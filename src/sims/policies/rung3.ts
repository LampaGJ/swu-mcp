import { seededRandom } from "../../../scripts/bench/stats.js";
import { enumerateActions, promptKindOf } from "../actions.js";
import type { EngineGame, EnginePlayer } from "../engine.js";
import type { SearchHooks } from "../policy.js";
import { decidingSeats } from "../search-leaf.js";
import { ViewBuilder, type TypedAction } from "./engine-view.js";
import { RUNG1_VERSION } from "./index.js";
import { evaluateV, HORIZON, maskState, pickCandidate, rankByExclusion, RUNG3_VERSION, withoutPass, type Candidate, type LookaheadParams, type RawSide, type RawState } from "./lookahead.js";
import { makeRulePolicy, RULE_PILOT_KEYS, RUNG1_PARAMS, type RuleParams } from "./rules.js";
import type { CardTables } from "./tables.js";
import type { BotPolicy, GameView, LegalAnswer } from "./types.js";
import type { DriverPolicy } from "./typed-adapter.js";

/**
 * @displayName Rung 3 one-ply lookahead bot on engine snapshots
 * @strategicPurpose A bot that tries its best few actions on the real rules engine and keeps the one whose result is
 * worth most, so a card's text matters through what the engine does with it, not through a parsed label (#163,
 * docs/research/sim-bot-policy-ladder.md "Rung 3"). Ranking is rung 1's, because rung 2 failed its ladder step (D79).
 * @tacticalObjective At a main-action prompt: rung 1's top K actions by exclusion; for each, bookmark (undo mode),
 * apply it, resolve every following prompt of both seats with fresh rung 1 bots up to the horizon (the next
 * main-action prompt, or the end of the action phase), score the masked state with V, roll back. Pick by
 * `pickCandidate`. Every other prompt is rung 1 on the same view builder, so a K = 1 rung 3 plays rung 1's trace.
 * Trials draw no decision randomness from the match: a rung 1 fallback inside a trial draws from the counter-based
 * stream `trial|seed|seat|k|candidate`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript */
type AnyCard = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const RUNG3_POLICY_ID = "rung3-lookahead";

/** Rung 1 with the lookahead's pilot switches (#174); with none set it is rung 1 exactly. */
const rung1 = (p: LookaheadParams): BotPolicy => {
  const params: RuleParams = { ...RUNG1_PARAMS };
  for (const k of RULE_PILOT_KEYS) if (p[k] === 1) params[k] = 1;
  return makeRulePolicy({ id: "rung1-rules", version: RUNG1_VERSION, rung: 1, params });
};

/** Work counters for one policy instance; the cost harness reads them in-thread. */
export interface LookaheadCounters {
  searches: number;
  trials: number;
  trialDecisions: number;
  trialErrors: number;
  /** Searches whose pick differed from rung 1's. */
  overrides: number;
  cutAtCap: number;
}

const safe = <T>(f: () => T, fallback: T): T => {
  try {
    const v = f();
    return v === undefined || v === null || (typeof v === "number" && Number.isNaN(v)) ? fallback : v;
  } catch {
    return fallback;
  }
};

/**
 * Reads the state V needs. Hidden zones are read as lengths only: the opponent's hand and both decks never have a
 * card identity read here, and maskState drops what remains (our trial draws) before V sees it.
 */
export function readRaw(game: EngineGame, seat: 1 | 2, builder: ViewBuilder): RawState {
  const players = [game.getPlayerById("player1"), game.getPlayerById("player2")] as AnyCard[];
  const me = players[seat - 1];
  const sideOf = (p: AnyCard): RawSide => {
    const units = (safe(() => p.getArenaCards(), []) as AnyCard[]).filter((c) => safe(() => Boolean(c.isUnit()), false)).map((c) => {
      const v = builder.card(c, me);
      return { power: v.power, remainingHp: v.remainingHp, exhausted: v.exhausted, leader: v.leader, cost: v.cost, score: v.score };
    });
    const hidden = (n: number) => Array.from({ length: n }, () => ({ id: "", cardKey: null, cost: 0, score: 0 }));
    const hand =
      p === me
        ? (safe(() => p.hand, []) as AnyCard[]).map((c) => {
            const v = builder.card(c, me);
            return { id: v.id, cardKey: v.cardKey, cost: v.cost, score: v.score };
          })
        : hidden(safe(() => p.hand.length, 0));
    const base = p.base;
    return {
      baseDamage: safe(() => Number(base.damage), 0),
      baseRemaining: safe(() => Number(base.remainingHp), 0),
      units,
      resources: { total: safe(() => p.resources.length, 0), ready: safe(() => Number(p.readyResourceCount), 0) },
      hand,
      deck: hidden(safe(() => p.drawDeck.length, 0)),
      leaderDeployed: safe(() => Boolean(p.getSingleLeader().deployed), false),
      hasInitiative: safe(() => Boolean(p.hasInitiative()), false),
    };
  };
  const names = game.winnerNames;
  const winnerSeat = game.isEnded && names.length === 1 ? (names[0] === "sim1" ? 1 : 2) : null;
  return { seat, ended: game.isEnded, winnerSeat, sides: [sideOf(players[0]), sideOf(players[1])] };
}

/**
 * Plays both seats with fresh rung 1 bots until the horizon: game over, the action phase over, the decision cap, or
 * (horizon reply) the next main-action prompt of either seat. Returns decisions played and whether the cap cut it.
 */
export function runToHorizon(
  game: EngineGame,
  players: readonly [EnginePlayer, EnginePlayer],
  cardKeys: Readonly<Record<string, string>>,
  params: LookaheadParams,
  builders: readonly [ViewBuilder, ViewBuilder],
  bots: readonly [BotPolicy, BotPolicy],
  random: () => number,
): { decisions: number; cut: boolean } {
  let decisions = 0;
  let idle = 0;
  while (decisions < params.maxTrialDecisions) {
    if (game.isEnded || game.currentPhase !== "action") return { decisions, cut: false };
    const seats = decidingSeats(players);
    if (seats.length === 0) {
      game.continue();
      if (++idle > 50) return { decisions, cut: false };
      continue;
    }
    idle = 0;
    const s = seats[0];
    if (params.horizon === HORIZON.reply && promptKindOf(players[s - 1]) === "mainAction") return { decisions, cut: false };
    const acts = enumerateActions(game, players, s, cardKeys);
    // A null amount (schemas.ts) reads like an absent one in engine-view's allocation.
    const { view, answers } = builders[s - 1].build(acts.map((a) => a.action) as unknown as TypedAction[], random);
    const i = bots[s - 1].tryChoose(answers, view) ?? Math.floor(random() * answers.length);
    builders[s - 1].record(view, answers[i]);
    acts[i].run(random);
    game.continue();
    decisions++;
  }
  return { decisions, cut: true };
}

/**
 * A variant's changes to rung 3 (#181): its own id, a candidate order and prune at main-action prompts, and an answer
 * for our own other prompts tried before rung 1, in play and in our seat's trial bot. Without hooks rung 3 is unchanged.
 */
export interface LookaheadHooks {
  policyId: string;
  policyVersion: string;
  /** From rung 1's ranked top k (ranked[0] is rung 1's pick): the indices to try, best first. */
  candidates(answers: readonly LegalAnswer[], view: GameView, ranked: readonly number[]): number[];
  override?(answers: readonly LegalAnswer[], view: GameView): number | null;
}

/** The driver view rung 3 reads: typed-adapter's view plus the session's search hooks. */
interface View {
  seat: 1 | 2;
  k: number;
  promptKind: string;
  game: EngineGame;
  players: readonly EnginePlayer[];
  search?: SearchHooks;
}

export function lookaheadPolicy(tables: CardTables, params: LookaheadParams, inputs: Record<string, string>, variant?: LookaheadHooks): DriverPolicy & { counters: LookaheadCounters } {
  let game: unknown = null;
  let builder: ViewBuilder | null = null;
  const bot = rung1(params);
  const decide = bot.decide;
  if (decide === undefined) throw new Error("rung 1 exposes no pure decide");
  const counters: LookaheadCounters = { searches: 0, trials: 0, trialDecisions: 0, trialErrors: 0, overrides: 0, cutAtCap: 0 };

  const search = (actions: readonly TypedAction[], answers: readonly LegalAnswer[], order: readonly number[], v: View, rootView: Parameters<ViewBuilder["record"]>[0]): number => {
    const hooks = v.search;
    if (hooks === undefined) throw new Error("rung 3 needs the driver's search hooks (a typed-driver session)");
    const g = v.game;
    const players = v.players as unknown as readonly [EnginePlayer, EnginePlayer];
    const me = players[v.seat - 1] as AnyCard;
    const rootHand = new Set((safe(() => me.hand, []) as AnyCard[]).map((c) => String(c.uuid)));
    counters.searches++;
    const mark = hooks.bookmark();
    const cands: Candidate[] = [];
    try {
      for (const [rank, idx] of order.entries()) {
        const fresh = enumerateActions(g, players, v.seat, hooks.cardKeys);
        if (fresh.length !== actions.length || fresh.some((a, i) => a.action.descriptor !== actions[i].descriptor)) throw new Error(`rung 3: legal actions changed across a rollback at decision ${v.k}`);
        const builders = [new ViewBuilder(g, 1, tables), new ViewBuilder(g, 2, tables)] as const;
        const bots: [BotPolicy, BotPolicy] = [rung1(params), rung1(params)];
        const override = variant?.override;
        if (override !== undefined) {
          const mine = bots[v.seat - 1];
          bots[v.seat - 1] = { ...mine, tryChoose: (a, gv) => override(a, gv) ?? mine.tryChoose(a, gv) };
        }
        builders[v.seat - 1].record(rootView, answers[idx]);
        const random = seededRandom(`trial|${hooks.seed}|${v.seat}|${v.k}|${idx}`);
        let value: number | null;
        try {
          fresh[idx].run(random);
          g.continue();
          const r = runToHorizon(g, players, hooks.cardKeys, params, builders, bots, random);
          counters.trialDecisions += r.decisions;
          if (r.cut) counters.cutAtCap++;
          value = evaluateV(maskState(readRaw(g, v.seat, builders[v.seat - 1]), rootHand), params);
        } catch {
          counters.trialErrors++;
          value = null;
        }
        counters.trials++;
        hooks.rollback(mark);
        cands.push({ index: idx, rank, descriptor: actions[idx].descriptor, v: value });
      }
    } finally {
      hooks.release(mark);
    }
    const best = pickCandidate(cands).index;
    if (best !== order[0]) counters.overrides++;
    return best;
  };

  return {
    rung: 3,
    policyId: variant?.policyId ?? RUNG3_POLICY_ID,
    policyVersion: variant?.policyVersion ?? RUNG3_VERSION,
    params,
    inputs,
    counters,
    covers: () => true,
    choose(actions, view, random) {
      const v = view as unknown as View;
      if (builder === null || game !== v.game) {
        game = v.game;
        builder = new ViewBuilder(v.game, v.seat, tables);
      }
      const { view: gv, answers } = builder.build(actions, random);
      if (variant?.override !== undefined && v.promptKind !== "mainAction") {
        const o = variant.override(answers, gv);
        if (o !== null) {
          builder.record(gv, answers[o]);
          return { index: o };
        }
      }
      const top = bot.tryChoose(answers, gv);
      if (top === null) return null;
      let pick = top;
      if (v.promptKind === "mainAction" && params.k > 1) {
        const ranked = rankByExclusion(answers, gv, decide, params.k);
        const order = params.noPass === 1 ? withoutPass(ranked, answers) : ranked;
        if (order[0] !== top) throw new Error(`rung 3: rung 1's pure order starts at ${order[0]}, its choice was ${top}`);
        if (variant !== undefined) {
          const tried = variant.candidates(answers, gv, order);
          pick = tried.length > 1 ? search(actions, answers, tried, v, gv) : (tried[0] ?? top);
        } else if (order.length > 1) pick = search(actions, answers, order, v, gv);
      }
      builder.record(gv, answers[pick]);
      return { index: pick };
    },
  };
}
