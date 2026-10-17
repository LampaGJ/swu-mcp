/**
 * Pins the captured model verdicts for the pairing fixture as data/fixtures/pairs-v1.json (LampaGJ/swu-mcp#15).
 * Reads <dir>/verdicts/p*.json (first-pass verdicts) and <dir>/adjudication/p*.json (final verdicts that override by id).
 * The same input files give a byte-identical fixture.
 *
 * Usage: tsx scripts/verify/pair-fixture-pin.ts [--dir <dir>] [--out <file>]
 *   --dir  default: <repo>/tmp/pair-fixture (holds index.json, verdicts/, adjudication/)
 *   --out  default: <repo>/data/fixtures/pairs-v1.json
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { parseUnitId } from "./pair-fixture.js";
import { serialize } from "./sample.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const FIXTURE_VERSION = 1;

const Label = z.enum(["correct", "wrong", "unsure"]);
export type Label = z.infer<typeof Label>;

const VerdictFile = z.looseObject({
  items: z.array(z.looseObject({ id: z.string().min(1), verdict: Label, reason: z.string() })),
});
const AdjudicationFile = z.looseObject({
  items: z.array(z.strictObject({ id: z.string().min(1), final: Label, reason: z.string() })),
});
const IndexFile = z.looseObject({
  seed: z.string(),
  sourceRun: z.strictObject({ date: z.string(), buildHash: z.string() }),
});

export const FixtureSchema = z.strictObject({
  version: z.literal(FIXTURE_VERSION),
  seed: z.string(),
  sourceRun: z.strictObject({ date: z.string(), buildHash: z.string() }),
  inputsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(z.strictObject({ id: z.string(), offer: z.string(), want: z.string(), row: z.string(), label: Label, reason: z.string() })),
});
export type Fixture = z.infer<typeof FixtureSchema>;

function parseFile<T>(schema: z.ZodType<T>, file: string): T {
  const result = schema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!result.success) throw new Error(`${file}: ${z.prettifyError(result.error)}`);
  return result.data;
}

const jsonFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /^p\d+\.json$/.test(name))
        .sort(compareCodePoints)
        .map((name) => path.join(dir, name))
    : [];

/** A repeated id carries one entry per defect: any wrong wins, then unsure, otherwise correct. */
function collapse(entries: readonly { verdict: Label; reason: string }[]): { label: Label; reason: string } {
  for (const label of ["wrong", "unsure", "correct"] as const) {
    const hit = entries.find((entry) => entry.verdict === label);
    if (hit !== undefined) return { label, reason: hit.reason };
  }
  throw new Error("no verdict entries");
}

export function pinFixture(dir: string): Fixture {
  const index = parseFile(IndexFile, path.join(dir, "index.json"));
  const verdictFiles = jsonFiles(path.join(dir, "verdicts"));
  const adjudicationFiles = jsonFiles(path.join(dir, "adjudication"));
  if (verdictFiles.length === 0) throw new Error(`no verdict files under ${path.join(dir, "verdicts")}`);

  const grouped = new Map<string, { verdict: Label; reason: string }[]>();
  const owner = new Map<string, string>();
  for (const file of verdictFiles) {
    for (const entry of parseFile(VerdictFile, file).items) {
      const prior = owner.get(entry.id);
      if (prior !== undefined && prior !== file) throw new Error(`${entry.id} appears in ${prior} and ${file}`);
      owner.set(entry.id, file);
      grouped.set(entry.id, [...(grouped.get(entry.id) ?? []), { verdict: entry.verdict, reason: entry.reason }]);
    }
  }
  const labels = new Map([...grouped].map(([id, entries]) => [id, collapse(entries)]));

  const finals = new Set<string>();
  for (const file of adjudicationFiles) {
    for (const entry of parseFile(AdjudicationFile, file).items) {
      if (!labels.has(entry.id)) throw new Error(`${file}: adjudicated id ${entry.id} has no first-pass verdict`);
      if (finals.has(entry.id)) throw new Error(`${file}: ${entry.id} is adjudicated twice`);
      finals.add(entry.id);
      labels.set(entry.id, { label: entry.final, reason: entry.reason });
    }
  }

  const hash = createHash("sha256");
  for (const file of [...verdictFiles, ...adjudicationFiles]) {
    hash.update(`${path.relative(dir, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }

  const items = [...labels]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([id, { label, reason }]) => ({ id, ...parseUnitId(id), label, reason }));
  return FixtureSchema.parse({ version: FIXTURE_VERSION, seed: index.seed, sourceRun: index.sourceRun, inputsSha256: hash.digest("hex"), items });
}

function main(): void {
  const { values } = parseArgs({ options: { dir: { type: "string" }, out: { type: "string" } } });
  const dir = path.resolve(values.dir ?? path.join(REPO_ROOT, "tmp/pair-fixture"));
  const out = path.resolve(values.out ?? path.join(REPO_ROOT, "data/fixtures/pairs-v1.json"));
  const fixture = pinFixture(dir);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, serialize(fixture));
  const counts = { correct: 0, wrong: 0, unsure: 0 };
  for (const item of fixture.items) counts[item.label] += 1;
  console.log(`pinned ${fixture.items.length} items (${counts.correct} correct, ${counts.wrong} wrong, ${counts.unsure} unsure) to ${out}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
