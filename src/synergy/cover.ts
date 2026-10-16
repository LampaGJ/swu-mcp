import { compareCodePoints } from "../swu/canonical.js";
import { cmp } from "./order.js";
import type { SynergyCard } from "./schema.js";

/**
 * @displayName SWU aspect cover
 * @strategicPurpose A card whose aspect icons the leader and base do not supply costs +2
 * resources per uncovered icon, so every pair and trio is only as good as the cheapest
 * leader+base combination that covers it.
 * @tacticalObjective Combinations are the leader icon sets (up to 2 icons) and base icon sets
 * (1 icon, or none for a neutral base) that actually occur in the card data. Duplicated icons
 * count: a card with two Command icons needs two Command icons across leader and base.
 */

export const UNCOVERED_ICON_PENALTY = 2;

export interface CoverCombo {
  leader: string[];
  base: string[];
  label: string;
}

export interface CoverResult extends CoverCombo {
  penalty: number;
  uncovered: { cardKey: string; icons: string[]; penalty: number }[];
}

const iconSetKey = (icons: readonly string[]): string => icons.join("+");
const splitKey = (key: string): string[] => (key === "" ? [] : key.split("+"));

export const comboLabel = (leader: readonly string[], base: readonly string[]): string =>
  `leader ${leader.join("+") || "none"} / base ${base.join("+") || "neutral"}`;

/** Distinct leader and base icon sets present in the data, in code-point order. */
export function coverCombos(cards: readonly SynergyCard[]): CoverCombo[] {
  const sets = (type: string): string[][] =>
    [...new Set(cards.filter((c) => c.type === type).map((c) => iconSetKey(c.structured.aspectIcons)))]
      .sort(compareCodePoints)
      .map(splitKey);
  const combos: CoverCombo[] = [];
  for (const leader of sets("Leader")) for (const base of sets("Base")) combos.push({ leader, base, label: comboLabel(leader, base) });
  return combos;
}

const count = (icons: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const x of icons) out.set(x, (out.get(x) ?? 0) + 1);
  return out;
};

/** Penalty for fielding `members` under one leader+base: 2 per icon the pair does not supply, per card. */
export function coverPenalty(members: readonly SynergyCard[], leader: readonly string[], base: readonly string[]): CoverResult {
  const have = count([...leader, ...base]);
  let penalty = 0;
  const uncovered: CoverResult["uncovered"] = [];
  for (const m of members) {
    const missing: string[] = [];
    for (const [icon, need] of count(m.structured.aspectIcons)) {
      for (let i = have.get(icon) ?? 0; i < need; i++) missing.push(icon);
    }
    const cardPenalty = UNCOVERED_ICON_PENALTY * missing.length;
    penalty += cardPenalty;
    if (missing.length > 0) uncovered.push({ cardKey: m.cardKey, icons: missing.sort(compareCodePoints), penalty: cardPenalty });
  }
  return { leader: [...leader], base: [...base], label: comboLabel(leader, base), penalty, uncovered };
}

const penaltyOnly = (members: readonly SynergyCard[], have: ReadonlyMap<string, number>): number => {
  let penalty = 0;
  for (const m of members) {
    for (const [icon, need] of count(m.structured.aspectIcons))
      penalty += UNCOVERED_ICON_PENALTY * Math.max(0, need - (have.get(icon) ?? 0));
  }
  return penalty;
};

/**
 * Cheapest combination (ties broken by label). Memoised on the members' icon sets, since a
 * penalty depends only on those, which keeps the trio search from re-scoring millions of triples.
 */
export function makeBestCover(combos: readonly CoverCombo[]): (members: readonly SynergyCard[]) => { penalty: number; label: string } {
  const prepared = combos.map((c) => ({ label: c.label, have: count([...c.leader, ...c.base]) }));
  const neutral = { penalty: 0, label: comboLabel([], []) };
  const memo = new Map<string, { penalty: number; label: string }>();
  return (members) => {
    const key = members
      .map((m) => iconSetKey(m.structured.aspectIcons))
      .sort(cmp)
      .join("|");
    const hit = memo.get(key);
    if (hit) return hit;
    let best: { penalty: number; label: string } | null = null;
    for (const c of prepared) {
      const penalty = penaltyOnly(members, c.have);
      if (!best || penalty < best.penalty || (penalty === best.penalty && cmp(c.label, best.label) < 0)) best = { penalty, label: c.label };
    }
    const result = best ?? { ...neutral, penalty: penaltyOnly(members, new Map()) };
    memo.set(key, result);
    return result;
  };
}

/** Every combination ranked cheapest first (label breaks ties). */
export function rankCovers(members: readonly SynergyCard[], combos: readonly CoverCombo[]): CoverResult[] {
  return combos.map((c) => coverPenalty(members, c.leader, c.base)).sort((x, y) => x.penalty - y.penalty || cmp(x.label, y.label));
}
