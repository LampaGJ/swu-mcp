import { describe, expect, it } from "vitest";
import { buildMeta, deckWeights, DEFAULT_META_OPTIONS, windowOf, type CardFact } from "../../src/meta/build.js";
import { deck, fact } from "./fixtures.js";

const facts = new Map<string, CardFact>(
  [
    fact("L1", { type: "Leader", title: "Hunter", aspectIcons: ["Aggression", "Villainy"], power: 4, hp: 7 }),
    fact("L2", { type: "Leader", title: "Gardener", aspectIcons: ["Command", "Heroism"] }),
    fact("BV", { type: "Base", title: "Vigilance Base", aspectIcons: ["Vigilance"], cost: null }),
    fact("BV2", { type: "Base", title: "Other Vigilance Base", aspectIcons: ["Vigilance"], cost: null }),
    fact("BC", { type: "Base", title: "Command Base", aspectIcons: ["Command"], cost: null }),
    fact("U1", { title: "Sentinel Wall", cost: 3, power: 2, hp: 6, keywords: ["Sentinel"] }),
    fact("U2", { title: "Space Ace", cost: 4, power: 4, hp: 4, arenas: ["Space"], keywords: ["Raid"] }),
    fact("U3", { title: "Cheap Droid", cost: 1, power: 1, hp: 2, offers: ["offers:create-token-units"] }),
    fact("E1", { type: "Event", title: "Draw Two", cost: 2, offers: ["offers:draw"] }),
    fact("G1", { type: "Upgrade", title: "Blaster", cost: 2 }),
  ].map((f) => [f.cardKey, f]),
);

const OPTIONS = { ...DEFAULT_META_OPTIONS, minDecks: 2, minTournamentDecks: 4 };

const hunterDecks = Array.from({ length: 6 }, (_, i) =>
  deck(`h${i}`, {
    leader: "L1",
    base: i % 2 === 0 ? "BV" : "BV2",
    cards: [
      ["U1", 3],
      ["U2", 3],
      ["U3", 3],
      ["E1", i < 3 ? 2 : 0],
    ].filter(([, n]) => (n as number) > 0) as [string, number][],
    placement: i + 1,
    event: "melee:1",
    field: 32,
  }),
);
const gardenerDecks = Array.from({ length: 2 }, (_, i) =>
  deck(`g${i}`, {
    leader: "L2",
    base: "BC",
    cards: [
      ["G1", 3],
      ["U3", 2],
    ],
    placement: 20 + i,
    event: "melee:1",
    field: 32,
  }),
);
const communityDecks = Array.from({ length: 3 }, (_, i) =>
  deck(`c${i}`, { leader: "L2", base: "BC", cards: [["G1", 3]], population: "community", source: "swudb", event: null, placement: null }),
);
const oldDeck = deck("old", { leader: "L2", base: "BC", cards: [["G1", 3]], createdAt: "2026-01-01" });

describe("windowOf", () => {
  it("ends on the newest createdAt and spans the given days inclusive", () => {
    expect(windowOf([deck("a", { leader: "L1", base: "BV", cards: [], createdAt: "2026-10-17" })], 90)).toEqual({
      from: "2026-07-20",
      to: "2026-10-17",
      days: 90,
    });
  });
});

describe("deckWeights", () => {
  it("weights a winner near 2, a last place near 1 and a community list 1", () => {
    const w = deckWeights([
      deck("win", { leader: "L1", base: "BV", cards: [], placement: 1, field: 10 }),
      deck("last", { leader: "L1", base: "BV", cards: [], placement: 10, field: 10 }),
      deck("c", { leader: "L1", base: "BV", cards: [], population: "community", event: null, placement: null }),
    ]);
    expect(w.get("win")).toBe(2);
    expect(w.get("last")).toBeCloseTo(1.1);
    expect(w.get("c")).toBe(1);
  });
});

describe("buildMeta", () => {
  const meta = buildMeta([...hunterDecks, ...gardenerDecks, ...communityDecks, oldDeck], facts, OPTIONS);

  it("uses tournament decks as the primary population and keeps community lists apart", () => {
    expect(meta.primary).toBe("tournament");
    expect(meta.fallback).toBe(false);
    expect(meta.populations.map((p) => [p.population, p.decks])).toEqual([
      ["tournament", 8],
      ["community", 3],
    ]);
    expect(meta.archetypes.filter((a) => a.population === "community")).toHaveLength(1);
  });

  it("drops decks outside the window", () => {
    expect(meta.window.to).toBe("2026-10-01");
    expect(meta.archetypes.reduce((n, a) => n + a.decks, 0)).toBe(11);
  });

  it("groups by leader and base aspect, ranks by weighted share and counts top 8 finishes", () => {
    const t = meta.archetypes.filter((a) => a.population === "tournament");
    expect(t.map((a) => a.leader.title)).toEqual(["Hunter", "Gardener"]);
    expect(t[0].baseAspects).toEqual(["Vigilance"]);
    expect(t[0].bases.map((b) => b.decks)).toEqual([3, 3]);
    expect(t[0].top8).toBe(6);
    expect(t[0].top8Share).toBe(1);
    expect(t[0].share + t[1].share).toBeCloseTo(1, 3);
    expect(t[0].id).toMatch(/^t001-[0-9a-f]{6}$/);
  });

  it("profiles the threats: arena split, keywords, cheap units and key units with stats", () => {
    const p = meta.archetypes[0].profile;
    expect(p.arena.space).toBe(3);
    expect(p.arena.ground).toBe(6);
    expect(p.keywords.Sentinel).toBe(3);
    expect(p.keywords.Raid).toBe(3);
    expect(p.cheapUnits).toBe(3);
    expect(p.cheapUnitMedianHp).toBe(2);
    expect(p.leader).toEqual({ power: 4, hp: 7, arenas: ["Ground"] });
    expect(p.keyUnits.map((u) => [u.title, u.cost, u.power, u.hp])).toEqual([
      ["Space Ace", 4, 4, 4],
      ["Sentinel Wall", 3, 2, 6],
      ["Cheap Droid", 1, 1, 2],
    ]);
    expect(p.offers["offers:draw"]).toBeGreaterThan(0);
  });

  it("falls back to community lists when the window holds too few tournament decks", () => {
    const fallback = buildMeta([...gardenerDecks, ...communityDecks], facts, OPTIONS);
    expect(fallback.primary).toBe("community");
    expect(fallback.fallback).toBe(true);
  });

  it("is byte-identical on a rerun", () => {
    const again = buildMeta([...hunterDecks, ...gardenerDecks, ...communityDecks, oldDeck].reverse(), facts, OPTIONS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(meta));
  });
});
