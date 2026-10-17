import { describe, expect, it } from "vitest";
import {
  Bits,
  coverFree,
  groupOE,
  inPlayEvents,
  matchedPartners,
  pairLift,
  pairWin,
  Population,
  trioOE,
  type Unit,
} from "../../scripts/bench/measures.js";

const icons = new Map<string, string[]>([
  ["A", ["Command"]],
  ["B", ["Command"]],
  ["C", ["Aggression"]],
  ["D", ["Command", "Command"]],
]);
const iconsOf = (k: string): readonly string[] => icons.get(k) ?? [];

const unit = (cards: string[], over: Partial<Unit> = {}): Unit => ({
  cards: new Set(cards),
  icons: ["Command", "Heroism"],
  leader: "L1",
  base: null,
  won: null,
  ...over,
});

describe("bits", () => {
  it("counts, intersects and iterates", () => {
    const a = Bits.from(70, [0, 5, 64, 69]);
    const b = Bits.from(70, [5, 64, 10]);
    expect(a.count()).toBe(4);
    expect(a.andCount(b)).toBe(2);
    expect([...a.and(b).indices()]).toEqual([5, 64]);
    expect(a.or(b).count()).toBe(5);
  });
});

describe("aspect cover", () => {
  it("duplicated icons need two sources", () => {
    expect(coverFree(["Command"], ["Command", "Heroism"])).toBe(true);
    expect(coverFree(["Command", "Command"], ["Command", "Heroism"])).toBe(false);
    expect(coverFree([], [])).toBe(true);
  });
});

describe("pair lift", () => {
  const units = [
    unit(["A", "B"]),
    unit(["A", "B"]),
    unit(["A"]),
    unit(["B"]),
    unit(["C"], { icons: ["Aggression", "Villainy"] }),
    unit(["C"], { icons: ["Aggression", "Villainy"] }),
  ];
  const pop = new Population(units, iconsOf);

  it("unconditioned lift uses every unit", () => {
    const l = pairLift(pop, "A", "B", { conditioned: false });
    expect([l.n, l.nA, l.nB, l.nAB]).toEqual([6, 3, 3, 2]);
    expect(l.lift).toBeCloseTo((2 * 6) / 9, 12);
  });

  it("conditioned lift drops units that could not play both without penalty", () => {
    const l = pairLift(pop, "A", "B", { conditioned: true });
    expect([l.n, l.nA, l.nB, l.nAB]).toEqual([4, 3, 3, 2]);
  });

  it("a card never included leaves the pair unmeasured", () => {
    expect(pairLift(pop, "A", "D", { conditioned: false }).logLift).toBeNull();
  });
});

describe("matched baseline", () => {
  it("draws a partner from the same stratum, never the original partner, deterministically", () => {
    const strata = new Map([
      ["B", "s1"],
      ["X", "s1"],
      ["Y", "s1"],
      ["A", "s2"],
    ]);
    const pool = new Map([["s1", ["B", "X", "Y"]]]);
    const pairs = [{ a: "A", b: "B", id: "p1" }];
    const one = matchedPartners(pairs, strata, pool, new Set(["A\u0000B"]), "seed");
    const two = matchedPartners(pairs, strata, pool, new Set(["A\u0000B"]), "seed");
    expect(one).toEqual(two);
    expect(["X", "Y"]).toContain(one.get("p1"));
  });
});

describe("in-game interaction and win rate", () => {
  const units: Unit[] = [
    unit(["A", "B"], { won: 1, co: new Set(["A\u0000B"]), played: new Set(["B"]), leader: "L1" }),
    unit(["A", "B"], { won: 1, co: new Set(), played: new Set(["A"]), leader: "L1", base: "B" }),
    unit(["A"], { won: 0, leader: "L1" }),
    unit(["B"], { won: 0, leader: "L2" }),
    unit(["A", "B"], { won: 0, leader: "L2", co: new Set(["B\u0000A"]), played: new Set(["A"]) }),
  ];
  const pop = new Population(units, iconsOf);

  it("counts both directions of played-while-in-play, with the base as always in play", () => {
    expect(inPlayEvents(pop, "A", "B")).toEqual({ coSides: 3, aInPlayWhenBPlayed: 1, bInPlayWhenAPlayed: 2 });
  });

  it("win rates for both versus one, plus leader-stratified MH sums", () => {
    const w = pairWin(pop, "A", "B");
    expect(w.both).toEqual({ wins: 2, n: 3 });
    expect(w.one).toEqual({ wins: 0, n: 2 });
    expect(w.mh.den).toBeGreaterThan(0);
  });

  it("a unit carrying aggregated results counts every game it played", () => {
    const agg = new Population([unit(["A", "B"], { results: { wins: 3, n: 4 } }), unit(["A"], { results: { wins: 1, n: 4 } })], iconsOf);
    const w = pairWin(agg, "A", "B");
    expect(w.both).toEqual({ wins: 3, n: 4 });
    expect(w.one).toEqual({ wins: 1, n: 4 });
    expect(w.mh.num / w.mh.den).toBeCloseTo(0.5, 12);
  });

  it("a card a unit only may hold excludes that unit", () => {
    const agg = new Population([unit(["A"], { uncertain: new Set(["B"]), won: 1 }), unit(["A"], { won: 0 })], iconsOf);
    expect(pairWin(agg, "A", "B").one).toEqual({ wins: 0, n: 1 });
  });
});

describe("substitution and trios", () => {
  it("members that never share a deck have O/E 0", () => {
    const units = [unit(["A"]), unit(["B"]), unit(["A"]), unit(["B"])];
    const pop = new Population(units, iconsOf);
    expect(groupOE(pop, ["A", "B"], 1)).toEqual({ observed: 0, expected: 1, leaders: 1 });
  });

  it("trio O/E against independence within eligible units", () => {
    const units = [unit(["A", "B", "D"], { icons: ["Command", "Command"] }), unit(["A"], { icons: ["Command", "Command"] })];
    const pop = new Population(units, iconsOf);
    const t = trioOE(pop, "A", "B", "D");
    expect(t.n).toBe(2);
    expect(t.observed).toBe(1);
    expect(t.expected).toBeCloseTo(2 * 1 * 0.5 * 0.5, 12);
  });
});
