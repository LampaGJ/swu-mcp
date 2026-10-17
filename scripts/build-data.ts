/**
 * @displayName Data rebuild orchestrator
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#7): mault's originals and the committed pinned inputs in;
 * every data product under data/runs/<date>/ and a combined build.json out, byte-identical on a rerun.
 * @tacticalObjective Runs the steps in dependency order, fails on the first non-zero exit, then hashes every
 * output file and every step's replay record. The code commit and wall times are recorded in build.json but are
 * left out of buildHash, so two builds of the same inputs have the same buildHash.
 *
 * Usage: pnpm build:data [--originals <dir>] [--date <YYYY-MM-DD>]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --date       default: the day the raw card-list run finished (names data/runs/<date>)
 *
 * The rules step reads the pinned PDF under data/originals/rules/<version>/ when one exists and downloads it otherwise.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { z } from "zod";
import { canonicalJson, compareCodePoints, sha256Hex } from "../src/swu/canonical.js";
import { hex64 } from "../src/schemas/hash.js";
import { swuRawCacheManifestSchema } from "../src/swu/raw-manifest.js";
import { codeCommit } from "./lib/code-commit.js";
import { DEFAULT_ORIGINALS_ROOT, newestDatedDir } from "./lib/originals.js";
import { progress } from "./lib/progress.mjs";
import { REPO_ROOT } from "../src/paths.js";

const TSX = path.join(REPO_ROOT, "node_modules/.bin/tsx");

interface Step {
  name: string;
  script: string;
  args: string[];
  /** Run-dir-relative prefix of the files the step owns; "" marks the package step, which owns the loose top-level files and llm/, docs/. */
  owns: string[];
  replay: string;
}

const buildRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  date: z.iso.date(),
  originals: z.string(),
  codeCommit: z.string(),
  wallTimeMs: z.number().int().nonnegative(),
  buildHash: hex64,
  steps: z.array(
    z.strictObject({
      name: z.string(),
      command: z.string(),
      wallTimeMs: z.number().int().nonnegative(),
      replayHash: hex64,
      outputs: z.record(z.string(), hex64),
    }),
  ),
});

function pinnedRulesPdf(): string | undefined {
  const root = path.join(REPO_ROOT, "data/originals/rules");
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodePoints);
  for (const version of versions.reverse()) {
    const pdf = readdirSync(path.join(root, version)).find((name) => name.toLowerCase().endsWith(".pdf"));
    if (pdf !== undefined) return path.join(root, version, pdf);
  }
  return undefined;
}

function listFiles(root: string, dir = ""): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    return entry.isDirectory() ? listFiles(root, rel) : [rel];
  });
}

/** The replay record minus every codeCommit, so a new commit does not change the hash. */
function replayHash(file: string): string {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "codeCommit").map(([key, inner]) => [key, strip(inner)]));
    }
    return value;
  };
  return sha256Hex(canonicalJson(strip(JSON.parse(readFileSync(file, "utf8")))));
}

function ownedBy(step: Step, rel: string): boolean {
  if (rel === step.replay || path.basename(rel) === "replay.json") return false;
  return step.owns.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, date: { type: "string" } } });
  const originals = path.resolve(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT, "originals"));
  const manifest = swuRawCacheManifestSchema.parse(JSON.parse(readFileSync(path.join(originals, "swu-cards/raw-pages/manifest.json"), "utf8")));
  const date = z.iso.date().parse(values.date ?? manifest.finishedAt.slice(0, 10));
  const runDir = path.join(REPO_ROOT, "data/runs", date);
  const pdf = pinnedRulesPdf();

  const steps: Step[] = [
    {
      name: "export:package",
      script: "scripts/export-swu-data-package.ts",
      args: ["--originals", originals, "--date", date],
      owns: ["README.md", "llm", "docs"],
      replay: "replay.json",
    },
    {
      name: "card-features",
      script: "scripts/card-features.ts",
      args: ["--originals", originals, "--out", path.join(runDir, "features")],
      owns: ["features"],
      replay: "features/replay.json",
    },
    { name: "score", script: "scripts/score.ts", args: ["--data", runDir], owns: ["scores"], replay: "scores/replay.json" },
    {
      name: "synergy",
      script: "scripts/synergy.ts",
      args: ["--features", path.join(runDir, "features/features.json")],
      owns: ["synergy"],
      replay: "synergy/replay.json",
    },
    { name: "market", script: "scripts/market.ts", args: ["--data", runDir, "--originals", originals], owns: ["market"], replay: "market/replay.json" },
    {
      name: "rules:fetch",
      script: "scripts/rules-fetch.ts",
      args: ["--originals", originals, "--out", path.join(runDir, "rules"), "--date", date, ...(pdf === undefined ? [] : ["--pdf", pdf])],
      owns: ["rules"],
      replay: "rules/replay.json",
    },
    { name: "similarity", script: "scripts/similarity.ts", args: ["--data", runDir], owns: ["similarity"], replay: "similarity/replay.json" },
    { name: "meta", script: "scripts/meta.ts", args: ["--data", runDir, "--originals", originals], owns: ["meta"], replay: "meta/replay.json" },
  ];

  const p = progress("build-data", { total: steps.length, everyN: 1 });
  const logDir = path.join(REPO_ROOT, "tmp/build-data");
  mkdirSync(logDir, { recursive: true });
  const started = performance.now();
  const stepTimes = new Map<string, number>();
  steps.forEach((step, index) => {
    p.log({ phase: step.name, step: index + 1 });
    const log = openSync(path.join(logDir, `${step.name.replace(":", "-")}.log`), "w");
    const t0 = performance.now();
    const result = spawnSync(TSX, [step.script, ...step.args], { cwd: REPO_ROOT, stdio: ["ignore", log, "inherit"] });
    closeSync(log);
    stepTimes.set(step.name, Math.round(performance.now() - t0));
    if (result.status !== 0) throw new Error(`${step.name} failed with exit ${String(result.status)}; stdout log: ${path.join(logDir, step.name.replace(":", "-"))}.log`);
    p.tick(index + 1, { phase: step.name });
  });

  const files = listFiles(runDir).filter((rel) => rel !== "build.json");
  const recorded = steps.map((step) => {
    const outputs = Object.fromEntries(
      files
        .filter((rel) => ownedBy(step, rel))
        .sort(compareCodePoints)
        .map((rel) => [rel, sha256Hex(readFileSync(path.join(runDir, rel)))] as const),
    );
    return {
      name: step.name,
      command: ["pnpm", "exec", "tsx", step.script, ...step.args.map((arg) => (arg.startsWith(REPO_ROOT) ? path.relative(REPO_ROOT, arg) : arg))].join(" "),
      wallTimeMs: stepTimes.get(step.name) ?? 0,
      replayHash: replayHash(path.join(runDir, step.replay)),
      outputs,
    };
  });
  const unowned = files.filter((rel) => path.basename(rel) !== "replay.json" && !steps.some((step) => ownedBy(step, rel)));
  if (unowned.length > 0) throw new Error(`files in ${runDir} that no step owns: ${unowned.slice(0, 5).join(", ")}`);

  const buildHash = sha256Hex(canonicalJson({ date, steps: recorded.map(({ name, replayHash: replay, outputs }) => ({ name, replayHash: replay, outputs })) }));
  const record = buildRecordSchema.parse({
    schemaVersion: 1,
    date,
    originals,
    codeCommit: codeCommit("whole-tree"),
    wallTimeMs: Math.round(performance.now() - started),
    buildHash,
    steps: recorded,
  });
  writeFileSync(path.join(runDir, "build.json"), `${JSON.stringify(record, null, 1)}\n`);
  p.done({ buildHash, files: files.length });
  console.log(JSON.stringify({ runDir, buildHash, wallTimeMs: record.wallTimeMs, steps: recorded.map((s) => ({ name: s.name, ms: s.wallTimeMs, files: Object.keys(s.outputs).length })) }, null, 1));
}

main();
