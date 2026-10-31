import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { loadStore, newestRun } from "../../src/data.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { edgeEvidence } from "../../src/synergy/evidence.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { offerTags, wantTags, type CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE } from "./fixtures.js";

// LampaGJ/swu-mcp#153, D62: paid plays everywhere, opponent-side conditions, self-satisfied wants, name references, Neel and 0-power units.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "06010257": { cardKey: "06010257", title: "Restore Freedom", type: "Event", traits: "Gambit", cost: 2, text: "Play a unit from your hand. It costs 1 resource less for each Heroism aspect icon among friendly units." },
  "05010125": {
    cardKey: "05010125", title: "The Burden of Masters", type: "Event", traits: "Learned", cost: 1,
    text: "Put a Force unit from your discard pile on the bottom of your deck. If you do, play a unit from your hand and give 2 Experience tokens to it.",
  },
  "07010264": { cardKey: "07010264", title: "From a Certain Point of View", type: "Event", traits: "Learned", cost: 1, text: "Play a card from your hand, ignoring its aspect penalties." },
  "08010245": {
    cardKey: "08010245", title: "Eye of Sion", type: "Unit", traits: "Imperial|Vehicle|Transport", cost: 7, power: 5, hp: 8, arenas: "Space", unique: true,
    text: "Action [Exhaust]: Search the top 8 cards of your deck for a unit that costs the same as or less than this unit's power. Play it for free. It enters play ready.",
  },
  T153A: { cardKey: "T153A", title: "Big Discount", type: "Event", cost: 2, text: "Play a unit from your hand. It costs 5 resources less." },
  "09010216": {
    cardKey: "09010216", title: "Insurgent Camp", type: "Upgrade", traits: "Fortification", keywords: "Fortify", cost: 1,
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  "06010095": { cardKey: "06010095", title: "Theed Security", type: "Unit", traits: "Naboo|Trooper", cost: 2, power: 2, hp: 3, arenas: "Ground", text: "When Played: If an opponent controls an upgrade, give an Experience token to a unit." },
  "05010248": {
    cardKey: "05010248", title: "Jocasta Nu", subtitle: "The Gift of Knowledge", type: "Unit", traits: "Force|Jedi|Republic", cost: 3, power: 3, hp: 4, arenas: "Ground", unique: true,
    text: "When Played: You may attach a friendly upgrade on a friendly unit to a different eligible unit.",
  },
  T153B: { cardKey: "T153B", title: "Upgrade Clerk", type: "Unit", traits: "Official", cost: 2, power: 1, hp: 3, arenas: "Ground", text: "When Played: If you control an upgrade, draw a card." },
  "04010238": {
    cardKey: "04010238", title: "Sith Trooper", type: "Unit", traits: "First Order|Sith|Trooper", cost: 3, power: 3, hp: 3, arenas: "Ground",
    text: "On Attack: This unit gets +1/+0 for this attack for each damaged unit the defending player controls.",
  },
  T153C: { cardKey: "T153C", title: "Self Pinger", type: "Event", cost: 1, text: "Deal 1 damage to a friendly unit." },
  T153D: { cardKey: "T153D", title: "Any Pinger", type: "Event", cost: 1, text: "Deal 1 damage to a unit." },
  "09010117": {
    cardKey: "09010117", title: "Chewbacca", subtitle: "Resourceful Wookiee", type: "Unit", traits: "Wookiee", keywords: "Raid|Overwhelm", cost: 3, power: 0, hp: 5, arenas: "Ground", unique: true,
    text: "This unit gains Raid 1 for each exhausted resource you control.\nWhile each resource you control is exhausted, this unit gains Overwhelm.",
  },
  "08010216": { cardKey: "08010216", title: "Mandalorian Scout", type: "Unit", traits: "Mandalorian", cost: 2, power: 3, hp: 3, arenas: "Ground", text: "When Defeated: Exhaust a ready friendly resource." },
  T153E: { cardKey: "T153E", title: "Plain Draw", type: "Event", cost: 2, text: "Draw 2 cards." },
  "09010127": {
    cardKey: "09010127", title: "Chewbacca's Bowcaster", subtitle: "Handcrafted Tradition", type: "Upgrade", traits: "Item|Weapon", cost: 3, unique: true,
    text: "Attach to a non-Vehicle unit.\nWhen Played: If attached unit is Chewbacca, resource the top card of your deck. (It enters play exhausted.)",
  },
  "04010186": {
    cardKey: "04010186", title: "Mist Hunter", subtitle: "The Findsman's Pursuit", type: "Unit", traits: "Underworld|Vehicle|Transport", cost: 3, power: 3, hp: 4, arenas: "Space", unique: true,
    text: "On Attack: If you played a Bounty Hunter or Pilot card this phase, you may draw a card.",
  },
  T153F: { cardKey: "T153F", title: "Hunter", subtitle: "Outcast Sergeant", type: "Unit", traits: "Clone|Republic", cost: 3, power: 3, hp: 3, arenas: "Ground", unique: true, text: "Restore 1" },
  T153G: { cardKey: "T153G", title: "Bounty Hunter", type: "Unit", traits: "Underworld|Bounty Hunter", cost: 2, power: 2, hp: 2, arenas: "Ground", text: "Raid 1" },
  T153H: { cardKey: "T153H", title: "Repair", type: "Event", traits: "Supply", cost: 1, text: "Heal 3 damage from a unit." },
  T153I: { cardKey: "T153I", title: "Field Medic", type: "Unit", traits: "Rebel", cost: 2, power: 1, hp: 3, arenas: "Ground", text: "When Played: Repair the next unit you play this phase. Heal 1 damage from a unit." },
  "08010248": {
    cardKey: "08010248", title: "Neel", subtitle: "The Cutest Boy", type: "Unit", traits: "Fringe", cost: 1, power: 1, hp: 4, arenas: "Ground", unique: true,
    text: "When Played/On Attack: The next unit you play this phase with 1 or less power enters play ready.",
  },
  T153J: { cardKey: "T153J", title: "Big Raider", type: "Unit", traits: "Tusken", cost: 4, power: 4, hp: 4, arenas: "Ground", text: "While you control another Tusken unit, this unit gains Raid 2." },
  T153K: { cardKey: "T153K", title: "Small Raider", type: "Unit", traits: "Tusken", cost: 2, power: 1, hp: 2, arenas: "Ground", text: "While you control another Tusken unit, this unit gains Raid 2." },
  T153L: { cardKey: "T153L", title: "Rage Charm", type: "Upgrade", traits: "Condition", cost: 1, text: "Attached unit gains Raid 2." },
  T153M: { cardKey: "T153M", title: "Fleet Captain", type: "Unit", traits: "Imperial|Official", cost: 3, power: 2, hp: 3, arenas: "Ground", text: "Each friendly Vehicle unit gets +1/+0 and gains Overwhelm." },
} satisfies Record<string, Spec>;

type Key = keyof typeof CARDS;
const KEYS = Object.keys(CARDS) as Key[];
const FEATURES = KEYS.map((k) => featuresOf(CARDS[k]));
const feat = (k: Key) => FEATURES[KEYS.indexOf(k)];
const graph = buildPairGraph(synergyCardsSchema.parse(FEATURES), COMMITTED_TABLE);
const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

describe("defect 1: every play that pays the cost is a paid play", () => {
  for (const k of ["06010257", "05010125", "07010264"] as const) {
    it(`${k} ${CARDS[k].title} offers paid-play, not cheat-play`, () => {
      expect(offerTags(feat(k))).toContain("offers:paid-play");
      expect(offerTags(feat(k))).not.toContain("offers:cheat-play");
    });
  }
  it("a cost reduction short of zero is still a paid play", () => {
    expect(offerTags(feat("T153A"))).toContain("offers:paid-play");
    expect(offerTags(feat("T153A"))).not.toContain("offers:cheat-play");
  });
  it("08010245 Eye of Sion's 'Play it for free' stays cheat-play", () => {
    expect(offerTags(feat("08010245"))).toContain("offers:cheat-play");
    expect(offerTags(feat("08010245"))).not.toContain("offers:paid-play");
  });
  it("06010257 Restore Freedom feeds 09010216 Insurgent Camp through paid-play-trigger, not play-trigger-payoff", () => {
    expect(rowsOf("06010257", "09010216")).toContain("paid-play-trigger");
    expect(rowsOf("06010257", "09010216")).not.toContain("play-trigger-payoff");
  });
});

describe("defect 2: a condition on what an opponent controls is fed only from the opponent's side", () => {
  it("05010248 Jocasta Nu moving a friendly upgrade does not feed 06010095 Theed Security", () => {
    expect(rowsOf("05010248", "06010095")).not.toContain("upgrade-stacking");
  });
  it("05010248 Jocasta Nu still feeds a 'you control an upgrade' condition", () => {
    expect(rowsOf("05010248", "T153B")).toContain("upgrade-stacking");
  });
  it("damage to a friendly unit does not feed 04010238 Sith Trooper's count of damaged units the defending player controls", () => {
    expect(rowsOf("T153C", "04010238")).toEqual([]);
  });
  it("damage to any unit still feeds 04010238 Sith Trooper", () => {
    expect(rowsOf("T153D", "04010238")).toContain("ping-own-damage-payoff");
  });
});

describe("defect 3: a want every deck feeds by paying costs is generically fed", () => {
  it("the table marks wants:exhausted-resources generically fed, with a note", () => {
    const hit = (COMMITTED_TABLE.genericallyFed ?? []).find((g) => g.tag === "wants:exhausted-resources");
    expect(hit?.note).toMatch(/pay/i);
  });
  it("08010216 Mandalorian Scout, which exhausts a resource without paying, stays a specific feeder of 09010117 Chewbacca", () => {
    expect(rowsOf("08010216", "09010117")).toContain("exhaust-resource-payoff");
  });
  it("a card that only costs resources is no pairing feeder of 09010117 Chewbacca", () => {
    expect(rowsOf("T153E", "09010117")).toEqual([]);
  });
});

describe("defect 4: a card that names another card by title links to it", () => {
  it("09010127 Chewbacca's Bowcaster links to 09010117 Chewbacca through name-reference, quoting the naming clause", () => {
    const edge = graph.edgeByKey.get("09010127>09010117");
    expect(edge?.rows.map((r) => r.row)).toContain("name-reference");
    const byKey = graph.byKey;
    const ev = edgeEvidence(byKey.get("09010127")!, byKey.get("09010117")!, edge!.rows.filter((r) => r.row === "name-reference"));
    expect(ev[0].offer).toBe("text: When Played: If attached unit is Chewbacca, resource the top card of your deck.");
    expect(ev[0].want).toBe("title: Chewbacca");
  });
  it("name-reference outranks every other row", () => {
    const top = Math.max(...COMMITTED_TABLE.rows.filter((r) => r.id !== "name-reference").map((r) => r.strength));
    const name = COMMITTED_TABLE.rows.find((r) => r.id === "name-reference");
    expect(name?.strength ?? 0).toBeGreaterThan(top);
  });
  it("a trait that contains a title ('Bounty Hunter') does not name 'Hunter'", () => {
    expect(rowsOf("04010186", "T153F")).not.toContain("name-reference");
  });
  it("a title that is also a trait is never a name", () => {
    expect(rowsOf("04010186", "T153G")).not.toContain("name-reference");
  });
  it("a one-word title of a non-unique card ('Repair') is a generic word, not a name", () => {
    expect(rowsOf("T153I", "T153H")).not.toContain("name-reference");
  });
  it("the named card does not link back to the namer, and a card never names itself", () => {
    expect(rowsOf("09010117", "09010127")).not.toContain("name-reference");
    expect(rowsOf("09010127", "09010127")).toEqual([]);
  });
});

describe("defect 5: Neel readies the 0-power Chewbacca", () => {
  it("09010117 Chewbacca's self-granted Raid wants extra attacks", () => {
    expect(wantTags(feat("09010117"))).toContain("wants:extra-attacks");
  });
  it("08010248 Neel feeds 09010117 Chewbacca (printed power 0) through ready-reuse", () => {
    expect(rowsOf("08010248", "09010117")).toContain("ready-reuse");
  });
  it("08010248 Neel feeds a 1-power self-Raid unit", () => {
    expect(rowsOf("08010248", "T153K")).toContain("ready-reuse");
  });
  it("an upgrade's 'Attached unit gains Raid 2' is no self-grant and wants no extra attacks", () => {
    expect(wantTags(feat("T153L"))).not.toContain("wants:extra-attacks");
  });
  it("a unit that gives a keyword to other units ('Each friendly Vehicle unit ... gains Overwhelm') wants no extra attacks for it", () => {
    expect(wantTags(feat("T153M"))).not.toContain("wants:extra-attacks");
  });
  it("08010248 Neel does not feed a 4-power self-Raid unit", () => {
    expect(rowsOf("08010248", "T153J")).not.toContain("ready-reuse");
  });
});

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/archetypes.json"));
const OWNER_DECK: unknown = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe.skipIf(!hasData)("defect 3 on the owner's Warrior / Origin Tree deck (built data)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  it("deck_audit lists 09010117 Chewbacca, Resourceful Wookiee as neither an orphan nor an unfed generic want", () => {
    const out = body(DECK_TOOLS.deck_audit.handler(real, { swudb: OWNER_DECK }));
    const orphans = (out.orphanWants as { cardKey: string }[]).map((o) => o.cardKey);
    expect(orphans).not.toContain("09010117");
    expect(String(out.genericWants)).not.toContain("Resourceful Wookiee");
  });
});
