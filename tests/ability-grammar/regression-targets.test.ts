import { describe, expect, it } from "vitest";
import { parseTarget } from "../../src/ability-grammar/index.js";
import { CARDS } from "./regression-cards.js";
import { clauseWith, featuresOf, offerTags, wantTags } from "./helpers.js";

// Golden regressions for the 2026-10-16 verification (#9 -> #11): target parsing and text normalisation.

describe("RC12 target kind comes from the head noun", () => {
  it("05010008 Obi-Wan Kenobi: a unit without an Experience token on it is a unit", () => {
    const t = parseTarget("a unit without an Experience token on it");
    expect(t).toMatchObject({ kind: "unit", side: "any" });
    expect(t.restrict).toEqual(["without:Experience token"]);
  });

  it("05010008 Obi-Wan Kenobi: the clause gives a token to a unit and no longer wants tokens", () => {
    const card = featuresOf(CARDS["05010008"]);
    const effect = clauseWith(card, "Give an Experience token").effects[0];
    expect(effect).toMatchObject({ cat: "give_token", tokens: [["Experience", 1]], target: { kind: "unit" } });
    expect(wantTags(card)).not.toContain("wants:tokens");
    expect(offerTags(card)).toContain("offers:give-experience");
  });

  it("09010003 Doctor Hemlock: a unit without a Weakness token on it is a unit", () => {
    const card = featuresOf(CARDS["09010003"]);
    const effect = clauseWith(card, "unit without a Weakness token").effects[0];
    expect(effect.target).toMatchObject({ kind: "unit", restrict: ["without:Weakness token"] });
  });

  it("04010007 Admiral Holdo: a unit with a Resistance upgrade on it is a unit, and the upgrade is not a trait of the unit", () => {
    const t = parseTarget("a unit with a Resistance upgrade on it");
    expect(t).toMatchObject({ kind: "unit" });
    expect(t.restrict).toEqual(["with:Resistance upgrade"]);
    const card = featuresOf(CARDS["04010007"]);
    const effect = clauseWith(card, "Give a Resistance unit").effects[0];
    expect(effect).toMatchObject({ cat: "stat_mod", power: 2, hp: 2, target: { kind: "unit" } });
    expect(effect.target?.restrict).toContain("trait:Resistance");
  });

  it("keeps a token as the head noun when the phrase is about the token", () => {
    expect(parseTarget("an Experience token")).toMatchObject({ kind: "token" });
    expect(parseTarget("a friendly unit with 3 or less remaining HP").restrict).toEqual(["hp_le_3"]);
  });
});

describe("RC17 a named card is not a trait", () => {
  it("07010210 Salacious Crumb: Jabba the Hutt is a card name", () => {
    const t = parseTarget("Jabba the Hutt");
    expect(t.restrict).toEqual(["named:Jabba the Hutt"]);
    const card = featuresOf(CARDS["07010210"]);
    const cond = clauseWith(card, "If you control Jabba the Hutt").conditions[0];
    expect(cond).toMatchObject({ cat: "control" });
    expect((cond.what as { restrict: string[] }).restrict).toEqual(["named:Jabba the Hutt"]);
    expect(wantTags(card)).not.toContain("wants:trait-Hutt");
  });

  it("still reads a bare trait word as a trait", () => {
    expect(parseTarget("Rebel units").restrict).toEqual(["trait:Rebel"]);
    expect(parseTarget("a Hutt unit").restrict).toEqual(["trait:Hutt"]);
  });
});

describe("RC03 resources are not units or cards", () => {
  it.each([
    ["a friendly resource", "friendly"],
    ["2 enemy resources", "enemy"],
    ["a ready friendly resource", "friendly"],
  ])("%s", (text, side) => {
    expect(parseTarget(text)).toMatchObject({ kind: "resource", side });
  });

  it("a unit that costs resources is still a unit", () => {
    expect(parseTarget("a unit that costs 3 resources or less")).toMatchObject({ kind: "unit" });
  });

  it("07010013 Chewbacca: defeating a friendly resource is not a sacrifice of a unit", () => {
    const card = featuresOf(CARDS["07010013"]);
    const effect = clauseWith(card, "You may defeat a friendly resource").effects[0];
    expect(effect).toMatchObject({ cat: "defeat", target: { kind: "resource", side: "friendly" } });
    expect(offerTags(card)).not.toContain("offers:defeat-friendly-unit");
    expect(wantTags(card)).not.toContain("wants:sac-fodder");
  });
});
