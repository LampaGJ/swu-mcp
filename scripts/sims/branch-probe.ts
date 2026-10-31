/**
 * @displayName forceteki snapshot-branch probe
 * @strategicPurpose Keep measuring whether a seeded match can be paused at a decision, rolled back and continued
 * with other bot choices, ahead of the branching issue (#113), on the typed session.
 * @tacticalObjective Plays with undo on to the first action-window timepoint at or after decision K, takes a manual
 * snapshot, finishes, rolls back, finishes again under the same bot seed (must match), then under N other bot
 * seeds (the branch outcomes). Prints costs in ms. Branching protocol and fidelity are #113's.
 *
 * Usage: tsx scripts/sims/branch-probe.ts --deck1 <json> --deck2 <json> [--seed S] [--at K] [--branches N]
 */
import { parseArgs } from "node:util";
import { startGame, type StartedGame } from "../../src/sims/engine.js";
import { PolicyChain, rung0 } from "../../src/sims/policy.js";
import { Session } from "../../src/sims/session.js";
import { isMain } from "../bench/code-commit.js";
import { contextOptions, loadContext } from "./context.js";
import { loadDeck } from "./decks.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { ...contextOptions, deck1: { type: "string" }, deck2: { type: "string" }, seed: { type: "string", default: "100" }, at: { type: "string", default: "150" }, branches: { type: "string", default: "20" } },
  });
  if (values.deck1 === undefined || values.deck2 === undefined) throw new Error("--deck1 and --deck2 are required");
  const ctx = loadContext(values);
  const decks = [loadDeck(ctx.bridge, values.deck1), loadDeck(ctx.bridge, values.deck2)] as const;
  const at = Number(values.at);
  const ms = (t: number): number => Math.round((performance.now() - t) * 10) / 10;
  const started: StartedGame = await startGame(ctx.engine, [decks[0].list, decks[1].list], { engineSeed: `engine:${values.seed}`, undo: true });
  const { game } = started;
  const session = (seed: string) =>
    new Session(started, { seed, cardKeys: ctx.bridge.engineCardKeys, chains: [new PolicyChain([rung0]), new PolicyChain([rung0])], recordMode: "none", playedMetric: ctx.engine.playedMetric });

  let lastSnap = game.snapshotManager.currentSnapshotId;
  const t0 = performance.now();
  const main = session(values.seed);
  const paused = main.run({
    until: (p) => {
      const id = game.snapshotManager.currentSnapshotId;
      const fresh = id !== lastSnap;
      lastSnap = id;
      return p.k >= at && fresh && game.currentPhase === "action";
    },
  });
  const reachMs = ms(t0);
  if (paused !== "paused") throw new Error(`game ended before decision ${at}`);
  const active = game.actionPhaseActivePlayer;
  if (active === null) throw new Error("no active player at the pause");
  const tSnap = performance.now();
  const snapshotId = game.takeManualSnapshot(active);
  const takeMs = ms(tSnap);
  const k0 = main.k;
  const finish = (seed: string) => {
    const s = session(seed);
    const t = performance.now();
    s.run();
    return { ...s.footer().result, traceSha256: s.traceSha256(), ms: ms(t) };
  };
  const rollback = () => {
    const t = performance.now();
    const ok = game.rollbackToSnapshot(active.id, { type: ctx.engine.SnapshotType.Manual, playerId: active.id, snapshotId });
    return { ok, ms: ms(t) };
  };
  const first = finish("branch:A");
  const rb1 = rollback();
  const replay = rb1.ok ? finish("branch:A") : null;
  const outcomes: ReturnType<typeof finish>[] = [];
  const rollbackMs: number[] = [];
  for (let b = 0; b < Number(values.branches); b++) {
    const rb = rollback();
    rollbackMs.push(rb.ms);
    if (!rb.ok) break;
    outcomes.push(finish(`branch:${b}`));
  }
  const tally = { 1: 0, 2: 0, other: 0 };
  for (const o of outcomes) tally[o.winner ?? "other"] += 1;
  const mean = (xs: number[]): number => Math.round((xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)) * 10) / 10;
  console.log(
    JSON.stringify(
      {
        seed: values.seed,
        pausedAtDecision: k0,
        reachMs,
        takeManualSnapshotMs: takeMs,
        firstContinuation: { winner: first.winner, decisions: first.decisions, traceSha256: first.traceSha256 },
        firstRollback: rb1,
        replaySameBotSeedMatches: replay === null ? null : replay.traceSha256 === first.traceSha256 && replay.winner === first.winner,
        branches: outcomes.length,
        branchWinnerTally: tally,
        distinctBranchTraces: new Set(outcomes.map((o) => o.traceSha256)).size,
        meanRollbackMs: mean(rollbackMs),
        meanBranchContinuationMs: mean(outcomes.map((o) => o.ms)),
      },
      null,
      1,
    ),
  );
}

if (isMain(import.meta.url)) await main();
