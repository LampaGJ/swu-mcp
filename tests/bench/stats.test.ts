import { describe, expect, it } from "vitest";
import { bootstrapCI, logLift, mannWhitney, mean, median, mhRiskDifference, normalCdf, seededRandom } from "../../scripts/bench/stats.js";

describe("lift", () => {
  it("is 1 (log 0) under independence and grows with co-occurrence", () => {
    expect(logLift(25, 50, 50, 100, 0)).toBeCloseTo(0, 12);
    expect(logLift(50, 50, 50, 100, 0)).toBeCloseTo(Math.log(2), 12);
    expect(logLift(0, 50, 50, 100)).toBeLessThan(0);
  });

  it("shrinks toward 0 when the expected count is tiny, instead of exploding", () => {
    expect(logLift(0, 1, 1, 1000)).toBeCloseTo(Math.log(0.5 / (1 / 1000 + 0.5)), 12);
    expect(Math.abs(logLift(0, 1, 1, 1000))).toBeLessThan(0.01);
    expect(logLift(1, 1, 1, 1000)).toBeCloseTo(Math.log(1.5 / 0.501), 12);
  });
});

describe("summary statistics", () => {
  it("mean and median", () => {
    expect(mean([1, 2, 3, 10])).toBe(4);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("normal cdf matches known quantiles", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 5);
  });
});

describe("seeded bootstrap", () => {
  const values = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 3 + (i % 7));

  it("same seed, same interval; other seed, other interval", () => {
    const a = bootstrapCI(values, mean, { iterations: 500, seed: "s1" });
    const b = bootstrapCI(values, mean, { iterations: 500, seed: "s1" });
    const c = bootstrapCI(values, mean, { iterations: 500, seed: "s2" });
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
    expect(a.low).toBeLessThanOrEqual(a.value as number);
    expect(a.high).toBeGreaterThanOrEqual(a.value as number);
  });

  it("random stream is deterministic in [0, 1)", () => {
    const r1 = seededRandom("x");
    const r2 = seededRandom("x");
    const xs = Array.from({ length: 5 }, () => r1());
    expect(xs).toEqual(Array.from({ length: 5 }, () => r2()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("empty input has no interval", () => {
    expect(bootstrapCI([], mean, { iterations: 10, seed: "e" })).toEqual({ value: null, low: null, high: null, n: 0 });
  });
});

describe("Mann-Whitney U and AUC", () => {
  it("separated samples give AUC 1 / 0", () => {
    expect(mannWhitney([4, 5, 6], [1, 2, 3]).auc).toBe(1);
    expect(mannWhitney([1, 2, 3], [4, 5, 6]).auc).toBe(0);
    expect(mannWhitney([1, 2, 3], [4, 5, 6]).rankBiserial).toBe(-1);
  });

  it("ties count half", () => {
    const r = mannWhitney([1, 2], [2, 3]);
    expect(r.u).toBe(0.5);
    expect(r.auc).toBe(0.125);
  });

  it("identical samples give AUC 0.5 and p 1", () => {
    const r = mannWhitney([1, 2, 3, 4], [1, 2, 3, 4]);
    expect(r.auc).toBe(0.5);
    expect(r.p).toBeCloseTo(1, 6);
  });

  it("large shifted samples are significant", () => {
    const x = Array.from({ length: 60 }, (_, i) => i + 20);
    const y = Array.from({ length: 60 }, (_, i) => i);
    expect(mannWhitney(x, y).p).toBeLessThan(0.001);
  });
});

describe("Mantel-Haenszel risk difference", () => {
  it("one stratum reduces to the plain difference", () => {
    expect(mhRiskDifference([{ a: 6, n1: 10, c: 4, n0: 10 }]).rd).toBeCloseTo(0.2, 12);
  });

  it("removes a confounder that a pooled difference keeps", () => {
    const strata = [
      { a: 9, n1: 10, c: 45, n0: 50 },
      { a: 10, n1: 50, c: 2, n0: 10 },
    ];
    expect(mhRiskDifference(strata).rd).toBeCloseTo(0, 12);
  });
});
