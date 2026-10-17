/**
 * @displayName Card scoring script
 * @strategicPurpose Manipulation node: feature output, card rows and committed coefficients in;
 * scores.json and its replay record out, byte-identical on a rerun.
 * @tacticalObjective Applies src/scorer to every card in the package. The coefficients are read from
 * data/rubric-coefficients.json and never fitted here.
 *
 * Usage: pnpm score [--data <package dir>] [--coefficients <file>] [--out <dir>]
 *   --data  default: newest dated dir under data/runs (SWU_MCP_DATA wins)
 *   --out   default: <data>/scores
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveDataDir } from "../src/data.js";
import { runScoring } from "../src/scorer/run.js";
import { codeCommit } from "./lib/code-commit.js";
import { REPO_ROOT } from "../src/paths.js";


function main(): void {
  const { values } = parseArgs({ options: { data: { type: "string" }, coefficients: { type: "string" }, out: { type: "string" } } });
  const dataDir = path.resolve(values.data ?? resolveDataDir());
  const coefficientsFile = path.resolve(values.coefficients ?? path.join(REPO_ROOT, "data/rubric-coefficients.json"));
  const outDir = path.resolve(values.out ?? path.join(dataDir, "scores"));

  const run = runScoring(dataDir, readFileSync(coefficientsFile, "utf8"), codeCommit(["src", "scripts", "data/rubric-coefficients.json", "package.json"]));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "scores.json"), run.scoresText);
  writeFileSync(path.join(outDir, "replay.json"), run.replayText);
  console.log(JSON.stringify({ outDir, scored: run.replay.scoredCards, outputHash: run.replay.outputHash, codeCommit: run.replay.codeCommit }, null, 1));
}

main();
