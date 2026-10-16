import type { PairGraph } from "./graph.js";
import { cmp } from "./order.js";
import type { PairEdge, TrioRecord } from "./schema.js";

/**
 * @displayName SWU slot roles
 * @strategicPurpose Names which offers/wants tag each member of a pair or trio contributes to its
 * links, so fungibility can list substitutes for exactly that role.
 * @tacticalObjective The tag of an edge is its strongest row (ties broken by row id), so the same
 * edge always names the same role.
 */

export interface SlotRole {
  cardKey: string;
  offers: string[];
  wants: string[];
}

const topRow = (e: PairEdge): PairEdge["rows"][number] => [...e.rows].sort((x, y) => y.weight - x.weight || cmp(x.row, y.row))[0];

/** The pair edges that make up a trio, by shape (convergent: A and B both feed C). */
export function trioLinks(graph: PairGraph, t: Pick<TrioRecord, "cardA" | "cardB" | "cardC" | "shape">): PairEdge[] {
  const pairs: [string, string][] =
    t.shape === "chain"
      ? [
          [t.cardA, t.cardB],
          [t.cardB, t.cardC],
        ]
      : t.shape === "loop"
        ? [
            [t.cardA, t.cardB],
            [t.cardB, t.cardC],
            [t.cardC, t.cardA],
          ]
        : [
            [t.cardA, t.cardC],
            [t.cardB, t.cardC],
          ];
  return pairs.flatMap(([a, b]) => {
    const e = graph.edgeByKey.get(`${a}>${b}`);
    return e === undefined ? [] : [e];
  });
}

export function slotRoles(keys: readonly string[], links: readonly PairEdge[]): SlotRole[] {
  return keys.map((cardKey) => ({
    cardKey,
    offers: [...new Set(links.filter((e) => e.a === cardKey).map((e) => topRow(e).offer))].sort(cmp),
    wants: [...new Set(links.filter((e) => e.b === cardKey).map((e) => topRow(e).want))].sort(cmp),
  }));
}
