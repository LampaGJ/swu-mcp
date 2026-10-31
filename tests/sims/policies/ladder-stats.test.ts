import { describe, expect, it } from "vitest";
import { pairedDeckTest, signTest, summarizeLadder, type LadderPair } from "../../../src/sims/policies/ladder-stats.js";

const pair = (deck1: string, deck2: string, a: 1 | 2 | null, b: 1 | 2 | null, seed = 1): LadderPair => ({
  seed,
  deck1,
  deck2,
  a: { winner: a, endCondition: a === null ? "timeout" : "base_destroyed" },
  b: { winner: b, endCondition: b === null ? "timeout" : "base_destroyed" },
});

describe("ladder statistics", () => {
  it("computes the exact two-sided sign test", () => {
    expect(signTest(0, 10)).toBeCloseTo(2 / 1024, 10);
    expect(signTest(5, 10)).toBe(1);
    expect(signTest(0, 0)).toBe(1);
    expect(signTest(30, 30)).toBeCloseTo(2 * 0.5 ** 30, 15);
  });

  it("scores duplicate pairs: candidate wins seat 1 of a and seat 2 of b", () => {
    const decks = ["A", "B"];
    const pairs = Array.from({ length: 20 }, (_, i) => pair(decks[i % 2], decks[(i + 1) % 2], 1, 2, i));
    const s = summarizeLadder(pairs, decks);
    expect(s.discordant).toMatchObject({ candidate2to0: 20, baseline2to0: 0 });
    expect(s.pooled).toMatchObject({ wins: 40, n: 40, share: 1 });
    expect(s.pass).toBe(true);
  });

  it("fails the pass rule when a deck's interval lies wholly below 50%", () => {
    const decks = ["A", "B"];
    const good = Array.from({ length: 30 }, (_, i) => pair("A", "A", 1, 2, i));
    const bad = Array.from({ length: 30 }, (_, i) => pair("B", "B", 2, 1, 100 + i));
    const s = summarizeLadder([...good, ...bad], decks);
    expect(s.passDetail.decksWhollyBelow).toBe(1);
    expect(s.pass).toBe(false);
  });

  it("leaves non-decisive games out of shares and budgets games at ceil(93 / (1 - d))", () => {
    const s = summarizeLadder([pair("A", "A", null, 2), pair("A", "A", 1, 1)], ["A"]);
    expect(s.nonDecisive).toBe(1);
    expect(s.pooled.n).toBe(3);
    expect(s.budgetGames).toBe(Math.ceil(93 / 0.75));
    expect(s.discordant.candidate2to0 + s.discordant.baseline2to0).toBe(0);
  });

  it("pairs two decks on the same seeds and tests the seeds where only one won", () => {
    expect(pairedDeckTest([true, true, false, null], [false, true, false, true])).toEqual({ baseOnly: 1, variantOnly: 0, pValue: 1 });
  });
});
