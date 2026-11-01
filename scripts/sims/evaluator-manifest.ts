/**
 * @displayName Evaluator file schemas
 * @strategicPurpose Trust boundary for every evaluator artifact the trainer emits and the runtime (#127) loads, so a
 * truncated weight blob, a shifted layout or an overlapping seed range is a parse error, not a silent misprediction.
 * @tacticalObjective Zod v4 schemas for the train config, evaluator.json, training-run.json, the trainer's test
 * predictions and the committed evaluator manifest.
 */
import { z } from "zod";
import { hex64 } from "../../src/schemas/hash.js";
import { rangesOverlap, seedRangeSchema } from "../../src/sims/branches.js";

const b64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, { error: "expected base64" });
/** Bytes a base64 string decodes to, without decoding it. */
const b64Bytes = (s: string): number => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0);
export const KINDS = ["constant", "logistic", "mlp", "xgboost"] as const;
const kind = z.enum(KINDS);
const device = z.enum(["gpu", "cpu"]);
export const SCALINGS = ["rms", "none"] as const;
const repoPath = z.string().min(1);

export const trainConfigSchema = z
  .strictObject({
    evaluatorVersion: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, { error: "lowercase letters, digits, dots and dashes" }),
    seed: z.int().min(0),
    dataset: z.strictObject({ manifest: repoPath, records: repoPath, expectSha256: hex64.optional() }),
    vocab: z.strictObject({ file: repoPath, expectSha256: hex64.optional() }),
    inventoryManifest: repoPath,
    ladderSeedRanges: repoPath.nullable(),
    splits: z.strictObject({ train: seedRangeSchema, validation: seedRangeSchema, test: seedRangeSchema }),
    floor: z.strictObject({ minDecisions: z.int().positive(), minSourceGames: z.int().positive(), minTestGames: z.int().positive() }),
    outcomeWeightGrid: z.array(z.number().min(0).max(1)).min(1),
    /** Column scaling searched with the logistic grid on validation: 1 / RMS over training rows, or none. */
    scalingGrid: z.array(z.enum(SCALINGS)).min(1),
    logistic: z.strictObject({ cGrid: z.array(z.number().positive()).min(1), tol: z.number().positive(), maxIter: z.int().positive() }),
    mlp: z.strictObject({
      device,
      hidden: z.array(z.int().positive()).min(1).max(3),
      learningRate: z.number().positive(),
      betas: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
      weightDecay: z.number().min(0),
      batchSize: z.int().positive(),
      maxEpochs: z.int().positive(),
      patience: z.int().positive(),
    }),
    xgboost: z.strictObject({
      enabled: z.boolean(),
      /** XGBoost trains only when the MLP's validation branch log loss is not at least this far below logistic's. */
      minMlpGain: z.number().min(0),
      rounds: z.int().positive(),
      maxDepth: z.int().positive(),
      eta: z.number().positive(),
      minChildWeight: z.number().min(0),
      lambda: z.number().min(0),
    }),
    bootstrap: z.strictObject({ iterations: z.int().positive(), seed: z.string().min(1) }),
    maxEce: z.number().positive(),
  })
  .superRefine((c, ctx) => {
    const r = c.splits;
    if (rangesOverlap(r.train, r.validation) || rangesOverlap(r.train, r.test) || rangesOverlap(r.validation, r.test))
      ctx.addIssue({ code: "custom", message: "split seed ranges must be pairwise disjoint", path: ["splits"] });
  });
export type TrainConfig = z.infer<typeof trainConfigSchema>;

const layerSchema = z.strictObject({ in: z.int().positive(), out: z.int().positive(), weight: b64, bias: b64 });
const denseSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.enum(["constant", "logistic", "mlp"]),
  featureLayoutSha256: hex64,
  featureWidth: z.int().positive(),
  /** float32 little-endian, base64; every input column is multiplied by its scale before the first layer. */
  scale: b64,
  activation: z.literal("relu"),
  layers: z.array(layerSchema).min(1),
});
const treeSchema = z.strictObject({
  formatVersion: z.literal(1),
  kind: z.literal("xgboost"),
  featureLayoutSha256: hex64,
  featureWidth: z.int().positive(),
  model: z.strictObject({ file: z.string().min(1), sha256: hex64 }),
});
export const evaluatorWeightsSchema = z.discriminatedUnion("kind", [denseSchema, treeSchema]).superRefine((w, ctx) => {
  if (w.kind === "xgboost") return;
  if (b64Bytes(w.scale) !== 4 * w.featureWidth) ctx.addIssue({ code: "custom", message: `scale holds ${b64Bytes(w.scale)} bytes, expected ${4 * w.featureWidth}`, path: ["scale"] });
  w.layers.forEach((l, i) => {
    const want = i === 0 ? w.featureWidth : w.layers[i - 1].out;
    if (l.in !== want) ctx.addIssue({ code: "custom", message: `layer ${i} input ${l.in}, expected ${want}`, path: ["layers", i, "in"] });
    if (b64Bytes(l.weight) !== 4 * l.in * l.out) ctx.addIssue({ code: "custom", message: `layer ${i} weight holds ${b64Bytes(l.weight)} bytes, expected ${4 * l.in * l.out}`, path: ["layers", i, "weight"] });
    if (b64Bytes(l.bias) !== 4 * l.out) ctx.addIssue({ code: "custom", message: `layer ${i} bias holds ${b64Bytes(l.bias)} bytes, expected ${4 * l.out}`, path: ["layers", i, "bias"] });
  });
  if (w.layers[w.layers.length - 1].out !== 1) ctx.addIssue({ code: "custom", message: "last layer must have one output", path: ["layers"] });
});
export type EvaluatorWeights = z.infer<typeof evaluatorWeightsSchema>;

const num = z.number().nullable();
const metricsSchema = z.strictObject({ brier: num, logLoss: num, ece: num, n: z.int().min(0) });
const splitMetricsSchema = z.strictObject({ branch: metricsSchema, outcome: metricsSchema });
const splitCount = z.strictObject({ rows: z.int().min(0), branchRows: z.int().min(0), outcomeRows: z.int().min(0), games: z.int().min(0) });
const hyperparameter = z.union([z.number(), z.string(), z.array(z.number())]);
export const trainingRunSchema = z.strictObject({
  formatVersion: z.literal(1),
  evaluatorVersion: z.string().min(1),
  seed: z.int().min(0),
  device,
  featureLayoutSha256: hex64,
  featureWidth: z.int().positive(),
  environment: z.record(z.string(), z.string().nullable()),
  counts: z.strictObject({ train: splitCount, validation: splitCount, test: splitCount }),
  logisticSearch: z.array(z.strictObject({ scaling: z.enum(SCALINGS), outcomeWeight: z.number(), C: z.number(), iterations: z.int().min(0), validationBranchLogLoss: num })),
  candidates: z.array(
    z.strictObject({
      kind,
      hyperparameters: z.record(z.string(), hyperparameter),
      evaluatorFile: z.string().min(1),
      evaluatorSha256: hex64,
      validation: splitMetricsSchema,
      test: splitMetricsSchema,
      rankAgreement: z.strictObject({ top1: num, spearman: num, decisions: z.int().min(0), spearmanDecisions: z.int().min(0) }),
    }),
  ),
  xgboost: z.strictObject({ trained: z.boolean(), reason: z.string().min(1) }),
  learningCurve: z.array(z.strictObject({ fraction: z.number(), games: z.int().min(0), brier: num, logLoss: num })),
  chosen: kind,
});
export type TrainingRun = z.infer<typeof trainingRunSchema>;

export const predictionSchema = z.strictObject({
  id: z.string().min(1),
  seed: z.int(),
  kind: z.enum(["branch", "outcome"]),
  y: z.number().min(0).max(1),
  w: z.number().positive(),
  p: z.record(z.string(), z.number().min(0).max(1)),
});
export type Prediction = z.infer<typeof predictionSchema>;

const ci = z.strictObject({ value: num, low: num, high: num, n: z.int().min(0) });
const fileEntry = z.strictObject({ path: z.string().min(1), sha256: hex64, bytes: z.int().positive() });
export const evaluatorManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  evaluatorVersion: z.string().min(1),
  kind,
  adopted: z.boolean(),
  reason: z.string().min(1),
  /** Paths relative to the models root (SWU_MODELS_ROOT, default /Volumes/Models/swu); files[0] is evaluator.json. */
  files: z.array(fileEntry).min(1),
  /** A repo copy of evaluator.json for dense weights small enough to commit, byte-identical to files[0]; null otherwise. */
  pinnedWeights: z.strictObject({ path: repoPath, sha256: hex64 }).nullable(),
  config: z.strictObject({ path: repoPath, sha256: hex64 }),
  trainingRunSha256: hex64,
  featureLayoutSha256: hex64,
  featureWidth: z.int().positive(),
  stateLayoutSha256: hex64,
  vocabSha256: hex64,
  dataset: z.strictObject({
    manifestSha256: hex64,
    recordsSha256: hex64,
    determinizationLevel: z.string().min(1),
    continuationRung: z.int().min(0),
    decisions: z.int().min(0),
    sourceGames: z.int().min(0),
    testGames: z.int().min(0),
    branchRows: z.int().min(0),
    outcomeRows: z.int().min(0),
    /** Draw and timeout continuations inside the branch labels (each scored 0.5), and outcome rows labelled 0.5. */
    draws: z.strictObject({ branchContinuations: z.int().min(0), outcomeRows: z.int().min(0) }),
    skipped: z.strictObject({ afterTerminal: z.int().min(0), noContinuation: z.int().min(0), nullSourceOutcome: z.int().min(0) }),
  }),
  splits: z.strictObject({ train: seedRangeSchema, validation: seedRangeSchema, test: seedRangeSchema }),
  excludedRanges: z.array(z.strictObject({ source: z.string().min(1), range: seedRangeSchema })),
  ladderRangesChecked: z.boolean(),
  test: splitMetricsSchema,
  bootstrap: z.strictObject({ outcomeBrierDiff: ci, branchBrierDiff: ci }),
  reuse: z.array(z.strictObject({ path: z.string().min(1), sha256: hex64.nullable(), verdict: z.enum(["adopted", "baseline", "rejected"]), reason: z.string().min(1) })),
  replay: z.strictObject({ inputHash: hex64, codeCommit: z.string().min(7), outputHash: hex64 }),
});
export type EvaluatorManifest = z.infer<typeof evaluatorManifestSchema>;
