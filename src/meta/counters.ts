import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../paths.js";
import { compareCodePoints } from "../swu/canonical.js";
import { clip } from "../synergy/evidence.js";
import {
  counterTableSchema,
  type CounterRelation,
  type CounterTable,
  type CounterThreat,
  type KeyUnit,
  type ThreatProfile,
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
  return counterTableSchema.parse(JSON.parse(readFileSync(file, "utf8")));
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
const clauseSchema = z.looseObject({ text: z.string(), effects: z.array(effectSchema) });
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

/** Every answer offer of a card: its offers: tags with the effects of the clause behind each, plus pseudo-tags. */
export function answerOffers(card: CounterCard): AnswerOffer[] {
  const byWhy = new Map<string, EffectSpec[]>();
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
  }
  const out: AnswerOffer[] = card.tags.offers
    .filter((t) => !t.tag.startsWith("offers:is-trait-"))
    .map((t) => ({ tag: t.tag, why: t.why, effects: byWhy.get(t.why) ?? [] }));
  for (const k of [...new Set(card.keywords.filter((k) => !k.granted).map((k) => k.keyword))].sort(compareCodePoints)) {
    out.push({ tag: `keyword:${k}`, why: `printed keyword ${k}`, effects: [] });
  }
  if (card.type === "Unit" && card.structured.arenas.includes("Space")) {
    out.push({ tag: "unit:space", why: `Space unit ${card.structured.power ?? "-"}/${card.structured.hp ?? "-"}`, effects: [] });
  }
  if (resource.length > 0) out.push({ tag: "disrupt-resources", why: resource[0].why, effects: resource[0].effects });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Threat detection

function metricValue(profile: ThreatProfile, metric: string): number | null {
  if (metric === "keyUnits") return profile.keyUnits.length;
  if (metric === "meanCost") return profile.meanCost;
  if (metric === "arena.spaceShare") return profile.arena.spaceShare;
  if (metric.startsWith("keywords.")) return profile.keywords[metric.slice(9)] ?? 0;
  if (metric.startsWith("offers.")) return profile.offers[metric.slice(7)] ?? 0;
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
const HOSTILE_SIDES = new Set(["any", "enemy"]);
const UNIT_KINDS = new Set(["unit", "unit_or_base"]);
/** Limits the parser reads into restrict; every other relative clause or reference makes the target conditional. */
const READ_LIMITS = /\b(?:that|which) costs? \d+ or (?:less|more)\b|\bwith \d+ or (?:less|more) (?:remaining hp|power|hp)\b/gi;
const CONDITIONAL =
  /\b(?:that|those|these|which|who|it|its|chosen|this|attack(?:ing|ed)?|defending|damaged|undamaged|exhausted|ready|upgraded|equal|than|total|combined)\b/i;

/** A target the matcher can only satisfy under a condition it cannot check ("a unit that dealt damage to a base"). */
export const conditionalTarget = (text: string): boolean => CONDITIONAL.test(text.replace(READ_LIMITS, ""));
const SWEEP_QUANTS = new Set(["all", "any_number", "any"]);
const LIMIT = /^(cost|hp|power)_(le|lt|ge)_(\d+)$/;

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
  if (!arenaFits(effect.arena, unit.arenas) || !restrictHolds(effect.restrict, unit)) return false;
  if (effect.cat === "damage") return typeof effect.n === "number" && unit.hp !== null && effect.n >= unit.hp;
  return true;
}

function sweeps(effect: EffectSpec, cheapHp: number | null, needReach: boolean): boolean {
  if (!(effect.cat === "defeat" || effect.cat === "damage") || !HOSTILE_SIDES.has(effect.side) || !UNIT_KINDS.has(effect.kind))
    return false;
  if (!SWEEP_QUANTS.has(effect.quant) || conditionalTarget(effect.text.replace(/\bnot chosen\b/i, ""))) return false;
  if (!needReach) return true;
  if (cheapHp === null) return false;
  if (effect.cat === "damage") return typeof effect.n === "number" && effect.n >= cheapHp;
  const hp = effect.restrict.map((r) => /^hp_le_(\d+)$/.exec(r)).find((m) => m !== null);
  const blocked = effect.restrict.some((r) => !/^(hp_le_\d+|non_leader|other|non_trait:.+)$/.test(r));
  return !blocked && (hp === undefined || Number(hp[1]) >= cheapHp);
}

export interface RelationHit {
  relation: string;
  threat: string;
  offer: string;
  weight: number;
  evidence: string;
  /** Key units this offer removes, for the removal relations. */
  answers: string[];
  /** Share of the archetype's key-unit copies removed (removal), else 1. */
  fraction: number;
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
    if (q.removesKeyUnit) {
      const removed = profile.keyUnits.filter((u) => offer.effects.some((e) => removes(e, u)));
      if (removed.length === 0) continue;
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
    const hit: RelationHit = {
      relation: relation.id,
      threat: relation.threat,
      offer: offer.tag,
      weight,
      evidence: clip(offer.why),
      answers,
      fraction: Math.round(fraction * 1e4) / 1e4,
    };
    if (best === null || hit.weight * hit.fraction > best.weight * best.fraction) best = hit;
  }
  return best;
}
