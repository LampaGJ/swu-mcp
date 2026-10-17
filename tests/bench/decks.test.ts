import { describe, expect, it } from "vitest";
import { dedupeDecks, normalizeDeck } from "../../scripts/bench/decks.js";

const byId = new Map([
  ["JTL_001", "L1"],
  ["JTL_020", "B1"],
  ["JTL_100", "C1"],
  ["JTL_300", "C1"],
  ["SEC_050", "C2"],
]);
const icons = new Map([
  ["L1", ["Command", "Villainy"]],
  ["B1", ["Vigilance"]],
]);

const file = (over: Record<string, unknown> = {}) => ({
  metadata: { name: "Deck", author: "someone", createdAt: "2026-01-02T00:00:00Z", idea_source: "https://melee.gg/x" },
  leader: { id: "JTL_001", count: 1 },
  base: { id: "JTL_020", count: 1 },
  deck: [
    { id: "JTL_100", count: 2 },
    { id: "JTL_300", count: 1 },
    { id: "SEC_050", count: 3 },
    { id: "ZZZ_999", count: 1 },
  ],
  sideboard: [{ id: "SEC_050", count: 1 }],
  ...over,
});

describe("deck normalisation", () => {
  it("folds printings to logical cards, keeps aspects and createdAt, drops the author", () => {
    const deck = normalizeDeck(file(), byId, icons);
    expect(deck.leader).toBe("L1");
    expect(deck.base).toBe("B1");
    expect(deck.aspects).toEqual(["Command", "Vigilance", "Villainy"]);
    expect(deck.cards).toEqual([
      ["C1", 3],
      ["C2", 3],
    ]);
    expect(deck.sideboard).toEqual([["C2", 1]]);
    expect(deck.unmapped).toEqual(["ZZZ_999"]);
    expect(deck.createdAt).toBe("2026-01-02T00:00:00Z");
    expect(deck.source).toBe("melee.gg");
    expect(JSON.stringify(deck)).not.toContain("someone");
  });

  it("the same list in a different order hashes the same", () => {
    const a = normalizeDeck(file(), byId, icons);
    const b = normalizeDeck(file({ deck: [...file().deck].reverse() }), byId, icons);
    expect(a.key).toBe(b.key);
  });
});

describe("dedupe across snapshots", () => {
  it("keeps one deck, every snapshot it appeared in and the earliest createdAt", () => {
    const early = normalizeDeck(file({ metadata: { createdAt: "2025-12-25T00:00:00Z", source: "swudb" } }), byId, icons);
    const late = normalizeDeck(file(), byId, icons);
    const other = normalizeDeck(file({ base: { id: "JTL_001", count: 1 } }), byId, icons);
    const out = dedupeDecks([
      { snapshot: "b", deck: late },
      { snapshot: "a", deck: early },
      { snapshot: "b", deck: other },
      { snapshot: "b", deck: late },
    ]);
    expect(out.decks).toHaveLength(2);
    const merged = out.decks.find((d) => d.key === late.key);
    expect(merged?.snapshots).toEqual(["a", "b"]);
    expect(merged?.createdAt).toBe("2025-12-25T00:00:00Z");
    expect(out.duplicatesWithinSnapshot).toBe(1);
    expect(out.duplicatesAcrossSnapshots).toBe(1);
  });
});
