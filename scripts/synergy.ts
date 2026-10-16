/**
 * @displayName SWU synergy script
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#3, ported from mault#325): card features plus
 * the committed complementarity table in; pairs, trios, fungibility classes and a replay record out,
 * replayable from the pinned inputs to identical bytes.
 * @tacticalObjective Reads data/runs/<date>/features/features.json (from `pnpm card-features`).
 *
 * Usage: pnpm synergy [--features <features.json>] [--table <complementarity.json>] [--out <dir>]
 *   --features  default: newest data/runs/<date>/features/features.json
 *   --table     default: <repo>/data/complementarity.json
 *   --out       default: data/runs/<date>/synergy next to the features directory
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildSynergyRun } from "../src/synergy/index.js";
import { compareCodePoints } from "../src/swu/canonical.js";
import { progress } from "./lib/progress.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATED_DIR = /^\d{4}-\d{2}-\d{2}$/;

function newestFeatures(): string {
  const runs = path.join(REPO_ROOT, "data/runs");
  const newest = readdirSync(runs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATED_DIR.test(e.name))
    .map((e) => e.name)
    .sort(compareCodePoints)
    .at(-1);
  if (newest === undefined) throw new Error(`no dated run under ${runs}; run "pnpm card-features" first`);
  return path.join(runs, newest, "features/features.json");
}

function codeCommit(): string {
  const git = (args: string[]): string => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  const dirty = git(["status", "--porcelain", "--", "src", "scripts", "data/complementarity.json"]) === "" ? "" : "-dirty";
  return `${git(["rev-parse", "HEAD"])}${dirty}`;
}

function main(): void {
  const { values } = parseArgs({ options: { features: { type: "string" }, table: { type: "string" }, out: { type: "string" } } });
  const featuresPath = path.resolve(values.features ?? newestFeatures());
  const tablePath = path.resolve(values.table ?? path.join(REPO_ROOT, "data/complementarity.json"));
  const outDir = path.resolve(values.out ?? path.join(path.dirname(path.dirname(featuresPath)), "synergy"));
  const p = progress("synergy", { everyN: 1 });
  p.log({ phase: "build", featuresPath });
  const run = buildSynergyRun(readFileSync(featuresPath, "utf8"), readFileSync(tablePath, "utf8"), codeCommit());
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(run.files)) writeFileSync(path.join(outDir, name), content);
  const r = run.report as Record<string, unknown>;
  p.done({ pairs: r.pairs });
  const slim = { ...r, examplePairs: undefined, topTrios: undefined };
  console.log(JSON.stringify({ outDir, ...slim, replay: run.replay }, null, 1));
  const failed = (r.exampleChecks as { row: string; matches: boolean }[]).filter((c) => !c.matches);
  if (failed.length > 0) {
    console.error(`example pairs that do not match their row: ${failed.map((f) => f.row).join(", ")}`);
    process.exitCode = 3;
  }
}

main();
