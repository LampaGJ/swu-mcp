import type { AbilityLite, SynergyCard } from "./schema.js";

/**
 * @displayName Leader engine and role families
 * @strategicPurpose Decision D60 (#149): no tool read the leader's own ability, so The Warrior's engine (play a unit of
 * 3 or less power with Ambush) was invisible to pairings, and a substitute for Darth Traya (readies a leader) or Oppo
 * Rancisis (copies board keywords) matched a clause and not the job.
 * @tacticalObjective Pure readers over the parsed feature record (effects and clause text), no model and no file
 * access: the leader's played-unit limit and granted keywords, whether a partner pays that off, and the role families
 * a substitute must keep. The pair graph and the tags are untouched, so pairing precision is unchanged.
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

export type EngineHit = { kind: "pays-off" | "plays"; keyword: string | null; how: string; partnerText: string | null };

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

/**
 * How a partner meets the leader's clause. pays-off: the partner's own text keys on a friendly unit with a keyword the
 * leader grants ("When a friendly unit with Ambush enters play"). plays: the partner is a unit the leader's action can
 * play (power at or under its limit). Null when neither holds. pays-off wins when both do.
 */
export function engineHitOf(engine: LeaderEngine, partner: SynergyCard): EngineHit | null {
  const texts = textsOf(partner);
  for (const keyword of engine.grantsKeywords) {
    const pattern = new RegExp(`\\bfriendly units? (?:with|that has|that have|has|have) (?:an? )?${keyword}\\b`, "i");
    const text = texts.find((t) => pattern.test(t));
    if (text !== undefined) return { kind: "pays-off", keyword, how: `its text keys on a friendly unit with ${keyword}, which this leader gives`, partnerText: text };
  }
  const power = powerOf(partner);
  if (engine.playsUnitMaxPower !== null && partner.type === "Unit" && power !== null && power <= engine.playsUnitMaxPower)
    return { kind: "plays", keyword: null, how: `a unit with ${power} power, within the ${engine.playsUnitMaxPower} or less this leader plays`, partnerText: null };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Role families (substitutes keep the card's job)

const KEYWORD_GRANT = /^offers:grant-(.+)$/;
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A ready effect aimed at a leader ("You may ready a non-unit leader"). */
export function readiesLeader(card: SynergyCard): boolean {
  return Object.values(card.faces)
    .flat()
    .flatMap(clausesOf)
    .some((clause) => effectsOf(clause).some((e) => e.rule === "ready" && ((e.target as Loose | undefined)?.kind === "leader")));
}

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
export function roleKeepOf(slot: SynergyCard, supplied: ReadonlySet<string>): RoleKeep | null {
  const families: { name: string; tags: string[]; has: (c: SynergyCard) => boolean }[] = [];
  if (readiesLeader(slot)) families.push({ name: "ready-leader", tags: ["offers:ready-unit"], has: readiesLeader });
  for (const { tag } of slot.tags.offers) {
    const keyword = KEYWORD_GRANT.exec(tag)?.[1];
    if (keyword === undefined || !supplied.has(capital(keyword))) continue;
    families.push({ name: `grant-${capital(keyword)}`, tags: [tag], has: (c) => c.tags.offers.some((o) => o.tag === tag) || c.tags.wants.some((w) => w.tag === `wants:keyword-${keyword}`) });
  }
  if (families.length === 0) return null;
  const names = families.map((f) => f.name);
  const grants = families.filter((f) => f.name !== "ready-leader").map((f) => f.name.slice("grant-".length));
  const jobs = [...(families.some((f) => f.name === "ready-leader") ? ["readies a leader"] : []), ...(grants.length === 0 ? [] : [`gives ${grants.join(", ")}`])];
  return {
    families: names,
    jobs,
    tags: new Set(families.flatMap((f) => f.tags)),
    keptBy: (candidate) => families.filter((f) => f.has(candidate)).map((f) => f.name),
    note: `this card's job in the deck: it ${jobs.join(" and ")}; a substitute must do the same${families.length > 1 ? " (any one of them)" : ""}`,
  };
}
