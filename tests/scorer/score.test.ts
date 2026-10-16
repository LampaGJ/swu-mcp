import { describe, expect, it } from "vitest";
import { buildFeatureRun } from "../../src/ability-grammar/index.js";
import { coefficientsSchema, type Coefficients } from "../../src/scorer/coefficients.js";
import { cardFeatureValues, type ScorerCard } from "../../src/scorer/features.js";
import { firstCurrentSet } from "../../src/scorer/inputs.js";
import { playabilityT, scoreCard } from "../../src/scorer/score.js";

const EMPTY_TABLE = JSON.stringify({ schemaVersion: 1, tableVersion: 1, entries: [] });
const sha = "0".repeat(64);
const t = (b: number, support = 10) => ({ b, se: 0.1, support });

// Round numbers so every expected value below can be checked by hand.
const COEFFICIENTS: Coefficients = coefficientsSchema.parse({
  schemaVersion: 1,
  rubricVersion: "test",
  source: {
    rubricDoc: "test",
    scriptSha256: sha,
    featuresModuleSha256: sha,
    featuresJsonSha256: sha,
    cardsToonSha256: sha,
    featuresReplayInputHash: sha,
    swuStatsCapture: "test",
    swuStatsCaptureSha256: sha,
  },
  vanilla: {
    n: 10,
    power: { intercept: 1, cost: 1, space: -0.5, unique: 0 },
    hp: { intercept: 1, cost: 1, space: 0, unique: 1.5 },
  },
  designer: {
    powerWeight: 1.17,
    hpWeight: 1,
    fittedPowerHpRatio: 1.1,
    statPointsPerResource: 2,
    unit: {
      dependent: "statSurplus",
      n: 10,
      r2: 0.5,
      intercept: t(0.5),
      terms: { "kw:Ambush": t(-1), line: t(-0.5), aspects: t(0.25), "fx:damage": t(-0.1) },
    },
    event: { dependent: "cost", n: 10, r2: 0.5, intercept: t(3), terms: { "fx:damage": t(0.5) } },
    upgrade: { dependent: "cost", n: 10, r2: 0.5, intercept: t(1), terms: { upgradeStats: t(0.25) } },
    leader: { dependent: "leaderUnitStats", n: 10, r2: 0.5, intercept: t(2), terms: { cost: t(1.5), space: t(-1) } },
    base: { dependent: "baseHp", n: 10, r2: 0.5, intercept: t(30), terms: { hasAbility: t(-3) } },
  },
  play: {
    window: "test",
    games: 1000,
    n: 100,
    r2: 0.3,
    perStatPoint: 0.2,
    terms: { powerSurplus: t(0.25), hpSurplus: t(0.1), "kw:Ambush": t(1.5), unique: t(1) },
    cost: { fitted: { "5": t(-0.4), "6": t(-0.8) }, applied: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": -0.4, "6": -0.8, "7": -0.85 }, appliedFrom: 5 },
    heldOutSpearman: [],
  },
});

function make(row: Record<string, unknown>, set: string | null = "JTL"): ScorerCard {
  const input = { cardKey: "99990001", title: "Test Card", type: "Unit", aspects: "Vigilance", arenas: "Ground", unique: false, ...row };
  const features = buildFeatureRun([input], EMPTY_TABLE, "test").result.cards[0];
  return { features, set };
}

describe("unit scoring against hand-computed values", () => {
  it("a vanilla unit on the curve has zero stat surplus and no keyword or effect points", () => {
    // Curve at cost 3, ground, not unique: power 1+3 = 4, HP 1+3 = 4, so 4/4 is exactly on it.
    const s = scoreCard(make({ cost: 3, power: 4, hp: 4 }), COEFFICIENTS);
    expect(s.components.expectedStats).toBeCloseTo(8);
    expect(s.components.statSurplus).toBeCloseTo(0);
    expect(s.components.keywordPoints).toBe(0);
    expect(s.components.effectPoints).toBe(0);
    // Only the model baseline remains: minus the 0.5 intercept.
    expect(s.efficiency).toBeCloseTo(-0.5);
  });

  it("weights power above HP when scoring surplus", () => {
    // 5/3 at cost 3: power +1 (x1.17), HP -1 (x1.0).
    const s = scoreCard(make({ cost: 3, power: 5, hp: 3 }), COEFFICIENTS);
    expect(s.components.statSurplus).toBeCloseTo(0.17);
  });

  it("charges a space unit the space power discount and a unique unit the HP bonus", () => {
    const space = scoreCard(make({ cost: 3, power: 3.5, hp: 4, arenas: "Space" }), COEFFICIENTS);
    expect(space.components.expectedStats).toBeCloseTo(7.5);
    expect(space.components.statSurplus).toBeCloseTo(0);
    const unique = scoreCard(make({ cost: 3, power: 4, hp: 5.5, unique: true }), COEFFICIENTS);
    expect(unique.components.statSurplus).toBeCloseTo(0);
  });

  it("gives a keyword card its keyword points, which offset the stats designers removed", () => {
    // Ambush priced at 1 stat point: a 4/3 Ambush unit is 1 HP short of the curve and earns it back.
    const s = scoreCard(make({ cost: 3, power: 4, hp: 3, text: "Ambush", keywords: "Ambush" }), COEFFICIENTS);
    expect(s.components.statSurplus).toBeCloseTo(-1);
    expect(s.components.keywordPoints).toBeCloseTo(1);
    expect(s.efficiency).toBeCloseTo(-0.5);
  });

  it("prices an ability line and an effect magnitude from the committed coefficients", () => {
    const s = scoreCard(make({ cost: 3, power: 4, hp: 4, text: "When Played: Deal 2 damage to an enemy unit." }), COEFFICIENTS);
    // line: -(-0.5 x 1) = 0.5; damage 2: -(-0.1 x 2) = 0.2.
    expect(s.components.effectPoints).toBeCloseTo(0.7);
    expect(s.terms.map((x) => x.term)).toEqual(expect.arrayContaining(["line", "fx:damage"]));
  });

  it("deducts the designer allowance for extra aspect icons", () => {
    const s = scoreCard(make({ cost: 3, power: 4, hp: 4, aspects: "Vigilance|Villainy" }), COEFFICIENTS);
    // baseline -0.5 (minus the 0.5 intercept) plus -0.25 for the one extra icon.
    expect(s.components.modifiers).toBeCloseTo(-0.75);
  });
});

describe("events, upgrades, leaders and bases", () => {
  it("scores an event as stat points for the cost below the model's baseline price plus priced effects", () => {
    const s = scoreCard(make({ type: "Event", cost: 2, text: "Deal 2 damage to a unit." }), COEFFICIENTS);
    expect(s.model).toBe("event");
    expect(s.components.costTerm).toBeCloseTo(2 * (3 - 2));
    expect(s.components.effectPoints).toBeCloseTo(2 * 0.5 * 2);
    expect(s.components.statSurplus).toBe(0);
  });

  it("values an upgrade's stats at the fitted price", () => {
    const s = scoreCard(make({ type: "Upgrade", cost: 2, upgradePower: 2, upgradeHp: 2 }), COEFFICIENTS);
    expect(s.components.statSurplus).toBeCloseTo(2 * 0.25 * 4);
    expect(s.components.costTerm).toBeCloseTo(2 * (1 - 2));
  });

  it("scores a leader against its deploy-threshold curve and a base against the no-ability HP", () => {
    const leader = scoreCard(make({ type: "Leader", cost: 6, power: 4, hp: 8 }), COEFFICIENTS);
    expect(leader.components.expectedStats).toBeCloseTo(2 + 1.5 * 6);
    expect(leader.components.statSurplus).toBeCloseTo(12 - 11);
    expect(leader.playCalibrated).toBeNull();
    const base = scoreCard(make({ type: "Base", hp: 27, text: "Epic Action: Heal 2 damage from a unit." }), COEFFICIENTS);
    expect(base.components.statSurplus).toBeCloseTo(-3);
    expect(base.components.effectPoints).toBeCloseTo(3);
  });
});

describe("play calibration and T(cost)", () => {
  it("applies the table, clamping costs above its top key", () => {
    expect(playabilityT(COEFFICIENTS, 2)).toBe(0);
    expect(playabilityT(COEFFICIENTS, 5)).toBe(-0.4);
    expect(playabilityT(COEFFICIENTS, 9)).toBe(-0.85);
  });

  it("sums fitted terms on surplus and keywords, then adds T", () => {
    // 5/3 at cost 6: curve is 7/7, so power -2 and HP -4; Ambush adds 1.5; T(6) = -0.8.
    const s = scoreCard(make({ cost: 6, power: 5, hp: 3, text: "Ambush", keywords: "Ambush" }), COEFFICIENTS);
    expect(s.playCalibratedNoT).toBeCloseTo(0.25 * -2 + 0.1 * -4 + 1.5);
    expect(s.playCalibrated).toBeCloseTo((s.playCalibratedNoT ?? 0) - 0.8);
    expect(s.components.playabilityTStat).toBeCloseTo(-0.8 / 0.25);
  });
});

describe("flags and the zero rule", () => {
  it("flags an unclassified clause and lets it contribute nothing", () => {
    const text = "Zorblax the quantum frobnicator sings sideways.";
    const s = scoreCard(make({ cost: 3, power: 4, hp: 4, text }), COEFFICIENTS);
    expect(s.flags).toContain("unclassified_sentences");
    expect(s.unclassifiedClauses).toBeGreaterThan(0);
    expect(s.components.effectPoints).toBeCloseTo(0.5);
    expect(Object.keys(cardFeatureValues(make({ cost: 3, power: 4, hp: 4, text }))).filter((k) => k.startsWith("fx:"))).toEqual([]);
  });

  it("does not score token cards", () => {
    const s = scoreCard(make({ type: "Token Unit", cost: null, power: 2, hp: 2 }), COEFFICIENTS);
    expect(s.scored).toBe(false);
    expect(s.total).toBeNull();
    expect(s.flags).toContain("unscored_type");
  });

  it("marks Homeworlds cards as outside the play fit", () => {
    expect(scoreCard(make({ cost: 3, power: 4, hp: 4 }, "HMW"), COEFFICIENTS).flags).toContain("set_not_in_play_fit");
  });
});

describe("determinism and set resolution", () => {
  it("scores the same card to identical bytes twice", () => {
    const card = make({ cost: 4, power: 4, hp: 5, text: "When Played: Deal 1 damage to a unit." });
    expect(JSON.stringify(scoreCard(card, COEFFICIENTS))).toBe(JSON.stringify(scoreCard(card, COEFFICIENTS)));
  });

  it("takes the earliest current set and folds Weekly Play codes into their parent", () => {
    expect(firstCurrentSet("SOR|SHD|LOF|JTL")).toBe("JTL");
    expect(firstCurrentSet("SOR|LAWP")).toBe("LAW");
    expect(firstCurrentSet("SOR|SHD")).toBeNull();
    expect(firstCurrentSet(null)).toBeNull();
  });
});
