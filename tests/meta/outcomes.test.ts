import { describe, expect, it } from "vitest";
import { foldCardOutcomes, foldMatchups, matchupResponseSchema, tournamentGames, type NameResolver } from "../../src/meta/outcomes.js";
import { tournamentResultsSchema } from "../../src/meta/schema.js";

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

describe("foldCardOutcomes", () => {
  const meta = { source: "karabast-human" as const, rank: 2, label: "human", basis: "seen", period: { from: null, to: "2026-02-10" } };
  const games = Array.from(
    { length: 12 },
    (_, i) =>
      [
        { leader: "L9", won: (i < 8 ? 1 : 0) as 0 | 1, cards: ["answer", "filler"] },
        { leader: "L1", won: (i < 8 ? 0 : 1) as 0 | 1, cards: ["threat"] },
      ] as const,
  );

  it("counts a side's cards against the other side's leader, aggregates only, and drops rows under minN", () => {
    const out = foldCardOutcomes(
      [
        ...games,
        [
          { leader: "L9", won: null, cards: ["x"] },
          { leader: "L1", won: null, cards: [] },
        ],
      ],
      meta,
      new Set(["L1"]),
      10,
    );
    expect(out.sides).toBe(12);
    expect(out.byLeader).toEqual([
      {
        leader: "L1",
        against: { wins: 8, n: 12 },
        cards: [
          { cardKey: "answer", wins: 8, n: 12 },
          { cardKey: "filler", wins: 8, n: 12 },
        ],
      },
    ]);
    expect(foldCardOutcomes(games, meta, new Set(["L1"]), 13).byLeader[0].cards).toEqual([]);
  });

  it("reads tournament match results, the pluggable primary card-level source", () => {
    const results = tournamentResultsSchema.parse({
      kind: "tournament-matches",
      source: "fixture",
      matches: [
        {
          date: "2026-10-01",
          sides: [
            { leader: "L9", base: "B", cards: [["answer", 3]] },
            { leader: "L1", base: "B", cards: [["threat", 2]] },
          ],
          winner: 0,
        },
      ],
    });
    const [[a, b]] = tournamentGames(results);
    expect(a).toEqual({ leader: "L9", won: 1, cards: ["answer"] });
    expect(b.won).toBe(0);
  });
});
