import { seededRandom } from "../../../scripts/bench/stats.js";
import { compareCodePoints } from "../../swu/canonical.js";
import type { EngineGame, EnginePlayer } from "../engine.js";
import { BELIEF } from "./lookahead.js";

/**
 * @displayName Hidden-card sampler (fair lookahead re-deal)
 * @strategicPurpose A lookahead bot may only plan around what its player could know (#183): before every trial the
 * opponent's hand and both decks' order are replaced by a guess, so no trial plays the opponent's real hand or draws
 * the real next card. Which guess is a pluggable belief, so a prior from tournament lists or a learned hand model can
 * replace the published decklist later without touching the search.
 * @tacticalObjective `sampleHidden(view, seen, rng)` returns card ids for the opponent's hand, the opponent's deck order
 * and our deck order. The view carries only what the actor knows: the opponent's hand size, the opponent's registered
 * decklist and which cards are in our own deck. `knownDecklistSampler` (belief `known`) deals the decklist minus every
 * seen card, put in id order before a seeded shuffle, so its output depends on the key and the actor's knowledge only,
 * never on the true hidden order. `redealHidden` reads the view from the engine, samples with the counter-keyed
 * stream and applies the sample; the caller's rollback restores the real state.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript */
type AnyCard = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface HiddenCard {
  /** Engine object id: a deterministic name and counter (forceteki GameStateManager), stable for the whole game. */
  uuid: string;
  name: string;
}

/** What the actor knows about the hidden zones. */
export interface HiddenView {
  seat: 1 | 2;
  opponentHandSize: number;
  /** The opponent's main-deck cards as the actor believes they were registered (here: the published list). */
  opponentDecklist: readonly HiddenCard[];
  /** The cards in our own deck: which ones, never their order. */
  ownDeck: readonly HiddenCard[];
}

export interface HiddenSample {
  opponentHand: string[];
  /** Top card first. */
  opponentDeckOrder: string[];
  ownDeckOrder: string[];
}

/** `seen` holds the ids of the opponent's decklist cards the actor has seen leave the hidden zones. */
export type HiddenSampler = (view: HiddenView, seen: ReadonlySet<string>, rng: () => number) => HiddenSample;

export { BELIEF, BELIEF_NAMES } from "./lookahead.js";

const shuffled = (ids: readonly string[], rng: () => number): string[] => {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

const canonical = (cards: readonly HiddenCard[]): string[] => cards.map((c) => c.uuid).sort(compareCodePoints);

/** The published decklist minus every seen card: fair when the opponent's list is public, as tournament lists are. */
export const knownDecklistSampler: HiddenSampler = (view, seen, rng) => {
  const pool = canonical(view.opponentDecklist.filter((c) => !seen.has(c.uuid)));
  if (pool.length < view.opponentHandSize) throw new Error(`hidden sampler: ${pool.length} unseen cards cannot fill a hand of ${view.opponentHandSize}`);
  const opp = shuffled(pool, rng);
  return { opponentHand: opp.slice(0, view.opponentHandSize), opponentDeckOrder: opp.slice(view.opponentHandSize), ownDeckOrder: shuffled(canonical(view.ownDeck), rng) };
};

export const SAMPLERS: Readonly<Record<number, HiddenSampler>> = { [BELIEF.known]: knownDecklistSampler };

const hiddenCard = (c: AnyCard): HiddenCard => ({ uuid: String(c.uuid), name: String(c.internalName) });

/**
 * The actor's view, read from the engine. Every decklist card outside the opponent's hand and deck counts as seen,
 * face-down resources included: the re-deal moves hand and deck only, so a resource keeps its true identity (#183
 * names this residual gap).
 */
export function hiddenViewOf(players: readonly [EnginePlayer, EnginePlayer], seat: 1 | 2): { view: HiddenView; seen: Set<string> } {
  const me = players[seat - 1] as AnyCard;
  const opp = players[2 - seat] as AnyCard;
  const decklist = (opp.allCards as AnyCard[]).filter((c) => c !== undefined && c !== null && !c.isLeader() && !c.isBase() && !c.isToken()).map(hiddenCard);
  const hidden = new Set([...(opp.hand as AnyCard[]), ...(opp.drawDeck as AnyCard[])].map((c) => String(c.uuid)));
  const seen = new Set(decklist.filter((c) => !hidden.has(c.uuid)).map((c) => c.uuid));
  return { view: { seat, opponentHandSize: (opp.hand as AnyCard[]).length, opponentDecklist: decklist, ownDeck: (me.drawDeck as AnyCard[]).map(hiddenCard) }, seen };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));

/**
 * Puts a sample into the live engine: reseeds the engine RNG (so a trial's random effects do not follow the real
 * game's future), rebuilds both decks in the sampled order and draws the opponent's sampled hand. Our hand and every
 * public zone stay. Refuses a sample that is not exactly the cards in the hidden zones.
 */
export function applyHidden(game: EngineGame, players: readonly [EnginePlayer, EnginePlayer], seat: 1 | 2, sample: HiddenSample, engineKey: string): void {
  const me = players[seat - 1] as AnyCard;
  const opp = players[2 - seat] as AnyCard;
  const oppCards = [...(opp.hand as AnyCard[]), ...(opp.drawDeck as AnyCard[])];
  const ownCards = [...(me.drawDeck as AnyCard[])];
  if (sample.opponentHand.length !== (opp.hand as AnyCard[]).length) throw new Error("hidden sample: the opponent's hand size changed");
  if (!sameSet([...sample.opponentHand, ...sample.opponentDeckOrder], oppCards.map((c) => String(c.uuid)))) throw new Error("hidden sample: the opponent's cards are not the cards in their hand and deck");
  if (!sameSet(sample.ownDeckOrder, ownCards.map((c) => String(c.uuid)))) throw new Error("hidden sample: our deck's cards changed");
  (game.randomGenerator as unknown as { reseed(seed: string): void }).reseed(engineKey);
  const byId = new Map([...oppCards, ...ownCards].map((c) => [String(c.uuid), c]));
  for (const c of [...(opp.hand as AnyCard[])]) c.moveTo("deckBottom");
  opp.deckZone.clearDeck();
  for (const id of [...sample.opponentHand, ...sample.opponentDeckOrder]) opp.deckZone.addCardToBottom(byId.get(id));
  opp.drawCardsToHand(sample.opponentHand.length);
  me.deckZone.clearDeck();
  for (const id of sample.ownDeckOrder) me.deckZone.addCardToBottom(byId.get(id));
}

/** One fair re-deal of what `seat` cannot see, keyed by `key` (the sampler's stream; the engine reseed is `key|engine`). */
export function redealHidden(game: EngineGame, players: readonly [EnginePlayer, EnginePlayer], seat: 1 | 2, belief: number, key: string): void {
  const sampler = SAMPLERS[belief];
  if (sampler === undefined) throw new Error(`no hidden sampler for belief ${belief}`);
  const { view, seen } = hiddenViewOf(players, seat);
  applyHidden(game, players, seat, sampler(view, seen, seededRandom(key)), `${key}|engine`);
}
