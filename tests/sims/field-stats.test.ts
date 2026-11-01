import { describe, expect, it } from "vitest";
import { bootstrapCI } from "../../scripts/bench/stats.js";
import { wilson } from "../../src/meta/stats.js";
import { pairedFieldDifference, stratifiedEstimate, type PairedStratum, type StratumResult } from "../../src/sims/field-stats.js";

const stratum = (id: string, weight: number, wins: number, losses: number, extra: Partial<StratumResult> = {}): StratumResult => ({
  id,
  weight,
  wins,
  losses,
  draws: 0,
  errors: 0,
  ...extra,
});

describe("stratified field estimate", () => {
  it("reproduces bootstrapCI exactly for a single stratum", () => {
    const outcomes = [...Array<number>(37).fill(1), ...Array<number>(63).fill(0)];
    const expected = bootstrapCI(outcomes, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length, { iterations: 500, seed: "same" });
    const got = stratifiedEstimate([stratum("only", 1, 37, 63)], { iterations: 500, seed: "same" });
    expect(got.winShare).toBe(expected.value);
    expect(got.ci95).toEqual({ low: expected.low, high: expected.high });
  });

  it("is the share-weighted mean of the strata, with weights renormalised", () => {
    const got = stratifiedEstimate([stratum("a", 0.6, 60, 40), stratum("b", 0.3, 30, 70), stratum("rest", 0.1, 50, 50)], { seed: "mean" });
    expect(got.winShare).toBeCloseTo(0.6 * 0.6 + 0.3 * 0.3 + 0.1 * 0.5, 4);
    const half = stratifiedEstimate([stratum("a", 3, 60, 40), stratum("b", 1.5, 30, 70), stratum("rest", 0.5, 50, 50)], { seed: "mean" });
    expect(half.winShare).toBe(got.winShare);
    expect(got.n).toBe(300);
    expect(got.coverage).toBe(1);
  });

  it("gives each stratum a Wilson interval with draws left out", () => {
    const got = stratifiedEstimate([stratum("a", 1, 50, 50, { draws: 12, errors: 3 })], { seed: "w" });
    expect(got.strata[0]).toMatchObject({ id: "a", n: 100, draws: 12, errors: 3, winShare: 0.5, wilson95: wilson(50, 100) });
    const w = got.strata[0].wilson95;
    expect((w?.high ?? 0) - (w?.low ?? 1)).toBeLessThan(0.2);
  });

  it("brackets the weighted mean and is narrower than the widest stratum interval", () => {
    const got = stratifiedEstimate([stratum("a", 0.5, 50, 50), stratum("b", 0.3, 40, 60), stratum("rest", 0.2, 60, 40)], { seed: "ci" });
    expect(got.ci95.low as number).toBeLessThan(got.winShare as number);
    expect(got.ci95.high as number).toBeGreaterThan(got.winShare as number);
    expect((got.ci95.high as number) - (got.ci95.low as number)).toBeLessThan(0.15);
  });

  it("is deterministic in its seed", () => {
    const strata = [stratum("a", 0.5, 31, 69), stratum("b", 0.5, 66, 34)];
    const run = (seed: string) => stratifiedEstimate(strata, { seed, iterations: 25 });
    expect(run("x")).toEqual(run("x"));
    expect(JSON.stringify(["a", "b", "c", "d"].map((s) => run(s).ci95))).not.toBe(JSON.stringify(["a", "a", "a", "a"].map((s) => run(s).ci95)));
  });

  it("names a stratum with no decisive game and reports the field weight it leaves out", () => {
    const got = stratifiedEstimate([stratum("a", 0.7, 7, 3), stratum("b", 0.3, 0, 0, { errors: 9 })], { seed: "gap" });
    expect(got.empty).toEqual(["b"]);
    expect(got.coverage).toBeCloseTo(0.7, 4);
    expect(got.winShare).toBeCloseTo(0.7, 4);
    expect(got.strata[1]).toMatchObject({ winShare: null, wilson95: null, errors: 9 });
  });

  it("returns nulls when no stratum has a decisive game", () => {
    const got = stratifiedEstimate([stratum("a", 1, 0, 0)], { seed: "none" });
    expect(got).toMatchObject({ winShare: null, ci95: { low: null, high: null }, coverage: 0, n: 0 });
  });
});

const paired = (id: string, weight: number, deckOnly: number, variantOnly: number, same: number): PairedStratum => ({ id, weight, deckOnly, variantOnly, same });

describe("paired field difference (deck minus variant)", () => {
  it("is the share-weighted mean of the per-stratum paired differences, with weights renormalised", () => {
    const one = pairedFieldDifference([paired("a", 1, 30, 10, 60)], { seed: "s" });
    expect(one.difference).toBe(0.2);
    expect(one.pairs).toBe(100);
    expect(one.ci95.low as number).toBeLessThan(0.2);
    expect(one.ci95.high as number).toBeGreaterThan(0.2);
    const two = pairedFieldDifference([paired("a", 3, 20, 0, 80), paired("b", 1, 0, 40, 60)], { seed: "s" });
    expect(two.difference).toBeCloseTo((3 * 0.2 + 1 * -0.4) / 4, 4);
    const unnormalised = pairedFieldDifference([paired("a", 0.3, 20, 0, 80), paired("b", 0.1, 0, 40, 60)], { seed: "s" });
    expect(unnormalised.difference).toBe(two.difference);
  });

  it("is deterministic in its seed and brackets zero when the decks are alike", () => {
    const strata = [paired("a", 1, 12, 11, 77), paired("b", 1, 9, 10, 81)];
    expect(pairedFieldDifference(strata, { seed: "x" })).toEqual(pairedFieldDifference(strata, { seed: "x" }));
    const r = pairedFieldDifference(strata, { seed: "x" });
    expect(r.ci95.low as number).toBeLessThan(0);
    expect(r.ci95.high as number).toBeGreaterThan(0);
  });

  it("gives a degenerate interval when every pair is the same and names a stratum with no pair", () => {
    const r = pairedFieldDifference([paired("a", 1, 0, 0, 50), paired("empty", 1, 0, 0, 0)], { seed: "s" });
    expect(r.difference).toBe(0);
    expect(r.ci95).toEqual({ low: 0, high: 0 });
    expect(r.empty).toEqual(["empty"]);
    expect(r.coverage).toBe(0.5);
    expect(r.strata.map((x) => x.difference)).toEqual([0, null]);
  });

  it("returns nulls when no stratum has a pair where both decks were decisive", () => {
    const r = pairedFieldDifference([paired("a", 1, 0, 0, 0)], { seed: "s" });
    expect(r).toMatchObject({ difference: null, ci95: { low: null, high: null }, pairs: 0, coverage: 0 });
  });
});
