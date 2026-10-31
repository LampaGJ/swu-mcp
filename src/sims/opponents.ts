import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { splitCell, type CardStore } from "../data.js";
import { deckWeights, type MetaDeck } from "../meta/build.js";
import { premierVerdict, snapshotDeclaresPremier } from "../meta/format.js";
import { metaFileSchema, type Archetype, type MetaFile } from "../meta/schema.js";
import { compareCodePoints } from "../swu/canonical.js";
import { swudbCandidates } from "../tools/swudb.js";
import { seededRandom } from "./field-stats.js";

/**
 * @displayName Opponent sampler
 * @strategicPurpose Manipulation node (reduces, #112 of #104): a battle-test faces the real competitive field, not a
 * hand-picked list. Real melee tournament decklists in, a seeded draw of opponents out, by the same placement-weighted
 * archetype share the meta step reports (src/meta/build.ts). Opponent side of the forceteki deck-testing tool.
 * @tacticalObjective Loads the melee lists of the meta window, assigns each to a tournament archetype of
 * meta/archetypes.json (same leader, then the archetype whose listed core the list covers best), then draws an
 * archetype by `share` and a list of it by placement weight, or per stratum with a rest-of-field stratum. A list the
 * id bridge cannot place is counted and named, never dropped silently. Karabast data cannot enter the pool (D22): only
 * lists whose metadata source is melee are read. Same seed, same draw: the generator is a sha256-seeded mulberry32.
 */

export const SAMPLER_VERSION = "opponents-v1";

const entry = z.looseObject({ id: z.string().min(1), count: z.number().int().nonnegative().optional() });

/** A decklist file of a snapshot: foreign data, so a loose object that keeps only the fields the sampler reads. */
export const opponentFileSchema = z.looseObject({
  metadata: z
    .looseObject({
      source: z.string().optional(),
      via: z.string().optional(),
      createdAt: z.string().optional(),
      name: z.string().optional(),
      event: z
        .looseObject({
          id: z.union([z.number(), z.string()]).optional(),
          name: z.string().optional(),
          date: z.string().optional(),
          players: z.number().int().positive().optional(),
        })
        .nullish(),
      placement: z.number().int().positive().nullish(),
    })
    .optional(),
  leader: entry,
  base: entry,
  deck: z.array(entry),
});

export interface ListedDeck {
  leader: { id: string; count: number };
  base: { id: string; count: number };
  deck: { id: string; count: number }[];
}

export interface OpponentList extends ListedDeck {
  /** File name without .json, the stable name of the list. */
  key: string;
  name: string | null;
  event: string | null;
  date: string;
  placement: number;
  /** Placement weight, deckWeights in src/meta/build.ts: 1 + (1 - (placement - 1) / field). */
  weight: number;
  /** The event's player count as the weighting estimated it. */
  field: number;
  archetypeId: string | null;
  /** SET_NNN ids the id bridge cannot place; empty when the engine can build the list. */
  unmapped: string[];
}

export type CardKind = "leader" | "base" | "main";
export type CardKeyOf = (id: string, kind: CardKind) => string | null;

/**
 * The id bridge seam (#109 replaces it): the SET_NNN ids of a list the engine cannot be given. The default asks the card
 * table (src/tools/swudb.ts), so a list passes when every id names exactly one card there.
 */
export type UnmappedCards = (deck: ListedDeck) => string[];

const kindFits = (type: string, kind: CardKind): boolean =>
  kind === "leader" ? type === "Leader" : kind === "base" ? type === "Base" : type !== "Leader" && type !== "Base";

export function storeCardKeyOf(store: CardStore): CardKeyOf {
  const memo = new Map<string, string | null>();
  return (id, kind) => {
    const memoKey = `${kind}\u0000${id}`;
    const hit = memo.get(memoKey);
    if (hit !== undefined || memo.has(memoKey)) return hit ?? null;
    const fits = swudbCandidates(store, id).filter((row) => kindFits(row.type, kind));
    const real = fits.filter((row) => !row.type.startsWith("Token"));
    const keys = [...new Set((real.length > 0 ? real : fits).map((row) => row.cardKey))];
    const found = keys.length === 1 ? keys[0] : null;
    memo.set(memoKey, found);
    return found;
  };
}

/**
 * The SET_NNN -> cardKey index the meta step uses (scripts/bench/card-map.ts, every printing of the raw card pages), so a
 * list lands in the archetype the meta step put it in. The card table (storeCardKeyOf) holds the Premier pool only and
 * misses rotated-set cards the engine can still build.
 */
export const mapCardKeyOf =
  (byId: ReadonlyMap<string, string>): CardKeyOf =>
  (id) =>
    byId.get(id) ?? null;

const setCodeMapSchema = z.record(z.string(), z.string());

/** The SET_NNN codes the forceteki engine can build: the keys of test/json/_setCodeMap.json in a forceteki clone (foreign file, parsed here). */
export function engineSetCodes(forcetekiDir: string): ReadonlySet<string> {
  const file = path.join(forcetekiDir, "test/json/_setCodeMap.json");
  return new Set(Object.keys(setCodeMapSchema.parse(JSON.parse(readFileSync(file, "utf8")))));
}

/** The bridge the engine imposes: an id missing from its set-code map fails at `new Deck` (J24_005 does), whatever the card tables say. */
export const engineUnmappedCards =
  (codes: ReadonlySet<string>): UnmappedCards =>
  (deck) =>
    [deck.leader.id, deck.base.id, ...deck.deck.map((e) => e.id)].filter((id, i, all) => !codes.has(id) && all.indexOf(id) === i);

/** Aspect icons of a card from the card table, sorted and joined with + the way ArchetypeInfo.baseAspects is. */
export const storeAspectsOf =
  (store: CardStore): ((cardKey: string) => string | null) =>
  (cardKey) => {
    const row = store.byKey.get(cardKey);
    return row === undefined ? null : splitCell(row.aspects).sort(compareCodePoints).join("+");
  };

export const unmappedCardsWith =
  (cardKeyOf: CardKeyOf): UnmappedCards =>
  (deck) =>
    [
      ...(cardKeyOf(deck.leader.id, "leader") === null ? [deck.leader.id] : []),
      ...(cardKeyOf(deck.base.id, "base") === null ? [deck.base.id] : []),
      ...deck.deck.filter((e) => cardKeyOf(e.id, "main") === null).map((e) => e.id),
    ].filter((id, i, all) => all.indexOf(id) === i);

export interface SnapshotEntry extends ListedDeck {
  key: string;
  name: string | null;
  source: string;
  via: string | null;
  event: { key: string; name: string | null; players: number | null } | null;
  date: string;
  placement: number | null;
}

export interface ReadCounts {
  files: number;
  melee: number;
  nonMelee: number;
  nonPremier: number;
  invalid: number;
  undated: number;
  outOfWindow: number;
  noPlacement: number;
}

const isDeckFile = (name: string): boolean => name.endsWith(".json") && !name.startsWith("_") && name !== "manifest.json" && name !== "rejects.json";

/** Reads the melee tournament lists of one snapshot dated inside the window; every other file is counted by reason. */
export function readSnapshotEntries(dir: string, window: { from: string; to: string }): { entries: SnapshotEntry[]; counts: ReadCounts } {
  if (/karabast/i.test(path.resolve(dir))) throw new Error(`${dir} looks like Karabast data, which never enters the opponent pool (D22)`);
  const files = readdirSync(dir)
    .filter((f) => isDeckFile(f) && statSync(path.join(dir, f)).isFile())
    .sort(compareCodePoints);
  const premierSnapshot = snapshotDeclaresPremier(dir);
  const counts: ReadCounts = { files: files.length, melee: 0, nonMelee: 0, nonPremier: 0, invalid: 0, undated: 0, outOfWindow: 0, noPlacement: 0 };
  const entries: SnapshotEntry[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    if (!premierVerdict(raw, premierSnapshot).keep) {
      counts.nonPremier += 1;
      continue;
    }
    const parsed = opponentFileSchema.safeParse(raw);
    if (!parsed.success) {
      counts.invalid += 1;
      continue;
    }
    const d = parsed.data;
    const source = d.metadata?.source ?? "unknown";
    if (source !== "melee") {
      counts.nonMelee += 1;
      continue;
    }
    counts.melee += 1;
    const createdAt = d.metadata?.createdAt;
    if (createdAt === undefined || !/^\d{4}-\d{2}-\d{2}/.test(createdAt)) {
      counts.undated += 1;
      continue;
    }
    const date = createdAt.slice(0, 10);
    if (compareCodePoints(date, window.from) < 0 || compareCodePoints(date, window.to) > 0) {
      counts.outOfWindow += 1;
      continue;
    }
    const event = d.metadata?.event;
    const placement = d.metadata?.placement ?? null;
    if (event === undefined || event === null || placement === null) {
      counts.noPlacement += 1;
      continue;
    }
    const via = d.metadata?.via ?? null;
    const eventKey = event.id !== undefined ? String(event.id) : event.name !== undefined ? `${event.name}|${event.date ?? ""}` : null;
    entries.push({
      key: file.slice(0, -".json".length),
      name: d.metadata?.name ?? null,
      source,
      via,
      event: eventKey === null ? null : { key: `${via ?? source}:${eventKey}`, name: event.name ?? null, players: event.players ?? null },
      date,
      placement,
      leader: { id: d.leader.id, count: d.leader.count ?? 1 },
      base: { id: d.base.id, count: d.base.count ?? 1 },
      deck: d.deck.map((e) => ({ id: e.id, count: e.count ?? 1 })),
    });
  }
  return { entries, counts };
}

export interface ArchetypeInfo {
  id: string;
  name: string;
  share: number;
  decks: number;
  leaderKey: string;
  /** Aspect icons of the archetype's base, sorted and joined with + (empty for a neutral base). */
  baseAspects: string;
  baseKeys: ReadonlySet<string>;
  core: ReadonlySet<string>;
}

export interface UnassignedList {
  key: string;
  name: string | null;
  reason: "leader-unmapped" | "no-archetype";
  unmapped: string[];
}

export interface OpponentPool {
  window: { from: string; to: string };
  archetypes: ArchetypeInfo[];
  lists: OpponentList[];
  unassigned: UnassignedList[];
  counts: ReadCounts;
  byArchetype: ReadonlyMap<string, readonly OpponentList[]>;
}

export function tournamentArchetypes(meta: MetaFile): ArchetypeInfo[] {
  return meta.archetypes
    .filter((a: Archetype) => a.population === "tournament")
    .map((a) => ({
      id: a.id,
      name: a.name,
      share: a.share,
      decks: a.decks,
      leaderKey: a.leader.cardKey,
      baseAspects: [...a.baseAspects].sort(compareCodePoints).join("+"),
      baseKeys: new Set(a.bases.map((b) => b.cardKey)),
      core: new Set(a.core.map((c) => c.cardKey)),
    }))
    .sort((a, b) => b.share - a.share || compareCodePoints(a.id, b.id));
}

/**
 * The archetype of a list: same leader, then the one whose listed core the list covers best. meta/archetypes.json does not
 * name its members, so this replays the assignment from the 20 listed core cards (an approximation; the file's `decks`
 * count is the yardstick, see poolReport). Ties go to an archetype that lists the base, then the larger share.
 */
export function assignArchetype(
  byLeader: ReadonlyMap<string, readonly ArchetypeInfo[]>,
  leaderKey: string,
  base: { key: string | null; aspects: string | null },
  cardKeys: ReadonlySet<string>,
): string | null {
  const all = byLeader.get(leaderKey);
  if (all === undefined || all.length === 0) return null;
  const sameAspects = base.aspects === null ? [] : all.filter((a) => a.baseAspects === base.aspects);
  const candidates = sameAspects.length > 0 ? sameAspects : all;
  const scored = candidates.map((a) => {
    let covered = 0;
    for (const c of a.core) if (cardKeys.has(c)) covered += 1;
    return { a, score: covered / (a.core.size + cardKeys.size - covered || 1), base: base.key !== null && a.baseKeys.has(base.key) ? 1 : 0 };
  });
  scored.sort((x, y) => y.score - x.score || y.base - x.base || y.a.share - x.a.share || compareCodePoints(x.a.id, y.a.id));
  return scored[0].a.id;
}

export interface PoolInput {
  meta: MetaFile;
  entries: readonly SnapshotEntry[];
  counts: ReadCounts;
  cardKeyOf: CardKeyOf;
  /** Aspect icons of a base cardKey, sorted and joined with +; null when unknown, then only the leader and core decide the archetype. */
  baseAspectsOf?: (baseKey: string) => string | null;
  /** Defaults to unmappedCardsWith(cardKeyOf); #109's bridge replaces it here. */
  unmappedCards?: UnmappedCards;
}

export function buildPool(input: PoolInput): OpponentPool {
  const { meta, entries, cardKeyOf } = input;
  const unmappedCards = input.unmappedCards ?? unmappedCardsWith(cardKeyOf);
  const archetypes = tournamentArchetypes(meta);
  if (archetypes.length === 0) throw new Error("meta/archetypes.json holds no tournament archetype to sample from");
  const byLeader = new Map<string, ArchetypeInfo[]>();
  for (const a of archetypes) byLeader.set(a.leaderKey, [...(byLeader.get(a.leaderKey) ?? []), a]);

  const weightInput: MetaDeck[] = entries.map((e) => ({
    key: e.key,
    population: "tournament",
    source: e.source,
    leader: e.leader.id,
    base: e.base.id,
    cards: [],
    createdAt: e.date,
    event: e.event?.key ?? null,
    placement: e.placement,
    field: e.event?.players ?? null,
  }));
  const weights = deckWeights(weightInput);
  const fields = new Map<string, number>();
  for (const e of entries) if (e.event !== null) fields.set(e.event.key, Math.max(fields.get(e.event.key) ?? 0, e.placement ?? 0, e.event.players ?? 0));

  const lists: OpponentList[] = [];
  const unassigned: UnassignedList[] = [];
  for (const e of [...entries].sort((a, b) => compareCodePoints(a.key, b.key))) {
    const unmapped = unmappedCards(e);
    const leaderKey = cardKeyOf(e.leader.id, "leader");
    if (leaderKey === null) {
      unassigned.push({ key: e.key, name: e.name, reason: "leader-unmapped", unmapped });
      continue;
    }
    const cardKeys = new Set<string>();
    for (const c of e.deck) {
      const k = cardKeyOf(c.id, "main");
      if (k !== null) cardKeys.add(k);
    }
    const baseKey = cardKeyOf(e.base.id, "base");
    const archetypeId = assignArchetype(byLeader, leaderKey, { key: baseKey, aspects: baseKey === null ? null : (input.baseAspectsOf?.(baseKey) ?? null) }, cardKeys);
    if (archetypeId === null) {
      unassigned.push({ key: e.key, name: e.name, reason: "no-archetype", unmapped });
      continue;
    }
    lists.push({
      ...e,
      event: e.event?.name ?? null,
      placement: e.placement as number,
      weight: weights.get(e.key) ?? 1,
      field: e.event === null ? 0 : (fields.get(e.event.key) ?? 0),
      archetypeId,
      unmapped,
    });
  }
  const byArchetype = new Map<string, OpponentList[]>();
  for (const l of lists) byArchetype.set(l.archetypeId as string, [...(byArchetype.get(l.archetypeId as string) ?? []), l]);
  return { window: meta.window, archetypes, lists, unassigned, counts: input.counts, byArchetype };
}

export interface LoadOptions {
  /** The meta/archetypes.json to sample by. */
  archetypesFile: string;
  /** A snapshot directory, data/originals/decks/<date>. */
  decksDir: string;
  cardKeyOf: CardKeyOf;
  baseAspectsOf?: (baseKey: string) => string | null;
  unmappedCards?: UnmappedCards;
}

export function loadOpponentPool(options: LoadOptions): OpponentPool {
  if (!existsSync(options.archetypesFile)) throw new Error(`no archetypes file at ${options.archetypesFile}`);
  const meta = metaFileSchema.parse(JSON.parse(readFileSync(options.archetypesFile, "utf8")));
  const { entries, counts } = readSnapshotEntries(options.decksDir, meta.window);
  return buildPool({ meta, entries, counts, cardKeyOf: options.cardKeyOf, baseAspectsOf: options.baseAspectsOf, unmappedCards: options.unmappedCards });
}

// ---------------------------------------------------------------------------------------------------------------------
// Sampling

export interface Draw {
  index: number;
  /** "field" for a proportional draw, else the stratum id (an archetype id or "rest-of-field"). */
  stratum: string;
  archetypeId: string;
  archetypeName: string;
  list: OpponentList;
  /** Ids the bridge cannot place; non-empty only when unmapped lists are kept (`unmapped: "keep"`). */
  unmapped: string[];
  /** The header `source` field: sampler, seed, mode, draw index, archetype and list. */
  source: string;
}

export interface SkippedDraw {
  draw: number;
  stratum: string;
  archetypeId: string;
  key: string;
  name: string | null;
  unmapped: string[];
}

export interface SampleResult {
  seed: string;
  mode: "proportional" | "stratified" | "named";
  draws: Draw[];
  /** Lists drawn and set aside because the bridge could not place them; each is replaced by a fresh draw of the same archetype. */
  skippedUnmapped: SkippedDraw[];
  /** Archetypes with no list the engine can build, left out of the draw and named here. */
  unplayableArchetypes: string[];
  population: { text: string; lists: number };
}

export type UnmappedMode = "redraw" | "keep";

export function populationLabel(window: { from: string; to: string }, listsDrawn: number): { text: string; lists: number } {
  return {
    text: `melee tournament decklists, ${window.from} to ${window.to}, placement-weighted archetype share (n = ${listsDrawn} lists drawn)`,
    lists: listsDrawn,
  };
}

function cumulative(weights: readonly number[]): Float64Array {
  const out = new Float64Array(weights.length);
  let sum = 0;
  weights.forEach((w, i) => {
    sum += w;
    out[i] = sum;
  });
  return out;
}

/** Index of the first cumulative total above u * total, the weighted pick for u in [0, 1). */
function pickIndex(cum: Float64Array, u: number): number {
  const target = u * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface Drawer {
  pickArchetype(rng: () => number, among: readonly ArchetypeInfo[]): ArchetypeInfo;
  pickList(rng: () => number, archetype: ArchetypeInfo): OpponentList;
}

function drawerFor(pool: OpponentPool, mode: UnmappedMode): { drawer: Drawer; unplayable: string[]; eligible: ArchetypeInfo[] } {
  const listsOf = (a: ArchetypeInfo): readonly OpponentList[] => pool.byArchetype.get(a.id) ?? [];
  const usable = (a: ArchetypeInfo): readonly OpponentList[] => (mode === "keep" ? listsOf(a) : listsOf(a).filter((l) => l.unmapped.length === 0));
  const eligible = pool.archetypes.filter((a) => usable(a).length > 0);
  const unplayable = pool.archetypes.filter((a) => usable(a).length === 0).map((a) => a.id);
  const listCum = new Map<string, { lists: readonly OpponentList[]; cum: Float64Array }>();
  return {
    eligible,
    unplayable,
    drawer: {
      pickArchetype(rng, among) {
        return among[pickIndex(cumulative(among.map((a) => a.share)), rng())];
      },
      pickList(rng, archetype) {
        let hit = listCum.get(archetype.id);
        if (hit === undefined) {
          const full = listsOf(archetype);
          hit = { lists: full, cum: cumulative(full.map((l) => l.weight)) };
          listCum.set(archetype.id, hit);
        }
        return hit.lists[pickIndex(hit.cum, rng())];
      },
    },
  };
}

const sourceOf = (seed: string, mode: string, index: number, archetypeId: string, key: string): string =>
  `${SAMPLER_VERSION} seed=${seed} mode=${mode} draw=${index} archetype=${archetypeId} list=${key}`;

function drawOne(
  drawer: Drawer,
  rng: () => number,
  archetypes: readonly ArchetypeInfo[],
  context: { seed: string; mode: string; stratum: string; index: number; unmapped: UnmappedMode },
  skipped: SkippedDraw[],
): Draw {
  const archetype = archetypes.length === 1 ? archetypes[0] : drawer.pickArchetype(rng, archetypes);
  for (;;) {
    const list = drawer.pickList(rng, archetype);
    if (list.unmapped.length > 0 && context.unmapped === "redraw") {
      skipped.push({ draw: context.index, stratum: context.stratum, archetypeId: archetype.id, key: list.key, name: list.name, unmapped: list.unmapped });
      continue;
    }
    return {
      index: context.index,
      stratum: context.stratum,
      archetypeId: archetype.id,
      archetypeName: archetype.name,
      list,
      unmapped: list.unmapped,
      source: sourceOf(context.seed, context.mode, context.index, archetype.id, list.key),
    };
  }
}

/**
 * Draws a list by placement weight from an archetype that holds one the engine can build. Redrawing a set-aside list from
 * the same archetype keeps each archetype's share intact; the set-aside lists are returned for the report.
 */
export function sampleProportional(pool: OpponentPool, options: { seed: string; n: number; unmapped?: UnmappedMode }): SampleResult {
  const unmapped = options.unmapped ?? "redraw";
  const { drawer, eligible, unplayable } = drawerFor(pool, unmapped);
  const rng = seededRandom(`${options.seed}|${SAMPLER_VERSION}|proportional`);
  const skipped: SkippedDraw[] = [];
  const draws: Draw[] = [];
  if (eligible.length === 0 && options.n > 0) throw new Error("no archetype holds a list the engine can build");
  const picker = cumulative(eligible.map((a) => a.share));
  for (let i = 0; i < options.n; i++) {
    const archetype = eligible[pickIndex(picker, rng())];
    draws.push(
      drawOne(drawer, rng, [archetype], { seed: options.seed, mode: "proportional", stratum: "field", index: i, unmapped }, skipped),
    );
  }
  return { seed: options.seed, mode: "proportional", draws, skippedUnmapped: skipped, unplayableArchetypes: unplayable, population: populationLabel(pool.window, draws.length) };
}

export interface StratumPlan {
  id: string;
  name: string;
  /** The field share the stratum stands for; the weights of a plan sum to 1. */
  weight: number;
  n: number;
  archetypeIds: string[];
}

export const REST_OF_FIELD = "rest-of-field";

/** The `top` archetypes by share, each its own stratum, plus one rest-of-field stratum with its own n. */
export function stratifiedPlan(pool: OpponentPool, options: { top?: number; perStratum?: number; restOfField?: number } = {}): StratumPlan[] {
  const top = options.top ?? 6;
  const perStratum = options.perStratum ?? 100;
  const total = pool.archetypes.reduce((s, a) => s + a.share, 0);
  const named = pool.archetypes.slice(0, top);
  const rest = pool.archetypes.slice(top);
  const plan: StratumPlan[] = named.map((a) => ({ id: a.id, name: a.name, weight: a.share / total, n: perStratum, archetypeIds: [a.id] }));
  if (rest.length > 0) {
    plan.push({
      id: REST_OF_FIELD,
      name: `the other ${rest.length} tournament archetypes`,
      weight: rest.reduce((s, a) => s + a.share, 0) / total,
      n: options.restOfField ?? perStratum,
      archetypeIds: rest.map((a) => a.id),
    });
  }
  return plan;
}

/** Per stratum, `n` draws that do not depend on the other strata: each stratum has its own generator, seeded by its id. */
export function sampleStratified(pool: OpponentPool, plan: readonly StratumPlan[], options: { seed: string; unmapped?: UnmappedMode }): SampleResult & { plan: StratumPlan[] } {
  const unmapped = options.unmapped ?? "redraw";
  const { drawer, eligible, unplayable } = drawerFor(pool, unmapped);
  const canDraw = new Set(eligible.map((a) => a.id));
  const byId = new Map(pool.archetypes.map((a) => [a.id, a] as const));
  const skipped: SkippedDraw[] = [];
  const draws: Draw[] = [];
  for (const stratum of plan) {
    const among = stratum.archetypeIds.filter((id) => canDraw.has(id)).map((id) => byId.get(id) as ArchetypeInfo);
    if (among.length === 0) continue;
    const rng = seededRandom(`${options.seed}|${SAMPLER_VERSION}|stratified|${stratum.id}`);
    for (let i = 0; i < stratum.n; i++) {
      draws.push(
        drawOne(drawer, rng, among, { seed: options.seed, mode: "stratified", stratum: stratum.id, index: i, unmapped }, skipped),
      );
    }
  }
  return {
    seed: options.seed,
    mode: "stratified",
    draws,
    skippedUnmapped: skipped,
    unplayableArchetypes: unplayable,
    plan: [...plan],
    population: populationLabel(pool.window, draws.length),
  };
}

/** A fixed list is allowed only when the caller names it. */
export function namedDraw(pool: OpponentPool, key: string, seed = "named"): Draw {
  const list = pool.lists.find((l) => l.key === key);
  if (list === undefined) throw new Error(`no list named ${key} in the opponent pool`);
  const archetype = pool.archetypes.find((a) => a.id === list.archetypeId) as ArchetypeInfo;
  return {
    index: 0,
    stratum: "named",
    archetypeId: archetype.id,
    archetypeName: archetype.name,
    list,
    unmapped: list.unmapped,
    source: sourceOf(seed, "named", 0, archetype.id, list.key),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Deck panel and report

export interface PanelEntry {
  archetypeId: string;
  archetypeName: string;
  share: number;
  /** Null when no list of the archetype is buildable. */
  list: OpponentList | null;
  /** Higher-placing lists of the archetype set aside because the bridge could not place them. */
  skippedUnmapped: { key: string; name: string | null; unmapped: string[] }[];
}

/** Highest placement weight first (a winner of a larger event ahead of a winner of a smaller one), then newer, then name. */
const placingOrder = (a: OpponentList, b: OpponentList): number =>
  b.weight - a.weight || b.field - a.field || compareCodePoints(b.date, a.date) || compareCodePoints(a.key, b.key);

/** The highest-placing buildable melee list of each of the `top` archetypes by share. */
export function deckPanel(pool: OpponentPool, options: { top?: number } = {}): PanelEntry[] {
  return pool.archetypes.slice(0, options.top ?? 6).map((a) => {
    const ranked = [...(pool.byArchetype.get(a.id) ?? [])].sort(placingOrder);
    const firstPlayable = ranked.findIndex((l) => l.unmapped.length === 0);
    const skipped = (firstPlayable < 0 ? ranked : ranked.slice(0, firstPlayable)).map((l) => ({ key: l.key, name: l.name, unmapped: l.unmapped }));
    return {
      archetypeId: a.id,
      archetypeName: a.name,
      share: a.share,
      list: firstPlayable < 0 ? null : ranked[firstPlayable],
      skippedUnmapped: skipped,
    };
  });
}

export const poolReportSchema = z.strictObject({
  sampler: z.literal(SAMPLER_VERSION),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  population: z.string(),
  read: z.strictObject({
    files: z.number().int(),
    melee: z.number().int(),
    nonMelee: z.number().int(),
    nonPremier: z.number().int(),
    invalid: z.number().int(),
    undated: z.number().int(),
    outOfWindow: z.number().int(),
    noPlacement: z.number().int(),
  }),
  lists: z.number().int(),
  unmappedLists: z.number().int(),
  unmappedWeightShare: z.number(),
  unassigned: z.strictObject({
    count: z.number().int(),
    byReason: z.record(z.string(), z.number().int()),
    lists: z.array(z.strictObject({ key: z.string(), name: z.string().nullable(), reason: z.string(), unmapped: z.array(z.string()) })),
  }),
  archetypesWithoutLists: z.array(z.string()),
  archetypes: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      share: z.number(),
      /** `decks` of meta/archetypes.json, the count the assignment is measured against. */
      metaDecks: z.number().int(),
      lists: z.number().int(),
      unmappedLists: z.number().int(),
      unmapped: z.array(z.strictObject({ key: z.string(), name: z.string().nullable(), ids: z.array(z.string()) })),
    }),
  ),
});
export type PoolReport = z.infer<typeof poolReportSchema>;

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Counts and names every list the bridge or the archetype assignment left out of a draw: nothing is dropped silently. */
export function poolReport(pool: OpponentPool): PoolReport {
  const totalWeight = pool.lists.reduce((s, l) => s + l.weight, 0);
  const unmappedLists = pool.lists.filter((l) => l.unmapped.length > 0);
  const byReason: Record<string, number> = {};
  for (const u of pool.unassigned) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
  return poolReportSchema.parse({
    sampler: SAMPLER_VERSION,
    window: { from: pool.window.from, to: pool.window.to },
    population: populationLabel(pool.window, pool.lists.length).text,
    read: pool.counts,
    lists: pool.lists.length,
    unmappedLists: unmappedLists.length,
    unmappedWeightShare: totalWeight === 0 ? 0 : r4(unmappedLists.reduce((s, l) => s + l.weight, 0) / totalWeight),
    unassigned: {
      count: pool.unassigned.length,
      byReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => compareCodePoints(a[0], b[0]))),
      lists: pool.unassigned,
    },
    archetypesWithoutLists: pool.archetypes.filter((a) => (pool.byArchetype.get(a.id) ?? []).length === 0).map((a) => a.id),
    archetypes: pool.archetypes.map((a) => {
      const lists = pool.byArchetype.get(a.id) ?? [];
      const bad = lists.filter((l) => l.unmapped.length > 0);
      return {
        id: a.id,
        name: a.name,
        share: a.share,
        metaDecks: a.decks,
        lists: lists.length,
        unmappedLists: bad.length,
        unmapped: bad.map((l) => ({ key: l.key, name: l.name, ids: l.unmapped })),
      };
    }),
  });
}
