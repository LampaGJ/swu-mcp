/**
 * @displayName SWU card features script
 * @strategicPurpose Manipulation node (ported from mault LampaGJ/mault#322): card rows plus the
 * committed curated table in, features.json / coverage.json / unclassified.json / replay.json out,
 * replayable from the pinned input to identical bytes.
 * @tacticalObjective Builds the logical card rows from a mault originals folder with the same
 * flattener as the data package, or reads a data-package cards.toon with --cards.
 *
 * Usage: pnpm card-features [--originals <dir>] [--cards <cards.toon>] [--curated <curated-rules.json>] [--out <dir>]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --cards      read rows from a data-package cards.toon instead of the originals
 *   --curated    default: <repo>/data/curated-rules.json
 *   --out        default: <repo>/data/runs/<date>/features
 *
 * Exit codes: 0 ok, 3 stale curated entries (outputs are still written).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { StaleCuratedEntriesError, assertNoStaleCurated, buildFeatureRun } from "../src/ability-grammar/index.js";
import { compareCodePoints } from "../src/swu/canonical.js";
import { buildLogicalCards, flattenPrinting, newFlattenIssues, splitByCurrentSets, type FlatRow } from "../src/swu/llm-flatten.js";
import { swuRawCacheManifestSchema } from "../src/swu/raw-manifest.js";
import { progress } from "./lib/progress.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";
const DATED_DIR = /^\d{4}-\d{2}-\d{2}$/;

const pageSchema = z.object({
  data: z.array(z.looseObject({ attributes: z.record(z.string(), z.unknown()) })),
  meta: z.looseObject({ pagination: z.looseObject({ total: z.number().int() }) }),
});
const toonSchema = z.object({ cards: z.array(z.record(z.string(), z.unknown())) });

function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function newestDatedDir(root: string): string {
  const newest = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DATED_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodePoints)
    .at(-1);
  if (newest === undefined) throw new Error(`no dated originals directory under ${root}`);
  return path.join(root, newest);
}

function codeCommit(): string {
  const git = (args: string[]): string => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  const dirty = git(["status", "--porcelain", "--", "src", "scripts", "data/curated-rules.json"]) === "" ? "" : "-dirty";
  return `${git(["rev-parse", "HEAD"])}${dirty}`;
}

function cardsFromOriginals(originalsDir: string, tick: (done: number) => void): { rows: FlatRow[]; runDate: string } {
  const pagesDir = path.join(originalsDir, "swu-cards/raw-pages");
  const manifest = swuRawCacheManifestSchema.parse(JSON.parse(readFileSync(path.join(pagesDir, "manifest.json"), "utf8")));
  if (!manifest.complete) throw new Error(`raw run in ${pagesDir} is not complete`);
  const issues = newFlattenIssues();
  const printings: FlatRow[] = [];
  let declaredTotal = 0;
  [...manifest.pages]
    .sort((a, b) => a.page - b.page)
    .forEach((entry, index) => {
      const name = `page-${String(entry.page).padStart(4, "0")}.json`;
      const body = readFileSync(path.join(pagesDir, name));
      if (body.length !== entry.byteLength) throw new Error(`${name}: byteLength ${body.length} != manifest ${entry.byteLength}`);
      const digest = createHash("sha256").update(body).digest("hex");
      if (digest !== entry.sha256) throw new Error(`${name}: sha256 ${digest} != manifest ${entry.sha256}`);
      const parsed = pageSchema.parse(JSON.parse(body.toString("utf8")));
      declaredTotal = parsed.meta.pagination.total;
      for (const record of parsed.data) printings.push(flattenPrinting(record, issues));
      tick(index + 1);
    });
  if (printings.length !== declaredTotal) throw new Error(`pages hold ${printings.length} records but the API declared ${declaredTotal}`);
  const logical = buildLogicalCards(printings, new Map());
  return { rows: splitByCurrentSets(logical.cards).kept, runDate: manifest.finishedAt.slice(0, 10) };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      originals: { type: "string" },
      cards: { type: "string" },
      curated: { type: "string" },
      out: { type: "string" },
    },
  });
  const p = progress("card-features", { everyN: 10 });
  let rows: readonly unknown[];
  let label: string;
  if (values.cards !== undefined) {
    rows = toonSchema.parse(decode(readFileSync(path.resolve(expandHome(values.cards)), "utf8"))).cards;
    label = "from-cards";
  } else {
    const originalsDir = path.resolve(expandHome(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT)));
    const loaded = cardsFromOriginals(originalsDir, (done) => p.tick(done, { phase: "read-pages" }));
    rows = loaded.rows;
    label = loaded.runDate;
  }
  const outDir = path.resolve(expandHome(values.out ?? path.join(REPO_ROOT, "data/runs", label, "features")));
  const curatedJson = readFileSync(path.resolve(expandHome(values.curated ?? path.join(REPO_ROOT, "data/curated-rules.json"))), "utf8");

  p.log({ phase: "extract", cards: rows.length });
  const run = buildFeatureRun(rows, curatedJson, codeCommit());
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(run.files)) writeFileSync(path.join(outDir, name), content);
  const c = run.result.coverage;
  p.done({ cards: c.cards, clauses: c.clauses, unclassified: c.unclassified });
  console.log(
    JSON.stringify(
      {
        outDir,
        cards: c.cards,
        clauses: c.clauses,
        classifiedByGrammar: c.classifiedByGrammar,
        classifiedByCurated: c.classifiedByCurated,
        unclassified: c.unclassified,
        clauseCoveragePct: c.clauseCoveragePct,
        fullyParsedPct: c.fullyParsedPct,
        contentWordCoveragePct: c.contentWordCoveragePct,
        curated: { ...c.curated, stale: c.curated.stale.length, redundant: c.curated.redundant.length },
        replay: run.replay,
      },
      null,
      1,
    ),
  );
  if (c.curated.redundant.length > 0) console.error(`redundant curated entries (prune): ${c.curated.redundant.join(", ")}`);
  try {
    assertNoStaleCurated(run);
  } catch (error) {
    if (error instanceof StaleCuratedEntriesError) {
      console.error(error.message);
      process.exitCode = 3;
      return;
    }
    throw error;
  }
}

main();
