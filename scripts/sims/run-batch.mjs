/**
 * @displayName forceteki batch runner (spike)
 * @strategicPurpose Measure how many bot games per second one machine sustains, and show that worker threads
 * return the same per-seed results as a single thread.
 * @tacticalObjective Splits a seed range across worker_threads, each loading its own engine copy, and prints one
 * JSON line per game in seed order plus a summary line on stderr.
 *
 * Usage: node scripts/sims/run-batch.mjs --deck1 <json> --deck2 <json> --games N --seed S --workers W [--forceteki <dir>]
 */
import { readFileSync } from "node:fs";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { parseArgs } from "node:util";
import { DEFAULT_FORCETEKI, loadEngine, playGame } from "./play-game.mjs";

if (isMainThread) {
  const { values } = parseArgs({
    options: {
      deck1: { type: "string" },
      deck2: { type: "string" },
      games: { type: "string", default: "100" },
      seed: { type: "string", default: "1" },
      workers: { type: "string", default: "8" },
      policy1: { type: "string", default: "random" },
      policy2: { type: "string", default: "random" },
      forceteki: { type: "string", default: DEFAULT_FORCETEKI },
    },
  });
  const games = Number(values.games);
  const workers = Math.min(Number(values.workers), games);
  const seed0 = Number(values.seed);
  const t0 = performance.now();
  const parts = await Promise.all(
    Array.from({ length: workers }, (_, w) => {
      const seeds = [];
      for (let g = w; g < games; g += workers) seeds.push(seed0 + g);
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { deck1: values.deck1, deck2: values.deck2, seeds, forceteki: values.forceteki, policies: [values.policy1, values.policy2] },
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
  const { deck1, deck2, seeds, forceteki, policies } = workerData;
  const engine = loadEngine(forceteki);
  const d1 = JSON.parse(readFileSync(deck1, "utf8"));
  const d2 = JSON.parse(readFileSync(deck2, "utf8"));
  const out = [];
  for (const seed of seeds) out.push(await playGame(engine, d1, d2, { seed, policies }));
  parentPort.postMessage(out);
}
