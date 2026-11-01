import { compareCodePoints } from "../swu/canonical.js";
import type { IndexDeck } from "./deck-index.js";

/**
 * @displayName Deck remix neighbours
 * @strategicPurpose The nearest-neighbour view behind deck_remixer (LampaGJ/swu-mcp#193): the decks that share most of a
 * given list's cards, so a suggestion comes from players who built something close to it rather than from the leader's average.
 * @tacticalObjective Weighted Jaccard over card copies, neighbours drawn from the same leader and base first, then the same
 * leader, then the same aspects, with every widening stated; and, per card the given deck lacks, the share of neighbours that
 * run it with their match record with and without it. Pure, one tier at a time, no clock and no randomness.
 */

export const MAX_COPIES = 3;

export type Level = "leader+base" | "leader" | "aspects";
const LEVELS: readonly Level[] = ["leader+base", "leader", "aspects"];
const LEVEL_TEXT: Record<Level, string> = {
  "leader+base": "the same leader and base",
  leader: "the same leader (other bases)",
  aspects: "the same aspects (other leaders)",
};

export interface Target {
  leader: string;
  base: string | null;
  /** Sorted icons joined by "+", as the index writes them. */
  aspects: string;
  cards: ReadonlyMap<string, number>;
}

export interface Neighbour {
  deck: IndexDeck;
  similarity: number;
  level: Level;
}

export interface NeighbourSet {
  requested: number;
  minSimilarity: number;
  neighbours: Neighbour[];
  /** Decks with exactly the target's card copies; they teach nothing the list lacks, so they are not neighbours. */
  identical: number;
  /** Usable decks (at or above the similarity floor) per level, before the k cut. */
  available: Record<Level, number>;
  /** The deepest level a neighbour came from; null when there are none. */
  reach: Level | null;
  widening: string[];
}

/** Sum of the smaller copy counts over the sum of the larger ones; 0 when both lists are empty. */
export function weightedJaccard(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let low = 0;
  let high = 0;
  for (const [key, x] of a) {
    const y = b.get(key) ?? 0;
    low += Math.min(x, y);
    high += Math.max(x, y);
  }
  for (const [key, y] of b) if (!a.has(key)) high += y;
  return high === 0 ? 0 : low / high;
}

function levelOf(deck: IndexDeck, target: Target): Level | null {
  if (deck.leader === target.leader) return target.base !== null && deck.base === target.base ? "leader+base" : "leader";
  return deck.aspects === target.aspects ? "aspects" : null;
}

const nearestFirst = (a: Neighbour, b: Neighbour): number =>
  b.similarity - a.similarity || compareCodePoints(b.deck.date, a.deck.date) || a.deck.index - b.deck.index;

/** The k decks nearest the target: its own leader and base first, widening only when that leaves fewer than k. */
export function nearestDecks(decks: readonly IndexDeck[], target: Target, k: number, minSimilarity: number): NeighbourSet {
  const byLevel: Record<Level, Neighbour[]> = { "leader+base": [], leader: [], aspects: [] };
  let sharing = 0;
  let identical = 0;
  for (const deck of decks) {
    const level = levelOf(deck, target);
    if (level === null) continue;
    sharing += 1;
    const similarity = weightedJaccard(target.cards, deck.cards);
    if (similarity === 1) {
      identical += 1;
      continue;
    }
    if (similarity >= minSimilarity) byLevel[level].push({ deck, similarity, level });
  }
  const available = Object.fromEntries(LEVELS.map((l) => [l, byLevel[l].length])) as Record<Level, number>;
  const neighbours: Neighbour[] = [];
  const widening: string[] = [];
  for (const level of LEVELS) {
    if (neighbours.length >= k) break;
    const taken = byLevel[level].sort(nearestFirst).slice(0, k - neighbours.length);
    if (taken.length > 0 && level !== "leader+base") {
      const soFar = neighbours.length;
      widening.push(
        `widened to ${LEVEL_TEXT[level]}: added ${taken.length} deck${taken.length === 1 ? "" : "s"} because ${soFar === 0 ? "no nearer deck was available" : `only ${soFar} nearer deck${soFar === 1 ? " was" : "s were"} available`}, ${k} asked for`,
      );
    }
    neighbours.push(...taken);
  }
  if (neighbours.length === 0) {
    widening.push(
      sharing === 0
        ? `no deck in this tier runs ${target.base === null ? "this leader" : "this leader and base"}, this leader or the aspects ${target.aspects || "none"}`
        : `${sharing} deck${sharing === 1 ? "" : "s"} share the leader, base or aspects but none is within the similarity floor of ${minSimilarity}`,
    );
  }
  neighbours.sort(nearestFirst);
  const reach = neighbours.reduce<Level | null>(
    (deepest, n) => (deepest === null || LEVELS.indexOf(n.level) > LEVELS.indexOf(deepest) ? n.level : deepest),
    null,
  );
  return { requested: k, minSimilarity, neighbours, identical, available, reach, widening };
}

export interface RecordTally {
  decks: number;
  wins: number;
  losses: number;
}

export interface PopularRow {
  cardKey: string;
  decksWith: number;
  of: number;
  /** Similarity-weighted share of the neighbours that run the card. */
  share: number;
  /** Copies the neighbours run, the mean over those that run it, rounded, 1 to 3. */
  copies: number;
  withRecord: RecordTally;
  withoutRecord: RecordTally;
}

const tally = (decks: readonly Neighbour[]): RecordTally =>
  decks.reduce<RecordTally>(
    (t, { deck }) =>
      deck.record === null ? t : { decks: t.decks + 1, wins: t.wins + deck.record.wins, losses: t.losses + deck.record.losses },
    { decks: 0, wins: 0, losses: 0 },
  );

/**
 * Cards the neighbours run that the given deck does not, most shared first. `eligible` is asked only of cards that already pass the
 * share and deck-count floors, so a caller that tallies its refusals counts cards that would otherwise have been suggested.
 */
export function popularCards(
  set: NeighbourSet,
  held: ReadonlyMap<string, number>,
  eligible: (cardKey: string) => boolean,
  options: { minShare: number; minDecks: number },
): PopularRow[] {
  const total = set.neighbours.reduce((s, n) => s + n.similarity, 0);
  if (total === 0) return [];
  const carriers = new Map<string, Neighbour[]>();
  for (const n of set.neighbours) {
    for (const key of n.deck.cards.keys()) {
      if (held.has(key)) continue;
      const list = carriers.get(key) ?? [];
      list.push(n);
      carriers.set(key, list);
    }
  }
  const rows: PopularRow[] = [];
  for (const [cardKey, withCard] of [...carriers].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    const share = withCard.reduce((s, n) => s + n.similarity, 0) / total;
    if (withCard.length < options.minDecks || share < options.minShare || !eligible(cardKey)) continue;
    const mean = withCard.reduce((s, n) => s + (n.deck.cards.get(cardKey) as number), 0) / withCard.length;
    const present = new Set(withCard);
    rows.push({
      cardKey,
      decksWith: withCard.length,
      of: set.neighbours.length,
      share,
      copies: Math.min(MAX_COPIES, Math.max(1, Math.round(mean))),
      withRecord: tally(withCard),
      withoutRecord: tally(set.neighbours.filter((n) => !present.has(n))),
    });
  }
  return rows.sort((a, b) => b.share - a.share || b.decksWith - a.decksWith || compareCodePoints(a.cardKey, b.cardKey));
}
