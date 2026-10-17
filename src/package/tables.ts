import type { CardRulingsFile } from "../rules/schemas.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { FlatRow } from "../swu/llm-flatten.js";
import type { FungibilityIndex } from "../synergy/fungibility.js";
import { aspectGroup } from "../synergy/fungibility.js";
import type { PairGraph } from "../synergy/graph.js";
import { edgeOrder, mechanicalRows } from "../synergy/graph.js";
import type { SynergyCard, TrioRecord } from "../synergy/schema.js";
import { TRIO_SHAPES } from "../synergy/schema.js";

/**
 * @displayName Lean package tables
 * @strategicPurpose Manipulation nodes for the reader zip (LampaGJ/swu-mcp#7): each function turns one run
 * output into a compact table for llm/, declared effect noted per function.
 * @tacticalObjective Pure and deterministic. Rows keep the order of their inputs or sort by code point, and
 * numbers are rounded to two decimals so the bytes do not depend on floating-point noise.
 */

const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Columns of cards.toon a reader does not need: image variants derivable from artFront plus a size prefix, and
 * internal ids. The same set the MCP get_card tool hides (src/tools.ts HIDDEN_DETAIL), minus artFront, artist
 * and cardNumber.
 */
export const LEAN_DROP_COLUMNS: ReadonlySet<string> = new Set([
  "artBack",
  "artBackHorizontal",
  "artFrontHorizontal",
  "artThumbnail",
  "cardCount",
  "cardId",
  "cardUid",
  "validationId",
  "locale",
  "hasFoil",
  "hyperspace",
  "showcase",
]);

export interface ScoreCell {
  total: number | null;
  playCalibrated: number | null;
}

/** Declared effect: preserves rows, adds three columns, drops LEAN_DROP_COLUMNS when `lean`. */
export function augmentCards(
  cards: readonly FlatRow[],
  scores: ReadonlyMap<string, ScoreCell>,
  clusterOf: ReadonlyMap<string, number>,
  lean: boolean,
): FlatRow[] {
  return cards.map((card) => {
    const key = String(card.cardKey);
    const score = scores.get(key);
    const kept = Object.fromEntries(Object.entries(card).filter(([column]) => !(lean && LEAN_DROP_COLUMNS.has(column))));
    return {
      ...kept,
      playCalibrated: score?.playCalibrated == null ? null : r2(score.playCalibrated),
      total: score?.total == null ? null : r2(score.total),
      cluster: clusterOf.get(key) ?? null,
    };
  });
}

/** Declared effect: preserves rows, drops the definition column (definitions are shipped once, in the legend). */
export function leanIndexRows(rows: readonly FlatRow[]): FlatRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([column]) => column !== "definition")));
}

export interface LegendEntry {
  kind: string;
  id: string;
  definition: string;
}

export function legendRows(entries: readonly LegendEntry[]): FlatRow[] {
  return [...entries]
    .sort((a, b) => compareCodePoints(a.kind, b.kind) || compareCodePoints(a.id, b.id))
    .map((entry) => ({ kind: entry.kind, id: entry.id, definition: entry.definition }));
}

/** Declared effect: keeps the best `keep` neighbours per card, packed as key:cosine joined by "|", cosine to two decimals. */
export function neighbourRows(cards: Readonly<Record<string, readonly (readonly [string, number])[]>>, keep: number): FlatRow[] {
  return Object.keys(cards)
    .sort(compareCodePoints)
    .map((cardKey) => ({ cardKey, neighbours: cards[cardKey].slice(0, keep).map(([key, cosine]) => `${key}:${r2(cosine).toFixed(2)}`).join("|") }));
}

export function clusterRows(clusters: readonly { id: number; size: number; label: string }[]): FlatRow[] {
  return clusters.map(({ id, size, label }) => ({ id, size, label }));
}

export interface PairingReasons {
  rows: FlatRow[];
  /** Row id to the sentence that explains it, for every row id used. */
  reasons: Map<string, string>;
}

/**
 * Declared effect: reduces. Top `perCard` pairs per card, trait-only pairs excluded and a shared trait only a bonus, ranked as find_pairings ranks
 * with no aspects given (score, then edge order); the reason id is the pair's first mechanical row in table order. A partner cell is `<direction><partnerKey> <rowId> <score>`:
 * ">" means the partner is a payoff this card feeds, "<" means the partner enables this card.
 */
export function pairingRows(graph: PairGraph, perCard: number): PairingReasons {
  const byCard = new Map<string, { edge: PairGraph["edges"][number]; partner: string; direction: ">" | "<" }[]>();
  for (const edge of graph.edges) {
    if (edge.traitOnly) continue;
    const push = (card: string, partner: string, direction: ">" | "<"): void => {
      const list = byCard.get(card) ?? [];
      list.push({ edge, partner, direction });
      byCard.set(card, list);
    };
    push(edge.a, edge.b, ">");
    push(edge.b, edge.a, "<");
  }
  const reasons = new Map<string, string>();
  const rows = [...byCard.keys()].sort(compareCodePoints).map((cardKey) => {
    const list = (byCard.get(cardKey) ?? []).sort((x, y) => edgeOrder(x.edge, y.edge)).slice(0, perCard);
    const cells = list.map(({ edge, partner, direction }) => {
      const row = mechanicalRows(edge)[0];
      reasons.set(row.row, row.reason);
      return `${direction}${partner} ${row.row} ${r2(edge.score)}`;
    });
    return { cardKey, pairs: cells.join("|") };
  });
  return { rows, reasons };
}

/**
 * The row ids of each link in a trio's reasons string ("A -> B: rowId (offer -> want); rowId (...) | B -> C: ..."), links
 * joined by " | ". Card titles are left out because cardA to cardC already name the cards.
 */
export function reasonIds(reasons: string): string {
  const links = reasons.split(" | ").map((link) => [...link.matchAll(/(?:: |; )([a-z0-9-]+) \(/g)].map((match) => match[1]).join(","));
  if (links.some((link) => link === "")) throw new Error(`cannot read row ids from trio reasons: ${reasons}`);
  return links.join(" | ");
}

/** Declared effect: reduces to the first `perShape` trios of each shape with total cost at most `maxCost`; input is already ranked. */
export function trioRows(trios: Readonly<Record<string, readonly TrioRecord[]>>, perShape: number, maxCost: number): FlatRow[] {
  return TRIO_SHAPES.flatMap((shape) =>
    (trios[shape] ?? [])
      .filter((trio) => trio.totalCost <= maxCost)
      .slice(0, perShape)
      .map((trio) => ({
        cardA: trio.cardA,
        cardB: trio.cardB,
        cardC: trio.cardC,
        shape: trio.shape,
        totalCost: trio.totalCost,
        aspectPair: trio.aspectPair,
        penalty: trio.penalty,
        score: r2(trio.score),
        reasons: reasonIds(trio.reasons),
      })),
  );
}

/** Declared effect: reduces to classes with at least two members; members grouped by aspect icons as `Aspect+Aspect=key|key;...`. */
export function fungibleRows(index: FungibilityIndex): FlatRow[] {
  return index.classes
    .filter((cls) => cls.members.length >= 2)
    .map((cls) => {
      const groups = new Map<string, string[]>();
      for (const key of cls.members) {
        const group = aspectGroup(index.byKey.get(key) as SynergyCard);
        groups.set(group, [...(groups.get(group) ?? []), key]);
      }
      const byAspect = [...groups.keys()]
        .sort(compareCodePoints)
        .map((group) => `${group}=${(groups.get(group) as string[]).sort(compareCodePoints).join("|")}`)
        .join(";");
      return { role: cls.id, size: cls.members.length, byAspect };
    })
    .sort((a, b) => compareCodePoints(String(a.role), String(b.role)));
}

/** Declared effect: preserves every ruling, one row each (card titles stay in cards.toon). */
export function rulingRows(file: CardRulingsFile): FlatRow[] {
  return file.cards.flatMap((card) => card.rulings.map((ruling) => ({ cardKey: card.cardKey, date: ruling.date, text: ruling.text })));
}

export function vectorRows(cards: Readonly<Record<string, string>>): FlatRow[] {
  return Object.keys(cards)
    .sort(compareCodePoints)
    .map((cardKey) => ({ cardKey, v: cards[cardKey] }));
}
