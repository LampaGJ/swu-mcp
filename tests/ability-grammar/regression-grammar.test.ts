import { describe, expect, it } from "vitest";
import { parseClause } from "../../src/ability-grammar/index.js";
import { CARDS } from "./regression-cards.js";
import { clauseWith, clausesOf, featuresOf, offerTags } from "./helpers.js";

// Golden regressions for RC03/RC11/RC14/RC15/RC18: productions that drop a qualifier, miss a phrasing or lose a tie.

describe("RC14 a matched rule keeps the qualifier it consumed", () => {
  it("0101061 Guardian of the Whills: the first upgrade you play on this unit each round", () => {
    const e = clauseWith(featuresOf(CARDS["0101061"]), "The first upgrade").effects[0];
    expect(e).toMatchObject({ cat: "cost_reduction", n: 1, oneShot: true, frequency: "each_round", host: { side: "self", kind: "unit" } });
    expect(e.applies).toMatchObject({ kind: "upgrade" });
  });

  it("04010006 Darth Vader: attacked with a non-token Vehicle unit this phase", () => {
    const c = clauseWith(featuresOf(CARDS["04010006"]), "If you attacked with a non-token Vehicle unit");
    expect(c.conditions).toMatchObject([{ cat: "event_this_phase", verb: "attacked with", what: { kind: "unit", restrict: ["non_token", "trait:Vehicle"] } }]);
  });

  it("04010006 Darth Vader: deploy as an upgrade keeps its host restriction", () => {
    const deploy = clausesOf(featuresOf(CARDS["04010006"])).flatMap((c) => c.clause.structure).filter((s) => s.cat === "deploy");
    const host = deploy.find((s) => s.asUpgrade === true)?.host;
    expect(host).toMatchObject({ side: "friendly", kind: "unit" });
    expect(host?.restrict).toEqual(["trait:Vehicle", "without:Pilot"]);
  });

  it("06010009 Mon Mothma: the ignored penalties apply to non-Villainy Official units you play", () => {
    const e = clauseWith(featuresOf(CARDS["06010009"]), "Ignore the aspect penalties").effects[0];
    expect(e).toMatchObject({ cat: "ignore_aspect_penalty", applies: { kind: "unit" } });
    expect(e.applies?.restrict).toEqual(["non_aspect:Villainy", "trait:Official"]);
  });
});

describe("RC15 phrasing variants", () => {
  it("09010150 Migrate: for every 3 resources you control", () => {
    const c = clauseWith(featuresOf(CARDS["09010150"]), "For every 3 resources");
    expect(c.residue).toEqual([]);
    expect(c.conditions).toMatchObject([{ cat: "scaling", per: "3 resources you control", every: 3 }]);
    expect(c.effects).toMatchObject([{ cat: "create_token", token: "Beast" }]);
  });

  it("keeps for each working", () => {
    expect(parseClause("Draw a card for each friendly unit.").accepted.condition).toMatchObject([{ cat: "scaling", per: "friendly unit" }]);
  });

  it("05010100 Kelleran Beq: reveal it, and play it", () => {
    const c = clauseWith(featuresOf(CARDS["05010100"]), "Search the top 7 cards");
    expect(c.residue).toEqual([]);
    expect(c.effects.map((e) => e.cat)).toEqual(["search", "play_extra"]);
  });

  it("07010020 Daimyo's Palace: ignoring 1 of its Vigilance, Command, Aggression, or Cunning aspect penalties", () => {
    const c = clauseWith(featuresOf(CARDS["07010020"]), "Play a card from your hand");
    expect(c.residue).toEqual([]);
    expect(c.effects.map((e) => e.cat)).toEqual(["play_extra", "ignore_aspect_penalty"]);
    expect(c.effects[1]).toMatchObject({ n: 1 });
  });
});

describe("RC03 specific resource rules beat the generic ones", () => {
  it("06010235 The Wrong Ride: exhaust 2 enemy resources", () => {
    const card = featuresOf(CARDS["06010235"]);
    const e = clauseWith(card, "Exhaust 2 enemy resources").effects[0];
    expect(e).toMatchObject({ cat: "exhaust_resource", n: 2, target: { side: "enemy", kind: "resource" } });
    expect(offerTags(card)).not.toContain("offers:exhaust-enemy");
  });

  it("06010225 Synara San: ready a friendly resource is not readying a unit", () => {
    const card = featuresOf(CARDS["06010225"]);
    const e = clauseWith(card, "ready a friendly resource").effects[0];
    expect(e).toMatchObject({ cat: "ready_resource", n: 1 });
    expect(offerTags(card)).not.toContain("offers:ready-unit");
  });

  it("09010123 King Grakchawwaa: ready each card resourced this way is not readying a unit", () => {
    const card = featuresOf(CARDS["09010123"]);
    const c = clauseWith(card, "Ready each card resourced");
    expect(c.residue).toEqual([]);
    expect(c.effects.map((e) => e.cat)).toEqual(["ready_resource"]);
    expect(offerTags(card)).not.toContain("offers:ready-unit");
  });
});

describe("RC11 a conditional initiative phrase is not an effect", () => {
  it("05010203 Premonition of Doom: the next time you take the initiative", () => {
    const card = featuresOf(CARDS["05010203"]);
    const c = clauseWith(card, "The next time you take the initiative");
    expect(c.effects.map((e) => e.cat)).toEqual(["exhaust"]);
    expect(c.conditions).toMatchObject([{ cat: "initiative" }]);
    expect(offerTags(card)).not.toContain("offers:initiative");
  });

  it("the imperative still takes the initiative", () => {
    expect(parseClause("Take the initiative.").accepted.effect).toMatchObject([{ cat: "take_initiative" }]);
    expect(parseClause("You may take the initiative.").accepted.effect).toMatchObject([{ cat: "take_initiative" }]);
    expect(parseClause("When you take the initiative, draw a card.").accepted.effect.map((e) => e.cat)).toEqual(["draw"]);
  });
});

describe("RC18 a unit that attaches itself as an upgrade", () => {
  it("04010213 Sidon Ithano: attach this unit as an upgrade, with no Piloting keyword", () => {
    const card = featuresOf(CARDS["04010213"]);
    const c = clauseWith(card, "attach this unit as an upgrade");
    expect(c.source).toBe("grammar");
    expect(c.effects).toMatchObject([{ cat: "attach", rule: "attach_self", target: { side: "enemy", kind: "unit" } }]);
    expect(c.effects[0].target?.restrict).toEqual(["trait:Vehicle", "without:Pilot"]);
  });
});
