import { describe, expect, it } from "vitest";
import { buildPlay, buildPrices, parseWindowId, weekEndDate, weekStartDate, type PriceRow } from "../../src/market/build.js";

const row = (card_id: string, variant: string, product_id: number, price_normal: number | null, price_foil: number | null): PriceRow => ({
  card_id,
  variant,
  product_id,
  price_normal,
  price_foil,
  price_source: "direct",
  conformance: "conformant",
});

const rows = [row("A2", "hyperspace", 4, 2, null), row("A1", "standard", 1, 0.5, null), row("A1", "standard-foil", 2, null, 1.5), row("B1", "standard", 3, 9, 12)];
const keys = new Map([
  ["A1", "A1"],
  ["A2", "A1"],
  ["B1", "B1"],
]);

describe("buildPrices", () => {
  it("groups printings by logical card with the canonical printing's prices", () => {
    const out = buildPrices({ rows, cardKeyOfPrinting: keys, importId: 43, importFinishedAt: "2026-10-16T05:14:33.9" });
    expect(out.cards.map((c) => c.cardKey)).toEqual(["A1", "B1"]);
    expect(out.cards[0]).toMatchObject({ normal: 0.5, foil: 1.5 });
    expect(out.cards[0].printings.map((p) => `${p.cardId}/${p.variant}`)).toEqual(["A1/standard", "A1/standard-foil", "A2/hyperspace"]);
  });

  it("is byte-identical whatever the input order", () => {
    const make = (input: PriceRow[]) => JSON.stringify(buildPrices({ rows: input, cardKeyOfPrinting: keys, importId: 43, importFinishedAt: null }));
    expect(make([...rows].reverse())).toBe(make(rows));
  });

  it("refuses a price row that maps to no logical card", () => {
    expect(() => buildPrices({ rows: [row("Z9", "standard", 9, 1, null)], cardKeyOfPrinting: keys, importId: 1, importFinishedAt: null })).toThrow(/Z9/);
  });
});

describe("buildPlay", () => {
  const cardKeyOfUid = new Map([
    ["1", "L1"],
    ["2", "A1"],
    ["3", "A1"],
  ]);
  const captures = [
    { file: "swustats-premier-w29-55.json", sha256: "b".repeat(64), rows: [{ cardUid: "1", timesIncluded: 10, timesIncludedInWins: 6 }, { cardUid: 2, timesIncluded: 4, timesIncludedInWins: 1 }] },
    { file: "swustats-premier-w0-55.json", sha256: "a".repeat(64), rows: [{ cardUid: "1", timesIncluded: 30, timesIncludedInWins: 15 }, { cardUid: "2", timesIncluded: 8, timesIncludedInWins: 3 }, { cardUid: "3", timesIncluded: 2, timesIncludedInWins: 1 }] },
  ];
  const run = (input: typeof captures) => buildPlay({ captures: input, cardKeyOfUid, leaderKeys: new Set(["L1"]) });

  it("sums rows per logical card, counts player-games from leaders and orders windows", () => {
    const out = run(captures);
    expect(out.windows.map((w) => [w.id, w.playerGames])).toEqual([["w0-55", 30], ["w29-55", 10]]);
    expect(out.cards.find((c) => c.cardKey === "A1")?.byWindow).toEqual({ "w0-55": { included: 10, wins: 4 }, "w29-55": { included: 4, wins: 1 } });
    expect(out.note).toContain("not tournament data");
  });

  it("is byte-identical whatever the capture order", () => {
    expect(JSON.stringify(run([...captures].reverse()))).toBe(JSON.stringify(run(captures)));
  });

  it("dates weeks from 2025-09-20 and parses window names", () => {
    expect(weekStartDate(0)).toBe("2025-09-20");
    expect(weekStartDate(29)).toBe("2026-04-11");
    expect(weekEndDate(55)).toBe("2026-10-16");
    expect(parseWindowId("swustats-premier-w43-55.json")).toEqual({ id: "w43-55", startWeek: 43, endWeek: 55 });
    expect(() => parseWindowId("other.json")).toThrow();
  });

  it("refuses an unknown cardUid", () => {
    expect(() => run([{ file: "swustats-premier-w0-1.json", sha256: "c".repeat(64), rows: [{ cardUid: "99", timesIncluded: 1, timesIncludedInWins: 0 }] }])).toThrow(/99/);
  });
});
