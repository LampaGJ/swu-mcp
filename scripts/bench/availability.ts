/**
 * @displayName Card observability window
 * @strategicPurpose A pair can only be judged by a source captured after both cards existed; an unreleased card
 * missing from old decks is not evidence that nobody plays it.
 * @tacticalObjective Orders every logical card by the earliest main set that prints it, and decides per source
 * which release order it reaches: dated releases from the run's expansion index (only Homeworlds carries a date
 * today), extended by the sets the source itself shows in use, since Karabast ran sets before their street date.
 */
import { setReleaseOrder } from "../../src/swu/llm-flatten.js";
import type { Printing } from "./card-map.js";

export const UNKNOWN_ORDER = Number.MAX_SAFE_INTEGER;

/** Earliest main-set release order among a card's printings; promo-only cards stay UNKNOWN_ORDER. */
export function cardFirstOrder(printings: readonly Printing[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of printings) {
    const order = setReleaseOrder(p.expansion);
    out.set(p.cardKey, Math.min(out.get(p.cardKey) ?? UNKNOWN_ORDER, order));
  }
  return out;
}

/** "released YYYY-MM-DD" in an expansion definition, keyed by set code. */
export function releaseDatesFromDefinitions(rows: readonly { value: string; definition: string | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const hit = /\breleased (\d{4}-\d{2}-\d{2})\b/.exec(row.definition ?? "");
    if (hit) out.set(row.value, hit[1]);
  }
  return out;
}

export interface SourceWindow {
  source: string;
  capturedThrough: string;
  /** Highest main-set release order the source can contain. */
  reachesOrder: number;
  datedOrder: number;
  observedOrder: number;
}

/**
 * The source reaches a set when the set's dated release is on or before the capture date, or when at least
 * `minUses` observations in the source come from that set or a later one.
 */
export function sourceWindow(
  source: string,
  capturedThrough: string,
  releaseDates: ReadonlyMap<string, string>,
  setUses: ReadonlyMap<string, number>,
  minUses = 20,
): SourceWindow {
  let datedOrder = 0;
  for (const [set, date] of releaseDates) {
    const order = setReleaseOrder(set);
    if (order !== UNKNOWN_ORDER && date <= capturedThrough) datedOrder = Math.max(datedOrder, order);
  }
  let observedOrder = 0;
  for (const [set, uses] of setUses) {
    const order = setReleaseOrder(set);
    if (order !== UNKNOWN_ORDER && uses >= minUses) observedOrder = Math.max(observedOrder, order);
  }
  return { source, capturedThrough, reachesOrder: Math.max(datedOrder, observedOrder), datedOrder, observedOrder };
}

export function isObservable(
  cardKey: string,
  window: SourceWindow,
  firstOrder: ReadonlyMap<string, number>,
  seen: ReadonlySet<string>,
): boolean {
  if (seen.has(cardKey)) return true;
  return (firstOrder.get(cardKey) ?? UNKNOWN_ORDER) <= window.reachesOrder;
}
