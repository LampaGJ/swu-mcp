/**
 * @displayName Evaluator trainer driver
 * @strategicPurpose A captured, hashed evaluator for rungs 3 and 4; nothing is trained at query time (D1, D3).
 * @tacticalObjective Verifies the pinned inputs, flattens every branch and outcome row with src/sims/features.ts, runs
 * the Python trainer, bootstraps the Brier difference against the constant model by game, decides adoption, writes the
 * weights once to the models volume and a committed manifest with a replay record.
 *
 * Usage: pnpm sims:train-evaluator --config <file> [--python <bin>] [--models-root <dir>] [--pinned-dir <dir>] [--work <dir>]
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { bootstrapCI, mean, type CI } from "../bench/stats.js";
import { isMain } from "../bench/code-commit.js";
import { codeCommit } from "../lib/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { REPO_ROOT } from "../../src/paths.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { branchManifestSchema, branchRecordSchema, rangesOverlap, type SeedRange } from "../../src/sims/branches.js";
import { featureLayout, flattenState, type FeatureLayout } from "../../src/sims/features.js";
import { modelManifestSchema } from "../../src/sims/model-manifest.js";
import { SCALAR_COUNT, STATE_LAYOUT_SHA256, U, type EncodedState } from "../../src/sims/state.js";
import { FIRST_CARD_INDEX, parseVocab } from "../../src/sims/vocab.js";
import {
  evaluatorManifestSchema,
  evaluatorWeightsSchema,
  predictionSchema,
  trainConfigSchema,
  trainingRunSchema,
  type Prediction,
  type TrainConfig,
} from "./evaluator-manifest.js";

type Split = "train" | "validation" | "test";
export interface Row {
  id: string;
  seed: number;
  split: Split;
  kind: "branch" | "outcome";
  decision: string;
  action: string | null;
  y: number;
  w: number;
  i: number[];
  v: number[];
}

const SPLITS = ["train", "validation", "test"] as const;
/** Dense weights up to this size are also committed beside the manifest, so #127 runs without the models volume. */
const PINNED_WEIGHTS_MAX_BYTES = 1_000_000;
const ladderSchema = z.strictObject({ ranges: z.array(z.strictObject({ name: z.string().min(1), range: z.strictObject({ from: z.int().min(0), count: z.int().positive() }) })) });
const NO_CI: CI = { value: null, low: null, high: null, n: 0 };

const abs = (p: string): string => path.resolve(REPO_ROOT, p);
const fileSha = (file: string): string => sha256Hex(readFileSync(file));
function verify(file: string, expect: string | undefined): string {
  const got = fileSha(abs(file));
  if (expect !== undefined && got !== expect) throw new Error(`${file}: sha256 ${got}, config expects ${expect}`);
  return got;
}
/** A capture is written once: identical bytes pass (a replay), different bytes are refused. */
function writeOnce(dest: string, bytes: Buffer): void {
  if (existsSync(dest) && !readFileSync(dest).equals(bytes)) throw new Error(`${dest} exists with different bytes; refusing to overwrite (a new capture needs a new evaluatorVersion)`);
  if (!existsSync(dest)) writeFileSync(dest, bytes);
}

export async function verifyInputs(cfg: TrainConfig) {
  const datasetSha = verify(cfg.dataset.manifest, cfg.dataset.expectSha256);
  const vocabFileSha = verify(cfg.vocab.file, cfg.vocab.expectSha256);
  const dataset = branchManifestSchema.parse(JSON.parse(readFileSync(abs(cfg.dataset.manifest), "utf8")));
  if (!dataset.trainingEligible) throw new Error(`${cfg.dataset.manifest}: trainingEligible is false (continuations below a ladder-passed rung, #125, D95); refusing to train`);
  const recordsSha = verify(cfg.dataset.records, dataset.outputs.gzSha256);
  const vocab = parseVocab(JSON.parse(readFileSync(abs(cfg.vocab.file), "utf8")));
  if (vocab.contentSha256 !== dataset.vocab.contentSha256)
    throw new Error(`${cfg.vocab.file}: contentSha256 ${vocab.contentSha256}, the dataset was encoded with ${dataset.vocab.contentSha256}`);
  if (dataset.state.layoutSha256 !== STATE_LAYOUT_SHA256) throw new Error(`${cfg.dataset.manifest}: state layout ${dataset.state.layoutSha256}, this code encodes ${STATE_LAYOUT_SHA256}`);
  const inventory = modelManifestSchema.parse(JSON.parse(readFileSync(abs(cfg.inventoryManifest), "utf8")));
  if (inventory.evaluationSeedRange === null) throw new Error(`${cfg.inventoryManifest}: #123 has not reserved evaluationSeedRange; refusing to train`);
  const excluded: { source: string; range: SeedRange }[] = [{ source: "#123 evaluationSeedRange", range: inventory.evaluationSeedRange }];
  if (cfg.ladderSeedRanges !== null)
    for (const r of ladderSchema.parse(JSON.parse(readFileSync(abs(cfg.ladderSeedRanges), "utf8"))).ranges) excluded.push({ source: `#129 ${r.name}`, range: r.range });
  for (const name of SPLITS) {
    const range = cfg.splits[name];
    for (const e of excluded) if (rangesOverlap(range, e.range)) throw new Error(`${name} seeds ${range.from}+${range.count} overlap ${e.source} ${e.range.from}+${e.range.count}`);
    const want = dataset.source.splits[name];
    if (range.from !== want.from || range.count !== want.count)
      throw new Error(`${name} seeds ${range.from}+${range.count} differ from the dataset manifest's source.splits ${want.from}+${want.count}`);
  }
  const layout = featureLayout(SCALAR_COUNT, U, vocab.keys.length + FIRST_CARD_INDEX, vocab.contentSha256);
  return { datasetSha, recordsSha, vocabFileSha, dataset, vocab, inventory, excluded, layout };
}

export async function buildRows(cfg: TrainConfig, recordsPath: string, layout: FeatureLayout, expectedRecords: number | null = null) {
  const splitOf = (seed: number): Split | null => SPLITS.find((s) => seed >= cfg.splits[s].from && seed < cfg.splits[s].from + cfg.splits[s].count) ?? null;
  const rows: Row[] = [];
  const games = new Set<number>();
  const testGames = new Set<number>();
  let decisions = 0;
  const draws = { branchContinuations: 0, outcomeRows: 0 };
  const skipped = { afterTerminal: 0, noContinuation: 0, nullSourceOutcome: 0 };
  const p = progress("train-evaluator", { everyN: 500, total: expectedRecords });
  const lines = createInterface({ input: createReadStream(abs(recordsPath)).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line === "") continue;
    const r = branchRecordSchema.parse(JSON.parse(line));
    const id = `${r.gameId}|${r.k}`;
    const checkVocab = (s: EncodedState): void => {
      if (s.vocabSha256 !== layout.vocabSha256) throw new Error(`${id}: vocabSha256 ${s.vocabSha256} differs from the vocabulary ${layout.vocabSha256}`);
    };
    checkVocab(r.state);
    const split = splitOf(r.seed);
    if (split === null) throw new Error(`${id}: source seed ${r.seed} is in no split range`);
    decisions++;
    games.add(r.seed);
    if (split === "test") testGames.add(r.seed);
    const row = (rowId: string, kind: Row["kind"], action: string | null, y: number, w: number, s: EncodedState): Row => {
      checkVocab(s);
      const f = flattenState(s, layout);
      return { id: rowId, seed: r.seed, split, kind, decision: id, action, y, w, i: f.indices, v: f.values };
    };
    if (r.sourceOutcome === null) skipped.nullSourceOutcome++;
    else {
      if (r.sourceOutcome === 0.5) draws.outcomeRows++;
      rows.push(row(`${id}|root`, "outcome", null, r.sourceOutcome, 1, r.state));
    }
    const KN = r.determinization.K * r.determinization.N;
    for (const a of r.legalActions) {
      if (a.afterState === null) skipped.afterTerminal++;
      else if (a.mean === null || a.n === 0) skipped.noContinuation++;
      else {
        draws.branchContinuations += a.nDraw;
        rows.push(row(`${id}|${a.descriptor}`, "branch", a.descriptor, a.mean, a.n / KN, a.afterState));
      }
    }
    p.tick(decisions, { phase: "rows", rows: rows.length });
  }
  p.log({ phase: "rows-done", decisions, rows: rows.length });
  rows.sort((x, y) => compareCodePoints(x.id, y.id));
  return { rows, decisions, games: games.size, testGames: testGames.size, draws, skipped };
}

/** Game-clustered percentile bootstrap of the mean per-game Brier difference (candidate minus constant). */
export function brierDiffCI(preds: readonly Prediction[], kind: string, rowKind: Prediction["kind"], cfg: TrainConfig): CI {
  const perGame = new Map<number, { d: number; w: number }>();
  for (const r of preds) {
    if (r.kind !== rowKind) continue;
    const g = perGame.get(r.seed) ?? { d: 0, w: 0 };
    g.d += r.w * ((r.p[kind] - r.y) ** 2 - (r.p.constant - r.y) ** 2);
    g.w += r.w;
    perGame.set(r.seed, g);
  }
  const values = [...perGame.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g.d / g.w);
  return values.length === 0 ? NO_CI : bootstrapCI(values, mean, { iterations: cfg.bootstrap.iterations, seed: `${cfg.bootstrap.seed}|${kind}|${rowKind}` });
}

export interface RunOptions {
  config: string;
  python: string;
  modelsRoot: string;
  pinnedDir: string;
  work?: string;
}

/** Returns the exit code: 0 after a capture (adopted or not), 3 below the dataset floor. */
export async function run(opts: RunOptions): Promise<number> {
  const configBytes = readFileSync(abs(opts.config));
  const cfg = trainConfigSchema.parse(JSON.parse(configBytes.toString("utf8")));
  const inputs = await verifyInputs(cfg);
  const { layout, vocab, dataset, inventory, excluded } = inputs;
  const work = opts.work ?? path.join(REPO_ROOT, "tmp", "train-evaluator", cfg.evaluatorVersion);
  mkdirSync(work, { recursive: true });
  const built = await buildRows(cfg, cfg.dataset.records, layout, dataset.outputs.records);
  if (built.decisions < cfg.floor.minDecisions || built.games < cfg.floor.minSourceGames || built.testGames < cfg.floor.minTestGames) {
    writeFileSync(path.join(work, "below-floor.json"), `${canonicalJson({ floor: cfg.floor, decisions: built.decisions, sourceGames: built.games, testGames: built.testGames })}\n`);
    console.error(`below the dataset floor: ${built.decisions} decisions, ${built.games} games, ${built.testGames} test games; no evaluator trained`);
    return 3;
  }
  const rowsPath = path.join(work, "rows.jsonl"); // out: no emitter schema for rows.jsonl or resolved.json, both derive from parsed records and config and train_evaluator.py range-checks every row
  writeFileSync(rowsPath, built.rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const resolvedPath = path.join(work, "resolved.json");
  writeFileSync(resolvedPath, canonicalJson({ ...cfg, featureWidth: layout.width, featureLayoutSha256: layout.sha256 }));
  const env = { ...process.env, OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1", VECLIB_MAXIMUM_THREADS: "1", PYTHONHASHSEED: "0", TMPDIR: path.join(REPO_ROOT, "tmp") };
  const p = progress("train-evaluator", {});
  p.log({ phase: "trainer", rows: built.rows.length, detail: "reports/.progress/train-evaluator-py.json" });
  const trainer = spawnSync(opts.python, [path.join(REPO_ROOT, "scripts/sims/py/train_evaluator.py"), "--rows", rowsPath, "--config", resolvedPath, "--out", work], { stdio: "inherit", env, cwd: REPO_ROOT });
  if (trainer.status !== 0) throw new Error(`trainer exited with ${trainer.status}${trainer.error ? `: ${trainer.error.message}` : ""}`);

  const trainingRunPath = path.join(work, "training-run.json");
  const tr = trainingRunSchema.parse(JSON.parse(readFileSync(trainingRunPath, "utf8")));
  if (tr.featureLayoutSha256 !== layout.sha256 || tr.featureWidth !== layout.width) throw new Error("training-run.json names another feature layout");
  const preds = readFileSync(path.join(work, "test-predictions.jsonl"), "utf8").trim().split("\n").map((l) => predictionSchema.parse(JSON.parse(l)));
  const chosen = tr.candidates.find((c) => c.kind === tr.chosen);
  if (!chosen) throw new Error(`training-run.json names ${tr.chosen} but has no such candidate`);
  for (const c of tr.candidates) {
    const bytes = readFileSync(path.join(work, c.evaluatorFile));
    if (sha256Hex(bytes) !== c.evaluatorSha256) throw new Error(`${c.evaluatorFile}: sha256 differs from training-run.json`);
    const w = evaluatorWeightsSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (w.featureLayoutSha256 !== layout.sha256 || w.featureWidth !== layout.width) throw new Error(`${c.evaluatorFile}: feature layout differs from the driver's`);
  }
  const hasOutcome = preds.some((r) => r.kind === "outcome");
  const intervals = Object.fromEntries(
    tr.candidates
      .filter((c) => c.kind !== "constant")
      .map((c) => [c.kind, { branch: brierDiffCI(preds, c.kind, "branch", cfg), outcome: hasOutcome ? brierDiffCI(preds, c.kind, "outcome", cfg) : NO_CI }]),
  );
  const bootstrap = { outcomeBrierDiff: intervals[chosen.kind].outcome, branchBrierDiff: intervals[chosen.kind].branch };
  const ece = chosen.test.branch.ece;
  const below = (c: CI): boolean => c.high !== null && c.high < 0;
  const gates = {
    branch: below(bootstrap.branchBrierDiff),
    outcome: !hasOutcome || below(bootstrap.outcomeBrierDiff),
    ece: ece !== null && ece <= cfg.maxEce,
  };
  const adopted = gates.branch && gates.outcome && gates.ece;
  const ciText = (c: CI): string => `${c.value} [${c.low}, ${c.high}] over ${c.n} games`;
  const reason = adopted
    ? `${chosen.kind} adopted: test branch Brier difference ${ciText(bootstrap.branchBrierDiff)} and outcome ${ciText(bootstrap.outcomeBrierDiff)} lie below zero, branch ECE ${ece} <= ${cfg.maxEce}`
    : `no evaluator adopted: ${chosen.kind} (lowest validation branch log loss) failed ${Object.entries(gates)
        .filter(([, ok]) => !ok)
        .map(([g]) => g)
        .join(", ")}; branch Brier difference ${ciText(bootstrap.branchBrierDiff)}, outcome ${ciText(bootstrap.outcomeBrierDiff)}, branch ECE ${ece} (gate ${cfg.maxEce})`;

  const rel = path.join("swu-mcp", cfg.evaluatorVersion);
  const dest = path.join(opts.modelsRoot, rel);
  mkdirSync(dest, { recursive: true });
  const lock = path.join(REPO_ROOT, "scripts/sims/py/requirements-train.lock");
  const sources: [string, string][] = [
    [path.join(work, chosen.evaluatorFile), "evaluator.json"],
    [trainingRunPath, "training-run.json"],
    [lock, "requirements-train.lock"],
    [abs(opts.config), "train-config.json"],
  ];
  if (chosen.kind === "mlp") sources.push([path.join(work, "train-weights.safetensors"), "train-weights.safetensors"]);
  if (chosen.kind === "xgboost") sources.push([path.join(work, "xgboost.json"), "xgboost.json"]);
  const files = sources.map(([src, name]) => {
    const bytes = readFileSync(src);
    writeOnce(path.join(dest, name), bytes);
    return { path: path.join(rel, name), sha256: sha256Hex(bytes), bytes: bytes.length };
  });
  const report = path.join(dest, "run-report.json");
  if (!existsSync(report)) writeFileSync(report, readFileSync(path.join(work, "run-report.json")));

  mkdirSync(opts.pinnedDir, { recursive: true });
  const relRepo = (p: string): string => path.relative(REPO_ROOT, p).split(path.sep).join("/");
  let pinnedWeights: { path: string; sha256: string } | null = null;
  if (chosen.kind !== "xgboost" && files[0].bytes <= PINNED_WEIGHTS_MAX_BYTES) {
    const pinnedPath = path.join(opts.pinnedDir, `${cfg.evaluatorVersion}.evaluator.json`);
    writeFileSync(pinnedPath, readFileSync(path.join(work, chosen.evaluatorFile)));
    pinnedWeights = { path: relRepo(pinnedPath), sha256: files[0].sha256 };
  }
  const reuse = [...inventory.entries]
    .sort((a, b) => compareCodePoints(a.path, b.path))
    .map((m) => ({
      path: m.path,
      sha256: m.sha256,
      verdict: "rejected" as const,
      reason: `#123 verdict ${m.verdict}, reason ${m.reason}, d22 ${m.d22}, provenance ${m.provenance}; quarantined under D52 and D93, so no metric is recorded (D22)`,
    }));
  if (reuse.some((r) => !r.reason.includes("d22 quarantined"))) throw new Error("an inventory model is d22 clear: file the matched-position comparison follow-up (#126) before capturing");
  const inputHash = sha256Hex(
    canonicalJson({
      dataset: inputs.datasetSha,
      records: inputs.recordsSha,
      vocab: vocab.contentSha256,
      stateLayout: STATE_LAYOUT_SHA256,
      featureLayout: layout.sha256,
      config: cfg,
      lock: fileSha(lock),
    }),
  );
  const manifest = evaluatorManifestSchema.parse({
    formatVersion: 1,
    evaluatorVersion: cfg.evaluatorVersion,
    kind: chosen.kind,
    adopted,
    reason,
    files,
    pinnedWeights,
    config: { path: relRepo(abs(opts.config)), sha256: sha256Hex(configBytes) },
    trainingRunSha256: fileSha(trainingRunPath),
    featureLayoutSha256: layout.sha256,
    featureWidth: layout.width,
    stateLayoutSha256: STATE_LAYOUT_SHA256,
    vocabSha256: vocab.contentSha256,
    dataset: {
      manifestSha256: inputs.datasetSha,
      recordsSha256: inputs.recordsSha,
      determinizationLevel: `${dataset.determinization.mode} K${dataset.parameters.K} N${dataset.parameters.N}`,
      continuationRung: dataset.continuationPolicy.rung,
      decisions: built.decisions,
      sourceGames: built.games,
      testGames: built.testGames,
      branchRows: built.rows.filter((r) => r.kind === "branch").length,
      outcomeRows: built.rows.filter((r) => r.kind === "outcome").length,
      draws: built.draws,
      skipped: built.skipped,
    },
    splits: cfg.splits,
    excludedRanges: excluded,
    ladderRangesChecked: cfg.ladderSeedRanges !== null,
    test: chosen.test,
    bootstrap,
    reuse,
    replay: { inputHash, codeCommit: codeCommit(["scripts/sims", "src/sims"]), outputHash: files[0].sha256 },
  });
  writeFileSync(path.join(opts.pinnedDir, `${cfg.evaluatorVersion}.json`), `${canonicalJson(manifest)}\n`);
  writeFileSync(path.join(opts.pinnedDir, `${cfg.evaluatorVersion}.md`), reportMarkdown(cfg, tr, intervals, manifest));
  p.done({ adopted, kind: chosen.kind });
  console.log(reason);
  return 0;
}

function reportMarkdown(
  cfg: TrainConfig,
  tr: z.infer<typeof trainingRunSchema>,
  intervals: Record<string, { branch: CI; outcome: CI }>,
  m: z.infer<typeof evaluatorManifestSchema>,
): string {
  const ci = (c: CI | undefined): string => (c === undefined || c.value === null ? "n/a" : `${c.value} (95% interval ${c.low} to ${c.high}, ${c.n} games)`);
  const met = (x: { brier: number | null; logLoss: number | null; ece: number | null; n: number }): string => `Brier ${x.brier}, log loss ${x.logLoss}, ECE ${x.ece} (n ${x.n})`;
  const lines = [
    `# Evaluator ${cfg.evaluatorVersion}`,
    "",
    "Generated by `pnpm sims:train-evaluator`; do not edit by hand. Every number is bot play (D21): labels are continuation outcomes under the dataset's",
    `rung ${m.dataset.continuationRung} pilot (${m.dataset.determinizationLevel}), never pooled with tournament data.`,
    "",
    `Adopted: ${m.adopted}. ${m.reason}.`,
    "",
    `Feature layout ${m.featureLayoutSha256}, width ${m.featureWidth}. Dataset manifest ${m.dataset.manifestSha256}: ${m.dataset.decisions} decisions from ${m.dataset.sourceGames} source games (${m.dataset.testGames} in the test range), ${m.dataset.branchRows} branch rows and ${m.dataset.outcomeRows} outcome rows.`,
    `Seed splits: train ${cfg.splits.train.from}+${cfg.splits.train.count}, validation ${cfg.splits.validation.from}+${cfg.splits.validation.count}, test ${cfg.splits.test.from}+${cfg.splits.test.count}. Rows per split: train ${tr.counts.train.rows} (${tr.counts.train.games} games), validation ${tr.counts.validation.rows} (${tr.counts.validation.games}), test ${tr.counts.test.rows} (${tr.counts.test.games}).`,
    "",
    "## Candidates",
    "",
    ...tr.candidates.flatMap((c) => [
      `- ${c.kind} (${Object.entries(c.hyperparameters)
        .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("-") : v}`)
        .join(", ")}), evaluator sha256 ${c.evaluatorSha256}`,
      `  - validation branch: ${met(c.validation.branch)}; validation outcome: ${met(c.validation.outcome)}`,
      `  - test branch: ${met(c.test.branch)}; test outcome: ${met(c.test.outcome)}`,
      `  - test rank agreement: top-1 ${c.rankAgreement.top1} over ${c.rankAgreement.decisions} decisions, mean Spearman ${c.rankAgreement.spearman} over ${c.rankAgreement.spearmanDecisions}`,
      ...(c.kind === "constant" ? [] : [`  - test Brier difference against constant: branch ${ci(intervals[c.kind]?.branch)}; outcome ${ci(intervals[c.kind]?.outcome)}`]),
    ]),
    `- XGBoost: ${tr.xgboost.trained ? "trained" : "not trained"}, ${tr.xgboost.reason}.`,
    "",
    "## Learning curve (logistic, test branch rows)",
    "",
    ...tr.learningCurve.map((l) => `- ${l.games} training games (${l.fraction * 100}%): Brier ${l.brier}, log loss ${l.logLoss}.`),
    "",
    "## Existing models considered (#123)",
    "",
    "Every model in data/pinned/sim-models/manifest.json is rejected with #123's reason; none is clear under D22, so no metric of any of them appears here, and the constant model is the baseline (D52, D93).",
    "",
    ...m.reuse.map((r) => `- ${r.path} (sha256 ${r.sha256 ?? "missing"}): ${r.verdict}; ${r.reason}.`),
    "",
    "## Replay",
    "",
    `inputHash ${m.replay.inputHash}, codeCommit ${m.replay.codeCommit}, outputHash ${m.replay.outputHash}. Rerun with \`pnpm sims:train-evaluator --config ${m.config.path}\` and compare the evaluator.json sha256.`,
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: "string" }, python: { type: "string" }, "models-root": { type: "string" }, "pinned-dir": { type: "string" }, work: { type: "string" } },
  });
  if (!values.config) throw new Error("--config is required");
  const code = await run({
    config: values.config,
    python: values.python ?? process.env.SWU_SIMS_PYTHON ?? path.join(REPO_ROOT, ".venv/bin/python"),
    modelsRoot: values["models-root"] ?? process.env.SWU_MODELS_ROOT ?? "/Volumes/Models/swu",
    pinnedDir: abs(values["pinned-dir"] ?? "data/pinned/sim-evaluators"),
    work: values.work === undefined ? undefined : abs(values.work),
  });
  process.exitCode = code;
}

if (isMain(import.meta.url)) await main();
