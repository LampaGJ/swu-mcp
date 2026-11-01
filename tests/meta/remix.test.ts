import { describe, expect, it } from "vitest";
import type { IndexDeck } from "../../src/meta/deck-index.js";
import { nearestDecks, popularCards, weightedJaccard, type Target } from "../../src/meta/remix.js";

const cards = (obj: Record<string, number>): ReadonlyMap<string, number> => new Map(Object.entries(obj));
let n = 0;
const mk = (over: Omit<Partial<IndexDeck>, "cards"> & { cards: Record<string, number> }): IndexDeck => {
  const { cards: c, ...rest } = over;
  n += 1;
  return {
    index: n,
    leader: "L1",
    base: "B1",
    aspects: "Command+Cunning",
    event: null,
    date: "2026-10-01",
    record: null,
    placement: null,
    ...rest,
    cards: cards(c),
  };
};
const target: Target = { leader: "L1", base: "B1", aspects: "Command+Cunning", cards: cards({ a: 3, b: 3, c: 3, d: 3 }) };

describe("weighted Jaccard over card copies (#193)", () => {
  it("is the sum of the smaller counts over the sum of the larger counts", () => {
    expect(weightedJaccard(cards({ a: 3, b: 3, c: 3, d: 3 }), cards({ a: 3, b: 3, c: 3, d: 2 }))).toBeCloseTo(11 / 12, 12);
    expect(weightedJaccard(cards({ a: 3, b: 3, c: 3, d: 3 }), cards({ a: 3, b: 3, x: 3, y: 3 }))).toBeCloseTo(6 / 18, 12);
    expect(weightedJaccard(cards({ a: 1 }), cards({ a: 1 }))).toBe(1);
    expect(weightedJaccard(cards({ a: 1 }), cards({ z: 1 }))).toBe(0);
    expect(weightedJaccard(cards({}), cards({}))).toBe(0);
  });

  it("orders neighbours nearest first, ties by newer date then index", () => {
    const far = mk({ cards: { a: 3, x: 3, y: 3, z: 3 } });
    const near = mk({ cards: { a: 3, b: 3, c: 3, d: 2 } });
    const mid = mk({ cards: { a: 3, b: 3, x: 3, y: 3 } });
    const set = nearestDecks([far, near, mid], target, 3, 0);
    expect(set.neighbours.map((x) => x.deck.index)).toEqual([near.index, mid.index, far.index]);
    expect(set.neighbours[0].similarity).toBeCloseTo(11 / 12, 12);
  });
});

describe("neighbour widening is stated (#193)", () => {
  const sameBase = [mk({ cards: { a: 3, b: 3 } }), mk({ cards: { a: 3, b: 3, c: 3 } })];
  const sameLeader = [1, 2, 3].map(() => mk({ base: "B2", cards: { a: 3, b: 3, c: 3, d: 1 } }));
  const sameAspects = [
    mk({ leader: "L2", base: "B3", cards: { a: 3, b: 3, c: 3, d: 2 } }),
    mk({ leader: "L2", base: "B3", cards: { a: 3 } }),
  ];
  const otherAspects = [mk({ leader: "L9", base: "B9", aspects: "Aggression+Villainy", cards: { a: 3, b: 3, c: 3, d: 3 } })];
  const all = [...sameBase, ...sameLeader, ...sameAspects, ...otherAspects];

  it("draws from the same leader and base first and says nothing about widening when that is enough", () => {
    const set = nearestDecks(all, target, 2, 0);
    expect(set.neighbours.map((x) => x.level)).toEqual(["leader+base", "leader+base"]);
    expect(set.widening).toEqual([]);
    expect(set.reach).toBe("leader+base");
  });

  it("widens to the same leader, then to the same aspects, and names each step and how many decks it added", () => {
    const set = nearestDecks(all, target, 7, 0);
    expect(set.neighbours.filter((x) => x.level === "leader+base")).toHaveLength(2);
    expect(set.neighbours.filter((x) => x.level === "leader")).toHaveLength(3);
    expect(set.neighbours.filter((x) => x.level === "aspects")).toHaveLength(2);
    expect(set.reach).toBe("aspects");
    expect(set.widening).toHaveLength(2);
    expect(set.widening[0]).toContain("same leader");
    expect(set.widening[0]).toContain("3");
    expect(set.widening[1]).toContain("same aspects");
    expect(set.neighbours.some((x) => x.deck.aspects === "Aggression+Villainy")).toBe(false);
  });

  it("returns an empty set that names the reason when no deck shares the leader, base or aspects", () => {
    const set = nearestDecks(otherAspects, target, 5, 0);
    expect(set.neighbours).toEqual([]);
    expect(set.reach).toBeNull();
    expect(set.widening[0]).toMatch(/no deck/);
  });

  it("does not count a deck with exactly the target's cards as its own neighbour, and says how many it skipped", () => {
    const twin = mk({ cards: { a: 3, b: 3, c: 3, d: 3 } });
    const set = nearestDecks([twin, ...sameBase], target, 5, 0);
    expect(set.neighbours.some((x) => x.deck.index === twin.index)).toBe(false);
    expect(set.identical).toBe(1);
  });

  it("leaves out decks below the similarity floor", () => {
    const set = nearestDecks(all, target, 20, 0.5);
    expect(set.neighbours.every((x) => x.similarity >= 0.5)).toBe(true);
  });
});

describe("popular cards among the neighbours (#193)", () => {
  const decks = [
    mk({ cards: { a: 3, b: 3, c: 3, d: 3, z: 3 }, record: { wins: 5, losses: 2, draws: 0 } }),
    mk({ cards: { a: 3, b: 3, c: 3, d: 3, z: 2 }, record: { wins: 4, losses: 3, draws: 1 } }),
    mk({ cards: { a: 3, b: 3, c: 3, d: 3, z: 3 }, record: { wins: 3, losses: 3, draws: 0 } }),
    mk({ cards: { a: 3, b: 3, c: 3, d: 3, y: 1 }, record: { wins: 2, losses: 4, draws: 0 } }),
  ];
  const set = nearestDecks(decks, target, 4, 0);

  it("counts the neighbours that run a card the deck does not, with copies and the with/without record", () => {
    const rows = popularCards(set, target.cards, () => true, { minShare: 0.3, minDecks: 2 });
    expect(rows.map((r) => r.cardKey)).toEqual(["z"]);
    const z = rows[0];
    expect(z.decksWith).toBe(3);
    expect(z.of).toBe(4);
    expect(z.copies).toBe(3);
    expect(z.share).toBeGreaterThan(0.6);
    expect(z.withRecord).toEqual({ decks: 3, wins: 12, losses: 8 });
    expect(z.withoutRecord).toEqual({ decks: 1, wins: 2, losses: 4 });
  });

  it("skips ineligible cards and cards the deck already runs, and counts what it skipped", () => {
    const rows = popularCards(set, cards({ ...Object.fromEntries(target.cards), z: 1 }), () => true, { minShare: 0.3, minDecks: 2 });
    expect(rows).toEqual([]);
    const filtered = popularCards(set, target.cards, (k) => k !== "z", { minShare: 0.3, minDecks: 2 });
    expect(filtered).toEqual([]);
  });
});
