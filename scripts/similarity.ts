/**
 * @displayName Similarity script
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#2): the pinned embedding capture in; similar, kin,
 * clusters, compact vectors and a replay record out, replayable to identical bytes. No model runs here.
 * @tacticalObjective Reads data/pinned/embeddings/<renderVersion>-<inputHash12>/ (from `pnpm embed:capture`) and
 * writes data/runs/<date>/similarity/.
 *
 * Usage: pnpm similarity [--data <package dir>] [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadStore, packageDirOf, resolveDataDir } from "../src/data.js";
import { captureDirName, CAPTURE_ROOT, loadCapture } from "../src/embed/pinned.js";
import { inputHashOf, parseRenderCards, renderAll } from "../src/embed/render.js";
import { buildSimilarityRun, PARAMS } from "../src/embed/similarity-run.js";
import { codeCommit } from "./lib/code-commit.js";
import { progress } from "./lib/progress.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function main(): void {
  const { values } = parseArgs({ options: { data: { type: "string" }, out: { type: "string" } } });
  const store = loadStore(values.data === undefined ? resolveDataDir() : path.resolve(values.data));
  const cards = parseRenderCards(store.cards);
  const renderings = renderAll(cards);
  const name = captureDirName(renderings.renderVersion, inputHashOf(renderings).inputHash);
  const capture = loadCapture(path.join(REPO_ROOT, CAPTURE_ROOT, name));
  const outDir = path.resolve(values.out ?? path.join(packageDirOf(store), "similarity"));
  const p = progress("similarity", { total: PARAMS.restarts + 2, everyMs: 2000 });
  const run = buildSimilarityRun(cards, capture, name, codeCommit(["src", "scripts"]), (phase, done) => p.tick(done, { phase }));
  mkdirSync(outDir, { recursive: true });
  for (const [file, content] of Object.entries(run.files)) writeFileSync(path.join(outDir, file), content);
  writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(run.replay, null, 1)}\n`);
  p.done({ clusterSizes: run.clusterSizes });
  console.log(JSON.stringify({ outDir, clusterSizes: run.clusterSizes, replay: run.replay }, null, 1));
}

main();
