import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJson } from "../data.js";
import { REPO_ROOT } from "../paths.js";
import { compareCodePoints } from "../swu/canonical.js";
import { clip, evidenceSpan } from "../synergy/evidence.js";
import type { SynergyCard } from "../synergy/schema.js";
import {
  counterTableSchema,
  type CounterRelation,
  type CounterTable,
  type CounterThreat,
  type KeyUnit,
  type ThreatProfile,
  isHeavyKeyUnit,
} from "./schema.js";

/**
 * @displayName Meta counter matcher
 * @strategicPurpose Decides which of our cards answer which threat of an archetype, from the committed counter
 * table (data/counters.json) and the parsed card features, with the clause that justifies each answer
 * (LampaGJ/swu-mcp#25). Answers are candidates: the clause travels with them so the caller can check it.
 * @tacticalObjective An answer offer is a feature tag (offers:*) or a pseudo-tag read from printed fields
 * (keyword:<K>, unit:space) or effects the tag step skips (disrupt-resources). Qualifiers are checked against the
 * archetype: removal against each key unit's cost, HP, power, arena and traits; sweepers against the median HP of
 * its cheap units. A stated limit the matcher cannot check (damaged, exhausted, "with ...") never counts as a match.
 */

export const DEFAULT_COUNTERS_PATH = path.join(REPO_ROOT, "data/counters.json");

export function loadCounterTable(file = DEFAULT_COUNTERS_PATH): CounterTable {
  if (!existsSync(file)) throw new Error(`no counter table at ${file}`);
  return counterTableSchema.parse(readJson(file));
}

const targetSchema = z.looseObject({
  side: z.string().optional(),
  kind: z.string().optional(),
  arena: z.string().optional(),
  quant: z.string().optional(),
  restrict: z.array(z.string()).optional(),
  text: z.string().optional(),
});
const effectSchema = z.looseObject({ cat: z.string(), n: z.unknown().optional(), target: targetSchema.optional() });
const clauseSchema = z.looseObject({
  text: z.string(),
  effects: z.array(effectSchema),
  curatedId: z.string().optional(),
  structure: z.array(z.looseObject({ cat: z.string().optional(), what: z.unknown().optional() })).optional(),
});
interface AbilityNode {
  kind: string;
  clauses?: z.infer<typeof clauseSchema>[];
  options?: { clauses: z.infer<typeof clauseSchema>[] }[];
  grantedAbilities?: { abilities: AbilityNode[] }[];
}
const abilitySchema: z.ZodType<AbilityNode> = z.looseObject({
  kind: z.string(),
  clauses: z.array(clauseSchema).optional(),
  options: z.array(z.looseObject({ clauses: z.array(clauseSchema) })).optional(),
  get grantedAbilities() {
    return z.array(z.looseObject({ abilities: z.array(abilitySchema) })).optional();
  },
});

export const counterCardSchema = z.looseObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullable(),
  type: z.string(),
  structured: z.looseObject({
    cost: z.number().nullable(),
    power: z.number().nullable(),
    hp: z.number().nullable(),
    arenas: z.array(z.string()),
    aspectIcons: z.array(z.string()),
    traits: z.array(z.string()),
  }),
  keywords: z.array(z.looseObject({ keyword: z.string(), granted: z.boolean() })),
  faces: z.record(z.string(), z.array(abilitySchema)),
  tags: z.looseObject({ offers: z.array(z.looseObject({ tag: z.string(), why: z.string() })) }),
});
export type CounterCard = z.infer<typeof counterCardSchema>;

export interface EffectSpec {
  cat: string;
  n: number | string | null;
  side: string;
  kind: string;
  arena: string;
  quant: string;
  restrict: string[];
  /** The target's own words, read for limits the restrict list does not carry ("that dealt damage", "those units"). */
  text: string;
}

export interface AnswerOffer {
  tag: string;
  why: string;
  effects: EffectSpec[];
  /** D86 (#168): the effect-less clauses of the same ability that gate it ("If you control an Endor base, each opponent chooses one:"), cited as `why` is. */
  gates?: string[];
  /** D86 (#168): the offer is a mode an opponent picks ("each opponent chooses one:"); the clause that says so. */
  opponentChooses?: string;
}

function walkClauses(nodes: readonly AbilityNode[], visit: (clause: z.infer<typeof clauseSchema>) => void): void {
  for (const n of nodes) {
    if (n.kind !== "ability") continue;
    for (const c of n.clauses ?? []) visit(c);
    for (const o of n.options ?? []) for (const c of o.clauses) visit(c);
    for (const g of n.grantedAbilities ?? []) walkClauses(g.abilities, visit);
  }
}

const specOf = (e: z.infer<typeof effectSchema>): EffectSpec => ({
  cat: e.cat,
  n: typeof e.n === "number" || typeof e.n === "string" ? e.n : null,
  side: e.target?.side ?? "any",
  kind: e.target?.kind ?? "",
  arena: e.target?.arena ?? "any",
  quant: e.target?.quant ?? "one",
  restrict: e.target?.restrict ?? [],
  text: e.target?.text ?? "",
});

const RESOURCE_HITS = new Set(["exhaust_resource", "defeat", "bounce", "exhaust"]);
const SELECTED_SIDE = /^(?:an? )?(friendly|enemy)\b/i;

/**
 * D85 (#167): a curated clause that only selects targets ("You may choose a friendly unit and an enemy non-leader unit", Chimaera,
 * A Frightening Reality) carries the offer, and the next clause acts on "those units". The act's effects are given one target per
 * selected phrase (side, non-leader, the phrase as its words), so the curated offer's removal is read like any other clause's.
 */
function selectedTargetEffects(face: string, nodes: readonly AbilityNode[], into: Map<string, EffectSpec[]>, quotes: Map<string, string>): void {
  for (const n of nodes) {
    if (n.kind !== "ability") continue;
    const clauses = n.clauses ?? [];
    clauses.forEach((clause, i) => {
      const what = (clause.structure ?? []).find((s) => s.cat === "select_targets")?.what;
      const next = clauses[i + 1];
      if (clause.curatedId === undefined || typeof what !== "string" || next === undefined) return;
      const acts = next.effects.filter((e) => REMOVAL.has(e.cat));
      const phrases = what.split(/\s+and\s+/).map((p) => p.trim());
      const specs = acts.flatMap((e) =>
        phrases.map((phrase) => {
          const side = SELECTED_SIDE.exec(phrase)?.[1]?.toLowerCase() ?? "any";
          return { ...specOf(e), side, restrict: /\bnon-leader\b/i.test(phrase) ? ["non_leader"] : [], text: phrase };
        }),
      );
      if (specs.length === 0) return;
      into.set(`curated ${clause.curatedId}`, specs);
      quotes.set(`curated ${clause.curatedId}`, `${face}: ${next.text}`);
    });
    for (const g of n.grantedAbilities ?? []) selectedTargetEffects(face, g.abilities, into, quotes);
  }
}

const OPPONENT_CHOOSER = /\bopponent\b/i;
type ClauseNode = z.infer<typeof clauseSchema>;
const chooserOf = (c: ClauseNode): string | undefined =>
  (c.structure ?? []).map((s) => (s as { chooser?: unknown }).chooser).find((x): x is string => typeof x === "string");

/**
 * D86 (#168): an ability's effect-less clauses (a mode list's header, "If you control an Endor base, each opponent chooses one:")
 * gate every other clause of it, so a lock they name locks the offer too; a mode list whose header names an opponent as the
 * chooser is the opponent's to pick (Giant Gorax, Watto). Keyed by the clause as a tag cites it ("text: ...").
 */
function modeGates(face: string, nodes: readonly AbilityNode[], into: Map<string, { gates: string[]; chooser?: string }>): void {
  for (const n of nodes) {
    if (n.kind !== "ability") continue;
    const heads = (n.clauses ?? []).filter((c) => c.effects.length === 0);
    const chooser = heads.find((c) => OPPONENT_CHOOSER.test(chooserOf(c) ?? ""));
    const add = (c: ClauseNode, opponent: boolean): void => {
      const gates = heads.filter((h) => h !== c).map((h) => `${face}: ${h.text}`);
      if (gates.length === 0) return;
      const why = `${face}: ${c.text}`;
      const prior = into.get(why);
      into.set(why, {
        gates: [...new Set([...(prior?.gates ?? []), ...gates])],
        ...(prior?.chooser !== undefined ? { chooser: prior.chooser } : opponent && chooser !== undefined ? { chooser: chooser.text } : {}),
      });
    };
    for (const c of n.clauses ?? []) if (c.effects.length > 0) add(c, false);
    for (const o of n.options ?? []) for (const c of o.clauses) add(c, true);
    for (const g of n.grantedAbilities ?? []) modeGates(face, g.abilities, into);
  }
}

/** Every answer offer of a card: its offers: tags with the effects of the clause behind each, plus pseudo-tags. */
export function answerOffers(card: CounterCard): AnswerOffer[] {
  const gated = new Map<string, { gates: string[]; chooser?: string }>();
  for (const [face, nodes] of Object.entries(card.faces)) modeGates(face, nodes, gated);
  const withGates = (offer: AnswerOffer, cited: string): AnswerOffer => {
    const g = gated.get(cited);
    return g === undefined ? offer : { ...offer, gates: g.gates, ...(g.chooser === undefined ? {} : { opponentChooses: g.chooser }) };
  };
  const byWhy = new Map<string, EffectSpec[]>();
  const quotes = new Map<string, string>();
  const resource: { why: string; effects: EffectSpec[] }[] = [];
  for (const [face, nodes] of Object.entries(card.faces)) {
    walkClauses(nodes, (clause) => {
      const why = `${face}: ${clause.text}`;
      const specs = clause.effects.map(specOf);
      byWhy.set(why, [...(byWhy.get(why) ?? []), ...specs]);
      const hits = specs.filter(
        (s) =>
          RESOURCE_HITS.has(s.cat) &&
          (s.kind === "resource" || s.kind === "resources") &&
          (s.side === "enemy" || (s.side === "any" && /\benemy\b|\bopponent\b|\bthey\b/i.test(clause.text))),
      );
      if (hits.length > 0) resource.push({ why, effects: hits });
    });
    selectedTargetEffects(face, nodes, byWhy, quotes);
  }
  const out: AnswerOffer[] = card.tags.offers
    .filter((t) => !t.tag.startsWith("offers:is-trait-"))
    .map((t) => withGates({ tag: t.tag, why: quotes.get(t.why) ?? t.why, effects: byWhy.get(t.why) ?? [] }, t.why));
  for (const k of [...new Set(card.keywords.filter((k) => !k.granted).map((k) => k.keyword))].sort(compareCodePoints)) {
    out.push({ tag: `keyword:${k}`, why: `printed keyword ${k}`, effects: [] });
  }
  if (card.type === "Unit" && card.structured.arenas.includes("Space")) {
    out.push({ tag: "unit:space", why: `Space unit ${card.structured.power ?? "-"}/${card.structured.hp ?? "-"}`, effects: [] });
  }
  if (resource.length > 0) out.push(withGates({ tag: "disrupt-resources", why: resource[0].why, effects: resource[0].effects }, resource[0].why));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Threat detection

/**
 * D66 (#157): holders of a keyword they do not print. A profile built before the field existed derives it from the holder
 * offer (every Unit holding the keyword, printed or not) minus the printed count, which in a deck counts the same Units.
 */
function gainedKeyword(profile: ThreatProfile, keyword: string): number {
  if (profile.gainedKeywords !== undefined) return profile.gainedKeywords[keyword] ?? 0;
  const holders = profile.offers[`offers:has-keyword-${keyword.toLowerCase()}`] ?? 0;
  return Math.max(0, Math.round((holders - (profile.keywords[keyword] ?? 0)) * 100) / 100);
}

function metricValue(profile: ThreatProfile, metric: string): number | null {
  if (metric === "keyUnits") return profile.keyUnits.length;
  // A package built before D63 has no heavyKeyUnits; the listed key units give a lower bound (they are capped, ordered by copies).
  if (metric === "heavyKeyUnits") return profile.heavyKeyUnits ?? profile.keyUnits.filter((u) => isHeavyKeyUnit(u.cost, u.inclusion)).length;
  if (metric === "meanCost") return profile.meanCost;
  if (metric === "arena.spaceShare") return profile.arena.spaceShare;
  if (metric.startsWith("keywords.")) return profile.keywords[metric.slice(9)] ?? 0;
  if (metric.startsWith("offers.")) return profile.offers[metric.slice(7)] ?? 0;
  if (metric.startsWith("gainedKeywords.")) return gainedKeyword(profile, metric.slice(15));
  const direct = (profile as unknown as Record<string, unknown>)[metric];
  return typeof direct === "number" ? direct : null;
}

export interface DetectedThreat {
  threat: CounterThreat;
  value: number;
}

export function detectThreats(profile: ThreatProfile, table: CounterTable): DetectedThreat[] {
  const out: DetectedThreat[] = [];
  for (const threat of table.threats) {
    const values = threat.metrics.map((m) => metricValue(profile, m));
    if (values.some((v) => v === null)) continue;
    const value = Math.round((values as number[]).reduce((s, v) => s + v, 0) * 100) / 100;
    if ((threat.min === undefined || value >= threat.min) && (threat.max === undefined || value <= threat.max)) out.push({ threat, value });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Qualifier checks

const REMOVAL = new Set(["defeat", "damage", "capture", "bounce"]);
const UPGRADE_KINDS = new Set(["upgrade", "upgrades", "token", "tokens"]);
/** D66: a Shield token is an Armor upgrade, so removal limited to another trait ("a Condition upgrade") leaves it. */
const removesUpgrade = (e: EffectSpec): boolean => REMOVAL.has(e.cat) && UPGRADE_KINDS.has(e.kind);
const reachesShieldToken = (e: EffectSpec): boolean => !e.restrict.some((r) => r.startsWith("trait:") && r !== "trait:Armor");
const HOSTILE_SIDES = new Set(["any", "enemy"]);
const UNIT_KINDS = new Set(["unit", "unit_or_base"]);
/** Limits the parser reads into restrict; every other relative clause or reference makes the target conditional. */
const READ_LIMITS = /\b(?:that|which) costs? \d+ or (?:less|more)\b|\bwith \d+ or (?:less|more) (?:remaining hp|power|hp)\b/gi;
const CONDITIONAL =
  /\b(?:that|those|these|which|who|it|its|chosen|this|attack(?:ing|ed)?|defending|damaged|undamaged|exhausted|ready|upgraded|equal|than|total|combined)\b/i;

/** A target the matcher can only satisfy under a condition it cannot check ("a unit that dealt damage to a base"). */
export const conditionalTarget = (text: string): boolean => CONDITIONAL.test(text.replace(READ_LIMITS, ""));
const SWEEP_QUANTS = new Set(["all", "any_number", "any"]);
const ALL_QUANTS = new Set(["all", "each"]);
const LIMIT = /^(cost|hp|power)_(le|lt|ge)_(\d+)$/;

const TEXT_LIMIT = /\bwith (\d+) or (more|less|fewer) (power|remaining hp|hp)\b|\b(?:that costs?|costing) (\d+) or (more|less)\b/gi;

/** The stat limits of an effect's target, as restrict codes: the parsed restrict plus those only the target's own words state (#152). */
function limitsOf(effect: EffectSpec): string[] {
  const out = new Set(effect.restrict.filter((r) => LIMIT.test(r)));
  for (const m of effect.text.matchAll(TEXT_LIMIT)) {
    const stat = m[3] === undefined ? "cost" : m[3].toLowerCase() === "power" ? "power" : "hp";
    const n = m[1] ?? m[4];
    const more = (m[2] ?? m[5]).toLowerCase() === "more";
    out.add(`${stat}_${more ? "ge" : "le"}_${n}`);
  }
  return [...out].sort(compareCodePoints);
}

/** A removal effect's stat floor or ceiling in words ("power 6 or more"), for the answer row; null when it states none. */
export function thresholdOf(effect: EffectSpec): string | null {
  const words = limitsOf(effect).flatMap((code) => {
    const m = LIMIT.exec(code);
    if (m === null) return [];
    return [m[2] === "lt" ? `${m[1]} under ${m[3]}` : `${m[1]} ${m[3]} or ${m[2] === "ge" ? "more" : "less"}`];
  });
  return words.length === 0 ? null : words.join(", ");
}

/** Whether every stated limit on the target holds for the unit; a limit the matcher cannot read fails. */
function restrictHolds(restrict: readonly string[], unit: KeyUnit): boolean {
  for (const r of restrict) {
    if (r === "non_leader" || r === "non-leader" || r === "other") continue;
    if (r.startsWith("trait:")) {
      if (!unit.traits.includes(r.slice(6))) return false;
      continue;
    }
    if (r.startsWith("non_trait:")) {
      if (unit.traits.includes(r.slice(10))) return false;
      continue;
    }
    const m = LIMIT.exec(r);
    if (m === null) return false;
    const stat = m[1] === "cost" ? unit.cost : m[1] === "hp" ? unit.hp : unit.power;
    if (stat === null) return false;
    const n = Number(m[3]);
    if ((m[2] === "le" && stat > n) || (m[2] === "lt" && stat >= n) || (m[2] === "ge" && stat < n)) return false;
  }
  return true;
}

const arenaFits = (effectArena: string, unitArenas: readonly string[]): boolean =>
  effectArena === "space" ? unitArenas.includes("Space") : effectArena === "ground" ? unitArenas.includes("Ground") : true;

/** The effect removes the unit: defeat, capture or bounce within its limits, or damage at least its printed HP. */
export function removes(effect: EffectSpec, unit: KeyUnit): boolean {
  if (!REMOVAL.has(effect.cat) || !HOSTILE_SIDES.has(effect.side) || !UNIT_KINDS.has(effect.kind) || conditionalTarget(effect.text))
    return false;
  if (!arenaFits(effect.arena, unit.arenas) || !restrictHolds([...new Set([...effect.restrict, ...limitsOf(effect)])], unit))
    return false;
  if (effect.cat === "damage") return typeof effect.n === "number" && unit.hp !== null && effect.n >= unit.hp;
  return true;
}

/** D86 (#168): "any number of non-leader units with a total of 6 or less remaining HP" (Pre Vizsla): a pooled HP budget. */
const TOTAL_HP = /\bwith a total of (\d+) or less remaining HP\b/i;
const UP_TO = /^up_to_(\d+)$/;

function sweeps(effect: EffectSpec, cheapHp: number | null, needReach: boolean): boolean {
  if (!(effect.cat === "defeat" || effect.cat === "damage") || !HOSTILE_SIDES.has(effect.side) || !UNIT_KINDS.has(effect.kind))
    return false;
  // D86 (#168): "each of up to 3 units" (IG-2000) is a chosen multi-target sweep, one-sided like "any number of".
  const upTo = UP_TO.exec(effect.quant);
  const eachOfUpTo = upTo !== null && Number(upTo[1]) >= 2 && /\beach of up to\b/i.test(effect.text);
  if (!(SWEEP_QUANTS.has(effect.quant) || eachOfUpTo)) return false;
  const total = TOTAL_HP.exec(effect.text);
  if (conditionalTarget(effect.text.replace(/\bnot chosen\b/i, "").replace(TOTAL_HP, ""))) return false;
  if (!needReach) return true;
  if (cheapHp === null) return false;
  // A pooled budget sweeps only when it takes at least two of the archetype's typical cheap units.
  if (total !== null) return effect.cat === "defeat" && Number(total[1]) >= 2 * cheapHp;
  if (effect.cat === "damage") return typeof effect.n === "number" && effect.n >= cheapHp;
  const hp = effect.restrict.map((r) => /^hp_le_(\d+)$/.exec(r)).find((m) => m !== null);
  const blocked = effect.restrict.some((r) => !/^(hp_le_\d+|non_leader|other|non_trait:.+)$/.test(r));
  return !blocked && (hp === undefined || Number(hp[1]) >= cheapHp);
}

/**
 * Decision D46: the offer hits our units as well as theirs. Every defeat or damage effect it has on units that reaches
 * an opponent's side ("side any") takes all or each of them, with no choice of target; "any number of" and "up to N"
 * leave the choice to the player, so they are not symmetric.
 */
export function symmetricOffer(offer: AnswerOffer): boolean {
  const onUnits = offer.effects.filter(
    (e) => (e.cat === "defeat" || e.cat === "damage") && HOSTILE_SIDES.has(e.side) && UNIT_KINDS.has(e.kind),
  );
  return onUnits.length > 0 && onUnits.every((e) => e.side === "any" && ALL_QUANTS.has(e.quant));
}

export interface RelationHit {
  relation: string;
  threat: string;
  offer: string;
  weight: number;
  evidence: string;
  /** Key units this offer removes, for the removal relations. */
  answers: string[];
  /** The stat floor or ceiling the removing clause states ("power 6 or more"), when it states one. */
  threshold?: string;
  /** Share of the archetype's key-unit copies removed (removal), else 1. */
  fraction: number;
  /** Decision D46: the offer is a sweep that also hits our own units (see symmetricOffer). */
  symmetric: boolean;
}

/** How one relation applies to a card against one archetype profile, or null when it does not. */
export function relationHit(
  card: CounterCard,
  offers: readonly AnswerOffer[],
  relation: CounterRelation,
  profile: ThreatProfile,
): RelationHit | null {
  const q = relation.qualifier;
  let best: RelationHit | null = null;
  for (const offer of offers) {
    const weight = relation.offers[offer.tag];
    if (weight === undefined) continue;
    const tagBacked = offer.tag.startsWith("offers:") || offer.tag === "disrupt-resources";
    let answers: string[] = [];
    let fraction = 1;
    let threshold: string | null = null;
    if (q.removesKeyUnit) {
      const removed = profile.keyUnits.filter((u) => offer.effects.some((e) => removes(e, u)));
      if (removed.length === 0) continue;
      const limits = offer.effects.filter((e) => removed.some((u) => removes(e, u))).flatMap((e) => thresholdOf(e) ?? []);
      threshold = limits.length === 0 ? null : [...new Set(limits)].join("; ");
      const total = profile.keyUnits.reduce((s, u) => s + u.meanCopies, 0);
      fraction = total === 0 ? 0 : removed.reduce((s, u) => s + u.meanCopies, 0) / total;
      answers = removed.map((u) => u.title);
    }
    if (q.sweep && !offer.effects.some((e) => sweeps(e, profile.cheapUnitMedianHp, q.reachesCheapHp === true))) continue;
    if (q.arena !== undefined) {
      const ok = tagBacked
        ? offer.effects.some((e) => REMOVAL.has(e.cat) && e.arena === q.arena && HOSTILE_SIDES.has(e.side))
        : card.structured.arenas.some((a) => a.toLowerCase() === q.arena);
      if (!ok) continue;
    }
    if (
      q.healsBase &&
      tagBacked &&
      !offer.effects.some((e) => e.cat === "heal" && (e.kind === "base" || e.kind === "unit_or_base") && e.side !== "enemy")
    )
      continue;
    if (q.minPower !== undefined && (card.structured.power ?? 0) < q.minPower) continue;
    if (q.reachesShieldTokens && offer.effects.some(removesUpgrade) && !offer.effects.some((e) => removesUpgrade(e) && reachesShieldToken(e))) continue;
    const hit: RelationHit = {
      relation: relation.id,
      threat: relation.threat,
      offer: offer.tag,
      weight,
      // D82 (#164): the clause with the trigger, the clauses it hangs on and, in a choose-one, its whole mode, as the pairing tools quote it.
      evidence: clip(evidenceSpan(card as unknown as Pick<SynergyCard, "faces">, offer.why)),
      answers,
      ...(threshold === null ? {} : { threshold }),
      fraction: Math.round(fraction * 1e4) / 1e4,
      symmetric: symmetricOffer(offer),
    };
    if (best === null || hit.weight * hit.fraction > best.weight * best.fraction) best = hit;
  }
  return best;
}
