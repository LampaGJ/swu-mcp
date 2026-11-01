import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runInventory } from "../../scripts/sims/inventory-models.js";
import { xgbParity } from "../../scripts/sims/model-parity.js";
import { parseForest, predictForest } from "../../src/sims/forest.js";
import { modelManifestSchema } from "../../src/sims/model-manifest.js";
import { parseBaseScore, parseXgb, predictXgb } from "../../src/sims/xgb.js";
import { sha256Hex } from "../../src/swu/canonical.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CREDENTIAL_KEYS = /pushover|shellfish/i;
const METRIC_KEYS = ["accuracy", "brier", "brierScore", "logLoss", "auc", "loss", "ece"];
const FAKE = "FAKE-CREDENTIAL-SHOULD-NEVER-APPEAR";
const node = (i: number[], c: number[], l: number[], r: number[], d: number[]) => ({
  split_indices: i,
  split_conditions: c,
  left_children: l,
  right_children: r,
  default_left: d,
  loss_changes: [1, 0, 0],
});
const tinyXgb = (n = 500): unknown => ({
  learner: {
    learner_model_param: { base_score: "[5E-1]", num_feature: String(n) },
    objective: { name: "binary:logistic" },
    gradient_booster: {
      name: "gbtree",
      model: {
        trees: [
          node([0, 0, 0], [0.5, -0.2, 0.3], [1, -1, -1], [2, -1, -1], [1, 0, 0]),
          node([1, 0, 0], [2, 0.1, -0.1], [1, -1, -1], [2, -1, -1], [0, 0, 0]),
        ],
      },
    },
  },
});
const leaf = (prediction: number) => ({ type: "leaf", prediction, samples: 1 });
const tinyForest = (
  trees: unknown[] = [{ type: "split", featureIndex: 1, threshold: 0.5, left: leaf(0.2), right: leaf(0.9) }],
  subsets = [[3, 594]],
) => ({
  type: "random_forest",
  training: { objective: "binary_win" },
  data: { trees, featureSubsets: subsets },
});
const vec = (set: Record<number, number | null>, n = 500): (number | null)[] =>
  Array.from({ length: n }, (_, i) => (i in set ? set[i] : 0));
const sig = (m: number): number => 1 / (1 + Math.exp(-m));

describe("loaders", () => {
  const model = parseXgb(tinyXgb());
  it("XGBoost: bracketed base_score, x < split left, a tie right, missing along default_left, width checked", () => {
    expect(parseBaseScore("[5.4579264E-1]")).toBeCloseTo(0.54579264, 8);
    expect(predictXgb(model, vec({ 0: 0.4, 1: 1 }))).toBeCloseTo(sig(Math.fround(-0.2) + Math.fround(0.1)), 6);
    expect(predictXgb(model, vec({ 0: 0.5, 1: 2 }))).toBeCloseTo(sig(Math.fround(0.3) + Math.fround(-0.1)), 6);
    expect(predictXgb(model, vec({ 0: null, 1: null }))).toBeCloseTo(sig(Math.fround(-0.2) + Math.fround(-0.1)), 6);
    expect(() => predictXgb(model, vec({}, 499))).toThrow(/500 features, got 499/);
  });
  it("forest: projects through featureSubsets, sends a tie left, names a broken tree", () => {
    const forest = parseForest(tinyForest());
    expect(forest.numFeatures).toBe(595);
    expect(predictForest(forest, vec({ 594: 0.5 }, 595) as number[])).toBe(0.2);
    expect(predictForest(forest, vec({ 594: 0.6 }, 595) as number[])).toBe(0.9);
    const broken = tinyForest([leaf(0.5), { type: "split", featureIndex: 0, threshold: 1, left: leaf(0.1) }], [[0], [1]]);
    expect(() => parseForest(broken)).toThrow(/forest tree 1/);
  });
});

function syntheticVolume() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sims-inventory-"));
  const root = path.join(dir, "swu");
  const put = (rel: string, value: unknown): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), typeof value === "string" ? value : JSON.stringify(value));
  };
  const iter = "iterative-training/models/model-iter-1-2026-01-01T00-10-00.json";
  put("models/human-trained/xgboost-model.json", tinyXgb());
  put("models/human-trained/rf-filtered-100k.json", tinyForest([leaf(1), leaf(1)], [[0], [1]]));
  put("iterative-training/checkpoint.json", { config: { pushover: true, pushoverApp: FAKE, pushoverUser: FAKE, shellfish: true } });
  put(iter, tinyForest());
  put("iterative-training/data/iter-1-2026-01-01T00-00-00-metadata.json", {
    rolloutPolicy: "ml",
    config: { mlRollout: "/x/models/human-trained/xgboost-model.json", pushover: true, note: FAKE },
  });
  const row = (o: object): string => JSON.stringify(o);
  put(
    "manifests/training-runs.jsonl",
    [
      row({
        id: "run-a",
        model_output: path.join(root, iter),
        training_files: [],
        hyperparams: { objective: "binary_win" },
        metrics: { accuracy: 0.7 },
      }),
      row({ id: "run-b", model_output: path.join(dir, "gone.json"), training_files: [], hyperparams: { objective: "q_value" } }),
      "not json",
    ].join("\n"),
  );
  const out = path.join(dir, "out");
  const opts = {
    root,
    producer: path.join(dir, "none"),
    out: path.join(out, "pinned"),
    doc: path.join(out, "none.md"),
    report: path.join(out, "report"),
    parity: false,
  };
  return { out, opts };
}

describe("inventory walk on a synthetic volume", () => {
  it("classifies, counts missing and bad rows, and fences everything human-derived", () => {
    const m = runInventory(syntheticVolume().opts);
    expect(modelManifestSchema.parse(m)).toEqual(m);
    expect(m.counts).toMatchObject({ manifestRows: 3, manifestOutputsMissing: 1, badManifestRows: 1, clear: 0 });
    const by = new Map(m.entries.map((e) => [path.basename(e.path), e]));
    expect(by.get("xgboost-model.json")).toMatchObject({
      format: "xgboost-json",
      provenance: "human-games",
      d22: "quarantined",
      parity: "not-run",
    });
    expect(by.get("rf-filtered-100k.json")).toMatchObject({ verdict: "unreusable", reason: "constant-prediction" });
    expect(by.get("model-iter-1-2026-01-01T00-10-00.json")).toMatchObject({
      provenance: "bot-games-human-rollout",
      featureLayout: "core500+plugins",
    });
    expect(by.get("checkpoint.json")).toMatchObject({ format: "checkpoint-json", verdict: "not-scored", parity: "not-applicable" });
    expect(by.get("gone.json")).toMatchObject({ verdict: "missing", sha256: null, parity: "not-applicable" });
    expect(by.get("rf-filtered-100k.json")).toMatchObject({ parity: "not-run" });
  });

  it("keeps credentials and metrics out of committed outputs, metrics in the report, and replays to the same outputHash", () => {
    const { out, opts } = syntheticVolume();
    const first = runInventory(opts);
    expect(runInventory(opts).replay.outputHash).toBe(first.replay.outputHash);
    for (const file of ["pinned/manifest.json", "pinned/README.md", "report/recorded-metrics.json"]) {
      const text = readFileSync(path.join(out, file), "utf8");
      expect(text.includes(FAKE)).toBe(false);
      expect(CREDENTIAL_KEYS.test(text)).toBe(false);
    }
    const keys = new Set(first.entries.flatMap((e) => Object.keys(e)));
    expect(METRIC_KEYS.filter((k) => keys.has(k))).toEqual([]);
    expect(readFileSync(path.join(out, "report/recorded-metrics.json"), "utf8")).toContain("accuracy");
  });
});

const committed = [
  "data/pinned/sim-models/manifest.json",
  "data/pinned/sim-models/README.md",
  "docs/research/existing-models-inventory.md",
];
describe.skipIf(!existsSync(path.join(REPO_ROOT, committed[0])))("committed inventory outputs", () => {
  it("parse and carry no credential key name", () => {
    const manifest = modelManifestSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, committed[0]), "utf8")));
    const keys = new Set(manifest.entries.flatMap((e) => Object.keys(e)));
    expect(METRIC_KEYS.filter((k) => keys.has(k))).toEqual([]);
    expect(manifest.counts.clear).toBe(0);
    for (const file of committed.filter((f) => existsSync(path.join(REPO_ROOT, f)))) {
      expect(CREDENTIAL_KEYS.test(readFileSync(path.join(REPO_ROOT, file), "utf8"))).toBe(false);
    }
  });
});

describe.skipIf(!existsSync(path.join(REPO_ROOT, ".venv/bin/python")))("Booster parity", () => {
  it("matches Booster.predict within 1e-6 on 64 vectors", () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "sims-parity-")), "tiny.json");
    const bytes = JSON.stringify(tinyXgb(3));
    writeFileSync(file, bytes);
    expect(xgbParity(file, sha256Hex(bytes), parseXgb(JSON.parse(bytes))).ok).toBe(true);
  });
});
