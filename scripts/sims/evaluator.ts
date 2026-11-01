/**
 * @displayName Evaluator runtime
 * @strategicPurpose Scores states inside the game loop, synchronously and with no dependency, so the learned rungs
 * (#128) use the captured evaluator at engine speed while no model ever decides a served score (D1, D96).
 * @tacticalObjective Verifies the manifest and the weights' sha256, parses evaluator.json with evaluatorWeightsSchema,
 * checks the feature layout against the runtime's, and computes the logit in float64 with a sparse first layer and no
 * Math.exp; builds seeded synthetic networks of a given shape for the latency gate.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../src/paths.js";
import type { SparseRow } from "../../src/sims/features.js";
import { sha256Hex } from "../../src/swu/canonical.js";
import { seededRandom } from "../bench/stats.js";
import { evaluatorManifestSchema, evaluatorWeightsSchema, type EvaluatorManifest } from "./evaluator-manifest.js";

export interface Layer {
  in: number;
  out: number;
  /** Row-major: weight[i * out + j] connects input i to output j. */
  weight: Float64Array;
  bias: Float64Array;
}
export interface Dense {
  scale: Float64Array;
  layers: Layer[];
}
export interface Evaluator {
  version: string;
  /** sha256 of evaluator.json, or of the synthetic network's description. */
  sha256: string;
  featureWidth: number;
  featureLayoutSha256: string;
  /** The actor's win logit for one flattened state. */
  logit(row: SparseRow): number;
}

export const DEFAULT_MODELS_ROOT = "/Volumes/Models/swu";

function floats(b64: string, n: number, what: string): Float64Array {
  const buf = Buffer.from(b64, "base64");
  if (buf.length !== n * 4) throw new Error(`${what}: ${buf.length / 4} floats, expected ${n}`);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Float64 forward pass; the first layer visits only the row's non-zero columns, ReLU between layers, linear output. */
export function denseLogit(d: Dense, row: SparseRow): number {
  const first = d.layers[0];
  let h = Float64Array.from(first.bias);
  for (let t = 0; t < row.indices.length; t++) {
    const i = row.indices[t];
    const x = row.values[t] * d.scale[i];
    const off = i * first.out;
    for (let j = 0; j < first.out; j++) h[j] += x * first.weight[off + j];
  }
  for (let l = 1; l < d.layers.length; l++) {
    const L = d.layers[l];
    const o = Float64Array.from(L.bias);
    for (let i = 0; i < L.in; i++) {
      const x = h[i] > 0 ? h[i] : 0;
      if (x === 0) continue;
      const off = i * L.out;
      for (let j = 0; j < L.out; j++) o[j] += x * L.weight[off + j];
    }
    h = o;
  }
  return h[0];
}

/** Glorot-uniform weights rounded to float32, as an exported network would hold them, from a counter-based stream. */
export function syntheticDense(width: number, hidden: readonly number[], seed: string): Dense {
  const rnd = seededRandom(seed);
  const sizes = [width, ...hidden, 1];
  const layers = sizes.slice(0, -1).map((n, l) => {
    const out = sizes[l + 1];
    const a = Math.sqrt(6 / (n + out));
    return { in: n, out, weight: Float64Array.from({ length: n * out }, () => Math.fround((rnd() * 2 - 1) * a)), bias: new Float64Array(out) };
  });
  return { scale: new Float64Array(width).fill(1), layers };
}

export function syntheticEvaluator(width: number, layoutSha: string, hidden: readonly number[]): Evaluator {
  if (hidden.length === 0 || hidden.some((h) => !Number.isInteger(h) || h < 1)) throw new Error(`synthetic evaluator needs positive integer layer widths, got ${hidden.join(",")}`);
  const d = syntheticDense(width, hidden, `synthetic-evaluator|${hidden.join(",")}`);
  return { version: `synthetic:${hidden.join(",")}`, sha256: sha256Hex(`synthetic|${width}|${hidden.join(",")}`), featureWidth: width, featureLayoutSha256: layoutSha, logit: (row) => denseLogit(d, row) };
}

export function readManifest(manifestPath: string): EvaluatorManifest {
  return evaluatorManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
}

export interface LoadOptions {
  /** Root the manifest's pinnedWeights path is relative to (default: this repo). */
  root?: string;
  /** Root the manifest's files[] paths are relative to (default SWU_MODELS_ROOT or /Volumes/Models/swu). */
  modelsRoot?: string;
}

/**
 * The repo's pinned copy is read when the manifest names one and it exists; otherwise the models volume's file.
 * Either way its sha256 must equal the manifest's files[0] entry, so the two copies cannot disagree unnoticed.
 */
export function loadEvaluator(manifestPath: string, runtimeLayoutSha: string, opts: LoadOptions = {}): Evaluator {
  const m = readManifest(manifestPath);
  if (!m.adopted) throw new Error(`${manifestPath}: evaluator ${m.evaluatorVersion} was not adopted (${m.reason})`);
  const entry = m.files[0];
  if (path.basename(entry.path) !== "evaluator.json") throw new Error(`${manifestPath}: files[0] is ${entry.path}, not evaluator.json`);
  const pinned = m.pinnedWeights === null ? null : path.join(opts.root ?? REPO_ROOT, m.pinnedWeights.path);
  if (m.pinnedWeights !== null && m.pinnedWeights.sha256 !== entry.sha256) throw new Error(`${manifestPath}: pinnedWeights sha256 ${m.pinnedWeights.sha256} differs from files[0] ${entry.sha256}`);
  const file = pinned !== null && existsSync(pinned) ? pinned : path.join(opts.modelsRoot ?? process.env.SWU_MODELS_ROOT ?? DEFAULT_MODELS_ROOT, entry.path);
  const bytes = readFileSync(file);
  const got = sha256Hex(bytes);
  if (got !== entry.sha256) throw new Error(`${file}: sha256 ${got}, manifest says ${entry.sha256}`);
  const w = evaluatorWeightsSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (w.featureLayoutSha256 !== m.featureLayoutSha256 || w.featureLayoutSha256 !== runtimeLayoutSha)
    throw new Error(`feature layout mismatch: weights ${w.featureLayoutSha256}, manifest ${m.featureLayoutSha256}, runtime ${runtimeLayoutSha}`);
  if (w.featureWidth !== m.featureWidth) throw new Error(`feature width mismatch: weights ${w.featureWidth}, manifest ${m.featureWidth}`);
  // The adopted v1 is logistic (D96); a tree evaluator would run on src/sims/xgb.ts's walker, wired when one is adopted.
  if (w.kind === "xgboost") throw new Error(`${file}: an xgboost evaluator has no runtime here yet; v1 is logistic`);
  const d: Dense = {
    scale: floats(w.scale, w.featureWidth, "scale"),
    layers: w.layers.map((l, i) => ({ in: l.in, out: l.out, weight: floats(l.weight, l.in * l.out, `layer ${i} weight`), bias: floats(l.bias, l.out, `layer ${i} bias`) })),
  };
  return { version: m.evaluatorVersion, sha256: got, featureWidth: w.featureWidth, featureLayoutSha256: w.featureLayoutSha256, logit: (row) => denseLogit(d, row) };
}
