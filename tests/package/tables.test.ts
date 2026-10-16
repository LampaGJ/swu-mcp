import { describe, expect, it } from "vitest";
import { augmentCards, leanIndexRows, neighbourRows, reasonIds, trioRows } from "../../src/package/tables.js";
import type { TrioRecord } from "../../src/synergy/schema.js";

const trio = (cardA: string, shape: TrioRecord["shape"], totalCost: number, score: number): TrioRecord => ({
  cardA,
  cardB: "b",
  cardC: "c",
  shape,
  totalCost,
  allCostLe3: false,
  aspectPair: "x",
  penalty: 0,
  reasons: "A -> B: row-one (offers:x -> wants:y); row-two (offers:z -> wants:w) | B -> C: row-three (offers:q -> wants:r)",
  score,
});

describe("augmentCards", () => {
  const cards = [
    { cardKey: "1", title: "A", cardUid: "u1", artFront: "a.png" },
    { cardKey: "2", title: "B", cardUid: "u2", artFront: "b.png" },
  ];
  const scores = new Map([["1", { total: 1.23456, playCalibrated: -0.004 }]]);
  const clusters = new Map([["1", 7]]);

  it("appends the three columns rounded to two decimals and drops the lean columns", () => {
    const [first, second] = augmentCards(cards, scores, clusters, true);
    expect(first).toEqual({ cardKey: "1", title: "A", artFront: "a.png", playCalibrated: -0, total: 1.23, cluster: 7 });
    expect(second).toEqual({ cardKey: "2", title: "B", artFront: "b.png", playCalibrated: null, total: null, cluster: null });
  });

  it("keeps every source column when not lean", () => {
    expect(Object.keys(augmentCards(cards, scores, clusters, false)[0])).toEqual(["cardKey", "title", "cardUid", "artFront", "playCalibrated", "total", "cluster"]);
  });
});

describe("table packing", () => {
  it("drops the definition column from an index", () => {
    expect(leanIndexRows([{ value: "Grit", cards: 3, definition: "text", cardKeys: "1|2" }])).toEqual([{ value: "Grit", cards: 3, cardKeys: "1|2" }]);
  });

  it("packs the best neighbours with two-decimal cosines", () => {
    const rows = neighbourRows({ b: [["x", 0.9], ["y", 0.8765]], a: [["z", 0.5]] }, 1);
    expect(rows).toEqual([
      { cardKey: "a", neighbours: "z:0.50" },
      { cardKey: "b", neighbours: "x:0.90" },
    ]);
  });

  it("reduces trio reasons to row ids per link", () => {
    expect(reasonIds(trio("a", "chain", 3, 1).reasons)).toBe("row-one,row-two | row-three");
    expect(() => reasonIds("no ids here")).toThrow(/cannot read row ids/);
  });

  it("keeps at most perShape trios per shape within the cost cap", () => {
    const rows = trioRows(
      { chain: [trio("a", "chain", 5, 3), trio("b", "chain", 10, 2), trio("c", "chain", 4, 1)], loop: [trio("d", "loop", 9, 1)] },
      1,
      9,
    );
    expect(rows.map((row) => row.cardA)).toEqual(["a", "d"]);
  });
});
