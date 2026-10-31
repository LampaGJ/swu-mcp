/**
 * @displayName forceteki match replay (pnpm sims:replay)
 * @strategicPurpose A recorded match is evidence only if it replays (D2, #110): same pin, seed, decks and policies
 * must reproduce every decision and the logged traceSha256.
 * @tacticalObjective Reads a JSONL of match records, replays each (or one by --index), asserting legalActionsSha256,
 * rngCursor and the chosen descriptor at every k, stops a record at its first mismatch and names k and the field.
 * Exit 1 when any record fails.
 *
 * Usage: tsx scripts/sims/replay.ts --records <file.jsonl> [--index N]
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { replayMatch } from "../../src/sims/match.js";
import { isMain } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { contextOptions, loadContext } from "./context.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { ...contextOptions, records: { type: "string" }, index: { type: "string" } } });
  if (values.records === undefined) throw new Error("--records is required");
  const ctx = loadContext(values);
  const lines = readFileSync(values.records, "utf8").split("\n").filter((l) => l.trim() !== "");
  const picked = values.index === undefined ? lines.map((l, i) => ({ l, i })) : [{ l: lines[Number(values.index)], i: Number(values.index) }];
  const p = progress("sims-replay", { total: picked.length, everyN: 1 });
  let failed = 0;
  const traces: string[] = [];
  for (const [n, { l, i }] of picked.entries()) {
    const r = await replayMatch(ctx.engine, JSON.parse(l), ctx.bridge.engineCardKeys);
    if (!r.ok) failed += 1;
    traces.push(r.traceSha256);
    console.log(JSON.stringify({ index: i, ok: r.ok, decisions: r.decisions, traceSha256: r.traceSha256, mismatch: r.mismatch }));
    p.tick(n + 1);
  }
  p.done({ failed });
  console.error(JSON.stringify({ records: picked.length, replayedIdentical: picked.length - failed, failed }));
  if (failed > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
