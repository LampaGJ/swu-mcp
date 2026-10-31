import { z } from "zod";
import { hex64 } from "./hash.js";

/**
 * @displayName Cluster label table
 * @strategicPurpose Shape of data/cluster-labels.json, the human role names for the similarity clusters
 * (LampaGJ/swu-mcp#64). The names are a captured model output (D3): written once by a model pass, committed, and
 * read here as a pinned input. Each entry carries the hash of the member set it was written for, so a re-clustering
 * that reuses an id for different cards shows up as stale instead of mislabelling.
 * @tacticalObjective Strict schema for the file that `scripts/similarity/label-clusters.ts` writes and checks and that
 * `deck_audit` reads.
 */

export const CLUSTER_LABELS_VERSION = 1;

export const clusterLabelEntrySchema = z.strictObject({
  id: z.number().int().nonnegative(),
  membersSha256: hex64,
  size: z.number().int().positive(),
  tokenLabel: z.string(),
  label: z.string().trim().min(1, { error: "label is empty" }),
});

export const clusterLabelsFileSchema = z
  .strictObject({
    labelsVersion: z.literal(CLUSTER_LABELS_VERSION),
    capturedAt: z.iso.date(),
    capturedBy: z.string().min(1),
    note: z.string().min(1),
    labels: z.array(clusterLabelEntrySchema),
  })
  .refine((file) => new Set(file.labels.map((entry) => entry.id)).size === file.labels.length, { error: "cluster ids repeat" });

export type ClusterLabelEntry = z.infer<typeof clusterLabelEntrySchema>;
export type ClusterLabelsFile = z.infer<typeof clusterLabelsFileSchema>;
