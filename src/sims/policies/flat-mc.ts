import { seededRandom } from "../../../scripts/bench/stats.js";
import { enumerateActions, promptKindOf } from "../actions.js";
import type { EngineGame, EnginePlayer } from "../engine.js";
import type { SearchHooks } from "../policy.js";
import { decidingSeats } from "../search-leaf.js";
import { ViewBuilder, type TypedAction } from "./engine-view.js";
import { RUNG1_VERSION } from "./index.js";
import { evaluateV, maskState, MC_LENGTH, MC_PLAYOUT, MC_VERSION, mcStreamKey, mcWorldKey, pickBestPath, playoutScore, type MonteCarloParams } from "./lookahead.js";
import { makeRulePolicy, RUNG1_PARAMS } from "./rules.js";
import { readRaw } from "./rung3.js";
import type { CardTables } from "./tables.js";
import type { BotPolicy } from "./types.js";
import type { DriverPolicy } from "./typed-adapter.js";

/**
 * @displayName Rung 3 flat Monte Carlo on engine snapshots
 * @strategicPurpose The owner's "just do all possible moves for each game state" in its tractable form (#163): no bot
 * judgement picks the candidates; every legal main action is tried on the real engine and the one whose seeded
 * playouts score best is played, so what a card does is measured by the engine, not by rules about it.
 * @tacticalObjective At a main-action prompt: every canonical legal action (capped, cap firings counted), a sub-prompt
 * of ours inside a candidate's own action branched too when it has few answers (path candidates), each candidate played out
 * N times on both seats by rung 0 (or rung 1) from a bookmark, to the end of the game (win share) or of the action
 * phase (V on the masked state); the best mean wins, ties by descriptor path. The chosen path's remaining answers are
 * replayed at the sub-prompts that follow; every other prompt is rung 1. Playout randomness is the counter stream
 * mcStreamKey(seed, seat, k, candidate, playout). With determinize on (the default) playout p runs in sampled world p
 * (determinize below), shared by every candidate, so no playout draws the real next card or plays the opponent's real
 * hand; the round-length score reads the masked state.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript */
type AnyCard = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export const MC_POLICY_ID = "rung3-flat-mc";

const rung1 = (): BotPolicy => makeRulePolicy({ id: "rung1-rules", version: RUNG1_VERSION, rung: 1, params: RUNG1_PARAMS });

export interface MonteCarloCounters {
  searches: number;
  candidates: number;
  /** Searches where the cap cut the candidate list. */
  capFired: number;
  /** Candidates dropped because they returned to our own main action with nothing done (a cancelled click). */
  noOps: number;
  playouts: number;
  playoutDecisions: number;
  playoutsCut: number;
  playoutErrors: number;
  /** Sub-prompt answers played from a search's plan. */
  planned: number;
  loopGuard: number;
}

interface View {
  seat: 1 | 2;
  k: number;
  promptKind: string;
  multi: boolean;
  game: EngineGame;
  players: readonly EnginePlayer[];
  search?: SearchHooks;
}

/**
 * Replaces what the searching seat cannot know with a sample, the way the engine's own mulligan redeals: reseed the
 * engine RNG with the world key, put the opponent's hand on the bottom of their deck, shuffle both decks, and draw the
 * opponent back up to the same hand size. Our hand and everything public stay. The rollback restores the real state.
 */
export function determinize(game: EngineGame, players: readonly [EnginePlayer, EnginePlayer], seat: 1 | 2, key: string): void {
  (game.randomGenerator as unknown as { reseed(seed: string): void }).reseed(key);
  const me = players[seat - 1] as AnyCard;
  const opp = players[2 - seat] as AnyCard;
  const hand = [...(opp.hand as AnyCard[])];
  for (const c of hand) c.moveTo("deckBottom");
  opp.shuffleDeck();
  me.shuffleDeck();
  opp.drawCardsToHand(hand.length);
}

/** Continues the engine until some seat must decide or the game ends; false when it idles out. */
function settle(game: EngineGame, players: readonly [EnginePlayer, EnginePlayer]): boolean {
  for (let idle = 0; idle <= 50; idle++) {
    if (game.isEnded || decidingSeats(players).length > 0) return true;
    game.continue();
  }
  return false;
}

export function flatMonteCarloPolicy(tables: CardTables, params: MonteCarloParams, inputs: Record<string, string>): DriverPolicy & { counters: MonteCarloCounters } {
  let game: unknown = null;
  let builder: ViewBuilder | null = null;
  const bot = rung1();
  const counters: MonteCarloCounters = { searches: 0, candidates: 0, capFired: 0, noOps: 0, playouts: 0, playoutDecisions: 0, playoutsCut: 0, playoutErrors: 0, planned: 0, loopGuard: 0 };
  let plan: string[] = [];
  const recent: string[] = [];

  const applyPath = (g: EngineGame, players: readonly [EnginePlayer, EnginePlayer], seat: 1 | 2, keys: Readonly<Record<string, string>>, path: readonly string[], rnd: () => number): void => {
    for (const d of path) {
      if (!settle(g, players)) throw new Error("engine idled while applying a search path");
      const acts = enumerateActions(g, players, seat, keys);
      const a = acts.find((x) => x.action.descriptor === d);
      if (a === undefined) throw new Error(`search path step ${d} is not legal`);
      a.run(rnd);
      g.continue();
    }
  };

  /** Plays both seats to the playout's end; returns the decisions played and whether the cap cut it. */
  const playout = (g: EngineGame, players: readonly [EnginePlayer, EnginePlayer], keys: Readonly<Record<string, string>>, rnd: () => number): { decisions: number; cut: boolean } => {
    const builders = params.playout === MC_PLAYOUT.rung1 ? ([new ViewBuilder(g, 1, tables), new ViewBuilder(g, 2, tables)] as const) : null;
    const bots = params.playout === MC_PLAYOUT.rung1 ? ([rung1(), rung1()] as const) : null;
    let decisions = 0;
    let idle = 0;
    while (decisions < params.maxPlayoutDecisions) {
      if (g.isEnded) return { decisions, cut: false };
      if (params.length === MC_LENGTH.round && g.currentPhase !== "action") return { decisions, cut: false };
      const seats = decidingSeats(players);
      if (seats.length === 0) {
        g.continue();
        if (++idle > 50) return { decisions, cut: true };
        continue;
      }
      idle = 0;
      const s = seats[0];
      const acts = enumerateActions(g, players, s, keys);
      let i: number;
      if (builders !== null && bots !== null) {
        const { view, answers } = builders[s - 1].build(acts.map((a) => a.action) as unknown as TypedAction[], rnd);
        i = bots[s - 1].tryChoose(answers, view) ?? Math.floor(rnd() * answers.length);
        builders[s - 1].record(view, answers[i]);
      } else {
        const done = acts.findIndex((a) => a.action.kind === "done");
        const multi = (players[s - 1] as AnyCard).promptState.selectCardMode === "multiple";
        i = multi && done >= 0 && rnd() < 0.5 ? done : Math.floor(rnd() * acts.length);
      }
      acts[i].run(rnd);
      g.continue();
      decisions++;
    }
    return { decisions, cut: true };
  };

  const search = (actions: readonly TypedAction[], cancelled: ReadonlySet<number>, v: View): string[] => {
    const hooks = v.search;
    if (hooks === undefined) throw new Error("rung3mc needs the driver's search hooks (a typed-driver session)");
    const g = v.game;
    const players = v.players as unknown as readonly [EnginePlayer, EnginePlayer];
    const keys = hooks.cardKeys;
    const rootSnapshot = g.snapshotManager.currentSnapshotId;
    const rootHand = new Set((((players[v.seat - 1] as AnyCard).hand ?? []) as AnyCard[]).map((c) => String(c.uuid)));
    counters.searches++;
    const roots = actions.map((a, i) => ({ a, i })).filter(({ i }) => !cancelled.has(i));
    let capped = false;
    const noRandom = (): number => 0;
    const mark = hooks.bookmark();
    try {
      // Candidate paths: each root, and below it our own sub-prompts with few answers, depth-first, within the cap.
      const leaves: string[][] = [];
      /** Playout 0's score of a leaf, played straight from its expansion step instead of after another rollback. */
      const first = new Map<number, number>();
      const room = (): number => params.cap - leaves.length;
      const world = (p: number): void => {
        if (params.determinize === 1) determinize(g, players, v.seat, mcWorldKey(hooks.seed, v.seat, v.k, p));
      };
      const runPlayout = (path: readonly string[], ci: number, p: number, applied: boolean): number => {
        const rnd = seededRandom(mcStreamKey(hooks.seed, v.seat, v.k, ci, p));
        let score: number;
        try {
          if (!applied) {
            world(p);
            applyPath(g, players, v.seat, keys, path, rnd);
          }
          const r = playout(g, players, keys, rnd);
          counters.playoutDecisions += r.decisions;
          if (r.cut) counters.playoutsCut++;
          const state = maskState(readRaw(g, v.seat, new ViewBuilder(g, v.seat, tables)), rootHand);
          score = playoutScore(params.length, state.outcome, params.length === MC_LENGTH.round || r.cut ? evaluateV(state, params) : null);
        } catch {
          counters.playoutErrors++;
          score = params.length === MC_LENGTH.game ? 0.5 : 0;
        }
        counters.playouts++;
        hooks.rollback(mark);
        return score;
      };
      const expand = (path: string[], depth: number, pending: number): void => {
        if (depth >= params.depth || params.sub === 0) {
          leaves.push(path);
          return;
        }
        let children: string[] = [];
        try {
          world(0);
          applyPath(g, players, v.seat, keys, path, noRandom);
          const ok = settle(g, players);
          const seats = ok && !g.isEnded ? decidingSeats(players) : [];
          // Only sub-prompts inside the candidate's own action (still the root timepoint): later prompts (a regroup
          // resource choice after a phase-ending pass) depend on hidden draws that differ between sampled worlds.
          const sameAction = g.snapshotManager.currentSnapshotId === rootSnapshot;
          if (seats.length > 0 && seats[0] === v.seat && sameAction && promptKindOf(players[v.seat - 1]) !== "mainAction") {
            const acts = enumerateActions(g, players, v.seat, keys);
            if (acts.length > 1 && acts.length <= params.sub && room() - pending >= acts.length) children = acts.map((x) => x.action.descriptor);
          } else if (seats.length > 0 && seats[0] === v.seat && sameAction) {
            counters.noOps++;
            hooks.rollback(mark);
            return;
          }
        } catch {
          // An engine fault while expanding: the path stays a candidate, and its playouts count their own errors.
          counters.playoutErrors++;
          hooks.rollback(mark);
          leaves.push(path);
          return;
        }
        if (children.length === 0) {
          first.set(leaves.length, runPlayout(path, leaves.length, 0, true));
          leaves.push(path);
          return;
        }
        hooks.rollback(mark);
        children.forEach((c, j) => expand([...path, c], depth + 1, pending + children.length - 1 - j));
      };
      for (const [j, { a }] of roots.entries()) {
        if (room() <= 0) {
          capped = true;
          break;
        }
        expand([a.descriptor], 0, roots.length - 1 - j);
      }
      if (capped) counters.capFired++;
      if (leaves.length === 0) return [];
      counters.candidates += leaves.length;
      const scored = leaves.map((path, ci) => {
        let sum = 0;
        for (let p = 0; p < params.n; p++) sum += p === 0 && first.has(ci) ? (first.get(ci) as number) : runPlayout(path, ci, p, false);
        return { path, score: sum / params.n };
      });
      return pickBestPath(scored).path;
    } finally {
      hooks.release(mark);
    }
  };

  return {
    rung: 3,
    policyId: MC_POLICY_ID,
    policyVersion: MC_VERSION,
    params,
    inputs,
    counters,
    covers: () => true,
    choose(actions, view, random) {
      const v = view as unknown as View;
      if (builder === null || game !== v.game) {
        game = v.game;
        builder = new ViewBuilder(v.game, v.seat, tables);
        plan = [];
      }
      const { view: gv, answers } = builder.build(actions, random);
      if (v.promptKind === "mainAction") {
        plan = [];
        if (actions.length > 1) {
          const cancelled = new Set(answers.flatMap((a, i) => (a.cardId !== null && gv.cancelled.has(a.cardId) ? [i] : [])));
          const path = search(actions, cancelled, v);
          const index = path.length === 0 ? -1 : actions.findIndex((a) => a.descriptor === path[0]);
          if (index >= 0) {
            // A sixth identical main-action choice in twelve hands the decision to rung 0, as rung 1's loop guard does.
            const key = `${actions.map((a) => a.descriptor).join(";")}|${index}`;
            recent.push(key);
            if (recent.length > 12) recent.shift();
            if (recent.filter((x) => x === key).length >= 6) {
              recent.length = 0;
              counters.loopGuard++;
              return null;
            }
            plan = path.slice(1);
            builder.record(gv, answers[index]);
            return { index };
          }
        }
      } else if (plan.length > 0) {
        const next = plan.shift() as string;
        const index = actions.findIndex((a) => a.descriptor === next);
        if (index >= 0) {
          counters.planned++;
          builder.record(gv, answers[index]);
          return { index };
        }
        plan = [];
      }
      const i = bot.tryChoose(answers, gv);
      if (i === null) return null;
      builder.record(gv, answers[i]);
      return { index: i };
    },
  };
}
