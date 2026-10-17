import { describe, expect, it } from "vitest";
import { CARDS } from "./regression-cards.js";
import { featuresOf, offerTags, wantTags } from "./helpers.js";

// Golden regressions for the tag builder (RC01/02/05/07/08/09/10) and the wants:replay-when-played review.

describe("RC01 damage to your own base", () => {
  it.each(["08010179", "05010137"] as const)("%s deals damage to your base, not to a friendly unit", (key) => {
    const card = featuresOf(CARDS[key]);
    expect(offerTags(card)).toContain("offers:damage-own-base");
    expect(offerTags(card)).not.toContain("offers:damage-friendly-unit");
  });

  it("08010179 Boba Fett's Rancor: damage to a base for every 5 damage on your base targets a base of either side", () => {
    expect(offerTags(featuresOf(CARDS["08010179"]))).toContain("offers:damage-enemy-base");
  });
});

describe("RC18 a unit that attaches itself as an upgrade offers an upgrade to attach", () => {
  it("04010213 Sidon Ithano: no Piloting keyword needed", () => {
    expect(offerTags(featuresOf(CARDS["04010213"]))).toContain("offers:upgrade-to-attach");
  });
});

describe("RC02 returning an upgrade is not returning a unit", () => {
  it.each(["08010042", "07010224"] as const)("%s", (key) => {
    const card = featuresOf(CARDS[key]);
    expect(offerTags(card)).toContain("offers:return-upgrade");
    expect(offerTags(card)).not.toContain("offers:return-any-to-hand");
  });
});

describe("RC05 a tutor offers its destination", () => {
  it("05010103 Following the Path: puts the cards on top of the deck", () => {
    const card = featuresOf(CARDS["05010103"]);
    expect(offerTags(card)).toContain("offers:tutor-to-deck");
    expect(offerTags(card)).not.toContain("offers:tutor");
  });

  it("05010100 Kelleran Beq: plays the card it finds", () => {
    const card = featuresOf(CARDS["05010100"]);
    expect(offerTags(card)).toContain("offers:tutor-to-play");
    expect(offerTags(card)).not.toContain("offers:tutor");
  });

  it("a tutor that draws the card still offers tutor", () => {
    const card = featuresOf({
      cardKey: "99990002", title: "Tutor", type: "Event",
      text: "Search the top 5 cards of your deck for a unit, reveal it, and draw it.",
    });
    expect(offerTags(card)).toContain("offers:tutor");
  });
});

describe("RC07 granted or one-shot On Attack does not want extra attacks", () => {
  it("05010205 Force Speed: an Event that grants an On Attack for one attack", () => {
    const card = featuresOf(CARDS["05010205"]);
    expect(wantTags(card)).not.toContain("wants:extra-attacks");
    expect(offerTags(card)).toContain("offers:extra-attack");
  });

  it("07010225 Han's Golden Dice: a permanent grant still wants extra attacks", () => {
    expect(wantTags(featuresOf(CARDS["07010225"]))).toContain("wants:extra-attacks");
  });

  it("a unit's own On Attack still wants extra attacks", () => {
    expect(wantTags(featuresOf(CARDS["06010225"]))).toContain("wants:extra-attacks");
  });
});

describe("RC08 a Pilot-attach trigger wants Pilots", () => {
  it("04010223 Razor Crest", () => {
    const card = featuresOf(CARDS["04010223"]);
    expect(wantTags(card)).toContain("wants:pilot-attached");
    expect(wantTags(card)).not.toContain("wants:upgrades-attached");
  });

  it("an any-upgrade trigger keeps the generic tag", () => {
    const card = featuresOf({ cardKey: "99990003", title: "Stacker", type: "Unit", text: "When an upgrade attaches to this unit: Draw a card." });
    expect(wantTags(card)).toContain("wants:upgrades-attached");
  });
});

describe("RC09 playing a unit is not creating a unit", () => {
  it("05010249 Luke Skywalker: when you play another unique unit", () => {
    const card = featuresOf(CARDS["05010249"]);
    expect(wantTags(card)).toContain("wants:units-played");
    expect(wantTags(card)).not.toContain("wants:units-entering");
  });

  it("08010017 Greef Karga: when you play or create a unit", () => {
    const card = featuresOf(CARDS["08010017"]);
    expect(wantTags(card)).toContain("wants:units-entering");
    expect(wantTags(card)).not.toContain("wants:units-played");
  });
});

describe("RC10 deploying a leader is not resource ramp", () => {
  it("04010191 Invincible", () => {
    const card = featuresOf(CARDS["04010191"]);
    expect(wantTags(card)).toContain("wants:leader-deployed");
    expect(wantTags(card)).not.toContain("wants:resource-ramp");
  });

  it("06010008 Bail Organa: playing a card from resources still wants ramp", () => {
    expect(wantTags(featuresOf(CARDS["06010008"]))).toContain("wants:resource-ramp");
  });
});

describe("wants:replay-when-played is limited to a When Played worth replaying", () => {
  const unit = (text: string) => featuresOf({ cardKey: "99990004", title: "Replay", type: "Unit", text });

  it("a When Played that draws is worth replaying and says why", () => {
    const card = unit("When Played: Draw a card.");
    const why = card.tags.wants.find((t) => t.tag === "wants:replay-when-played")?.why;
    expect(why).toMatch(/draw/);
  });

  it("a When Played that only restricts you is not", () => {
    expect(wantTags(unit("When Played: This unit can't attack."))).not.toContain("wants:replay-when-played");
  });

  it("a When Played that only defeats this unit is not", () => {
    expect(wantTags(unit("When Played: Defeat this unit."))).not.toContain("wants:replay-when-played");
  });

  it("a When Played that discards your own cards for nothing is not", () => {
    expect(wantTags(unit("When Played: Discard a card from your hand."))).not.toContain("wants:replay-when-played");
  });

  it("a granted When Played does not make the host want a replay", () => {
    const card = featuresOf({ cardKey: "99990005", title: "Host", type: "Upgrade", text: "Attached unit gains: “When Played: Draw a card.”" });
    expect(wantTags(card)).not.toContain("wants:replay-when-played");
  });
});
