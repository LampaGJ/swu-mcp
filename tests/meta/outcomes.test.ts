import { describe, expect, it } from "vitest";
import { foldDeckEvidence, foldMatchups, matchupResponseSchema, parseMatchRecord, type NameResolver } from "../../src/meta/outcomes.js";
import { SWUMETASTATS_SOURCE } from "../../src/meta/schema.js";
import { wilson } from "../../src/meta/stats.js";
import { deck, fact } from "./fixtures.js";

const resolver: NameResolver = {
  leader: (name, set) => (name === "Hunter | The One" ? "L1" : name === "Gardener" && set === "sec" ? "L2" : null),
  baseAspects: (name) => (name === "Vigilance Base" ? ["Vigilance"] : null),
};

const row = (leader: string, base: string, opp: string, oppBase: string, wins: number, losses: number, draws = 0) => ({
  leader,
  base,
  aspect: "Command",
  opponentLeader: opp,
  opponentBase: oppBase,
  opponentAspect: oppBase === "Mystery Base" ? "Unknown" : "Command",
  wins,
  losses,
  draws,
});

describe("foldMatchups", () => {
  const response = matchupResponseSchema.parse({
    matchups: [
      row("Hunter | The One", "Vigilance Base", "Gardener", "Some Base", 6, 4, 1),
      row("Gardener", "Some Base", "Hunter | The One", "Vigilance Base", 4, 6, 1),
      row("Hunter | The One", "Other Vigilance", "Gardener", "Some Base", 1, 0),
      row("Nobody", "Vigilance Base", "Gardener", "Some Base", 3, 3),
      row("Hunter | The One", "Vigilance Base", "Gardener", "Mystery Base", 2, 2),
    ],
    leaderSets: { Gardener: "sec" },
  });
  const folded = foldMatchups(response, resolver, { from: "2026-07-19", to: "2026-10-17" });

  it("resolves leaders by name and set, base aspects by base name or the row's aspect word, and halves the match count", () => {
    expect(folded.unresolvedRows).toBe(2);
    expect(folded.matches).toBe(Math.round((11 + 11 + 1) / 2));
    expect(folded.pairs).toEqual([
      { leader: "L1", baseAspects: ["Command"], oppLeader: "L2", oppBaseAspects: ["Command"], wins: 1, losses: 0, draws: 0 },
      { leader: "L1", baseAspects: ["Vigilance"], oppLeader: "L2", oppBaseAspects: ["Command"], wins: 6, losses: 4, draws: 1 },
      { leader: "L2", baseAspects: ["Command"], oppLeader: "L1", oppBaseAspects: ["Vigilance"], wins: 4, losses: 6, draws: 1 },
    ]);
    expect(folded.label).toContain("tournament");
  });
});

describe("parseMatchRecord", () => {
  it("reads W-L-D and rejects anything else", () => {
    expect(parseMatchRecord("5-2-1")).toEqual({ wins: 5, losses: 2, draws: 1 });
    expect(parseMatchRecord("0-2-0")).toEqual({ wins: 0, losses: 2, draws: 0 });
    expect(parseMatchRecord("5-2")).toBeNull();
    expect(parseMatchRecord(undefined)).toBeNull();
  });
});

describe("wilson", () => {
  it("gives the Wilson 95% score interval and null for no matches", () => {
    expect(wilson(7, 12)).toEqual({ low: 0.3195, high: 0.8067 });
    expect(wilson(0, 10)?.low).toBe(0);
    expect(wilson(0, 0)).toBeNull();
  });
});

describe("foldDeckEvidence", () => {
  const facts = new Map([
    ["L1", fact("L1", { type: "Leader", aspectIcons: ["Vigilance", "Villainy"] })],
    ["L2", fact("L2", { type: "Leader", aspectIcons: ["Vigilance", "Villainy"] })],
    ["B1", fact("B1", { type: "Base", aspectIcons: ["Command"] })],
  ]);
  const window = { from: "2026-07-20", to: "2026-10-17" };
  const decks = [
    // L1 decks: 3 with the answer (4-1, 4-1, 3-2), 2 without (1-4, 2-3); filler sits in 4 of 5, so its without side
    // (5 matches) is under minN and it is dropped. One L2 deck; a community list, a deck with no match record and an
    // out-of-window deck are ignored.
    deck("a", { leader: "L1", base: "B1", cards: [["answer", 3], ["filler", 2]], record: { wins: 4, losses: 1, draws: 0 } }),
    deck("b", { leader: "L1", base: "B1", cards: [["answer", 2]], record: { wins: 4, losses: 1, draws: 0 } }),
    deck("c", { leader: "L1", base: "B1", cards: [["answer", 1], ["filler", 3]], record: { wins: 3, losses: 2, draws: 0 } }),
    deck("d", { leader: "L1", base: "B1", cards: [["filler", 3]], record: { wins: 1, losses: 4, draws: 0 } }),
    deck("e", { leader: "L1", base: "B1", cards: [["filler", 3]], record: { wins: 2, losses: 3, draws: 0 } }),
    deck("f", { leader: "L2", base: "B1", cards: [["answer", 3]], record: { wins: 2, losses: 2, draws: 1 } }),
    deck("g", { leader: "L1", base: "B1", cards: [["answer", 3]], population: "community", event: null, placement: null, record: null }),
    deck("h", { leader: "L1", base: "B1", cards: [["answer", 3]], createdAt: "2026-01-01", record: { wins: 9, losses: 0, draws: 0 } }),
    deck("i", { leader: "L1", base: "B1", cards: [["answer", 3]] }),
  ];
  const ev = foldDeckEvidence(decks, facts, window, 10);

  it("groups tournament decks with a match record by leader and base aspects and by aspect set, all from swumetastats", () => {
    expect(ev.source).toBe(SWUMETASTATS_SOURCE);
    expect(ev.decks).toBe(6);
    expect(ev.matches).toBe(30);
    expect(ev.opponents).toContain("unknown");
    const arch = ev.groups.find((g) => g.key === "L1|Command");
    expect(arch).toMatchObject({ level: "archetype", leader: "L1", decks: 5, wins: 14, losses: 11, draws: 0 });
    expect(arch?.cards).toEqual([
      { cardKey: "answer", decks: 3, wins: 11, losses: 4, draws: 0 },
    ]);
    const aspects = ev.groups.find((g) => g.key === "aspects:Command+Vigilance+Villainy");
    expect(aspects).toMatchObject({ level: "aspects", leader: null, decks: 6, wins: 16, losses: 13, draws: 1 });
  });

  it("drops a card row unless both with and without reach minN matches, and a group with no rows", () => {
    expect(ev.groups.some((g) => g.key === "L2|Command")).toBe(false);
    const strict = foldDeckEvidence(decks, facts, window, 11);
    expect(strict.groups.find((g) => g.key === "L1|Command")?.cards.map((c) => c.cardKey) ?? []).toEqual([]);
  });
});
