import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySwaps, rankVariants } from "../../scripts/export-warrior-decks.js";
import { swudbDeckSchema } from "../../src/tools/swudb.js";

const fixture = swudbDeckSchema.parse(JSON.parse(readFileSync("tests/fixtures/decks/warrior-chewie-raid.swudb.json", "utf8")));
const total = (d: { deck: { count: number }[] }) => d.deck.reduce((n, e) => n + e.count, 0);

describe("export-warrior-decks", () => {
  it("applies a swap, keeps the deck size and stays a valid SWUDB document", () => {
    const out = applySwaps(fixture, ["HMW_212>LAW_232"]);
    expect(total(out)).toBe(total(fixture));
    expect(out.deck.find((e) => e.id === "LAW_232")?.count).toBe(1);
  });
  it("refuses a swap whose source card is absent", () => {
    expect(() => applySwaps(fixture, ["ZZZ_999>LAW_232"])).toThrow(/not in the deck/);
  });
  it("ranks tunings by share and drops controls", () => {
    const v = (name: string, share: number) => ({ name, file: "f", swaps: [], share: { wins: 0, n: 1, share, low: 0, high: 1 } });
    expect(rankVariants([v("base", 0.4), v("dead-card-control", 0.9), v("a", 0.5)]).map((x) => x.name)).toEqual(["a", "base"]);
  });
});
