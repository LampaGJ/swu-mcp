import { readFileSync } from "node:fs";
import { z } from "zod";
import { sha256Hex } from "../swu/canonical.js";

/**
 * @displayName Rubric coefficients schema
 * @strategicPurpose The scorer never fits at runtime. Every weight it applies is read from
 * data/rubric-coefficients.json, which scripts/fit-coefficients.ts writes from pinned captures.
 * This schema is the trust boundary for that file.
 * @tacticalObjective Declares the fitted vanilla curve, the designer-price models (units, events,
 * upgrades, leaders, bases), the play-calibrated model and the input hashes behind them.
 */

const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const termSchema = z.strictObject({ b: z.number(), se: z.number(), support: z.number().int().nonnegative() });
export type Term = z.infer<typeof termSchema>;

const termMap = z.record(z.string(), termSchema);

export const curveSchema = z.strictObject({
  intercept: z.number(),
  cost: z.number(),
  space: z.number(),
  unique: z.number(),
});
export type Curve = z.infer<typeof curveSchema>;

/** A linear model: intercept plus named terms; the term name prefix decides which component it feeds. */
export const linearModelSchema = z.strictObject({
  dependent: z.string(),
  n: z.number().int().positive(),
  r2: z.number(),
  intercept: termSchema,
  terms: termMap,
});
export type LinearModel = z.infer<typeof linearModelSchema>;

export const coefficientsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  rubricVersion: z.string().min(1),
  source: z.strictObject({
    rubricDoc: z.string(),
    scriptSha256: sha,
    featuresModuleSha256: sha,
    featuresJsonSha256: sha,
    cardsToonSha256: sha,
    featuresReplayInputHash: sha,
    swuStatsCapture: z.string(),
    swuStatsCaptureSha256: sha,
  }),
  vanilla: z.strictObject({ n: z.number().int().positive(), power: curveSchema, hp: curveSchema }),
  designer: z.strictObject({
    powerWeight: z.number().positive(),
    hpWeight: z.number().positive(),
    fittedPowerHpRatio: z.number(),
    statPointsPerResource: z.number().positive(),
    unit: linearModelSchema,
    event: linearModelSchema,
    upgrade: linearModelSchema,
    leader: linearModelSchema,
    base: linearModelSchema,
  }),
  play: z.strictObject({
    window: z.string(),
    games: z.number().int().positive(),
    n: z.number().int().positive(),
    r2: z.number(),
    perStatPoint: z.number().positive(),
    terms: termMap,
    cost: z.strictObject({
      fitted: z.record(z.string(), termSchema),
      applied: z.record(z.string(), z.number()),
      appliedFrom: z.number().int(),
    }),
    heldOutSpearman: z.array(z.strictObject({ heldOut: z.string(), n: z.number().int(), full: z.number(), baseline: z.number() })),
  }),
});
export type Coefficients = z.infer<typeof coefficientsSchema>;

export interface LoadedCoefficients {
  coefficients: Coefficients;
  sha256: string;
}

export function parseCoefficients(text: string): LoadedCoefficients {
  return { coefficients: coefficientsSchema.parse(JSON.parse(text)), sha256: sha256Hex(text) };
}

export function loadCoefficients(file: string): LoadedCoefficients {
  return parseCoefficients(readFileSync(file, "utf8"));
}
