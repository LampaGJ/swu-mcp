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

type Loose = Record<string, unknown>;
const PLAYED_UNIT_TRIGGER = /^when you play a unit\b/i;

/**
 * D74 (#161): whether the offer clause readies a unit as it is played ("When you play a unit ...: ready that unit", "The next
 * unit you play ... enters play ready"). The ready-reuse reason ("re-uses its Action [Exhaust] or lets an On Attack unit swing
 * again") misstates that gain: the played unit acts on the turn it enters.
 */
function readiesAsPlayed(card: SynergyCard, why: string): boolean {
  const body = why.replace(/^\w+: /, "").replace(/\s+/g, " ").trim();
  for (const ability of Object.values(card.faces).flat()) {
    const playTrigger = (ability.triggers ?? []).some((t) => PLAYED_UNIT_TRIGGER.test((t.text ?? "").trim()));
    for (const clause of ability.clauses ?? []) {
      if (clause.text.replace(/\s+/g, " ").trim() !== body) continue;
      const effects = clause.effects.filter((x): x is Loose => typeof x === "object" && x !== null);
      if (effects.some((x) => x.rule === "enters_ready" || (playTrigger && x.rule === "ready" && (x.target as Loose | undefined)?.side === "ref"))) return true;
    }
  }
  return false;
}

const PLAYED_READY_REASON: Record<string, string> = {
  "wants:extra-attacks": "It readies a unit as you play it, so that unit can attack the turn it enters play instead of a round later.",
  "wants:ready-unit": "It readies a unit as you play it, so that unit can use its Action [Exhaust] the turn it enters play.",
};

/** The reason for one row hit of an edge, worded for the side the offer actually lands on. */
export function reasonOfHit(graph: PairGraph, e: PairEdge, hit: PairRowHit): string {
  if (hit.offer === "offers:ready-unit" && PLAYED_READY_REASON[hit.want] !== undefined) {
    const a = graph.byKey.get(e.a) as SynergyCard;
    const why = hit.offerWhy ?? a.tags.offers.find((t) => t.tag === hit.offer)?.why;
    if (why !== undefined && readiesAsPlayed(a, why)) return PLAYED_READY_REASON[hit.want];
  }
  const variants = rowById(graph, hit.row)?.reasonBySide;
  if (variants === undefined) return hit.reason;
  return variants[offerTargetSide(graph.byKey.get(e.a) as SynergyCard, hit.offer)] ?? hit.reason;
}
