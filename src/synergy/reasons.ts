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
const PLAYED_THIS_PHASE = /\bplayed this phase\b/i;

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
      // D82 (#164): "Ready a unit that was played this phase" readies a unit on the turn it entered, the same gain.
      if (effects.some((x) => x.rule === "ready" && PLAYED_THIS_PHASE.test(String((x.target as Loose | undefined)?.text ?? "")))) return true;
    }
  }
  return false;
}

const PLAYED_READY_REASON: Record<string, string> = {
  "wants:extra-attacks": "It readies a unit as you play it, so that unit can attack the turn it enters play instead of a round later.",
  "wants:ready-unit": "It readies a unit as you play it, so that unit can use its Action [Exhaust] the turn it enters play.",
};

/**
 * D82 (#164): a unit that wants extra attacks gains from attacking (Raid per exhausted resource, a Tusken count), not from an
 * Action [Exhaust] or an On Attack, so a ready that is not tied to playing the unit is worded as the second attack it gives.
 */
const READY_AGAIN_REASON = "Readying a unit after it attacks lets it attack again this round, so what it gains while attacking pays off twice.";

/** D91 (#173): "Take control of a non-leader unit, then defeat it" is no sacrifice outlet, so the sac-outlet row's reason misstates it. */
const SEIZED_DEFEAT_REASON =
  "It takes control of a unit, then defeats it: the unit is yours when it leaves play (CR 8.27.1, 8.11.1), so it counts as a friendly unit defeated.";

/** The reason for one row hit of an edge, worded for the side the offer actually lands on. */
export function reasonOfHit(graph: PairGraph, e: PairEdge, hit: PairRowHit): string {
  if (hit.offer === "offers:defeat-friendly-unit" && graph.qualifier(e.a, "offers", hit.offer)?.seized === true) return SEIZED_DEFEAT_REASON;
  if (hit.offer === "offers:ready-unit" && PLAYED_READY_REASON[hit.want] !== undefined) {
    const a = graph.byKey.get(e.a) as SynergyCard;
    const why = hit.offerWhy ?? a.tags.offers.find((t) => t.tag === hit.offer)?.why;
    if (why !== undefined && readiesAsPlayed(a, why)) return PLAYED_READY_REASON[hit.want];
    if (hit.want === "wants:extra-attacks") return READY_AGAIN_REASON;
  }
  const variants = rowById(graph, hit.row)?.reasonBySide;
  const text = variants === undefined ? hit.reason : (variants[offerTargetSide(graph.byKey.get(e.a) as SynergyCard, hit.offer)] ?? hit.reason);
  return ownExamples(graph, e, text);
}

const titlesOf = new WeakMap<PairGraph, readonly string[]>();
/** Card titles of the graph, longest first, so "Oppo Rancisis" is matched before a shorter title it starts with. */
function graphTitles(graph: PairGraph): readonly string[] {
  let titles = titlesOf.get(graph);
  if (titles === undefined) {
    titles = [...new Set([...graph.byKey.values()].map((c) => c.title))].filter((t) => t.length > 0).sort((x, y) => y.length - x.length || (x < y ? -1 : x > y ? 1 : 0));
    titlesOf.set(graph, titles);
  }
  return titles;
}
const DECISION_REF = /\s*\((?:D\d+(?:, D\d+)*)\)\.?\s*$/;

/**
 * D83 (#165): a row's reason names example cards ("...: Marchion Ro doubles each friendly unit's Raid, and Oppo Rancisis gains
 * Raid 2 while another friendly unit has Raid."; "Example: Academy Graduate feeds Kylo Ren's Command Shuttle."). On a link the
 * reason keeps only the example clauses of the two linked cards, so Oppo's row never explains Marchion Ro.
 */
export function ownExamples(graph: PairGraph, e: PairEdge, reason: string): string {
  const titles = graphTitles(graph);
  const own = new Set([e.a, e.b].map((k) => graph.byKey.get(k)?.title).filter((t): t is string => t !== undefined));
  const titleAt = (text: string): string | undefined => titles.find((t) => text.startsWith(t) && !/[\p{L}\p{N}]/u.test(text.charAt(t.length)));
  const ref = DECISION_REF.exec(reason)?.[0] ?? "";
  let body = ref === "" ? reason : reason.slice(0, reason.length - ref.length);
  // "Example: X feeds Y." names other cards; it stays only when it names a linked card.
  body = body.replace(/\s*Example: ([^.]*)\./g, (whole, inner: string) => ([...own].some((t) => inner.includes(t)) ? whole : ""));
  const colon = body.indexOf(": ");
  if (colon >= 0) {
    const head = body.slice(0, colon);
    const segments = body.slice(colon + 2).replace(/\.$/, "").split(/, and |; /);
    const named = segments.map(titleAt);
    if (named.every((t) => t !== undefined)) {
      const kept = segments.filter((_, i) => own.has(named[i] as string));
      body = kept.length === 0 ? `${head}.` : `${head}: ${kept.join("; ")}.`;
    }
  }
  // "...is such a target too; Oppo Rancisis copies it from one" names a card after a semicolon.
  body = body.replace(/; ([^;.]+)(?=\.|$)/g, (whole, inner: string) => {
    const t = titleAt(inner);
    return t === undefined || own.has(t) ? whole : "";
  });
  return `${body.trimEnd()}${ref}`;
}
