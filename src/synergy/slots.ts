import { primaryRows, type PairGraph } from "./graph.js";
import { cmp } from "./order.js";
import type { PairEdge, TrioRecord } from "./schema.js";

/**
 * @displayName SWU slot roles
 * @strategicPurpose Names which offers/wants tag each member of a pair or trio contributes to its
 * links, so fungibility can list substitutes for exactly that role.
 * @tacticalObjective The tag of an edge is its strongest mechanical row (ties broken by row id), so the same
 * edge always names the same role and a trait bonus never does.
 */

export interface SlotRole {
  cardKey: string;
  offers: string[];
  wants: string[];
}

const topRow = (e: PairEdge): PairEdge["rows"][number] =>
  [...primaryRows(e)].sort((x, y) => y.weight - x.weight || cmp(x.row, y.row))[0];

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
    const e = graph.edgeByKey.get(`${a}>${b}`) ?? graph.conditionalByKey.get(`${a}>${b}`);
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

/** Wants a card carries for having any When Played, On Attack or When Defeated ability; nearly every deck feeds them by accident (D86 shares them with find_trios). */
export const GENERIC_TRIGGER_WANTS: ReadonlySet<string> = new Set(["wants:replay-when-played", "wants:extra-attacks", "wants:self-defeated"]);

/** Decision D73: rows that close a trio weakly: a threshold a ramp card only speeds up, and a replay of a unit whose play trigger is small. */
export const WEAK_CLOSING_ROWS: ReadonlySet<string> = new Set(["ramp-threshold", "bounce-replay"]);

/**
 * Whether a link into the trio's payoff (every link of a loop) rests on weak rows alone, so a trio with a mechanical
 * closing payoff ranks before it. A link that also carries any other mechanical row is not weak.
 */
export function hasWeakClosingLink(graph: PairGraph, t: Pick<TrioRecord, "cardA" | "cardB" | "cardC" | "shape">): boolean {
  return trioLinks(graph, t)
    .filter((e) => t.shape === "loop" || e.b === t.cardC)
    .some((e) => {
      const rows = primaryRows(e);
      return rows.length > 0 && rows.every((r) => WEAK_CLOSING_ROWS.has(r.baseId));
    });
}
