/**
 * @displayName Simulation replay gate
 * @strategicPurpose The evidence #110 asks for before any later step trusts a record: matches over the deck panel
 * replay to identical traceSha256, worker threads equal one thread, and rung-0 traces do not depend on undo mode.
 * @tacticalObjective Plays the panel matches in this thread (timed), replays every record, plays them again on a cold
 * and then a warm worker pool (timed) and once more with undo on, compares everything and prints one JSON report.
 * Exit 1 on any difference.
 *
 * Usage: tsx scripts/sims/replay-gate.ts [--matches 50] [--workers 8] [--seed0 1]
 */
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { playMatch, replayMatch, type MatchSpec } from "../../src/sims/match.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchRecord } from "../../src/sims/schemas.js";
import { canonicalJson } from "../../src/swu/canonical.js";
import { isMain } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { contextOptions, loadContext } from "./context.js";
import { loadDeck } from "./decks.js";

const DECKS = path.join(REPO_ROOT, "data/originals/decks/2026-10-17");

/** The owner's reference deck and the spike's three tournament lists (Krennic, Cad Bane, Luke). */
export const DECK_PANEL = [
  path.join(REPO_ROOT, "tests/fixtures/decks/warrior-chewie-raid.swudb.json"),
  path.join(DECKS, "melee-0b373cb2-6dfb-425e-842d-b4a700e2d337.json"),
  path.join(DECKS, "melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json"),
  path.join(DECKS, "melee-1a7b3451-7300-4e19-b69b-b44200bbce01.json"),
];

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { ...contextOptions, matches: { type: "string", default: "50" }, workers: { type: "string", default: "8" }, seed0: { type: "string", default: "1" } } });
  const ctx = loadContext(values);
  const keys = ctx.bridge.engineCardKeys;
  const panel = DECK_PANEL.map((f) => loadDeck(ctx.bridge, f));
  const pairs: [number, number][] = [];
  for (let a = 0; a < panel.length; a++) for (let b = a + 1; b < panel.length; b++) pairs.push([a, b]);
  const n = Number(values.matches);
  const specs: MatchSpec[] = Array.from({ length: n }, (_, i) => {
    const [a, b] = pairs[i % pairs.length];
    const swap = Math.floor(i / pairs.length) % 2 === 1;
    return { seed: String(Number(values.seed0) + i), decks: swap ? [panel[b], panel[a]] : [panel[a], panel[b]], policies: ["rung0", "rung0"], recordMode: "compact", undo: false, codeCommit: ctx.codeCommit };
  });
  const p = progress("sims-replay-gate", { total: n * 5, everyN: 1 });
  let done = 0;
  const failures: string[] = [];

  const t1 = performance.now();
  const single: MatchRecord[] = [];
  for (const s of specs) {
    single.push((await playMatch(ctx.engine, s, keys)).record);
    p.tick(++done);
  }
  const singleMs = performance.now() - t1;

  let replayed = 0;
  for (const r of single) {
    const out = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(r)), keys);
    if (out.ok && out.traceSha256 === r.footer.traceSha256) replayed += 1;
    else failures.push(`replay seed ${r.header.seed}: ${JSON.stringify(out.mismatch)}`);
    p.tick(++done);
  }

  const workers = Number(values.workers);
  const tPool = performance.now();
  const pool = await createPool({ workers, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
  const poolStartMs = performance.now() - tPool;
  const tCold = performance.now();
  const cold = await pool.run({ specs, cardKeys: keys });
  const coldMs = performance.now() - tCold;
  done += n;
  p.tick(done);
  const tWarm = performance.now();
  const warm = await pool.run({ specs, cardKeys: keys });
  const warmMs = performance.now() - tWarm;
  await pool.close();
  done += n;
  p.tick(done);
  const sameAsSingle = (rs: MatchRecord[]): number => rs.filter((r, i) => canonicalJson(r) === canonicalJson(single[i])).length;
  const coldEqual = sameAsSingle(cold);
  const warmEqual = sameAsSingle(warm);
  if (coldEqual !== n) failures.push(`cold pool: ${n - coldEqual} records differ from single-thread`);
  if (warmEqual !== n) failures.push(`warm pool: ${n - warmEqual} records differ from single-thread`);

  let undoEqual = 0;
  for (const [i, s] of specs.entries()) {
    const r = (await playMatch(ctx.engine, { ...s, undo: true }, keys)).record;
    if (canonicalJson(r.footer) === canonicalJson(single[i].footer) && canonicalJson(r.decisions) === canonicalJson(single[i].decisions)) undoEqual += 1;
    else failures.push(`undo on: seed ${s.seed} differs`);
    p.tick(++done);
  }
  p.done({ failures: failures.length });

  const gps = (games: number, ms: number): number => Math.round((games / ms) * 10000) / 10;
  const results = single.map((r) => r.footer.result);
  console.log(
    JSON.stringify(
      {
        matches: n,
        panel: panel.map((d) => d.source),
        pairs: pairs.length,
        endConditions: Object.fromEntries(["base_destroyed", "draw", "timeout", "stuck", "error"].map((e) => [e, results.filter((r) => r.endCondition === e).length])),
        replayedIdenticalTrace: replayed,
        workerThreads: { workers, coldEqual, warmEqual },
        undoOnEqual: undoEqual,
        distinctTraces: new Set(single.map((r) => r.footer.traceSha256)).size,
        throughput: {
          singleThreadGamesPerSecond: gps(n, singleMs),
          singleThreadMsPerGame: Math.round(singleMs / n),
          meanDecisionsPerGame: Math.round(results.reduce((a, r) => a + r.decisions, 0) / n),
          poolStartMs: Math.round(poolStartMs),
          coldPoolGamesPerSecond: gps(n, coldMs),
          warmPoolGamesPerSecond: gps(n, warmMs),
        },
        failures,
      },
      null,
      1,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
