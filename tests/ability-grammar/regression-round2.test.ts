import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable, parseTarget } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema, type SwuCardFeatures } from "../../src/schemas/card-features.js";
import { CARDS } from "./regression-cards.js";
import { clauseWith, clausesOf, featuresOf, offerTags, wantTags, type CardSpec } from "./helpers.js";

// Golden regressions for the round-2 verification root causes (LampaGJ/swu-mcp#15, docs/verification/2026-10-17-round2.md).

const cats = (xs: readonly { cat: string }[]): string[] => xs.map((x) => x.cat);

describe("RC13 conditions are typed, not residue", () => {
  it("06010144 Tempest Assault: the you've contraction", () => {
    const clause = clauseWith(featuresOf(CARDS["06010144"]), "If you've dealt damage");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "event_this_phase", verb: "dealt" }]);
    expect(clause.effects).toMatchObject([{ cat: "damage", conditional: true }]);
  });

  it("05010163 Quinlan Vos: if this unit has 6 or more power", () => {
    const clause = clauseWith(featuresOf(CARDS["05010163"]), "If this unit has 6 or more power");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "self_state", state: "power_ge_6" }]);
    expect(clause.effects).toMatchObject([{ cat: "damage", conditional: true }]);
  });

  it("05010137 Savage Opress: if you don't", () => {
    const clause = clauseWith(featuresOf(CARDS["05010137"]), "If you don't");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "if_you_do", check: "not" }]);
    expect(clause.effects).toMatchObject([{ cat: "damage", conditional: true }]);
  });

  it("09010098 Resonate: if a friendly non-leader unit shares a Trait with a friendly leader", () => {
    const clause = clauseWith(featuresOf(CARDS["09010098"]), "shares a Trait");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([
      { cat: "target_check", check: "shares_trait", applies: { side: "friendly", kind: "unit", restrict: ["non_leader"] }, what: { side: "friendly", kind: "leader" } },
    ]);
    expect(clause.effects).toMatchObject([{ cat: "heal", conditional: true }]);
  });

  it("07010007 Boba Fett: if the defending unit was defeated, on both faces", () => {
    const hits = clausesOf(featuresOf(CARDS["07010007"])).filter((c) => c.clause.text.startsWith("If the defending unit was defeated"));
    expect(hits.map((h) => h.face)).toEqual(["text", "deployBox"]);
    for (const { clause } of hits) {
      expect(clause.residue).toEqual([]);
      expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "state", state: "defeated" }]);
      for (const e of clause.effects) expect(e.conditional).toBe(true);
    }
  });
});

describe("side from an ownership phrase", () => {
  it("08010006 Sabine Wren: the next unit you play is friendly", () => {
    const clause = clauseWith(featuresOf(CARDS["08010006"]), "The next unit you play this phase gains Shielded");
    expect(clause.effects).toMatchObject([{ cat: "grant_keyword", target: { side: "friendly", kind: "unit" } }]);
  });

  it("04010005 Admiral Piett: each Capital Ship unit you play is friendly", () => {
    const clause = clauseWith(featuresOf(CARDS["04010005"]), "Each Capital Ship unit you play");
    expect(clause.effects).toMatchObject([{ cat: "cost_reduction", applies: { side: "friendly", kind: "unit" } }]);
  });

  it("07010044 Single Reactor Ignition: its controller's base after an enemy unit is the enemy base", () => {
    const clause = clauseWith(featuresOf(CARDS["07010044"]), "its controller's base");
    expect(clause.effects).toMatchObject([{ cat: "damage", target: { side: "enemy", kind: "base" } }]);
  });

  it("05010130 HK-47: its controller's base with no referent in the clause is a reference, not any", () => {
    const clause = clauseWith(featuresOf(CARDS["05010130"]), "its controller's base");
    expect(clause.effects).toMatchObject([{ cat: "damage", target: { side: "ref", kind: "base" } }]);
  });
});

describe("RC14 a rule keeps its qualifier", () => {
  it("09010004 Grand Moff Tarkin: upgrades with Fortify you play", () => {
    const clause = clauseWith(featuresOf(CARDS["09010004"]), "upgrades with Fortify");
    expect(clause.effects).toMatchObject([{ cat: "ignore_aspect_penalty", applies: { side: "friendly", kind: "upgrade", restrict: ["keyword:Fortify"] } }]);
  });

  it("08010030 Marrok: loses Sentinel keeps the keyword and the unit", () => {
    const clause = clauseWith(featuresOf(CARDS["08010030"]), "he loses Sentinel");
    const lose = clause.effects.find((e) => e.cat === "remove_keyword");
    expect(lose).toMatchObject({ keywords: ["Sentinel"], target: { side: "self" } });
  });

  it("04010077 In the Heat of Battle: a coordinated lose keeps the shared subject and the grant", () => {
    const clause = clauseWith(featuresOf(CARDS["04010077"]), "loses Saboteur");
    expect(clause.effects).toMatchObject([
      { cat: "grant_keyword", target: { side: "any", kind: "unit", quant: "all" } },
      { cat: "remove_keyword", keywords: ["Saboteur"], target: { side: "any", kind: "unit", quant: "all" } },
    ]);
  });

  it("09010205 Intelligence Agency: look at an opponent's hand keeps the target", () => {
    const clause = clauseWith(featuresOf(CARDS["09010205"]), "Look at an opponent's hand");
    expect(clause.effects.find((e) => e.cat === "look")).toMatchObject({ target: { side: "enemy", kind: "hand" } });
  });
});

describe("single cases", () => {
  it("0301058 Padawan Starfighter: a Force unit or a Force upgrade keeps both kinds", () => {
    const clause = clauseWith(featuresOf(CARDS["0301058"]), "While you control a Force unit");
    expect(clause.conditions).toMatchObject([{ cat: "control", what: { kind: "unit", restrict: ["or_kind:upgrade", "trait:Force"] } }]);
  });

  it("keeps kind order for a compound noun phrase with no disjunction", () => {
    expect(parseTarget("a token unit").kind).toBe("token");
    expect(parseTarget("a unit or base").kind).toBe("unit_or_base");
  });

  it("04010244 There Is No Escape: can't gain abilities for this round", () => {
    const clause = clauseWith(featuresOf(CARDS["04010244"]), "can't gain abilities");
    expect(clause.residue).toEqual([]);
    expect(cats(clause.effects)).toEqual(["blank", "restriction"]);
    expect(clause.effects[1]).toMatchObject({ what: "gain abilities" });
    expect(cats(clause.modifiers)).toEqual(["duration_round"]);
  });

  it("09010008 General Grievous: play 2 units keeps the count", () => {
    const clause = clauseWith(featuresOf(CARDS["09010008"]), "Play 2 units");
    expect(clause.effects).toMatchObject([{ cat: "play_extra", n: 2, zone: "your hand" }]);
  });
});

function curatedFeaturesOf(spec: CardSpec): SwuCardFeatures {
  const { index } = loadCuratedTable(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8"));
  const card = swuFeatureInputCardSchema.parse({ type2: "", ...spec });
  return extractFeatures([card], index).cards[0];
}

describe("RC19 curated entries model their clause", () => {
  it("cur-0003 ISB Agent: the reveal keeps the event-from-hand target", () => {
    const clause = clauseWith(curatedFeaturesOf(CARDS["0101176"]), "reveal an event");
    expect(clause.structure).toMatchObject([{ cat: "reveal_hand", target: { side: "friendly", kind: "card", arena: "hand", restrict: ["type:event"] } }]);
  });

  it("cur-0060 Oppo Rancisis: mirrors keywords, does not want a wide board", () => {
    expect(wantTags(curatedFeaturesOf(CARDS["05010105"]))).not.toContain("wants:wide-board");
  });

  it("cur-0063 Marchion Ro: doubling Raid grants no Raid", () => {
    const card = curatedFeaturesOf(CARDS["05010186"]);
    expect(offerTags(card)).not.toContain("offers:grant-raid");
    expect(clauseWith(card, "Raid is doubled").effects).toMatchObject([{ cat: "stat_mod", sign: "buff", target: { side: "friendly", restrict: ["keyword:Raid"] } }]);
  });

  it("cur-0073 DJ: rescued units entering ready is not a units-entering payoff", () => {
    expect(wantTags(curatedFeaturesOf(CARDS["06010018"]))).not.toContain("wants:units-entering");
  });

  it("cur-0074 Darth Sion: the return to hand is conditional on 7 or more power", () => {
    const clause = clauseWith(curatedFeaturesOf(CARDS["06010035"]), "If this unit had 7 or more power");
    expect(clause.effects).toMatchObject([{ cat: "bounce", conditional: true }]);
    expect(clause.offers ?? []).not.toContain("offers:return-own-to-hand");
  });

  it("cur-0080 Vuutun Palaa: exhausts ready Droids, does not want exhausted ones", () => {
    expect(wantTags(curatedFeaturesOf(CARDS["06010122"]))).not.toContain("wants:exhausted-own");
  });

  it("cur-0107 Krrsantan: rationale does not claim a When Played", () => {
    const table = JSON.parse(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8")) as { entries: { id: string; rationale: string }[] };
    const entry = table.entries.find((e) => e.id === "cur-0107");
    expect(entry?.rationale).not.toMatch(/re-triggers its own When Played/);
    expect(CARDS["07010084"].text).not.toMatch(/When Played/);
  });

  it("cur-0151 Hold Them Off: units in its arena is the same arena", () => {
    const clause = clauseWith(curatedFeaturesOf(CARDS["08010139"]), "among any number of units in its arena");
    expect(clause.effects).toMatchObject([{ cat: "damage", target: { arena: "same" } }]);
  });

  it("cur-0153 Deadly Vulnerability: attaches to either side and deals no damage itself", () => {
    const card = curatedFeaturesOf(CARDS["08010150"]);
    expect(offerTags(card)).not.toContain("offers:damage-friendly-unit");
    expect(wantTags(card)).not.toContain("wants:damage-friendly");
    expect(clauseWith(card, "twice as much damage").structure).toMatchObject([{ cat: "damage_multiplier", n: 2, target: { side: "any" } }]);
  });
});
