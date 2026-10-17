/**
 * Measures a run's pairing precision against the pinned fixture data/fixtures/pairs-v1.json (LampaGJ/swu-mcp#15).
 * Only fixture pairs the run still emits count toward precision; recall-of-correct is over all fixture-correct pairs.
 * Precision is reported overall, on mechanical rows only and on trait-only rows (the trait-reference family, #24).
 *
 * Usage: tsx scripts/verify/pair-precision.ts [--run <dir>] [--fixture <file>]
 *   --run  default: newest dated directory under data/runs
 * Output: JSON on stdout and <run>/verify/pair-precision.json. Always exits 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { FixtureSchema, type Fixture } from "./pair-fixture-pin.js";
import { newestDatedDir } from "../lib/originals.js";
import { pairUnits } from "./pair-fixture.js";
import { serialize } from "./sample.js";
import { REPO_ROOT } from "../../src/paths.js";


export interface Interval {
  value: number | null;
  low: number | null;
  high: number | null;
  n: number;
  of: number;
}

export function wilson(successes: number, n: number, z95 = 1.959964): Interval {
  if (n === 0) return { value: null, low: null, high: null, n: successes, of: n };
  const p = successes / n;
  const z2 = z95 * z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const round = (x: number): number => Math.round(x * 1e4) / 1e4;
  return { value: round(p), low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)), n: successes, of: n };
}

export interface Measure {
  fixtureItems: number;
  stillEmitted: number;
  precision: Interval;
  recallOfCorrect: Interval;
  wrongStillEmitted: Interval;
}

export function measure(items: Fixture["items"], emitted: ReadonlySet<string>): Measure {
  const kept = items.filter((item) => emitted.has(item.id));
  const correctKept = kept.filter((item) => item.label === "correct").length;
  const wrongKept = kept.filter((item) => item.label === "wrong").length;
  const correctAll = items.filter((item) => item.label === "correct").length;
  const wrongAll = items.filter((item) => item.label === "wrong").length;
  return {
    fixtureItems: items.length,
    stillEmitted: kept.length,
    precision: wilson(correctKept, correctKept + wrongKept),
    recallOfCorrect: wilson(correctKept, correctAll),
    wrongStillEmitted: wilson(wrongKept, wrongAll),
  };
}

const isTraitRow = (row: string): boolean => row === "trait-reference" || row.startsWith("trait-reference:");

export function report(fixture: Fixture, emitted: ReadonlySet<string>): Record<string, unknown> {
  const rows = [...new Set(fixture.items.map((item) => item.row))].sort(compareCodePoints);
  return {
    fixture: { version: fixture.version, seed: fixture.seed, sourceRun: fixture.sourceRun, inputsSha256: fixture.inputsSha256 },
    overall: measure(fixture.items, emitted),
    mechanical: measure(fixture.items.filter((item) => !isTraitRow(item.row)), emitted),
    traitOnly: measure(fixture.items.filter((item) => isTraitRow(item.row)), emitted),
    perRow: Object.fromEntries(rows.map((row) => [row, measure(fixture.items.filter((item) => item.row === row), emitted)])),
  };
}

export function emittedIds(runDir: string): Set<string> {
  const table = decode(readFileSync(path.join(runDir, "synergy/pairs.toon"), "utf8")) as Record<string, unknown>;
  const pairs = z.array(z.record(z.string(), z.unknown())).parse(table.pairings);
  return new Set(pairUnits(pairs).map((unit) => unit.id));
}

function main(): void {
  const { values } = parseArgs({ options: { run: { type: "string" }, fixture: { type: "string" } } });
  const runDir = path.resolve(values.run ?? newestDatedDir(path.join(REPO_ROOT, "data/runs"), "run"));
  const fixtureFile = path.resolve(values.fixture ?? path.join(REPO_ROOT, "data/fixtures/pairs-v1.json"));
  const fixture = FixtureSchema.parse(JSON.parse(readFileSync(fixtureFile, "utf8")));
  const result = { run: path.basename(runDir), ...report(fixture, emittedIds(runDir)) };
  const text = serialize(result);
  mkdirSync(path.join(runDir, "verify"), { recursive: true });
  writeFileSync(path.join(runDir, "verify/pair-precision.json"), text);
  process.stdout.write(text);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
