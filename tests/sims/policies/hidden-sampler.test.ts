import { describe, expect, it } from "vitest";
import { seededRandom } from "../../../scripts/bench/stats.js";
import { BELIEF, knownDecklistSampler, SAMPLERS, type HiddenView } from "../../../src/sims/policies/hidden-sampler.js";

const card = (uuid: string) => ({ uuid, name: uuid.split("_")[0] });
const view = (decklist: string[], own: string[], handSize: number): HiddenView => ({ seat: 1, opponentHandSize: handSize, opponentDecklist: decklist.map(card), ownDeck: own.map(card) });
const DECK = ["a_1", "b_2", "c_3", "d_4", "e_5", "f_6", "g_7", "h_8"];
const OWN = ["x_10", "y_11", "z_12"];

describe("hidden-card samplers (#183)", () => {
  it("the known-decklist sampler deals only unseen cards, the opponent's hand at its public size, and both decks in full", () => {
    const seen = new Set(["b_2", "g_7"]);
    const s = knownDecklistSampler(view(DECK, OWN, 2), seen, seededRandom("k|1"));
    expect(s.opponentHand).toHaveLength(2);
    expect([...s.opponentHand, ...s.opponentDeckOrder].sort()).toEqual(DECK.filter((u) => !seen.has(u)).sort());
    expect([...s.ownDeckOrder].sort()).toEqual([...OWN].sort());
  });

  it("is a function of what the actor knows and the key: the order the cards arrive in (the true hidden order) changes nothing", () => {
    const seen = new Set(["b_2"]);
    const a = knownDecklistSampler(view(DECK, OWN, 3), seen, seededRandom("k|2"));
    const b = knownDecklistSampler(view([...DECK].reverse(), [...OWN].reverse(), 3), seen, seededRandom("k|2"));
    expect(b).toEqual(a);
    const c = knownDecklistSampler(view(DECK, OWN, 3), seen, seededRandom("k|3"));
    expect(c).not.toEqual(a);
  });

  it("refuses a hand larger than the unseen pool instead of dealing a short hand", () => {
    expect(() => knownDecklistSampler(view(["a_1"], OWN, 2), new Set(), seededRandom("k"))).toThrow(/unseen/);
  });

  it("names its samplers by a numeric belief code, so the params hash stays a number map", () => {
    expect(BELIEF.known).toBe(1);
    expect(SAMPLERS[BELIEF.known]).toBe(knownDecklistSampler);
  });
});
