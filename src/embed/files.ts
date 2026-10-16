import { z } from "zod";
import { hex64 } from "./pinned.js";

/**
 * @displayName Similarity run files
 * @strategicPurpose Shapes of the files `pnpm similarity` writes and the MCP tools read, so the tools parse
 * what arrives instead of trusting it.
 * @tacticalObjective Schemas for similar.json, kin.json, clusters.json, vectors.json and replay.json.
 */

const neighbour = z.tuple([z.string(), z.number()]);

export const neighboursFileSchema = z.strictObject({
  edge: z.enum(["similar", "kin"]),
  meaning: z.string(),
  rendering: z.enum(["ability", "abstract"]),
  renderVersion: z.number().int(),
  limit: z.number().int(),
  minCosine: z.number().nullable(),
  cards: z.record(z.string(), z.array(neighbour)),
});
export type NeighboursFile = z.infer<typeof neighboursFileSchema>;

export const clustersFileSchema = z.strictObject({
  renderVersion: z.number().int(),
  k: z.number().int(),
  seed: z.number().int(),
  restarts: z.number().int(),
  maxIter: z.number().int(),
  inertia: z.number(),
  clusters: z.array(z.strictObject({ id: z.number().int(), size: z.number().int(), label: z.string(), members: z.array(z.string()) })),
});
export type ClustersFile = z.infer<typeof clustersFileSchema>;

export const vectorsFileSchema = z.strictObject({
  renderVersion: z.number().int(),
  rendering: z.literal("ability"),
  model: z.string(),
  fullDims: z.number().int(),
  dims: z.number().int(),
  dtype: z.literal("int8"),
  scale: z.number(),
  decode: z.string(),
  cards: z.record(z.string(), z.string()),
});
export type VectorsFile = z.infer<typeof vectorsFileSchema>;

export const similarityReplaySchema = z.strictObject({
  codeCommit: z.string(),
  renderVersion: z.number().int(),
  capture: z.string(),
  inputHash: z.strictObject({ capture: hex64, "ability.f32": hex64, "abstract.f32": hex64, cards: hex64 }),
  params: z.strictObject({
    similarLimit: z.number().int(),
    similarMinCosine: z.number(),
    kinLimit: z.number().int(),
    k: z.number().int(),
    seed: z.number().int(),
    restarts: z.number().int(),
    maxIter: z.number().int(),
    mrlDims: z.number().int(),
  }),
  outputHash: z.record(z.string(), hex64),
});
export type SimilarityReplay = z.infer<typeof similarityReplaySchema>;
