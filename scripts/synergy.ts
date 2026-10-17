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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildSynergyRun } from "../src/synergy/run.js";
import { codeCommit } from "./lib/code-commit.js";
import { newestDatedDir } from "./lib/originals.js";
import { progress } from "./lib/progress.mjs";
import { REPO_ROOT } from "../src/paths.js";


function newestFeatures(): string {
  const runs = path.join(REPO_ROOT, "data/runs");
  return path.join(newestDatedDir(runs, "run"), "features/features.json");
}

function main(): void {
  const { values } = parseArgs({ options: { features: { type: "string" }, table: { type: "string" }, out: { type: "string" } } });
  const featuresPath = path.resolve(values.features ?? newestFeatures());
  const tablePath = path.resolve(values.table ?? path.join(REPO_ROOT, "data/complementarity.json"));
  const outDir = path.resolve(values.out ?? path.join(path.dirname(path.dirname(featuresPath)), "synergy"));
  const p = progress("synergy", { everyN: 1 });
  p.log({ phase: "build", featuresPath });
  const run = buildSynergyRun(readFileSync(featuresPath, "utf8"), readFileSync(tablePath, "utf8"), codeCommit(["src", "scripts", "data/complementarity.json"]));
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
