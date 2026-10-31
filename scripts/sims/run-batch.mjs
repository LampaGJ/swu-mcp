/**
 * @displayName forceteki batch runner (spike)
 * @strategicPurpose Measure how many bot games per second one machine sustains, and show that worker threads
 * return the same per-seed results as a single thread.
 * @tacticalObjective Splits a seed range across worker_threads, each loading its own engine copy, and prints one
 * JSON line per game in seed order plus a summary line on stderr.
 *
 * Workers claim the next seed from a shared counter, so a slow game never leaves other workers idle; a per-seed record
 * does not depend on which worker played it. `--workers auto` (default) is hw.perflevel0.logicalcpu, the top core class.
 *
 * Usage: node scripts/sims/run-batch.mjs --deck1 <json> --deck2 <json> --games N --seed S [--workers W|auto] [--forceteki <dir>] [--no-memo]
 */
import { readFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { parseArgs } from "node:util";
import { DEFAULT_FORCETEKI, installSelectableCardsMemo, loadEngine, playGame, topCoreClassSize, WORKER_RESOURCE_LIMITS } from "./play-game.mjs";

if (isMainThread) {
  const { values } = parseArgs({
    options: {
      deck1: { type: "string" },
      deck2: { type: "string" },
      games: { type: "string", default: "100" },
      seed: { type: "string", default: "1" },
      workers: { type: "string", default: "auto" },
      policy1: { type: "string", default: "random" },
      policy2: { type: "string", default: "random" },
      forceteki: { type: "string", default: DEFAULT_FORCETEKI },
      "no-memo": { type: "boolean", default: false },
    },
  });
  const games = Number(values.games);
  const workers = Math.min(values.workers === "auto" ? topCoreClassSize() : Number(values.workers), games);
  const seed0 = Number(values.seed);
  const counter = new Int32Array(new SharedArrayBuffer(4));
  const t0 = performance.now();
  const parts = await Promise.all(
    Array.from({ length: workers }, () => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          resourceLimits: WORKER_RESOURCE_LIMITS,
          workerData: { deck1: values.deck1, deck2: values.deck2, games, seed0, counter, forceteki: values.forceteki, memo: !values["no-memo"], policies: [values.policy1, values.policy2] },
        });
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    }),
  );
  const wallMs = Math.round(performance.now() - t0);
  const records = parts.flat().sort((a, b) => a.seed - b.seed);
  for (const r of records) console.log(JSON.stringify(r));
  const sumMs = records.reduce((a, r) => a + r.ms, 0);
  console.error(JSON.stringify({ games, workers, wallMs, gamesPerSecond: Math.round((games / wallMs) * 10000) / 10, sumGameMs: Math.round(sumMs) }));
} else {
  const { deck1, deck2, games, seed0, counter, forceteki, memo, policies } = workerData;
  const engine = loadEngine(forceteki);
  if (memo) installSelectableCardsMemo(forceteki);
  const d1 = JSON.parse(readFileSync(deck1, "utf8"));
  const d2 = JSON.parse(readFileSync(deck2, "utf8"));
  const out = [];
  for (let i = Atomics.add(counter, 0, 1); i < games; i = Atomics.add(counter, 0, 1)) out.push(await playGame(engine, d1, d2, { seed: seed0 + i, policies }));
  parentPort.postMessage(out);
}
