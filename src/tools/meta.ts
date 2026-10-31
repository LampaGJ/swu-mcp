import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MissingDataError, packageDirOf, readJson, type CardStore } from "../data.js";
import {
  answerOffers,
  counterCardSchema,
  detectThreats,
  loadCounterTable,
  relationHit,
  type AnswerOffer,
  type CounterCard,
  type RelationHit,
} from "../meta/counters.js";
import { archetypeEvidenceKey, aspectsEvidenceKey } from "../meta/outcomes.js";
import {
  LEADER_CARDS_MAX,
  metaFileSchema,
  POPULATIONS,
  SWUMETASTATS_SOURCE,
  winRatesFileSchema,
  type Archetype,
  type CounterTable,
  type DeckEvidence,
  type MetaFile,
  type WinRatesFile,
} from "../meta/schema.js";
import { wilson } from "../meta/stats.js";
import { compareCodePoints } from "../swu/canonical.js";
import { CANDIDATE_STATUS } from "../synergy/evidence.js";
import { cardLabel } from "../synergy/order.js";
import type { ToolResult } from "../tools.js";
import {
  baseField,
  cardScope,
  decklistField,
  deckEnvOf,
  LEADER_INCLUSION_FLOOR,
  leaderCardsOf,
  leaderField,
  leaderSourceText,
  MAIN_TYPES,
  resolveList,
  resolvePair,
  resolveRef,
  singlePenalty,
  suppliedBy,
  type DeckEnv,
} from "./deck.js";
import { fail, ok, round } from "./common.js";
import { deferRepeatedLinks } from "./synergy.js";

/**
 * @displayName Meta defense tools
 * @strategicPurpose Answers "whatever my deck does, what must it include to beat the decks people are winning with
 * now" (LampaGJ/swu-mcp#25): meta_archetypes lists the current archetypes, meta_threats describes one, meta_answers
 * ranks the cards in our aspects that answer the most meta share. Every win rate comes from swumetastats.com's
 * melee.gg tournament data and carries its source, window, n and a Wilson 95% interval; no Karabast-derived number
 * is ever read or shown here (decision D22).
 * @tacticalObjective Reads <package>/meta/archetypes.json and winrates.json (written by `pnpm meta`) and the committed
 * data/counters.json; answers are computed per call by src/meta/counters.ts, with clause evidence and
 * status: candidate. No model and no clock in the path.
 */

type EvidenceGroup = DeckEvidence["groups"][number];

export interface MetaEnv {
  deck: DeckEnv;
  meta: MetaFile;
  winrates: WinRatesFile;
  table: CounterTable;
  cards: Map<string, { card: CounterCard; offers: AnswerOffer[] }>;
  evidence: Map<string, { group: EvidenceGroup; cards: Map<string, EvidenceGroup["cards"][number]> }>;
}

/** Builds the env from parsed parts, so tests can pass an in-code DeckEnv and synthetic meta files. */
export function createMetaEnv(deck: DeckEnv, meta: unknown, winrates: unknown, table: CounterTable, features: readonly unknown[]): MetaEnv {
  const cards = new Map<string, { card: CounterCard; offers: AnswerOffer[] }>();
  for (const raw of features) {
    const card = counterCardSchema.parse(raw);
    cards.set(card.cardKey, { card, offers: answerOffers(card) });
  }
  const parsed = winRatesFileSchema.parse(winrates);
  const evidence = new Map(
    (parsed.deckEvidence?.groups ?? []).map((group) => [group.key, { group, cards: new Map(group.cards.map((c) => [c.cardKey, c])) }]),
  );
  return { deck, meta: metaFileSchema.parse(meta), winrates: parsed, table, cards, evidence };
}

const envs = new WeakMap<CardStore, MetaEnv>();

function metaEnvOf(store: CardStore): MetaEnv {
  const hit = envs.get(store);
  if (hit !== undefined) return hit;
  const dir = path.join(packageDirOf(store), "meta");
  const file = path.join(dir, "archetypes.json");
  if (!existsSync(file)) throw new MissingDataError(`no ${file}; this data package predates the meta step (run "pnpm meta" or "pnpm build:data")`);
  const features = z.array(z.unknown()).parse(readJson(path.join(packageDirOf(store), "features/features.json")));
  const env = createMetaEnv(deckEnvOf(store), readJson(file), readJson(path.join(dir, "winrates.json")), loadCounterTable(), features);
  envs.set(store, env);
  return env;
}

const r4 = (x: number): number => round(x, 4);
const rate = (wins: number, n: number): number | null => (n === 0 ? null : r4(wins / n));

const populationField = z
  .enum(["primary", ...POPULATIONS])
  .default("primary")
  .describe(
    "primary (default): tournament decklists with placements, or community lists when the window has too few; tournament or community picks one",
  );

function populationOf(env: MetaEnv, wanted: "primary" | (typeof POPULATIONS)[number]): (typeof POPULATIONS)[number] {
  return wanted === "primary" ? env.meta.primary : wanted;
}

function sourcesNote(env: MetaEnv, population: string): Record<string, unknown> {
  const summary = env.meta.populations.find((p) => p.population === population);
  return {
    population,
    primary: env.meta.primary,
    fallback: env.meta.fallback,
    decks: summary?.decks ?? 0,
    events: summary?.events ?? 0,
    deckSources: Object.entries(summary?.sources ?? {})
      .map(([s, n]) => `${s} ${n}`)
      .join(", "),
    window: `${env.meta.window.from}..${env.meta.window.to}`,
    weighting: env.meta.method.weighting,
    tournamentMatchups:
      env.winrates.matchups === null
        ? "none captured"
        : `${SWUMETASTATS_SOURCE}: leader and base-aspect matchups, ${env.winrates.matchups.period.from}..${env.winrates.matchups.period.to}, ${env.winrates.matchups.matches} matches`,
    answerEvidence:
      env.winrates.deckEvidence === null
        ? "none captured"
        : `${SWUMETASTATS_SOURCE}: ${env.winrates.deckEvidence.decks} tournament decklists with a match record from ${env.winrates.deckEvidence.events} events, ${env.winrates.deckEvidence.window.from}..${env.winrates.deckEvidence.window.to}; opponents ${env.winrates.deckEvidence.opponents}`,
  };
}

const leaderDataOf = (env: DeckEnv, leaderKey: string) => leaderCardsOf(env)?.get(leaderKey) ?? null;

const archetypesIn = (env: MetaEnv, population: string): Archetype[] => env.meta.archetypes.filter((a) => a.population === population);

/** Tournament match record of a leader and base aspect against the field, or against one other archetype. */
function matchupRecord(
  env: MetaEnv,
  leader: string,
  baseAspects: readonly string[],
  opp?: Archetype,
): { wins: number; losses: number; draws: number } | null {
  const m = env.winrates.matchups;
  if (m === null) return null;
  const key = baseAspects.join("+");
  let wins = 0;
  let losses = 0;
  let draws = 0;
  for (const p of m.pairs) {
    if (p.leader !== leader || p.baseAspects.join("+") !== key) continue;
    if (opp !== undefined && (p.oppLeader !== opp.leader.cardKey || p.oppBaseAspects.join("+") !== opp.baseAspects.join("+"))) continue;
    wins += p.wins;
    losses += p.losses;
    draws += p.draws;
  }
  return wins + losses + draws === 0 ? null : { wins, losses, draws };
}

interface Record3 {
  wins: number;
  losses: number;
  draws: number;
}

/** A W-L-D record as shipped: n decisive matches, win rate wins / n (draws left out, as swumetastats does), Wilson 95% interval. */
function rated(r: Record3): { record: string; n: number; winRate: number | null; ci95: string | null } {
  const n = r.wins + r.losses;
  const ci = wilson(r.wins, n);
  return { record: `${r.wins}-${r.losses}-${r.draws}`, n, winRate: rate(r.wins, n), ci95: ci === null ? null : `${ci.low}..${ci.high}` };
}

/** A tournament matchup record with its source and window, or null when no match was recorded. */
function sourcedMatchup(env: MetaEnv, r: Record3 | null) {
  const m = env.winrates.matchups;
  if (r === null || m === null) return null;
  return { ...rated(r), source: SWUMETASTATS_SOURCE, window: `${m.period.from}..${m.period.to}` };
}

// ---------------------------------------------------------------------------------------------
// meta_archetypes

export const metaArchetypesShape = {
  population: populationField,
  leader: z.string().min(1).optional().describe("Only archetypes of this leader: a cardKey or exact title"),
  limit: z.number().int().min(1).max(100).default(10),
};

export function metaArchetypes(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(metaArchetypesShape).parse(input);
  const population = populationOf(env, args.population);
  let list = archetypesIn(env, population);
  if (args.leader !== undefined) {
    const leader = resolveRef(env.deck.store, args.leader, "leader");
    if (!leader.ok) return fail(`leader "${args.leader}": ${leader.reason}, ${leader.detail}`);
    list = list.filter((a) => a.leader.cardKey === leader.row.cardKey);
  }
  const shown = list.slice(0, args.limit);
  return ok({
    dataVersion: env.deck.dataVersion,
    sources: sourcesNote(env, population),
    archetypes: list.length,
    shown: shown.length,
    rows: shown.map((a) => ({
      id: a.id,
      name: a.name,
      leader: a.leader.cardKey,
      leaderAspects: a.leader.aspects.join("+"),
      baseAspects: a.baseAspects.join("+") || "neutral",
      topBase: a.bases[0] === undefined ? null : { cardKey: a.bases[0].cardKey, title: a.bases[0].title },
      share: a.share,
      top8Share: a.top8Share,
      decks: a.decks,
      tournamentRecord: sourcedMatchup(env, matchupRecord(env, a.leader.cardKey, a.baseAspects)),
      threats: detectThreats(a.profile, env.table)
        .map((t) => t.threat.id)
        .join(", "),
      core: a.core
        .slice(0, 6)
        .map((c) => c.title)
        .join("; "),
    })),
    note: "name ends with the cluster's most distinctive core card as \"signature <card>\", which is a core card and not the base; topBase = the base most of its decks play, pass its title or cardKey as the base of playable_cards, deck_audit and meta_answers. share = placement-weighted share of the population's decks in the window; top8Share = share of all top-8 finishes; tournamentRecord = match wins-losses-draws of the leader and base aspect against the whole field (leader-level, all of its archetypes), n = decisive matches (wins + losses), winRate = wins / n (draws left out, as swumetastats does), ci95 = Wilson 95% interval, source swumetastats (melee.gg tournaments). Call meta_threats for one archetype and meta_answers for the cards that answer them.",
  });
}

// ---------------------------------------------------------------------------------------------
// meta_threats

export const metaThreatsShape = {
  archetype: z
    .string()
    .min(1)
    .describe(
      "An archetype id from meta_archetypes (for example t001-b32174, or just its rank part t001), or a leader cardKey or exact title (its largest archetype; add base for the archetype with that base). A leader with no tournament archetype in the window falls back to its community lists, labelled in leaderSource",
    ),
  base: baseField
    .optional()
    .describe("With a leader in archetype: profile the leader's archetype whose bases share this base's aspects, not the leader's largest one"),
  population: populationField,
  coreLimit: z.number().int().min(1).max(40).default(15),
};

interface FoundArchetype {
  archetype: Archetype;
  /** The leader has no archetype in the wanted population, so this is its community one. */
  fallback: boolean;
  leaderKey: string;
}

const sameIcons = (a: readonly string[], b: readonly string[]): boolean => [...a].sort(compareCodePoints).join("+") === [...b].sort(compareCodePoints).join("+");

/** Decks a leader has in the window, per population: its leader-cards entry when that is the population, else the sum of its archetypes. */
function leaderDeckCounts(env: MetaEnv, leaderKey: string): { tournament: number; community: number } {
  const entry = leaderDataOf(env.deck, leaderKey)?.entry;
  const viaArchetypes = (population: string): number =>
    archetypesIn(env, population)
      .filter((a) => a.leader.cardKey === leaderKey)
      .reduce((n, a) => n + a.decks, 0);
  return {
    tournament: entry?.population === "tournament" ? entry.decks : viaArchetypes("tournament"),
    community: entry?.population === "community" ? entry.decks : viaArchetypes("community"),
  };
}

function findArchetype(env: MetaEnv, ref: string, population: string, baseRef: string | undefined): FoundArchetype | string {
  const id = ref.trim();
  const byId = env.meta.archetypes.find((a) => a.id === id || a.id.startsWith(`${id}-`));
  if (byId !== undefined) {
    return baseRef === undefined ? { archetype: byId, fallback: false, leaderKey: byId.leader.cardKey } : "base goes with a leader in archetype, not with an archetype id";
  }
  const leader = resolveRef(env.deck.store, ref, "leader");
  if (!leader.ok) return `no archetype id "${ref}", and as a leader: ${leader.reason}, ${leader.detail}`;
  const leaderKey = leader.row.cardKey;
  let baseKey: string | undefined;
  let baseIcons: readonly string[] | undefined;
  if (baseRef !== undefined) {
    const base = resolveRef(env.deck.store, baseRef, "base");
    if (!base.ok) return `base "${baseRef}": ${base.reason}, ${base.detail}`;
    baseKey = base.row.cardKey;
    baseIcons = env.deck.ctx.graph.byKey.get(baseKey)?.structured.aspectIcons ?? [];
  }
  const matching = (pop: string): Archetype | undefined => {
    const hits = archetypesIn(env, pop).filter((a) => a.leader.cardKey === leaderKey && (baseIcons === undefined || sameIcons(a.baseAspects, baseIcons)));
    return hits.find((a) => baseKey !== undefined && a.bases.some((b) => b.cardKey === baseKey)) ?? hits[0];
  };
  const hit = matching(population);
  if (hit !== undefined) return { archetype: hit, fallback: false, leaderKey };
  const community = population === "community" ? undefined : matching("community");
  if (community !== undefined) return { archetype: community, fallback: true, leaderKey };
  const counts = leaderDeckCounts(env, leaderKey);
  const baseText = baseIcons === undefined ? "" : ` and a base with ${baseIcons.join("+") || "no"} aspects`;
  return `no ${population} or community archetype with leader ${cardLabel(leader.row)}${baseText}: ${counts.tournament} tournament decks, ${counts.community} community decks in ${env.meta.window.from}..${env.meta.window.to}`;
}

export function metaThreats(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(metaThreatsShape).parse(input);
  const found = findArchetype(env, args.archetype, populationOf(env, args.population), args.base);
  if (typeof found === "string") return fail(found);
  const a = found.archetype;
  const leaderData = found.fallback ? leaderDataOf(env.deck, found.leaderKey) : null;
  const communityDecks = leaderDeckCounts(env, found.leaderKey).community;
  const others = archetypesIn(env, a.population)
    .filter((o) => o.id !== a.id && !(o.leader.cardKey === a.leader.cardKey && o.baseAspects.join("+") === a.baseAspects.join("+")))
    .slice(0, 10);
  const vs = others
    .map((o) => ({ archetype: o.name, share: o.share, record: matchupRecord(env, a.leader.cardKey, a.baseAspects, o) }))
    .filter((v) => v.record !== null)
    .map((v) => ({ archetype: v.archetype, share: v.share, ...sourcedMatchup(env, v.record) }));
  return ok({
    dataVersion: env.deck.dataVersion,
    sources: sourcesNote(env, a.population),
    leaderSource: found.fallback
      ? {
          population: "community",
          fallback: true,
          decks: communityDecks,
          window: leaderData === null ? `${env.meta.window.from}..${env.meta.window.to}` : `${leaderData.entry.window.from}..${leaderData.entry.window.to}`,
        }
      : null,
    archetype: {
      id: a.id,
      name: a.name,
      population: a.population,
      share: a.share,
      top8Share: a.top8Share,
      decks: a.decks,
      window: `${a.window.from}..${a.window.to}`,
      cohesion: a.cohesion,
      tournamentRecord: sourcedMatchup(env, matchupRecord(env, a.leader.cardKey, a.baseAspects)),
    },
    leader: { ...a.leader, aspects: a.leader.aspects.join("+"), power: a.profile.leader.power, hp: a.profile.leader.hp },
    bases: a.bases,
    threats: detectThreats(a.profile, env.table).map((t) => ({
      id: t.threat.id,
      title: t.threat.title,
      value: t.value,
      metrics: t.threat.metrics.join(" + "),
      reason: t.threat.reason,
    })),
    profile: {
      units: a.profile.units,
      events: a.profile.events,
      upgrades: a.profile.upgrades,
      groundUnits: a.profile.arena.ground,
      spaceUnits: a.profile.arena.space,
      meanCost: a.profile.meanCost,
      curve: Object.entries(a.profile.curve)
        .map(([k, v]) => `${k}:${v}`)
        .join(" "),
      keywords: Object.entries(a.profile.keywords)
        .filter(([, v]) => v >= 0.5)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
      tokenUnitMakers: a.profile.offers["offers:create-token-units"] ?? 0,
      shieldGivers: (a.profile.offers["offers:give-shield"] ?? 0) + (a.profile.offers["offers:give-shield-self"] ?? 0),
      cheapUnits: a.profile.cheapUnits,
      cheapUnitMedianHp: a.profile.cheapUnitMedianHp,
    },
    keyUnits: a.profile.keyUnits.map((u) => ({
      ...u,
      arenas: u.arenas.join("+"),
      keywords: u.keywords.join(", "),
      traits: u.traits.join(", "),
    })),
    core: a.core.slice(0, args.coreLimit),
    tournamentRecordVs: vs,
    note: `${found.fallback ? "The leader has no tournament archetype in the window, so this is its largest community archetype (leaderSource: the leader's community lists, never pooled with tournament decks); the record against the field is still tournament data for the leader and base aspect. " : ""}Profile figures are placement-weighted mean copies per deck. Threats fire from data/counters.json thresholds. tournamentRecord (against the whole field) and tournamentRecordVs (against each other large archetype's leader and base aspect) are leader-level tournament matchups over all builds: n = decisive matches (wins + losses), winRate = wins / n, ci95 = Wilson 95% interval, source swumetastats (melee.gg tournaments).`,
  });
}

// ---------------------------------------------------------------------------------------------
// meta_answers

export const metaAnswersShape = {
  leader: leaderField.optional().describe("Our leader: a cardKey or exact title; may instead be listed in the decklist"),
  base: baseField.optional().describe("Our base: a cardKey or exact title; may instead be listed in the decklist"),
  decklist: decklistField
    .optional()
    .describe("Our deck as {card, count}; cards already in it are marked inDeck, and a leader and base in it are used when not given"),
  population: populationField,
  archetypes: z.number().int().min(1).max(30).default(10).describe("How many of the largest archetypes to defend against"),
  maxPenalty: z.number().int().min(0).default(0).describe("Highest aspect penalty to allow; 0 keeps cards our leader and base fully cover"),
  evidence: z.boolean().default(true).describe("Include the clause text behind each answer; false drops it"),
  includeUnplayed: z
    .boolean()
    .default(false)
    .describe(
      "Also list answers the leader's tournament decks play in under 2% of their lists (leaderInclusion null or below 0.02); default false keeps them off the page and counts them in capped. A card already in the decklist always stays",
    ),
  limit: z.number().int().min(1).max(60).default(15).describe("How many additions to list; staples (already in the deck or played by 50% or more of the leader's lists) are all listed on top of it"),
  perThreat: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(4)
    .describe("At most this many answers per primary threat are ranked first; further answers to the same threat follow in rank order (60 turns the cap off)"),
  minPerThreat: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(1)
    .describe(
      "Reserve page slots so every threat the defended archetypes pose shows at least this many answers (staples count); a threat whose only answers fall under the leader-inclusion floor gets its best one anyway, flagged hiddenByFloor. 0 turns the reservation off",
    ),
};

/** Decision D46: a staple is in the deck or played in at least this share of our leader's decklists. */
export const STAPLE_INCLUSION = 0.5;
/** Decision D46: a deck with at least this many units (a leader's lists: more than this many) is crowded enough that a sweep mostly hits its own board. */
export const SYMMETRIC_UNIT_COUNT = 30;

interface Answer {
  cardKey: string;
  title: string;
  type: string;
  cost: number | null;
  penalty: number;
  inDeck: number;
  coverage: number;
  threatCount: number;
  /** The threat that contributes most share-weighted coverage to this answer. */
  primaryThreat: string;
  evidence: DeckEvidenceView;
  evidenceClass: EvidenceClass;
  /** Share of our leader's decklists that play the card; null when unplayed or when the package holds no list for the leader. */
  leaderInclusion: number | null;
  /** Decision D46: every offer this card answers with also hits our own units. */
  symmetric: boolean;
  /** Decision D46: symmetric, and our unit count is high enough that the rank puts it behind the other answers of its band. */
  symmetricDemoted: boolean;
  hits: { archetype: Archetype; hit: RelationHit }[];
}

export type EvidenceClass = "ok" | "negative" | "unmeasured" | "thin-control";

/** What a deck-evidence cell needs to be classed: the object cardDeckEvidence returns, or the reason it has none. */
export type DeckEvidenceView =
  | string
  | { withCard: { n: number; decks: number }; withoutCard: { n: number; decks: number }; difference: number | null };

/** The keys meta_answers sorts on, in the order compareAnswerRank applies them. */
export interface AnswerRank {
  cardKey: string;
  penalty: number;
  coverage: number;
  evidenceClass: EvidenceClass;
  cost: number | null;
  /** Decision D45: the tie-break after cost band; undefined and null both sort as unplayed. */
  leaderInclusion?: number | null;
  /** Decision D46: sorts after the other answers of the same coverage band. */
  symmetricDemoted?: boolean;
  threatCount: number;
}

const COVERAGE_BAND = 0.05;
const NEGATIVE_GAP = -0.05;
/** Decision D36: a side with fewer decks than this is one deck's luck, however many matches it played. */
export const MIN_EVIDENCE_DECKS = 10;

/**
 * Decision D36 (#139): the decks without the card are a control group only when they hold at least this share of the
 * comparable decks, or CONTROL_DECKS_CAP decks, whichever is smaller. The decks with the card are not held to it: a
 * rarely played card is still measured against the field (an owner question is open on that side).
 */
export const CONTROL_SHARE = 0.1;
export const CONTROL_DECKS_CAP = 50;

/** The without-card count and the comparable total when the without side is too small to be a control group; undefined otherwise. */
export function thinControl(evidence: Exclude<DeckEvidenceView, string>): { decks: number; of: number } | undefined {
  const of = evidence.withCard.decks + evidence.withoutCard.decks;
  return evidence.withoutCard.decks < Math.min(of * CONTROL_SHARE, CONTROL_DECKS_CAP) ? { decks: evidence.withoutCard.decks, of } : undefined;
}

const thinControlText = (t: NonNullable<ReturnType<typeof thinControl>>): string =>
  `the decks without this card are ${t.decks} of ${t.of} comparable decks: not a control group`;

/** What keeps a side from being measured: fewer than minN decisive matches or fewer than MIN_EVIDENCE_DECKS decks. */
export function thinSides(evidence: Exclude<DeckEvidenceView, string>, minN: number): string[] {
  const out: string[] = [];
  for (const side of ["withCard", "withoutCard"] as const) {
    const e = evidence[side];
    if (e.decks < MIN_EVIDENCE_DECKS) out.push(`${side} has ${e.decks} decks (needs ${MIN_EVIDENCE_DECKS})`);
    if (e.n < minN) out.push(`${side} has ${e.n} decisive matches (needs ${minN})`);
  }
  return out;
}

/**
 * Decision D36: unmeasured unless both sides have at least minN decisive matches. Then negative on a point gap below
 * -0.05 whatever the deck count (a thin negative still warns), else ok only when both sides also have MIN_EVIDENCE_DECKS
 * decks, else unmeasured. #139: an otherwise ok figure whose without-card side holds under the smaller of 10% of the
 * comparable decks and 50 decks is thin-control, because a handful of decks that skip a staple are not a control group.
 */
export function evidenceClassOf(evidence: DeckEvidenceView, minN: number): EvidenceClass {
  if (typeof evidence === "string" || evidence.difference === null) return "unmeasured";
  if (evidence.withCard.n < minN || evidence.withoutCard.n < minN) return "unmeasured";
  if (evidence.difference < NEGATIVE_GAP) return "negative";
  if (thinSides(evidence, minN).length > 0) return "unmeasured";
  return thinControl(evidence) === undefined ? "ok" : "thin-control";
}

/** Decision D36: 0-2, 3-4, 5-6, 7+ and, last, an unknown cost. */
export function costBand(cost: number | null): number {
  if (cost === null) return 4;
  return cost <= 2 ? 0 : cost <= 4 ? 1 : cost <= 6 ? 2 : 3;
}

export function compareAnswerRank(x: AnswerRank, y: AnswerRank): number {
  return (
    x.penalty - y.penalty ||
    Math.round(y.coverage / COVERAGE_BAND) - Math.round(x.coverage / COVERAGE_BAND) ||
    Number(x.symmetricDemoted ?? false) - Number(y.symmetricDemoted ?? false) ||
    Number(x.evidenceClass === "negative") - Number(y.evidenceClass === "negative") ||
    costBand(x.cost) - costBand(y.cost) ||
    (y.leaderInclusion ?? -1) - (x.leaderInclusion ?? -1) ||
    r4(y.coverage) - r4(x.coverage) ||
    y.threatCount - x.threatCount ||
    compareCodePoints(x.cardKey, y.cardKey)
  );
}

/** The threat whose hits add the most coverage (share x weight x fraction); a tie goes to the lower code-point id. */
export function primaryThreatOf(hits: readonly { archetype: Pick<Archetype, "share">; hit: Pick<RelationHit, "threat" | "weight" | "fraction"> }[]): string {
  const by = new Map<string, number>();
  for (const { archetype, hit } of hits) by.set(hit.threat, (by.get(hit.threat) ?? 0) + archetype.share * hit.weight * hit.fraction);
  let best = "";
  let bestValue = -1;
  for (const [threat, value] of [...by].sort((x, y) => compareCodePoints(x[0], y[0]))) {
    if (value > bestValue) {
      best = threat;
      bestValue = value;
    }
  }
  return best;
}

/**
 * Deck-level evidence for one card: comparable tournament decks (our leader and base aspects, else our aspect set)
 * that include it against those that do not, by their whole-event match records. Opponents are not known.
 */
function cardDeckEvidence(env: MetaEnv, cardKey: string, ours: { archetype: string; aspects: string; label: string; aspectText: string }) {
  const ev = env.winrates.deckEvidence;
  if (ev === null) return "no tournament decklists captured";
  for (const [key, comparable] of [
    [ours.archetype, `${ours.label} decks`],
    [ours.aspects, `${ours.aspectText} decks (any leader)`],
  ] as const) {
    const hit = env.evidence.get(key);
    const row = hit?.cards.get(cardKey);
    if (hit === undefined || row === undefined) continue;
    const g = hit.group;
    const withCard = rated(row);
    const without = rated({ wins: g.wins - row.wins, losses: g.losses - row.losses, draws: g.draws - row.draws });
    return {
      comparable,
      withCard: { decks: row.decks, ...withCard },
      withoutCard: { decks: g.decks - row.decks, ...without },
      difference: withCard.winRate === null || without.winRate === null ? null : r4(withCard.winRate - without.winRate),
      opponents: "unknown",
      source: SWUMETASTATS_SOURCE,
      window: `${ev.window.from}..${ev.window.to}`,
    };
  }
  return `fewer than ${env.winrates.minN} decisive matches with or without it among comparable tournament decks in ${ev.window.from}..${ev.window.to}`;
}

function annotated(a: Answer, minN: number): Answer["evidence"] | (Exclude<DeckEvidenceView, string> & Record<string, string>) {
  if (typeof a.evidence === "string") return a.evidence;
  if (a.evidenceClass === "unmeasured") return { ...a.evidence, unmeasured: unmeasuredWhy(a.evidence, minN) };
  if (a.evidenceClass === "thin-control") {
    const thin = thinControl(a.evidence);
    return thin === undefined ? a.evidence : { ...a.evidence, thinControl: thinControlText(thin) };
  }
  if (a.evidenceClass === "negative" && a.evidence.withCard.decks < MIN_EVIDENCE_DECKS)
    return { ...a.evidence, thin: `(thin: ${a.evidence.withCard.decks} decks with the card)` };
  return a.evidence;
}

function unmeasuredWhy(evidence: Exclude<DeckEvidenceView, string>, minN: number): string {
  const thin = thinSides(evidence, minN);
  return thin.length > 0 ? `unmeasured: ${thin.join("; ")}` : "unmeasured: one side has no recorded decisive match, so there is no difference";
}

/** Mean units in our leader's lists: the leader-cards unit rows when the package has them, else our leader's largest archetype. */
function leaderUnitMean(env: MetaEnv, leaderKey: string, population: string, leaderData: ReturnType<typeof leaderDataOf>): number | null {
  if (leaderData !== null)
    return round(
      leaderData.entry.cards.reduce((n, c) => n + (env.deck.store.byKey.get(c.cardKey)?.type === "Unit" ? c.meanCopies : 0), 0),
      2,
    );
  const own = env.meta.archetypes.filter((a) => a.leader.cardKey === leaderKey && a.population === population).sort((x, y) => y.share - x.share);
  return own.length === 0 ? null : own[0].profile.units;
}


export function metaAnswers(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(metaAnswersShape).parse(input);
  const listed = args.decklist ?? [];
  const pickFromList = (kind: "leader" | "base"): string | undefined =>
    listed
      .map((e) => e.card)
      .find((ref) => {
        const r = resolveRef(env.deck.store, ref, kind);
        return r.ok;
      });
  const leaderRef = args.leader ?? pickFromList("leader");
  const baseRef = args.base ?? pickFromList("base");
  if (leaderRef === undefined || baseRef === undefined) return fail("give a leader and a base, or a decklist that lists them");
  const pair = resolvePair(env.deck, leaderRef, baseRef);
  if (typeof pair === "string") return fail(pair);
  const mainEntries = listed.filter((e) => e.card !== leaderRef && e.card !== baseRef);
  const partial = mainEntries.length === 0 ? { lines: [], unresolved: [] } : resolveList(env.deck, mainEntries, "main");
  const inDeck = new Map(partial.lines.map((l) => [l.syn.cardKey, l.count]));
  const supplied = suppliedBy(pair);
  const population = populationOf(env, args.population);
  const targets = archetypesIn(env, population).slice(0, args.archetypes);
  const threatsOf = new Map(targets.map((a) => [a.id, new Set(detectThreats(a.profile, env.table).map((t) => t.threat.id))]));
  const consideredShare = targets.reduce((s, a) => s + a.share, 0);
  const leaderData = leaderDataOf(env.deck, pair.leader.row.cardKey);
  const unitBasis =
    mainEntries.length > 0
      ? { units: partial.lines.reduce((n, l) => n + (l.syn.type === "Unit" ? l.count : 0), 0), from: "the decklist" }
      : { units: leaderUnitMean(env, pair.leader.row.cardKey, population, leaderData), from: "the leader's decklists (mean)" };
  const demoteSymmetric =
    unitBasis.units !== null && (mainEntries.length > 0 ? unitBasis.units >= SYMMETRIC_UNIT_COUNT : unitBasis.units > SYMMETRIC_UNIT_COUNT);
  const baseIcons = pair.base.syn.structured.aspectIcons;
  const ourAspects = [...pair.leader.syn.structured.aspectIcons, ...baseIcons];
  const ours = {
    archetype: archetypeEvidenceKey(pair.leader.row.cardKey, baseIcons),
    aspects: aspectsEvidenceKey(ourAspects),
    label: `${cardLabel(pair.leader.row)} / ${baseIcons.join("+") || "neutral"} base`,
    aspectText: [...ourAspects].sort(compareCodePoints).join("+") || "no-aspect",
  };

  const answers: Answer[] = [];
  for (const syn of env.deck.ctx.cards) {
    const row = env.deck.store.byKey.get(syn.cardKey);
    const entry = env.cards.get(syn.cardKey);
    if (row === undefined || entry === undefined || !MAIN_TYPES.has(syn.type) || cardScope(env.deck.store, row) === "rotated") continue;
    const penalty = singlePenalty(syn, supplied);
    if (penalty > args.maxPenalty) continue;
    const hits: Answer["hits"] = [];
    let coverage = 0;
    for (const a of targets) {
      const live = threatsOf.get(a.id) as Set<string>;
      let best: RelationHit | null = null;
      for (const relation of env.table.relations) {
        if (!live.has(relation.threat)) continue;
        const hit = relationHit(entry.card, entry.offers, relation, a.profile);
        if (hit !== null && (best === null || hit.weight * hit.fraction > best.weight * best.fraction)) best = hit;
      }
      if (best === null) continue;
      hits.push({ archetype: a, hit: best });
      coverage += a.share * best.weight * best.fraction;
    }
    if (hits.length === 0) continue;
    const symmetric = hits.every((h) => h.hit.symmetric);
    const evidence = cardDeckEvidence(env, syn.cardKey, ours);
    answers.push({
      cardKey: syn.cardKey,
      title: cardLabel(syn),
      type: syn.type,
      cost: syn.structured.cost,
      penalty,
      inDeck: inDeck.get(syn.cardKey) ?? 0,
      coverage,
      threatCount: new Set(hits.map((h) => h.hit.threat)).size,
      primaryThreat: primaryThreatOf(hits),
      evidence,
      evidenceClass: evidenceClassOf(evidence, env.winrates.minN),
      leaderInclusion: leaderData?.byCard.get(syn.cardKey)?.inclusion ?? null,
      symmetric,
      symmetricDemoted: symmetric && demoteSymmetric,
      hits,
    });
  }
  answers.sort(compareAnswerRank);
  const hidden = new Set(
    leaderData === null || args.includeUnplayed
      ? []
      : answers.filter((a) => a.inDeck === 0 && (a.leaderInclusion ?? 0) < LEADER_INCLUSION_FLOOR),
  );
  const hiddenRows = answers.filter((a) => hidden.has(a));
  const visible = hidden.size === 0 ? answers : answers.filter((a) => !hidden.has(a));
  const isStaple = (a: Answer): boolean => a.inDeck > 0 || (a.leaderInclusion ?? 0) >= STAPLE_INCLUSION;
  const staples = visible.filter(isStaple);
  const candidates = visible.filter((a) => !isStaple(a));
  const { ordered, deferred } = deferRepeatedLinks(candidates, (a) => a.primaryThreat, args.perThreat);

  const threatShares = [...new Set(targets.flatMap((a) => [...(threatsOf.get(a.id) as Set<string>)]))]
    .map((threat) => ({
      threat,
      share: r4(targets.filter((a) => (threatsOf.get(a.id) as Set<string>).has(threat)).reduce((s, a) => s + a.share, 0)),
    }))
    .sort((x, y) => y.share - x.share || compareCodePoints(x.threat, y.threat));
  const addresses = (a: Answer, threat: string): boolean => a.hits.some((h) => h.hit.threat === threat);
  // Decision D46: before the rank fill, each fired threat gets minPerThreat answers (staples count), the best-ranked
  // first; a threat with no answer above the floor takes its best hidden one.
  const reservedList: Answer[] = [];
  const fromHidden = new Set<Answer>();
  if (args.minPerThreat > 0) {
    for (const { threat } of threatShares) {
      const have = (): number => [...staples, ...reservedList].filter((a) => addresses(a, threat)).length;
      for (const a of candidates) {
        if (have() >= args.minPerThreat) break;
        if (!reservedList.includes(a) && addresses(a, threat)) reservedList.push(a);
      }
      const rescue = have() === 0 ? hiddenRows.find((a) => addresses(a, threat)) : undefined;
      if (rescue !== undefined) {
        reservedList.push(rescue);
        fromHidden.add(rescue);
      }
    }
  }
  const kept = new Set(reservedList.slice(0, args.limit));
  const rankPage = new Set(ordered.slice(0, args.limit));
  const page = new Set([...kept, ...ordered.filter((a) => !kept.has(a)).slice(0, args.limit - kept.size)]);
  const additions = [
    ...ordered.filter((a) => page.has(a)),
    ...[...kept].filter((a) => fromHidden.has(a)).sort((x, y) => answers.indexOf(x) - answers.indexOf(y)),
  ];
  const isReserved = (a: Answer): boolean => kept.has(a) && (fromHidden.has(a) || !rankPage.has(a));
  const leftOut = hidden.size - [...kept].filter((a) => fromHidden.has(a)).length;
  const shownRows = [...staples, ...additions];
  const threatsCovered = threatShares
    .map((t) => `${t.threat} ${shownRows.filter((a) => addresses(a, t.threat)).length} (share ${t.share})`)
    .join("; ");

  const byThreat = (a: Answer) => {
    const groups = new Map<
      string,
      { threat: string; relation: string; offer: string; evidence: string; archetypes: string[]; units: Set<string>; symmetric?: boolean }
    >();
    for (const { archetype, hit } of a.hits) {
      const key = `${hit.relation}|${hit.offer}`;
      const g = groups.get(key) ?? {
        threat: hit.threat,
        relation: hit.relation,
        offer: hit.offer,
        evidence: hit.evidence,
        archetypes: [],
        units: new Set<string>(),
      };
      if (hit.symmetric) g.symmetric = true;
      g.archetypes.push(`${archetype.id} (${archetype.share})`);
      for (const u of hit.answers) g.units.add(u);
      groups.set(key, g);
    }
    return [...groups.values()].map((g) => ({
      threat: g.threat,
      relation: g.relation,
      offer: g.offer,
      ...(g.symmetric ? { symmetric: true } : {}),
      ...(args.evidence ? { evidence: g.evidence } : {}),
      archetypes: g.archetypes.join(", "),
      keyUnitsRemoved:
        g.units.size === 0
          ? null
          : `${g.units.size}: ${[...g.units].sort(compareCodePoints).slice(0, 6).join("; ")}${g.units.size > 6 ? "; ..." : ""}`,
    }));
  };

  const symmetricText =
    unitBasis.units === null
      ? "not demoted: no decklist and no leader data give a unit count"
      : demoteSymmetric
        ? `demoted: ${unitBasis.units} units from ${unitBasis.from} is ${mainEntries.length > 0 ? `${SYMMETRIC_UNIT_COUNT} or more` : `more than ${SYMMETRIC_UNIT_COUNT}`}, so a sweep mostly kills our own board and symmetric answers sort after the other answers of the same coverage band`
        : `not demoted: ${unitBasis.units} units from ${unitBasis.from} is under the ${SYMMETRIC_UNIT_COUNT}-unit line`;
  const rowOf = (a: Answer) => ({
    cardKey: a.cardKey,
    title: a.title,
    type: a.type,
    cost: a.cost,
    penalty: a.penalty,
    inDeck: a.inDeck,
    coverage: r4(a.coverage),
    archetypesAnswered: a.hits.length,
    threatsAnswered: a.threatCount,
    primaryThreat: a.primaryThreat,
    status: CANDIDATE_STATUS,
    ...(a.symmetric ? { symmetric: true } : {}),
    ...(isReserved(a) ? { reserved: true } : {}),
    ...(fromHidden.has(a) && kept.has(a) ? { hiddenByFloor: true } : {}),
    answers: byThreat(a),
    deckEvidence: annotated(a, env.winrates.minN),
    evidenceClass: a.evidenceClass,
    leaderInclusion: a.leaderInclusion,
  });

  return ok({
    dataVersion: env.deck.dataVersion,
    sources: sourcesNote(env, population),
    leader: { cardKey: pair.leader.row.cardKey, title: cardLabel(pair.leader.row) },
    base: { cardKey: pair.base.row.cardKey, title: cardLabel(pair.base.row) },
    suppliedIcons: supplied.join("+") || "none",
    unresolved: partial.unresolved,
    defendingAgainst: targets.map((a) => ({
      id: a.id,
      name: a.name,
      share: a.share,
      threats: [...(threatsOf.get(a.id) as Set<string>)].join(", "),
      ourTournamentRecord: sourcedMatchup(env, matchupRecord(env, pair.leader.row.cardKey, baseIcons, a)),
    })),
    consideredShare: r4(consideredShare),
    matched: answers.length,
    shown: shownRows.length,
    capped: deferred + leftOut,
    leaderSource:
      leaderData === null
        ? null
        : {
            population: leaderData.entry.population,
            fallback: leaderData.entry.fallback,
            decks: leaderData.entry.decks,
            window: `${leaderData.entry.window.from}..${leaderData.entry.window.to}`,
          },
    threatsCovered,
    symmetricSweeps: {
      demoted: demoteSymmetric,
      units: unitBasis.units,
      basis: unitBasis.units === null ? "no unit count available: no decklist and no leader data" : `${unitBasis.units} units, from ${unitBasis.from}`,
    },
    staples: staples.map(rowOf),
    additions: additions.map(rowOf),
    note: `Penalty-free cards first, then by coverage = sum over the archetypes answered of share x relation weight x the share of key-unit copies removed (removal) or 1, in bands of 0.05. Within a coverage band the order is evidenceClass (ok and unmeasured before negative), then cost band (0-2, 3-4, 5-6, 7+), then leaderInclusion (more-played first, unplayed last), then exact coverage. evidenceClass = unmeasured unless both sides (with the card, without it) have at least minN decisive matches; then negative when the difference is below -0.05 (deckEvidence.thin flags a negative with under 10 decks with the card), and ok only when both sides also have 10 decks, else unmeasured (deckEvidence.unmeasured names the thin side); an otherwise ok figure whose without-card side holds under the smaller of ${CONTROL_SHARE * 100}% of the comparable decks and ${CONTROL_DECKS_CAP} decks is thin-control (deckEvidence.thinControl: the decks without this card are N of M comparable decks: not a control group), sorted with ok and unmeasured, because a few decks that skip a staple are not a control group. The class only reorders within a band and removes no row; it is association, not effect, because opponents are unknown. perThreat ${args.perThreat}: at most ${args.perThreat} answers per primary threat (the threat adding the most coverage to the answer) are ranked first, so the page shows a spread of threats; ${deferred} further answers to an already-listed threat follow in rank order (perThreat 60 turns the cap off). leaderInclusion = ${leaderData === null ? "not available: this package holds no decklist data for our leader, so nothing is filtered or tie-broken by it" : `placement-weighted share of our leader's ${leaderData.entry.population} decklists that play the card (${leaderSourceText(leaderData.entry)}); null = unplayed there`}. ${args.includeUnplayed || leaderData === null ? "includeUnplayed: every answer is listed." : `The page leaves out answers under ${LEADER_INCLUSION_FLOOR * 100}% leaderInclusion that are not already in the deck (${hidden.size} left out; includeUnplayed: true lists them).`} capped counts the answers deferred by perThreat plus those left out (minus any the page shows as hiddenByFloor). staples = answers already in the deck (inDeck above 0) or played by ${STAPLE_INCLUSION * 100}% or more of our leader's decklists; additions = the rest, so a builder sees what to add first. limit, perThreat and the leaderInclusion floor apply to additions only; every staple is listed. minPerThreat ${args.minPerThreat}: ${args.minPerThreat === 0 ? "off." : `before the rank fill each threat the defended archetypes pose gets at least ${args.minPerThreat} answer(s) on the page (a staple counts), best-ranked first, marked reserved: true when the rank alone would not have shown it; a threat whose every answer falls under the leaderInclusion floor gets its best hidden one anyway, marked reserved: true and hiddenByFloor: true, so a threat with an answer in the pool never reads 0.`} symmetric: true marks an answer whose every offer defeats or damages all or each unit of both sides, our own board included. symmetricSweeps: ${symmetricText}. threatsCovered counts staples and additions together: each threat the defended archetypes pose, the number of shown answers that address it and the meta share of the archetypes posing it; 0 means no answer in the pool addresses it (or minPerThreat is 0 and none was shown). Answers are candidates: confirm each clause (evidence) against the card text, then run deck_audit with the swaps. deckEvidence: match records of comparable tournament decks (our leader and base aspects, else our aspect set) with the card against those without it; n = decisive matches (wins + losses), winRate = wins / n, ci95 = Wilson 95% interval, source swumetastats (melee.gg tournaments). Opponents are unknown (each record is the deck's whole event), so it is not a win rate against any archetype, and it is association, not effect. ourTournamentRecord: our leader and base aspect against that archetype's leader and base aspect in tournament matchups, same fields.`,
  });
}

// ---------------------------------------------------------------------------------------------
// leader_cards

/** These rows are counts over decklists, not candidate links, so they carry status fact. */
export const FACT_STATUS = "fact";

export const leaderCardsShape = {
  leader: leaderField,
  limit: z.number().int().min(1).max(LEADER_CARDS_MAX).default(40),
  sortBy: z
    .enum(["inclusion", "lift"])
    .default("inclusion")
    .describe("inclusion (default): raw popularity in the leader's decks; lift: inclusion minus the card's inclusion in decks that could play it"),
  minInclusion: z.number().min(0).max(1).default(0.1).describe("Leave out cards played in a smaller share of the leader's decks"),
};

export function leaderCards(env: MetaEnv, input: unknown): ToolResult {
  const args = z.object(leaderCardsShape).parse(input);
  const index = leaderCardsOf(env.deck);
  if (index === null) return fail('no meta/leader-cards.json in this data package; it predates the leader index (run "pnpm meta" or "pnpm build:data")');
  const leader = resolveRef(env.deck.store, args.leader, "leader");
  if (!leader.ok) return fail(`leader "${args.leader}": ${leader.reason}, ${leader.detail}`);
  const hit = index.get(leader.row.cardKey);
  if (hit === undefined) return fail(`no tournament or community decklist with leader ${cardLabel(leader.row)} in ${env.meta.window.from}..${env.meta.window.to}`);
  const { entry } = hit;
  const kept = entry.cards.filter((c) => c.inclusion >= args.minInclusion);
  const sorted =
    args.sortBy === "lift"
      ? kept.slice().sort((a, b) => b.lift - a.lift || b.inclusion - a.inclusion || compareCodePoints(a.cardKey, b.cardKey))
      : kept;
  const shown = sorted.slice(0, args.limit);
  return ok({
    dataVersion: env.deck.dataVersion,
    leader: { cardKey: leader.row.cardKey, title: cardLabel(leader.row) },
    population: entry.population,
    fallback: entry.fallback,
    window: `${entry.window.from}..${entry.window.to}`,
    decks: entry.decks,
    topBase: entry.topBase,
    status: FACT_STATUS,
    sortBy: args.sortBy,
    matched: kept.length,
    shown: shown.length,
    cards: shown,
    note: `Counts over this leader's decklists (${leaderSourceText(entry)}), every deck of the leader in the window, all its archetypes. inclusion = placement-weighted share of the leader's decks that play the card; meanCopies = placement-weighted copies per deck; baselineInclusion = the same share across every ${entry.population} deck in the window whose leader and base icons cover the card's aspects (decks that could play it without a penalty); lift = inclusion - baselineInclusion. Weighting: ${env.meta.method.weighting}. Small deck counts are noisy; at most ${LEADER_CARDS_MAX} cards per leader are kept.`,
  });
}

// ---------------------------------------------------------------------------------------------
// registration

function withEnv(store: CardStore, run: (env: MetaEnv) => ToolResult): ToolResult {
  try {
    return run(metaEnvOf(store));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const tool = (title: string, description: string, shape: z.ZodRawShape, run: (env: MetaEnv, input: unknown) => ToolResult) => ({
  title,
  description,
  shape,
  handler: (store: CardStore, input: unknown): ToolResult => withEnv(store, (env) => run(env, input)),
});

export const META_TOOLS = {
  meta_archetypes: tool(
    "Meta archetypes",
    "The current Premier archetypes: recent tournament decklists (placement-weighted) clustered by leader, base aspect and shared core cards, with meta share, top-8 share, the date window, the leader's tournament match record, the threats each poses, its core cards and its most-played base (topBase). Community lists are a separate, labelled population.",
    metaArchetypesShape,
    metaArchetypes,
  ),
  meta_threats: tool(
    "Meta threats",
    "One archetype in depth: leader and bases, threat profile (arena split, curve, keywords, upgrade and token reliance), key units with cost, power and HP, core cards with inclusion rates, the threats it poses and its tournament record against the other large archetypes. A leader with no tournament archetype in the window falls back to its largest community archetype (leaderSource: population community, fallback true, decks); an error names both deck counts only when neither population holds a deck. Give base with a leader to profile the archetype with that base's aspects.",
    metaThreatsShape,
    metaThreats,
  ),
  meta_answers: tool(
    "Meta answers",
    "Cards in our aspects that answer the largest archetypes, penalty-free first: for each, the threats it answers with clause evidence and status: candidate, coverage weighted by meta share, cost, whether it is already in the deck, and tournament deck evidence: the match win rate of comparable decks with the card against those without it (n, Wilson 95% interval, swumetastats source and window; opponents unknown) and its evidenceClass (negative; ok; or unmeasured when either side has under minN decisive matches, or under 10 decks without a negative gap). Within a coverage band, ok and unmeasured answers rank before negative ones, then cheaper cost bands first, then the answer more of our leader's tournament decks play (leaderInclusion). The page leaves out answers the leader's decks play in under 2% of their lists unless they are already in the decklist or includeUnplayed is true (capped counts them). perThreat (default 4) lists at most that many answers per primary threat before answers that repeat a threat. minPerThreat (default 1) reserves a page slot for the best answer of every fired threat, taking one under the leader-inclusion floor (hiddenByFloor) when nothing above it answers, so threatsCovered reads 0 only for a threat with no answer in the pool. The output splits into staples (in the deck, or played by 50% or more of the leader's lists) and additions (limit applies to these), and threatsCovered counts both. symmetric: true marks a sweep that also hits our own units; it sorts after the other answers of its coverage band when the deck runs 30 or more units (a decklist) or the leader's lists average more than 30. Takes a leader and base, or a decklist.",
    metaAnswersShape,
    metaAnswers,
  ),
  leader_cards: tool(
    "Leader cards",
    "The cards a leader's recent decklists actually play: for every card in the leader's decks in the meta window (tournament decklists, or community lists only when the leader has no tournament deck, and the output says so), the placement-weighted inclusion, mean copies, baseline inclusion among decks whose aspects could play it, and lift over that baseline. Names the population, window and deck count; status: fact. sortBy inclusion (raw popularity) or lift.",
    leaderCardsShape,
    leaderCards,
  ),
} as const;
