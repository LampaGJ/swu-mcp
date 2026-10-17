import { z } from "zod";
import { MissingDataError, splitCell, type CardRow, type CardStore } from "../data.js";
import type { ClustersFile } from "../embed/files.js";
import { rulesFor } from "../rules/store.js";
import type { ScoreRow } from "../scorer/scores-file.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { SynergyContext } from "../synergy/context.js";
import { coverPenalty } from "../synergy/cover.js";
import { aspectGroup, roleOf, substitutesFor } from "../synergy/fungibility.js";
import { cardLabel } from "../synergy/order.js";
import type { PairEdge, SynergyCard } from "../synergy/schema.js";
import type { ToolResult } from "../tools.js";
import { marketData, type MarketData } from "./market.js";
import { similarityData } from "./similarity.js";
import { synergyContextOf } from "./synergy.js";
import { dataVersion, valueData } from "./value.js";
import { ok, fail, lower } from "./common.js";

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
  dataVersion: string;
}

const envs = new WeakMap<CardStore, DeckEnv>();

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

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places || 0;
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

const deckLineSchema = z.strictObject({
  card: z
    .string()
    .min(1)
    .describe("A cardKey (for example 0101033) or an exact card title; 'Title, Subtitle' picks one of several cards that share a title"),
  count: z.number().int().min(1).max(99).default(1),
});

const cardList = (what: string) => z.array(deckLineSchema).min(1).max(250).describe(what);
const decklistField = cardList("Cards as {card, count}; the same card listed twice is added up");
const leaderField = z.string().min(1).describe("The leader: a cardKey or an exact title (with subtitle if the title is shared)");
const baseField = z.string().min(1).describe("The base: a cardKey or an exact title");

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

function resolveRef(store: CardStore, ref: string, kind: Kind): Resolution {
  const direct = store.byKey.get(ref.trim());
  const found = direct !== undefined ? [direct] : (nameIndex(store).get(normalise(ref)) ?? []);
  if (found.length === 0) return { ok: false, reason: "unknown", detail: "no card with this cardKey or title" };
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

function resolveList(env: DeckEnv, entries: readonly z.infer<typeof deckLineSchema>[], kind: Kind): ResolvedList {
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

function resolvePair(env: DeckEnv, leaderRef: string, baseRef: string): { leader: Piece; base: Piece } | string {
  const leader = resolvePiece(env, leaderRef, "leader");
  if (typeof leader === "string") return leader;
  const base = resolvePiece(env, baseRef, "base");
  if (typeof base === "string") return base;
  return { leader, base };
}

const icons = (piece: Piece): string[] => piece.syn.structured.aspectIcons;
const suppliedBy = (pair: { leader: Piece; base: Piece }): string[] => [...icons(pair.leader), ...icons(pair.base)];
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

const MAIN_TYPES = new Set(["Unit", "Event", "Upgrade"]);

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

function cardScope(store: CardStore, row: CardRow): CardScope {
  const scope = premierScope(store);
  const sets = splitCell(row.sets);
  if (scope === null) return "unverified";
  if (sets.some((s) => scope.legal.has(s))) return "legal";
  return sets.length > 0 && sets.every((s) => scope.rotated.has(s)) ? "rotated" : "unverified";
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

const singlePenalty = (syn: SynergyCard, supplied: readonly string[]): number => coverPenalty([syn], supplied, []).penalty;

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
  ];
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

/** Fungible substitutes of one deck card as a flat list: not in the deck, not rotated out of Premier. */
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
  for (const group of groups) {
    for (const sub of group.cards) {
      if (exclude.has(sub.cardKey)) continue;
      const row = env.store.byKey.get(sub.cardKey);
      const syn = env.ctx.graph.byKey.get(sub.cardKey);
      if (row === undefined || syn === undefined || cardScope(env.store, row) === "rotated") continue;
      out.push({ syn, row, cost: sub.cost, fills: slot.fills.get(sub.cardKey) as number });
    }
  }
  return out;
}

const numberOr = (value: number | null | undefined, fallback: number): number => value ?? fallback;

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

const wantsOf = (syn: SynergyCard): string[] =>
  [...new Set(syn.tags.wants.map((t) => t.tag).filter((tag) => !tag.startsWith("wants:trait-")))].sort(compareCodePoints);

export function deckAudit(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(deckAuditShape).parse(input);
  const pair = resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const { lines, unresolved, copies } = resolveList(env, args.decklist, "main");
  if (lines.length === 0) return noCards(unresolved);
  const supplied = suppliedBy(pair);

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
  const orphanWants = lines.flatMap((l) => {
    const wants = wantsOf(l.syn);
    if (wants.length === 0) return [];
    const feeders = into.get(l.syn.cardKey) ?? [];
    if (feeders.some((e) => inDeck.has(e.a) && e.a !== l.syn.cardKey)) return [];
    return [{ card: cardLabel(l.syn), cardKey: l.syn.cardKey, wants: wants.slice(0, 4).join(", "), feedersInCardPool: feeders.length }];
  });

  const clusterGaps = clusterGapRows(env, lines, supplied, args.gapLimit);

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
    orphanWants,
    clusterGaps,
  });
}

/** Clusters over-represented in the penalty-free Premier pool relative to this deck, by the pool's own share. */
function clusterGapRows(env: DeckEnv, lines: readonly DeckLine[], supplied: readonly string[], limit: number): unknown {
  if (env.clusters === null) return { note: "no similarity run in this package, so role clusters are unavailable" };
  const clusterOf = new Map(env.clusters.clusters.flatMap((c) => c.members.map((k) => [k, c.id] as const)));
  const pool = env.ctx.cards.filter((syn) => {
    const row = env.store.byKey.get(syn.cardKey);
    return row !== undefined && MAIN_TYPES.has(syn.type) && cardScope(env.store, row) !== "rotated" && singlePenalty(syn, supplied) === 0;
  });
  const poolCount = new Map<number, number>();
  for (const syn of pool) {
    const id = clusterOf.get(syn.cardKey);
    if (id !== undefined) poolCount.set(id, (poolCount.get(id) ?? 0) + 1);
  }
  const deckCount = new Map<number, number>();
  for (const l of lines) {
    const id = clusterOf.get(l.syn.cardKey);
    if (id !== undefined) deckCount.set(id, (deckCount.get(id) ?? 0) + l.count);
  }
  const mainCopies = sumBy(
    lines.filter((l) => MAIN_TYPES.has(l.row.type)),
    (l) => l.count,
  );
  const labelOf = new Map(env.clusters.clusters.map((c) => [c.id, c.label]));
  const rows = [...poolCount.entries()]
    .map(([id, n]) => {
      const expected = (n / pool.length) * mainCopies;
      const have = deckCount.get(id) ?? 0;
      return {
        clusterId: id,
        label: labelOf.get(id) ?? "",
        deckCards: have,
        expected: r2(expected),
        gap: r2(expected - have),
        poolCards: n,
      };
    })
    .filter((row) => row.gap >= 1)
    .sort((a, b) => b.gap - a.gap || a.clusterId - b.clusterId);
  return {
    norm: `a cluster's share of the ${pool.length} Premier-scope cards this leader and base play penalty-free, scaled to the ${mainCopies} main-deck cards; gap is expected minus held`,
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

  const { lines, unresolved, copies } = resolveList(env, args.decklist, "any");
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
    "The sideboard (up to 10 cards, CR 9.2.2.c) is not checked.",
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
    counts: { mainDeck: mainCopies, minimum, maxCopies: MAX_COPIES, distinct: main.length, listedCopies: copies },
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
  tag: z.string().min(1).optional().describe("Only cards carrying this offers: or wants: tag, for example offers:draw"),
  maxPenalty: z.number().int().min(0).default(0).describe("Highest aspect penalty to allow; 0 means every icon is supplied"),
  perCost: z.number().int().min(1).max(20).default(3),
  limit: z.number().int().min(1).max(200).default(30),
};

export function playableCards(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(playableCardsShape).parse(input);
  const pair = resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const partial = args.decklist === undefined ? { lines: [], unresolved: [], copies: 0 } : resolveList(env, args.decklist, "main");
  const supplied = suppliedBy(pair);
  const held = new Map(partial.lines.map((l) => [l.syn.cardKey, l.count]));
  const heldCosts = new Set(partial.lines.map((l) => l.syn.structured.cost));

  const rows = env.ctx.cards.flatMap((syn) => {
    const cost = syn.structured.cost;
    const row = env.store.byKey.get(syn.cardKey);
    if (row === undefined || cost === null || !MAIN_TYPES.has(syn.type) || cardScope(env.store, row) === "rotated") return [];
    if (args.costs !== undefined && !args.costs.includes(cost)) return [];
    if (args.emptyCostsOnly && heldCosts.has(cost)) return [];
    const remaining = MAX_COPIES - (held.get(syn.cardKey) ?? 0);
    if (remaining <= 0) return [];
    if (args.tag !== undefined && ![...syn.tags.offers, ...syn.tags.wants].some((t) => t.tag === args.tag)) return [];
    const penalty = singlePenalty(syn, supplied);
    if (penalty > args.maxPenalty) return [];
    return [
      {
        cardKey: syn.cardKey,
        title: cardLabel(syn),
        type: syn.type,
        cost,
        aspects: aspectGroup(syn),
        penalty,
        playCalibrated: env.scores.get(syn.cardKey)?.playCalibrated ?? null,
        price: priceOf(env, syn.cardKey),
        remainingCopies: remaining,
      },
    ];
  });
  rows.sort(
    (a, b) =>
      a.cost - b.cost ||
      numberOr(b.playCalibrated, -Infinity) - numberOr(a.playCalibrated, -Infinity) ||
      a.penalty - b.penalty ||
      compareCodePoints(a.cardKey, b.cardKey),
  );
  const perCost = new Map<number, number>();
  const shown = rows
    .filter((r) => {
      const n = perCost.get(r.cost) ?? 0;
      perCost.set(r.cost, n + 1);
      return n < args.perCost;
    })
    .slice(0, args.limit);
  return ok({
    dataVersion: env.dataVersion,
    leader: head(pair.leader.row),
    base: head(pair.base.row),
    suppliedIcons: iconText(supplied),
    unresolved: partial.unresolved,
    note: "ranked within each cost by play-calibrated score (fitted to Premier inclusion; rank-meaningful only). Not leader-specific: no leader-level play data is held. Rotated cards are left out.",
    matched: rows.length,
    shown: shown.length,
    cards: shown,
  });
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
    note: "substitutes fill the same offers/wants role (tag, type, timing, magnitude, cost band); the least aspect penalty comes first, then the most roles filled (fills counts the card's roles the substitute also fills), then the closest cost. Cards already in the deck and rotated cards are left out.",
    slots,
  });
}

// ---------------------------------------------------------------------------------------------
// budget_alternatives

export const budgetAlternativesShape = {
  decklist: decklistField,
  maxPrice: z.number().positive().optional().describe("Highest price of a substitute, in US dollars"),
  minSaving: z.number().positive().default(0.25).describe("Smallest price saving worth listing, in US dollars"),
  leader: leaderField.optional().describe("Give with base to add each substitute's aspect penalty"),
  base: baseField.optional(),
  perSlot: z.number().int().min(1).max(10).default(3),
};

export function budgetAlternatives(env: DeckEnv, input: unknown): ToolResult {
  const args = z.object(budgetAlternativesShape).parse(input);
  if ((args.leader === undefined) !== (args.base === undefined)) return fail("give both leader and base, or neither");
  const pair = args.leader === undefined || args.base === undefined ? undefined : resolvePair(env, args.leader, args.base);
  if (typeof pair === "string") return fail(pair);
  const { lines, unresolved } = resolveList(env, args.decklist, "main");
  if (lines.length === 0) return noCards(unresolved);
  const supplied = pair === undefined ? undefined : suppliedBy(pair);
  const inDeck = new Set(lines.map((l) => l.syn.cardKey));
  const unpriced: string[] = [];
  const slots = lines.flatMap((line) => {
    const price = priceOf(env, line.syn.cardKey);
    if (price === null) {
      unpriced.push(cardLabel(line.syn));
      return [];
    }
    if (price < args.minSaving) return [];
    const slot = slotMembers(env, line.syn.cardKey);
    if (slot === null) return [];
    const slotScore = env.scores.get(line.syn.cardKey)?.playCalibrated ?? null;
    const slotPenalty = supplied === undefined ? null : singlePenalty(line.syn, supplied);
    const alternatives = substituteCandidates(env, line, slot, supplied, inDeck)
      .flatMap((c) => {
        const cheaper = priceOf(env, c.syn.cardKey);
        if (cheaper === null || price - cheaper < args.minSaving || (args.maxPrice !== undefined && cheaper > args.maxPrice)) return [];
        const score = env.scores.get(c.syn.cardKey)?.playCalibrated ?? null;
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
            penalty: supplied === undefined ? null : singlePenalty(c.syn, supplied),
          },
        ];
      })
      .sort(
        (a, b) =>
          b.fills - a.fills ||
          b.saved - a.saved ||
          numberOr(b.scoreDelta, -Infinity) - numberOr(a.scoreDelta, -Infinity) ||
          compareCodePoints(a.cardKey, b.cardKey),
      )
      .slice(0, args.perSlot);
    if (alternatives.length === 0) return [];
    return [
      {
        card: cardLabel(line.syn),
        cardKey: line.syn.cardKey,
        count: line.count,
        price,
        aspectPenalty: slotPenalty,
        roles: slot.roles.join(", "),
        alternatives,
      },
    ];
  });
  return ok({
    dataVersion: env.dataVersion,
    priceImport: { id: env.market.prices.priceImportId, date: env.market.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    note: `Canonical normal prices, US only. scoreDelta is play-calibrated score of the substitute minus the card (rank-meaningful only). ${supplied === undefined ? "No aspect penalty without a leader and base." : "penalty is the substitute's own aspect penalty under this leader and base."}`,
    unresolved,
    unpriced,
    slotsWithAlternatives: slots.length,
    bestSavingPerCopy: r2(sumBy(slots, (s) => s.count * s.alternatives[0].saved)),
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
  const unpriced = lines.filter((l) => priceOf(env, l.syn.cardKey, finish) === null || cheapestPrice(env, l.syn.cardKey, finish) === null);
  const scored = lines.filter((l) => env.scores.get(l.syn.cardKey)?.playCalibrated != null);
  return {
    unresolved,
    summary: {
      cards: sumBy(lines, (l) => l.count),
      market: r2(sumBy(lines, (l) => (priceOf(env, l.syn.cardKey, finish) ?? 0) * l.count)),
      low: r2(sumBy(lines, (l) => (cheapestPrice(env, l.syn.cardKey, finish) ?? 0) * l.count)),
      rubric: r2(sumBy(scored, (l) => (env.scores.get(l.syn.cardKey)?.playCalibrated as number) * l.count)),
      unpriced: unpriced.map((l) => cardLabel(l.syn)),
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
  return (value) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid] <= value) low = mid + 1;
      else high = mid;
    }
    return (100 * low) / sorted.length;
  };
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

export const DECK_TOOLS = {
  deck_audit: tool(
    "Deck audit",
    "One-call report on a decklist under a leader and base: size and types, cost curve against the rubric's fitted stat curve, mean score, aspect penalty per card (+2 resources per uncovered icon, per copy), orphan wants (cards that want what nothing in the deck offers) and role-cluster gaps. Decklist is {card, count} with a cardKey or exact title; unresolved names are listed.",
    deckAuditShape,
    deckAudit,
  ),
  deck_legality_check: tool(
    "Deck legality check",
    `Checks a list against Comprehensive Rules v8.0 deck construction: exactly 1 leader and 1 base and at least 50 other cards (CR ${CR.deckContents}), at most 3 copies of a card (CR ${CR.premierCopies}, ${CR.copyLimit}), no tokens (CR ${CR.tokens}), base text that changes the minimum deck size (CR ${CR.baseOverride}) and the Premier cardpool (CR ${CR.cardpool}). Lists failing cards with the section id. Data limits: no ban or suspension ledger, no asOf date, sideboard not checked.`,
    deckLegalityShape,
    deckLegalityCheck,
  ),
  suggest_leader_base: tool(
    "Suggest leader and base",
    "Leader and base aspect pairs that leave the fewest uncovered icons for a pile of cards (+2 resources per uncovered icon, per copy), with leader and base examples for each pair. Fix the leader or the base to rank only the other. Rotated-out leaders and bases are left out.",
    suggestLeaderBaseShape,
    suggestLeaderBase,
  ),
  playable_cards: tool(
    "Playable cards",
    "The best cards for a leader and base: Unit, Event and Upgrade cards within an aspect penalty limit (default none), ranked within each cost by play-calibrated score. Give a partial decklist to skip cards already at 3 copies and, with emptyCostsOnly, to fill the costs it lacks. Not leader-specific play data.",
    playableCardsShape,
    playableCards,
  ),
  fungible_in_deck: tool(
    "Fungible substitutes in a deck",
    "For each card of a decklist, cards that fill the same offers/wants role (same tag, type, timing, magnitude and cost band), ordered by least aspect penalty under the given leader and base. Cards already in the deck are left out; slots whose card has no role are listed.",
    fungibleInDeckShape,
    fungibleInDeck,
  ),
  budget_alternatives: tool(
    "Budget alternatives",
    "Cheaper fungible substitutes for the cards of a decklist: same role, lower canonical US price, with the price saved, the play-calibrated score difference and, with a leader and base, the aspect penalty. Cards without a price are listed.",
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
  owned_vs_needed: tool(
    "Owned versus needed",
    "Diffs a decklist against an owned list: missing copies with the cheapest-printing price of each, the cost to complete, and owned spare cards that fill the same role as each missing card. Both lists are arguments and are not stored.",
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
