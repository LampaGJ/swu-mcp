/**
 * @displayName Branch sampler worker
 * @strategicPurpose One source game per pool task (#125): replay it from its seed, decks and policies, and at each
 * sampled decision estimate every legal action's value over K re-dealt hidden worlds and N seeded continuations, so
 * the evaluator trains on what the engine says an action is worth, not on what a bot happened to play.
 * @tacticalObjective Two task kinds. `candidates` plays the source game once and lists its candidate decisions (main
 * action, fresh timepoint, two or more answers) with the chosen descriptor and the footer. `branches` replays it,
 * pauses at each sampled k, bookmarks the root through the session's own search hooks (src/sims/session.ts), rolls back
 * once and treats the restored state as the root, records each action's afterstate on the true root, then for every
 * (j, i, action) rolls back, re-deals with the flat Monte Carlo primitive (src/sims/policies/flat-mc.ts determinize),
 * reseeds the engine and plays the action and the rest of the game under fresh continuation chains. After the last k
 * the source game runs on, and its traceSha256 must equal the candidate pass's, or the game's records are dropped.
 * Runs in-thread for tests, or as a worker_thread for scripts/sims/sample-branches.ts.
 */
import { performance } from "node:perf_hooks";
import { parentPort, workerData, isMainThread } from "node:worker_threads";
import { createHash } from "node:crypto";
import {
  aggregateAction,
  branchTaskResultSchema,
  branchTaskSchema,
  candidateResultSchema,
  candidateTaskSchema,
  continuationOutcome,
  isCandidate,
  seedKeys,
  sourceOutcomeOf,
  type ActionValue,
  type BranchRecord,
  type BranchStats,
  type BranchTask,
  type BranchTaskResult,
  type CandidateResult,
  type CandidateTask,
  type Outcome,
} from "../../src/sims/branches.js";
import { enumerateActions } from "../../src/sims/actions.js";
import type { EnginePin } from "../../src/sims/engine-pin.js";
import { installSelectableCardsMemo, loadEngine, startGame, type Engine, type EngineGame, type EnginePlayer, type StartedGame } from "../../src/sims/engine.js";
import { buildHeader, chainForHeader, type MatchSpec } from "../../src/sims/match.js";
import { POLICIES, PolicyChain, type SearchBookmark } from "../../src/sims/policy.js";
import { determinize } from "../../src/sims/policies/flat-mc.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { driverName, registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { Session, type Pending } from "../../src/sims/session.js";
import { extractStateView, type StateViewKeys } from "../../src/sims/state-view.js";
import { encodeState, type EncodedState } from "../../src/sims/state.js";
import { compileVocab, parseVocab, type CompiledVocab } from "../../src/sims/vocab.js";
import { compareCodePoints } from "../../src/swu/canonical.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript */
type AnyCard = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface BranchWorkerInit {
  forceteki: string;
  pin: EnginePin;
  memo: boolean;
  /** The run whose card tables the continuation rung reads (data/runs/<date>). */
  tablesRun: string;
  complementarity: string;
  policy: string;
  vocab: unknown;
  viewKeys: StateViewKeys;
  cardKeys: Record<string, string>;
}

export interface BranchContext {
  engine: Engine;
  cardKeys: Readonly<Record<string, string>>;
  viewKeys: StateViewKeys;
  vocab: CompiledVocab;
  /** A fresh continuation chain: no policy memory crosses from one continuation into another. */
  chain: () => PolicyChain;
}

export function branchContext(init: BranchWorkerInit, engine: Engine = loadEngine(init.forceteki, { pin: init.pin, verify: false })): BranchContext {
  if (init.memo) installSelectableCardsMemo(init.forceteki);
  const tables = loadTables({ runDir: init.tablesRun, complementarity: init.complementarity, pairs: false });
  registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), [init.policy], tables);
  const name = driverName(init.policy);
  const make = POLICIES[name];
  if (make === undefined) throw new Error(`policy ${init.policy} did not register as ${name}`);
  return { engine, cardKeys: init.cardKeys, viewKeys: init.viewKeys, vocab: compileVocab(parseVocab(init.vocab)), chain: make };
}

async function startSource(ctx: BranchContext, spec: MatchSpec, maxDecisions: number): Promise<{ started: StartedGame; session: Session }> {
  const header = buildHeader(ctx.engine, spec, ctx.cardKeys);
  const started = await startGame(ctx.engine, [header.decks[0].engineList, header.decks[1].engineList], { engineSeed: header.rng.engineSeed, undo: true });
  const session = new Session(started, {
    seed: header.seed,
    cardKeys: ctx.cardKeys,
    chains: [chainForHeader(header.policies[0]), chainForHeader(header.policies[1])],
    recordMode: "none",
    playedMetric: ctx.engine.playedMetric,
    maxDecisions,
    manualSnapshotType: ctx.engine.SnapshotType.Manual,
  });
  return { started, session };
}

const cursorText = (p: Pending): string => `${p.rngCursor.engineDraws}:${p.rngCursor.engineStateSha}:${p.rngCursor.botDraws}`;
const winnerOf = (game: EngineGame): 1 | 2 | null => (game.winnerNames.length === 1 ? (game.winnerNames[0] === "sim1" ? 1 : 2) : null);

export async function runCandidateTask(ctx: BranchContext, raw: CandidateTask): Promise<CandidateResult> {
  const task = candidateTaskSchema.parse(raw);
  const { started, session } = await startSource(ctx, task.spec as MatchSpec, task.maxSourceDecisions);
  const game = started.game;
  let last = game.snapshotManager.currentSnapshotId;
  let pending: Omit<CandidateResult["candidates"][number], "chosen"> | null = null;
  let singleAnswer = 0;
  const candidates: CandidateResult["candidates"] = [];
  session.run({
    until: (p) => {
      const id = game.snapshotManager.currentSnapshotId;
      if (isCandidate(last, id, game.currentPhase, p.promptKind, p.actions.length)) pending = { k: p.k, actor: p.seat, legalActionsSha256: p.legalActionsSha256, rngCursor: cursorText(p) };
      else if (isCandidate(last, id, game.currentPhase, p.promptKind, 2)) singleAnswer++;
      last = id;
      return false;
    },
    check: (p, choice) => {
      const c = pending as Omit<CandidateResult["candidates"][number], "chosen"> | null;
      if (c !== null && c.k === p.k) candidates.push({ ...c, chosen: p.actions[choice.index].action.descriptor });
      pending = null;
      return false;
    },
  });
  const end = session.endCondition ?? "error";
  return candidateResultSchema.parse({
    gameId: task.gameId,
    endCondition: end,
    winner: end === "base_destroyed" ? winnerOf(game) : null,
    decisions: session.k,
    traceSha256: session.traceSha256(),
    candidates,
    singleAnswer,
  });
}

const zoneNames = (cards: readonly AnyCard[]): string[] => cards.map((c) => String(c.internalName));
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const errorKey = (where: string, message: string | null): string => `${where}: ${(message ?? "unknown").replace(/\s+/g, " ").slice(0, 80)}`;

/** Branches one paused decision. Leaves the engine on the restored root with the bookmark released. */
function branchAt(ctx: BranchContext, task: BranchTask, started: StartedGame, source: Session, p: Pending, chosen: string, stats: BranchStats, errors: Map<string, number>): BranchRecord {
  const { game } = started;
  const players = source.players as readonly [EnginePlayer, EnginePlayer];
  const actor = p.seat;
  const hooks = source.hooks[actor - 1];
  const fail = (key: string): void => void errors.set(key, (errors.get(key) ?? 0) + 1);
  const mark: SearchBookmark = hooks.bookmark();
  try {
    const rollback = (): void => {
      const t = performance.now();
      hooks.rollback(mark);
      stats.rollbackMs.push(performance.now() - t);
    };
    rollback();
    const roots = enumerateActions(game, players, actor, ctx.cardKeys).map((a) => a.action);
    const rootDescriptors = roots.map((a) => a.descriptor);
    const rootMatched = rootDescriptors.length === p.actions.length && rootDescriptors.every((d, i) => d === p.actions[i].action.descriptor);
    const encode = (): EncodedState => encodeState(extractStateView(game, actor, ctx.viewKeys), ctx.vocab);
    const state = encode();
    const round = game.roundNumber;
    const me = players[actor - 1] as AnyCard;
    const opp = players[2 - actor] as AnyCard;
    const rootOppMultiset = [...zoneNames(opp.hand), ...zoneNames(opp.drawDeck)].sort(compareCodePoints).join(",");
    const deckAtRoot = (me.drawDeck as AnyCard[]).length;

    const continuation = (seed: string, descriptor: string, until?: (q: Pending, s: Session) => boolean): { session: Session; paused: boolean } => {
      const s = new Session(started, {
        seed,
        cardKeys: ctx.cardKeys,
        chains: [ctx.chain(), ctx.chain()],
        recordMode: "none",
        playedMetric: ctx.engine.playedMetric,
        maxDecisions: task.maxContinuationDecisions,
        manualSnapshotType: ctx.engine.SnapshotType.Manual,
      });
      const r = s.run({
        force: (q, ss) => {
          if (ss.k !== 0) return null;
          if (q.seat !== actor) throw new Error(`forced action: seat ${q.seat} decides first, not the actor ${actor}`);
          const i = q.actions.findIndex((a) => a.action.descriptor === descriptor);
          if (i < 0) throw new Error(`forced action ${descriptor} is not legal at the continuation root`);
          return i;
        },
        until,
      });
      return { session: s, paused: r === "paused" };
    };
    const reseed = (key: string): void => (game.randomGenerator as unknown as { reseed(seed: string): void }).reseed(key);

    // Afterstates once, on the true root: the action, then both seats under the continuation rung to the next
    // main-action prompt, the end of the action phase or the end of the game (rung 3's horizon, src/sims/policies/rung3.ts:113-122).
    const after = roots.map((a): Pick<ActionValue, "afterState" | "afterTerminal"> => {
      rollback();
      const t = performance.now();
      reseed(seedKeys.after(task.runSeed, task.gameId, p.k));
      const { session: s, paused } = continuation(seedKeys.after(task.runSeed, task.gameId, p.k), a.descriptor, (q, ss) => ss.k >= 1 && (game.currentPhase !== "action" || q.promptKind === "mainAction"));
      let out: Pick<ActionValue, "afterState" | "afterTerminal">;
      if (paused) out = { afterState: encode(), afterTerminal: "none" };
      else {
        const o = continuationOutcome(s.endCondition ?? "error", winnerOf(game), actor);
        if (o === "win" || o === "loss" || o === "draw") out = { afterState: null, afterTerminal: o };
        else {
          fail(errorKey(`afterstate ${s.endCondition}`, s.error));
          out = { afterState: null, afterTerminal: "error" };
        }
      }
      stats.afterstateMs.push(performance.now() - t);
      return out;
    });

    // grid[a][j][i]; keys depend on (j, i) only, so every action sees the same deals and streams.
    const grid: Outcome[][][] = roots.map(() => Array.from({ length: task.K }, () => [] as Outcome[]));
    const tops = new Set<string>();
    for (let j = 1; j <= task.K; j++) {
      let dealSig: string | null = null;
      for (let i = 1; i <= task.N; i++) {
        roots.forEach((a, ai) => {
          rollback();
          if (ai === 0 && !(j === 1 && i === 1)) {
            const now = enumerateActions(game, players, actor, ctx.cardKeys).map((x) => x.action.descriptor);
            if (now.length !== rootDescriptors.length || now.some((d, x) => d !== rootDescriptors[x])) stats.rootDrift++;
          }
          const t = performance.now();
          determinize(game, players, actor, seedKeys.det(task.runSeed, task.gameId, p.k, j));
          stats.determinizeMs.push(performance.now() - t);
          const myDeck = zoneNames(me.drawDeck);
          const sig = sha(`${myDeck.join(",")}|${zoneNames(opp.hand).join(",")}|${zoneNames(opp.drawDeck).join(",")}`);
          if (dealSig === null) {
            dealSig = sig;
            tops.add(myDeck.slice(0, 5).join(","));
            if ([...zoneNames(opp.hand), ...zoneNames(opp.drawDeck)].sort(compareCodePoints).join(",") !== rootOppMultiset) stats.multisetViolations++;
          } else if (sig !== dealSig) stats.dealDrift++;
          reseed(seedKeys.engine(task.runSeed, task.gameId, p.k, j, i));
          const tc = performance.now();
          const { session: s } = continuation(seedKeys.cont(task.runSeed, task.gameId, p.k, j, i), a.descriptor);
          stats.continuationMs += performance.now() - tc;
          stats.continuations++;
          const o = continuationOutcome(s.endCondition ?? "error", winnerOf(game), actor);
          if (o === "error") fail(errorKey("continuation", s.error));
          grid[ai][j - 1].push(o);
        });
      }
    }
    if (deckAtRoot >= 10) {
      stats.decks10++;
      if (tops.size >= 2) stats.decksDistinctTop5++;
    }
    rollback();
    const index = rootDescriptors.indexOf(chosen);
    return {
      schemaVersion: 1,
      gameId: task.gameId,
      seed: Number(task.spec.seed),
      k: p.k,
      round,
      phase: "action",
      actor,
      promptKind: p.promptKind,
      state,
      legalActions: roots.map((a, ai) => ({ descriptor: a.descriptor, kind: a.kind, cardKey: a.cardKey, ...aggregateAction(grid[ai]), ...after[ai] })),
      chosen: { descriptor: chosen, index: index < 0 ? null : index },
      sourceOutcome: sourceOutcomeOf(task.sourceOutcome.endCondition, task.sourceOutcome.winner, actor),
      rngCursor: cursorText(p),
      rootMatched,
      determinization: { mode: "multiset", K: task.K, N: task.N },
    };
  } finally {
    hooks.release(mark);
  }
}

export async function runBranchTask(ctx: BranchContext, raw: BranchTask, onDecision: () => void = () => undefined): Promise<BranchTaskResult> {
  const task = branchTaskSchema.parse(raw);
  const { started, session } = await startSource(ctx, task.spec as MatchSpec, task.maxSourceDecisions);
  const at = new Map(task.ks.map((x) => [x.k, x]));
  const done = new Set<number>();
  const stats: BranchStats = { rollbackMs: [], determinizeMs: [], afterstateMs: [], continuationMs: 0, continuations: 0, decks10: 0, decksDistinctTop5: 0, multisetViolations: 0, dealDrift: 0, rootDrift: 0 };
  const errors = new Map<string, number>();
  const records: BranchRecord[] = [];
  let replayMismatchAt: number | null = null;
  for (;;) {
    let paused: Pending | null = null;
    const r = session.run({
      until: (p) => {
        if (!at.has(p.k) || done.has(p.k)) return false;
        paused = p;
        return true;
      },
    });
    if (r === "ended" || paused === null) break;
    const p: Pending = paused;
    const want = at.get(p.k) as BranchTask["ks"][number];
    if (p.seat !== want.actor || p.legalActionsSha256 !== want.legalActionsSha256 || cursorText(p) !== want.rngCursor) {
      replayMismatchAt = p.k;
      break;
    }
    done.add(p.k);
    try {
      records.push(branchAt(ctx, task, started, session, p, want.chosen, stats, errors));
      onDecision();
    } catch (e) {
      const key = errorKey("branch", String((e as Error)?.message ?? e));
      errors.set(key, (errors.get(key) ?? 0) + 1);
    }
  }
  if (replayMismatchAt === null && done.size < at.size) replayMismatchAt = task.ks.find((x) => !done.has(x.k))?.k ?? null;
  const traceMatched = replayMismatchAt === null && session.ended && session.traceSha256() === task.traceSha256 && session.endCondition === task.sourceOutcome.endCondition;
  const result: BranchTaskResult = {
    gameId: task.gameId,
    replayMismatchAt,
    traceMatched,
    records,
    errors: Object.fromEntries([...errors].sort(([a], [b]) => compareCodePoints(a, b))),
    stats,
  };
  return branchTaskResultSchema.parse(result);
}

// ---------------------------------------------------------------------------------------------------------------------
// Worker thread: claims task indexes from the batch's shared counter and posts each result as it finishes.

interface Batch {
  id: number;
  kind: "candidates" | "branches";
  tasks: unknown[];
  counter: Int32Array;
}

if (!isMainThread && parentPort !== null && (workerData as { branchWorker?: boolean })?.branchWorker === true) {
  const port = parentPort;
  // No emitter gate on workerData: the main thread assembles it in-process from already-parsed sources (vocab, decks, pins), and every task below is parsed on arrival.
  const ctx = branchContext((workerData as { init: BranchWorkerInit }).init);
  port.on("message", async ({ id, kind, tasks, counter }: Batch) => {
    try {
      for (let i = Atomics.add(counter, 0, 1); i < tasks.length; i = Atomics.add(counter, 0, 1)) {
        const out = kind === "candidates" ? await runCandidateTask(ctx, tasks[i] as CandidateTask) : await runBranchTask(ctx, tasks[i] as BranchTask, () => port.postMessage({ id, beat: true }));
        port.postMessage({ id, i, out });
      }
      port.postMessage({ id, done: true });
    } catch (e) {
      port.postMessage({ id, error: String((e as Error)?.stack ?? e) });
    }
  });
  port.postMessage({ ready: true });
}
