import { wilson } from "../../meta/stats.js";

/**
 * @displayName Ladder statistics
 * @strategicPurpose Decides whether bot rung n beats rung n-1 from seat-swapped duplicate game pairs, with the test
 * fixed in advance (#114), so a rung is promoted on evidence and not on a lucky batch.
 * @tacticalObjective Exact two-sided sign test on discordant pairs, Wilson intervals on game shares (src/meta/stats.ts),
 * per-deck shares, the pass rule (pooled test at alpha, above 50% in at least five of six decks, no deck interval wholly
 * below 50%), and the games budget ceil(93 / (1 - d)).
 */

/** Bonferroni split of 0.05 over up to five ladder steps. */
export const LADDER_ALPHA = 0.01;

/** Exact two-sided binomial sign test at p = 0.5: k successes of n. */
export function signTest(k: number, n: number): number {
  if (n === 0) return 1;
  const logC: number[] = [0];
  for (let i = 1; i <= n; i++) logC.push(logC[i - 1] + Math.log(n - i + 1) - Math.log(i));
  const lo = Math.min(k, n - k);
  let tail = 0;
  for (let i = 0; i <= lo; i++) tail += Math.exp(logC[i] + n * Math.log(0.5));
  return Math.min(1, 2 * tail);
}

export interface PairGame {
  /** 1 or 2, null when not decisive. */
  winner: 1 | 2 | null;
  endCondition: string;
}

/** One duplicate pair: the candidate in seat 1 of `a` and seat 2 of `b`, same engine seed, decks fixed in their seats. */
export interface LadderPair {
  seed: number;
  deck1: string;
  deck2: string;
  a: PairGame;
  b: PairGame;
}

export interface Share {
  wins: number;
  n: number;
  share: number | null;
  low: number | null;
  high: number | null;
}

export const shareOf = (wins: number, n: number): Share => {
  const w = wilson(wins, n);
  return { wins, n, share: n === 0 ? null : Math.round((wins / n) * 1e4) / 1e4, low: w?.low ?? null, high: w?.high ?? null };
};

export interface LadderSummary {
  pairs: number;
  games: number;
  nonDecisive: number;
  nonDecisiveShare: number;
  /** ceil(93 / (1 - d)): games for a +-10-point interval at the measured non-decisive share. */
  budgetGames: number;
  pooled: Share;
  discordant: { candidate2to0: number; baseline2to0: number; pValue: number };
  perDeck: Record<string, Share>;
  pass: boolean;
  passDetail: { signTest: boolean; decksAbove: number; decksWhollyBelow: number };
}

export function summarizeLadder(pairs: readonly LadderPair[], decks: readonly string[], alpha = LADDER_ALPHA): LadderSummary {
  let wins = 0;
  let decisive = 0;
  let nonDecisive = 0;
  let c20 = 0;
  let b20 = 0;
  const deckWins = new Map(decks.map((d) => [d, { wins: 0, n: 0 }]));
  const note = (deck: string, won: boolean): void => {
    const e = deckWins.get(deck) ?? { wins: 0, n: 0 };
    e.n++;
    if (won) e.wins++;
    deckWins.set(deck, e);
  };
  for (const p of pairs) {
    const aWon = p.a.winner === null ? null : p.a.winner === 1;
    const bWon = p.b.winner === null ? null : p.b.winner === 2;
    for (const [won, deck] of [
      [aWon, p.deck1],
      [bWon, p.deck2],
    ] as const) {
      if (won === null) nonDecisive++;
      else {
        decisive++;
        if (won) wins++;
        note(deck, won);
      }
    }
    if (aWon === true && bWon === true) c20++;
    if (aWon === false && bWon === false) b20++;
  }
  const games = pairs.length * 2;
  const d = games === 0 ? 0 : nonDecisive / games;
  const pValue = signTest(c20, c20 + b20);
  const perDeck = Object.fromEntries([...deckWins].map(([k, v]) => [k, shareOf(v.wins, v.n)]));
  const decksAbove = Object.values(perDeck).filter((s) => s.share !== null && s.share > 0.5).length;
  const decksWhollyBelow = Object.values(perDeck).filter((s) => s.high !== null && s.high < 0.5).length;
  const signPass = pValue < alpha && c20 > b20;
  const need = Math.max(0, decks.length - 1);
  return {
    pairs: pairs.length,
    games,
    nonDecisive,
    nonDecisiveShare: Math.round(d * 1e4) / 1e4,
    budgetGames: Math.ceil(93 / (1 - Math.min(d, 0.99))),
    pooled: shareOf(wins, decisive),
    discordant: { candidate2to0: c20, baseline2to0: b20, pValue: Number(pValue.toPrecision(4)) },
    perDeck,
    pass: signPass && decksAbove >= need && decksWhollyBelow === 0,
    passDetail: { signTest: signPass, decksAbove, decksWhollyBelow },
  };
}

/** Paired comparison of two decks played on the same seeds: per seed, did each win? Sign test on the seeds where they differ. */
export function pairedDeckTest(base: readonly (boolean | null)[], variant: readonly (boolean | null)[]): { baseOnly: number; variantOnly: number; pValue: number } {
  let baseOnly = 0;
  let variantOnly = 0;
  for (let i = 0; i < Math.min(base.length, variant.length); i++) {
    if (base[i] === null || variant[i] === null) continue;
    if (base[i] && !variant[i]) baseOnly++;
    if (!base[i] && variant[i]) variantOnly++;
  }
  return { baseOnly, variantOnly, pValue: Number(signTest(variantOnly, baseOnly + variantOnly).toPrecision(4)) };
}
