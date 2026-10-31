import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { offerTags, wantTags, type CardSpec } from "../ability-grammar/helpers.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import { COMMITTED_TABLE } from "./fixtures.js";

// LampaGJ/swu-mcp#145, D58: the matcher reads the kind and size of what a clause acts on.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const { index } = loadCuratedTable(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8"));
type Spec = CardSpec & { cost?: number; power?: number; hp?: number; arenas?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "09010117": {
    cardKey: "09010117", title: "Chewbacca", type: "Unit", traits: "Wookiee", keywords: "Raid|Overwhelm", cost: 3, power: 0, hp: 5, arenas: "Ground",
    text: "This unit gains Raid 1 for each exhausted resource you control.\nWhile each resource you control is exhausted, this unit gains Overwhelm.",
  },
  "07010226": {
    cardKey: "07010226", title: "Secret Battle of Pretend", type: "Event", traits: "Trick", cost: 2,
    text: "Exhaust a friendly unit. If you do, for each different aspect it has, exhaust an enemy unit in the same arena.",
  },
  "08010216": { cardKey: "08010216", title: "Mandalorian Scout", type: "Unit", traits: "Mandalorian", cost: 2, power: 3, hp: 3, arenas: "Ground", text: "When Defeated: Exhaust a ready friendly resource." },
  "06010216": { cardKey: "06010216", title: "Regulations Bureaucrat", type: "Unit", traits: "Imperial|Official", cost: 2, power: 0, hp: 5, arenas: "Ground", text: "Action [Exhaust]: Exhaust a resource." },
  "09010228": { cardKey: "09010228", title: "Lakeside Shaaks", type: "Unit", traits: "Creature", cost: 4, power: 4, hp: 4, arenas: "Ground", text: "When Played: Ready a friendly resource." },
  "09010209": { cardKey: "09010209", title: "Corona Squadron X-Wing", type: "Unit", traits: "New Republic|Vehicle|Fighter", cost: 2, power: 2, hp: 2, arenas: "Space", text: "On Attack: You may ready a resource." },
  "08010248": {
    cardKey: "08010248", title: "Neel", type: "Unit", traits: "Fringe", cost: 1, power: 1, hp: 4, arenas: "Ground",
    text: "When Played/On Attack: The next unit you play this phase with 1 or less power enters play ready.",
  },
  "08010119": {
    cardKey: "08010119", title: "Greef Karga", type: "Unit", traits: "Official", cost: 2, power: 2, hp: 3, arenas: "Ground",
    text: "Action [1 resource, Exhaust]: If your base was attacked this phase, create a Mandalorian token.",
  },
  T145A: { cardKey: "T145A", title: "One Power Clerk", type: "Unit", traits: "Official", cost: 2, power: 1, hp: 3, arenas: "Ground", text: "Action [Exhaust]: Draw a card." },
  T145B: { cardKey: "T145B", title: "Exhausted Watcher", type: "Unit", traits: "Official", cost: 3, power: 2, hp: 3, arenas: "Ground", text: "This unit gets +1/+0 for each exhausted friendly unit." },
} satisfies Record<string, Spec>;

describe("an exhausted-resource want is not an exhausted-unit want", () => {
  it("09010117 Chewbacca wants exhausted resources, not exhausted units or a resource threshold", () => {
    const w = wantTags(featuresOf(CARDS["09010117"]));
    expect(w).toContain("wants:exhausted-resources");
    expect(w).not.toContain("wants:exhausted-own");
    expect(w).not.toContain("wants:resource-ramp");
  });
  it("a count of exhausted friendly units keeps the exhausted-unit want", () => {
    const w = wantTags(featuresOf(CARDS.T145B));
    expect(w).toContain("wants:exhausted-own");
    expect(w).not.toContain("wants:exhausted-resources");
  });
  it("06010216 Regulations Bureaucrat exhausting a resource offers exhaust-resource; 08010216 Mandalorian Scout's When Defeated drawback offers none (D70)", () => {
    expect(offerTags(featuresOf(CARDS["06010216"]))).toContain("offers:exhaust-resource");
    expect(offerTags(featuresOf(CARDS["08010216"]))).not.toContain("offers:exhaust-resource");
  });
  it("an enemy resource exhaust offers nothing to an exhausted-resource want", () => {
    const f = featuresOf({ cardKey: "T145C", title: "Resource Jam", type: "Event", text: "Exhaust 2 enemy resources." });
    expect(offerTags(f)).not.toContain("offers:exhaust-resource");
  });
  it("07010226 Secret Battle of Pretend exhausts a unit, not a resource", () => {
    const o = offerTags(featuresOf(CARDS["07010226"]));
    expect(o).toContain("offers:exhaust-own");
    expect(o).not.toContain("offers:exhaust-resource");
  });
  it.each(["09010228", "09010209"] as const)("%s readying a resource offers ready-resource, not resource-ramp", (key) => {
    const o = offerTags(featuresOf(CARDS[key]));
    expect(o).toContain("offers:ready-resource");
    expect(o).not.toContain("offers:resource-ramp");
  });
  it("the committed table records ready-resource as feeding nothing, with the reason", () => {
    const note = (COMMITTED_TABLE.feedsNothing ?? []).find((n) => n.tag === "offers:ready-resource")?.note ?? "";
    expect(note).toMatch(/exhausted resources/);
    expect(COMMITTED_TABLE.rows.some((r) => Object.keys(r.offers).includes("offers:ready-resource"))).toBe(false);
  });
});

describe("the pair links that rested on the kind and size of the target", () => {
  const keys = Object.keys(CARDS) as (keyof typeof CARDS)[];
  const graph = buildPairGraph(synergyCardsSchema.parse(keys.map((k) => featuresOf(CARDS[k]))), COMMITTED_TABLE);
  const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

  it("07010226 Secret Battle of Pretend no longer feeds 09010117 Chewbacca", () => {
    expect(rowsOf("07010226", "09010117")).toEqual([]);
  });
  it("07010226 Secret Battle of Pretend still feeds an exhausted-unit count", () => {
    expect(rowsOf("07010226", "T145B")).toContain("exhaust-own-payoff");
  });
  it("06010216 Regulations Bureaucrat feeds 09010117 Chewbacca through exhaust-resource-payoff; 08010216 Mandalorian Scout's drawback does not (D70)", () => {
    expect(rowsOf("06010216", "09010117")).toContain("exhaust-resource-payoff");
    expect(rowsOf("08010216", "09010117")).toEqual([]);
  });
  it.each(["09010228", "09010209"] as const)("%s readying a resource does not feed 09010117 Chewbacca", (key) => {
    expect(rowsOf(key, "09010117")).toEqual([]);
  });
  it("08010248 Neel no longer readies 08010119 Greef Karga, printed power 2", () => {
    expect(rowsOf("08010248", "08010119")).not.toContain("ready-reuse");
  });
  it("08010248 Neel still readies a 1-power unit with an Exhaust action", () => {
    expect(rowsOf("08010248", "T145A")).toContain("ready-reuse");
  });
});
