/**
 * @displayName Cluster label capture
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#64): the cluster labels in data/cluster-labels.json are a
 * captured model output (D3). A model pass read each cluster's member cards once and wrote a short role name; the
 * names are committed with the hash of the member set they were written for. No model runs here or at run time.
 * @tacticalObjective `--template` writes the skeleton (hashes, sizes, token labels, empty names) for the capture;
 * `--check` (the default) verifies the committed file against a run and exits 1 naming every stale or empty cluster.
 *
 * Usage: tsx scripts/similarity/label-clusters.ts --run <run dir> [--out data/cluster-labels.json] [--template [--date YYYY-MM-DD]] [--check]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { membersSha256 } from "../../src/embed/cluster-labels.js";
import { clustersFileSchema, type ClustersFile } from "../../src/embed/files.js";
import { REPO_ROOT } from "../../src/paths.js";
import { clusterLabelsFileSchema, CLUSTER_LABELS_VERSION, type ClusterLabelEntry } from "../../src/schemas/cluster-labels.js";

const CAPTURED_BY = "claude-sonnet-5-5 (reading each cluster's member titles, types and text from llm/cards.toon)";
const NOTE =
  "Captured model output (D3): the labels were written once by a model pass and are pinned here, never produced at run time. Each entry is valid only while membersSha256 equals the hash of the loaded run's cluster members; otherwise deck_audit falls back to tokenLabel and reports labelStatus stale.";

export function loadClusters(runDir: string): ClustersFile {
  return clustersFileSchema.parse(JSON.parse(readFileSync(path.join(runDir, "similarity/clusters.json"), "utf8")));
}

export function templateOf(clusters: ClustersFile, capturedAt: string): unknown {
  const labels = [...clusters.clusters]
    .sort((a, b) => a.id - b.id)
    .map((c) => ({ id: c.id, membersSha256: membersSha256(c.members), size: c.size, tokenLabel: c.label, label: "" }));
  return { labelsVersion: CLUSTER_LABELS_VERSION, capturedAt, capturedBy: CAPTURED_BY, note: NOTE, labels };
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

/** Empty list when the file is current for the run; otherwise one line per problem, naming the cluster id. */
export function checkLabels(raw: unknown, clusters: ClustersFile): string[] {
  const parsed = clusterLabelsFileSchema.safeParse(raw);
  if (!parsed.success) return [`file does not parse: ${z.prettifyError(parsed.error)}`];
  const byId = new Map<number, ClusterLabelEntry>(parsed.data.labels.map((entry) => [entry.id, entry]));
  const problems: string[] = [];
  for (const cluster of [...clusters.clusters].sort((a, b) => a.id - b.id)) {
    const entry = byId.get(cluster.id);
    if (entry === undefined) problems.push(`cluster ${cluster.id}: no entry`);
    else if (entry.membersSha256 !== membersSha256(cluster.members)) problems.push(`cluster ${cluster.id}: stale (membersSha256 no longer matches the run)`);
  }
  const known = new Set(clusters.clusters.map((c) => c.id));
  for (const id of [...byId.keys()].sort((a, b) => a - b)) if (!known.has(id)) problems.push(`cluster ${id}: not in the run`);
  return problems;
}

function main(): void {
  const { values } = parseArgs({
    options: { run: { type: "string" }, out: { type: "string" }, template: { type: "boolean" }, check: { type: "boolean" }, date: { type: "string" } },
  });
  if (values.run === undefined) throw new Error("--run <run dir> is required");
  if (values.template === true && values.check === true) throw new Error("--template and --check are exclusive");
  const runDir = path.resolve(values.run);
  const out = path.resolve(values.out ?? path.join(REPO_ROOT, "data/cluster-labels.json"));
  const clusters = loadClusters(runDir);

  if (values.template === true) {
    const date = z.iso.date().parse(values.date ?? path.basename(runDir));
    if (existsSync(out)) throw new Error(`${out} exists; the captured labels are never overwritten`);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, serialize(templateOf(clusters, date)));
    console.log(`wrote the skeleton for ${clusters.clusters.length} clusters to ${out}`);
    return;
  }

  const problems = checkLabels(JSON.parse(readFileSync(out, "utf8")), clusters);
  if (problems.length > 0) {
    console.error(`${out} does not match ${runDir}:\n${problems.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${out} matches ${runDir}: ${clusters.clusters.length} clusters, every hash current, no empty label`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
