import { decode } from "@toon-format/toon";
import { z } from "zod";
import type { CardRow, CardStore } from "../data.js";
import type { EvidenceClass } from "../meta/deck-evidence.js";
import { SWUMETASTATS_SOURCE } from "../meta/schema.js";
import { compareCodePoints } from "../swu/canonical.js";
import { clauseLock, isLocked, lockFields, lockSupply } from "../synergy/clause-lock.js";
import { leaderEngineOf } from "../synergy/leader-engine.js";
import { baseEnabledOf } from "../synergy/locks.js";
import { cardLabel } from "../synergy/order.js";
import type { SynergyCard } from "../synergy/schema.js";
import type { ToolResult } from "../tools.js";
import { fail, ok, round } from "./common.js";
import {
  LEADER_INCLUSION_FLOOR,
  LEADER_STAPLE_INCLUSION,
  MAIN_TYPES,
  baseField,
  cardScope,
  deckAudit,
  deckEnvOf,
  deckLegalityCheck,
  drawbackOf,
  inPremierPool,
  leaderCardsOf,
  leaderDataFor,
  leaderField,
  leaderSourceText,
  pairEvidence,
  resolveList,
  resolvePair,
  resolveRef,
  singlePenalty,
  suppliedBy,
  type DeckEnv,
} from "./deck.js";
import { cardList } from "./decklist-field.js";
import { findPairings, findTrios } from "./synergy.js";
import { swudbDeckSchema, swudbIdOf } from "./swudb.js";

/**
 * @displayName Deck builder
 * @strategicPurpose Owner, 2026-11-01 (#186): "serve me most valuable cards for the warrior as a decklist in a .json for
 * karabast input" and "the analyses should be built into our mcp capabilities". The hand procedure that built the Warrior
 * list from playable_cards, find_pairings, find_trios, meta_answers evidence, deck_audit and deck_legality_check becomes one
 * deterministic tool.
 * @tacticalObjective Ranks every Premier main-deck card under a leader and base by its separate evidence lines (the leader's
 * lists, measured tournament gaps, the leader engine and trio packages, the base, the rubric score), fills exactly 50 cards
 * (at most 3 copies) under per-cost caps drawn from the leader's lists, keeps accepted trio packages whole, and returns the
 * SWUDB document with set-code ids, the swaps against a starting list, the deck_audit headline and the deck_legality_check
 * result. No model, no clock, no randomness; ties break by cardKey code points.
 */

const DECK_SIZE = 50;
const MAX_COPIES = 3;

// Ranking weights. Each term rests on one evidence tier and is printed in the card's why line, so a reader sees what moved it.
/** Per unit of leaderInclusion, counted only at or above the 2% floor: a 78% staple adds 3.1. */
export const PLAYED_WEIGHT = 4;
/** Per unit of measured win-rate gap: +5 points adds 1.0. */
export const MEASURED_WEIGHT = 20;
/** A measured card the leader's lists do not play counts a quarter: the gap comes from other leaders' decks. */
const UNPLAYED_MEASURED_FACTOR = 0.25;
/** Per unit of find_pairings rank above 0.5 (the unplayed floor of a leader-weighted rank) on a leader-engine row. */
export const ENGINE_WEIGHT = 2;
/** The same for a pair-graph link from the leader that is not its engine. */
export const LINK_WEIGHT = 1;
/** A leader-engine partner at this rank or more is an engine core card and wants 3 copies (The Chieftain 1.91, Insurgent Camp 1.65). */
const ENGINE_CORE_RANK = 1.5;
/** Per point of play-calibrated score above 0. */
export const SCORE_WEIGHT = 0.2;
/** The base enables the card's own clause (D73): an evidence line, but not play evidence, so it weighs less than a 20% card. */
export const BASE_ENABLED_BONUS = 0.75;
const DRAWBACK_COST = 0.5;
/** A card of the starting list keeps a lead over an equal newcomer. */
const HELD_BONUS = 0.75;
/** Per unit of find_trios rank, added to every member of an accepted package. */
const TRIO_WEIGHT = 0.5;
const MAX_PACKAGES = 3;
/** Trio rows of find_trios read for packages. */
const TRIO_POOL = 15;
const TRIO_MAX_COST = 12;

// Curve. The caps and floors come from the leader's lists' copies per cost, scaled to 50 cards.
const CURVE_BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+"] as const;
/** Without leader lists: a plain midrange curve. */
const DEFAULT_CURVE: Readonly<Record<string, number>> = { "0": 0, "1": 6, "2": 10, "3": 11, "4": 9, "5": 6, "6": 5, "7+": 3 };
const CAP_FACTOR = 1.3;
/** deck_audit names a cost holding more than 40% of the cards a glut; a cap stays at that line. */
const GLUT_CAP = 20;
const MIN_CAP = 3;
const FLOOR_FACTOR = 0.75;
/** Costs 2 to 6 get a floor; a floor at 0, 1 or 7+ would force weak cards into a cost the hand fills anyway or rarely casts. */
const FLOOR_COSTS = new Set(["2", "3", "4", "5", "6"]);
const LEFT_OUT_ROWS = 15;

const bucketOf = (cost: number): string => (cost >= 7 ? "7+" : String(cost));
const points = (gap: number): string => `${gap >= 0 ? "+" : ""}${round(gap * 100, 1)} points`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

export const buildDeckShape = {
  leader: leaderField.optional().describe("The leader: a cardKey, a SET_NNN id or an exact title. Required unless swudb is given"),
  base: baseField
    .optional()
    .describe("The base: a cardKey, a SET_NNN id or an exact title. Omitted: the base most of the leader's decklists run, with the runner-up reported"),
  decklist: cardList("A starting list to improve, as {card, count}; the answer lists the swaps against it").optional(),
  swudb: swudbDeckSchema
    .optional()
    .describe("A starting deck as the SWUDB JSON interchange document; its leader and base are used unless leader or base is given, and its sideboard unless sideboard is given"),
  mustInclude: cardList("Cards that must be in the 50, with exactly these copies (1 to 3)").optional(),
  exclude: z.array(z.string().min(1)).max(100).optional().describe("Cards never to pick (cardKeys, SET_NNN ids or exact titles)"),
  sideboard: cardList("The sideboard, kept exactly as given and checked with the deck (at most 10 cards)").optional(),
  format: z.literal("premier").default("premier").describe("premier: the Premier cardpool and deck rules"),
  name: z.string().min(1).max(80).optional().describe("Deck name written to metadata.name"),
};
const buildDeckInput = z.strictObject(buildDeckShape);
type BuildDeckInput = z.infer<typeof buildDeckInput>;

// Tool-to-tool seams: the outputs of find_pairings, find_trios, deck_audit and deck_legality_check are parsed here, at the consumer.
export const pairingsOutput = z.looseObject({
  pairings: z
    .array(z.looseObject({ cardKey: z.string(), linkKind: z.string(), link: z.string(), score: z.number(), rank: z.number().optional() }))
    .default([]),
  leader: z.looseObject({ engine: z.looseObject({ action: z.string().optional() }).optional() }).optional(),
});
const TRIO_LOCKS = ["baseLocked", "nameLocked", "needsForce", "needsTrait", "needsHost", "leaderClash", "riderUnmet", "drawback"] as const;
const triosOutput = z.looseObject({
  trios: z
    .array(z.looseObject({ cards: z.string(), cardKeys: z.string(), score: z.number(), rank: z.number().optional(), penalty: z.number(), reasons: z.string() }))
    .default([]),
});
export const auditOutput = z.looseObject({
  aspect: z.looseObject({ penalty: z.number(), uncovered: z.array(z.unknown()) }),
  score: z.looseObject({ meanPlayCalibrated: z.number().nullable() }).optional(),
  curveGlut: z.looseObject({ cost: z.union([z.number(), z.string()]).optional() }).optional(),
  orphanWants: z.array(z.looseObject({ card: z.string() })).optional(),
  lockedCards: z.looseObject({ cards: z.array(z.unknown()) }).optional(),
  leaderComparison: z
    .looseObject({ missingStaples: z.array(z.looseObject({ card: z.string(), penalty: z.number().optional(), evidenceClass: z.string().optional() })).optional() })
    .nullable()
    .optional(),
});
export const legalityOutput = z.looseObject({
  legal: z.boolean(),
  counts: z.looseObject({ mainDeck: z.number() }),
  failures: z.array(z.unknown()),
  warnings: z.array(z.unknown()),
});

export function decoded<T extends z.ZodType>(schema: T, result: ToolResult, what: string): z.infer<T> | string {
  if (result.isError === true) return `${what}: ${result.content[0]?.text ?? "error"}`;
  const parsed = schema.safeParse(decode(result.content[0].text));
  return parsed.success ? parsed.data : `${what} answered in an unexpected shape: ${z.prettifyError(parsed.error)}`;
}

interface Candidate {
  syn: SynergyCard;
  row: CardRow;
  id: string;
  cost: number;
  bucket: string;
  penalty: number;
  inclusion: number | null;
  meanCopies: number | null;
  evidenceClass: EvidenceClass | null;
  evidenceGap: number | null;
  playCalibrated: number | null;
  engine: { link: string; rank: number; leaderEngine: boolean } | null;
  enabled: string | null;
  drawback: string | null;
  lock: string | null;
  held: number;
  must: number | null;
  excluded: boolean;
  package: string | null;
  rides: boolean;
  value: number;
}

const played = (c: Candidate): boolean => c.inclusion !== null && c.inclusion >= LEADER_INCLUSION_FLOOR;

/** Why a card cannot be picked on its own evidence; null when it can. A must-include overrides every reason but a rotated card. */
function barOf(c: Candidate): string | null {
  if (c.excluded) return "excluded (asked)";
  if (c.penalty > 0) return `pays aspect penalty +${c.penalty} under this leader and base`;
  if (c.evidenceClass === "negative") return `measured negative: ${points(c.evidenceGap ?? 0)} with it in comparable tournament decks`;
  if (c.lock !== null) return `locked: ${c.lock}`;
  return null;
}

function valueOf(c: Candidate, trioRank: number): number {
  let v = 0;
  if (played(c)) v += PLAYED_WEIGHT * (c.inclusion as number);
  if (c.evidenceClass === "ok" && c.evidenceGap !== null) v += MEASURED_WEIGHT * c.evidenceGap * (played(c) ? 1 : UNPLAYED_MEASURED_FACTOR);
  if (c.engine !== null) v += (c.engine.leaderEngine ? ENGINE_WEIGHT : LINK_WEIGHT) * Math.max(0, c.engine.rank - 0.5);
  v += SCORE_WEIGHT * Math.max(0, c.playCalibrated ?? 0);
  if (c.enabled !== null) v += BASE_ENABLED_BONUS;
  if (c.drawback !== null) v -= DRAWBACK_COST;
  if (c.held > 0) v += HELD_BONUS;
  v += TRIO_WEIGHT * trioRank;
  return round(v, 4);
}

function desiredCopies(c: Candidate): number {
  if (c.must !== null) return c.must;
  if (c.rides) return 1;
  if ((c.inclusion ?? 0) >= LEADER_STAPLE_INCLUSION || (c.engine?.leaderEngine === true && c.engine.rank >= ENGINE_CORE_RANK)) return MAX_COPIES;
  if (played(c) && c.meanCopies !== null && (c.inclusion as number) > 0) return Math.min(MAX_COPIES, Math.max(1, Math.round(c.meanCopies / (c.inclusion as number))));
  return 2;
}

function whyOf(c: Candidate, population: string | null): string {
  const parts: string[] = [];
  if (c.must !== null) parts.push("must-include (asked)");
  if (c.penalty > 0) parts.push(`aspect penalty +${c.penalty} each`);
  if (c.engine !== null) parts.push(`${c.engine.leaderEngine ? "leader engine" : "leader link"}: ${c.engine.link} (find_pairings rank ${c.engine.rank})`);
  if (c.package !== null) parts.push(`package: ${c.package}${c.rides ? " (rides on the package, 1 copy)" : ""}`);
  if (c.inclusion !== null && population !== null) {
    const share = `${pct(c.inclusion)} of the leader's ${population} lists`;
    parts.push(c.inclusion >= LEADER_STAPLE_INCLUSION ? `staple: in ${share}` : played(c) ? `played: in ${share}` : `in ${share}, under the ${pct(LEADER_INCLUSION_FLOOR)} floor`);
  }
  if ((c.evidenceClass === "ok" || c.evidenceClass === "negative") && c.evidenceGap !== null)
    parts.push(`measured ${c.evidenceClass === "ok" ? "ok" : "negative"} ${points(c.evidenceGap)} with it in comparable tournament decks`);
  if (c.enabled !== null) parts.push(`base enables it: ${c.enabled}`);
  if (c.lock !== null) parts.push(`locked: ${c.lock}`);
  if (c.drawback !== null) parts.push(`drawback: "${c.drawback}"`);
  if (c.held > 0) parts.push(`starting list x${c.held}`);
  if (c.playCalibrated !== null) parts.push(`play-calibrated ${round(c.playCalibrated, 2)}`);
  return parts.join("; ");
}

/** The leader's lists' copies per cost bucket, scaled to 50 cards; null when the package holds no lists for the leader. */
function leaderCurve(env: DeckEnv, data: ReturnType<typeof leaderDataFor>): Record<string, number> | null {
  if (data === null) return null;
  const copies: Record<string, number> = Object.fromEntries(CURVE_BUCKETS.map((b) => [b, 0]));
  let total = 0;
  for (const row of data.entry.cards) {
    const syn = env.ctx.graph.byKey.get(row.cardKey);
    const cost = syn?.structured.cost ?? null;
    if (syn === undefined || cost === null || !MAIN_TYPES.has(syn.type)) continue;
    copies[bucketOf(cost)] += row.meanCopies;
    total += row.meanCopies;
  }
  if (total === 0) return null;
  return Object.fromEntries(CURVE_BUCKETS.map((b) => [b, (copies[b] * DECK_SIZE) / total]));
}

interface BaseChoice {
  cardKey: string;
  chosenBy: string;
  runnerUp: { cardKey: string; title: string; id: string | null; decks: number } | null;
}

/** The base most of the leader's lists run, among bases still in the Premier pool, and the next one. */
function defaultBase(env: DeckEnv, leaderKey: string): BaseChoice | string {
  const entry = leaderCardsOf(env)?.get(leaderKey)?.entry;
  const bases = (entry?.baseDecks ?? []).filter((b) => {
    const row = env.store.byKey.get(b.cardKey);
    return row !== undefined && row.type === "Base" && cardScope(env.store, row) !== "rotated";
  });
  if (entry === undefined || bases.length === 0) return "no base given and the package holds no per-base decklist counts for this leader to choose one from; give base";
  const [best, next] = bases;
  const runner = next === undefined ? undefined : env.store.byKey.get(next.cardKey);
  return {
    cardKey: best.cardKey,
    chosenBy: `most played: ${best.decks} of ${entry.decks} of the leader's ${entry.population} lists (${entry.window.from}..${entry.window.to}) run it`,
    runnerUp: next === undefined || runner === undefined ? null : { cardKey: next.cardKey, title: next.title, id: swudbIdOf(runner), decks: next.decks },
  };
}

interface Item {
  members: string[];
  value: number;
  isPackage: boolean;
}

export function buildDeck(env: DeckEnv, input: unknown): ToolResult {
  const parsed = buildDeckInput.safeParse(input);
  if (!parsed.success) return fail(`build_deck input: ${z.prettifyError(parsed.error)}`);
  const args: BuildDeckInput = parsed.data;
  if (args.swudb !== undefined && args.decklist !== undefined) return fail("give either swudb or decklist as the starting list, not both");
  const startEntries = args.decklist ?? args.swudb?.deck.map((e) => ({ card: e.id, count: e.count })) ?? [];
  const sideboardEntries = args.sideboard ?? args.swudb?.sideboard?.map((e) => ({ card: e.id, count: e.count }));

  const leaderRef = args.leader ?? args.swudb?.leader.id;
  if (leaderRef === undefined) return fail("give leader, or a swudb document that names one");
  const leaderHit = resolveRef(env.store, leaderRef, "leader");
  if (!leaderHit.ok) return fail(`leader "${leaderRef}": ${leaderHit.reason}, ${leaderHit.detail}`);
  const leaderKey = leaderHit.row.cardKey;
  let choice: BaseChoice | null = null;
  let baseRef = args.base ?? args.swudb?.base.id;
  if (baseRef === undefined) {
    const picked = defaultBase(env, leaderKey);
    if (typeof picked === "string") return fail(picked);
    choice = picked;
    baseRef = picked.cardKey;
  }
  const pair = resolvePair(env, leaderKey, baseRef);
  if (typeof pair === "string") return fail(pair);
  const baseKey = pair.base.row.cardKey;

  const excluded = new Set<string>();
  for (const ref of args.exclude ?? []) {
    const hit = resolveRef(env.store, ref, "main");
    if (!hit.ok) return fail(`exclude "${ref}": ${hit.reason}, ${hit.detail}`);
    excluded.add(hit.row.cardKey);
  }
  const must = resolveList(env, args.mustInclude ?? [], "main");
  if (must.unresolved.length > 0) return fail(`mustInclude: ${must.unresolved.map((u) => `"${u.card}" ${u.reason}, ${u.detail}`).join("; ")}`);
  for (const l of must.lines) {
    if (l.count > MAX_COPIES) return fail(`mustInclude ${cardLabel(l.row)} x${l.count}: at most ${MAX_COPIES} copies of a card`);
    if (excluded.has(l.syn.cardKey)) return fail(`${cardLabel(l.row)} is both in mustInclude and in exclude`);
  }
  if (must.copies > DECK_SIZE) return fail(`mustInclude holds ${must.copies} cards; a deck holds ${DECK_SIZE}`);
  const start = resolveList(env, startEntries, "main");
  const mustOf = new Map(must.lines.map((l) => [l.syn.cardKey, l.count]));
  const heldOf = new Map(start.lines.map((l) => [l.syn.cardKey, l.count]));

  const supplied = suppliedBy(pair);
  const leaderData = leaderDataFor(env, pair);
  const population = leaderData?.entry.population ?? null;
  const { evidence, evidenceFields } = pairEvidence(env, pair);
  const locks = lockSupply(pair.leader.syn, pair.base.syn, []);
  const inPool = inPremierPool(env.store);

  const pairings = decoded(
    pairingsOutput,
    findPairings(env.ctx, { cardKey: leaderKey, leader: leaderKey, base: baseKey, perLink: 100, limit: 100, evidence: false }, inPool, undefined, { scores: env.scores }),
    "find_pairings",
  );
  const engineOf = new Map<string, { link: string; rank: number; leaderEngine: boolean }>();
  for (const p of typeof pairings === "string" ? [] : pairings.pairings) {
    if (!engineOf.has(p.cardKey)) engineOf.set(p.cardKey, { link: p.link, rank: round(p.rank ?? p.score, 3), leaderEngine: p.linkKind === "leader-engine" });
  }
  const leaderAction = typeof pairings === "string" ? undefined : pairings.leader?.engine?.action;

  const candidates = new Map<string, Candidate>();
  for (const syn of env.ctx.cards) {
    const row = env.store.byKey.get(syn.cardKey);
    const cost = syn.structured.cost;
    if (row === undefined || cost === null || !MAIN_TYPES.has(syn.type) || cardScope(env.store, row) !== "legal") continue;
    const id = swudbIdOf(row);
    if (id === null) continue;
    const lock = lockFields(clauseLock(syn, locks));
    const enabled = baseEnabledOf(syn, pair.base.syn);
    const fields = evidenceFields(syn.cardKey);
    const leaderRow = leaderData?.byCard.get(syn.cardKey);
    candidates.set(syn.cardKey, {
      syn,
      row,
      id,
      cost,
      bucket: bucketOf(cost),
      penalty: singlePenalty(syn, supplied),
      inclusion: leaderRow?.inclusion ?? null,
      meanCopies: leaderRow?.meanCopies ?? null,
      evidenceClass: fields.evidenceClass ?? null,
      evidenceGap: fields.evidenceGap ?? null,
      playCalibrated: env.scores.get(syn.cardKey)?.playCalibrated ?? null,
      engine: engineOf.get(syn.cardKey) ?? null,
      enabled: enabled === null ? null : enabled.location,
      drawback: drawbackOf(syn),
      lock: isLocked(clauseLock(syn, locks)) ? Object.entries(lock).map(([k, v]) => `${k} ${v}`).join(", ") : null,
      held: heldOf.get(syn.cardKey) ?? 0,
      must: mustOf.get(syn.cardKey) ?? null,
      excluded: excluded.has(syn.cardKey),
      package: null,
      rides: false,
      value: 0,
    });
  }
  for (const l of must.lines)
    if (!candidates.has(l.syn.cardKey)) return fail(`mustInclude ${cardLabel(l.row)}: not a Premier-legal unit, event or upgrade with a SET_NNN printing`);

  const ownEvidence = (c: Candidate): boolean => played(c) || (c.evidenceClass === "ok" && (c.evidenceGap ?? 0) >= 0) || c.engine?.leaderEngine === true;
  const open = (c: Candidate | undefined): c is Candidate => c !== undefined && barOf(c) === null;

  // A trio is a package when it builds on the leader engine, needs nothing the deck lacks, and every unit or event in it stands
  // on its own evidence; an upgrade without its own evidence rides on the unit it links to, at 1 copy.
  const trios = decoded(
    triosOutput,
    findTrios(env.ctx, { leader: leaderKey, base: baseKey, maxTotalCost: TRIO_MAX_COST, limit: TRIO_POOL, evidence: false }, inPool, undefined, env.scores, undefined),
    "find_trios",
  );
  const packages: { cards: string; cardKeys: string; rank: number; why: string }[] = [];
  const trioRankOf = new Map<string, number>();
  for (const t of typeof trios === "string" ? [] : trios.trios) {
    if (packages.length >= MAX_PACKAGES) break;
    const keys = t.cardKeys.split("|");
    const members = keys.map((k) => candidates.get(k));
    if (t.penalty > 0 || TRIO_LOCKS.some((k) => k in t) || !members.every(open)) continue;
    if (!members.some((c) => c.engine?.leaderEngine === true)) continue;
    if (!members.every((c) => ownEvidence(c) || c.syn.type === "Upgrade")) continue;
    const rank = t.rank ?? t.score;
    packages.push({ cards: t.cards, cardKeys: keys.join("|"), rank, why: t.reasons });
    for (const c of members) {
      c.package ??= t.cards;
      if (!ownEvidence(c)) c.rides = true;
      trioRankOf.set(c.syn.cardKey, Math.max(trioRankOf.get(c.syn.cardKey) ?? 0, rank));
    }
  }
  for (const c of candidates.values()) c.value = valueOf(c, trioRankOf.get(c.syn.cardKey) ?? 0);

  // Caps and floors per cost.
  const fromLeader = leaderCurve(env, leaderData);
  const target = fromLeader ?? DEFAULT_CURVE;
  const cap = Object.fromEntries(CURVE_BUCKETS.map((b) => [b, Math.min(GLUT_CAP, Math.max(MIN_CAP, Math.ceil(target[b] * CAP_FACTOR)))]));
  const floor = Object.fromEntries(CURVE_BUCKETS.map((b) => [b, FLOOR_COSTS.has(b) ? Math.floor(target[b] * FLOOR_FACTOR) : 0]));

  const picked = new Map<string, number>();
  const inBucket = new Map<string, number>();
  let slots = DECK_SIZE;
  const put = (c: Candidate, n: number): void => {
    picked.set(c.syn.cardKey, (picked.get(c.syn.cardKey) ?? 0) + n);
    inBucket.set(c.bucket, (inBucket.get(c.bucket) ?? 0) + n);
    slots -= n;
  };
  const roomFor = (c: Candidate, ignoreCap = false): number =>
    Math.min(MAX_COPIES - (picked.get(c.syn.cardKey) ?? 0), slots, ignoreCap ? Infinity : cap[c.bucket] - (inBucket.get(c.bucket) ?? 0));

  for (const c of [...candidates.values()].filter((x) => x.must !== null).sort((a, b) => compareCodePoints(a.syn.cardKey, b.syn.cardKey))) put(c, c.must as number);

  const byValue = (a: { value: number; key: string; isPackage?: boolean }, b: { value: number; key: string; isPackage?: boolean }): number =>
    b.value - a.value || Number(b.isPackage === true) - Number(a.isPackage === true) || compareCodePoints(a.key, b.key);
  const openCards = [...candidates.values()].filter((c) => c.must === null && open(c) && c.value > 0);
  const items: (Item & { key: string })[] = [
    ...packages.map((p) => {
      const members = p.cardKeys.split("|");
      return { members, value: Math.max(...members.map((k) => (candidates.get(k) as Candidate).value)), isPackage: true, key: p.cardKeys };
    }),
    ...openCards.map((c) => ({ members: [c.syn.cardKey], value: c.value, isPackage: false, key: c.syn.cardKey })),
  ].sort(byValue);

  // A single card goes in at its wanted copies, or at 2 when the cap or the slots allow no more; it is skipped rather than
  // squeezed in as an unplanned one-of. A package goes in whole or not at all.
  const tryAdd = (item: Item): boolean => {
    const plan: [Candidate, number][] = [];
    let need = 0;
    for (const key of item.members) {
      const c = candidates.get(key) as Candidate;
      const want = desiredCopies(c) - (picked.get(key) ?? 0);
      if (want <= 0) continue;
      const n = Math.min(want, roomFor(c));
      const least = Math.min(want, desiredCopies(c) === 1 ? 1 : 2);
      if (n < least) return false;
      plan.push([c, n]);
      need += n;
    }
    if (plan.length === 0 || need > slots) return false;
    for (const [c, n] of plan) put(c, n);
    return true;
  };

  for (const bucket of CURVE_BUCKETS) {
    for (const item of items) {
      if ((inBucket.get(bucket) ?? 0) >= floor[bucket] || slots === 0) break;
      if (item.isPackage || (candidates.get(item.members[0]) as Candidate).bucket !== bucket) continue;
      tryAdd(item);
    }
  }
  for (const item of items) {
    if (slots === 0) break;
    tryAdd(item);
  }
  // Slots a cap or the two-copy rule left open: more copies of the picked cards, best first, within the caps and then past them.
  const pickedByValue = (): Candidate[] =>
    [...picked.keys()]
      .map((k) => candidates.get(k) as Candidate)
      .filter((c) => c.must === null)
      .sort((a, b) => byValue({ value: a.value, key: a.syn.cardKey }, { value: b.value, key: b.syn.cardKey }));
  for (const ignoreCap of [false, true]) {
    for (const c of pickedByValue()) {
      if (slots === 0) break;
      const n = roomFor(c, ignoreCap);
      if (n > 0) put(c, n);
    }
  }
  for (const c of [...candidates.values()].filter((x) => open(x) && !picked.has(x.syn.cardKey) && x.must === null).sort((a, b) => byValue({ value: a.value, key: a.syn.cardKey }, { value: b.value, key: b.syn.cardKey }))) {
    if (slots === 0) break;
    put(c, Math.min(MAX_COPIES, slots));
  }

  // Output.
  const chosen = [...picked].map(([k, n]) => ({ c: candidates.get(k) as Candidate, n })).sort((a, b) => a.c.cost - b.c.cost || compareCodePoints(a.c.id, b.c.id));
  const leaderId = swudbIdOf(pair.leader.row);
  const baseId = swudbIdOf(pair.base.row);
  if (leaderId === null || baseId === null) return fail("the leader or base has no SET_NNN printing in the card table");
  const sideboard = sideboardEntries === undefined ? undefined : resolveList(env, sideboardEntries, "any");
  const sideIds = sideboard?.lines.map((l) => ({ id: swudbIdOf(l.row) ?? l.row.cardKey, count: l.count }));
  const swudb = {
    metadata: { name: args.name ?? `${cardLabel(pair.leader.row)} on ${cardLabel(pair.base.row)} (build_deck)` },
    leader: { id: leaderId, count: 1 },
    base: { id: baseId, count: 1 },
    deck: chosen.map(({ c, n }) => ({ id: c.id, count: n })),
    ...(sideIds === undefined ? {} : { sideboard: sideIds }),
  };

  const lines = chosen.map(({ c, n }) => ({ card: c.syn.cardKey, count: n }));
  const sideLines = sideboardEntries;
  const audit = decoded(auditOutput, deckAudit(env, { decklist: lines, leader: leaderKey, base: baseKey, ...(sideLines === undefined ? {} : { sideboard: sideLines }) }), "deck_audit");
  const legality = decoded(legalityOutput, deckLegalityCheck(env, { decklist: lines, leader: leaderKey, base: baseKey, format: "premier", ...(sideLines === undefined ? {} : { sideboard: sideLines }) }), "deck_legality_check");
  if (typeof legality === "string") return fail(legality);

  const curveCounts = CURVE_BUCKETS.map((b) => [b, inBucket.get(b) ?? 0] as const).filter(([b, n]) => n > 0 || cap[b] > MIN_CAP);
  const engine = leaderEngineOf(pair.leader.syn);
  const maxPower = engine?.playsUnitMaxPower ?? null;
  const units = chosen.filter(({ c }) => c.syn.type === "Unit");
  const powerOf = (c: Candidate): number | null => (typeof c.row.power === "number" ? c.row.power : null);

  const swaps = (() => {
    if (start.lines.length === 0) return undefined;
    const keys = [...new Set([...heldOf.keys(), ...picked.keys()])].sort(compareCodePoints);
    const inRows: { id: string; title: string; count: number; why: string }[] = [];
    const outRows: { id: string; title: string; count: number; why: string }[] = [];
    for (const k of keys) {
      const diff = (picked.get(k) ?? 0) - (heldOf.get(k) ?? 0);
      if (diff === 0) continue;
      const c = candidates.get(k);
      const row = c?.row ?? env.store.byKey.get(k);
      const id = c?.id ?? (row === undefined ? k : (swudbIdOf(row) ?? k));
      const title = row === undefined ? k : cardLabel(row);
      if (diff > 0) inRows.push({ id, title, count: diff, why: c === undefined ? "" : whyOf(c, population) });
      else {
        const bar = c === undefined ? "not a Premier-legal main-deck card" : (barOf(c) ?? (picked.has(k) ? "fewer copies: its evidence wants fewer, or the cost cap is full" : `outranked: value ${c.value} is below the cut`));
        outRows.push({ id, title, count: -diff, why: bar });
      }
    }
    return { in: inRows, out: outRows, ...(start.unresolved.length === 0 ? {} : { unresolved: start.unresolved }) };
  })();

  const leftOut = [...candidates.values()]
    .filter((c) => !picked.has(c.syn.cardKey) && (played(c) || c.engine?.leaderEngine === true || (c.evidenceClass === "ok" && (c.evidenceGap ?? 0) > 0)))
    .sort((a, b) => (b.inclusion ?? 0) - (a.inclusion ?? 0) || b.value - a.value || compareCodePoints(a.syn.cardKey, b.syn.cardKey))
    .slice(0, LEFT_OUT_ROWS)
    .map((c) => ({
      cardKey: c.syn.cardKey,
      id: c.id,
      title: cardLabel(c.syn),
      cost: c.cost,
      leaderInclusion: c.inclusion,
      reason: barOf(c) ?? `value ${c.value} below the cut at cost ${c.bucket} (${inBucket.get(c.bucket) ?? 0} of cap ${cap[c.bucket]})`,
    }));

  const penaltyRows = chosen.filter(({ c }) => c.penalty > 0).map(({ c, n }) => ({ cardKey: c.syn.cardKey, title: cardLabel(c.syn), count: n, each: c.penalty }));

  return ok({
    status: "candidate",
    dataVersion: env.dataVersion,
    leader: { cardKey: leaderKey, id: leaderId, title: cardLabel(pair.leader.row) },
    base: { cardKey: baseKey, id: baseId, title: cardLabel(pair.base.row), chosenBy: choice?.chosenBy ?? "given" },
    baseRunnerUp: choice?.runnerUp ?? null,
    swudb,
    populations: {
      leaderLists: leaderData === null ? "none: the package holds no decklists for this leader" : leaderSourceText(leaderData.entry, leaderData.selection),
      measured:
        evidence === null || evidence.winrates.deckEvidence === null
          ? "none: the package holds no tournament deck evidence"
          : `${SWUMETASTATS_SOURCE}, ${evidence.winrates.deckEvidence.window.from}..${evidence.winrates.deckEvidence.window.to}: match win rate of comparable tournament decks with the card against those without it`,
      engine: "the reviewed offers-to-wants pair graph and the leader's own clause (find_pairings, find_trios): rule-derived, no play data",
      simulated: "not used: no bot-simulation figure enters this list",
      note: "D21: each tier keeps its own line in every why; leaderInclusion and measured gaps are never merged into one rate. value is a ranking score that weighs the lines, not a win rate.",
    },
    cards: chosen.map(({ c, n }) => ({ id: c.id, cardKey: c.syn.cardKey, title: cardLabel(c.syn), type: c.syn.type, cost: c.cost, count: n, value: c.value, why: whyOf(c, population) })),
    ...(sideboard === undefined
      ? {}
      : {
          sideboardCards: sideboard.lines.map((l) => {
            const c = candidates.get(l.syn.cardKey);
            return { id: swudbIdOf(l.row) ?? l.row.cardKey, title: cardLabel(l.row), count: l.count, why: `as given${c === undefined ? "" : `; ${whyOf(c, population)}`}` };
          }),
          ...(sideboard.unresolved.length === 0 ? {} : { sideboardUnresolved: sideboard.unresolved }),
        }),
    packages,
    ...(swaps === undefined ? {} : { swaps }),
    penalty: { total: penaltyRows.reduce((s, r) => s + r.each * r.count, 0), cards: penaltyRows },
    curve: {
      byCost: curveCounts.map(([b, n]) => `${b}:${n}`).join(" "),
      caps: curveCounts.map(([b]) => `${b}:${cap[b]}`).join(" "),
      floors: CURVE_BUCKETS.filter((b) => floor[b] > 0).map((b) => `${b}:${floor[b]}`).join(" ") || "none",
      source: fromLeader === null ? "no leader lists: a default midrange curve" : `the leader's lists' copies per cost scaled to 50 (cap x${CAP_FACTOR}, at most ${GLUT_CAP}; floor x${FLOOR_FACTOR} at costs 2 to 6)`,
      ...(maxPower === null
        ? {}
        : {
            actionBand: {
              ...(leaderAction === undefined ? {} : { action: leaderAction }),
              playsUnitMaxPower: maxPower,
              units: units.reduce((s, u) => s + u.n, 0),
              unitsInBand: units.filter(({ c }) => (powerOf(c) ?? Infinity) <= maxPower).reduce((s, u) => s + u.n, 0),
            },
          }),
    },
    audit:
      typeof audit === "string"
        ? audit
        : {
            penalty: audit.aspect.penalty,
            uncovered: audit.aspect.uncovered.length,
            meanPlayCalibrated: audit.score?.meanPlayCalibrated ?? null,
            curveGlut: audit.curveGlut === undefined ? "none" : `cost ${String(audit.curveGlut.cost ?? "?")}`,
            missingStaples:
              (audit.leaderComparison?.missingStaples ?? [])
                .map((m) => `${m.card}${m.penalty !== undefined && m.penalty > 0 ? ` (+${m.penalty})` : ""}${m.evidenceClass === "negative" ? " (negative)" : ""}`)
                .join("; ") || "none",
            orphanWants: (audit.orphanWants ?? []).map((o) => o.card).join("; ") || "none",
            lockedCards: audit.lockedCards?.cards.length ?? 0,
          },
    legality,
    leftOut,
    ...(typeof pairings === "string" || typeof trios === "string" ? { warnings: [pairings, trios].filter((x) => typeof x === "string") } : {}),
    note: `Ranked by value = ${PLAYED_WEIGHT} x leaderInclusion (at or above ${pct(LEADER_INCLUSION_FLOOR)}) + ${MEASURED_WEIGHT} x measured gap on an ok card (x${UNPLAYED_MEASURED_FACTOR} when the leader's lists do not play it) + ${ENGINE_WEIGHT} x (find_pairings rank - 0.5) on a leader-engine partner (${LINK_WEIGHT} x on another leader link) + ${SCORE_WEIGHT} x play-calibrated score + ${BASE_ENABLED_BONUS} when the base enables the card - ${DRAWBACK_COST} for a drawback + ${HELD_BONUS} for a starting-list card + ${TRIO_WEIGHT} x trio rank for a package member. Picked only when penalty-free, unlocked, not measured negative and not excluded, unless it is a must-include. Copies: 3 for a staple or an engine core card (rank ${ENGINE_CORE_RANK} or more), else the leader's lists' copies when played, else 2; an upgrade riding on a package 1. A trio from find_trios is a package when it holds a leader-engine partner and every unit or event in it has its own evidence; it goes in whole. Status candidate: confirm each line against the card text.`,
  });
}

function withEnv(store: CardStore, input: unknown): ToolResult {
  try {
    return buildDeck(deckEnvOf(store), input);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export const BUILD_DECK_TOOLS = {
  build_deck: {
    title: "Build a deck",
    description:
      "Builds an evidence-based 50-card Premier list for a leader and base and returns it as the SWUDB JSON interchange document (set-code ids like HMW_018), ready for Karabast import, with a why line per card (each evidence tier on its own: the leader's decklists, measured tournament gaps, the leader engine and trio packages, the base, the rubric score), the packages kept whole, the aspect penalty, the curve against per-cost caps from the leader's lists and the leader's Action band, the deck_audit headline and the deck_legality_check result. Exactly 50 cards, at most 3 copies; a card that pays an aspect penalty, is measured negative, is locked by its clause or is excluded is picked only as a mustInclude, and the why line says so. Omit base for the base most of the leader's lists run (the runner-up is reported). Give a starting list (decklist or swudb) to get swaps against it; a sideboard is kept exactly as given. Deterministic, no model; status candidate.",
    shape: buildDeckShape,
    handler: withEnv,
  },
} as const;
