import { existsSync } from "node:fs";
import path from "node:path";
import { readJson } from "../data.js";
import { REPO_ROOT } from "../paths.js";
import { clusterLabelsFileSchema, type ClusterLabelsFile } from "../schemas/cluster-labels.js";
import { compareCodePoints, sha256Hex } from "../swu/canonical.js";
import type { ClustersFile } from "./files.js";

/**
 * @displayName Cluster labels
 * @strategicPurpose Joins the pinned human role names (data/cluster-labels.json, a captured model output under D3)
 * to the clusters of the loaded similarity run, only where the cluster still holds the cards the name was written for
 * (LampaGJ/swu-mcp#64).
 * @tacticalObjective Hashes a cluster's member set, loads and memoises the label file, and reports per cluster whether
 * its label is pinned, stale (members changed) or missing (no file).
 */

export const DEFAULT_CLUSTER_LABELS_PATH = path.join(REPO_ROOT, "data/cluster-labels.json");

export type LabelStatus = "pinned" | "stale" | "unlabelled";

/** Ids repeat across re-clusterings, so the name is keyed by the member set, never by the id alone. */
export function membersSha256(members: readonly string[]): string {
  return sha256Hex([...members].sort(compareCodePoints).join("\n"));
}

const loaded = new Map<string, ClusterLabelsFile>();

/** Null when the file is absent; a present but malformed file throws, because it is a foreign-data seam. */
export function loadClusterLabels(file = DEFAULT_CLUSTER_LABELS_PATH): ClusterLabelsFile | null {
  const hit = loaded.get(file);
  if (hit !== undefined) return hit;
  if (!existsSync(file)) return null;
  const parsed = clusterLabelsFileSchema.parse(readJson(file));
  loaded.set(file, parsed);
  return parsed;
}

export interface ResolvedLabel {
  label: string;
  labelStatus: LabelStatus;
}

export function resolveClusterLabel(cluster: ClustersFile["clusters"][number], labels: ClusterLabelsFile | null): ResolvedLabel {
  if (labels === null) return { label: cluster.label, labelStatus: "unlabelled" };
  const entry = labels.labels.find((candidate) => candidate.id === cluster.id);
  if (entry === undefined || entry.membersSha256 !== membersSha256(cluster.members)) return { label: cluster.label, labelStatus: "stale" };
  return { label: entry.label, labelStatus: "pinned" };
}
