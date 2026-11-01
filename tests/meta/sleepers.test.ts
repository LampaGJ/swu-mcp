import { describe, expect, it } from "vitest";
import { analyseSleepers, DEFAULT_SLEEPER_OPTIONS, stepUpQ, twoSidedP } from "../../src/meta/sleepers.js";
import { sleeperRowSchema } from "../../src/meta/sleepers-schema.js";
import { fixture } from "./sleeper-fixtures.js";

const fast = { ...DEFAULT_SLEEPER_OPTIONS, replicates: 120, nullReplicates: 60 };

describe("false-discovery helpers", () => {
  it("BH and BY match hand-computed step-up values", () => {
    const p = [0.01, 0.04, 0.03, 0.5];
    expect(stepUpQ(p, "BH").map((q) => Number(q.toFixed(4)))).toEqual([0.04, 0.0533, 0.0533, 0.5]);
    const c = 1 + 1 / 2 + 1 / 3 + 1 / 4;
    expect(stepUpQ(p, "BY")[0]).toBeCloseTo(0.04 * c, 10);
    expect(stepUpQ([], "BH")).toEqual([]);
  });

  it("two-sided p is 0.05 at z = 1.96 and keeps digits far out", () => {
    expect(twoSidedP(1.959964)).toBeCloseTo(0.05, 5);
    expect(twoSidedP(0)).toBeCloseTo(1, 6);
    expect(twoSidedP(6)).toBeGreaterThan(0);
    expect(twoSidedP(6)).toBeLessThan(1e-8);
  });
});

describe("analyseSleepers on planted effects", () => {
  const decks = fixture({
    good: { boost: 0.12, rate: 0.25 },
    staple: { boost: 0.05, rate: 0.8 },
    skilled: { skillBoost: 0.2, rate: 0.4 },
    picked: { rate: 0.3, skillPick: 0.3 },
    bad: { boost: -0.1, rate: 0.4 },
    n1: { rate: 0.3 },
    n2: { rate: 0.5 },
    n3: { rate: 0.2 },
  });
  const out = analyseSleepers(decks, fast);
  const row = (k: string) => out.global.find((r) => r.cardKey === k);

  it("every row parses against the data-product schema", () => {
    for (const r of out.global) sleeperRowSchema.parse(r);
  });

  it("finds the underplayed winner as a sleeper and the common winner as proven", () => {
    expect(row("good")?.verdict).toBe("sleeper");
    expect(row("good")?.gap.low).toBeGreaterThan(0);
    expect(row("staple")?.playRate).toBeGreaterThan(0.5);
    expect(row("bad")?.verdict).toBe("loses-ground");
  });

  it("flags the skill-dependent card and not the null cards", () => {
    expect(row("skilled")?.skill?.interaction.value).toBeGreaterThan(0);
    expect(row("skilled")?.skilledEdge).toBe(true);
    for (const k of ["n1", "n2", "n3"]) expect(row(k)?.verdict).toBe("no-clear-effect");
  });

  it("separates selection from effect: a card strong players pick shows a gap that vanishes within player", () => {
    const r = row("picked");
    expect(r?.gap.value).toBeGreaterThan(0);
    expect(r?.withinPlayer).not.toBeNull();
    expect(Math.abs(r?.withinPlayer?.value ?? 1)).toBeLessThan(Math.abs(r?.gap.value ?? 0));
  });

  it("recovers the true spread of player skill from cross-event covariance (no skill-linked card: 0.08 / sqrt 3 = 0.046)", () => {
    const plain = analyseSleepers(fixture({ n1: { rate: 0.3 }, n2: { rate: 0.5 } }, "skill-spread"), fast);
    expect(plain.skill.betweenPlayerSd).toBeGreaterThan(0.03);
    expect(plain.skill.betweenPlayerSd).toBeLessThan(0.065);
    expect(plain.skill.tierCuts[0]).toBeLessThan(0);
    expect(plain.skill.tierCuts[1]).toBeGreaterThan(0);
  });

  it("the label-shuffle null passes nothing through BY", () => {
    expect(out.nullCheck.rows).toBeGreaterThan(0);
    expect(out.nullCheck.passBY).toBe(0);
  });

  it("is deterministic: the same input gives the same output", () => {
    expect(JSON.stringify(analyseSleepers(decks, fast))).toBe(JSON.stringify(out));
  });

  it("writes per-leader rows and counts players without exposing them", () => {
    expect(out.archetypes.map((a) => a.key)).toEqual(["L1|Vigilance", "L2|Vigilance"]);
    expect(JSON.stringify(out)).not.toMatch(/"p\d+"/);
    expect(out.counts.players).toBeGreaterThan(100);
  });
});

describe("an all-null fixture", () => {
  it("passes no card through BY at q = 0.1", () => {
    const plants = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`c${i}`, { rate: 0.2 + (i % 5) * 0.1 }]));
    const out = analyseSleepers(fixture(plants, "null-fixture"), fast);
    expect(out.global.length).toBe(30);
    expect(out.global.filter((r) => r.gap.qBY <= 0.1).length).toBe(0);
  });
});
