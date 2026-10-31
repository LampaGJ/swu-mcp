import { describe, expect, it } from "vitest";
import { seededRandom } from "../../scripts/bench/stats.js";
import { BOT_SCHEME, DecisionRandom, botDraw } from "../../src/sims/rng.js";

describe("sha256-counter-v1 decision randomness", () => {
  it("is the documented formula over the shared sha256-to-mulberry32 helper", () => {
    expect(BOT_SCHEME).toBe("sha256-counter-v1");
    expect(botDraw("7", 2, 41, 0)).toBe(seededRandom("bot|7|2|41|0")());
    expect(botDraw("7", 1, 0, 3)).toBe(seededRandom("bot|7|1|0|3")());
  });

  it("numbers draws j within one decision and counts them", () => {
    const r = new DecisionRandom("s", 1, 5);
    const a = r.next();
    const b = r.next();
    expect([a, b]).toEqual([botDraw("s", 1, 5, 0), botDraw("s", 1, 5, 1)]);
    expect(r.draws).toBe(2);
  });

  it("is stateless: decisions before a branch at k never move, whatever happens at or after k", () => {
    const stream = (choicesAtK: number) => {
      const out: number[] = [];
      for (let k = 0; k < 10; k++) {
        const r = new DecisionRandom("42", ((k % 2) + 1) as 1 | 2, k);
        const n = k === 6 ? choicesAtK : 1;
        for (let j = 0; j < n; j++) out.push(r.next());
      }
      return out;
    };
    const a = stream(1);
    const b = stream(3);
    expect(b.slice(0, 6)).toEqual(a.slice(0, 6));
    expect(b.slice(9)).toEqual(a.slice(7));
  });

  it("separates seats and seeds", () => {
    expect(botDraw("1", 1, 0, 0)).not.toBe(botDraw("1", 2, 0, 0));
    expect(botDraw("1", 1, 0, 0)).not.toBe(botDraw("2", 1, 0, 0));
    for (let k = 0; k < 50; k++) {
      const u = botDraw("x", 1, k, 0);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});
