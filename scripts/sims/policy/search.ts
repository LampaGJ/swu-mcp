/**
 * @displayName Learned rungs 3 and 4 on engine snapshots
 * @strategicPurpose A bot that judges each candidate action by the captured evaluator V on the real rules engine
 * (#128, D96), so the learned state value, not a hand-written one, decides which line is best; simulation bots only,
 * never a served score (D1, CLAUDE.md "No model in the scoring path").
 * @tacticalObjective At a main-action prompt with two or more answers: candidates are the ranking pilot's top k by
 * exclusion (rung 1 with sacGuard and handCap, D92, D95; rung 2 was never promoted, D79) plus Pass and Claim
 * Initiative. Rung 3 (`rung3v`, mode none, reads the true state): bookmark, apply the candidate, resolve every
 * following prompt of both seats with the pilot to the next main-action prompt, the end of the action phase or the
 * end of the game (the leaf #125's afterstates were taken at, src/sims/branches.ts and scripts/sims/branch-worker.ts),
 * score V from the actor's seat, roll back. Rung 4 (`rung4`, mode multiset) repeats that under D re-deals of hidden
 * information (flat Monte Carlo's `determinize`, re-applied after every root rollback because a manual snapshot is the
 * start of the action, D95) and, where the candidate ends at the opponent's fresh main-action prompt, bookmarks it and
 * takes the minimum over the opponent's top m replies by the same pilot. Leaves round to 4 decimals, the mean over
 * determinizations is rounded again, the highest mean wins (ties by rank, then descriptor), and the decision record
 * carries the whole search block. Every other prompt is the pilot on the same view builder.
 */
import { seededRandom } from "../../bench/stats.js";
import { enumerateActions, promptKindOf, type CanonicalAction } from "../../../src/sims/actions.js";
import type { EngineGame, EnginePlayer } from "../../../src/sims/engine.js";
import type { PolicyChoice, SearchBookmark, SearchHooks } from "../../../src/sims/policy.js";
import { decidingSeats } from "../../../src/sims/search-leaf.js";
import type { SearchBlock } from "../../../src/sims/schemas.js";
import { ViewBuilder, type TypedAction } from "../../../src/sims/policies/engine-view.js";
import { determinize } from "../../../src/sims/policies/flat-mc.js";
import { LEARNED_VERSION, RUNG1_VERSION, type LearnedParams } from "../../../src/sims/policies/index.js";
import { HORIZON, rankByExclusion, RUNG3_PARAMS, type LookaheadParams } from "../../../src/sims/policies/lookahead.js";
import { makeRulePolicy, RUNG1_PARAMS, type RuleParams } from "../../../src/sims/policies/rules.js";
import { runToHorizon } from "../../../src/sims/policies/rung3.js";
import type { CardTables } from "../../../src/sims/policies/tables.js";
import type { BotPolicy, GameView, LegalAnswer } from "../../../src/sims/policies/types.js";
import type { StateScorer } from "../evaluator-hook.js";
import { candidateMean, candidateOrder, pickScored, r4, replyValue, terminalValue, type ScoredCandidate } from "./search-core.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript */
type AnyGame = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface LearnedCounters {
  searches: number;
  trials: number;
  trialDecisions: number;
  trialErrors: number;
  /** Searches whose pick differed from the ranking pilot's. */
  overrides: number;
  cutAtCap: number;
  noOps: number;
  evaluatorCalls: number;
  determinizations: number;
  replies: number;
  /** Candidates whose reply ply fell back to the one-ply value, by reason. */
  replyFallbacks: number;
  replySnapshotUnavailable: number;
  loopGuard: number;
}

const pilot = (p: LearnedParams): BotPolicy => {
  const params: RuleParams = { ...RUNG1_PARAMS };
  if (p.sacGuard === 1) params.sacGuard = 1;
  if (p.handCap === 1) params.handCap = 1;
  return makeRulePolicy({ id: "rung1-rules", version: RUNG1_VERSION, rung: 1, params });
};

interface View {
  seat: 1 | 2;
  k: number;
  promptKind: string;
  game: EngineGame;
  players: readonly EnginePlayer[];
  search?: SearchHooks;
}

export interface LearnedPolicyOptions {
  rung: 3 | 4;
  params: LearnedParams;
  tables: CardTables;
  inputs: Record<string, string>;
  scorer: StateScorer;
  evaluatorSha256: string;
}

export const LEARNED_POLICY_IDS = { 3: "rung3-value", 4: "rung4-search" } as const;

/** The re-deal key of determinization d at decision k (D95 names the same primitive `det`). */
export const detKey = (seed: string, seat: 1 | 2, k: number, d: number): string => `det|${seed}|${seat}|${k}|${d}`;

export function learnedSearchPolicy(o: LearnedPolicyOptions) {
  const { rung, params, tables, scorer } = o;
  let game: unknown = null;
  let builder: ViewBuilder | null = null;
  const bot = pilot(params);
  const decide = bot.decide;
  if (decide === undefined) throw new Error("the ranking pilot exposes no pure decide");
  const counters: LearnedCounters = { searches: 0, trials: 0, trialDecisions: 0, trialErrors: 0, overrides: 0, cutAtCap: 0, noOps: 0, evaluatorCalls: 0, determinizations: 0, replies: 0, replyFallbacks: 0, replySnapshotUnavailable: 0, loopGuard: 0 };
  const horizon: LookaheadParams = { ...RUNG3_PARAMS, horizon: HORIZON.reply, maxTrialDecisions: params.maxTrialDecisions };
  const round: LookaheadParams = { ...horizon, horizon: HORIZON.round };
  const recent: string[] = [];
  const D = rung === 4 ? params.d : 1;

  /**
   * horizon=round: the pilots play both seats on to the end of the action phase before the leaf is scored.
   * horizon=next: on through the regroup phase to the first main-action prompt of the next round, so resources left
   * unspent are ready again and only what the line kept or built is scored.
   */
  const finish = (g: AnyGame, players: readonly [EnginePlayer, EnginePlayer], keys: Readonly<Record<string, string>>, random: () => number): void => {
    if ((params.horizon !== 1 && params.horizon !== 2) || g.isEnded || g.currentPhase !== "action") return;
    const builders = [new ViewBuilder(g, 1, tables), new ViewBuilder(g, 2, tables)] as const;
    const bots = [pilot(params), pilot(params)] as const;
    const r = runToHorizon(g, players, keys, round, builders, bots, random);
    counters.trialDecisions += r.decisions;
    if (r.cut) counters.cutAtCap++;
    if (params.horizon !== 2) return;
    const startRound = g.roundNumber as number;
    let idle = 0;
    for (let n = 0; n < params.maxTrialDecisions; n++) {
      if (g.isEnded || (g.currentPhase === "action" && g.roundNumber > startRound && decidingSeats(players).some((x) => promptKindOf(players[x - 1]) === "mainAction"))) return;
      const seats = decidingSeats(players);
      if (seats.length === 0) {
        g.continue();
        if (++idle > 50) return;
        n--;
        continue;
      }
      idle = 0;
      const x = seats[0];
      const acts = enumerateActions(g, players, x, keys);
      const { view, answers } = builders[x - 1].build(acts.map((a) => a.action) as unknown as TypedAction[], random);
      const i = bots[x - 1].tryChoose(answers, view) ?? Math.floor(random() * answers.length);
      builders[x - 1].record(view, answers[i]);
      acts[i].run(random);
      g.continue();
      counters.trialDecisions++;
    }
    counters.cutAtCap++;
  };

  /** The actor's value of the live state: terminal plus or minus 20, else V; every leaf 0 in stub mode. */
  const leaf = (g: AnyGame, seat: 1 | 2): number => {
    if (params.stub === 1) return 0;
    if (g.isEnded) {
      const names = g.winnerNames as string[];
      const winner = names.length === 1 ? (names[0] === "sim1" ? 1 : 2) : null;
      return terminalValue(winner === null ? "draw" : winner === seat ? "won" : "lost");
    }
    counters.evaluatorCalls++;
    return scorer.score(g, seat)[0];
  };
  const leafAt = (g: AnyGame, players: readonly [EnginePlayer, EnginePlayer], keys: Readonly<Record<string, string>>, seat: 1 | 2, key: string): number => {
    finish(g, players, keys, seededRandom(`${key}|finish`));
    return leaf(g, seat);
  };

  /** Applies one answer at the live prompt and resolves both seats with fresh pilots to the next leaf. */
  const applyAndResolve = (g: EngineGame, players: readonly [EnginePlayer, EnginePlayer], keys: Readonly<Record<string, string>>, seat: 1 | 2, act: CanonicalAction, view: GameView, answer: LegalAnswer, random: () => number): void => {
    const builders = [new ViewBuilder(g, 1, tables), new ViewBuilder(g, 2, tables)] as const;
    const bots = [pilot(params), pilot(params)] as const;
    builders[seat - 1].record(view, answer);
    act.run(random);
    g.continue();
    const r = runToHorizon(g, players, keys, horizon, builders, bots, random);
    counters.trialDecisions += r.decisions;
    if (r.cut) counters.cutAtCap++;
  };

  const sameActions = (fresh: readonly CanonicalAction[], actions: readonly TypedAction[], k: number, where: string): void => {
    if (fresh.length !== actions.length || fresh.some((a, i) => a.action.descriptor !== actions[i].descriptor)) throw new Error(`${LEARNED_POLICY_IDS[rung]}: legal actions changed across a rollback at decision ${k} (${where})`);
  };

  /** The reply ply: min over the opponent's top m replies from a bookmark of the opponent's fresh main-action prompt. */
  const replies = (g: AnyGame, players: readonly [EnginePlayer, EnginePlayer], hooks: SearchHooks, seat: 1 | 2, rootSnapshot: number, key: string): { value: number | null; fallback: string | null } => {
    const opp = (3 - seat) as 1 | 2;
    const seats = g.isEnded || g.currentPhase !== "action" ? [] : decidingSeats(players);
    if (seats.length === 0 || seats[0] !== opp || promptKindOf(players[opp - 1]) !== "mainAction") return { value: leafAt(g, players, hooks.cardKeys, seat, key), fallback: "one-ply: no opponent main action next" };
    const mark: SearchBookmark = hooks.bookmark();
    // A manual snapshot aliases the current timepoint's; only a fresh timepoint holds the determinized state (D95).
    if (mark.snapshotId === rootSnapshot || mark.snapshotId !== g.snapshotManager.currentSnapshotId) {
      counters.replySnapshotUnavailable++;
      return { value: leafAt(g, players, hooks.cardKeys, seat, key), fallback: "reply-snapshot-unavailable" };
    }
    try {
      const acts = enumerateActions(g, players, opp, hooks.cardKeys);
      const ob = new ViewBuilder(g, opp, tables);
      const rnd = seededRandom(`${key}|replies`);
      const { view, answers } = ob.build(acts.map((a) => a.action) as unknown as TypedAction[], rnd);
      const ranked = rankByExclusion(answers, view, decide, params.m);
      if (ranked.length === 0) return { value: leafAt(g, players, hooks.cardKeys, seat, key), fallback: "one-ply: the pilot ranks no reply" };
      const descriptors = acts.map((a) => a.action.descriptor);
      const leaves: (number | null)[] = [];
      for (const [j, ri] of ranked.entries()) {
        if (j > 0) {
          hooks.rollback(mark);
          const again = enumerateActions(g, players, opp, hooks.cardKeys);
          if (again.length !== descriptors.length || again.some((a, x) => a.action.descriptor !== descriptors[x])) throw new Error(`reply actions changed across a rollback (${key})`);
          acts.splice(0, acts.length, ...again);
        }
        counters.replies++;
        try {
          applyAndResolve(g, players, hooks.cardKeys, opp, acts[ri], view, answers[ri], seededRandom(`${key}|reply|${ri}`));
          leaves.push(r4(leafAt(g, players, hooks.cardKeys, seat, `${key}|reply|${ri}`)));
        } catch {
          counters.trialErrors++;
          leaves.push(null);
        }
      }
      return { value: replyValue(leaves), fallback: null };
    } finally {
      hooks.release(mark);
    }
  };

  const search = (actions: readonly TypedAction[], answers: readonly LegalAnswer[], order: readonly number[], v: View, rootView: GameView): { pick: number; block: SearchBlock } => {
    const hooks = v.search;
    if (hooks === undefined) throw new Error(`${LEARNED_POLICY_IDS[rung]} needs the driver's search hooks (a typed-driver session)`);
    const g = v.game as AnyGame;
    const players = v.players as unknown as readonly [EnginePlayer, EnginePlayer];
    const seat = v.seat;
    counters.searches++;
    const mark = hooks.bookmark();
    const rootSnapshot = g.snapshotManager.currentSnapshotId as number;
    const cands: ScoredCandidate[] = order.map((idx, rank) => ({ index: idx, descriptor: actions[idx].descriptor, rank, values: [], mean: null, fallback: null }));
    try {
      for (let d = 0; d < D; d++) {
        for (const c of cands) {
          const fresh = enumerateActions(g, players, seat, hooks.cardKeys);
          sameActions(fresh, actions, v.k, `d ${d}, ${c.descriptor}`);
          const key = `${rung === 3 ? "v3" : "v4"}|${hooks.seed}|${seat}|${v.k}|${d}|${c.index}`;
          let value: number | null;
          try {
            if (rung === 4) {
              determinize(g, players, seat, detKey(hooks.seed, seat, v.k, d));
              counters.determinizations++;
            }
            applyAndResolve(g, players, hooks.cardKeys, seat, fresh[c.index], rootView, answers[c.index], seededRandom(key));
            const ended = Boolean(g.isEnded);
            const seats = ended ? [] : decidingSeats(players);
            // Back at our own main action in the same timepoint: the click did nothing (a cancelled play). The pilot's
            // own pick keeps its value, so a stub search still plays the pilot.
            if (c.rank > 0 && !ended && g.currentPhase === "action" && seats[0] === seat && promptKindOf(players[seat - 1]) === "mainAction" && g.snapshotManager.currentSnapshotId === rootSnapshot) {
              counters.noOps++;
              value = null;
              c.fallback = "no-op";
            } else if (rung === 4) {
              const r = replies(g, players, hooks, seat, rootSnapshot, key);
              value = r.value === null ? null : r4(r.value);
              if (r.fallback !== null) {
                counters.replyFallbacks++;
                c.fallback = c.fallback ?? r.fallback;
              }
            } else value = r4(leafAt(g, players, hooks.cardKeys, seat, key));
          } catch {
            counters.trialErrors++;
            value = null;
            c.fallback = c.fallback ?? "trial-error";
          }
          counters.trials++;
          hooks.rollback(mark);
          if (g.snapshotManager.currentSnapshotId !== rootSnapshot) throw new Error(`${LEARNED_POLICY_IDS[rung]}: rollback left snapshot ${g.snapshotManager.currentSnapshotId}, expected the root ${rootSnapshot} at decision ${v.k}`);
          c.values.push(value);
        }
      }
    } finally {
      hooks.release(mark);
    }
    for (const c of cands) c.mean = candidateMean(c.values);
    const best = pickScored(cands);
    if (best.index !== order[0]) counters.overrides++;
    const block: SearchBlock = {
      rung,
      mode: rung === 3 ? "none" : "multiset",
      determinizations: D,
      replies: rung === 4 ? params.m : 0,
      candidates: cands.map((c) => ({ descriptor: c.descriptor, rank: c.rank, values: c.values, mean: c.mean, fallback: c.fallback })),
      chosen: best.descriptor,
    };
    return { pick: best.index, block };
  };

  return {
    rung,
    policyId: LEARNED_POLICY_IDS[rung],
    policyVersion: LEARNED_VERSION,
    params,
    inputs: o.inputs,
    evaluatorSha256: o.evaluatorSha256,
    counters,
    covers: () => true,
    choose(actions: readonly TypedAction[], view: unknown, random: () => number): PolicyChoice | null {
      const v = view as View;
      if (builder === null || game !== v.game) {
        game = v.game;
        builder = new ViewBuilder(v.game, v.seat, tables);
        recent.length = 0;
      }
      const { view: gv, answers } = builder.build(actions, random);
      const top = bot.tryChoose(answers, gv);
      if (top === null) return null;
      if (v.promptKind !== "mainAction" || actions.length < 2) {
        builder.record(gv, answers[top]);
        return { index: top };
      }
      const ranked = rankByExclusion(answers, gv, decide, params.k);
      if (ranked[0] !== top) throw new Error(`${LEARNED_POLICY_IDS[rung]}: the pilot's pure order starts at ${ranked[0]}, its choice was ${top}`);
      const cancelled = new Set(answers.flatMap((a, i) => (a.cardId !== null && gv.cancelled.has(a.cardId) ? [i] : [])));
      const order = candidateOrder(ranked, actions.map((a) => a.kind), cancelled, params.noPass === 1);
      if (order.length < 2) {
        builder.record(gv, answers[top]);
        return { index: top };
      }
      const { pick: searched, block } = search(actions, answers, order, v, gv);
      let pick = searched;
      // A sixth identical searched choice in twelve plays the pilot's pick instead, as rung 1's loop guard does.
      const loopKey = `${actions.map((a) => a.descriptor).join(";")}|${pick}`;
      recent.push(loopKey);
      if (recent.length > 12) recent.shift();
      if (pick !== top && recent.filter((x) => x === loopKey).length >= 6) {
        recent.length = 0;
        counters.loopGuard++;
        pick = top;
      }
      builder.record(gv, answers[pick]);
      return { index: pick, search: { ...block, chosen: actions[pick].descriptor } };
    },
  };
}
