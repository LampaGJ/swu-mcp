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
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolveDataDir } from "../src/data.js";
import { runScoring } from "../src/scorer/run.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function codeCommit(): string {
  const git = (args: string[]): string => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  const dirty = git(["status", "--porcelain", "--", "src", "scripts", "data/rubric-coefficients.json", "package.json"]) === "" ? "" : "-dirty";
  return `${git(["rev-parse", "HEAD"])}${dirty}`;
}

function main(): void {
  const { values } = parseArgs({ options: { data: { type: "string" }, coefficients: { type: "string" }, out: { type: "string" } } });
  const dataDir = path.resolve(values.data ?? resolveDataDir());
  const coefficientsFile = path.resolve(values.coefficients ?? path.join(REPO_ROOT, "data/rubric-coefficients.json"));
  const outDir = path.resolve(values.out ?? path.join(dataDir, "scores"));

  const run = runScoring(dataDir, readFileSync(coefficientsFile, "utf8"), codeCommit());
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "scores.json"), run.scoresText);
  writeFileSync(path.join(outDir, "replay.json"), run.replayText);
  console.log(JSON.stringify({ outDir, scored: run.replay.scoredCards, outputHash: run.replay.outputHash, codeCommit: run.replay.codeCommit }, null, 1));
}

main();
