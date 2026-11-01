import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { denseLogit, loadEvaluator, syntheticDense, type Dense } from "../../scripts/sims/evaluator.js";
import { REPO_ROOT } from "../../src/paths.js";
import { featureLayout, type SparseRow } from "../../src/sims/features.js";
import { observedRecord } from "../../src/sims/session.js";
import { SCALAR_COUNT, U } from "../../src/sims/state.js";
import { FIRST_CARD_INDEX, parseVocab } from "../../src/sims/vocab.js";

const MANIFEST = path.join(REPO_ROOT, "data/pinned/sim-evaluators/v1.json");
const vocab = parseVocab(JSON.parse(readFileSync(path.join(REPO_ROOT, "data/pinned/sim-vocab/2026-10-30.r6.v2.json"), "utf8")));
const layout = featureLayout(SCALAR_COUNT, U, vocab.keys.length + FIRST_CARD_INDEX, vocab.contentSha256);

/** The textbook forward pass over a dense input vector, float64 throughout, for comparison with the sparse one. */
function naiveDense(d: Dense, x: Float64Array): number {
  let h = Array.from(x, (v, i) => v * d.scale[i]);
  d.layers.forEach((L, l) => {
    const o = Array.from(L.bias);
    for (let i = 0; i < L.in; i++) for (let j = 0; j < L.out; j++) o[j] += h[i] * L.weight[i * L.out + j];
    h = l < d.layers.length - 1 ? o.map((v) => (v > 0 ? v : 0)) : o;
  });
  return h[0];
}

function row(width: number, seed: number): SparseRow {
  const indices: number[] = [];
  const values: number[] = [];
  for (let i = seed % 7; i < width; i += 13 + (seed % 5)) {
    indices.push(i);
    values.push(((i * 31 + seed) % 9) - 4 || 1);
  }
  return { indices, values };
}

describe("evaluator runtime (#127)", () => {
  it("the sparse forward pass equals a naive dense float64 pass within 1e-12 on a synthetic network", () => {
    const width = 300;
    const d = syntheticDense(width, [64, 32], "test-net");
    for (let s = 0; s < 20; s++) {
      const r = row(width, s);
      const x = new Float64Array(width);
      r.indices.forEach((i, t) => (x[i] = r.values[t]));
      expect(Math.abs(denseLogit(d, r) - naiveDense(d, x))).toBeLessThan(1e-12);
    }
  });

  it("synthetic networks are seeded: the same shape and seed give the same weights", () => {
    const a = syntheticDense(50, [8], "s");
    const b = syntheticDense(50, [8], "s");
    expect(Array.from(a.layers[0].weight)).toEqual(Array.from(b.layers[0].weight));
    expect(Array.from(syntheticDense(50, [8], "t").layers[0].weight)).not.toEqual(Array.from(a.layers[0].weight));
  });

  it("loads the pinned v1 logistic evaluator and computes the dot product plus bias in float64", () => {
    const ev = loadEvaluator(MANIFEST, layout.sha256);
    expect(ev.version).toBe("v1");
    expect(ev.sha256).toBe("75a972ea6de8b132b91f7c64e48dd13a5654c8ea2c3d6b7c0fdc98cc318dcd27");
    expect(ev.featureWidth).toBe(19874);
    const w = JSON.parse(readFileSync(path.join(REPO_ROOT, "data/pinned/sim-evaluators/v1.evaluator.json"), "utf8")) as { layers: { weight: string; bias: string }[] };
    const wb = Buffer.from(w.layers[0].weight, "base64");
    const bias = Buffer.from(w.layers[0].bias, "base64").readFloatLE(0);
    const r = row(19874, 3);
    let want = bias;
    r.indices.forEach((i, t) => (want += r.values[t] * wb.readFloatLE(i * 4)));
    expect(Math.abs(ev.logit(r) - want)).toBeLessThan(1e-9);
  });

  it("refuses a weights file with one flipped byte, naming both hashes", () => {
    const root = path.join(REPO_ROOT, "tmp/test-evaluator-tamper");
    mkdirSync(path.join(root, "data/pinned/sim-evaluators"), { recursive: true });
    const bytes = readFileSync(path.join(REPO_ROOT, "data/pinned/sim-evaluators/v1.evaluator.json"));
    bytes[200] = bytes[200] === 0x41 ? 0x42 : 0x41;
    writeFileSync(path.join(root, "data/pinned/sim-evaluators/v1.evaluator.json"), bytes);
    copyFileSync(MANIFEST, path.join(root, "v1.json"));
    expect(() => loadEvaluator(path.join(root, "v1.json"), layout.sha256, { root, modelsRoot: path.join(root, "no-models") })).toThrow(/sha256 [0-9a-f]{64}, manifest says 75a972ea6de8/);
  });

  it("refuses a runtime feature layout other than the manifest's", () => {
    expect(() => loadEvaluator(MANIFEST, "f".repeat(64))).toThrow(/feature layout mismatch/);
  });

  it("the observed decision record carries no timing field", () => {
    const rec = observedRecord({ k: 3, phase: "action", actor: 1, promptKind: "mainAction", legalActionsSha256: "a".repeat(64), chosen: "pass", rngCursor: { engineDraws: 1, engineStateSha: "0123456789abcdef", botDraws: 2 }, values: [0.123456, -1] });
    const keys = (o: unknown): string[] => (o !== null && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [k, ...keys(v)]) : []);
    expect(keys(rec).filter((k) => /ms|time|wall|duration|elapsed/i.test(k))).toEqual([]);
    expect(rec.values).toEqual([0.1235, -1]);
  });

  it("no file under src/ reaches the evaluator runtime or the learned rungs (D1)", () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
    const hits = walk(path.join(REPO_ROOT, "src")).filter((f) => /sims\/evaluator|sims\/policy\/(search|learned)/.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
