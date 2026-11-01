/**
 * @displayName sims:summary condensed view
 * @strategicPurpose The small, versioned answer to "what are the simulations doing" for a schickso plugin and a
 * TerminalWidget provider (#179 of #104, D100).
 * @tacticalObjective Reads the same heartbeats as sims:watch (the main checkout and every linked worktree), builds the
 * summary src/sims/summary.ts defines and prints it: `--json` the schemaVersion 1 document, `--text` (the default) at most
 * 5 lines of 60 characters. Exit 0 with an empty jobs list when nothing ran recently; exit 2 when it cannot read the
 * repo or the summary fails its own schema. A viewer: it writes nothing and emits no progress. It reads the clock because
 * it reports heartbeat ages; it produces no data product.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/sims/summary.ts [--json | --text]
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { isAlive, listSources } from "../../src/sims/sources.js";
import { renderSummaryText, summarize } from "../../src/sims/summary.js";
import { discoverJobs } from "../../src/sims/watch.js";

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false }, text: { type: "boolean", default: false } } });
  if (values.json === true && values.text === true) {
    process.stderr.write("sims:summary: pass --json or --text, not both\n");
    return 2;
  }
  if (!existsSync(path.join(REPO_ROOT, "package.json"))) {
    process.stderr.write("sims:summary: cannot read the repository\n");
    return 2;
  }
  const sources = await listSources(REPO_ROOT);
  const nowMs = Date.now();
  const { jobs } = discoverJobs(sources, nowMs, isAlive);
  const summary = summarize({ jobs, repo: path.basename((sources.find((s) => s.main === true) ?? sources[0]).root), nowMs });
  process.stdout.write(values.json === true ? `${JSON.stringify(summary, null, 2)}\n` : `${renderSummaryText(summary).join("\n")}\n`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  process.stderr.write(`sims:summary: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
