import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { clausesOf, featuresOf as grammarFeaturesOf, wantTags, type CardSpec } from "../ability-grammar/helpers.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import { COMMITTED_TABLE } from "./fixtures.js";

// LampaGJ/swu-mcp#22, D57: a conditional or self-referential clause is no unconditional want.
// Card rows from the 2026-10-30 run (originals 2026-10-16), text verbatim.

const { index } = loadCuratedTable(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8"));
const featuresOf = (spec: CardSpec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "09010161": { cardKey: "09010161", title: "Raze to Ruin", type: "Event", traits: "Disaster|Plan", text: "Each player discards all but 3 cards from their hand." },
  "06010179": { cardKey: "06010179", title: "Aggressive Negotiations", type: "Event", traits: "Tactic", text: "Attack with a unit. For this attack, it gets +1/+0 for each card in your hand." },
  "05010059": { cardKey: "05010059", title: "Nightsister Warrior", type: "Unit", traits: "Force|Night", text: "When Defeated: Draw a card." },
  "08010055": {
    cardKey: "08010055",
    title: "Blade of Talzin",
    type: "Upgrade",
    traits: "Night|Item|Weapon",
    text: "Attach to a non-Vehicle unit.\nWhen Defeated: If this upgrade was on a friendly Night unit, return this upgrade from your discard pile to your hand.",
  },
  "06010105": { cardKey: "06010105", title: "Renewed Friendship", type: "Event", traits: "Innate", text: "Return a unit from your discard pile to your hand.\nCreate 2 Spy tokens." },
  "09010056": {
    cardKey: "09010056",
    title: "Yoda",
    type: "Unit",
    traits: "Force|Fringe|Jedi",
    keywords: "Hidden",
    text: "Hidden\nWhen Defeated: You may put this card from your discard pile on top of your deck. If you do, heal 2 damage from a base.",
  },
  // The printed text uses U+2011 non-breaking hyphens.
  "09010037": {
    cardKey: "09010037",
    title: "Bacta Tank",
    type: "Upgrade",
    traits: "Fortification",
    keywords: "Fortify",
    text: "Fortify\nWhen Played: Heal up to 3 damage from a non‑Vehicle unit.\nAction [defeat this upgrade]: Put a non‑Vehicle unit from your discard pile on top of your deck.",
  },
  "07010173": { cardKey: "07010173", title: "BT-1", type: "Unit", traits: "Underworld|Droid", text: "On Attack: Discard a card from your deck. If it's Aggression, you may deal 1 damage to a ground unit." },
} satisfies Record<string, CardSpec>;

describe("a discard-to-count effect does not want cards in hand", () => {
  it("09010161 Raze to Ruin drops the curated cur-0189 want but keeps its discard offers", () => {
    const f = featuresOf(CARDS["09010161"]);
    expect(clausesOf(f).map((c) => c.clause.curatedId)).toEqual(["cur-0189"]);
    expect(wantTags(f)).not.toContain("wants:cards-in-hand");
    expect(f.tags.offers.map((t) => t.tag)).toEqual(expect.arrayContaining(["offers:discard-opponent", "offers:discard-own"]));
  });

  it("06010179 Aggressive Negotiations, which scales with cards in hand, keeps the want", () => {
    expect(wantTags(featuresOf(CARDS["06010179"]))).toContain("wants:cards-in-hand");
  });
});

describe("a return-from-discard of the card itself does not want cards in discard", () => {
  it("08010055 Blade of Talzin returning 'this upgrade' drops the want but keeps the return offer", () => {
    const f = featuresOf(CARDS["08010055"]);
    expect(wantTags(f)).not.toContain("wants:cards-in-discard");
    expect(f.tags.offers.map((t) => t.tag)).toContain("offers:return-from-discard");
  });

  it("06010105 Renewed Friendship returning 'a unit from your discard pile' keeps the want", () => {
    expect(wantTags(featuresOf(CARDS["06010105"]))).toContain("wants:cards-in-discard");
  });

  it("09010056 Yoda putting 'this card' back on its deck drops the curated cur-0180 want", () => {
    const f = featuresOf(CARDS["09010056"]);
    expect(clausesOf(f).some((c) => c.clause.curatedId === "cur-0180")).toBe(true);
    expect(wantTags(f)).not.toContain("wants:cards-in-discard");
  });

  it("09010037 Bacta Tank putting 'a non-Vehicle unit from your discard pile' back keeps the curated cur-0173 want", () => {
    expect(wantTags(featuresOf(CARDS["09010037"]))).toContain("wants:cards-in-discard");
  });

  it("a return of 'it' gated on a self_state condition is no unconditional want", () => {
    const f = grammarFeaturesOf({ cardKey: "T1", title: "Synthetic", type: "Unit", text: "When Defeated: If this unit is upgraded, return it from your discard pile to your hand." });
    expect(wantTags(f)).not.toContain("wants:cards-in-discard");
  });

  it("a return of 'a unit' under a self_state condition still wants cards in discard", () => {
    const f = grammarFeaturesOf({ cardKey: "T2", title: "Synthetic", type: "Unit", text: "When Defeated: While this unit is damaged, return a unit from your discard pile to your hand." });
    expect(wantTags(f)).toContain("wants:cards-in-discard");
  });
});

describe("the pair links that rested on those wants", () => {
  const keys = Object.keys(CARDS) as (keyof typeof CARDS)[];
  const graph = buildPairGraph(synergyCardsSchema.parse(keys.map((k) => featuresOf(CARDS[k]))), COMMITTED_TABLE);
  const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

  it("05010059 Nightsister Warrior no longer feeds 09010161 Raze to Ruin as draw-hand-size", () => {
    expect(rowsOf("05010059", "09010161")).not.toContain("draw-hand-size");
  });
  it("05010059 Nightsister Warrior still feeds 06010179 Aggressive Negotiations as draw-hand-size", () => {
    expect(rowsOf("05010059", "06010179")).toContain("draw-hand-size");
  });
  it("07010173 BT-1 no longer feeds 08010055 Blade of Talzin as fill-discard", () => {
    expect(rowsOf("07010173", "08010055")).not.toContain("fill-discard");
  });
  it("07010173 BT-1 still feeds 06010105 Renewed Friendship as fill-discard", () => {
    expect(rowsOf("07010173", "06010105")).toContain("fill-discard");
  });
});
