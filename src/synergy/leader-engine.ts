import { SELF_GAINS } from "../ability-grammar/tags.js";
import { evidenceSpan } from "./evidence.js";
import type { AbilityLite, SynergyCard } from "./schema.js";

/**
 * @displayName Leader engine and role families
 * @strategicPurpose Decision D60 (#149): no tool read the leader's own ability, so The Warrior's engine (play a unit of
 * 3 or less power with Ambush) was invisible to pairings, and a substitute for Darth Traya (readies a leader) or Oppo
 * Rancisis (copies board keywords) matched a clause and not the job.
 * @tacticalObjective Pure readers over the parsed feature record (effects and clause text), no model and no file
 * access: the leader's played-unit limit and granted keywords, the leader's Action, whether a partner pays that off
 * or repeats it (D65), and the role families a substitute must keep. The pair graph and the tags are untouched, so
 * pairing precision is unchanged.
 */

type Loose = Record<string, unknown>;

const clausesOf = (ability: AbilityLite) => [...(ability.clauses ?? []), ...(ability.options ?? []).flatMap((o) => o.clauses)];

/** Clauses of the card's own text face (a leader's deployed-unit face is not the leader side). */
function textClauses(card: SynergyCard) {
  return (card.faces.text ?? []).flatMap(clausesOf);
}

const effectsOf = (clause: { effects: unknown[] }): Loose[] => clause.effects.filter((e): e is Loose => typeof e === "object" && e !== null);

export interface LeaderEngine {
  /** The clause text that plays or grants, quoted in a reason. */
  clause: string;
  /** "a unit with 3 or less power" gives 3; null when the leader plays no unit-limited card. */
  playsUnitMaxPower: number | null;
  /** Keywords the leader gives to what it plays or to a unit, for example Ambush. */
  grantsKeywords: string[];
}

const POWER_LIMIT = /\bunit with (\d+) or less power\b/i;

/** The leader's own play and grant effects, or null when its text face has none. */
export function leaderEngineOf(card: SynergyCard): LeaderEngine | null {
  let clauseText: string | null = null;
  let maxPower: number | null = null;
  const keywords = new Set<string>();
  for (const clause of textClauses(card)) {
    for (const effect of effectsOf(clause)) {
      if (effect.rule === "play_from" && typeof effect.what === "string") {
        const limit = POWER_LIMIT.exec(effect.what)?.[1];
        if (limit !== undefined) {
          maxPower = maxPower === null ? Number(limit) : Math.min(maxPower, Number(limit));
          clauseText ??= clause.text;
        }
      }
      if (effect.rule === "give_keyword" && Array.isArray(effect.keywords)) {
        for (const k of effect.keywords) {
          const name = (k as Loose | null)?.keyword;
          if (typeof name === "string") {
            keywords.add(name);
            clauseText ??= clause.text;
          }
        }
      }
    }
  }
  if (clauseText === null) return null;
  return { clause: clauseText, playsUnitMaxPower: maxPower, grantsKeywords: [...keywords].sort() };
}

export type EngineHitKind = "pays-off" | "readies-played" | "attack-payoff" | "grants-held-keyword" | "repeats-action" | "plays";
export interface EngineHit {
  kind: EngineHitKind;
  keyword: string | null;
  how: string;
  partnerText: string | null;
  /** The leader clause this hit rests on, when it is not the engine's play or grant clause (the Action a ready repeats). */
  clause?: string;
}

const powerOf = (card: SynergyCard): number | null => {
  const power = (card.structured as Loose).power;
  return typeof power === "number" ? power : null;
};

/** Every trigger and clause text of a card: where a "friendly unit with Ambush" condition would be written. */
function textsOf(card: SynergyCard): string[] {
  return Object.values(card.faces)
    .flat()
    .flatMap((ability) => [...(ability.triggers ?? []).map((t) => t.text ?? ""), ...clausesOf(ability).map((c) => c.text)]);
}

/** "When you play a unit [with N or less power]" (a reactive trigger on your own play); group 1 is the power limit, absent for any unit. */
const PLAY_TRIGGER = /^when you play a unit(?: with (\d+) or less power)?$/i;

/**
 * D74 (#161): the clause of a card that readies the unit you just played ("When you play a unit with 3 or less power: ...
 * ready that unit"), quoted with its trigger, when its limit admits every unit this leader plays; null otherwise.
 */
function readiesPlayedClause(card: SynergyCard, maxPower: number): string | null {
  for (const ability of card.faces.text ?? []) {
    const limit = (ability.triggers ?? []).map((t) => PLAY_TRIGGER.exec((t.text ?? "").trim())).find((m) => m !== null);
    if (limit === undefined || (limit[1] !== undefined && Number(limit[1]) < maxPower)) continue;
    const ready = clausesOf(ability).find((c) => effectsOf(c).some((e) => e.rule === "ready" && (e.target as Loose | undefined)?.side === "ref"));
    if (ready !== undefined) return evidenceSpan(card, `text: ${ready.text}`).replace(/^text: /, "");
  }
  return null;
}

/** Keywords that act only while the unit attacks (CR); a unit that gives one to itself pays off every attack. Mirrors the tag builder's list (src/ability-grammar/tags.ts). */
const ATTACK_KEYWORDS = new Set(["Raid", "Overwhelm", "Saboteur", "Restore"]);
/** A keyword a leader can give that makes the played unit attack on entry (CR: Ambush). */
const ATTACK_ON_ENTRY = new Set(["Ambush"]);

/** The attack keyword a unit gives itself ("This unit gains Raid 1 ..."), with the clause, when it wants attacks for it (D62). */
function selfGainedAttackKeyword(card: SynergyCard): { keyword: string; text: string } | null {
  if (!card.tags.wants.some((w) => w.tag === "wants:extra-attacks")) return null;
  for (const clause of Object.values(card.faces).flat().flatMap(clausesOf)) {
    if (!SELF_GAINS.test(clause.text)) continue;
    for (const effect of effectsOf(clause)) {
      if (effect.cat !== "grant_keyword" || (effect.target as Loose | undefined)?.side !== "self" || !Array.isArray(effect.keywords)) continue;
      for (const k of effect.keywords) {
        const name = (k as Loose | null)?.keyword;
        if (typeof name === "string" && ATTACK_KEYWORDS.has(name)) return { keyword: name, text: clause.text };
      }
    }
  }
  return null;
}

/** The clause behind a card's `wants:keyword-<keyword>` tag, without its face prefix ("text: "), or null when the card holds no such want. */
function keywordHolderWant(card: SynergyCard, keyword: string): string | null {
  const tag = `wants:keyword-${keyword.toLowerCase()}`;
  const why = card.tags.wants.find((w) => w.tag === tag)?.why;
  return why === undefined ? null : why.replace(/^[A-Za-z]+: /, "");
}

/** The leader's own Action that exhausts it, as "Action [..]: clause text", or null. A ready aimed at a leader lets it run again. */
export function leaderActionOf(card: SynergyCard): string | null {
  for (const ability of card.faces.text ?? []) {
    const trigger = (ability.triggers ?? []).find((t) => t.trigger === "action" && /\bexhaust\b/i.test(t.text ?? ""));
    if (trigger === undefined) continue;
    const body = clausesOf(ability).map((c) => c.text).join(" ");
    return body === "" ? (trigger.text ?? "Action") : `${trigger.text}: ${body}`;
  }
  return null;
}

/**
 * How a partner meets the leader's clause. pays-off: the partner's own text keys on a friendly unit with a keyword the
 * leader grants ("When a friendly unit with Ambush enters play"), or on one using it ("Friendly units can attack bases while
 * using Ambush", D72). attack-payoff (D65): the leader gives the played unit an
 * attack on entry (Ambush) and the unit gives itself an attack keyword (Raid, Overwhelm, Saboteur, Restore) that pays per
 * attack. grants-held-keyword (D67): the leader gives a keyword to the unit it plays, so that unit holds the keyword, and the
 * partner wants friendly holders of it (`wants:keyword-<k>`, Oppo Rancisis copies the keywords on the board). readies-played (D74): the
 * leader plays a unit with an attack on entry (Ambush) and the partner readies the unit you play (Insurgent Camp), so the unit attacks twice. repeats-action (D65): the partner readies a leader and the leader has an Action that exhausts it. plays: the
 * partner is a unit the leader's action can play (power at or under its limit). Null when none holds, in that order.
 */
export function engineHitOf(engine: LeaderEngine | null, partner: SynergyCard, action: string | null = null): EngineHit | null {
  if (engine !== null) {
    const texts = textsOf(partner);
    for (const keyword of engine.grantsKeywords) {
      const pattern = new RegExp(`\\bfriendly units? (?:with|that has|that have|has|have) (?:an? )?${keyword}\\b`, "i");
      const text = texts.find((t) => pattern.test(t));
      if (text !== undefined) return { kind: "pays-off", keyword, how: `its text keys on a friendly unit with ${keyword}, which this leader gives`, partnerText: text };
      // D72: "Friendly units can attack bases while using Ambush" pays off the keyword in use, the same tag rule as src/ability-grammar/tags.ts (KEYWORD_USERS).
      const using = new RegExp(`\\bfriendly units?\\b[^.;]*\\bwhile using ${keyword}\\b`, "i");
      const usedBy = texts.find((t) => using.test(t));
      if (usedBy !== undefined) return { kind: "pays-off", keyword, how: `its text pays off a friendly unit using ${keyword}, which this leader gives`, partnerText: usedBy };
    }
  }
  const entry = engine?.grantsKeywords.find((k) => ATTACK_ON_ENTRY.has(k));
  if (engine !== null && engine.playsUnitMaxPower !== null && entry !== undefined) {
    const ready = readiesPlayedClause(partner, engine.playsUnitMaxPower);
    if (ready !== null)
      return {
        kind: "readies-played",
        keyword: entry,
        how: `it readies the unit this leader plays (its limit admits every unit of ${engine.playsUnitMaxPower} or less power), so after the ${entry} attack that unit is ready to attack again, a base included`,
        partnerText: ready,
      };
  }
  const power = powerOf(partner);
  const playable = engine !== null && engine.playsUnitMaxPower !== null && partner.type === "Unit" && power !== null && power <= engine.playsUnitMaxPower;
  const entryKeyword = engine?.grantsKeywords.find((k) => ATTACK_ON_ENTRY.has(k));
  if (playable && entryKeyword !== undefined) {
    const gain = selfGainedAttackKeyword(partner);
    if (gain !== null)
      return { kind: "attack-payoff", keyword: entryKeyword, how: `this leader gives it ${entryKeyword}, an attack on entry, and its own text gains ${gain.keyword} while it attacks`, partnerText: gain.text };
  }
  for (const keyword of engine?.grantsKeywords ?? []) {
    const wanted = keywordHolderWant(partner, keyword);
    if (wanted !== null) return { kind: "grants-held-keyword", keyword, how: `this leader gives the unit it plays ${keyword}, so that unit is a friendly ${keyword} holder, which this card wants`, partnerText: wanted };
  }
  if (action !== null) {
    const ready = readyLeaderClause(partner);
    if (ready !== null) return { kind: "repeats-action", keyword: null, how: "it readies a leader, so the leader's Action can be used again", partnerText: ready, clause: action };
  }
  if (playable) return { kind: "plays", keyword: null, how: `a unit with ${power} power, within the ${engine.playsUnitMaxPower} or less this leader plays`, partnerText: null };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Role families (substitutes keep the card's job)

const KEYWORD_GRANT = /^offers:grant-(.+)$/;

/**
 * The jobs a unit does that its offers name (D65): readying a unit, drawing, removing an enemy unit. A swap for a unit that
 * does one must do it too, or budget_alternatives says no card does. Keyword grants are the other job and live below.
 */
const OFFER_JOBS = [
  { name: "ready", job: "readies a unit", tags: ["offers:ready-unit"] },
  { name: "draw", job: "draws a card", tags: ["offers:draw"] },
  { name: "removal", job: "removes a unit", tags: ["offers:defeat-any-unit", "offers:defeat-enemy-unit", "offers:damage-any-unit", "offers:damage-enemy-unit", "offers:bounce-enemy"] },
  // D85 (#167): a unit that makes token units or holds Sentinel (Koska Reeves does both) keeps that job, so a swap must too.
  { name: "token", job: "creates a token unit", tags: ["offers:create-token-units"] },
  { name: "sentinel", job: "holds Sentinel", tags: ["offers:has-keyword-sentinel"] },
] as const;
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The clause text of a ready effect aimed at a leader ("You may ready a non-unit leader"), or null. */
function readyLeaderClause(card: SynergyCard): string | null {
  const clause = Object.values(card.faces)
    .flat()
    .flatMap(clausesOf)
    .find((c) => effectsOf(c).some((e) => e.rule === "ready" && ((e.target as Loose | undefined)?.kind === "leader")));
  return clause?.text ?? null;
}

export const readiesLeader = (card: SynergyCard): boolean => readyLeaderClause(card) !== null;

const printedKeywords = (card: SynergyCard): string[] => {
  const field = (card.structured as Loose).keywordsField;
  return Array.isArray(field) ? field.filter((k): k is string => typeof k === "string") : [];
};

/** The keywords the deck and leader supply: printed on a deck card, or granted by the leader's own clause. */
export function suppliedKeywords(engine: LeaderEngine | null, deck: readonly SynergyCard[]): Set<string> {
  return new Set([...(engine?.grantsKeywords ?? []), ...deck.flatMap(printedKeywords)]);
}

export interface RoleKeep {
  /** Family names, for example "ready-leader" or "grant-Ambush". */
  families: string[];
  /** The tags the families live in, so a role outside them is not the card's job here. */
  tags: Set<string>;
  /** The families a candidate keeps (empty = none), in family order. */
  keptBy: (candidate: SynergyCard) => string[];
  /** The job in words, one per family ("readies a leader", "gives Ambush"). */
  jobs: string[];
  /** One sentence naming the job, for the output. */
  note: string;
}

/**
 * The job a slot card does in this deck, when it has one that a clause match can miss: readying a leader, or granting
 * a keyword the deck or leader supplies (D60). Null when the card does neither, so every other substitute stays as before.
 */
export function roleKeepOf(slot: SynergyCard, supplied: ReadonlySet<string>, offerJobs = false): RoleKeep | null {
  const families: { name: string; tags: string[]; job?: string; has: (c: SynergyCard) => boolean }[] = [];
  if (readiesLeader(slot)) families.push({ name: "ready-leader", tags: ["offers:ready-unit"], has: readiesLeader });
  // D65: with offerJobs, a unit also keeps the job its offers name; a card that readies a leader already keeps the stricter ready-leader job.
  if (offerJobs && (slot.type === "Unit" || slot.type === "Event")) {
    for (const { name, job, tags } of OFFER_JOBS) {
      // D84 (#166): an event keeps only the removal job ("Take control of a non-leader unit, then defeat it"); D65 keeps the rest for units.
      if (slot.type === "Event" && name !== "removal") continue;
      if (name === "ready" && readiesLeader(slot)) continue;
      if (!slot.tags.offers.some((o) => (tags as readonly string[]).includes(o.tag))) continue;
      families.push({ name, tags: [...tags], job, has: (c) => c.tags.offers.some((o) => (tags as readonly string[]).includes(o.tag)) });
    }
  }
  for (const { tag } of slot.tags.offers) {
    const keyword = KEYWORD_GRANT.exec(tag)?.[1];
    if (keyword === undefined || !supplied.has(capital(keyword))) continue;
    families.push({ name: `grant-${capital(keyword)}`, tags: [tag], has: (c) => c.tags.offers.some((o) => o.tag === tag) || c.tags.wants.some((w) => w.tag === `wants:keyword-${keyword}`) });
  }
  if (families.length === 0) return null;
  const names = families.map((f) => f.name);
  const grants = families.filter((f) => f.name.startsWith("grant-")).map((f) => f.name.slice("grant-".length));
  const jobs = [
    ...(families.some((f) => f.name === "ready-leader") ? ["readies a leader"] : []),
    ...families.flatMap((f) => (f.job === undefined ? [] : [f.job])),
    ...(grants.length === 0 ? [] : [`gives ${grants.join(", ")}`]),
  ];
  return {
    families: names,
    jobs,
    tags: new Set(families.flatMap((f) => f.tags)),
    keptBy: (candidate) => families.filter((f) => f.has(candidate)).map((f) => f.name),
    note: `this card's job in the deck: it ${jobs.join(" and ")}; a substitute must do the same${families.length > 1 ? " (any one of them)" : ""}`,
  };
}
