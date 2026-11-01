/**
 * @displayName Existing-model inventory manifest
 * @strategicPurpose The memory rule says reuse a trained model before training a new one; this manifest pins, by
 * hash and provenance only, every model file already on /Volumes/Models/swu, so a reuse decision cites bytes and a
 * D22 class instead of a filename.
 * @tacticalObjective Zod v4 schemas for the committed manifest (hashes, formats, provenance, verdict enums, no
 * metric), the feature map, the pick-only views of the foreign files the walk reads, and the parity vectors exchanged
 * with the Python Booster.
 */
import { z } from "zod";
import { hex64 } from "../schemas/hash.js";

export const formatSchema = z.enum(["xgboost-json", "rf-json", "mlx-npz", "checkpoint-json", "summary-json", "other"]);
export const objectiveSchema = z.enum(["binary_win", "q_value", "loss_prevention", "unknown"]);
export const layoutSchema = z.enum(["core500", "core500+plugins", "legacy360", "phase3-583", "unknown"]);
export const provenanceSchema = z.enum([
  "bot-games",
  "bot-games-unproven-decks",
  "bot-games-human-rollout",
  "human-games",
  "human-inferred",
  "unknown",
]);
export const verdictSchema = z.enum(["reusable", "unreusable", "not-scored", "missing"]);
/** Loader parity against the original runtime: not-run when it applies but was not checked (no --parity, no .venv, or an earlier verdict). */
export const paritySchema = z.enum(["passed", "failed", "not-run", "not-applicable"]);
/** Committed reasons are enums: a measured share or metric of a quarantined model never enters a committed file. */
export const reasonSchema = z.enum([
  "none",
  "constant-prediction",
  "feature-schema-unrecoverable",
  "unavailable-gain-share-over-threshold",
  "different-target",
  "format-not-scorable",
  "quarantined-d22",
  "file-missing",
  "loader-parity-failed",
  "awaiting-fresh-batch",
]);
export const seedRangeSchema = z.strictObject({ from: z.int().min(0), count: z.int().positive() });
export const replaySchema = z.strictObject({ inputHash: hex64, codeCommit: z.string().min(7), outputHash: hex64 });

export const manifestEntrySchema = z
  .strictObject({
    path: z.string().min(1),
    sha256: hex64.nullable(),
    bytes: z.int().min(0).nullable(),
    format: formatSchema,
    objective: objectiveSchema,
    numFeatures: z.int().positive().nullable(),
    featureLayout: layoutSchema,
    runId: z.string().min(1).nullable(),
    producer: z
      .strictObject({
        project: z.string().min(1),
        script: z.string().min(1).nullable(),
        repoCommit: z.string().min(7).nullable(),
        confidence: z.enum(["confirmed", "inferred"]),
      })
      .nullable(),
    provenance: provenanceSchema,
    d22: z.enum(["clear", "quarantined"]),
    verdict: verdictSchema,
    reason: reasonSchema,
    parity: paritySchema,
  })
  .refine((e) => (e.verdict === "reusable") === (e.reason === "none"), { error: "reason is none exactly when the verdict is reusable" })
  .refine((e) => e.d22 === "quarantined" || e.provenance === "bot-games", { error: "only bot-games provenance may be d22 clear" })
  .refine((e) => (e.verdict === "missing") === (e.sha256 === null), { error: "sha256 is null exactly when the file is missing" })
  .refine((e) => (e.parity === "failed") === (e.reason === "loader-parity-failed"), {
    error: "reason is loader-parity-failed exactly when parity failed",
  })
  .refine((e) => e.verdict !== "reusable" || e.parity === "passed", { error: "a reusable model must have passed loader parity" });
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const modelManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  root: z.literal("SWU_MODELS_ROOT"),
  producerRepo: z.strictObject({ path: z.string().min(1), head: z.string().min(7).nullable() }),
  counts: z.strictObject({
    entries: z.int().min(0),
    manifestRows: z.int().min(0),
    manifestOutputsPresent: z.int().min(0),
    manifestOutputsMissing: z.int().min(0),
    badManifestRows: z.int().min(0),
    clear: z.int().min(0),
    quarantined: z.int().min(0),
  }),
  evaluationSeedRange: seedRangeSchema.nullable(),
  entries: z.array(manifestEntrySchema),
  replay: replaySchema,
});
export type ModelManifest = z.infer<typeof modelManifestSchema>;

export const featureTierSchema = z.enum(["exact", "derived", "embedding", "unavailable"]);
export const featureMapSchema = z.strictObject({
  schemaVersion: z.literal(1),
  harness: z.strictObject({ path: z.string().min(1), repoCommit: z.string().min(7) }),
  coreCount: z.int().positive(),
  columns: z.array(z.strictObject({ index: z.int().min(0), name: z.string().min(1), tier: featureTierSchema, rule: z.string().min(1) })),
  replay: replaySchema,
});

// Pick-only views. z.object (not strictObject) on purpose, a documented exception to CLAUDE.md:68: these foreign
// files carry a `config` block with notification settings, and stripping every unnamed key at the boundary is what
// keeps that block out of every value, error and output this code produces.
export const trainingRunRowPick = z.object({
  id: z.string().min(1),
  model_output: z.string().min(1),
  training_files: z.array(z.string().min(1)),
  hyperparams: z.object({ objective: z.string().optional() }).optional(),
});
export const sessionMetadataPick = z.object({
  rolloutPolicy: z.string().optional(),
  config: z.object({ mlRollout: z.string().optional() }).optional(),
});

export const parityFileSchema = z.strictObject({
  modelSha256: hex64,
  xgboostVersion: z.string().min(1),
  vectors: z.array(z.array(z.number().nullable())),
  booster: z.array(z.number().min(0).max(1)),
});
