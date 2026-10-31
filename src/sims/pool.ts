import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { DEFAULT_FORCETEKI, type EnginePin } from "./engine-pin.js";
import { WORKER_RESOURCE_LIMITS, topCoreClassSize } from "./engine.js";
import type { MatchSpec } from "./match.js";
import type { MatchRecord } from "./schemas.js";

/**
 * @displayName Persistent simulation worker pool
 * @strategicPurpose A long-lived caller (the batch runner now, simulate_matchup later) pays the engine load and JIT
 * warm-up once per worker, not once per batch; results never depend on which worker played a seed.
 * @tacticalObjective Starts N worker_threads that load the pinned engine once (the parent verified the pin), then
 * serves batches: workers claim the next match index from a shared counter and the caller gets records in input
 * order. Heap caps per worker as measured in docs/research/sim-compute-measurements.md.
 */

export interface PoolOptions {
  workers?: number;
  forceteki?: string;
  pin: EnginePin;
  memo?: boolean;
  resourceLimits?: typeof WORKER_RESOURCE_LIMITS;
}

export interface BatchRequest {
  specs: readonly MatchSpec[];
  cardKeys: Readonly<Record<string, string>>;
  maxDecisions?: number;
}

export interface Pool {
  workers: number;
  run(req: BatchRequest): Promise<MatchRecord[]>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** A worker on a .ts entry needs the tsx loader; under tsx the parent already has it in execArgv. */
function workerEntry(): { file: string; execArgv: string[] } {
  const ts = path.join(here, "worker.ts");
  const js = path.join(here, "worker.js");
  const isTs = import.meta.url.endsWith(".ts");
  const hasTsx = process.execArgv.some((a) => a.includes("tsx"));
  return { file: isTs ? ts : js, execArgv: isTs && !hasTsx ? [...process.execArgv, "--import", "tsx"] : process.execArgv };
}

export async function createPool(opts: PoolOptions): Promise<Pool> {
  const n = Math.max(1, opts.workers ?? topCoreClassSize());
  const entry = workerEntry();
  const ws = Array.from(
    { length: n },
    () =>
      new Worker(entry.file, {
        execArgv: entry.execArgv,
        resourceLimits: opts.resourceLimits ?? WORKER_RESOURCE_LIMITS,
        workerData: { forceteki: opts.forceteki ?? DEFAULT_FORCETEKI, pin: opts.pin, memo: opts.memo !== false },
      }),
  );
  await Promise.all(
    ws.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          w.once("message", () => resolve());
          w.once("error", reject);
        }),
    ),
  );
  let nextId = 0;
  return {
    workers: n,
    async run(req) {
      const id = nextId++;
      const counter = new Int32Array(new SharedArrayBuffer(4));
      const parts = await Promise.all(
        ws.map(
          (w) =>
            new Promise<{ i: number; record: MatchRecord }[]>((resolve, reject) => {
              const onMessage = (m: { id: number; out?: { i: number; record: MatchRecord }[]; error?: string }) => {
                if (m.id !== id) return;
                w.off("message", onMessage);
                w.off("error", reject);
                if (m.error !== undefined) reject(new Error(m.error));
                else resolve(m.out ?? []);
              };
              w.on("message", onMessage);
              w.once("error", reject);
              w.postMessage({ id, specs: req.specs, cardKeys: req.cardKeys, maxDecisions: req.maxDecisions, counter });
            }),
        ),
      );
      const out = parts.flat().sort((a, b) => a.i - b.i);
      if (out.length !== req.specs.length || out.some((r, i) => r.i !== i)) throw new Error(`pool returned ${out.length} of ${req.specs.length} matches`);
      return out.map((r) => r.record);
    },
    close: async () => {
      await Promise.all(ws.map((w) => w.terminate()));
    },
  };
}
