/**
 * @displayName forceteki snapshot-branch probe (spike)
 * @strategicPurpose Answer whether a seeded match can be paused at a decision, rolled back, and replayed with
 * different bot choices ("what else could have happened if the bot chose differently at decision k").
 * @tacticalObjective Plays a game with undo enabled to the first action-window timepoint at or after decision K,
 * takes a manual snapshot, finishes the game, rolls back, finishes again with the same bot stream (must match),
 * then with N different bot streams (the branch outcomes). Prints costs in ms.
 *
 * Usage: node scripts/sims/branch-probe.mjs --deck1 <json> --deck2 <json> --seed S --at K --branches N
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULT_FORCETEKI, loadEngine, Session, startGame } from "./play-game.mjs";

const { values } = parseArgs({
  options: {
    deck1: { type: "string" },
    deck2: { type: "string" },
    seed: { type: "string", default: "100" },
    at: { type: "string", default: "150" },
    branches: { type: "string", default: "20" },
    forceteki: { type: "string", default: DEFAULT_FORCETEKI },
  },
});
const engine = loadEngine(values.forceteki);
const { SnapshotType, seedrandom } = engine;
const d1 = JSON.parse(readFileSync(values.deck1, "utf8"));
const d2 = JSON.parse(readFileSync(values.deck2, "utf8"));
const seed = Number(values.seed);
const at = Number(values.at);
const ms = (t) => Math.round((performance.now() - t) * 10) / 10;

const game = await startGame(engine, d1, d2, { seed, undo: true });
const session = new Session(game, { trace: false });

let lastSnap = game.snapshotManager.currentSnapshotId;
const t0 = performance.now();
const paused = session.run(seedrandom(`bot:${seed}`), {
  until: (s) => {
    const id = game.snapshotManager.currentSnapshotId;
    const newPoint = id !== lastSnap;
    lastSnap = id;
    return s.k >= at && newPoint && game.currentPhase === "action";
  },
});
const reachMs = ms(t0);
if (paused !== "paused") throw new Error(`game ended before decision ${at}`);

const active = game.actionPhaseActivePlayer;
const tSnap = performance.now();
const snapshotId = game.takeManualSnapshot(active);
const takeMs = ms(tSnap);
const k0 = session.k;
const finish = (botSeed) => {
  const s = new Session(game);
  const t = performance.now();
  s.run(seedrandom(botSeed));
  return { ...s.summary(botSeed, performance.now() - t), ms: ms(t) };
};

const first = finish(`branch:A`);
const rollbackOnce = () => {
  const t = performance.now();
  const ok = game.rollbackToSnapshot(active.id, { type: SnapshotType.Manual, playerId: active.id, snapshotId });
  return { ok, ms: ms(t) };
};
const rb1 = rollbackOnce();
const replay = rb1.ok ? finish(`branch:A`) : null;

const outcomes = [];
const rollbackMs = [];
for (let b = 0; b < Number(values.branches); b++) {
  const rb = rollbackOnce();
  rollbackMs.push(rb.ms);
  if (!rb.ok) {
    outcomes.push({ error: "rollback failed" });
    break;
  }
  outcomes.push(finish(`branch:${b}`));
}
const tally = { 1: 0, 2: 0, other: 0 };
for (const o of outcomes) tally[o.winner ?? "other"]++;

console.log(
  JSON.stringify(
    {
      seed,
      pausedAtDecision: k0,
      snapshotId,
      phase: game.currentPhase,
      reachMs,
      takeManualSnapshotMs: takeMs,
      firstContinuation: { winner: first.winner, prompts: first.prompts, traceSha256: first.traceSha256 },
      firstRollback: rb1,
      replaySameBotStreamMatches: replay ? replay.traceSha256 === first.traceSha256 && replay.winner === first.winner : null,
      branches: outcomes.length,
      branchWinnerTally: tally,
      distinctBranchTraces: new Set(outcomes.map((o) => o.traceSha256)).size,
      meanRollbackMs: Math.round((rollbackMs.reduce((a, b) => a + b, 0) / Math.max(1, rollbackMs.length)) * 10) / 10,
      meanBranchContinuationMs: Math.round((outcomes.reduce((a, o) => a + (o.ms ?? 0), 0) / Math.max(1, outcomes.length)) * 10) / 10,
    },
    null,
    1,
  ),
);
