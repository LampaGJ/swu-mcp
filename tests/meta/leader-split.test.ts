import { describe, expect, it } from "vitest";
import { buildLeaderCards } from "../../src/meta/build.js";
import { indexLeaderCards, leaderCardsFileSchema } from "../../src/meta/schema.js";
import { LEADER_SPLIT_MIN_DECKS, selectLeaderPopulation } from "../../src/meta/leader-split.js";
import { deck, fact } from "./fixtures.js";

const FACTS = new Map(
  [
    fact("L", { title: "Split Leader", type: "Leader", aspectIcons: ["Cunning", "Heroism"] }),
    fact("BJ", { title: "Jundland", type: "Base", aspectIcons: ["Aggression"] }),
    fact("BO", { title: "Origin Tree", type: "Base", aspectIcons: ["Command"] }),
    fact("BC", { title: "Command Two", type: "Base", aspectIcons: ["Command"] }),
    fact("BR", { title: "Rare Base", type: "Base", aspectIcons: ["Vigilance"] }),
    fact("AGG", { title: "Aggro Card", aspectIcons: ["Aggression"] }),
    fact("CMD", { title: "Command Card", aspectIcons: ["Command"] }),
    fact("ANY", { title: "Any Card", aspectIcons: [] }),
  ].map((f) => [f.cardKey, f]),
);

const community = (key: string, base: string, cards: [string, number][]) =>
  deck(key, { leader: "L", base, cards, population: "community", source: "swudb", event: null, placement: null });

/** 12 Jundland lists, 11 Origin Tree lists, 3 Command Two lists and 2 Rare Base lists. */
const DECKS = [
  ...Array.from({ length: 12 }, (_, i) => community(`j${i}`, "BJ", [["AGG", 3], ["ANY", 1]])),
  ...Array.from({ length: 11 }, (_, i) => community(`o${i}`, "BO", [["CMD", 2], ["ANY", 1]])),
  ...Array.from({ length: 3 }, (_, i) => community(`c${i}`, "BC", [["CMD", 1]])),
  ...Array.from({ length: 2 }, (_, i) => community(`r${i}`, "BR", [["ANY", 2]])),
];

describe("leader-cards per-base split (#148)", () => {
  const file = buildLeaderCards(DECKS, FACTS);
  const entry = file.leaders.find((l) => l.leader.cardKey === "L");

  it("counts the leader's lists per base and keeps the whole-population cards unchanged", () => {
    expect(entry?.decks).toBe(28);
    expect(entry?.baseDecks).toEqual([
      { cardKey: "BJ", title: "Jundland", aspects: ["Aggression"], decks: 12 },
      { cardKey: "BO", title: "Origin Tree", aspects: ["Command"], decks: 11 },
      { cardKey: "BC", title: "Command Two", aspects: ["Command"], decks: 3 },
      { cardKey: "BR", title: "Rare Base", aspects: ["Vigilance"], decks: 2 },
    ]);
    expect(entry?.cards.find((c) => c.cardKey === "AGG")?.inclusion).toBeCloseTo(12 / 28, 3);
  });

  it(`emits a split for each base and each base-aspect group of at least ${LEADER_SPLIT_MIN_DECKS} lists, and no smaller one`, () => {
    expect(LEADER_SPLIT_MIN_DECKS).toBe(10);
    const splits = entry?.splits ?? [];
    expect(splits.map((s) => `${s.kind}:${s.key}:${s.decks}`)).toEqual(["base:BJ:12", "base:BO:11", "aspect:Command:14"]);
    const origin = splits.find((s) => s.key === "BO");
    expect(origin?.label).toBe("Origin Tree");
    expect(origin?.cards.find((c) => c.cardKey === "CMD")).toMatchObject({ inclusion: 1, meanCopies: 2 });
    expect(origin?.cards.find((c) => c.cardKey === "AGG")).toBeUndefined();
  });

  it("stays deterministic and strict", () => {
    expect(JSON.stringify(buildLeaderCards([...DECKS].reverse(), FACTS))).toBe(JSON.stringify(file));
    expect(() => leaderCardsFileSchema.parse(file)).not.toThrow();
  });
});

describe("selectLeaderPopulation (#148)", () => {
  const index = indexLeaderCards(buildLeaderCards(DECKS, FACTS));
  const data = index.get("L") as NonNullable<ReturnType<typeof index.get>>;
  const base = (cardKey: string, title: string, aspects: string[]) => ({ cardKey, title, aspects });

  it("uses the lists with the given base when at least 10 remain, and labels them", () => {
    const sel = selectLeaderPopulation(data, { base: base("BO", "Origin Tree", ["Command"]) });
    expect(sel.selection).toMatchObject({ scope: "base", label: "Origin Tree", decks: 11, allDecks: 28 });
    expect(sel.entry.decks).toBe(11);
    expect(sel.byCard.get("AGG")).toBeUndefined();
    expect(sel.byCard.get("CMD")?.inclusion).toBe(1);
  });

  it("widens to the base's aspect when its own lists are under the floor, naming both counts", () => {
    const sel = selectLeaderPopulation(data, { base: base("BC", "Command Two", ["Command"]) });
    expect(sel.selection).toMatchObject({ scope: "aspect", label: "Command", decks: 14, allDecks: 28 });
    expect(sel.selection.line).toBe("3 Command Two lists is under the 10-deck floor; using the 14 Split Leader lists whose base is Command");
  });

  it("falls back to all lists with one line naming the counts and the dominant base", () => {
    const sel = selectLeaderPopulation(data, { base: base("BR", "Rare Base", ["Vigilance"]) });
    expect(sel.selection).toMatchObject({ scope: "all", decks: 28, allDecks: 28 });
    expect(sel.selection.line).toBe("2 Rare Base lists is under the 10-deck floor; using all 28 Split Leader lists, 12 of which run Jundland (Aggression)");
    expect(sel.entry).toBe(data.entry);
  });

  it("takes a base aspect set alone", () => {
    const sel = selectLeaderPopulation(data, { baseAspects: ["Command"] });
    expect(sel.selection).toMatchObject({ scope: "aspect", label: "Command", decks: 14 });
  });

  it("answers an aspect carried by one base from that base's split, and says when every list runs the base", () => {
    const only = indexLeaderCards(buildLeaderCards(DECKS.filter((d) => d.base !== "BC"), FACTS)).get("L") as typeof data;
    const sel = selectLeaderPopulation(only, { baseAspects: ["Aggression"] });
    expect(sel.selection).toMatchObject({ scope: "aspect", label: "Aggression", decks: 12 });
    expect(sel.entry.decks).toBe(12);
    const solo = indexLeaderCards(buildLeaderCards(DECKS.filter((d) => d.base === "BJ"), FACTS)).get("L") as typeof data;
    expect(selectLeaderPopulation(solo, { base: base("BJ", "Jundland", ["Aggression"]) }).selection).toMatchObject({
      scope: "all",
      line: "all 12 Split Leader lists run Jundland",
    });
  });

  it("leaves the population alone with no base, and for a package built without the split", () => {
    expect(selectLeaderPopulation(data, {}).selection).toMatchObject({ scope: "all", line: null });
    const old = { entry: { ...data.entry, baseDecks: undefined, splits: undefined }, byCard: data.byCard };
    const sel = selectLeaderPopulation(old, { base: base("BO", "Origin Tree", ["Command"]) });
    expect(sel.selection.scope).toBe("all");
    expect(sel.selection).toMatchObject({ scope: "all", line: null, decks: 28 });
  });
});
