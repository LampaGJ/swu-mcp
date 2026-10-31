import { createHash } from "node:crypto";
import { mulberry32 } from "../embed/math.js";
import { wilson } from "../meta/stats.js";

/**
 * @displayName Stratified field estimate
 * @strategicPurpose A battle-test samples each opponent archetype on its own, so the field-level win share is a
 * share-weighted mean of the strata, and Wilson does not apply to a weighted mean (#112).
 * @tacticalObjective Per-stratum win share with a Wilson 95% interval (draws left out, as src/meta/stats.ts does),
 * a field win share as the weighted mean over strata with decisive games, and a seeded percentile bootstrap that
 * resamples within each stratum. For one stratum it reproduces `bootstrapCI` (scripts/bench/stats.ts:53) value for
 * value, because it consumes the same seeded generator in the same order.
 */

export interface StratumResult {
  id: string;
  /** Share of the field this stratum stands for; the weights are renormalised over the strata that have decisive games. */
  weight: number;
  wins: number;
  losses: number;
  draws: number;
  /** Games the engine failed to finish; never counted as a win or a loss. */
  errors: number;
}

export interface StratumRow {
  id: string;
  weight: number;
  n: number;
  wins: number;
  losses: number;
  draws: number;
  errors: number;
  winShare: number | null;
  wilson95: { low: number; high: number } | null;
}

export interface FieldEstimate {
  winShare: number | null;
  ci95: { low: number | null; high: number | null };
  /** Decisive games over every stratum. */
  n: number;
  /** Fraction of the field weight held by strata with decisive games; below 1 the estimate leaves part of the field out. */
  coverage: number;
  /** Strata with no decisive game, named so a gap is never silent. */
  empty: string[];
  strata: StratumRow[];
  bootstrap: { iterations: number; seed: string };
}

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Same construction as seededRandom in scripts/bench/stats.ts: the first four bytes of sha256(seed) seed mulberry32. */
export function seededRandom(seed: string): () => number {
  return mulberry32(createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0));
}

export function stratifiedEstimate(
  strata: readonly StratumResult[],
  options: { iterations?: number; seed: string },
): FieldEstimate {
  const iterations = options.iterations ?? 2000;
  const rows: StratumRow[] = strata.map((s) => {
    const n = s.wins + s.losses;
    return {
      id: s.id,
      weight: s.weight,
      n,
      wins: s.wins,
      losses: s.losses,
      draws: s.draws,
      errors: s.errors,
      winShare: n === 0 ? null : round4(s.wins / n),
      wilson95: wilson(s.wins, n),
    };
  });
  const live = strata.filter((s) => s.wins + s.losses > 0 && s.weight > 0);
  const totalWeight = strata.reduce((sum, s) => sum + s.weight, 0);
  const liveWeight = live.reduce((sum, s) => sum + s.weight, 0);
  const empty = strata.filter((s) => s.wins + s.losses === 0).map((s) => s.id);
  const n = rows.reduce((sum, r) => sum + r.n, 0);
  const bootstrap = { iterations, seed: options.seed };
  if (live.length === 0 || liveWeight === 0) {
    return { winShare: null, ci95: { low: null, high: null }, n, coverage: 0, empty, strata: rows, bootstrap };
  }

  const outcomes = live.map((s) => Float64Array.from({ length: s.wins + s.losses }, (_, i) => (i < s.wins ? 1 : 0)));
  const weights = live.map((s) => s.weight / liveWeight);
  const point = outcomes.reduce((sum, o, k) => sum + weights[k] * mean(o), 0);

  const random = seededRandom(options.seed);
  const draws = new Float64Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let total = 0;
    for (let k = 0; k < outcomes.length; k++) {
      const o = outcomes[k];
      let sum = 0;
      for (let j = 0; j < o.length; j++) sum += o[Math.floor(random() * o.length)];
      total += weights[k] * (sum / o.length);
    }
    draws[b] = total;
  }
  draws.sort();
  const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.round(q * (draws.length - 1))))];
  return {
    winShare: round4(point),
    ci95: { low: round4(at(0.025)), high: round4(at(0.975)) },
    n,
    coverage: round4(totalWeight === 0 ? 0 : liveWeight / totalWeight),
    empty,
    strata: rows,
    bootstrap,
  };
}

function mean(xs: Float64Array): number {
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}
