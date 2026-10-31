/**
 * @displayName forceteki persistent worker pool (spike)
 * @strategicPurpose Let a long-lived caller (the simulate_matchup tool) pay the engine load and JIT warm-up once, not on every batch.
 * @tacticalObjective Starts N worker_threads that each load the engine once, then serves batches: workers claim seeds
 * from a per-batch shared counter and the caller gets records sorted by seed, identical to run-batch.mjs output.
 *
 * Usage: const pool = await createPool({ workers }); const records = await pool.run(deck1, deck2, { seed0, games, policies }); await pool.close();
 */
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { DEFAULT_FORCETEKI, installSelectableCardsMemo, loadEngine, playGame, topCoreClassSize, WORKER_RESOURCE_LIMITS } from "./play-game.mjs";

export async function createPool({ workers = topCoreClassSize(), forceteki = DEFAULT_FORCETEKI, memo = true, resourceLimits = WORKER_RESOURCE_LIMITS } = {}) {
  const ws = Array.from({ length: workers }, () => new Worker(new URL(import.meta.url), { workerData: { forceteki, memo }, resourceLimits }));
  await Promise.all(
    ws.map(
      (w) =>
        new Promise((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
    ),
  );
  let nextId = 0;
  return {
    workers,
    async run(deck1, deck2, { seed0, games, policies = ["random", "random"] }) {
      const id = nextId++;
      const counter = new Int32Array(new SharedArrayBuffer(4));
      const parts = await Promise.all(
        ws.map(
          (w) =>
            new Promise((resolve, reject) => {
              const onMessage = (m) => {
                if (m.id !== id) return;
                w.off("message", onMessage);
                w.off("error", reject);
                if (m.error) reject(new Error(m.error));
                else resolve(m.out);
              };
              w.on("message", onMessage);
              w.once("error", reject);
              w.postMessage({ id, deck1, deck2, seed0, games, policies, counter });
            }),
        ),
      );
      return parts.flat().sort((a, b) => a.seed - b.seed);
    },
    close: () => Promise.all(ws.map((w) => w.terminate())),
  };
}

if (!isMainThread) {
  const { forceteki, memo } = workerData;
  const engine = loadEngine(forceteki);
  if (memo) installSelectableCardsMemo(forceteki);
  parentPort.on("message", async ({ id, deck1, deck2, seed0, games, policies, counter }) => {
    try {
      const out = [];
      for (let i = Atomics.add(counter, 0, 1); i < games; i = Atomics.add(counter, 0, 1)) out.push(await playGame(engine, deck1, deck2, { seed: seed0 + i, policies }));
      parentPort.postMessage({ id, out });
    } catch (e) {
      parentPort.postMessage({ id, error: String(e?.message ?? e) });
    }
  });
  parentPort.postMessage({ ready: true });
}
