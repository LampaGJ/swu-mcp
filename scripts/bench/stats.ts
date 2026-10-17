/**
 * @displayName Real-play statistics
 * @strategicPurpose The benchmarks need a handful of textbook statistics; each is a short closed formula, so they
 * live here with tests instead of pulling in a statistics library.
 * @tacticalObjective Shrunk log-lift (observed over expected), seeded percentile bootstrap, Mann-Whitney U with tie-corrected normal
 * approximation (AUC and rank-biserial), Mantel-Haenszel risk difference. No clocks, no Math.random.
 */
import { createHash } from "node:crypto";
import { mulberry32 } from "../../src/embed/math.js";

export function seededRandom(seed: string): () => number {
  return mulberry32(createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0));
}

/**
 * ln(P(AB) / (P(A)P(B))) as ln((observed + pseudo) / (expected + pseudo)), expected = nA nB / n. Adding the
 * pseudo-count to both sides shrinks rare pairs toward 0; adding it to the marginals instead would hand a pair of
 * two once-seen cards a huge lift.
 */
export function logLift(nAB: number, nA: number, nB: number, n: number, pseudo = 0.5): number {
  return Math.log((nAB + pseudo) / ((nA * nB) / n + pseudo));
}

export const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function median(xs: readonly number[]): number {
  const s = Float64Array.from(xs).sort();
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Abramowitz and Stegun 7.1.26 erf; absolute error below 1.5e-7. */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export interface CI {
  value: number | null;
  low: number | null;
  high: number | null;
  n: number;
}

const round = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Percentile bootstrap (2.5 / 97.5) of `stat` over resamples drawn with a seeded generator. */
export function bootstrapCI(
  values: readonly number[],
  stat: (xs: readonly number[]) => number,
  options: { iterations: number; seed: string },
): CI {
  if (values.length === 0) return { value: null, low: null, high: null, n: 0 };
  const random = seededRandom(options.seed);
  const draws = new Float64Array(options.iterations);
  const sample = new Array<number>(values.length);
  for (let i = 0; i < options.iterations; i++) {
    for (let j = 0; j < values.length; j++) sample[j] = values[Math.floor(random() * values.length)];
    draws[i] = stat(sample);
  }
  draws.sort();
  const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.round(q * (draws.length - 1))))];
  return { value: round(stat(values)), low: round(at(0.025)), high: round(at(0.975)), n: values.length };
}

export interface MannWhitney {
  u: number;
  auc: number;
  rankBiserial: number;
  z: number;
  p: number;
  nx: number;
  ny: number;
}

/** U for x over y (ties count half), AUC = U / (nx ny), two-sided p from the tie-corrected normal approximation. */
export function mannWhitney(x: readonly number[], y: readonly number[]): MannWhitney {
  const all = [...x.map((v) => ({ v, g: 0 })), ...y.map((v) => ({ v, g: 1 }))].sort((a, b) => a.v - b.v);
  const n = all.length;
  let rankSumX = 0;
  let tieTerm = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && all[j + 1].v === all[i].v) j++;
    const rank = (i + j + 2) / 2;
    const t = j - i + 1;
    tieTerm += t * t * t - t;
    for (let k = i; k <= j; k++) if (all[k].g === 0) rankSumX += rank;
    i = j + 1;
  }
  const nx = x.length;
  const ny = y.length;
  const u = rankSumX - (nx * (nx + 1)) / 2;
  const auc = nx * ny === 0 ? 0.5 : u / (nx * ny);
  const variance = ((nx * ny) / 12) * (n + 1 - tieTerm / (n * (n - 1) || 1));
  const z = variance > 0 ? (u - (nx * ny) / 2) / Math.sqrt(variance) : 0;
  return { u, auc, rankBiserial: 2 * auc - 1, z, p: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))), nx, ny };
}

export interface Stratum {
  /** successes and size of the exposed group */
  a: number;
  n1: number;
  /** successes and size of the comparison group */
  c: number;
  n0: number;
}

/** Mantel-Haenszel sums: num = sum((a n0 - c n1) / N), den = sum(n1 n0 / N); strata missing a group drop out. */
export function mhSums(strata: Iterable<Stratum>): { num: number; den: number } {
  let num = 0;
  let den = 0;
  for (const s of strata) {
    const total = s.n1 + s.n0;
    if (s.n1 === 0 || s.n0 === 0) continue;
    num += (s.a * s.n0 - s.c * s.n1) / total;
    den += (s.n1 * s.n0) / total;
  }
  return { num, den };
}

/** Mantel-Haenszel common risk difference num / den. */
export function mhRiskDifference(strata: readonly Stratum[]): { rd: number | null; num: number; den: number } {
  const { num, den } = mhSums(strata);
  return { rd: den === 0 ? null : num / den, num, den };
}
