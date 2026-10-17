import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable, parseTarget } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { CARDS_R3 as CARDS } from "./regression-cards-round3.js";
import { featuresOf, offerTags, wantTags, type CardSpec } from "./helpers.js";

const { index } = loadCuratedTable(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8"));
const curatedFeaturesOf = (spec: CardSpec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

// Tag-level follow-ups for LampaGJ/swu-mcp#15 item 3 (docs/verification/2026-10-17-round2.md).

describe("indirect damage goes to a player, not to a unit", () => {
  it("04010139 Dengar: no damage-any-unit offer", () => {
    expect(offerTags(featuresOf(CARDS["04010139"]))).not.toContain("offers:damage-any-unit");
  });
});

describe("a unit or base the enemy controls offers damage to both", () => {
  it("09010013 Cham Syndulla: an enemy unit or base", () => {
    const tags = offerTags(featuresOf(CARDS["09010013"]));
    expect(tags).toContain("offers:damage-enemy-base");
    expect(tags).toContain("offers:damage-enemy-unit");
  });

  it("07010208 Collateral Damage: either side stays any-unit only", () => {
    expect(offerTags(featuresOf(CARDS["07010208"]))).not.toContain("offers:damage-enemy-base");
  });
});

describe("non-unit is not a unit", () => {
  it("05010018 Anakin Skywalker: playing a non-unit card does not enter a unit", () => {
    expect(offerTags(featuresOf(CARDS["05010018"]))).not.toContain("offers:units-entering");
  });
});

describe("a discard cost is not a discard payoff", () => {
  it("07010011 Darth Vader: Action [Exhaust, discard a card] does not want discards", () => {
    expect(wantTags(featuresOf(CARDS["07010011"]))).not.toContain("wants:discard-own");
  });
});

describe("a discard the card creates is not an existing discard pile", () => {
  it("07010203 Daring Delve: discarded this way", () => {
    expect(wantTags(curatedFeaturesOf(CARDS["07010203"]))).not.toContain("wants:cards-in-discard");
  });
});

describe("an effect gated on the unit's own state is not an offer", () => {
  it("06010035 Darth Sion: the conditional bounce of himself", () => {
    expect(offerTags(curatedFeaturesOf(CARDS["06010035"]))).not.toContain("offers:return-own-to-hand");
  });
});

describe("damage on your base is a base-damage want", () => {
  it("08010179 Boba Fett's Rancor", () => {
    const tags = wantTags(featuresOf(CARDS["08010179"]));
    expect(tags).toContain("wants:own-base-damaged");
    expect(tags).not.toContain("wants:self-damaged");
  });
});

describe("a relative clause does not set the side", () => {
  it("09010078 Qui-Gon Jinn: a unit that attacked your base is not friendly", () => {
    expect(parseTarget("a unit that attacked your base this phase").side).toBe("any");
    expect(offerTags(featuresOf(CARDS["09010078"]))).not.toContain("offers:defeat-friendly-unit");
  });

  it("keeps friendly for a plain ownership phrase", () => {
    expect(parseTarget("a unit that you control").side).toBe("friendly");
    expect(parseTarget("one of your units").side).toBe("friendly");
  });
});

describe("a granted When Defeated is not an on-demand defeat", () => {
  it("06010039 Creditor's Claim", () => {
    const tags = offerTags(featuresOf(CARDS["06010039"]));
    expect(tags).not.toContain("offers:defeat-any-unit");
    expect(tags).toContain("offers:upgrade-to-attach");
  });
});
