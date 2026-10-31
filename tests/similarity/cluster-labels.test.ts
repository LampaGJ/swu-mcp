import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadClusterLabels, membersSha256, resolveClusterLabel } from "../../src/embed/cluster-labels.js";
import type { ClustersFile } from "../../src/embed/files.js";
import { clusterLabelsFileSchema, type ClusterLabelsFile } from "../../src/schemas/cluster-labels.js";
import { checkLabels, loadClusters, templateOf } from "../../scripts/similarity/label-clusters.js";

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/similarity/label-clusters.ts");
const PINNED_RUN = process.env.SWU_MCP_DATA ?? path.resolve(import.meta.dirname, "../../data/runs/2026-10-30");
const COMMITTED = path.resolve(import.meta.dirname, "../../data/cluster-labels.json");

const clusters: ClustersFile = {
  renderVersion: 1,
  k: 2,
  seed: 1,
  restarts: 1,
  maxIter: 1,
  inertia: 0,
  clusters: [
    { id: 1, size: 3, label: "kw:Raid(100%)", members: ["c", "a", "b"] },
    { id: 0, size: 2, label: "type:Base(41%)", members: ["y", "x"] },
  ],
};

function labelsFor(source: ClustersFile, overrides: Partial<Record<number, { membersSha256?: string; label?: string }>> = {}): ClusterLabelsFile {
  return {
    labelsVersion: 1,
    capturedAt: "2026-10-30",
    capturedBy: "test",
    note: "test fixture",
    labels: source.clusters.map((c) => ({
      id: c.id,
      membersSha256: overrides[c.id]?.membersSha256 ?? membersSha256(c.members),
      size: c.size,
      tokenLabel: c.label,
      label: overrides[c.id]?.label ?? `human ${c.id}`,
    })),
  };
}

function scratchDir(): string {
  const root = path.join(tmpdir(), "swu-cluster-labels-test");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, "t-"));
}

describe("clusterLabelsFileSchema", () => {
  it("accepts a well-formed file", () => {
    expect(clusterLabelsFileSchema.safeParse(labelsFor(clusters)).success).toBe(true);
  });

  it("rejects an empty or blank label", () => {
    expect(clusterLabelsFileSchema.safeParse(labelsFor(clusters, { 0: { label: "" } })).success).toBe(false);
    expect(clusterLabelsFileSchema.safeParse(labelsFor(clusters, { 0: { label: "   " } })).success).toBe(false);
  });

  it("rejects a hash that is not 64 lowercase hex characters", () => {
    for (const bad of ["abc", "G".repeat(64), "A".repeat(64), "a".repeat(63)]) {
      expect(clusterLabelsFileSchema.safeParse(labelsFor(clusters, { 0: { membersSha256: bad } })).success).toBe(false);
    }
  });

  it("rejects unknown keys, a wrong version and repeated ids", () => {
    const good = labelsFor(clusters);
    expect(clusterLabelsFileSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(clusterLabelsFileSchema.safeParse({ ...good, labelsVersion: 2 }).success).toBe(false);
    expect(clusterLabelsFileSchema.safeParse({ ...good, labels: [good.labels[0], good.labels[0]] }).success).toBe(false);
  });
});

describe("membersSha256", () => {
  it("does not depend on member order and does change with the member set", () => {
    expect(membersSha256(["c", "a", "b"])).toBe(membersSha256(["a", "b", "c"]));
    expect(membersSha256(["a", "b"])).not.toBe(membersSha256(["a", "b", "c"]));
    expect(membersSha256(["a", "b"])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("resolveClusterLabel", () => {
  const cluster = clusters.clusters[0];

  it("returns the human label when the member hash matches", () => {
    expect(resolveClusterLabel(cluster, labelsFor(clusters))).toEqual({ label: "human 1", labelStatus: "pinned" });
  });

  it("returns the token label and stale when the members changed", () => {
    const stale = labelsFor(clusters, { 1: { membersSha256: membersSha256(["a", "b"]) } });
    expect(resolveClusterLabel(cluster, stale)).toEqual({ label: "kw:Raid(100%)", labelStatus: "stale" });
  });

  it("returns the token label and stale when the file has no entry for the id", () => {
    const onlyZero = { ...labelsFor(clusters), labels: labelsFor(clusters).labels.filter((l) => l.id === 0) };
    expect(resolveClusterLabel(cluster, onlyZero)).toEqual({ label: "kw:Raid(100%)", labelStatus: "stale" });
  });

  it("returns the token label and unlabelled when there is no file", () => {
    expect(resolveClusterLabel(cluster, null)).toEqual({ label: "kw:Raid(100%)", labelStatus: "unlabelled" });
  });
});

describe("loadClusterLabels", () => {
  it("is null for a missing file and throws for a malformed one", () => {
    const dir = scratchDir();
    expect(loadClusterLabels(path.join(dir, "absent.json"))).toBeNull();
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...labelsFor(clusters), labels: [{ id: 0, membersSha256: "nope", size: 1, tokenLabel: "t", label: "" }] }));
    expect(() => loadClusterLabels(bad)).toThrow();
  });

  it("parses and memoises a valid file", () => {
    const file = path.join(scratchDir(), "labels.json");
    writeFileSync(file, JSON.stringify(labelsFor(clusters)));
    const first = loadClusterLabels(file);
    expect(first?.labels).toHaveLength(2);
    expect(loadClusterLabels(file)).toBe(first);
  });
});

describe("label-clusters script", () => {
  it("writes a template sorted by id with empty labels and the member-set hashes", () => {
    const template = templateOf(clusters, "2026-10-30") as { labelsVersion: number; capturedAt: string; labels: Record<string, unknown>[] };
    expect(template.labelsVersion).toBe(1);
    expect(template.capturedAt).toBe("2026-10-30");
    expect(template.labels).toEqual([
      { id: 0, membersSha256: membersSha256(["x", "y"]), size: 2, tokenLabel: "type:Base(41%)", label: "" },
      { id: 1, membersSha256: membersSha256(["a", "b", "c"]), size: 3, tokenLabel: "kw:Raid(100%)", label: "" },
    ]);
  });

  it("checks clean when every hash matches, and names the stale, missing, empty and unknown ids otherwise", () => {
    expect(checkLabels(labelsFor(clusters), clusters)).toEqual([]);
    const stale = labelsFor(clusters, { 1: { membersSha256: membersSha256(["z"]) } });
    expect(checkLabels(stale, clusters)).toEqual([expect.stringContaining("cluster 1: stale")]);
    const missing = { ...labelsFor(clusters), labels: labelsFor(clusters).labels.slice(0, 1) };
    expect(checkLabels(missing, clusters)).toEqual([expect.stringContaining("cluster 0: no entry")]);
    const extra = { ...labelsFor(clusters), labels: [...labelsFor(clusters).labels, { ...labelsFor(clusters).labels[0], id: 9 }] };
    expect(checkLabels(extra, clusters)).toEqual([expect.stringContaining("cluster 9: not in the run")]);
    expect(checkLabels(labelsFor(clusters, { 0: { label: "" } }), clusters)[0]).toContain("does not parse");
  });

  it("exits non-zero naming the stale ids and zero when the file is current", () => {
    const dir = scratchDir();
    mkdirSync(path.join(dir, "run/similarity"), { recursive: true });
    writeFileSync(path.join(dir, "run/similarity/clusters.json"), JSON.stringify(clusters));
    const run = (out: string): { status: number; stderr: string } => {
      try {
        execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--run", path.join(dir, "run"), "--out", out, "--check"], { stdio: "pipe" });
        return { status: 0, stderr: "" };
      } catch (error) {
        const failure = error as { status: number; stderr: Buffer };
        return { status: failure.status, stderr: failure.stderr.toString() };
      }
    };
    const current = path.join(dir, "current.json");
    writeFileSync(current, JSON.stringify(labelsFor(clusters)));
    expect(run(current).status).toBe(0);
    const stale = path.join(dir, "stale.json");
    writeFileSync(stale, JSON.stringify(labelsFor(clusters, { 0: { membersSha256: membersSha256(["q"]) } })));
    const failed = run(stale);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("cluster 0: stale");
  }, 30_000);
});

describe.skipIf(!existsSync(path.join(PINNED_RUN, "similarity/clusters.json")))("committed labels against the pinned run", () => {
  it("--check passes: all 32 clusters present, every hash current, no empty label", () => {
    const real = loadClusters(PINNED_RUN);
    expect(real.clusters).toHaveLength(32);
    const raw: unknown = JSON.parse(readFileSync(COMMITTED, "utf8"));
    expect(checkLabels(raw, real)).toEqual([]);
    const output = execFileSync(process.execPath, ["--import", "tsx", SCRIPT, "--run", PINNED_RUN, "--check"], { encoding: "utf8" });
    expect(output).toContain("32 clusters");
  }, 30_000);

  it("resolves every pinned cluster to its human label", () => {
    const labels = loadClusterLabels();
    expect(labels).not.toBeNull();
    for (const cluster of loadClusters(PINNED_RUN).clusters) {
      expect(resolveClusterLabel(cluster, labels).labelStatus).toBe("pinned");
    }
  });
});
