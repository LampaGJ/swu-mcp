import { describe, expect, it } from "vitest";
import { coverCombos, coverPenalty, makeBestCover, rankCovers } from "../../src/synergy/cover.js";
import { mk } from "./fixtures.js";

const leaders = [
  mk("L1", "Leader One", { type: "Leader", icons: ["Command", "Heroism"] }),
  mk("L2", "Leader Two", { type: "Leader", icons: ["Aggression", "Villainy"] }),
  mk("L3", "Leader Three", { type: "Leader", icons: ["Aggression", "Villainy"] }),
];
const bases = [mk("B1", "Base Green", { type: "Base", icons: ["Command"] }), mk("B2", "Base Neutral", { type: "Base", icons: [] })];
const combos = coverCombos([...leaders, ...bases]);

describe("coverCombos", () => {
  it("takes the distinct leader and base icon sets present in the data", () => {
    expect(combos.map((c) => c.label)).toEqual([
      "leader Aggression+Villainy / base neutral",
      "leader Aggression+Villainy / base Command",
      "leader Command+Heroism / base neutral",
      "leader Command+Heroism / base Command",
    ]);
  });
});

describe("coverPenalty", () => {
  it("charges 2 per uncovered icon", () => {
    const card = mk("C", "Card", { icons: ["Aggression"] });
    expect(coverPenalty([card], ["Command", "Heroism"], ["Command"]).penalty).toBe(2);
    expect(coverPenalty([card], ["Aggression", "Villainy"], []).penalty).toBe(0);
  });

  it("needs a second icon for a doubled aspect", () => {
    const double = mk("D", "Double", { icons: ["Command", "Command"] });
    expect(coverPenalty([double], ["Command", "Heroism"], []).penalty).toBe(2);
    expect(coverPenalty([double], ["Command", "Heroism"], ["Command"]).penalty).toBe(0);
    expect(coverPenalty([double], [], []).penalty).toBe(4);
  });

  it("sums per card and lists what is uncovered", () => {
    const a = mk("A", "A", { icons: ["Aggression"] });
    const b = mk("B", "B", { icons: ["Command", "Cunning"] });
    const r = coverPenalty([a, b], ["Command", "Heroism"], []);
    expect(r.penalty).toBe(4);
    expect(r.uncovered).toEqual([
      { cardKey: "A", icons: ["Aggression"], penalty: 2 },
      { cardKey: "B", icons: ["Cunning"], penalty: 2 },
    ]);
  });

  it("charges nothing for a neutral card", () => {
    expect(coverPenalty([mk("N", "N", { icons: [] })], [], []).penalty).toBe(0);
  });
});

describe("rankCovers", () => {
  it("lists the cheapest combination first and breaks ties by label", () => {
    const card = mk("C", "Card", { icons: ["Command"] });
    const ranked = rankCovers([card], combos);
    expect(ranked.map((r) => r.penalty)).toEqual([0, 0, 0, 2]);
    expect(ranked.map((r) => r.label)).toEqual([
      "leader Aggression+Villainy / base Command",
      "leader Command+Heroism / base Command",
      "leader Command+Heroism / base neutral",
      "leader Aggression+Villainy / base neutral",
    ]);
  });

  it("agrees with the memoised best cover", () => {
    const cards = [mk("X", "X", { icons: ["Aggression"] }), mk("Y", "Y", { icons: ["Command"] })];
    const best = makeBestCover(combos)(cards);
    expect(best).toEqual({ penalty: rankCovers(cards, combos)[0].penalty, label: rankCovers(cards, combos)[0].label });
  });
});
