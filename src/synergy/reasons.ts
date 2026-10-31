import type { PairGraph } from "./graph.js";
import { offerTargetSide } from "./qualifiers.js";
import type { PairEdge, PairRowHit, SynergyCard } from "./schema.js";

/**
 * @displayName SWU side-aware pair reasons
 * @strategicPurpose A table row's single reason text read wrong when the offer lands on the other side of the
 * board: "Damaging your own unit switches on Grit" was printed for a finisher that wants an enemy unit damaged
 * (LampaGJ/swu-mcp#121).
 * @tacticalObjective Picks the row's `reasonBySide` variant by the target side of the offer clause that made the
 * link, and falls back to the row's `reason`. Tool output only: edges, scores and the data release keep `reason`.
 */

const rowsOf = new WeakMap<PairGraph, ReadonlyMap<string, PairGraph["rows"][number]>>();

function rowById(graph: PairGraph, id: string): PairGraph["rows"][number] | undefined {
  let byId = rowsOf.get(graph);
  if (byId === undefined) {
    byId = new Map(graph.rows.map((r) => [r.id, r]));
    rowsOf.set(graph, byId);
  }
  return byId.get(id);
}

/** The reason for one row hit of an edge, worded for the side the offer actually lands on. */
export function reasonOfHit(graph: PairGraph, e: PairEdge, hit: PairRowHit): string {
  const variants = rowById(graph, hit.row)?.reasonBySide;
  if (variants === undefined) return hit.reason;
  return variants[offerTargetSide(graph.byKey.get(e.a) as SynergyCard, hit.offer)] ?? hit.reason;
}
