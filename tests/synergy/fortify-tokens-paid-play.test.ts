import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { extractFeatures, loadCuratedTable, stripReminders } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { clauseWith, offerTags, type CardSpec } from "../ability-grammar/helpers.js";
import { tagEvidence } from "../../src/synergy/evidence.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import { COMMITTED_TABLE } from "./fixtures.js";

// LampaGJ/swu-mcp#146, D58: Fortify attaches to the base, token doubling feeds no trait want, a paid play is not cheat-play.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const { index } = loadCuratedTable(readFileSync(new URL("../../data/curated-rules.json", import.meta.url), "utf8"));
type Spec = CardSpec & { cost?: number; power?: number; hp?: number; arenas?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "09010216": {
    cardKey: "09010216", title: "Insurgent Camp", type: "Upgrade", traits: "Fortification", keywords: "Fortify", cost: 1,
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  "08010253": {
    cardKey: "08010253", title: "Yellow Aces Bomber", type: "Unit", traits: "New Republic|Vehicle|Fighter", keywords: "Support", cost: 3, power: 2, hp: 4, arenas: "Space",
    text: "Support (When you play this unit, you may attack with another unit. It gains this unit's other abilities for this attack.)\nOn Attack: If this unit is upgraded, deal 2 damage to a base.",
  },
  T146A: { cardKey: "T146A", title: "Plain Blaster", type: "Upgrade", traits: "Item|Weapon", cost: 1, text: "Attached unit gets +1/+0." },
  "09010212": {
    cardKey: "09010212", title: "The Chieftain", type: "Unit", traits: "Tusken", keywords: "Raid", cost: 3, power: 2, hp: 5, arenas: "Ground",
    text: "This unit gains Raid 1 for each other friendly Tusken unit.\nWhile a friendly Tusken unit is defending, it gets +1/+0 for each Raid it has.",
  },
  "08010094": {
    cardKey: "08010094", title: "Moff Jerjerrod", type: "Unit", traits: "Imperial|Official", cost: 2, power: 1, hp: 3, arenas: "Ground",
    text: "If you would create a number of tokens, you may defeat this unit. If you do, create twice that number of tokens instead.",
  },
  T146B: { cardKey: "T146B", title: "Clan Elder", type: "Unit", traits: "Mandalorian", cost: 3, power: 2, hp: 4, arenas: "Ground", text: "This unit gets +1/+0 for each other friendly Mandalorian unit." },
  "08010t01": { cardKey: "08010t01", title: "Mandalorian", type: "Token Unit", traits: "Mandalorian", keywords: "Shielded", cost: 0, power: 2, hp: 2, arenas: "Ground", text: "Shielded" },
  "09010018": {
    cardKey: "09010018", title: "The Warrior", type: "Leader", traits: "Tusken", keywords: "Ambush|Raid", cost: 5, power: 3, hp: 6, arenas: "Ground",
    text: "Action [1 resource, Exhaust]: Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.",
  },
  T146C: { cardKey: "T146C", title: "Free Drop", type: "Event", cost: 2, text: "Play a unit from your hand for free." },
} satisfies Record<string, Spec>;

describe("a Fortify upgrade attaches to the base", () => {
  const keys = Object.keys(CARDS) as (keyof typeof CARDS)[];
  const graph = buildPairGraph(synergyCardsSchema.parse(keys.map((k) => featuresOf(CARDS[k]))), COMMITTED_TABLE);
  const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

  it("09010216 Insurgent Camp is not an upgrade on 08010253 Yellow Aces Bomber", () => {
    expect(rowsOf("09010216", "08010253")).not.toContain("upgrade-stacking");
  });
  it("a unit upgrade still feeds 08010253 Yellow Aces Bomber", () => {
    expect(rowsOf("T146A", "08010253")).toContain("upgrade-stacking");
  });
});

describe("token creation feeds a trait want only when the token carries the trait", () => {
  const keys = Object.keys(CARDS) as (keyof typeof CARDS)[];
  const graph = buildPairGraph(synergyCardsSchema.parse(keys.map((k) => featuresOf(CARDS[k]))), COMMITTED_TABLE);
  const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

  it("08010094 Moff Jerjerrod's token doubling does not feed 09010212 The Chieftain, no token is Tusken", () => {
    expect(rowsOf("08010094", "09010212")).toEqual([]);
    expect(graph.conditionalByKey.get("08010094>09010212")).toBeUndefined();
  });
  it("08010094 Moff Jerjerrod still feeds a Mandalorian count, a Mandalorian token exists", () => {
    expect(rowsOf("08010094", "T146B")).toContain("fodder-for-outlet");
  });
  it("a doubler puts no token traits on the board of its own", () => {
    expect(graph.boardTraits("08010094")).toEqual(["Imperial", "Official"]);
  });
});

describe("a play that pays the card's cost is not cheat-play", () => {
  it("stripReminders keeps '(paying its cost)' and drops other reminders", () => {
    expect(stripReminders("Play a unit from your hand (paying its cost) and give it Ambush.").text).toBe("Play a unit from your hand (paying its cost) and give it Ambush.");
    expect(stripReminders("Raid 2 (This unit gets +2/+0 while attacking.)").text).toBe("Raid 2");
  });
  it("09010018 The Warrior keeps the parenthetical in the clause and offers paid-play, not cheat-play", () => {
    const f = featuresOf(CARDS["09010018"]);
    expect(clauseWith(f, "Play a unit").text).toBe("Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.");
    expect(clauseWith(f, "Play a unit").residue).toEqual([]);
    expect(offerTags(f)).toContain("offers:paid-play");
    expect(offerTags(f)).not.toContain("offers:cheat-play");
  });
  it("a free play from hand stays cheat-play", () => {
    const o = offerTags(featuresOf(CARDS.T146C));
    expect(o).toContain("offers:cheat-play");
    expect(o).not.toContain("offers:paid-play");
  });
  it("09010018 The Warrior feeds 09010216 Insurgent Camp through the paid-play row, quoting the whole clause", () => {
    const cards = synergyCardsSchema.parse((Object.keys(CARDS) as (keyof typeof CARDS)[]).map((k) => featuresOf(CARDS[k])));
    const graph = buildPairGraph(cards, COMMITTED_TABLE);
    const edge = graph.edgeByKey.get("09010018>09010216");
    expect(edge?.rows.map((r) => r.row)).toContain("paid-play-trigger");
    expect(edge?.rows.map((r) => r.offer)).not.toContain("offers:cheat-play");
    const warrior = cards.find((c) => c.cardKey === "09010018");
    expect(warrior && tagEvidence(warrior, "offers:paid-play")).toBe("text: Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.");
  });
});
