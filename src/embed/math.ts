/**
 * @displayName Deterministic vector math
 * @strategicPurpose Pure numeric helpers for the similarity run (cosine neighbours, seeded k-means,
 * MRL truncation with int8 quantisation) so two runs over the same pinned vectors give identical bytes.
 * @tacticalObjective No clocks, no Math.random: randomness comes from the seeded mulberry32 below, sums run
 * in a fixed order, and every tie breaks on the lower index. k-means is a documented exception to the
 * frameworks-first rule: ~60 lines, and the libraries on npm do not promise run-to-run determinism.
 */

/** mulberry32: a 32-bit seeded generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Row-major float64 copy of a float32 matrix with every row scaled to unit length. */
export function unitRows(values: Float32Array, rows: number, dims: number, usedDims = dims): Float64Array {
  const out = new Float64Array(rows * usedDims);
  for (let r = 0; r < rows; r += 1) {
    let sum = 0;
    for (let d = 0; d < usedDims; d += 1) {
      const v = values[r * dims + d];
      out[r * usedDims + d] = v;
      sum += v * v;
    }
    const norm = Math.sqrt(sum);
    if (norm === 0) throw new Error(`row ${r} has zero length`);
    for (let d = 0; d < usedDims; d += 1) out[r * usedDims + d] /= norm;
  }
  return out;
}

export interface Neighbour {
  index: number;
  cosine: number;
}

/** Cosine neighbours of one row among unit rows, best first, ties to the lower index. `keep` filters candidates. */
export function neighboursOf(
  unit: Float64Array,
  dims: number,
  rows: number,
  row: number,
  keep: (candidate: number) => boolean,
): Neighbour[] {
  const found: Neighbour[] = [];
  for (let other = 0; other < rows; other += 1) {
    if (other === row || !keep(other)) continue;
    let dot = 0;
    for (let d = 0; d < dims; d += 1) dot += unit[row * dims + d] * unit[other * dims + d];
    found.push({ index: other, cosine: dot });
  }
  return found.sort((a, b) => b.cosine - a.cosine || a.index - b.index);
}

export interface KMeansResult {
  assign: Int32Array;
  inertia: number;
  iterations: number;
}

export interface KMeansOptions {
  k: number;
  seed: number;
  restarts: number;
  maxIter: number;
}

function sqDist(data: Float64Array, row: number, centroids: Float64Array, c: number, dims: number): number {
  let sum = 0;
  for (let d = 0; d < dims; d += 1) {
    const diff = data[row * dims + d] - centroids[c * dims + d];
    sum += diff * diff;
  }
  return sum;
}

function kmeansPlusPlus(data: Float64Array, rows: number, dims: number, k: number, random: () => number): Float64Array {
  const centroids = new Float64Array(k * dims);
  const first = Math.floor(random() * rows);
  centroids.set(data.subarray(first * dims, (first + 1) * dims), 0);
  const best = new Float64Array(rows);
  for (let r = 0; r < rows; r += 1) best[r] = sqDist(data, r, centroids, 0, dims);
  for (let c = 1; c < k; c += 1) {
    let total = 0;
    for (let r = 0; r < rows; r += 1) total += best[r];
    const target = random() * total;
    let acc = 0;
    let pick = rows - 1;
    for (let r = 0; r < rows; r += 1) {
      acc += best[r];
      if (acc > target) {
        pick = r;
        break;
      }
    }
    centroids.set(data.subarray(pick * dims, (pick + 1) * dims), c * dims);
    for (let r = 0; r < rows; r += 1) best[r] = Math.min(best[r], sqDist(data, r, centroids, c, dims));
  }
  return centroids;
}

function lloyd(data: Float64Array, rows: number, dims: number, k: number, random: () => number, maxIter: number): KMeansResult {
  const centroids = kmeansPlusPlus(data, rows, dims, k, random);
  const assign = new Int32Array(rows).fill(-1);
  const dist = new Float64Array(rows);
  let iterations = 0;
  for (; iterations < maxIter; iterations += 1) {
    let changed = false;
    for (let r = 0; r < rows; r += 1) {
      let bestC = 0;
      let bestD = Infinity;
      for (let c = 0; c < k; c += 1) {
        const d = sqDist(data, r, centroids, c, dims);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      dist[r] = bestD;
      if (assign[r] !== bestC) {
        assign[r] = bestC;
        changed = true;
      }
    }
    if (!changed) break;
    const sums = new Float64Array(k * dims);
    const counts = new Int32Array(k);
    for (let r = 0; r < rows; r += 1) {
      counts[assign[r]] += 1;
      for (let d = 0; d < dims; d += 1) sums[assign[r] * dims + d] += data[r * dims + d];
    }
    for (let c = 0; c < k; c += 1) {
      if (counts[c] === 0) {
        let far = 0;
        for (let r = 1; r < rows; r += 1) if (dist[r] > dist[far]) far = r;
        centroids.set(data.subarray(far * dims, (far + 1) * dims), c * dims);
        dist[far] = 0;
        continue;
      }
      for (let d = 0; d < dims; d += 1) centroids[c * dims + d] = sums[c * dims + d] / counts[c];
    }
  }
  let inertia = 0;
  for (let r = 0; r < rows; r += 1) inertia += sqDist(data, r, centroids, assign[r], dims);
  return { assign, inertia, iterations };
}

/** k-means++ seeding and Lloyd iterations, best of `restarts` runs (seeds seed, seed+1, ...); lower inertia wins, ties to the earlier run. */
export function kmeans(
  data: Float64Array,
  rows: number,
  dims: number,
  options: KMeansOptions,
  onRestart?: (done: number) => void,
): KMeansResult {
  let best: KMeansResult | undefined;
  for (let run = 0; run < options.restarts; run += 1) {
    const result = lloyd(data, rows, dims, options.k, mulberry32(options.seed + run), options.maxIter);
    if (best === undefined || result.inertia < best.inertia) best = result;
    onRestart?.(run + 1);
  }
  if (best === undefined) throw new Error("kmeans needs at least one restart");
  return best;
}

/** numpy.round semantics: halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** numpy.percentile (linear interpolation) of already sorted ascending values. */
export function percentileSorted(sorted: Float64Array, q: number): number {
  const position = (q / 100) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export interface Quantised {
  dims: number;
  scale: number;
  rows: Int8Array;
}

/** Truncate each row to its first `dims` values (Matryoshka), renormalise, then int8 with one global scale = p99.9(|x|) / 127. */
export function quantiseInt8(values: Float32Array, rows: number, fullDims: number, dims: number): Quantised {
  const unit = unitRows(values, rows, fullDims, dims);
  const sorted = Float64Array.from(unit, Math.abs).sort();
  const scale = percentileSorted(sorted, 99.9) / 127;
  const out = new Int8Array(unit.length);
  for (let i = 0; i < unit.length; i += 1) out[i] = Math.max(-127, Math.min(127, roundHalfEven(unit[i] / scale)));
  return { dims, scale, rows: out };
}

export function dequantiseInt8(quantised: Quantised): Float64Array {
  return Float64Array.from(quantised.rows, (q) => q * quantised.scale);
}

export const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
export const fromBase64Url = (text: string): Int8Array => {
  const bytes = Buffer.from(text, "base64url");
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
};
