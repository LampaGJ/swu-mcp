import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { seededRandom } from "../../scripts/bench/stats.js";
import { evaluatorWeightsSchema, trainConfigSchema, trainingRunSchema } from "../../scripts/sims/evaluator-manifest.js";
import { buildRows, run, verifyInputs } from "../../scripts/sims/train-evaluator.js";
import { aggregateAction } from "../../src/sims/branches.js";
import { featureLayout } from "../../src/sims/features.js";
import { encodeState, SCALAR_COUNT, U } from "../../src/sims/state.js";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import { compileVocab, FIRST_CARD_INDEX, parseVocab } from "../../src/sims/vocab.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PY = process.env.SWU_SIMS_PYTHON ?? path.join(ROOT, ".venv/bin/python");
const EXAMPLE = path.join(ROOT, "scripts/sims/train-evaluator.config.example.json");
const example = (): Record<string, any> => JSON.parse(readFileSync(EXAMPLE, "utf8"));
const vocab = parseVocab(JSON.parse(readFileSync(path.join(ROOT, "data/pinned/sim-vocab/2026-10-30.r6.v2.json"), "utf8")));
const state = encodeState(JSON.parse(readFileSync(path.join(ROOT, "tests/fixtures/sims/state-views/basic.json"), "utf8")), compileVocab(vocab));
const layout = featureLayout(SCALAR_COUNT, U, vocab.keys.length + FIRST_CARD_INDEX, vocab.contentSha256);

const action = (descriptor: string, outcomes: ("win" | "loss" | "draw")[]) => ({ descriptor, kind: "play", cardKey: null, ...aggregateAction([outcomes]), afterState: state, afterTerminal: "none" as const });
const record = (seed: number, k: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  gameId: String(seed),
  seed,
  k,
  round: 3,
  phase: "action",
  actor: 1,
  promptKind: "mainAction",
  state,
  legalActions: [action("attack|a", ["win", "draw"]), action("pass", ["loss", "loss"])],
  chosen: { descriptor: "pass", index: 1 },
  sourceOutcome: 1,
  rngCursor: "1:abc:1",
  rootMatched: true,
  determinization: { mode: "multiset", K: 1, N: 2 },
  ...over,
});

function scratch(name: string): string {
  const dir = path.join(ROOT, "tmp", "test-train-evaluator", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writeGz(dir: string, records: Record<string, unknown>[]): string {
  const file = path.join(dir, "branches.jsonl.gz");
  writeFileSync(file, gzipSync(Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n")));
  return file;
}
function writeConfig(dir: string, cfg: Record<string, unknown>): string {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  return file;
}

describe("train-evaluator driver: refusals before training", () => {
  it("parses the example config", () => {
    expect(() => trainConfigSchema.parse(example())).not.toThrow();
  });

  it("fails on a dataset expectSha256 mismatch naming the file and both hashes, before any row is built", async () => {
    const cfg = example();
    cfg.dataset.expectSha256 = "0".repeat(64);
    const actual = sha256Hex(readFileSync(path.join(ROOT, cfg.dataset.manifest)));
    await expect(verifyInputs(trainConfigSchema.parse(cfg))).rejects.toThrow(new RegExp(`${cfg.dataset.manifest}.*${actual}.*${"0".repeat(64)}`));
  });

  it("refuses a trainingEligible false manifest", async () => {
    const dir = scratch("ineligible");
    const cfg = example();
    const m = JSON.parse(readFileSync(path.join(ROOT, cfg.dataset.manifest), "utf8"));
    m.trainingEligible = false;
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
    cfg.dataset = { manifest: path.join(dir, "manifest.json"), records: cfg.dataset.records };
    await expect(verifyInputs(trainConfigSchema.parse(cfg))).rejects.toThrow(/trainingEligible is false/);
  });

  it("refuses a split overlapping #123's evaluationSeedRange", async () => {
    const cfg = example();
    cfg.splits.test = { from: 9000100, count: 90 };
    await expect(verifyInputs(trainConfigSchema.parse(cfg))).rejects.toThrow(/test seeds 9000100\+90 overlap #123 evaluationSeedRange 9000000\+2000/);
  });

  it("refuses a split that differs from the dataset manifest's source.splits", async () => {
    const cfg = example();
    cfg.splits.test = { from: 6000510, count: 89 };
    await expect(verifyInputs(trainConfigSchema.parse(cfg))).rejects.toThrow(/source\.splits/);
  });

  it("fails on a record whose vocabSha256 differs, naming the record", async () => {
    const dir = scratch("vocab");
    const file = writeGz(dir, [record(6000001, 4), record(6000002, 7, { state: { ...state, vocabSha256: "f".repeat(64) } })]);
    await expect(buildRows(trainConfigSchema.parse(example()), file, layout)).rejects.toThrow(/6000002\|7: vocabSha256 f{64} differs/);
  });

  it("fails on a record whose seed lies in no split, naming the record", async () => {
    const dir = scratch("seed");
    const file = writeGz(dir, [record(5999999, 2)]);
    await expect(buildRows(trainConfigSchema.parse(example()), file, layout)).rejects.toThrow(/5999999\|2: source seed 5999999 is in no split/);
  });

  it("builds weighted branch rows and outcome rows, draws as 0.5", async () => {
    const dir = scratch("rows");
    const file = writeGz(dir, [record(6000001, 4, { sourceOutcome: 0.5 })]);
    const built = await buildRows(trainConfigSchema.parse(example()), file, layout);
    expect(built.rows.map((r) => [r.id, r.kind, r.y, r.w])).toEqual([
      ["6000001|4|attack|a", "branch", 0.75, 1],
      ["6000001|4|pass", "branch", 0, 1],
      ["6000001|4|root", "outcome", 0.5, 1],
    ]);
    expect(built.draws).toEqual({ branchContinuations: 1, outcomeRows: 1 });
  });

  it("below the floor: exit 3, below-floor.json, no evaluator file", async () => {
    const dir = scratch("floor");
    const gz = writeGz(dir, [record(6000001, 1), record(6000510, 2)]);
    const cfg = example();
    const m = JSON.parse(readFileSync(path.join(ROOT, cfg.dataset.manifest), "utf8"));
    m.outputs.gzSha256 = sha256Hex(readFileSync(gz));
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
    cfg.dataset = { manifest: path.join(dir, "manifest.json"), records: gz };
    const code = await run({ config: writeConfig(dir, cfg), python: PY, modelsRoot: path.join(dir, "models"), pinnedDir: path.join(dir, "pinned"), work: path.join(dir, "work") });
    expect(code).toBe(3);
    expect(JSON.parse(readFileSync(path.join(dir, "work", "below-floor.json"), "utf8"))).toMatchObject({ decisions: 2, sourceGames: 2, testGames: 1 });
    expect(existsSync(path.join(dir, "models"))).toBe(false);
    expect(existsSync(path.join(dir, "pinned"))).toBe(false);
  });

  it("refuses weights whose base64 length does not match the declared shape", () => {
    const f32 = (n: number): string => Buffer.alloc(4 * n).toString("base64");
    const ok = { formatVersion: 1, kind: "logistic", featureLayoutSha256: "a".repeat(64), featureWidth: 3, scale: f32(3), activation: "relu", layers: [{ in: 3, out: 1, weight: f32(3), bias: f32(1) }] };
    expect(() => evaluatorWeightsSchema.parse(ok)).not.toThrow();
    expect(() => evaluatorWeightsSchema.parse({ ...ok, layers: [{ ...ok.layers[0], weight: f32(2) }] })).toThrow(/weight holds 8 bytes, expected 12/);
  });
});

const WIDTH = 12;
function syntheticRows(): string {
  const rnd = seededRandom("train-evaluator-fixture");
  const out: string[] = [];
  for (let r = 0; r < 200; r++) {
    const seed = r % 20;
    const split = seed < 14 ? "train" : seed < 17 ? "validation" : "test";
    const x = [0, 1, 2, 3].map(() => Math.round(rnd() * 4));
    const y = Math.round(Math.min(1, Math.max(0, 0.2 + 0.15 * x[0] - 0.05 * x[1] + 0.1 * rnd())) * 1e6) / 1e6;
    const kind = r % 4 === 0 ? "outcome" : "branch";
    out.push(JSON.stringify({ id: `g${String(seed).padStart(2, "0")}|${String(r).padStart(3, "0")}`, seed, split, kind, decision: `g${seed}|${r >> 3}`, action: kind === "branch" ? `a${r % 3}` : null, y: kind === "outcome" ? Math.round(y) : y, w: 1, i: [0, 1, 2, 3], v: x }));
  }
  return out.sort().join("\n") + "\n";
}

describe.skipIf(!existsSync(PY))("train_evaluator.py determinism (needs the sims venv at .venv or SWU_SIMS_PYTHON; skipped when absent)", () => {
  it("gives identical constant, logistic, CPU MLP and XGBoost files on two runs", () => {
    const dir = scratch("determinism");
    writeFileSync(path.join(dir, "rows.jsonl"), syntheticRows());
    const cfg: Record<string, any> = { ...example(), featureWidth: WIDTH, featureLayoutSha256: "0".repeat(64) };
    cfg.mlp = { ...cfg.mlp, device: "cpu", maxEpochs: 3 };
    cfg.xgboost = { ...cfg.xgboost, enabled: true, minMlpGain: 1000, rounds: 10 };
    writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
    const env = { ...process.env, PYTHONHASHSEED: "0", TMPDIR: path.join(ROOT, "tmp") };
    const kinds = ["constant", "logistic", "mlp", "xgboost"];
    const hashes = ["a", "b"].map((name) => {
      const out = path.join(dir, name);
      const r = spawnSync(PY, ["scripts/sims/py/train_evaluator.py", "--rows", path.join(dir, "rows.jsonl"), "--config", path.join(dir, "config.json"), "--out", out], { cwd: ROOT, env, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const tr = trainingRunSchema.parse(JSON.parse(readFileSync(path.join(out, "training-run.json"), "utf8")));
      expect(tr.candidates.map((c) => c.kind)).toEqual(kinds);
      return [...kinds.map((k) => sha256Hex(readFileSync(path.join(out, `evaluator-${k}.json`)))), sha256Hex(readFileSync(path.join(out, "xgboost.json"))), sha256Hex(readFileSync(path.join(out, "training-run.json")))];
    });
    console.log(`run a ${canonicalJson(hashes[0])}\nrun b ${canonicalJson(hashes[1])}`);
    expect(hashes[1]).toEqual(hashes[0]);
  }, 300_000);
});
