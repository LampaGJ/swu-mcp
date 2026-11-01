/**
 * @displayName Branch-sampled decision values (CLI)
 * @strategicPurpose The owner's "enough iterations at each branch" as a pinned dataset (#125): every legal action at
 * sampled decisions of seeded games, valued over K re-dealt hidden worlds and N continuations, with a manifest that
 * replays it and refuses human-derived inputs (D22, D52). Bot play under a named rung (D21), never pooled with
 * tournament data.
 * @tacticalObjective Draws two placement-weighted melee lists per source game (src/sims/opponents.ts
 * sampleProportional), refuses disallowed inputs before any game runs, plays every source game once on a warm worker
 * pool to list its candidate decisions, selects decisions with the keyed-uniform rule (independent of worker count),
 * replays each game holding a sampled decision and branches it (scripts/sims/branch-worker.ts), then writes
 * branches.jsonl.gz (records sorted by gameId and k, gzip level 9), manifest.json (hashes, counts, replay record) and
 * run-report.json (wall time and costs, outside every hash). Existing output with different bytes is refused.
 * Progress: reports/.progress/<job>.json.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/sims/sample-branches.ts --purpose pilot --seed-from 5000000 --games 220 \
 *     --target 2000 --K 4 --N 4 [--rate 1] [--run-seed <s>] [--workers 12] [--date 2026-11-01] [--out <dir>] [--pin]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import { gzipSync } from "node:zlib";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import {
  assertInputsAllowed,
  BRANCH_LABEL,
  branchManifestSchema,
  branchTaskResultSchema,
  branchTaskSchema,
  candidateResultSchema,
  candidateTaskSchema,
  DETERMINIZE_PRIMITIVE,
  selectDecisions,
  splitSeedRange,
  type BranchManifest,
  type BranchRecord,
  type BranchTask,
  type BranchTaskResult,
  type CandidateResult,
  type CandidateTask,
  type SeedRange,
  type SourceSpec,
} from "../../src/sims/branches.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { modelManifestSchema } from "../../src/sims/model-manifest.js";
import { engineSetCodes, engineUnmappedCards, loadOpponentPool, mapCardKeyOf, sampleProportional, storeAspectsOf, type UnmappedCards } from "../../src/sims/opponents.js";
import { swudbDeckSchema } from "../../src/tools/swudb.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";
import { driverName } from "../../src/sims/policies/typed-adapter.js";
import { stateViewKeysOf } from "../../src/sims/state-view.js";
import { STATE_LAYOUT_SHA256, STATE_VERSION } from "../../src/sims/state.js";
import { parseVocab, vocabRevision } from "../../src/sims/vocab.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { loadCardMap } from "../bench/card-map.js";
import { isMain } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import type { BranchWorkerInit } from "./branch-worker.js";
import { DEFAULT_ORIGINALS, DEFAULT_RUN, loadContext } from "./context.js";
import { prepareDeck } from "./decks.js";

/** The fields read from a committed ladder record; the record carries more, which parsing strips. */
const ladderFileSchema = z.object({
  step: z.string().min(1),
  candidate: z.object({ spec: z.string(), paramsSha256: z.string() }),
  summary: z.object({ discordant: z.object({ pValue: z.number() }), pooled: z.object({ share: z.number() }) }),
  design: z.object({ alpha: z.number() }),
});

export const DEFAULTS = {
  policy: "rung1:sacGuard=1,handCap=1",
  ladderFile: "data/pinned/sim-ladder-v1/rung1-pilot-vs-rung0.json",
  decks: path.join(REPO_ROOT, "data/originals/decks/2026-10-17"),
  release: path.join(REPO_ROOT, "data/runs/2026-10-30"),
  vocab: path.join(REPO_ROOT, "data/pinned/sim-vocab/2026-10-30.r6.v2.json"),
  inventory: path.join(REPO_ROOT, "data/pinned/sim-models/manifest.json"),
  complementarity: path.join(REPO_ROOT, "data/complementarity.json"),
  maxContinuationDecisions: 2000,
  /** Rung 1 games average about 94 decisions (data/pinned/sim-ladder-v1/rung1-pilot-vs-rung0.json); seed 6000193 loops past 3,000 in one action phase. */
  maxSourceDecisions: 2000,
  /** Heap per worker: a branch holds one manual snapshot plus the engine; flat Monte Carlo ran in the same budget. */
  resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 48 },
} as const;

export interface SampleOptions {
  purpose: BranchManifest["purpose"];
  date: string;
  runSeed: string;
  seedFrom: number;
  games: number;
  rate: number;
  target: number;
  K: number;
  N: number;
  policy?: string;
  workers: number;
  out: string;
  /** Also copy the manifest to data/pinned/sim-datasets/branches-<date>.manifest.json. */
  pin?: boolean;
  job?: string;
  maxContinuationDecisions?: number;
  forceteki?: string;
  run?: string;
  originals?: string;
  decks?: string;
  release?: string;
  vocab?: string;
  inventory?: string;
  ladderFile?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pool: one branch worker per thread, shared-counter claiming, results placed by task index (order-independent).

const here = path.dirname(fileURLToPath(import.meta.url));

function workerEntry(): { file: string; execArgv: string[] } {
  const isTs = import.meta.url.endsWith(".ts");
  const hasTsx = process.execArgv.some((a) => a.includes("tsx"));
  return { file: path.join(here, isTs ? "branch-worker.ts" : "branch-worker.js"), execArgv: isTs && !hasTsx ? [...process.execArgv, "--import", "tsx"] : process.execArgv };
}

interface BranchPool {
  run<T>(kind: "candidates" | "branches", tasks: readonly unknown[], parse: (raw: unknown) => T, onResult: (i: number, out: T) => void, onBeat?: () => void): Promise<T[]>;
  close(): Promise<void>;
}

async function createBranchPool(n: number, init: BranchWorkerInit): Promise<BranchPool> {
  const entry = workerEntry();
  const ws = Array.from({ length: n }, () => new Worker(entry.file, { execArgv: entry.execArgv, resourceLimits: DEFAULTS.resourceLimits, workerData: { branchWorker: true, init } }));
  await Promise.all(ws.map((w) => new Promise<void>((resolve, reject) => (w.once("message", () => resolve()), w.once("error", reject)))));
  let nextId = 0;
  return {
    async run(kind, tasks, parse, onResult, onBeat) {
      const id = nextId++;
      const counter = new Int32Array(new SharedArrayBuffer(4));
      const out: unknown[] = new Array(tasks.length);
      await Promise.all(
        ws.map(
          (w) =>
            new Promise<void>((resolve, reject) => {
              const onMessage = (m: { id: number; i?: number; out?: unknown; done?: boolean; beat?: boolean; error?: string }): void => {
                if (m.id !== id) return;
                if (m.beat === true) onBeat?.();
                else if (m.error !== undefined) {
                  w.off("message", onMessage);
                  reject(new Error(m.error));
                } else if (m.done === true) {
                  w.off("message", onMessage);
                  resolve();
                } else if (m.i !== undefined) {
                  const parsed = parse(m.out);
                  out[m.i] = parsed;
                  onResult(m.i, parsed);
                }
              };
              w.on("message", onMessage);
              w.once("error", reject);
              w.postMessage({ id, kind, tasks, counter });
            }),
        ),
      );
      if (out.some((x) => x === undefined)) throw new Error(`branch pool returned ${out.filter((x) => x !== undefined).length} of ${tasks.length} ${kind} tasks`);
      return out as never;
    },
    close: async () => void (await Promise.all(ws.map((w) => w.terminate()))),
  };
}

// ---------------------------------------------------------------------------------------------------------------------

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r4 = (x: number | null): number | null => (x === null ? null : Math.round(x * 10000) / 10000);
const fileSha = (file: string): string => sha256Hex(readFileSync(file));
const finished = (r: CandidateResult): boolean => r.endCondition === "base_destroyed" || r.endCondition === "draw";

function writeOnce(file: string, bytes: Buffer): void {
  if (existsSync(file) && !readFileSync(file).equals(bytes)) throw new Error(`${file} already exists with different bytes; a branch dataset is never overwritten (use a new --out or date)`);
  writeFileSync(file, bytes);
}

/** Per-action standard error of the mean and the share of outcome variance between determinizations, from the counts; the share needs N >= 2. */
function noiseOf(records: readonly BranchRecord[]): { meanActionSE: number | null; detVarianceShare: number | null } {
  let seSum = 0;
  let seN = 0;
  let between = 0;
  let total = 0;
  for (const r of records) {
    const { N } = r.determinization;
    for (const a of r.legalActions) {
      if (a.mean === null || a.n < 2) continue;
      const ex2 = (a.nWin + 0.25 * a.nDraw) / a.n;
      const v = Math.max(0, ex2 - a.mean * a.mean);
      seSum += Math.sqrt((v * a.n) / (a.n - 1) / a.n);
      seN++;
      total += v * a.n;
      for (const d of a.perDet) if (d !== null) between += N * (d - a.mean) ** 2;
    }
  }
  const withinMeasured = records.length > 0 && records.every((r) => r.determinization.N >= 2);
  return { meanActionSE: seN === 0 ? null : seSum / seN, detVarianceShare: total === 0 || !withinMeasured ? null : between / total };
}

/** Everything fixed before any game runs: inputs, refusals, the source specs and the worker's init. */
export function prepareSources(o: SampleOptions) {
  const policy = o.policy ?? DEFAULTS.policy;
  const forceteki = o.forceteki ?? DEFAULT_FORCETEKI;
  const run = o.run ?? DEFAULT_RUN;
  const originals = o.originals ?? DEFAULT_ORIGINALS;
  const decksDir = o.decks ?? DEFAULTS.decks;
  const seedRange: SeedRange = { from: o.seedFrom, count: o.games };
  if (!Number.isInteger(o.K) || !Number.isInteger(o.N) || o.K < 1 || o.N < 1) throw new Error("K and N must be positive integers");

  const inventory = modelManifestSchema.parse(JSON.parse(readFileSync(o.inventory ?? DEFAULTS.inventory, "utf8")));
  if (inventory.evaluationSeedRange === null) throw new Error("#123 has not reserved evaluationSeedRange; refusing to sample");
  const evaluationSeedRange = inventory.evaluationSeedRange;
  const header = policyHeader(parsePolicySpec(policy));
  if (header.rung >= 3) throw new Error(`continuation rung ${header.rung} needs a captured evaluator with a #123 entry; not supported here`);
  // The pool admits only lists whose metadata.source is melee (src/sims/opponents.ts readSnapshotEntries).
  const deckSources = ["melee"];
  assertInputsAllowed({ deckSources, seedRanges: [seedRange], evaluationSeedRange, evaluatorD22: null });

  const ctx = loadContext({ forceteki, run, originals, "no-memo": false });
  const cardMap = loadCardMap(run, originals);
  const engineUnmapped = engineUnmappedCards(engineSetCodes(forceteki));
  // A list the deck schema refuses (a sideboard count of 0 in the 2026-10-17 snapshot) is unbuildable like a list with
  // cards the engine lacks: the sampler sets it aside and redraws from the same archetype, and the report counts it.
  const unbuildable: UnmappedCards = (deck) => {
    const out = engineUnmapped(deck);
    const key = (deck as { key?: unknown }).key;
    if (typeof key === "string" && !swudbDeckSchema.safeParse(JSON.parse(readFileSync(path.join(decksDir, `${key}.json`), "utf8"))).success) out.push(`invalid-list:${key}`);
    return out;
  };
  const pool = loadOpponentPool({
    archetypesFile: path.join(run, "meta/archetypes.json"),
    decksDir,
    cardKeyOf: mapCardKeyOf(cardMap.setNumber.byId),
    baseAspectsOf: storeAspectsOf(loadStore(run)),
    unmappedCards: unbuildable,
  });
  const sample = sampleProportional(pool, { seed: `branch-source|${o.runSeed}`, n: 2 * o.games });

  const name = driverName(policy);
  const deckCache = new Map<string, SourceSpec["decks"][number]>();
  const deckOf = (i: number): SourceSpec["decks"][number] => {
    const d = sample.draws[i];
    const cached = deckCache.get(d.source);
    if (cached !== undefined) return cached;
    const deck = prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(decksDir, `${d.list.key}.json`), "utf8")), `melee ${d.source}`);
    deckCache.set(d.source, deck);
    return deck;
  };
  const specs: SourceSpec[] = Array.from({ length: o.games }, (_, g) => ({ seed: String(o.seedFrom + g), decks: [deckOf(2 * g), deckOf(2 * g + 1)], policies: [name, name], recordMode: "none", undo: true, codeCommit: ctx.codeCommit }));
  const batchSha256 = sha256Hex(canonicalJson(specs.map((s) => ({ seed: s.seed, decks: s.decks, policies: s.policies }))));

  const vocabRaw = JSON.parse(readFileSync(o.vocab ?? DEFAULTS.vocab, "utf8")) as unknown;
  const vocab = parseVocab(vocabRaw);
  const init: BranchWorkerInit = {
    forceteki,
    pin: ctx.engine.pin,
    memo: true,
    tablesRun: run,
    complementarity: DEFAULTS.complementarity,
    policy,
    vocab: vocabRaw,
    viewKeys: stateViewKeysOf(loadStore(o.release ?? DEFAULTS.release).cards, ctx.bridge.engineCardKeys),
    cardKeys: { ...ctx.bridge.engineCardKeys },
  };
  const ladderFile = o.ladderFile ?? DEFAULTS.ladderFile;
  const ladderRaw = ladderFileSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, ladderFile), "utf8")));
  const ladderPassed = ladderRaw.candidate.spec === policy && ladderRaw.candidate.paramsSha256 === header.paramsSha256 && ladderRaw.summary.discordant.pValue < ladderRaw.design.alpha && ladderRaw.summary.pooled.share > 0.5;
  const ladder = header.rung >= 1 ? { step: ladderRaw.step, file: ladderFile, sha256: fileSha(path.join(REPO_ROOT, ladderFile)), passed: ladderPassed } : null;
  const listsSetAside = sample.skippedUnmapped.map((x) => ({ draw: x.draw, key: x.key, reason: x.unmapped.some((u) => u.startsWith("invalid-list:")) ? "deck schema" : "engine lacks a card" }));
  return { policy, header, seedRange, evaluationSeedRange, deckSources, ctx, specs, batchSha256, vocab, init, ladder, listsSetAside };
}

export async function sampleBranches(o: SampleOptions): Promise<{ manifest: BranchManifest; report: Record<string, unknown>; outDir: string }> {
  const t0 = performance.now();
  const maxCont = o.maxContinuationDecisions ?? DEFAULTS.maxContinuationDecisions;
  const maxSource = DEFAULTS.maxSourceDecisions;
  const job = o.job ?? "sample-branches";
  const { policy, header, seedRange, evaluationSeedRange, deckSources, ctx, specs, batchSha256, vocab, init, ladder, listsSetAside } = prepareSources(o);
  const sim = await createBranchPool(o.workers, init);
  const p = progress(job, { total: o.games, everyN: 1 });
  let candidateResults: CandidateResult[];
  let branchResults: BranchTaskResult[];
  let tasks: BranchTask[];
  const tA = performance.now();
  let tB = tA;
  try {
    const candTasks: CandidateTask[] = specs.map((spec) => candidateTaskSchema.parse({ gameId: spec.seed, spec, maxSourceDecisions: maxSource }));
    let doneA = 0;
    candidateResults = await sim.run("candidates", candTasks, (raw) => candidateResultSchema.parse(raw), () => p.tick(++doneA, { phase: "candidates", total: o.games }));
    tB = performance.now();
    // An error, a timeout at the cap or a stuck engine is a pathology of the source game, not a decision to learn from.
    const usable = candidateResults.filter(finished);
    const selected = selectDecisions(o.runSeed, usable.flatMap((r) => r.candidates.map((c) => ({ gameId: r.gameId, k: c.k }))), o.rate, o.target);
    const byGame = new Map<string, number[]>();
    for (const c of selected) byGame.set(c.gameId, [...(byGame.get(c.gameId) ?? []), c.k]);
    const resultOf = new Map(candidateResults.map((r) => [r.gameId, r]));
    const specOf = new Map(specs.map((s) => [s.seed, s]));
    tasks = [...byGame.entries()]
      .sort((a, b) => compareCodePoints(a[0], b[0]))
      .map(([gameId, ks]) => {
        const r = resultOf.get(gameId) as CandidateResult;
        const want = new Set(ks);
        return branchTaskSchema.parse({
          gameId,
          spec: specOf.get(gameId),
          ks: r.candidates.filter((c) => want.has(c.k)),
          traceSha256: r.traceSha256,
          sourceOutcome: { endCondition: r.endCondition, winner: r.winner },
          K: o.K,
          N: o.N,
          runSeed: o.runSeed,
          maxContinuationDecisions: maxCont,
          maxSourceDecisions: maxSource,
        });
      });
    // Largest games first so the long tail is short; results are placed by index, so this order changes wall time only.
    const order = tasks.map((_, i) => i).sort((a, b) => tasks[b].ks.length - tasks[a].ks.length || a - b);
    let decisionsDone = 0;
    let beats = 0;
    let doneB = 0;
    const totalDecisions = selected.length;
    const results = await sim.run(
      "branches",
      order.map((i) => tasks[i]),
      (raw) => branchTaskResultSchema.parse(raw),
      (_, r) => {
        decisionsDone += r.records.length;
        p.tick(++doneB, { phase: "branches", total: tasks.length, decisions: decisionsDone, decisionsTotal: totalDecisions });
      },
      () => p.tick(doneB, { phase: "branches", total: tasks.length, decisionsBranched: ++beats, decisionsTotal: totalDecisions }),
    );
    branchResults = new Array(tasks.length);
    order.forEach((ti, pos) => (branchResults[ti] = results[pos]));
  } finally {
    await sim.close();
  }
  const tC = performance.now();

  const records = branchResults.flatMap((r) => r.records).sort((a, b) => compareCodePoints(a.gameId, b.gameId) || a.k - b.k);
  const jsonl = Buffer.from(records.map((r) => `${canonicalJson(r)}\n`).join(""), "utf8");
  const gz = gzipSync(jsonl, { level: 9 });
  const jsonlSha256 = sha256Hex(jsonl);
  const gzSha256 = sha256Hex(gz);

  const errors = new Map<string, number>();
  for (const r of branchResults) for (const [k, v] of Object.entries(r.errors)) errors.set(k, (errors.get(k) ?? 0) + v);
  const stat = (f: (s: BranchTaskResult["stats"]) => number): number => branchResults.reduce((acc, r) => acc + f(r.stats), 0);
  const allMs = (f: (s: BranchTaskResult["stats"]) => number[]): number[] => branchResults.flatMap((r) => f(r.stats));
  const actions = records.reduce((a, r) => a + r.legalActions.length, 0);
  const continuations = stat((s) => s.continuations);
  const sum = (f: (a: BranchRecord["legalActions"][number]) => number): number => records.reduce((acc, r) => acc + r.legalActions.reduce((x, a) => x + f(a), 0), 0);
  const continuationErrors = sum((a) => a.nErr);
  const splits = splitSeedRange(seedRange);
  const inRange = (seed: number, r: SeedRange): boolean => seed >= r.from && seed < r.from + r.count;
  const perSplit = Object.fromEntries(
    (["train", "validation", "test"] as const).map((s) => {
      const rs = records.filter((r) => inRange(r.seed, splits[s]));
      return [s, { range: splits[s], decisions: rs.length, games: new Set(rs.map((r) => r.gameId)).size }];
    }),
  ) as Record<"train" | "validation" | "test", { range: SeedRange; decisions: number; games: number }>;
  const sampledGames = new Set(records.map((r) => r.gameId)).size;
  const replayMismatch = branchResults.filter((r) => r.replayMismatchAt !== null).length;

  const parameters = { runSeed: o.runSeed, rate: o.rate, target: o.target, K: o.K, N: o.N, rung: header.rung, maxContinuationDecisions: maxCont, maxSourceDecisions: maxSource, date: o.date };
  const engine = { commit: ctx.engine.pin.commit, cardDataSha256: ctx.engine.pin.cardDataSha256, node: process.version, undoMode: "free" as const };
  const continuationPolicy = { rung: header.rung, spec: policy, policyId: header.id, version: header.version, paramsSha256: header.paramsSha256, evaluatorManifestSha256: null, ladder };
  const vocabInfo = { dataVersion: `${vocab.dataVersion}.v${vocabRevision(vocab)}`, contentSha256: vocab.contentSha256 };
  const stateInfo = { stateVersion: STATE_VERSION, layoutSha256: STATE_LAYOUT_SHA256 };
  const source = { batchSha256, generator: "in-run" as const, policy, seedRanges: [seedRange], splits, evaluationSeedRange, deckSources: deckSources as ["melee"] };
  const inputHash = sha256Hex(canonicalJson({ parameters, engine: { commit: engine.commit, cardDataSha256: engine.cardDataSha256 }, continuationPolicy, vocab: vocabInfo, state: stateInfo, source, determinization: DETERMINIZE_PRIMITIVE }));
  const manifest = branchManifestSchema.parse({
    schemaVersion: 1,
    label: BRANCH_LABEL,
    purpose: o.purpose,
    trainingEligible: ladder !== null && ladder.passed && header.rung >= 1 && o.purpose === "dataset",
    parameters,
    determinization: { mode: "multiset", primitive: DETERMINIZE_PRIMITIVE },
    engine,
    continuationPolicy,
    vocab: vocabInfo,
    state: stateInfo,
    source,
    counts: {
      sourceGames: candidateResults.length,
      sourceErrors: candidateResults.filter((r) => r.endCondition === "error").length,
      sourceTimeouts: candidateResults.filter((r) => r.endCondition === "timeout" || r.endCondition === "stuck").length,
      sourceReplayMismatch: replayMismatch,
      candidates: candidateResults.filter(finished).reduce((a, r) => a + r.candidates.length, 0),
      singleAnswerSkipped: candidateResults.reduce((a, r) => a + r.singleAnswer, 0),
      sampled: tasks.reduce((a, t) => a + t.ks.length, 0),
      sampledGames,
      testGames: perSplit.test.games,
      records: records.length,
      rootMismatch: records.filter((r) => !r.rootMatched).length,
      actions,
      continuations,
      draws: sum((a) => a.nDraw - a.nTimeout),
      timeouts: sum((a) => a.nTimeout),
      afterTerminal: sum((a) => (a.afterTerminal === "none" || a.afterTerminal === "error" ? 0 : 1)),
      errors: Object.fromEntries([...errors].sort(([a], [b]) => compareCodePoints(a, b))),
      unknownCards: records.reduce((a, r) => a + r.state.unknown, 0),
      unitOverflow: records.reduce((a, r) => a + r.state.overflow.me + r.state.overflow.opp, 0),
    },
    humanDerivedInputs: [],
    outputs: { records: records.length, jsonlSha256, gzSha256 },
    replay: { inputHash, codeCommit: ctx.codeCommit, outputHash: jsonlSha256 },
  });

  const wallSeconds = (performance.now() - t0) / 1000;
  const branchSeconds = (tC - tB) / 1000;
  const noise = noiseOf(records);
  const decks10 = stat((s) => s.decks10);
  const sourceOutcomes = { win: 0, loss: 0, half: 0, null: 0 };
  for (const r of records) {
    if (r.sourceOutcome === 1) sourceOutcomes.win++;
    else if (r.sourceOutcome === 0) sourceOutcomes.loss++;
    else if (r.sourceOutcome === 0.5) sourceOutcomes.half++;
    else sourceOutcomes.null++;
  }
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    label: BRANCH_LABEL,
    purpose: o.purpose,
    workers: o.workers,
    wallSeconds: r4(wallSeconds),
    phaseSeconds: { setup: r4((tA - t0) / 1000), candidates: r4((tB - tA) / 1000), branches: r4(branchSeconds), write: null },
    continuationsPerSecond: r4(branchSeconds > 0 ? continuations / branchSeconds : null),
    decisionsPerHour: r4(branchSeconds > 0 ? (records.length / branchSeconds) * 3600 : null),
    meanContinuationMsPerWorker: r4(continuations > 0 ? stat((s) => s.continuationMs) / continuations : null),
    p50Ms: { rollback: r4(median(allMs((s) => s.rollbackMs))), determinize: r4(median(allMs((s) => s.determinizeMs))), afterstate: r4(median(allMs((s) => s.afterstateMs))) },
    meanActionsPerDecision: r4(records.length > 0 ? actions / records.length : null),
    meanActionSE: r4(noise.meanActionSE),
    detVarianceShare: r4(noise.detVarianceShare),
    rootMatchedFalseFraction: r4(records.length > 0 ? manifest.counts.rootMismatch / records.length : null),
    continuationErrorRate: r4(continuations > 0 ? continuationErrors / continuations : null),
    errorsByType: manifest.counts.errors,
    draws: manifest.counts.draws,
    timeouts: manifest.counts.timeouts,
    sourceOutcomes,
    listsSetAside,
    perSplit,
    replay: { sourceReplayMismatch: replayMismatch, traceMatchedGames: branchResults.filter((r) => r.traceMatched).length, games: branchResults.length },
    instrument: {
      decisionsWithDeck10: decks10,
      distinctTop5Share: r4(decks10 > 0 ? stat((s) => s.decksDistinctTop5) / decks10 : null),
      multisetViolations: stat((s) => s.multisetViolations),
      dealDrift: stat((s) => s.dealDrift),
      rootDrift: stat((s) => s.rootDrift),
    },
    goRule: o.purpose === "pilot" ? { pilotWallHours: r4(wallSeconds / 3600), projectedDatasetHours: r4((wallSeconds / 3600) * 5), rule: "projected hours = pilot wall time x 5 (#125)" } : null,
    errorStop: continuations > 0 && continuationErrors / continuations > 0.05,
  };

  mkdirSync(o.out, { recursive: true });
  writeOnce(path.join(o.out, "branches.jsonl.gz"), gz);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`, "utf8");
  writeOnce(path.join(o.out, "manifest.json"), manifestBytes);
  (report.phaseSeconds as Record<string, unknown>).write = r4((performance.now() - tC) / 1000);
  writeFileSync(path.join(o.out, "run-report.json"), `${JSON.stringify(report, null, 1)}\n`);
  if (o.pin === true) {
    const dir = path.join(REPO_ROOT, "data/pinned/sim-datasets");
    mkdirSync(dir, { recursive: true });
    writeOnce(path.join(dir, `branches-${o.date}.manifest.json`), manifestBytes);
  }
  p.done({ records: records.length, jsonlSha256 });
  if (report.errorStop === true) throw new Error(`more than 5% of continuations errored (${continuationErrors} of ${continuations}); file the errors against #110`);
  return { manifest, report, outDir: o.out };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      purpose: { type: "string", default: "pilot" },
      date: { type: "string", default: "2026-11-01" },
      "run-seed": { type: "string" },
      "seed-from": { type: "string" },
      games: { type: "string" },
      rate: { type: "string", default: "1" },
      target: { type: "string" },
      K: { type: "string", default: "4" },
      N: { type: "string", default: "4" },
      policy: { type: "string", default: DEFAULTS.policy },
      workers: { type: "string", default: "12" },
      out: { type: "string" },
      pin: { type: "boolean", default: false },
      job: { type: "string" },
      "max-continuation-decisions": { type: "string" },
    },
  });
  const parsedPurpose = branchManifestSchema.shape.purpose.safeParse(values.purpose);
  if (!parsedPurpose.success) throw new Error("--purpose is pilot, dataset or fixture");
  const purpose = parsedPurpose.data;
  for (const k of ["seed-from", "games", "target"] as const) if (values[k] === undefined) throw new Error(`--${k} is required`);
  const out = values.out ?? path.join(REPO_ROOT, "data/originals/sims/branches", values.date);
  const { manifest, report } = await sampleBranches({
    purpose,
    date: values.date,
    runSeed: values["run-seed"] ?? `${purpose}-${values.date}`,
    seedFrom: Number(values["seed-from"]),
    games: Number(values.games),
    rate: Number(values.rate),
    target: Number(values.target),
    K: Number(values.K),
    N: Number(values.N),
    policy: values.policy,
    workers: Number(values.workers),
    out,
    pin: values.pin,
    job: values.job,
    maxContinuationDecisions: values["max-continuation-decisions"] === undefined ? undefined : Number(values["max-continuation-decisions"]),
  });
  console.log(JSON.stringify({ out, counts: manifest.counts, outputs: manifest.outputs, replay: manifest.replay, report }, null, 1));
}

if (isMain(import.meta.url)) await main();
