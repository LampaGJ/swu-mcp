import { describe, expect, it } from "vitest";
import { parseTarget } from "../../src/ability-grammar/index.js";
import { featuresOf, wantTags, type CardSpec } from "./helpers.js";

// LampaGJ/swu-mcp#24: wants:trait-X only when the text rewards having X units on your side.
// Real card rows from the 2026-10-17 run, text verbatim.
const CARDS = {
  "05010118": {
    cardKey: "05010118",
    title: "Terentatek",
    type: "Unit",
    traits: "Creature",
    keywords: "Ambush",
    text: "While an opponent controls a Force unit, this unit gains Ambush. (When you play this unit, it may attack an enemy unit.)",
  },
  "05010033": {
    cardKey: "05010033",
    title: "Nameless Terror",
    type: "Unit",
    traits: "Creature",
    text: "When Played: You may exhaust a Force unit.\nOn Attack: Each enemy unit loses the Force trait for this phase.",
  },
  "04010235": {
    cardKey: "04010235",
    title: "Commandeer",
    type: "Event",
    traits: "Trick",
    text: "Take control of a non-leader Vehicle unit that costs 6 or less without a Pilot on it. If you do, ready it. At the start of the next regroup phase, return that unit to its owner's hand.",
  },
  "05010218": {
    cardKey: "05010218",
    title: "Impossible Escape",
    type: "Event",
    traits: "Force",
    text: "You may either exhaust a friendly unit or use the Force (lose your Force token). If you do either, exhaust an enemy unit and draw a card.",
  },
  "04010213": {
    cardKey: "04010213",
    title: "Sidon Ithano",
    type: "Unit",
    traits: "Underworld|Pilot",
    text: "When played as a unit: You may attach this unit as an upgrade to an enemy Vehicle unit without a Pilot on it.",
  },
  "05010151": {
    cardKey: "05010151",
    title: "Knight's Saber",
    type: "Upgrade",
    traits: "Item|Weapon|Lightsaber",
    text: "Attach to a Jedi non-Vehicle unit.",
  },
  "08010105": {
    cardKey: "08010105",
    title: "Bo-Katan Kryze",
    type: "Unit",
    traits: "Mandalorian",
    keywords: "Raid",
    text: "While you control another Mandalorian unit, this unit gains Raid 2.",
  },
  "04010206": {
    cardKey: "04010206",
    title: "Fly Casual",
    type: "Event",
    traits: "Trick",
    text: "Ready a Vehicle unit. It can't attack bases for this phase.",
  },
  "04010158": {
    cardKey: "04010158",
    title: "Crackshot V-Wing",
    type: "Unit",
    traits: "Republic|Vehicle|Fighter",
    text: "When Played: If you control no other Fighter units, deal 1 damage to this unit.",
  },
  "05010045": {
    cardKey: "05010045",
    title: "Yaddle",
    type: "Unit",
    traits: "Force|Jedi|Republic",
    keywords: "Restore",
    text: "Restore 1\nOn Attack: Each other friendly Jedi unit gains Restore 1 for this phase.",
  },
} satisfies Record<string, CardSpec>;

const traitWants = (key: keyof typeof CARDS): string[] => wantTags(featuresOf(CARDS[key])).filter((t) => t.startsWith("wants:trait-"));

describe("no trait want without a reward for your own units", () => {
  it("05010118 Terentatek: an opponent's Force unit is not a want", () => {
    expect(traitWants("05010118")).toEqual([]);
  });

  it("05010033 Nameless Terror: exhausting a Force unit targets the enemy", () => {
    expect(traitWants("05010033")).toEqual([]);
  });

  it("04010235 Commandeer: taking control of a Vehicle wants the opponent's Vehicle", () => {
    expect(traitWants("04010235")).toEqual([]);
  });

  it("05010218 Impossible Escape: 'use the Force' is not the Force trait", () => {
    expect(parseTarget("a friendly unit or use the Force").restrict).not.toContain("trait:Force");
    expect(traitWants("05010218")).toEqual([]);
  });

  it("04010213 Sidon Ithano: an enemy Vehicle is not a want", () => {
    expect(traitWants("04010213")).toEqual([]);
  });

  it("05010151 Knight's Saber: wants Jedi, never the excluded non-Vehicle", () => {
    expect(traitWants("05010151")).toEqual(["wants:trait-Jedi"]);
  });
});

describe("trait wants that reward your own units are kept", () => {
  it("08010105 Bo-Katan Kryze: while you control another Mandalorian", () => {
    expect(traitWants("08010105")).toEqual(["wants:trait-Mandalorian"]);
  });

  it("04010206 Fly Casual: ready a Vehicle unit", () => {
    expect(traitWants("04010206")).toEqual(["wants:trait-Vehicle"]);
  });

  it("04010158 Crackshot V-Wing: punished for controlling no other Fighter", () => {
    expect(traitWants("04010158")).toEqual(["wants:trait-Fighter"]);
  });

  it("05010045 Yaddle: buffs each other friendly Jedi", () => {
    expect(traitWants("05010045")).toEqual(["wants:trait-Jedi"]);
  });
});
