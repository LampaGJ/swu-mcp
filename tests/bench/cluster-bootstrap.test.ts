import { describe, expect, it } from "vitest";
import { bootstrapCI, clusterBootstrapMean, mean } from "../../scripts/bench/stats.js";

describe("card-clustered bootstrap", () => {
  // One hub card in 60 pairs with a high value; 20 other pairs among distinct cards with a low one.
  const values: number[] = [];
  const cards: [string, string][] = [];
  for (let i = 0; i < 60; i++) {
    values.push(1 + (i % 3) * 0.01);
    cards.push(["hub", `h${i}`]);
  }
  for (let i = 0; i < 20; i++) {
    values.push(0);
    cards.push([`x${i}`, `y${i}`]);
  }

  it("has the plain mean as its point estimate and is seeded", () => {
    const a = clusterBootstrapMean(values, cards, { iterations: 300, seed: "s" });
    const b = clusterBootstrapMean(values, cards, { iterations: 300, seed: "s" });
    expect(a).toEqual(b);
    expect(a.value).toBeCloseTo(mean(values), 4);
    expect(a.n).toBe(80);
    expect(a.cards).toBe(101);
  });

  it("gives a wider interval than resampling pairs when one hub card carries most pairs", () => {
    const pairCI = bootstrapCI(values, mean, { iterations: 300, seed: "s" });
    const cardCI = clusterBootstrapMean(values, cards, { iterations: 300, seed: "s" });
    const width = (ci: { low: number | null; high: number | null }) => (ci.high as number) - (ci.low as number);
    expect(width(cardCI)).toBeGreaterThan(2 * width(pairCI));
  });

  it("returns an empty interval for no values", () => {
    expect(clusterBootstrapMean([], [], { iterations: 10, seed: "s" })).toEqual({ value: null, low: null, high: null, n: 0, cards: 0 });
  });
});
