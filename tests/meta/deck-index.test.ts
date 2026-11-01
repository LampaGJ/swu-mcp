import { describe, expect, it } from "vitest";
import { buildDeckIndex, deckIndexFileSchema, expandTier, type RawIndexDeck, type TierInput } from "../../src/meta/deck-index.js";

const deck = (over: Partial<RawIndexDeck> = {}): RawIndexDeck => ({
  leader: "LW",
  base: "BO",
  aspects: ["Command", "Cunning", "Heroism"],
  event: "swumetastats:7",
  date: "2026-10-01",
  record: "5-2-0",
  placement: 3,
  cards: [
    ["b", 2],
    ["a", 3],
  ],
  ...over,
});

const tournament = (decks: RawIndexDeck[], windowDays?: number): TierInput => ({
  tier: "tournament",
  source: "swumetastats.com",
  population: "tournament decklists with their whole-event match record",
  capture: "swumetastats-decklists 2026-11-01",
  ...(windowDays === undefined ? {} : { windowDays }),
  decks,
});

describe("deck index build step (#193)", () => {
  const decks = [
    deck({ date: "2026-10-02", cards: [["c", 1]] }),
    deck({ date: "2026-09-01" }),
    deck({ leader: "LX", date: "2026-10-02", event: "swumetastats:8", record: null, placement: null }),
  ];

  it("writes a strict, dictionary-coded file that expands back to the same decks", () => {
    const file = buildDeckIndex([tournament(decks)]);
    expect(deckIndexFileSchema.safeParse(file).success).toBe(true);
    const tier = expandTier(file, "tournament");
    expect(tier).not.toBeNull();
    expect(tier?.decks).toHaveLength(3);
    const lx = tier?.decks.find((d) => d.leader === "LX");
    expect(lx).toMatchObject({ base: "BO", aspects: "Command+Cunning+Heroism", event: "swumetastats:8", record: null, placement: null });
    const first = tier?.decks.find((d) => d.date === "2026-09-01");
    expect([...(first?.cards ?? [])]).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
    expect(first?.record).toEqual({ wins: 5, losses: 2, draws: 0 });
  });

  it("is byte-identical whatever order the decks arrive in", () => {
    const a = JSON.stringify(buildDeckIndex([tournament(decks)]));
    const b = JSON.stringify(buildDeckIndex([tournament([...decks].reverse())]));
    expect(a).toBe(b);
  });

  it("keeps only the decks inside the window counted back from the newest deck, and states the window", () => {
    const file = buildDeckIndex([tournament(decks, 30)]);
    const tier = expandTier(file, "tournament");
    expect(tier?.decks.map((d) => d.date).sort()).toEqual(["2026-10-02", "2026-10-02"]);
    expect(tier?.meta.window).toEqual({ from: "2026-10-02", to: "2026-10-02" });
    expect(tier?.meta.decks).toBe(2);
  });

  it("rejects a field the schema does not name, so a player name cannot ride along", () => {
    const file = buildDeckIndex([tournament(decks)]);
    expect(deckIndexFileSchema.safeParse({ ...file, player: "someone" }).success).toBe(false);
    expect(deckIndexFileSchema.safeParse({ ...file, tiers: [{ ...file.tiers[0], author: "someone" }] }).success).toBe(false);
  });

  it("keeps two tiers apart and returns null for a tier it does not hold", () => {
    const file = buildDeckIndex([
      tournament(decks),
      {
        ...tournament([deck({ event: null, record: null, placement: null })]),
        tier: "community",
        source: "swudb.com",
        population: "community lists",
      },
    ]);
    expect(expandTier(file, "community")?.decks).toHaveLength(1);
    expect(expandTier(file, "tournament")?.decks).toHaveLength(3);
    expect(expandTier(buildDeckIndex([tournament(decks)]), "community")).toBeNull();
  });
});
