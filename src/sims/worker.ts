import { parentPort, workerData } from "node:worker_threads";
import type { EnginePin } from "./engine-pin.js";
import { installSelectableCardsMemo, loadEngine } from "./engine.js";
import { playMatch, type MatchSpec } from "./match.js";

/**
 * @displayName Simulation worker
 * @strategicPurpose One engine copy per thread, loaded once, so a batch spreads over cores without changing any
 * per-seed record.
 * @tacticalObjective Loads the engine named by the parent's verified pin, then plays match indexes it claims from the
 * batch's shared counter until the batch is exhausted, and posts the records back.
 */

const { forceteki, pin, memo } = workerData as { forceteki: string; pin: EnginePin; memo: boolean };
const engine = loadEngine(forceteki, { pin, verify: false });
if (memo) installSelectableCardsMemo(forceteki);

interface Batch {
  id: number;
  specs: MatchSpec[];
  cardKeys: Record<string, string>;
  maxDecisions?: number;
  counter: Int32Array;
}

parentPort?.on("message", async ({ id, specs, cardKeys, maxDecisions, counter }: Batch) => {
  try {
    const out = [];
    for (let i = Atomics.add(counter, 0, 1); i < specs.length; i = Atomics.add(counter, 0, 1)) out.push({ i, record: (await playMatch(engine, specs[i], cardKeys, { maxDecisions })).record });
    parentPort?.postMessage({ id, out });
  } catch (e) {
    parentPort?.postMessage({ id, error: String((e as Error)?.message ?? e) });
  }
});
parentPort?.postMessage({ ready: true });
