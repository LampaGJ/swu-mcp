import { compareCodePoints } from "../../swu/canonical.js";
import type { GameView, LegalAnswer } from "./types.js";

/**
 * @displayName Rung 3 state value, hidden-information mask and candidate order
 * @strategicPurpose The deterministic half of the rung 3 lookahead bot (#163, docs/research/sim-bot-policy-ladder.md
 * "Rung 3"): which actions it tries, how it scores the state a trial reaches, and what that score may read. Kept free
 * of the engine so each rule has a fixture test.
 * @tacticalObjective `rankByExclusion` orders rung 1's choices (its pick, then its pick with that answer removed, up to
 * K); `maskState` turns an engine read into the public state plus our own hand, the opponent's hand and both decks as
 * counts and any card drawn during the trial as a count; `evaluateV` is the ladder doc's V with lethal at plus or minus
 * infinity; `pickCandidate` takes the highest V, ties by rung 1 order, then descriptor.
 */

export const RUNG3_VERSION = "1";

/** Horizon codes, numeric so the params hash stays a number map: 0 stops at the next main-action prompt, 1 rolls out to the end of the action phase. */
export const HORIZON = { reply: 0, round: 1 } as const;

export interface LookaheadParams {
  /** Candidates tried per main-action prompt. */
  k: number;
  horizon: (typeof HORIZON)[keyof typeof HORIZON];
  wBase: number;
  wBoard: number;
  wHand: number;
  wResources: number;
  wReady: number;
  /** Weight on the play-calibrated score of units in play (0 in the ladder doc's V). */
  wScore: number;
  /** Trial decisions before a rollout is cut and scored where it stands. */
  maxTrialDecisions: number;
  /** Version of V and the mask, in the params hash so every record names it. */
  vVersion: number;
  /** Rung 1's pilot switches (rules.ts RuleParams) for the ranking, the rollouts and every other prompt; absent is 0. */
  sacGuard?: number;
  initDraw?: number;
  handCap?: number;
  aspectCall?: number;
  /** 1: Pass is a candidate only when rung 1 itself passes (a rollout after Pass plays the card a real Pass never plays, #174). */
  noPass?: number;
}

export const LOOKAHEAD_PILOT_KEYS = ["noPass"] as const;

const IS_PASS_ANSWER = (a: LegalAnswer): boolean => a.kind === "button" && /^pass\b/i.test(a.label);

/** Rung 1's order without its Pass answers, unless rung 1's own pick is Pass. */
export function withoutPass(order: readonly number[], answers: readonly LegalAnswer[]): number[] {
  if (order.length === 0 || IS_PASS_ANSWER(answers[order[0]])) return [...order];
  return order.filter((i) => !IS_PASS_ANSWER(answers[i]));
}

export const RUNG3_PARAMS: LookaheadParams = { k: 3, horizon: HORIZON.round, wBase: 1.5, wBoard: 1, wHand: 1, wResources: 1, wReady: 1, wScore: 0, maxTrialDecisions: 400, vVersion: 1 };

export interface RawUnit {
  power: number;
  remainingHp: number;
  exhausted: boolean;
  leader: boolean;
  cost: number;
  score: number;
}

export interface RawCard {
  /** Engine object id, stable across a rollback; used only to tell root hand cards from trial draws. */
  id: string;
  cardKey: string | null;
  cost: number;
  score: number;
}

/** One side as the engine holds it, hidden zones included. */
export interface RawSide {
  baseDamage: number;
  baseRemaining: number;
  units: RawUnit[];
  resources: { total: number; ready: number };
  hand: RawCard[];
  deck: RawCard[];
  leaderDeployed: boolean;
  hasInitiative: boolean;
}

export interface RawState {
  /** The seat V is computed for. */
  seat: 1 | 2;
  ended: boolean;
  winnerSeat: 1 | 2 | null;
  sides: [RawSide, RawSide];
}

export interface PublicSide {
  baseDamage: number;
  baseRemaining: number;
  units: RawUnit[];
  resources: { total: number; ready: number };
  handSize: number;
  deckSize: number;
  leaderDeployed: boolean;
  hasInitiative: boolean;
}

export interface PublicState {
  outcome: "won" | "lost" | "draw" | null;
  me: PublicSide & {
    /** Our hand cards that were in hand when the decision began, in id order. */
    knownHand: { cardKey: string | null; cost: number; score: number }[];
    /** Cards in our hand now that were not there at the root: counted, never identified. */
    drawnInTrial: number;
  };
  opp: PublicSide;
}

const publicSide = (s: RawSide): PublicSide => ({
  baseDamage: s.baseDamage,
  baseRemaining: s.baseRemaining,
  units: s.units.map((u) => ({ ...u })),
  resources: { ...s.resources },
  handSize: s.hand.length,
  deckSize: s.deck.length,
  leaderDeployed: s.leaderDeployed,
  hasInitiative: s.hasInitiative,
});

/** The only path from an engine read to V: the opponent's hand and both decks become counts, trial draws a count. */
export function maskState(raw: RawState, rootHand: ReadonlySet<string>): PublicState {
  const me = raw.sides[raw.seat - 1];
  const opp = raw.sides[2 - raw.seat];
  const known = me.hand.filter((c) => rootHand.has(c.id)).sort((a, b) => compareCodePoints(a.id, b.id));
  const outcome = !raw.ended ? null : raw.winnerSeat === null ? "draw" : raw.winnerSeat === raw.seat ? "won" : "lost";
  return {
    outcome,
    me: { ...publicSide(me), knownHand: known.map((c) => ({ cardKey: c.cardKey, cost: c.cost, score: c.score })), drawnInTrial: me.hand.length - known.length },
    opp: publicSide(opp),
  };
}

type Weights = Pick<LookaheadParams, "wBase" | "wBoard" | "wHand" | "wResources" | "wReady" | "wScore">;

const board = (s: PublicSide): number => s.units.reduce((sum, u) => sum + u.power + u.remainingHp, 0);
const ready = (s: PublicSide): number => s.units.filter((u) => !u.exhausted).length;
const unitScore = (s: PublicSide): number => s.units.reduce((sum, u) => sum + u.score, 0);

/** V for the actor: `wBase (opp base damage - own) + wBoard (own power + HP - opp) + wHand (hand sizes) + wResources (resources) + wReady (ready units) + wScore (unit scores)`. */
export function evaluateV(s: PublicState, w: Weights): number {
  if (s.outcome === "won") return Infinity;
  if (s.outcome === "lost") return -Infinity;
  if (s.outcome === "draw") return 0;
  const { me, opp } = s;
  return (
    w.wBase * (opp.baseDamage - me.baseDamage) +
    w.wBoard * (board(me) - board(opp)) +
    w.wHand * (me.handSize - opp.handSize) +
    w.wResources * (me.resources.total - opp.resources.total) +
    w.wReady * (ready(me) - ready(opp)) +
    (w.wScore === 0 ? 0 : w.wScore * (unitScore(me) - unitScore(opp)))
  );
}

/**
 * Rung 1's order over the answers: its pick, then its pick among the answers left, up to k. `decide` must be pure
 * (rung 1's `decide`, not `tryChoose`, which counts and runs the loop guard).
 */
export function rankByExclusion(answers: readonly LegalAnswer[], view: GameView, decide: (answers: readonly LegalAnswer[], view: GameView) => number | null, k: number): number[] {
  const out: number[] = [];
  const left = answers.map((_, i) => i);
  while (out.length < k && left.length > 0) {
    const pick = decide(
      left.map((i) => answers[i]),
      view,
    );
    if (pick === null || pick < 0 || pick >= left.length) break;
    out.push(left[pick]);
    left.splice(pick, 1);
  }
  return out;
}

export interface Candidate {
  index: number;
  /** Position in rung 1's order, 0 = rung 1's own pick. */
  rank: number;
  descriptor: string;
  /** Null when the trial failed (engine error); such a candidate is never picked while another scored. */
  v: number | null;
}

/** Highest V; ties by rung 1 order, then descriptor. Every trial failed: rung 1's pick. */
export function pickCandidate(cands: readonly Candidate[]): Candidate {
  const scored = cands.filter((c) => c.v !== null);
  const pool = scored.length > 0 ? scored : cands;
  let best = pool[0];
  for (const c of pool.slice(1)) {
    const cv = c.v ?? 0;
    const bv = best.v ?? 0;
    const better = cv > bv || (cv === bv && (c.rank < best.rank || (c.rank === best.rank && compareCodePoints(c.descriptor, best.descriptor) < 0)));
    if (better) best = c;
  }
  return best;
}

// ---- flat Monte Carlo variant (owner redirect, #163) ---------------------------------------------

export const MC_VERSION = "1";

/** Playout lengths: 0 plays to the end of the game and scores the win, 1 to the end of the action phase and scores V. */
export const MC_LENGTH = { game: 0, round: 1 } as const;
/** Playout policies on both seats: 0 is rung 0 (uniform over canonical actions), 1 is rung 1. */
export const MC_PLAYOUT = { rung0: 0, rung1: 1 } as const;

export interface MonteCarloParams extends Pick<LookaheadParams, "wBase" | "wBoard" | "wHand" | "wResources" | "wReady" | "wScore" | "vVersion"> {
  /** Playouts per candidate. */
  n: number;
  length: (typeof MC_LENGTH)[keyof typeof MC_LENGTH];
  playout: (typeof MC_PLAYOUT)[keyof typeof MC_PLAYOUT];
  /** Most candidates per decision (main actions plus expanded sub-prompt answers); each firing is counted. */
  cap: number;
  /** A sub-prompt of ours right after a candidate is branched when it has at most this many answers (0: never). */
  sub: number;
  /** Sub-prompt levels branched below a main action. */
  depth: number;
  /** Playout decisions before a playout is cut (scored 0.5, or by V at the cut). */
  maxPlayoutDecisions: number;
  /**
   * 1: each playout index p is a sampled world (both decks shuffled, the opponent's hand redealt from their unseen
   * cards), shared by every candidate; 0: playouts run on the true hidden state (clairvoyant, kept to measure the leak).
   */
  determinize: number;
}

export const MC_PARAMS: MonteCarloParams = {
  n: 4,
  length: MC_LENGTH.round,
  playout: MC_PLAYOUT.rung0,
  cap: 40,
  sub: 6,
  depth: 2,
  maxPlayoutDecisions: 800,
  determinize: 1,
  wBase: RUNG3_PARAMS.wBase,
  wBoard: RUNG3_PARAMS.wBoard,
  wHand: RUNG3_PARAMS.wHand,
  wResources: RUNG3_PARAMS.wResources,
  wReady: RUNG3_PARAMS.wReady,
  wScore: RUNG3_PARAMS.wScore,
  vVersion: RUNG3_PARAMS.vVersion,
};

const V_CLAMP = 1000;

/** One playout's score: to game end a win share (a draw or a cut playout 0.5); to round end V, a win or loss at the clamp. */
export function playoutScore(length: MonteCarloParams["length"], outcome: PublicState["outcome"], v: number | null): number {
  if (length === MC_LENGTH.game) return outcome === "won" ? 1 : outcome === "lost" ? 0 : 0.5;
  if (outcome === "won") return V_CLAMP;
  if (outcome === "lost") return -V_CLAMP;
  if (outcome === "draw") return 0;
  return Math.max(-V_CLAMP, Math.min(V_CLAMP, v ?? 0));
}

/** The playout stream's name: seed, seat, decision index, candidate index, playout index (sha256-to-mulberry32 like the bot draws). */
export const mcStreamKey = (seed: string, seat: 1 | 2, k: number, candidate: number, playout: number): string => `mc|${seed}|${seat}|${k}|${candidate}|${playout}`;

/** World p of decision k: the engine reseed that shuffles the hidden zones, the same for every candidate (common random numbers). */
export const mcWorldKey = (seed: string, seat: 1 | 2, k: number, world: number): string => `mc-world|${seed}|${seat}|${k}|${world}`;

const comparePaths = (a: readonly string[], b: readonly string[]): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = compareCodePoints(a[i], b[i]);
    if (d !== 0) return d;
  }
  return a.length - b.length;
};

/** Highest mean score; ties by the path's descriptors in code-point order. */
export function pickBestPath<T extends { path: readonly string[]; score: number }>(cands: readonly T[]): T {
  let best = cands[0];
  for (const c of cands.slice(1)) if (c.score > best.score || (c.score === best.score && comparePaths(c.path, best.path) < 0)) best = c;
  return best;
}
