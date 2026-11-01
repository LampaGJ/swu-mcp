/**
 * @displayName Learned search core
 * @strategicPurpose The deterministic half of the learned rungs (#128): which actions they try, how leaf values
 * combine and which candidate wins, kept free of the engine so a reader can recompute every choice from the record.
 * @tacticalObjective Candidate order (the ranking pilot's top k plus Pass and Claim Initiative), terminal values,
 * 4-decimal rounding, the reply minimum, the mean over determinizations, the pick (highest mean, ties by rank, then
 * descriptor), and the untied top-1 decision check (#126's move-choice gate, coordinator ruling 2).
 */
import { compareCodePoints } from "../../../src/swu/canonical.js";
import { signTest } from "../../../src/sims/policies/ladder-stats.js";

/** A finished game is worth plus or minus 20 logits to the actor (#128), far past any state V scores. */
export const LEAF_TERMINAL = 20;

export const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export const terminalValue = (outcome: "won" | "lost" | "draw"): number => (outcome === "won" ? LEAF_TERMINAL : outcome === "lost" ? -LEAF_TERMINAL : 0);

/** The opponent picks the reply worst for the actor: the minimum of the rounded leaves; null when every reply failed. */
export function replyValue(leaves: readonly (number | null)[]): number | null {
  const ok = leaves.filter((v): v is number => v !== null).map(r4);
  return ok.length === 0 ? null : Math.min(...ok);
}

/** Mean over the determinizations that scored, from rounded values, rounded again. */
export function candidateMean(values: readonly (number | null)[]): number | null {
  const ok = values.filter((v): v is number => v !== null).map(r4);
  return ok.length === 0 ? null : r4(ok.reduce((a, b) => a + b, 0) / ok.length);
}

export interface ScoredCandidate {
  /** Index into the decision's legal actions. */
  index: number;
  descriptor: string;
  rank: number;
  values: (number | null)[];
  mean: number | null;
  fallback: string | null;
}

/** Highest mean; ties by rank, then descriptor (code points). A null mean is picked only when every mean is null. */
export function pickScored<T extends Pick<ScoredCandidate, "descriptor" | "rank" | "mean">>(cands: readonly T[]): T {
  const scored = cands.filter((c) => c.mean !== null);
  const pool = scored.length > 0 ? scored : cands;
  let best = pool[0];
  for (const c of pool.slice(1)) {
    const cv = c.mean ?? 0;
    const bv = best.mean ?? 0;
    if (cv > bv || (cv === bv && (c.rank < best.rank || (c.rank === best.rank && compareCodePoints(c.descriptor, best.descriptor) < 0)))) best = c;
  }
  return best;
}

/**
 * The ranking's order, then Pass and Claim Initiative when legal and not already in it (#128 "Candidates"); a
 * cancelled answer (a click the engine took back) is dropped unless it is the ranking's own pick.
 */
export function candidateOrder(ranked: readonly number[], kinds: readonly string[], cancelled: ReadonlySet<number>, noPass = false): number[] {
  const dropPass = noPass && kinds[ranked[0]] !== "pass";
  const out = ranked.filter((i, r) => r === 0 || (!cancelled.has(i) && !(dropPass && kinds[i] === "pass")));
  for (const kind of dropPass ? ["takeInitiative"] : ["pass", "takeInitiative"]) {
    const i = kinds.indexOf(kind);
    if (i >= 0 && !out.includes(i) && !cancelled.has(i)) out.push(i);
  }
  return out;
}

export interface UntiedTop1 {
  decisions: number;
  /** Decisions whose best label is unique. */
  untied: number;
  /** Untied decisions where the model's argmax (ties to the first action) is the best action. */
  model: number;
  /** Untied decisions where the constant model's pick, the first action in code-point order, is the best action. */
  constant: number;
  modelOnly: number;
  constantOnly: number;
  modelShare: number | null;
  constantShare: number | null;
  /** Two-sided exact sign test on the discordant decisions (model right and constant wrong against the reverse). */
  pValue: number | null;
}

const argmax = (xs: readonly number[]): number => xs.reduce((b, x, i) => (x > xs[b] ? i : b), 0);

/** Actions in each decision are in code-point order of their descriptors, so the constant model picks index 0. */
export function untiedTop1(decisions: readonly { pred: readonly number[]; label: readonly number[] }[]): UntiedTop1 {
  let untied = 0;
  let model = 0;
  let constant = 0;
  let modelOnly = 0;
  let constantOnly = 0;
  for (const d of decisions) {
    const best = Math.max(...d.label);
    if (d.label.filter((l) => l === best).length !== 1) continue;
    untied++;
    const b = d.label.indexOf(best);
    const m = argmax(d.pred) === b;
    const c = b === 0;
    if (m) model++;
    if (c) constant++;
    if (m && !c) modelOnly++;
    if (c && !m) constantOnly++;
  }
  const share = (n: number): number | null => (untied === 0 ? null : r4(n / untied));
  return { decisions: decisions.length, untied, model, constant, modelOnly, constantOnly, modelShare: share(model), constantShare: share(constant), pValue: modelOnly + constantOnly === 0 ? null : signTest(modelOnly, modelOnly + constantOnly) };
}
