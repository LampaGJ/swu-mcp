import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MissingDataError, packageDirOf, readJson, splitCell, type CardRow, type CardStore } from "../data.js";
import { loadClusterLabels, resolveClusterLabel } from "../embed/cluster-labels.js";
import type { ClustersFile } from "../embed/files.js";
import { selectLeaderPopulation, type LeaderSelection, type SelectedLeaderData } from "../meta/leader-split.js";
import { indexLeaderCards, LEADER_CARDS_MAX, type LeaderCardsEntry, type LeaderCardsIndex } from "../meta/schema.js";
import { rulesFor } from "../rules/store.js";
import { countAtOrBelow } from "../scorer/rank.js";
import type { ScoreRow } from "../scorer/scores-file.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { SynergyContext } from "../synergy/context.js";
import { clauseLock, isLocked, lockFields, lockSupply, type ClauseLock, type LockSupply } from "../synergy/clause-lock.js";
import { coverPenalty } from "../synergy/cover.js";
import { aspectGroup, roleOf, substitutesFor } from "../synergy/fungibility.js";
import { edgeOrder } from "../synergy/graph.js";
import { leaderEngineOf, roleKeepOf, suppliedKeywords } from "../synergy/leader-engine.js";
import { cardLabel } from "../synergy/order.js";
import type { PairEdge, SynergyCard } from "../synergy/schema.js";
import type { ToolResult } from "../tools.js";
import { marketData, type MarketData } from "./market.js";
import { similarityData } from "./similarity.js";
import { synergyContextOf } from "./synergy.js";
import { dataVersion, valueData } from "./value.js";
import { ok, fail, lower, round } from "./common.js";
import { cardList, deckLineSchema, decklistField } from "./decklist-field.js";
import { expandSwudb, hasPrintingColumns, isSwudbId, swudbCandidates, swudbField } from "./swudb.js";

/**
 * @displayName Deck tools
 * @strategicPurpose MCP read-only tools that take a decklist, a collection or a trade as arguments
 * (LampaGJ/swu-mcp#5): deck_audit, deck_legality_check, suggest_leader_base, playable_cards,
 * fungible_in_deck, budget_alternatives, price_list, trade_balance, owned_vs_needed,
 * play_value_vs_price and score_vs_play. Nothing is stored and no model sits in the path.
 * @tacticalObjective Composes the synergy context (aspect cover, fungibility, pair graph), the
 * scores, the market files and the cluster run through one DeckEnv, so a tool answer and the
 * module it reuses cannot disagree. Names resolve by exact normalised match only; what cannot be
 * resolved is listed in the answer, never guessed.
 */

export interface DeckEnv {
  store: CardStore;
  ctx: SynergyContext;
  market: MarketData;
  scores: ReadonlyMap<string, ScoreRow>;
  clusters: ClustersFile | null;
  /** Where the pinned cluster labels are read from; the committed data/cluster-labels.json when unset. */
  clusterLabelsPath?: string;
  dataVersion: string;
  /** Per-leader tournament card inclusion; undefined = read <package>/meta/leader-cards.json on first use, null = none. */
  leaderCards?: LeaderCardsIndex | null;
}

const envs = new WeakMap<CardStore, DeckEnv>();
const leaderIndexes = new WeakMap<CardStore, LeaderCardsIndex | null>();

/** The leader-cards index, loaded lazily so a package built before #19 still serves every deck tool (score ranking). */
export function leaderCardsOf(env: DeckEnv): LeaderCardsIndex | null {
  if (env.leaderCards !== undefined) return env.leaderCards;
  const hit = leaderIndexes.get(env.store);
  if (hit !== undefined) return hit;
  const file = path.join(packageDirOf(env.store), "meta", "leader-cards.json");
  const index = existsSync(file) ? indexLeaderCards(readJson(file)) : null;
  leaderIndexes.set(env.store, index);
  return index;
}

/**
 * "tournament, 12 decks, 2026-07-04..2026-10-01", plus the community fallback when the leader has no tournament deck
 * and, with a selection (D60, #148), the base the lists were narrowed to or the one line that says why they were not.
 */
export function leaderSourceText(entry: LeaderCardsEntry, selection?: LeaderSelection): string {
  const fallback = entry.fallback ? "; the leader has no tournament decklist in the window, so these are community lists" : "";
  return `${entry.population}, ${entry.decks} decks, ${entry.window.from}..${entry.window.to}${fallback}${selection?.line == null ? "" : `; ${selection.line}`}`;
}

/** The fields a tool adds to its leader-source block when the leader's lists were narrowed by base or a base line applies (D60); empty otherwise, so the block keeps its old shape. */
export function selectionFields(selection: LeaderSelection): Record<string, unknown> {
  if (selection.line === null) return {};
  return {
    ...(selection.scope === "base" ? { base: selection.label } : selection.scope === "aspect" ? { baseAspects: selection.label } : {}),
    ...(selection.scope === "all" ? {} : { listsOfLeader: selection.allDecks }),
    populationNote: selection.line,
  };
}

/** The leader's decklists narrowed to the pair's base (D60, #148); null when the package holds none for this leader. */
export function leaderDataFor(env: DeckEnv, pair: { leader: Piece; base: Piece }): SelectedLeaderData | null {
  const data = leaderCardsOf(env)?.get(pair.leader.row.cardKey);
  if (data === undefined) return null;
  return selectLeaderPopulation(data, { base: { cardKey: pair.base.row.cardKey, title: cardLabel(pair.base.row), aspects: icons(pair.base) } });
}

export function deckEnvOf(store: CardStore): DeckEnv {
  const hit = envs.get(store);
  if (hit !== undefined) return hit;
  const value = valueData(store);
  let clusters: ClustersFile | null = null;
  try {
    clusters = similarityData(store).clusters;
  } catch (error) {
    if (!(error instanceof MissingDataError)) throw error;
    clusters = null;
  }
  const env: DeckEnv = {
    store,
    ctx: synergyContextOf(store),
    market: marketData(store),
    scores: value.rows,
    clusters,
    dataVersion: dataVersion(value.replay),
  };
  envs.set(store, env);
  return env;
}

const r2 = (x: number): number => round(x, 2);
const r4 = (x: number): number => round(x, 4);
const r6 = (x: number): number => round(x, 6);
const sumBy = <T>(items: readonly T[], f: (item: T) => number): number => items.reduce((s, item) => s + f(item), 0);

// ---------------------------------------------------------------------------------------------
// Comprehensive Rules citations (v8.0 sections in the data; verified at run time by citedRules)

const CR = {
  minimumVaries: "1.2.1",
  leaderBaseCount: "1.2.2",
  tokens: "1.2.3",
  baseOverride: "3.2.1.a",
  copyLimit: "8.5.5",
  deckContents: "9.2.2.a",
  premierCopies: "9.2.2.b",
  sideboard: "9.2.2.c",
  cardpool: "9.2.2.d",
} as const;

const MIN_MAIN_DECK = 50;
const MAX_COPIES = 3;

/** Which cited sections the loaded Comprehensive Rules actually contain, with their version. */
function citedRules(store: CardStore, ids: readonly string[]): { rulesVersion: string | null; missing: string[] } {
  try {
    const rules = rulesFor(store.dataDir);
    return { rulesVersion: rules.document.version, missing: ids.filter((id) => !rules.byId.has(id)) };
  } catch (error) {
    if (!(error instanceof MissingDataError)) throw error;
    return { rulesVersion: null, missing: [...ids] };
  }
}

// ---------------------------------------------------------------------------------------------
// Input shapes and name resolution

export { cardList, deckLineSchema, decklistField };
export const leaderField = z.string().min(1).describe("The leader: a cardKey, a SET_NNN id or an exact title (with subtitle if the title is shared)");
export const baseField = z.string().min(1).describe("The base: a cardKey, a SET_NNN id or an exact title");

/** The SWUDB document's sideboard, carried beside the registered arguments by expandSwudb; never an argument of its own. */
const sideboardInput = z.object({ sideboard: cardList("Sideboard cards as {card, count}").optional() });
const MAX_SIDEBOARD = 10;

const normalise = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

const nameIndexes = new WeakMap<CardStore, Map<string, CardRow[]>>();

function nameIndex(store: CardStore): Map<string, CardRow[]> {
  const hit = nameIndexes.get(store);
  if (hit !== undefined) return hit;
  const index = new Map<string, CardRow[]>();
  const add = (name: string, row: CardRow): void => {
    const key = normalise(name);
    const list = index.get(key) ?? [];
    if (!list.includes(row)) list.push(row);
    index.set(key, list);
  };
  for (const row of store.cards) {
    add(row.title, row);
    if (row.subtitle !== null && row.subtitle !== "") {
      for (const joiner of [", ", " - ", ": "]) add(`${row.title}${joiner}${row.subtitle}`, row);
    }
  }
  nameIndexes.set(store, index);
  return index;
}

type Kind = "main" | "leader" | "base" | "any";

const kindFits = (type: string, kind: Kind): boolean =>
  kind === "any" || (kind === "leader" ? type === "Leader" : kind === "base" ? type === "Base" : type !== "Leader" && type !== "Base");

const describeRow = (row: CardRow): string => `${row.cardKey} ${cardLabel(row)} (${row.type})`;

type Resolution = { ok: true; row: CardRow } | { ok: false; reason: "unknown" | "ambiguous" | "wrong type"; detail: string };

/** A cardKey is one alphanumeric token with a digit (0101033, 08010011); anything else, a title, can be a card from a set before the pool. */
const CARD_KEY_SHAPE = /^[A-Za-z]*\d[A-Za-z0-9]*$/;

/** Names of the main sets the expansion index marks rotated, in main-set order ("Spark of Rebellion. Main set 1. Premier rotated it out." gives Spark of Rebellion). */
function rotatedSetNames(store: CardStore): string[] {
  const named = (store.facets.get("expansion") ?? []).flatMap((e) => {
    const definition = e.definition ?? "";
    const number = /\bMain set (\d+)\b/.exec(definition)?.[1];
    const name = /^(.+?)\.\s/.exec(definition)?.[1];
    return /rotated/i.test(definition) && number !== undefined && name !== undefined ? [{ order: Number(number), name }] : [];
  });
  return named.sort((a, b) => a.order - b.order || compareCodePoints(a.name, b.name)).map((n) => n.name);
}

function missDetail(store: CardStore, ref: string): string {
  if (CARD_KEY_SHAPE.test(ref.trim())) return "no card with this cardKey or title";
  const rotated = rotatedSetNames(store);
  return `not in the data: this name is not a card from Jump to Lightspeed onward (the Premier pool), so it is either a card from a rotated set${rotated.length === 0 ? "" : ` (${rotated.join(", ")})`} or a misspelling`;
}

/** A SET_NNN id names a printing: placed by the card table's expansion, cardNumber and sets columns, and never guessed past them. */
function resolveSwudbRef(store: CardStore, ref: string, kind: Kind): Resolution {
  const id = ref.trim();
  const found = swudbCandidates(store, id);
  if (found.length === 0)
    return {
      ok: false,
      reason: "unknown",
      detail: hasPrintingColumns(store)
        ? `no card is printed as ${id}: no card has that expansion and card number, and none lists that set with that number`
        : `${id} cannot be placed: this package's card table has no expansion and cardNumber columns`,
    };
  const fits = found.filter((row) => kindFits(row.type, kind));
  // A token takes its parent's card number (LOF_002 is Mother Talzin and a Shield token); a deck holds no token.
  const real = fits.filter((row) => !row.type.startsWith("Token"));
  const pick = real.length > 0 ? real : fits;
  if (pick.length === 1) return { ok: true, row: pick[0] };
  const list = (pick.length === 0 ? found : pick).map(describeRow).sort(compareCodePoints);
  if (pick.length === 0)
    return { ok: false, reason: "wrong type", detail: `${id} is not a ${kind === "main" ? "main-deck card" : kind}: ${list.join("; ")}` };
  return { ok: false, reason: "ambiguous", detail: `${id} matches ${pick.length} cards, pass the cardKey: ${list.join("; ")}` };
}

export function resolveRef(store: CardStore, ref: string, kind: Kind): Resolution {
  if (isSwudbId(ref)) return resolveSwudbRef(store, ref, kind);
  const direct = store.byKey.get(ref.trim());
  const found = direct !== undefined ? [direct] : (nameIndex(store).get(normalise(ref)) ?? []);
  if (found.length === 0) return { ok: false, reason: "unknown", detail: missDetail(store, ref) };
  const fits = found.filter((row) => kindFits(row.type, kind));
  if (fits.length === 1) return { ok: true, row: fits[0] };
  const list = (fits.length === 0 ? found : fits).map(describeRow).sort(compareCodePoints);
  if (fits.length === 0)
    return { ok: false, reason: "wrong type", detail: `not a ${kind === "main" ? "main-deck card" : kind}: ${list.join("; ")}` };
  return { ok: false, reason: "ambiguous", detail: `matches ${fits.length} cards, pass the cardKey: ${list.join("; ")}` };
}

interface DeckLine {
  row: CardRow;
  syn: SynergyCard;
  count: number;
}

interface Unresolved {
  card: string;
  count: number;
  reason: string;
  detail: string;
}

interface ResolvedList {
  lines: DeckLine[];
  unresolved: Unresolved[];
  copies: number;
}

export function resolveList(env: DeckEnv, entries: readonly z.infer<typeof deckLineSchema>[], kind: Kind): ResolvedList {
  const merged = new Map<string, DeckLine>();
  const unresolved: Unresolved[] = [];
  for (const entry of entries) {
    const resolved = resolveRef(env.store, entry.card, kind);
    if (!resolved.ok) {
      unresolved.push({ card: entry.card, count: entry.count, reason: resolved.reason, detail: resolved.detail });
      continue;
    }
    const syn = env.ctx.graph.byKey.get(resolved.row.cardKey);
    if (syn === undefined) {
      unresolved.push({
        card: entry.card,
        count: entry.count,
        reason: "no feature record",
        detail: `${resolved.row.cardKey} is in the card list but not in the feature file`,
      });
      continue;
    }
    const line = merged.get(syn.cardKey);
    if (line === undefined) merged.set(syn.cardKey, { row: resolved.row, syn, count: entry.count });
    else line.count += entry.count;
  }
  const lines = [...merged.values()];
  return { lines, unresolved, copies: sumBy(lines, (l) => l.count) };
}

interface Piece {
  row: CardRow;
  syn: SynergyCard;
}

function resolvePiece(env: DeckEnv, ref: string, kind: "leader" | "base"): Piece | string {
  const resolved = resolveRef(env.store, ref, kind);
  if (!resolved.ok) return `${kind} "${ref}": ${resolved.reason}, ${resolved.detail}`;
  const syn = env.ctx.graph.byKey.get(resolved.row.cardKey);
  return syn === undefined ? `${kind} "${ref}": ${resolved.row.cardKey} has no feature record` : { row: resolved.row, syn };
}

export function resolvePair(env: DeckEnv, leaderRef: string, baseRef: string): { leader: Piece; base: Piece } | string {
  const leader = resolvePiece(env, leaderRef, "leader");
  if (typeof leader === "string") return leader;
  const base = resolvePiece(env, baseRef, "base");
  if (typeof base === "string") return base;
  return { leader, base };
}

const icons = (piece: Piece): string[] => piece.syn.structured.aspectIcons;
export const suppliedBy = (pair: { leader: Piece; base: Piece }): string[] => [...icons(pair.leader), ...icons(pair.base)];
const iconText = (list: readonly string[]): string => list.join("+") || "none";
const head = (row: { cardKey: string; title: string; subtitle: string | null }) => ({ cardKey: row.cardKey, title: cardLabel(row) });

function noCards(unresolved: readonly Unresolved[]): ToolResult {
  return fail(`none of the cards resolved: ${unresolved.map((u) => `"${u.card}" (${u.reason}: ${u.detail})`).join("; ")}`);
}

// ---------------------------------------------------------------------------------------------
// Shared lookups: price, score, set scope, cover, substitutes

const priceOf = (env: DeckEnv, cardKey: string, finish: "normal" | "foil" = "normal"): number | null =>
  env.market.priceByKey.get(cardKey)?.[finish] ?? null;

function cheapestPrice(env: DeckEnv, cardKey: string, finish: "normal" | "foil" = "normal"): number | null {
  const entry = env.market.priceByKey.get(cardKey);
  if (entry === undefined) return null;
  const prices = entry.printings.map((p) => p[finish]).filter((p): p is number => p !== null);
  return prices.length === 0 ? null : Math.min(...prices);
}

export const MAIN_TYPES = new Set(["Unit", "Event", "Upgrade"]);

interface PremierScope {
  legal: ReadonlySet<string>;
  rotated: ReadonlySet<string>;
}

const scopes = new WeakMap<CardStore, PremierScope | null>();

/** Premier-legal and rotated set codes, read from the expansion index definitions of the loaded package. */
function premierScope(store: CardStore): PremierScope | null {
  if (scopes.has(store)) return scopes.get(store) ?? null;
  const entries = store.facets.get("expansion");
  const scope =
    entries === undefined
      ? null
      : {
          legal: new Set(entries.filter((e) => /Premier legal/i.test(e.definition ?? "")).map((e) => e.value)),
          rotated: new Set(entries.filter((e) => /rotated/i.test(e.definition ?? "")).map((e) => e.value)),
        };
  scopes.set(store, scope);
  return scope;
}

type CardScope = "legal" | "rotated" | "unverified";

export function cardScope(store: CardStore, row: CardRow): CardScope {
  const scope = premierScope(store);
  const sets = splitCell(row.sets);
  if (scope === null) return "unverified";
  if (sets.some((s) => scope.legal.has(s))) return "legal";
  return sets.length > 0 && sets.every((s) => scope.rotated.has(s)) ? "rotated" : "unverified";
}

/** Decision D46: substitutes and alternatives come from the Premier pool, a card with a Premier-legal printing. A package with no expansion index checks nothing. */
export function inPremierPool(store: CardStore): (cardKey: string) => boolean {
  if (premierScope(store) === null) return () => true;
  return (cardKey) => {
    const row = store.byKey.get(cardKey);
    return row !== undefined && cardScope(store, row) === "legal";
  };
}

interface WeightedCover {
  penalty: number;
  uncovered: { card: string; cardKey: string; count: number; icons: string; penaltyEach: number; penaltyTotal: number }[];
}

/** Penalty of fielding every copy under one leader and base: coverPenalty per card, times its count. */
function deckCover(lines: readonly DeckLine[], leader: readonly string[], base: readonly string[]): WeightedCover {
  const result = coverPenalty(
    lines.map((l) => l.syn),
    leader,
    base,
  );
  const countOf = new Map(lines.map((l) => [l.syn.cardKey, l.count]));
  const uncovered = result.uncovered.map((u) => {
    const count = countOf.get(u.cardKey) ?? 1;
    const syn = lines.find((l) => l.syn.cardKey === u.cardKey) as DeckLine;
    return {
      card: cardLabel(syn.syn),
      cardKey: u.cardKey,
      count,
      icons: u.icons.join("+"),
      penaltyEach: u.penalty,
      penaltyTotal: u.penalty * count,
    };
  });
  return { penalty: sumBy(uncovered, (u) => u.penaltyTotal), uncovered };
}

export const singlePenalty = (syn: SynergyCard, supplied: readonly string[]): number => coverPenalty([syn], supplied, []).penalty;

interface Slot {
  roles: string[];
  /** Substitute cardKey -> how many of the card's roles it fills. */
  fills: Map<string, number>;
}

/** The role tags of a card and, for each other card in any of those role classes, how many of the roles it fills. */
function slotMembers(env: DeckEnv, cardKey: string): Slot | null {
  const fungibility = env.ctx.fungibility;
  const tags = [
    ...new Set((fungibility.rolesByCard.get(cardKey) ?? []).map((id) => (fungibility.classById.get(id) as { tag: string }).tag)),
  ].filter((tag) => !tag.startsWith("keyword:"));
  const fills = new Map<string, number>();
  for (const tag of tags) {
    for (const member of roleOf(fungibility, cardKey, tag)?.members ?? []) {
      if (member !== cardKey) fills.set(member, (fills.get(member) ?? 0) + 1);
    }
  }
  return tags.length === 0 ? null : { roles: tags, fills };
}

interface Candidate {
  syn: SynergyCard;
  row: CardRow;
  cost: number | null;
  fills: number;
}

/** Fungible substitutes of one deck card as a flat list: not in the deck, in the Premier pool (D46). */
function substituteCandidates(
  env: DeckEnv,
  slotCard: DeckLine,
  slot: Slot,
  supplied: readonly string[] | undefined,
  exclude: ReadonlySet<string>,
): Candidate[] {
  const groups = substitutesFor(env.ctx.fungibility, [...slot.fills.keys()], slotCard.syn.cardKey, {
    preferAspects: supplied,
    perGroup: 100,
  });
  const out: Candidate[] = [];
  const pool = inPremierPool(env.store);
  for (const group of groups) {
    for (const sub of group.cards) {
      if (exclude.has(sub.cardKey)) continue;
      const row = env.store.byKey.get(sub.cardKey);
      const syn = env.ctx.graph.byKey.get(sub.cardKey);
      if (row === undefined || syn === undefined || !pool(sub.cardKey)) continue;
      out.push({ syn, row, cost: sub.cost, fills: slot.fills.get(sub.cardKey) as number });
    }
  }
  return out;
}

const arenaKey = (c: SynergyCard): string => (c.structured.arenas ?? []).map((a) => a.toLowerCase()).sort(compareCodePoints).join("+");

/** A budget swap keeps the card's type, a unit's arena and its cost to within one. */
function sameSlotShape(slotCard: SynergyCard, other: SynergyCard): boolean {
  if (slotCard.type !== other.type) return false;
  if (slotCard.type === "Unit" && arenaKey(slotCard) !== arenaKey(other)) return false;
  const [a, b] = [slotCard.structured.cost, other.structured.cost];
  return a === null || b === null ? a === b : Math.abs(a - b) <= 1;
}

const numberOr = (value: number | null | undefined, fallback: number): number => value ?? fallback;

/** Decision D45: a card in under 2% of the leader's decklists is not a card the leader plays; the tools that fill a deck leave it out. */
export const LEADER_INCLUSION_FLOOR = 0.02;
/** Decision D50: a card in at least 60% of the leader's decklists is a staple, listed past perCost. */
export const LEADER_STAPLE_INCLUSION = 0.6;
/** Decision D50: with emptyCostsOnly, a cost counts as used when the leader's lists hold this many mean copies there. */
export const LEADER_COST_MIN_COPIES = 0.5;

// ---------------------------------------------------------------------------------------------
// deck_audit

export const deckAuditShape = {
  decklist: decklistField,
  leader: leaderField,
  base: baseField,
  gapLimit: z.number().int().min(1).max(32).default(8).describe("Most cluster gaps listed"),
};

const COST_BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7+", "-"] as const;
const costBucket = (cost: number | null): string => (cost === null ? "-" : cost >= 7 ? "7+" : String(cost));

const intoIndex = new WeakMap<SynergyContext, Map<string, PairEdge[]>>();

function edgesInto(ctx: SynergyContext): Map<string, PairEdge[]> {
  const hit = intoIndex.get(ctx);
  if (hit !== undefined) return hit;
  const index = new Map<string, PairEdge[]>();
  for (const edge of ctx.graph.edges) {
    if (edge.traitOnly) continue;
    const bucket = index.get(edge.b);
    if (bucket === undefined) index.set(edge.b, [edge]);
    else bucket.push(edge);
  }
  intoIndex.set(ctx, index);
  return index;
}

const NAMED_FEEDERS = 3;

/** Decision D59 (#147, #150): the lock fields every deck tool prints. */
export const LOCK_NOTE =
  "baseLocked: a clause of the card works only under a base of that location (Origin Tree is Kashyyyk, Jundland Wastes Tatooine; the location is pinned from the engine card data) and this base is another; needsUnitAspect: a clause of the card works only while you control a unit of that aspect (\"A or B\" = either) and the leader, base and deck units supply none. A locked card is ranked after the unlocked ones and is not counted as covering a threat. Only the card's own clause text is read: a card whose lock sits in a leader or base ability is not flagged.";

/**
 * The best few cards offering what an orphan wants; "Title (cost)", with ", +N" for an aspect penalty. Without the
 * leader's lists, penalty-free for this leader and base first. With them (#140): cards the lists play at
 * LEADER_INCLUSION_FLOOR or more first, most played first, then aspect penalty, then pair edge; an unplayed card is
 * marked "unplayed" and a played one carries its inclusion.
 */
function namedFeeders(env: DeckEnv, feeders: readonly PairEdge[], inDeck: ReadonlySet<string>, supplied: readonly string[], data: LeaderData | null, locks: LockSupply): string {
  const inclusionOf = (cardKey: string): number => data?.byCard.get(cardKey)?.inclusion ?? 0;
  const playedIn = (cardKey: string): boolean => inclusionOf(cardKey) >= LEADER_INCLUSION_FLOOR;
  return feeders
    .flatMap((edge) => {
      const syn = env.ctx.graph.byKey.get(edge.a);
      const row = env.store.byKey.get(edge.a);
      if (syn === undefined || row === undefined || inDeck.has(edge.a)) return [];
      if (!MAIN_TYPES.has(syn.type) || cardScope(env.store, row) === "rotated") return [];
      const lock = clauseLock(syn, locks);
      return [{ edge, syn, penalty: singlePenalty(syn, supplied), lock, locked: isLocked(lock) }];
    })
    // D59: a feeder whose clause this leader, base and deck cannot meet follows the feeders that can.
    .sort((x, y) =>
      Number(x.locked) - Number(y.locked) ||
      (data === null
        ? x.penalty - y.penalty || edgeOrder(x.edge, y.edge)
        : Number(playedIn(y.edge.a)) - Number(playedIn(x.edge.a)) ||
          (playedIn(x.edge.a) ? inclusionOf(y.edge.a) - inclusionOf(x.edge.a) : 0) ||
          x.penalty - y.penalty ||
          edgeOrder(x.edge, y.edge)),
    )
    .slice(0, NAMED_FEEDERS)
    .map(({ syn, penalty, lock }) => {
      const mark = data === null ? "" : playedIn(syn.cardKey) ? `, ${Math.round(inclusionOf(syn.cardKey) * 100)}%` : ", unplayed";
      const locked = Object.entries(lockFields(lock)).map(([k, v]) => `, ${k}: ${v}`).join("");
      return `${cardLabel(syn)} (${syn.structured.cost ?? "-"}${penalty > 0 ? `, +${penalty}` : ""}${mark}${locked})`;
    })
    .join("; ");
}

/** Wants a card carries for having any When Played, On Attack or When Defeated ability; nearly every deck feeds them by accident. */
const TRIGGER_WANTS: ReadonlySet<string> = new Set(["wants:replay-when-played", "wants:extra-attacks", "wants:self-defeated"]);
/** A want fed by an offer that more than this share of main-deck cards carry is generic. */
const GENERIC_FEEDER_SHARE = 0.25;

const genericIndex = new WeakMap<SynergyContext, Set<string>>();

/** The want tags no audit row should name one card at a time: trigger-derived wants, and wants most of the pool can feed. */
function genericWantTags(ctx: SynergyContext): ReadonlySet<string> {
  const hit = genericIndex.get(ctx);
  if (hit !== undefined) return hit;
  const offersFor = new Map<string, Set<string>>();
  for (const row of ctx.graph.rows) {
    if (row.family === "trait") continue;
    for (const want of Object.keys(row.wants)) {
      const set = offersFor.get(want) ?? new Set<string>();
      for (const offer of Object.keys(row.offers)) set.add(offer);
      offersFor.set(want, set);
    }
  }
  const main = ctx.cards.filter((c) => MAIN_TYPES.has(c.type));
  const generic = new Set(TRIGGER_WANTS);
  for (const [want, offers] of offersFor) {
    const feeders = main.filter((c) => c.tags.offers.some((o) => offers.has(o.tag))).length;
    if (main.length > 0 && feeders / main.length > GENERIC_FEEDER_SHARE) generic.add(want);
  }
  genericIndex.set(ctx, generic);
  return generic;
}

const wantsOf = (syn: SynergyCard): string[] =>
  [...new Set(syn.tags.wants.map((t) => t.tag).filter((tag) => !tag.startsWith("wants:trait-")))].sort(compareCodePoints);

/** A wide-board want with no number in its clause asks for this many units. */
const WIDE_BOARD_DEFAULT_UNITS = 3;

/** The unit count a wide-board want asks for: the first "N or more" in its clause, else WIDE_BOARD_DEFAULT_UNITS (#152). */
function wideBoardNeed(syn: SynergyCard): number {
  for (const t of syn.tags.wants) {
    const m = t.tag === "wants:wide-board" ? /\b(\d+) or more\b/.exec(t.why) : null;
    if (m !== null) return Number(m[1]);
  }
  return WIDE_BOARD_DEFAULT_UNITS;
}

export function deckAudit(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(deckAuditShape).parse(input);
  const pair = resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const { lines, unresolved, copies } = resolveList(env, args.decklist, "main");
  if (lines.length === 0) return noCards(unresolved);
  const supplied = suppliedBy(pair);
  const locks = lockSupply(pair.leader.syn, pair.base.syn, lines.map((l) => l.syn));

  const byType = new Map<string, number>();
  for (const l of lines) byType.set(l.row.type, (byType.get(l.row.type) ?? 0) + l.count);
  const costed = lines.filter((l) => l.syn.structured.cost !== null);
  const averageCost =
    costed.length === 0 ? null : r2(sumBy(costed, (l) => (l.syn.structured.cost as number) * l.count) / sumBy(costed, (l) => l.count));

  const weightedMean = (pick: (l: DeckLine) => number | null): number | null => {
    const have = lines.filter((l) => pick(l) !== null);
    return have.length === 0 ? null : r2(sumBy(have, (l) => (pick(l) as number) * l.count) / sumBy(have, (l) => l.count));
  };
  const scoreOf = (l: DeckLine): ScoreRow | undefined => env.scores.get(l.syn.cardKey);

  const curve = COST_BUCKETS.flatMap((bucket) => {
    const inBucket = lines.filter((l) => costBucket(l.syn.structured.cost) === bucket);
    if (inBucket.length === 0) return [];
    const withStats = inBucket.filter((l) => scoreOf(l)?.components.expectedStats != null);
    const stat = (pick: (c: ScoreRow["components"]) => number): number | null =>
      withStats.length === 0
        ? null
        : r2(sumBy(withStats, (l) => pick((scoreOf(l) as ScoreRow).components) * l.count) / sumBy(withStats, (l) => l.count));
    return [
      {
        cost: bucket,
        cards: sumBy(inBucket, (l) => l.count),
        units: sumBy(
          inBucket.filter((l) => l.row.type === "Unit"),
          (l) => l.count,
        ),
        avgExpectedStats: stat((c) => c.expectedStats as number),
        avgStatSurplus: stat((c) => c.statSurplus),
      },
    ];
  });

  const cover = deckCover(lines, icons(pair.leader), icons(pair.base));

  const inDeck = new Set(lines.map((l) => l.syn.cardKey));
  const into = edgesInto(env.ctx);
  const generic = genericWantTags(env.ctx);
  const genericHolders = new Map<string, string[]>();
  const leaderData = leaderDataFor(env, pair);
  const fedFromDeck = (feeders: readonly PairEdge[], cardKey: string): boolean => feeders.some((e) => inDeck.has(e.a) && e.a !== cardKey);
  const unitCopies = sumBy(
    lines.filter((l) => l.row.type === "Unit"),
    (l) => l.count,
  );
  // A wide-board want is fed by the deck's own unit count, so it is no orphan once the deck holds the units it asks for.
  const boardFed = (l: DeckLine, want: string): boolean => want === "wants:wide-board" && unitCopies >= wideBoardNeed(l.syn);
  // A want the table marks generically fed (paying any cost exhausts resources) is fed by playing the deck at all (D62).
  const fedByAnyDeck = env.ctx.graph.genericallyFed;
  const orphanWants = lines.flatMap((l) => {
    const wants = wantsOf(l.syn).filter((w) => !boardFed(l, w) && !fedByAnyDeck.has(w));
    if (wants.length === 0) return [];
    const all = into.get(l.syn.cardKey) ?? [];
    const feeding = (tags: readonly string[]): PairEdge[] => all.filter((e) => e.rows.some((r) => tags.includes(r.want)));
    const vague = wants.filter((w) => generic.has(w));
    const specific = wants.filter((w) => !generic.has(w));
    if (vague.length > 0 && !fedFromDeck(feeding(vague), l.syn.cardKey)) {
      for (const w of vague) genericHolders.set(w, [...(genericHolders.get(w) ?? []), cardLabel(l.syn)]);
    }
    const feeders = feeding(specific);
    if (specific.length === 0 || fedFromDeck(feeders, l.syn.cardKey)) return [];
    return [
      {
        card: cardLabel(l.syn),
        cardKey: l.syn.cardKey,
        wants: specific.slice(0, 4).join(", "),
        feedersInCardPool: feeders.length,
        feeders: namedFeeders(env, feeders, inDeck, supplied, leaderData, locks),
      },
    ];
  });
  const genericWants =
    genericHolders.size === 0
      ? "none"
      : `${[...genericHolders.entries()]
          .sort(([a], [b]) => compareCodePoints(a, b))
          .map(([w, cards]) => `${w} (${cards.length} ${cards.length === 1 ? "card" : "cards"}): ${cards.join("; ")}`)
          .join(" | ")}. Generic wants (any When Played, On Attack or When Defeated, or fed by more than ${GENERIC_FEEDER_SHARE * 100}% of main-deck cards) are not listed per card. Wants every deck feeds by playing cards at all (${[...fedByAnyDeck].sort(compareCodePoints).join(", ") || "none"}) are never listed.`;

  const leaderComparison = leaderComparisonOf(env, lines, leaderData, supplied);
  const clusterGaps = clusterGapRows(env, lines, supplied, args.gapLimit, leaderData);
  const sideboardEntries = sideboardInput.parse(input).sideboard;
  const sideboard = sideboardEntries === undefined ? undefined : sideboardRows(env, sideboardEntries, supplied, leaderData, locks);
  const lockedCards = lines.flatMap((l) => {
    const lock = clauseLock(l.syn, locks);
    return isLocked(lock) ? [{ card: cardLabel(l.syn), cardKey: l.syn.cardKey, count: l.count, ...lockFields(lock) }] : [];
  });

  return ok({
    dataVersion: env.dataVersion,
    leader: head(pair.leader.row),
    base: head(pair.base.row),
    deck: {
      cards: copies,
      distinct: lines.length,
      byType: Object.fromEntries([...byType.entries()].sort(([a], [b]) => compareCodePoints(a, b))),
      averageCost,
    },
    unresolved,
    score: {
      note: "total is designer stat points (compares within one type); playCalibrated is fitted to Premier inclusion and is rank-meaningful only",
      scoredCards: sumBy(
        lines.filter((l) => scoreOf(l)?.total != null),
        (l) => l.count,
      ),
      meanTotal: weightedMean((l) => scoreOf(l)?.total ?? null),
      meanPlayCalibrated: weightedMean((l) => scoreOf(l)?.playCalibrated ?? null),
    },
    curve,
    aspect: {
      suppliedIcons: iconText(supplied),
      penalty: cover.penalty,
      note: "+2 resources per aspect icon the leader and base do not supply, counted per copy; leader abilities that ignore the penalty are not modelled",
      uncovered: cover.uncovered,
    },
    leaderComparison,
    lockedCards: { note: LOCK_NOTE, cards: lockedCards },
    orphanWants,
    genericWants,
    clusterGaps,
    ...(sideboard === undefined ? {} : { sideboard }),
  });
}

/** The sideboard listed beside the 50, never merged into it (#143): one row per card with the figures a swap decision reads. */
function sideboardRows(env: DeckEnv, entries: readonly z.infer<typeof deckLineSchema>[], supplied: readonly string[], data: LeaderData | null, locks: LockSupply) {
  const { lines, unresolved, copies } = resolveList(env, entries, "main");
  return {
    note: "the sideboard is not part of the deck counts above; penalty is per copy under this leader and base; leaderInclusion is the share of the leader's decklists that play the card, null = never in the leader's top cards",
    cards: copies,
    rows: lines.map((l) => ({
      card: cardLabel(l.syn),
      cardKey: l.syn.cardKey,
      count: l.count,
      type: l.row.type,
      cost: l.syn.structured.cost,
      penalty: singlePenalty(l.syn, supplied),
      scoreTotal: env.scores.get(l.syn.cardKey)?.total ?? null,
      playCalibrated: env.scores.get(l.syn.cardKey)?.playCalibrated ?? null,
      leaderInclusion: data === null ? null : (data.byCard.get(l.syn.cardKey)?.inclusion ?? null),
      ...lockFields(clauseLock(l.syn, locks)),
    })),
    unresolved,
  };
}

/** A tag defines a cluster when at least this many of the cluster's cards carry it... */
const DEFINING_TAG_MIN_CARDS = 5;
/** ...and at least this share of every card carrying the tag sits in the cluster. */
const DEFINING_TAG_MIN_SHARE = 0.4;
/** A cluster's label names the keyword that defines it as "kw:Raid(100%)"; a share this high counts. */
const KEYWORD_CLUSTER_MIN_SHARE = 50;
const KEYWORD_TOKEN = /\bkw:([A-Za-z]+)\((\d+)%\)/g;
const DECK_CARDS_RULE = `deckCards counts a deck card in a cluster when the clusters file places it there or it carries one of the cluster's defining tags (an offers: or wants: tag that at least ${DEFINING_TAG_MIN_CARDS} of the cluster's cards carry and that at least ${DEFINING_TAG_MIN_SHARE * 100}% of all cards carrying it sit in the cluster), so a card the clustering placed elsewhere still counts toward the role it plays; a card that prints the keyword naming a cluster (kw:Raid in its label at ${KEYWORD_CLUSTER_MIN_SHARE}% or more) counts in that cluster, the one with the most printed holders when several are named for it`;

/** Printed keywords of a card: `structured.keywordsField` and the non-granted entries of `keywords`. */
function printedKeywordsOf(syn: SynergyCard): ReadonlySet<string> {
  const field = ((syn.structured.keywordsField as unknown[] | undefined) ?? []).filter((k): k is string => typeof k === "string");
  const listed = ((syn.keywords as { keyword?: unknown; granted?: unknown }[] | undefined) ?? []).flatMap((k) => (typeof k.keyword === "string" && k.granted !== true ? [k.keyword] : []));
  return new Set([...field, ...listed]);
}

const keywordClusters = new WeakMap<ClustersFile, Map<string, number>>();

/**
 * Per keyword, the cluster a printed holder of it belongs to (#152): among the clusters whose label names the keyword
 * at KEYWORD_CLUSTER_MIN_SHARE percent or more, the one with the most printed holders among its members, the lower id on
 * a tie. A second cluster named for the same keyword (Raid granters beside Raid units) gets no printed holders, because
 * it holds the cards that give the keyword, not the cards that print it.
 */
function keywordClustersOf(ctx: SynergyContext, clusters: ClustersFile, clusterOf: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  const hit = keywordClusters.get(clusters);
  if (hit !== undefined) return hit;
  const best = new Map<string, { id: number; holders: number }>();
  for (const c of [...clusters.clusters].sort((a, b) => a.id - b.id)) {
    if (!c.members.some((k) => clusterOf.get(k) === c.id)) continue;
    for (const m of c.label.matchAll(KEYWORD_TOKEN)) {
      if (Number(m[2]) < KEYWORD_CLUSTER_MIN_SHARE) continue;
      const holders = c.members.filter((k) => {
        const syn = ctx.graph.byKey.get(k);
        return syn !== undefined && printedKeywordsOf(syn).has(m[1]);
      }).length;
      const have = best.get(m[1]);
      if (have === undefined || holders > have.holders) best.set(m[1], { id: c.id, holders });
    }
  }
  const out = new Map([...best].map(([keyword, { id }]) => [keyword, id] as const));
  keywordClusters.set(clusters, out);
  return out;
}

const definingTags = new WeakMap<ClustersFile, Map<number, ReadonlySet<string>>>();

/** Per cluster, the offers: and wants: tags concentrated in it (D56); computed once per clusters file from the synergy tags, no model in the path. */
function definingTagsOf(ctx: SynergyContext, clusters: ClustersFile, clusterOf: ReadonlyMap<string, number>): ReadonlyMap<number, ReadonlySet<string>> {
  const hit = definingTags.get(clusters);
  if (hit !== undefined) return hit;
  const carriers = new Map<string, string[]>();
  for (const syn of ctx.cards) for (const t of new Set([...syn.tags.offers, ...syn.tags.wants].map((x) => x.tag))) carriers.set(t, [...(carriers.get(t) ?? []), syn.cardKey]);
  const out = new Map<number, Set<string>>();
  for (const [tag, keys] of carriers) {
    const perCluster = new Map<number, number>();
    for (const key of keys) {
      const id = clusterOf.get(key);
      if (id !== undefined) perCluster.set(id, (perCluster.get(id) ?? 0) + 1);
    }
    for (const [id, n] of perCluster) {
      if (n < DEFINING_TAG_MIN_CARDS || n / keys.length < DEFINING_TAG_MIN_SHARE) continue;
      out.set(id, (out.get(id) ?? new Set<string>()).add(tag));
    }
  }
  definingTags.set(clusters, out);
  return out;
}

/** A card the leader's lists play in at least this share of decks, and the deck lacks, is a missing staple. */
const STAPLE_INCLUSION = 0.5;
/** A deck card the leader's lists play in fewer than this share of decks (or never) is rarely played. */
const RARE_INCLUSION = 0.05;

type LeaderData = NonNullable<ReturnType<LeaderCardsIndex["get"]>> & { selection?: LeaderSelection };

/** The deck against the leader's own decklists (D43): staples it lacks and cards those lists rarely play. */
function leaderComparisonOf(env: DeckEnv, lines: readonly DeckLine[], data: LeaderData | null, supplied: readonly string[]): unknown {
  if (data === null) return { note: "no leader decklist data in this package for this leader, so the deck is not compared with real lists" };
  const { entry, byCard } = data;
  const byTitle = new Map(entry.cards.map((c) => [lower(c.title), c]));
  const heldTitles = new Set(lines.map((l) => lower(cardLabel(l.syn))));
  const inclusionOf = (l: DeckLine): number | null => (byCard.get(l.syn.cardKey) ?? byTitle.get(lower(cardLabel(l.syn))))?.inclusion ?? null;
  const held = new Set(lines.map((l) => l.syn.cardKey));
  const missingStaples = entry.cards
    .filter((c) => c.inclusion >= STAPLE_INCLUSION && !held.has(c.cardKey))
    .flatMap((c) => {
      const syn = env.ctx.graph.byKey.get(c.cardKey);
      if (syn !== undefined && !MAIN_TYPES.has(syn.type)) return [];
      const card = syn === undefined ? c.title : cardLabel(syn);
      if (heldTitles.has(lower(card))) return [];
      const penalty = syn === undefined ? 0 : singlePenalty(syn, supplied);
      // A penalised staple is marked, never hidden (D60); a penalty-free row keeps the old shape.
      return [{ card, cardKey: c.cardKey, inclusion: r4(c.inclusion), meanCopies: r2(c.meanCopies), cost: syn?.structured.cost ?? env.store.byKey.get(c.cardKey)?.cost ?? null, ...(penalty > 0 ? { penalty, penalised: true } : {}) }];
    })
    .sort((a, b) => b.inclusion - a.inclusion || compareCodePoints(a.card, b.card));
  const rarelyPlayed = lines.flatMap((l) => {
    const inclusion = inclusionOf(l);
    return inclusion !== null && inclusion >= RARE_INCLUSION ? [] : [{ card: cardLabel(l.syn), cardKey: l.syn.cardKey, count: l.count, inclusion: inclusion === null ? null : r4(inclusion) }];
  });
  return {
    population: entry.population,
    decks: entry.decks,
    window: `${entry.window.from}..${entry.window.to}`,
    ...(data.selection === undefined ? {} : selectionFields(data.selection)),
    source: leaderSourceText(entry, data.selection),
    note: `missingStaples: cards in at least ${STAPLE_INCLUSION * 100}% of this leader's decklists that the deck lacks (penalty and penalised: true mark a staple that pays an aspect penalty under this leader and base; a row without them pays none); rarelyPlayed: deck cards in fewer than ${RARE_INCLUSION * 100}% of them, inclusion null = never in the leader's top ${entry.cards.length} cards. Inclusion is placement-weighted (D38).`,
    missingStaples,
    rarelyPlayed,
  };
}

/**
 * Clusters over-represented in the yardstick relative to this deck: the leader's tournament cards weighted by
 * inclusion when the package has them (D43), otherwise the penalty-free Premier pool. A cluster made mostly of
 * cards a main deck cannot hold (bases, leaders, tokens) is never a gap.
 */
function clusterGapRows(env: DeckEnv, lines: readonly DeckLine[], supplied: readonly string[], limit: number, leaderData: LeaderData | null): unknown {
  if (env.clusters === null) return { note: "no similarity run in this package, so role clusters are unavailable" };
  const labels = loadClusterLabels(env.clusterLabelsPath);
  const typeOf = (k: string): string | undefined => env.ctx.graph.byKey.get(k)?.type ?? env.store.byKey.get(k)?.type;
  const deckable = (c: ClustersFile["clusters"][number]): boolean => c.members.filter((k) => MAIN_TYPES.has(typeOf(k) ?? "")).length * 2 >= c.members.length;
  const clusterOf = new Map(env.clusters.clusters.filter(deckable).flatMap((c) => c.members.map((k) => [k, c.id] as const)));
  const skipped = new Set(env.clusters.clusters.filter((c) => !deckable(c)).flatMap((c) => c.members));
  const weighted: { cardKey: string; weight: number }[] =
    leaderData === null
      ? env.ctx.cards
          .filter((syn) => {
            const row = env.store.byKey.get(syn.cardKey);
            return row !== undefined && MAIN_TYPES.has(syn.type) && cardScope(env.store, row) !== "rotated" && singlePenalty(syn, supplied) === 0;
          })
          .map((syn) => ({ cardKey: syn.cardKey, weight: 1 }))
      : leaderData.entry.cards.filter((c) => MAIN_TYPES.has(typeOf(c.cardKey) ?? "")).map((c) => ({ cardKey: c.cardKey, weight: c.inclusion }));
  const poolWeight = new Map<number, number>();
  const poolCount = new Map<number, number>();
  let totalWeight = 0;
  for (const { cardKey, weight } of weighted) {
    if (skipped.has(cardKey)) continue;
    totalWeight += weight;
    const id = clusterOf.get(cardKey);
    if (id === undefined) continue;
    poolWeight.set(id, (poolWeight.get(id) ?? 0) + weight);
    poolCount.set(id, (poolCount.get(id) ?? 0) + 1);
  }
  const defining = definingTagsOf(env.ctx, env.clusters, clusterOf);
  const byKeyword = keywordClustersOf(env.ctx, env.clusters, clusterOf);
  const deckCount = new Map<number, number>();
  for (const l of lines) {
    const own = clusterOf.get(l.syn.cardKey);
    const heldTags = new Set([...l.syn.tags.offers, ...l.syn.tags.wants].map((t) => t.tag));
    const ids = new Set<number>(own === undefined ? [] : [own]);
    for (const [id, tags] of defining) if ([...tags].some((t) => heldTags.has(t))) ids.add(id);
    for (const keyword of printedKeywordsOf(l.syn)) {
      const id = byKeyword.get(keyword);
      if (id !== undefined) ids.add(id);
    }
    for (const id of ids) deckCount.set(id, (deckCount.get(id) ?? 0) + l.count);
  }
  const mainCopies = sumBy(
    lines.filter((l) => MAIN_TYPES.has(l.row.type)),
    (l) => l.count,
  );
  const labelOf = new Map(env.clusters.clusters.map((c) => [c.id, resolveClusterLabel(c, labels)]));
  const rows = [...poolCount.entries()]
    .map(([id, n]) => {
      const expected = totalWeight === 0 ? 0 : ((poolWeight.get(id) ?? 0) / totalWeight) * mainCopies;
      const have = deckCount.get(id) ?? 0;
      return {
        clusterId: id,
        label: labelOf.get(id)?.label ?? "",
        labelStatus: labelOf.get(id)?.labelStatus ?? "unlabelled",
        deckCards: have,
        expected: r2(expected),
        gap: r2(expected - have),
        poolCards: n,
      };
    })
    .filter((row) => row.gap >= 1)
    .sort((a, b) => b.gap - a.gap || a.clusterId - b.clusterId);
  return {
    norm:
      leaderData === null
        ? `a cluster's share of the ${weighted.length} Premier-scope cards this leader and base play penalty-free, scaled to the ${mainCopies} main-deck cards; gap is expected minus held; ${DECK_CARDS_RULE}; clusters made mostly of bases, leaders or tokens are skipped`
        : `a cluster's inclusion-weighted share of the ${weighted.length} cards in this leader's decklists (${leaderSourceText(leaderData.entry, leaderData.selection)}), scaled to the ${mainCopies} main-deck cards; gap is expected minus held; poolCards counts those cards in the cluster; ${DECK_CARDS_RULE}; clusters made mostly of bases, leaders or tokens are skipped`,
    shown: Math.min(rows.length, limit),
    clusters: rows.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------------------------
// deck_legality_check

export const deckLegalityShape = {
  decklist: decklistField,
  leader: leaderField.optional(),
  base: baseField.optional(),
  format: z
    .enum(["premier", "eternal"])
    .default("premier")
    .describe("premier checks the Premier cardpool (CR 9.2.2.d); eternal skips the set check"),
};

interface Finding {
  rule: string;
  check: string;
  detail: string;
}

const baseDeckSizeShift = (text: string | null): number => {
  const match = /minimum deck size is (increased|decreased) by (\d+) cards?/i.exec(text ?? "");
  return match === null ? 0 : (match[1].toLowerCase() === "increased" ? 1 : -1) * Number(match[2]);
};

export function deckLegalityCheck(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(deckLegalityShape).parse(input);
  const failures: Finding[] = [];
  const warnings: Finding[] = [];
  const premier = args.format === "premier";

  const piece = (ref: string | undefined, kind: "leader" | "base"): Piece | undefined => {
    if (ref === undefined) {
      failures.push({ rule: CR.deckContents, check: kind, detail: `no ${kind} given; a deck needs exactly 1 leader and exactly 1 base` });
      return undefined;
    }
    const resolved = resolvePiece(env, ref, kind);
    if (typeof resolved === "string") {
      failures.push({ rule: CR.deckContents, check: kind, detail: resolved });
      return undefined;
    }
    return resolved;
  };
  const leader = piece(args.leader, "leader");
  const base = piece(args.base, "base");

  const { lines, unresolved } = resolveList(env, args.decklist, "any");
  const listedCopies = sumBy(args.decklist, (entry) => entry.count);
  const sideboardEntries = sideboardInput.parse(input).sideboard;
  const sideboardCopies = sideboardEntries === undefined ? undefined : sumBy(sideboardEntries, (entry) => entry.count);
  for (const u of unresolved)
    failures.push({ rule: CR.deckContents, check: "unresolved card", detail: `"${u.card}" x${u.count}: ${u.reason}, ${u.detail}` });

  const main: DeckLine[] = [];
  for (const l of lines) {
    if (l.row.type === "Leader" || l.row.type === "Base") {
      failures.push({
        rule: CR.deckContents,
        check: "leader or base in the card list",
        detail: `${describeRow(l.row)} belongs in the leader or base argument, not the 50 other cards`,
      });
    } else if (!MAIN_TYPES.has(l.row.type)) {
      failures.push({ rule: CR.tokens, check: "token in deck", detail: `${describeRow(l.row)} is a token; tokens are not part of a deck` });
    } else main.push(l);
  }

  if (sideboardEntries !== undefined) {
    const side = resolveList(env, sideboardEntries, "any");
    for (const u of side.unresolved)
      failures.push({ rule: CR.sideboard, check: "unresolved sideboard card", detail: `"${u.card}" x${u.count}: ${u.reason}, ${u.detail}` });
    for (const l of side.lines)
      if (!MAIN_TYPES.has(l.row.type))
        failures.push({ rule: CR.sideboard, check: "sideboard card type", detail: `${describeRow(l.row)} is not a unit, event or upgrade card; a sideboard holds deck cards` });
    if ((sideboardCopies as number) > MAX_SIDEBOARD)
      failures.push({ rule: CR.sideboard, check: "sideboard size", detail: `${sideboardCopies} sideboard cards; at most ${MAX_SIDEBOARD}` });
  }

  const shift = base === undefined ? 0 : baseDeckSizeShift(base.row.text);
  const minimum = MIN_MAIN_DECK + shift;
  const mainCopies = sumBy(main, (l) => l.count);
  if (mainCopies < minimum) {
    failures.push({
      rule: shift === 0 ? CR.deckContents : `${CR.deckContents}, ${CR.baseOverride}`,
      check: "deck size",
      detail: `${mainCopies} unit, event and upgrade cards; the minimum is ${minimum}${shift === 0 ? "" : ` (50 ${shift > 0 ? "+" : "-"} ${Math.abs(shift)} from ${cardLabel(base?.row as CardRow)})`}`,
    });
  }
  if (
    base !== undefined &&
    shift === 0 &&
    /deck/i.test(base.row.text ?? "") &&
    /minimum|maximum|copies|construct/i.test(base.row.text ?? "")
  ) {
    warnings.push({
      rule: CR.baseOverride,
      check: "base text",
      detail: `${cardLabel(base.row)} mentions deck construction; read its text: ${base.row.text}`,
    });
  }

  for (const l of main) {
    if (l.count > MAX_COPIES) {
      failures.push({
        rule: `${CR.premierCopies}, ${CR.copyLimit}`,
        check: "copy limit",
        detail: `${cardLabel(l.row)} x${l.count}; at most ${MAX_COPIES} copies of any card`,
      });
    }
  }

  if (premier) {
    const checkSet = (row: CardRow, role: string): void => {
      const scope = cardScope(env.store, row);
      if (scope === "rotated")
        failures.push({
          rule: CR.cardpool,
          check: "cardpool",
          detail: `${role} ${cardLabel(row)} appears only in rotated sets (${row.sets})`,
        });
      else if (scope === "unverified")
        warnings.push({
          rule: CR.cardpool,
          check: "cardpool",
          detail: `${role} ${cardLabel(row)} has no printing in a set the data marks Premier legal (sets: ${row.sets ?? "none"}); promo-only cards cannot be confirmed here`,
        });
    };
    if (leader !== undefined) checkSet(leader.row, "leader");
    if (base !== undefined) checkSet(base.row, "base");
    for (const l of main) checkSet(l.row, "card");
  }

  const cited = Object.values(CR);
  const verified = citedRules(env.store, cited);
  const dataLimits = [
    "No ban or suspension ledger is loaded, so a banned or suspended card is not detected.",
    "asOf dates are not supported: legality is judged against this data version only.",
    sideboardEntries === undefined
      ? "The sideboard (up to 10 cards, CR 9.2.2.c) is not checked: none was given."
      : "The sideboard is checked for its 10-card limit, unresolved cards and non-deck card types (CR 9.2.2.c); its copies are not added to the 3-copy count, and its cards are not checked against the Premier cardpool.",
    premier
      ? "Premier cardpool comes from the expansion definitions in the package (sets marked Premier legal or rotated), not from rotation symbols on cards (CR 9.2.2.d)."
      : "Eternal accepts every released card (CR 9.2.2.d); no set check is made.",
    "Copy limits count one cardKey as one card; different cards that share a name are counted separately.",
    ...(verified.missing.length === 0
      ? []
      : verified.rulesVersion === null
        ? [`No Comprehensive Rules are loaded in this package, so the cited sections (${verified.missing.join(", ")}) are not verified.`]
        : [`Cited Comprehensive Rules sections not found in the loaded rules: ${verified.missing.join(", ")}`]),
  ];

  return ok({
    format: args.format,
    legal: failures.length === 0,
    rulesVersion: verified.rulesVersion,
    leader: leader === undefined ? null : head(leader.row),
    base: base === undefined ? null : head(base.row),
    counts: { mainDeck: mainCopies, minimum, maxCopies: MAX_COPIES, distinct: main.length, listedCopies, ...(sideboardCopies === undefined ? {} : { sideboard: sideboardCopies }) },
    failures,
    warnings,
    dataLimits,
  });
}

// ---------------------------------------------------------------------------------------------
// suggest_leader_base

export const suggestLeaderBaseShape = {
  decklist: decklistField,
  leader: leaderField.optional().describe("Fix the leader and rank only bases"),
  base: baseField.optional().describe("Fix the base and rank only leaders"),
  limit: z.number().int().min(1).max(50).default(10),
};

export function suggestLeaderBase(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(suggestLeaderBaseShape).parse(input);
  const { lines, unresolved } = resolveList(env, args.decklist, "main");
  if (lines.length === 0) return noCards(unresolved);
  const fixedLeader = args.leader === undefined ? undefined : resolvePiece(env, args.leader, "leader");
  if (typeof fixedLeader === "string") return fail(fixedLeader);
  const fixedBase = args.base === undefined ? undefined : resolvePiece(env, args.base, "base");
  if (typeof fixedBase === "string") return fail(fixedBase);

  const available = (type: "Leader" | "Base", iconsKey: string): SynergyCard[] =>
    env.ctx.cards.filter((c) => {
      const row = env.store.byKey.get(c.cardKey);
      return c.type === type && aspectGroup(c) === iconsKey && row !== undefined && cardScope(env.store, row) !== "rotated";
    });
  const examples = (cards: readonly SynergyCard[]): string => cards.map(cardLabel).sort(compareCodePoints).slice(0, 3).join("; ");

  const combos = env.ctx.combos.filter(
    (c) =>
      (fixedLeader === undefined || c.leader.join("+") === icons(fixedLeader).join("+")) &&
      (fixedBase === undefined || c.base.join("+") === icons(fixedBase).join("+")),
  );
  const ranked = combos
    .map((c) => ({
      combo: c,
      cover: deckCover(lines, c.leader, c.base),
      leaders: available("Leader", c.leader.join("+") || "neutral"),
      bases: available("Base", c.base.join("+") || "neutral"),
    }))
    .filter((r) => r.leaders.length > 0 && r.bases.length > 0)
    .sort((x, y) => x.cover.penalty - y.cover.penalty || compareCodePoints(x.combo.label, y.combo.label));
  const rows = ranked.slice(0, args.limit).map((r) => ({
    leaderIcons: iconText(r.combo.leader),
    baseIcons: iconText(r.combo.base),
    penalty: r.cover.penalty,
    leaders: r.leaders.length,
    leaderExamples: examples(r.leaders),
    bases: r.bases.length,
    baseExamples: examples(r.bases),
    uncovered: r.cover.uncovered
      .slice()
      .sort((a, b) => b.penaltyTotal - a.penaltyTotal || compareCodePoints(a.cardKey, b.cardKey))
      .slice(0, 3)
      .map((u) => `${u.card} x${u.count} (${u.icons})`)
      .join("; "),
  }));
  return ok({
    dataVersion: env.dataVersion,
    cards: sumBy(lines, (l) => l.count),
    unresolved,
    combinations: ranked.length,
    penaltyFree: ranked.filter((r) => r.cover.penalty === 0).length,
    note: "ranked by total aspect penalty (+2 resources per uncovered icon, per copy); leaders and bases that rotated out of Premier are left out; leader abilities are not modelled",
    shown: rows.length,
    pairs: rows,
  });
}

// ---------------------------------------------------------------------------------------------
// playable_cards

export const playableCardsShape = {
  leader: leaderField,
  base: baseField,
  decklist: decklistField
    .optional()
    .describe("A partial pile: cards already at 3 copies are skipped, and emptyCostsOnly looks at its curve"),
  costs: z.array(z.number().int().min(0).max(20)).max(21).optional().describe("Only these costs"),
  emptyCostsOnly: z.boolean().default(false).describe("Only costs the partial pile holds no card at"),
  includeUnplayed: z
    .boolean()
    .default(false)
    .describe("Ranked by leader: also list cards the leader's decks do not play (leaderInclusion null), after the played ones in each cost; default false drops them"),
  tag: z.string().min(1).optional().describe("Only cards carrying this offers: or wants: tag, for example offers:draw"),
  maxPenalty: z.number().int().min(0).default(0).describe("Highest aspect penalty to allow; 0 means every icon is supplied"),
  perCost: z.number().int().min(1).max(20).default(3),
  limit: z.number().int().min(1).max(200).default(30).describe("Most rows listed besides staples (leader mode); a staple is always listed and does not count"),
  rankBy: z
    .enum(["leader", "score"])
    .optional()
    .describe(
      "leader (the default when the package holds leader-cards data for this leader): within a cost, cards this leader's tournament decks play most first, then play-calibrated score; score: play-calibrated score only",
    ),
};

export function playableCards(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(playableCardsShape).parse(input);
  const pair = resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const partial = args.decklist === undefined ? { lines: [], unresolved: [], copies: 0 } : resolveList(env, args.decklist, "main");
  const supplied = suppliedBy(pair);
  const locks = lockSupply(pair.leader.syn, pair.base.syn, partial.lines.map((l) => l.syn));
  const lockOf = new Map<string, ClauseLock>();
  const lockedRank = (cardKey: string | null): number => Number(cardKey !== null && isLocked(lockOf.get(cardKey) ?? { baseLocked: [], needsUnitAspect: [] }));
  const held = new Map(partial.lines.map((l) => [l.syn.cardKey, l.count]));
  const heldCosts = new Set(partial.lines.map((l) => l.syn.structured.cost));
  const leaderData = leaderDataFor(env, pair);
  const rankedBy = leaderData !== null && args.rankBy !== "score" ? "leader" : "score";
  const inclusionOf = (cardKey: string): number | null => leaderData?.byCard.get(cardKey)?.inclusion ?? null;
  // D60: a staple the maxPenalty filter drops is listed apart with its penalty, never silently hidden.
  const penalisedStaples: { cardKey: string; title: string; cost: number; aspects: string; penalty: number; leaderInclusion: number }[] = [];

  const eligible = env.ctx.cards.flatMap((syn) => {
    const cost = syn.structured.cost;
    const row = env.store.byKey.get(syn.cardKey);
    if (row === undefined || cost === null || !MAIN_TYPES.has(syn.type) || cardScope(env.store, row) === "rotated") return [];
    if (args.costs !== undefined && !args.costs.includes(cost)) return [];
    if (args.emptyCostsOnly && heldCosts.has(cost)) return [];
    const remaining = MAX_COPIES - (held.get(syn.cardKey) ?? 0);
    if (remaining <= 0) return [];
    if (args.tag !== undefined && ![...syn.tags.offers, ...syn.tags.wants].some((t) => t.tag === args.tag)) return [];
    const penalty = singlePenalty(syn, supplied);
    if (penalty > args.maxPenalty) {
      const inclusion = rankedBy === "leader" ? inclusionOf(syn.cardKey) : null;
      if (inclusion !== null && inclusion >= LEADER_STAPLE_INCLUSION) {
        penalisedStaples.push({ cardKey: syn.cardKey, title: cardLabel(syn), cost, aspects: aspectGroup(syn), penalty, leaderInclusion: inclusion });
      }
      return [];
    }
    const lock = clauseLock(syn, locks);
    lockOf.set(syn.cardKey, lock);
    return [
      {
        cardKey: syn.cardKey,
        title: cardLabel(syn),
        type: syn.type,
        cost,
        aspects: aspectGroup(syn),
        penalty,
        ...(penalty > 0 ? { penalised: true } : {}),
        playCalibrated: env.scores.get(syn.cardKey)?.playCalibrated ?? null,
        ...(leaderData === null ? {} : { leaderInclusion: inclusionOf(syn.cardKey) }),
        price: priceOf(env, syn.cardKey),
        remainingCopies: remaining,
        ...lockFields(lock),
      },
    ];
  });
  const dropUnplayed = rankedBy === "leader" && !args.includeUnplayed;
  const isStaple = (r: { cardKey: string }): boolean => rankedBy === "leader" && (inclusionOf(r.cardKey) ?? 0) >= LEADER_STAPLE_INCLUSION;
  // Decision D45, D50: the floor drops a card the leader's decks play in under 2% (or never) from the listing.
  const everPlayed = dropUnplayed ? eligible.filter((r) => (inclusionOf(r.cardKey) ?? 0) >= LEADER_INCLUSION_FLOOR) : eligible;
  const costsWithCards = new Set(eligible.map((r) => r.cost));
  const playedCosts = new Set(everPlayed.map((r) => r.cost));
  const everSeen = new Set(eligible.filter((r) => inclusionOf(r.cardKey) !== null).map((r) => r.cost));
  const allCosts = [...new Set([...(args.costs ?? []), ...costsWithCards])].sort((a, b) => a - b);
  // Decision D50: with emptyCostsOnly, only a cost the leader's lists use (0.5 mean copies in total) is reported as empty.
  const usedCosts = dropUnplayed && args.emptyCostsOnly ? leaderUsedCosts(env, leaderData) : null;
  const unusedCosts = usedCosts === null ? [] : allCosts.filter((c) => !usedCosts.has(c) && !heldCosts.has(c));
  const reported = (cost: number): boolean => usedCosts === null || usedCosts.has(cost);
  const played = everPlayed.filter((r) => reported(r.cost));
  played.sort(
    (a, b) =>
      a.cost - b.cost ||
      // D59: within a cost a card whose clause this leader, base and deck cannot meet follows the cards that can be played as printed.
      lockedRank(a.cardKey) - lockedRank(b.cardKey) ||
      (rankedBy === "leader" ? numberOr(inclusionOf(b.cardKey), -1) - numberOr(inclusionOf(a.cardKey), -1) : 0) ||
      numberOr(b.playCalibrated, -Infinity) - numberOr(a.playCalibrated, -Infinity) ||
      a.penalty - b.penalty ||
      compareCodePoints(a.cardKey, b.cardKey),
  );
  const emptyCosts = dropUnplayed ? allCosts.filter((c) => !playedCosts.has(c) && !everSeen.has(c) && reported(c) && !(args.emptyCostsOnly && heldCosts.has(c))) : [];
  const thinList = dropUnplayed ? allCosts.filter((c) => !playedCosts.has(c) && everSeen.has(c) && reported(c)) : [];
  const rows = [
    ...played,
    ...(args.emptyCostsOnly ? [...emptyCosts.map((c) => noPlayedRow(c, false)), ...thinList.map((c) => noPlayedRow(c, true))] : []),
  ]
    .map((r) => withStaple(r, rankedBy === "leader", r.cardKey !== null && isStaple({ cardKey: r.cardKey })))
    .sort((a, b) => a.cost - b.cost);
  const perCost = new Map<number, number>();
  let others = 0;
  // Decision D51: a staple is always listed and spends neither perCost nor limit; limit caps the other rows.
  const shown = rows.filter((r) => {
    if (r.staple === true) return true;
    const n = perCost.get(r.cost) ?? 0;
    perCost.set(r.cost, n + 1);
    if (n >= args.perCost || others >= args.limit) return false;
    others++;
    return true;
  });
  return ok({
    dataVersion: env.dataVersion,
    leader: head(pair.leader.row),
    base: head(pair.base.row),
    suppliedIcons: iconText(supplied),
    unresolved: partial.unresolved,
    rankedBy,
    leaderSource:
      leaderData === null
        ? null
        : { population: leaderData.entry.population, fallback: leaderData.entry.fallback, decks: leaderData.entry.decks, window: `${leaderData.entry.window.from}..${leaderData.entry.window.to}`, ...selectionFields(leaderData.selection) },
    emptyCosts: emptyCostsText(emptyCosts, thinList, unusedCosts),
    note: playableNote(leaderData?.entry ?? null, rankedBy, args.includeUnplayed, leaderData?.selection),
    matched: played.length,
    shown: shown.length,
    cards: shown,
    ...(penalisedStaples.length === 0
      ? {}
      : {
          penalisedStaples: penalisedStaples
            .sort((a, b) => b.leaderInclusion - a.leaderInclusion || compareCodePoints(a.cardKey, b.cardKey))
            .map((r) => ({ ...r, note: `played by ${Math.round(r.leaderInclusion * 100)}% of the lists but pays +${r.penalty} under this leader and base, above maxPenalty ${args.maxPenalty}` })),
        }),
  });
}

const floorText = (cost: number): string => `no tournament-played card (>= ${LEADER_INCLUSION_FLOOR * 100}%) at cost ${cost}`;

function emptyCostsText(never: readonly number[], thin: readonly number[], unused: readonly number[]): string {
  const parts = [
    ...(never.length === 0 ? [] : [`${never.join(", ")}: no tournament-played card at ${never.length === 1 ? "this cost" : "these costs"}`]),
    ...thin.map(floorText),
    ...(unused.length === 0 ? [] : [`under ${LEADER_COST_MIN_COPIES} mean copies in the leader's lists at ${unused.length === 1 ? "cost" : "costs"} ${unused.join(", ")}`]),
  ];
  return parts.length === 0 ? "none" : `${parts.join("; ")}; includeUnplayed: true lists score-ranked cards`;
}

/** The costs at which the leader's lists hold LEADER_COST_MIN_COPIES mean copies or more, summed over the cards of that cost. */
function leaderUsedCosts(env: DeckEnv, leaderData: { entry: LeaderCardsEntry } | null): ReadonlySet<number> {
  const copies = new Map<number, number>();
  for (const row of leaderData?.entry.cards ?? []) {
    const syn = env.ctx.graph.byKey.get(row.cardKey);
    const cost = syn?.structured.cost ?? null;
    if (syn === undefined || cost === null || !MAIN_TYPES.has(syn.type)) continue;
    copies.set(cost, (copies.get(cost) ?? 0) + row.meanCopies);
  }
  return new Set([...copies].filter(([, n]) => n >= LEADER_COST_MIN_COPIES).map(([cost]) => cost));
}

/** In leader mode every row says whether it is a staple, so the rows keep one shape. */
function withStaple<T extends object>(row: T, leaderMode: boolean, staple: boolean): T & { staple?: boolean } {
  return leaderMode ? { ...row, staple } : row;
}

/** The row that stands in for a cost the leader's decks never play, so a gap reads as a gap and not as a filled cost. */
function noPlayedRow(cost: number, thin: boolean) {
  return {
    cardKey: null,
    title: `${thin ? floorText(cost) : `no tournament-played card at cost ${cost}`}; includeUnplayed: true lists score-ranked cards`,
    type: null,
    cost,
    aspects: null,
    penalty: null,
    playCalibrated: null,
    leaderInclusion: null,
    price: null,
    remainingCopies: null,
  };
}

const playableNote = (entry: LeaderCardsEntry | null, rankedBy: "leader" | "score", includeUnplayed: boolean, selection?: LeaderSelection): string =>
  `${playableRankNote(entry, rankedBy, includeUnplayed, selection)} ${LOCK_NOTE}`;

function playableRankNote(entry: LeaderCardsEntry | null, rankedBy: "leader" | "score", includeUnplayed: boolean, selection?: LeaderSelection): string {
  const score = "play-calibrated score (fitted to Premier inclusion; rank-meaningful only)";
  if (entry === null) return `ranked within each cost by ${score}. Not leader-specific: this package holds no leader-cards data for this leader. Rotated cards are left out.`;
  const capped = entry.cards.length >= LEADER_CARDS_MAX ? ` or below the ${LEADER_CARDS_MAX}-card cap of the leader index` : "";
  const unplayed = `leaderInclusion null = unplayed in this leader's decks${capped}`;
  const source = `this leader's ${entry.population} decklist inclusion (${leaderSourceText(entry, selection)})`;
  const unplayedRule = includeUnplayed
    ? "includeUnplayed: true lists the unplayed cards after the played ones in each cost"
    : `cards the leader's decks play in under ${LEADER_INCLUSION_FLOOR * 100}% of their lists, or not at all, are left out (includeUnplayed: true lists them), and emptyCosts names the costs left with no card; with emptyCostsOnly only a cost where the leader's lists hold at least ${LEADER_COST_MIN_COPIES} mean copies in total is reported, and emptyCosts names the other empty costs in one line`;
  const staples = `a card in ${LEADER_STAPLE_INCLUSION * 100}% or more of the lists is a staple: it is always listed in full, even past perCost and limit (staple: true), and does not count toward perCost or limit, which cap the other rows`;
  return rankedBy === "leader"
    ? `within each cost, ranked by ${source}, then ${score}; leaderInclusion = placement-weighted share of the leader's decks that play the card; ${unplayed}; ${staples}; ${unplayedRule}. Rotated cards are left out.`
    : `ranked within each cost by ${score} (rankBy score); leaderInclusion = ${source}; ${unplayed}. Rotated cards are left out.`;
}

// ---------------------------------------------------------------------------------------------
// fungible_in_deck

export const fungibleInDeckShape = {
  decklist: decklistField,
  leader: leaderField,
  base: baseField,
  perSlot: z.number().int().min(1).max(10).default(3),
  onlyPenalised: z.boolean().default(false).describe("Only slots whose card carries an aspect penalty under this leader and base"),
};

export function fungibleInDeck(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(fungibleInDeckShape).parse(input);
  const pair = resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const { lines, unresolved } = resolveList(env, args.decklist, "main");
  if (lines.length === 0) return noCards(unresolved);
  const supplied = suppliedBy(pair);
  const inDeck = new Set(lines.map((l) => l.syn.cardKey));
  const noRole: string[] = [];
  const slots = lines.flatMap((line) => {
    const penalty = singlePenalty(line.syn, supplied);
    if (args.onlyPenalised && penalty === 0) return [];
    const slot = slotMembers(env, line.syn.cardKey);
    if (slot === null) {
      noRole.push(cardLabel(line.syn));
      return [];
    }
    const substitutes = substituteCandidates(env, line, slot, supplied, inDeck)
      .map((c) => ({ c, penalty: singlePenalty(c.syn, supplied) }))
      .sort(
        (x, y) =>
          x.penalty - y.penalty ||
          y.c.fills - x.c.fills ||
          Math.abs(numberOr(x.c.cost, 99) - numberOr(line.syn.structured.cost, 99)) -
            Math.abs(numberOr(y.c.cost, 99) - numberOr(line.syn.structured.cost, 99)) ||
          compareCodePoints(x.c.syn.cardKey, y.c.syn.cardKey),
      )
      .slice(0, args.perSlot)
      .map(({ c, penalty: p }) => ({
        cardKey: c.syn.cardKey,
        title: cardLabel(c.syn),
        cost: c.cost,
        aspects: aspectGroup(c.syn),
        fills: c.fills,
        penalty: p,
      }));
    return [
      {
        card: cardLabel(line.syn),
        cardKey: line.syn.cardKey,
        count: line.count,
        cost: line.syn.structured.cost,
        aspects: aspectGroup(line.syn),
        penalty,
        roles: slot.roles.join(", "),
        substitutes,
      },
    ];
  });
  return ok({
    dataVersion: env.dataVersion,
    leader: head(pair.leader.row),
    base: head(pair.base.row),
    suppliedIcons: iconText(supplied),
    unresolved,
    noRole,
    note: "substitutes fill the same offers/wants role (tag, type, timing, magnitude, cost band); the least aspect penalty comes first, then the most roles filled (fills counts the card's roles the substitute also fills), then the closest cost. Cards already in the deck and cards outside the Premier pool (no Premier-legal printing) are left out.",
    slots,
  });
}

// ---------------------------------------------------------------------------------------------
// budget_alternatives

export const budgetAlternativesShape = {
  decklist: decklistField,
  maxPrice: z.number().positive().optional().describe("Highest price of a substitute, in US dollars; a card already at or under it is skipped and listed in alreadyUnderCap"),
  minSaving: z.number().positive().default(0.25).describe("Smallest price saving worth listing, in US dollars"),
  leader: leaderField.optional().describe("Give with base to add each substitute's aspect penalty"),
  base: baseField.optional(),
  perSlot: z.number().int().min(1).max(10).default(3),
  candidates: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Cards to weigh whatever the cost band: cardKeys, SET_NNN ids or exact titles. Each is always evaluated against the deck cards it shares a role with and listed under candidates with its price, saving, score and penalty, outsideBand: true when the cost band or arena rules would not have offered it",
    ),
};

type NoAlternativeReason = "no cheaper same-slot card" | `no cheaper same-slot card that ${string}` | `no card ${string}`;

/** Named candidates (cardKey, SET_NNN id or title) as feature records; what does not resolve is listed, never guessed (D55). */
function resolveCandidates(env: DeckEnv, refs: readonly string[] | undefined): { cards: Piece[]; unresolved: Unresolved[] } {
  const cards: Piece[] = [];
  const unresolved: Unresolved[] = [];
  for (const ref of refs ?? []) {
    const hit = resolveRef(env.store, ref, "main");
    const syn = hit.ok ? env.ctx.graph.byKey.get(hit.row.cardKey) : undefined;
    if (hit.ok && syn !== undefined && !cards.some((c) => c.syn.cardKey === syn.cardKey)) cards.push({ row: hit.row, syn });
    else if (!hit.ok) unresolved.push({ card: ref, count: 1, reason: hit.reason, detail: hit.detail });
    else if (syn === undefined) unresolved.push({ card: ref, count: 1, reason: "no feature record", detail: `${hit.row.cardKey} is in the card list but not in the feature file` });
  }
  return { cards, unresolved };
}

export function budgetAlternatives(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(budgetAlternativesShape).parse(input);
  if ((args.leader === undefined) !== (args.base === undefined)) return fail("give both leader and base, or neither");
  const pair = args.leader === undefined || args.base === undefined ? undefined : resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const { lines, unresolved } = resolveList(env, args.decklist, "main");
  if (lines.length === 0) return noCards(unresolved);
  const supplied = pair === undefined ? undefined : suppliedBy(pair);
  const leaderData = pair === undefined ? null : leaderDataFor(env, pair);
  // D60 (#149): a card that readies a leader, or gives a keyword the leader or the deck supplies, keeps that job in its substitutes.
  // D65 (#156): a unit that readies, draws or removes keeps that job too.
  const suppliedKw = suppliedKeywords(pair === undefined ? null : leaderEngineOf(pair.leader.syn), lines.map((l) => l.syn));
  const named = resolveCandidates(env, args.candidates);
  const inDeck = new Set(lines.map((l) => l.syn.cardKey));
  const unpriced: string[] = [];
  const alreadyUnderCap: { card: string; price: number }[] = [];
  const noAlternative: { card: string; price: number; reason: NoAlternativeReason }[] = [];
  const slots = lines.flatMap((line) => {
    const price = priceOf(env, line.syn.cardKey);
    if (price === null) {
      unpriced.push(cardLabel(line.syn));
      return [];
    }
    if (args.maxPrice !== undefined && price <= args.maxPrice) {
      alreadyUnderCap.push({ card: cardLabel(line.syn), price });
      return [];
    }
    const none = (reason: NoAlternativeReason): [] => {
      noAlternative.push({ card: cardLabel(line.syn), price, reason });
      return [];
    };
    if (price < args.minSaving) return none("no cheaper same-slot card");
    const slot = slotMembers(env, line.syn.cardKey);
    if (slot === null) return none("no cheaper same-slot card");
    const slotScore = env.scores.get(line.syn.cardKey)?.playCalibrated ?? null;
    const slotPenalty = supplied === undefined ? null : singlePenalty(line.syn, supplied);
    const roleKeep = roleKeepOf(line.syn, suppliedKw, true);
    const allCandidates = substituteCandidates(env, line, slot, supplied, inDeck);
    const candidates = roleKeep === null ? allCandidates : allCandidates.filter((c) => roleKeep.keptBy(c.syn).length > 0);
    const alternatives = candidates
      .flatMap((c) => {
        if (!sameSlotShape(line.syn, c.syn)) return [];
        const cheaper = priceOf(env, c.syn.cardKey);
        if (cheaper === null || price - cheaper < args.minSaving || (args.maxPrice !== undefined && cheaper > args.maxPrice)) return [];
        const score = env.scores.get(c.syn.cardKey)?.playCalibrated ?? null;
        const penalty = supplied === undefined ? null : singlePenalty(c.syn, supplied);
        if (penalty !== null && slotPenalty !== null && penalty > slotPenalty) return [];
        return [
          {
            cardKey: c.syn.cardKey,
            title: cardLabel(c.syn),
            cost: c.cost,
            aspects: aspectGroup(c.syn),
            fills: c.fills,
            price: cheaper,
            saved: r2(price - cheaper),
            scoreDelta: score === null || slotScore === null ? null : r2(score - slotScore),
            penalty,
            ...(roleKeep === null ? {} : { keepsRole: roleKeep.keptBy(c.syn).join(", ") }),
            ...(leaderData === null ? {} : { leaderInclusion: leaderData.byCard.get(c.syn.cardKey)?.inclusion ?? null }),
          },
        ];
      })
      .sort(
        (a, b) =>
          numberOr(b.leaderInclusion, -1) - numberOr(a.leaderInclusion, -1) ||
          b.fills - a.fills ||
          b.saved - a.saved ||
          numberOr(b.scoreDelta, -Infinity) - numberOr(a.scoreDelta, -Infinity) ||
          compareCodePoints(a.cardKey, b.cardKey),
      )
      .slice(0, args.perSlot);
    if (alternatives.length === 0) {
      if (roleKeep !== null && candidates.length === 0) return none(`no card ${roleKeep.jobs.join(" or ")}`);
      // D65: cards that do the job exist but none is cheaper in the slot's shape; the row names the job it kept.
      if (roleKeep !== null && candidates.some((c) => sameSlotShape(line.syn, c.syn))) return none(`no cheaper same-slot card that ${roleKeep.jobs.join(" or ")}`);
      return none(candidates.some((c) => sameSlotShape(line.syn, c.syn)) ? "no cheaper same-slot card" : "no card within the cost band");
    }
    return [
      {
        card: cardLabel(line.syn),
        cardKey: line.syn.cardKey,
        count: line.count,
        price,
        aspectPenalty: slotPenalty,
        roles: slot.roles.join(", "),
        ...(roleKeep === null ? {} : { job: roleKeep.note }),
        ...(leaderData !== null && !alternatives.some((a) => (a.leaderInclusion ?? 0) >= LEADER_INCLUSION_FLOOR) ? { note: "no tournament-played substitute under the cap" } : {}),
        alternatives,
      },
    ];
  });
  const candidateRows = named.cards.map(({ syn }) => {
    const price = priceOf(env, syn.cardKey);
    const score = env.scores.get(syn.cardKey)?.playCalibrated ?? null;
    const penalty = supplied === undefined ? null : singlePenalty(syn, supplied);
    const forSlots = lines.flatMap((line) => {
      const slot = slotMembers(env, line.syn.cardKey);
      const carried = new Set([...syn.tags.offers, ...syn.tags.wants].map((t) => t.tag));
      const shared = slot?.roles.filter((tag) => carried.has(tag)) ?? [];
      if (slot === null || shared.length === 0 || line.syn.cardKey === syn.cardKey) return [];
      const slotPrice = priceOf(env, line.syn.cardKey);
      const slotScore = env.scores.get(line.syn.cardKey)?.playCalibrated ?? null;
      const roleKeep = roleKeepOf(line.syn, suppliedKw, true);
      return [
        {
          card: cardLabel(line.syn),
          cardKey: line.syn.cardKey,
          saved: price === null || slotPrice === null ? null : r2(slotPrice - price),
          scoreDelta: score === null || slotScore === null ? null : r2(score - slotScore),
          sharedRoles: shared.join(", "),
          outsideBand: !slot.fills.has(syn.cardKey) || !sameSlotShape(line.syn, syn) || !inPremierPool(env.store)(syn.cardKey),
          ...(roleKeep === null ? {} : { keepsRole: roleKeep.keptBy(syn).join(", ") || "none" }),
        },
      ];
    });
    return {
      cardKey: syn.cardKey,
      title: cardLabel(syn),
      type: syn.type,
      cost: syn.structured.cost,
      aspects: aspectGroup(syn),
      price,
      playCalibrated: score,
      penalty,
      ...(inDeck.has(syn.cardKey) ? { inDeck: true } : {}),
      forSlots,
      ...(forSlots.length === 0 ? { note: "shares no offers/wants role with a card in the deck" } : {}),
    };
  });
  return ok({
    dataVersion: env.dataVersion,
    priceImport: { id: env.market.prices.priceImportId, date: env.market.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    note: `Canonical normal prices, US only. A substitute has the card's type, a unit's arena and a cost within 1 of the card it replaces, so a cheap card never stands in for one from a different part of the curve. savingPerCopy is the largest saving of any one listed swap on one copy; totalSaving is the sum over slots of count times that slot's first alternative's saving. scoreDelta is play-calibrated score of the substitute minus the card (rank-meaningful only). ${supplied === undefined ? "No aspect penalty without a leader and base." : "penalty is the substitute's own aspect penalty under this leader and base; only substitutes whose penalty is no higher than the card's own are listed."}${leaderData === null ? "" : ` Substitutes sort by this leader's decklist inclusion first (played before unplayed), then by role fit and saving; a slot with no played substitute (under 2% of the decks) says so; leaderInclusion = ${`this leader's ${leaderData.entry.population} decklist inclusion (${leaderSourceText(leaderData.entry, leaderData.selection)})`}, null = unplayed in this leader's decks.`}`,
    unresolved,
    unpriced,
    alreadyUnderCap,
    noAlternative,
    ...(args.candidates === undefined ? {} : { candidates: candidateRows }),
    ...(named.unresolved.length === 0 ? {} : { unresolvedCandidates: named.unresolved }),
    slotsWithAlternatives: slots.length,
    savingPerCopy: r2(Math.max(0, ...slots.flatMap((s) => s.alternatives.map((a) => a.saved)))),
    totalSaving: r2(sumBy(slots, (s) => s.count * s.alternatives[0].saved)),
    slots,
  });
}

// ---------------------------------------------------------------------------------------------
// price_list

const priceBasis = z.enum(["canonical", "cheapest", "foil"]);
type PriceBasis = z.infer<typeof priceBasis>;

const BASIS_TEXT: Record<PriceBasis, string> = {
  canonical: "the canonical printing's normal price",
  cheapest: "the cheapest printing's normal price",
  foil: "the canonical printing's foil price",
};

function unitPrice(env: DeckEnv, cardKey: string, basis: PriceBasis): number | null {
  return basis === "cheapest" ? cheapestPrice(env, cardKey) : priceOf(env, cardKey, basis === "foil" ? "foil" : "normal");
}

const fieldOf = (row: CardRow, key: string): string => {
  const value = row[key];
  return typeof value === "string" && value !== "" ? value : "unknown";
};

const GROUPS = ["none", "set", "rarity", "aspect", "type"] as const;

export const priceListShape = {
  items: cardList("Cards as {card, count}: a deck, a collection or a wishlist; leaders and bases are allowed"),
  basis: priceBasis.default("canonical").describe(
    `Which price counts: ${Object.entries(BASIS_TEXT)
      .map(([k, v]) => `${k} is ${v}`)
      .join("; ")}`,
  ),
  groupBy: z.enum(GROUPS).default("none").describe("set is the card's first printing set"),
  topN: z.number().int().min(1).max(50).default(5).describe("Report the share of the total held by the N dearest lines"),
  lineLimit: z.number().int().min(1).max(250).default(50).describe("Most lines listed, dearest first"),
};

function priceLines(env: DeckEnv, lines: readonly DeckLine[], basis: PriceBasis) {
  const priced = lines.flatMap((l) => {
    const unit = unitPrice(env, l.syn.cardKey, basis);
    return unit === null ? [] : [{ line: l, unit, total: r2(unit * l.count) }];
  });
  const unpriced = lines.filter((l) => unitPrice(env, l.syn.cardKey, basis) === null);
  return { priced, unpriced };
}

export function priceList(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(priceListShape).parse(input);
  const { lines, unresolved } = resolveList(env, args.items, "any");
  if (lines.length === 0) return noCards(unresolved);
  const { priced, unpriced } = priceLines(env, lines, args.basis);
  const total = r2(sumBy(priced, (p) => p.total));
  const sorted = [...priced].sort((a, b) => b.total - a.total || compareCodePoints(a.line.syn.cardKey, b.line.syn.cardKey));
  const groupKey = (row: CardRow): string => {
    switch (args.groupBy) {
      case "set":
        return fieldOf(row, "firstSet");
      case "rarity":
        return fieldOf(row, "rarity");
      case "aspect":
        return (row.aspects ?? "").split("|").join("+") || "neutral";
      case "type":
        return row.type;
      default:
        return "all";
    }
  };
  const groups = new Map<string, { cards: number; total: number }>();
  for (const p of priced) {
    const key = groupKey(p.line.row);
    const g = groups.get(key) ?? { cards: 0, total: 0 };
    g.cards += p.line.count;
    g.total += p.total;
    groups.set(key, g);
  }
  const top = sorted.slice(0, args.topN);
  return ok({
    priceImport: { id: env.market.prices.priceImportId, date: env.market.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    coverage: env.market.prices.coverage,
    basis: BASIS_TEXT[args.basis],
    total,
    cards: sumBy(lines, (l) => l.count),
    pricedCards: sumBy(priced, (p) => p.line.count),
    unresolved,
    unpriced: unpriced.map((l) => ({ card: cardLabel(l.syn), cardKey: l.syn.cardKey, count: l.count })),
    top: { n: top.length, total: r2(sumBy(top, (p) => p.total)), share: total > 0 ? r4(sumBy(top, (p) => p.total) / total) : null },
    ...(args.groupBy === "none"
      ? {}
      : {
          groupBy: args.groupBy,
          groups: [...groups.entries()]
            .map(([group, g]) => ({ group, cards: g.cards, total: r2(g.total), share: total > 0 ? r4(g.total / total) : null }))
            .sort((a, b) => b.total - a.total || compareCodePoints(a.group, b.group)),
        }),
    linesShown: Math.min(sorted.length, args.lineLimit),
    lines: sorted
      .slice(0, args.lineLimit)
      .map((p) => ({ card: cardLabel(p.line.syn), cardKey: p.line.syn.cardKey, count: p.line.count, unit: p.unit, total: p.total })),
  });
}

// ---------------------------------------------------------------------------------------------
// trade_balance

export const tradeBalanceShape = {
  sideA: cardList("Cards on side A as {card, count}"),
  sideB: cardList("Cards on side B as {card, count}"),
  finish: z.enum(["normal", "foil"]).default("normal").describe("Which price of the canonical printing counts as market"),
};

function side(env: DeckEnv, entries: readonly z.infer<typeof deckLineSchema>[], finish: "normal" | "foil") {
  const { lines, unresolved } = resolveList(env, entries, "any");
  const priced = lines.map((l) => ({ line: l, market: priceOf(env, l.syn.cardKey, finish), low: cheapestPrice(env, l.syn.cardKey, finish) }));
  const unpriced = priced.filter((p) => p.market === null || p.low === null);
  const scored = lines.filter((l) => env.scores.get(l.syn.cardKey)?.playCalibrated != null);
  return {
    unresolved,
    summary: {
      cards: sumBy(lines, (l) => l.count),
      market: r2(sumBy(priced, (p) => (p.market ?? 0) * p.line.count)),
      low: r2(sumBy(priced, (p) => (p.low ?? 0) * p.line.count)),
      rubric: r2(sumBy(scored, (l) => (env.scores.get(l.syn.cardKey)?.playCalibrated as number) * l.count)),
      unpriced: unpriced.map((p) => cardLabel(p.line.syn)),
      unscored: lines.length - scored.length,
    },
  };
}

const favours = (diff: number): string => (diff > 0 ? "A holds more" : diff < 0 ? "B holds more" : "even");

export function tradeBalance(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(tradeBalanceShape).parse(input);
  const a = side(env, args.sideA, args.finish);
  const b = side(env, args.sideB, args.finish);
  if (a.summary.cards === 0 && b.summary.cards === 0) return noCards([...a.unresolved, ...b.unresolved]);
  const diff = {
    market: r2(a.summary.market - b.summary.market),
    low: r2(a.summary.low - b.summary.low),
    rubric: r2(a.summary.rubric - b.summary.rubric),
  };
  return ok({
    dataVersion: env.dataVersion,
    priceImport: { id: env.market.prices.priceImportId, date: env.market.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    note: "market is the canonical printing's price, low is the cheapest printing's price (US TCGplayer only). rubric sums play-calibrated scores (rank-meaningful only, so read it as a rough guide). Cards without a price count as 0 and are listed.",
    sideA: a.summary,
    sideB: b.summary,
    difference: { ...diff, marketView: favours(diff.market), lowView: favours(diff.low), rubricView: favours(diff.rubric) },
    unresolved: { sideA: a.unresolved, sideB: b.unresolved },
  });
}

// ---------------------------------------------------------------------------------------------
// owned_vs_needed

export const ownedVsNeededShape = {
  decklist: decklistField,
  owned: cardList("Cards already owned as {card, count}; nothing is stored"),
  leader: leaderField.optional().describe("Give with base to add each owned substitute's aspect penalty"),
  base: baseField.optional(),
};

export function ownedVsNeeded(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(ownedVsNeededShape).parse(input);
  if ((args.leader === undefined) !== (args.base === undefined)) return fail("give both leader and base, or neither");
  const pair = args.leader === undefined || args.base === undefined ? undefined : resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const need = resolveList(env, args.decklist, "main");
  if (need.lines.length === 0) return noCards(need.unresolved);
  const have = resolveList(env, args.owned, "any");
  const supplied = pair === undefined ? undefined : suppliedBy(pair);
  const ownedCount = new Map(have.lines.map((l) => [l.syn.cardKey, l.count]));
  const neededCount = new Map(need.lines.map((l) => [l.syn.cardKey, l.count]));
  const spare = (cardKey: string): number => (ownedCount.get(cardKey) ?? 0) - (neededCount.get(cardKey) ?? 0);

  const unpriced: string[] = [];
  const missing = need.lines.flatMap((line) => {
    const owns = ownedCount.get(line.syn.cardKey) ?? 0;
    const short = Math.max(0, line.count - owns);
    if (short === 0) return [];
    const unit = cheapestPrice(env, line.syn.cardKey);
    if (unit === null) unpriced.push(cardLabel(line.syn));
    const slot = slotMembers(env, line.syn.cardKey);
    const substitutes =
      slot === null
        ? []
        : [...slot.fills.entries()]
            .filter(([key]) => spare(key) > 0 && env.ctx.graph.byKey.get(key)?.title !== line.syn.title)
            .map(([key, fills]) => ({ syn: env.ctx.graph.byKey.get(key) as SynergyCard, fills }))
            .map(({ syn, fills }) => ({
              cardKey: syn.cardKey,
              title: cardLabel(syn),
              spareCopies: spare(syn.cardKey),
              cost: syn.structured.cost,
              aspects: aspectGroup(syn),
              fills,
              penalty: supplied === undefined ? null : singlePenalty(syn, supplied),
            }))
            .sort((x, y) => y.fills - x.fills || numberOr(x.penalty, 0) - numberOr(y.penalty, 0) || compareCodePoints(x.cardKey, y.cardKey))
            .slice(0, 5);
    return [
      {
        card: cardLabel(line.syn),
        cardKey: line.syn.cardKey,
        needed: line.count,
        owned: owns,
        missing: short,
        unit,
        lineCost: unit === null ? null : r2(unit * short),
        ownedSubstitutes: substitutes,
      },
    ];
  });
  return ok({
    dataVersion: env.dataVersion,
    priceImport: { id: env.market.prices.priceImportId, date: env.market.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    note: "unit is the cheapest printing's normal price (US TCGplayer only). Owned substitutes are owned cards, beyond the copies the deck itself needs, that fill the same offers/wants role.",
    complete: missing.length === 0,
    neededCopies: need.copies,
    missingCopies: sumBy(missing, (m) => m.missing),
    costToComplete: r2(sumBy(missing, (m) => m.lineCost ?? 0)),
    unresolved: { decklist: need.unresolved, owned: have.unresolved },
    unpriced,
    missing,
  });
}

// ---------------------------------------------------------------------------------------------
// play_value_vs_price and score_vs_play

const playWindowField = z.string().min(1).optional().describe("A capture window id such as w29-55; omit for the widest");

function pickWindow(env: DeckEnv, id: string | undefined): MarketData["play"]["windows"][number] | string {
  const windows = env.market.play.windows;
  if (id !== undefined) {
    return windows.find((w) => w.id === id) ?? `no window ${id}; available: ${windows.map((w) => w.id).join(", ")}`;
  }
  const widest = [...windows].sort((a, b) => b.playerGames - a.playerGames || compareCodePoints(a.id, b.id))[0];
  return widest ?? "the play capture holds no windows";
}

const windowInfo = (env: DeckEnv, w: MarketData["play"]["windows"][number]) => ({
  window: w.id,
  startDate: w.startDate,
  endDate: w.endDate,
  playerGames: w.playerGames,
  source: env.market.play.source,
  note: env.market.play.note,
});

export const playValueVsPriceShape = {
  direction: z
    .enum(["cheap", "dear"])
    .default("cheap")
    .describe("cheap: most played per dollar (hidden gems); dear: least played per dollar (overpriced)"),
  window: playWindowField,
  minSampleSize: z.number().int().min(1).default(100).describe("Fewest games a card was included in"),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().positive().optional(),
  includeLeadersAndBases: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(20),
};

export function playValueVsPrice(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(playValueVsPriceShape).parse(input);
  const window = pickWindow(env, args.window);
  if (typeof window === "string") return fail(window);
  const rows = env.market.play.cards.flatMap((entry) => {
    const cell = entry.byWindow[window.id];
    const row = env.store.byKey.get(entry.cardKey);
    const price = priceOf(env, entry.cardKey);
    if (cell === undefined || row === undefined || price === null || price <= 0 || cell.included < args.minSampleSize) return [];
    if (!args.includeLeadersAndBases && (row.type === "Leader" || row.type === "Base")) return [];
    if ((args.minPrice !== undefined && price < args.minPrice) || (args.maxPrice !== undefined && price > args.maxPrice)) return [];
    const inclusionRate = cell.included / window.playerGames;
    return [
      {
        cardKey: entry.cardKey,
        title: cardLabel(row),
        type: row.type,
        included: cell.included,
        inclusionRate: r6(inclusionRate),
        winShare: r4(cell.wins / cell.included),
        price,
        inclusionPerDollar: r4(inclusionRate / price),
      },
    ];
  });
  const sign = args.direction === "cheap" ? -1 : 1;
  rows.sort((a, b) => sign * (a.inclusionPerDollar - b.inclusionPerDollar) || compareCodePoints(a.cardKey, b.cardKey));
  return ok({
    ...windowInfo(env, window),
    priceImport: { id: env.market.prices.priceImportId, date: env.market.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    caveat:
      "Online play, not tournament data, and US prices. Price is driven mostly by rarity, so cheap commons dominate the cheap list; inclusionPerDollar is inclusionRate divided by canonical normal price. No scorer is involved.",
    direction: args.direction,
    matched: rows.length,
    shown: Math.min(rows.length, args.limit),
    cards: rows.slice(0, args.limit),
  });
}

export const scoreVsPlayShape = {
  direction: z
    .enum(["underplayed", "overplayed"])
    .default("underplayed")
    .describe("underplayed: score rank well above play rank; overplayed: the reverse"),
  score: z
    .enum(["total", "playCalibrated"])
    .default("total")
    .describe("total is the designer rubric; playCalibrated is fitted to the same inclusion data, so its gap is partly circular"),
  window: playWindowField,
  minSampleSize: z.number().int().min(1).default(10000).describe("Fewest player-games the window must hold"),
  type: z.enum(["Unit", "Event", "Upgrade"]).optional(),
  set: z
    .string()
    .min(1)
    .optional()
    .describe("Set the rubric assigns the card to; narrows out cards that were not yet released for the whole window"),
  limit: z.number().int().min(1).max(200).default(20),
};

/** Share of values at or below each value, 0 to 100. */
function percentRanks(values: readonly number[]): (value: number) => number {
  const sorted = [...values].sort((a, b) => a - b);
  return (value) => (100 * countAtOrBelow(sorted, value)) / sorted.length;
}

export function scoreVsPlay(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(scoreVsPlayShape).parse(input);
  const window = pickWindow(env, args.window);
  if (typeof window === "string") return fail(window);
  if (window.playerGames < args.minSampleSize)
    return fail(`window ${window.id} holds ${window.playerGames} player-games, under minSampleSize ${args.minSampleSize}`);
  const playByKey = env.market.playByKey;
  const pool = [...env.scores.values()].flatMap((score) => {
    const value = args.score === "total" ? score.total : score.playCalibrated;
    const row = env.store.byKey.get(score.cardKey);
    if (!score.scored || value === null || row === undefined || !MAIN_TYPES.has(score.type) || cardScope(env.store, row) === "rotated")
      return [];
    if (args.type !== undefined && score.type !== args.type) return [];
    if (args.set !== undefined && lower(score.set) !== lower(args.set)) return [];
    const included = playByKey.get(score.cardKey)?.byWindow[window.id]?.included ?? 0;
    return [{ score, row, value, included, inclusionRate: included / window.playerGames }];
  });
  const byType = new Map<string, typeof pool>();
  for (const p of pool) {
    const bucket = byType.get(p.score.type);
    if (bucket === undefined) byType.set(p.score.type, [p]);
    else bucket.push(p);
  }
  const rows = [...byType.values()].flatMap((group) => {
    const scoreRank = percentRanks(group.map((g) => g.value));
    const playRank = percentRanks(group.map((g) => g.inclusionRate));
    return group.map((g) => {
      const scorePct = scoreRank(g.value);
      const playPct = playRank(g.inclusionRate);
      return {
        cardKey: g.score.cardKey,
        title: cardLabel(g.row),
        type: g.score.type,
        set: g.score.set,
        score: r2(g.value),
        scorePercentile: round(scorePct, 1),
        included: g.included,
        inclusionRate: r6(g.inclusionRate),
        playPercentile: round(playPct, 1),
        residual: round(scorePct - playPct, 1),
      };
    });
  });
  const sign = args.direction === "underplayed" ? -1 : 1;
  rows.sort((a, b) => sign * (a.residual - b.residual) || compareCodePoints(a.cardKey, b.cardKey));
  return ok({
    ...windowInfo(env, window),
    dataVersion: env.dataVersion,
    scoreUsed: args.score,
    caution:
      args.score === "playCalibrated"
        ? "playCalibrated weights are fitted to this same Premier inclusion data, so the residual is partly circular."
        : "total is the designer rubric and is not fitted to play; the playCalibrated score (fitted to inclusion) is not used here.",
    caveat:
      "residual is the card's percentile among same-type cards by score minus its percentile by inclusion rate. A card absent from the capture counts as 0 inclusions, and cards released after the window began look underplayed.",
    direction: args.direction,
    matched: rows.length,
    shown: Math.min(rows.length, args.limit),
    cards: rows.slice(0, args.limit),
  });
}

// ---------------------------------------------------------------------------------------------
// registration

function withEnv(store: CardStore, run: (env: DeckEnv) => ToolResult): ToolResult {
  try {
    return run(deckEnvOf(store));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }
}

const tool = (title: string, description: string, shape: z.ZodRawShape, run: (env: DeckEnv, input: unknown) => ToolResult) => ({
  title,
  description,
  shape,
  handler: (store: CardStore, input: unknown): ToolResult => withEnv(store, (env) => run(env, input)),
});

/** A tool that takes a deck: the swudb argument stands in for decklist, leader and base, which then turn optional in the registered shape. */
const deckTool = (title: string, description: string, shape: z.ZodRawShape, run: (env: DeckEnv, input: unknown) => ToolResult) => {
  const relaxed = Object.fromEntries(Object.entries(shape).map(([key, field]) => [key, key in FORM_FIELDS ? (field as z.ZodType).optional() : field]));
  const accepting = (env: DeckEnv, input: unknown): ToolResult => {
    const expanded = expandSwudb(input);
    return "error" in expanded ? fail(expanded.error) : run(env, expanded.input);
  };
  return tool(title, description, { ...relaxed, swudb: swudbField }, accepting);
};
const FORM_FIELDS: Record<string, true> = { decklist: true, leader: true, base: true };

export const DECK_TOOLS = {
  deck_audit: deckTool(
    "Deck audit",
    "One-call report on a decklist under a leader and base: size and types, cost curve against the rubric's fitted stat curve, mean score, aspect penalty per card (+2 resources per uncovered icon, per copy), orphan wants (cards that want what nothing in the deck offers; a wide-board want counts as fed once the deck holds the units its clause asks for, 3 when it names no number) and role-cluster gaps. Decklist is {card, count} with a cardKey or exact title; unresolved names are listed. A swudb sideboard is listed under sideboard with a row per card, apart from the deck. Or give the whole deck as swudb, the SWUDB JSON interchange document (SWUDB, melee.gg, Karabast and SWU Stats exports, ids like HMW_018), instead of decklist, leader and base. A card whose clause needs a base location or a unit aspect the leader, base and deck do not supply is listed under lockedCards with the lock named (baseLocked, needsUnitAspect), and such feeders follow the open ones. When the leader's decklists hold a per-base split (D60), they are narrowed to the lists with the given base (or its aspect) when at least 10 remain; otherwise all of them are used and one line (populationNote) names the counts and the dominant base. A staple that pays an aspect penalty under this leader and base is marked (penalty, penalised: true), never hidden.",
    deckAuditShape,
    deckAudit,
  ),
  deck_legality_check: deckTool(
    "Deck legality check",
    `Checks a list against Comprehensive Rules v8.0 deck construction: exactly 1 leader and 1 base and at least 50 other cards (CR ${CR.deckContents}), at most 3 copies of a card (CR ${CR.premierCopies}, ${CR.copyLimit}), no tokens (CR ${CR.tokens}), base text that changes the minimum deck size (CR ${CR.baseOverride}) and the Premier cardpool (CR ${CR.cardpool}). Lists failing cards with the section id. Data limits: no ban or suspension ledger, no asOf date; a sideboard (swudb) is checked for its 10-card limit only.${" Or give the whole deck as swudb, the SWUDB JSON interchange document (SWUDB, melee.gg, Karabast and SWU Stats exports, ids like HMW_018), instead of decklist, leader and base."}`,
    deckLegalityShape,
    deckLegalityCheck,
  ),
  suggest_leader_base: tool(
    "Suggest leader and base",
    "Leader and base aspect pairs that leave the fewest uncovered icons for a pile of cards (+2 resources per uncovered icon, per copy), with leader and base examples for each pair. Fix the leader or the base to rank only the other. Rotated-out leaders and bases are left out.",
    suggestLeaderBaseShape,
    suggestLeaderBase,
  ),
  playable_cards: deckTool(
    "Playable cards",
    "The best cards for a leader and base: Unit, Event and Upgrade cards within an aspect penalty limit (default none), ranked within each cost by how many of this leader's tournament decklists play the card (leaderInclusion, with the population and window named), then by play-calibrated score; rankBy score, or a package without leader data, ranks by score alone. In leader mode a card in 60% or more of the leader's decks is a staple: always listed in full, even past perCost and limit (staple: true); limit caps the other rows. A card played in under 2% of the decks, or never, is left out unless includeUnplayed is true, and emptyCosts names a cost left with no played card; with emptyCostsOnly only a cost where the leader's lists hold at least 0.5 mean copies is reported, and emptyCosts names the other empty costs in one line. Give a partial decklist to skip cards already at 3 copies and, with emptyCostsOnly, to fill the costs it lacks. Or give the deck as swudb (the SWUDB JSON interchange document) instead of leader, base and decklist. A card whose clause needs a base location or a unit aspect the leader, base and decklist do not supply carries baseLocked or needsUnitAspect and follows the other cards of its cost. When the leader's decklists hold a per-base split (D60), they are narrowed to the lists with the given base (or its aspect) when at least 10 remain; otherwise all of them are used and one line (populationNote) names the counts and the dominant base. A staple that pays an aspect penalty under this leader and base is marked (penalty, penalised: true), never hidden. A staple that maxPenalty drops is listed apart under penalisedStaples with its penalty.",
    playableCardsShape,
    playableCards,
  ),
  fungible_in_deck: deckTool(
    "Fungible substitutes in a deck",
    "For each card of a decklist, cards that fill the same offers/wants role (same tag, type, timing, magnitude and cost band), ordered by least aspect penalty under the given leader and base. Cards already in the deck are left out; slots whose card has no role are listed. Or give the whole deck as swudb, the SWUDB JSON interchange document (SWUDB, melee.gg, Karabast and SWU Stats exports, ids like HMW_018), instead of decklist, leader and base.",
    fungibleInDeckShape,
    fungibleInDeck,
  ),
  budget_alternatives: deckTool(
    "Budget alternatives",
    "Cheaper fungible substitutes for the cards of a decklist: same role, lower canonical US price, with the price saved, the play-calibrated score difference and, with a leader and base, the aspect penalty (never above the replaced card's) and the leader's tournament decklist inclusion (leaderInclusion; most-played substitutes first, and a slot with no played substitute says so). With maxPrice, cards already at or under it are skipped and listed in alreadyUnderCap. A priced deck card with no swap is listed in noAlternative with its price and the reason (no cheaper same-slot card, or no card within the cost band), so every priced card sits in slots, alreadyUnderCap or noAlternative. Cards without a price are listed. Or give the whole deck as swudb, the SWUDB JSON interchange document (SWUDB, melee.gg, Karabast and SWU Stats exports, ids like HMW_018), instead of decklist, leader and base. A card that readies a leader, or gives a keyword the leader or the deck supplies (Ambush, Raid), keeps that job, and so does a unit that readies a unit, draws a card or removes an enemy unit (read from its offers, D65): only substitutes that do the same are offered (keepsRole; job on the slot), and noAlternative says when none does or none is cheaper. Give candidates (cardKeys, SET_NNN ids or titles) to weigh named cards whatever the cost band: each is listed under candidates with its price, saving, score and penalty, outsideBand: true when the cost band or arena rules would not have offered it. When the leader's decklists hold a per-base split (D60), they are narrowed to the lists with the given base (or its aspect) when at least 10 remain; otherwise all of them are used and one line (populationNote) names the counts and the dominant base.",
    budgetAlternativesShape,
    budgetAlternatives,
  ),
  price_list: tool(
    "Price a list",
    "Total US TCGplayer price of a list of cards (deck, collection or wishlist) on the canonical, cheapest-printing or foil price, with the dearest lines, the share held by the top N and optional totals by first set, rarity, aspect or type. The list is an argument and is not stored.",
    priceListShape,
    priceList,
  ),
  trade_balance: tool(
    "Trade balance",
    "Compares two lists of cards by market price (canonical printing), low price (cheapest printing) and summed play-calibrated rubric score, with the difference each way. US prices only; unpriced cards are listed.",
    tradeBalanceShape,
    tradeBalance,
  ),
  owned_vs_needed: deckTool(
    "Owned versus needed",
    "Diffs a decklist against an owned list: missing copies with the cheapest-printing price of each, the cost to complete, and owned spare cards that fill the same role as each missing card. Both lists are arguments and are not stored. Or give the whole deck as swudb, the SWUDB JSON interchange document (SWUDB, melee.gg, Karabast and SWU Stats exports, ids like HMW_018), for decklist, leader and base; owned stays a list.",
    ownedVsNeededShape,
    ownedVsNeeded,
  ),
  play_value_vs_price: tool(
    "Play value versus price",
    "Premier inclusion against price from the pinned SWU Stats capture: cards most played per dollar (cheap, hidden gems) or least played per dollar (dear, overpriced) with a minimum sample, price bounds and capture window. Online play, not tournament data; US prices.",
    playValueVsPriceShape,
    playValueVsPrice,
  ),
  score_vs_play: tool(
    "Score versus play",
    "Cards whose rubric score rank and Premier inclusion rank disagree, as a percentile gap within the card type: underplayed (score high, play low) or overplayed. Uses the designer total by default; the play-calibrated score is fitted to the same inclusion data, so its gap is partly circular and the output says so.",
    scoreVsPlayShape,
    scoreVsPlay,
  ),
} as const;
