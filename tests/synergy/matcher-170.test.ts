import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#170 items 1, 2 and 5, D89: an Advantage token is an upgrade, a return of the card's own discards wants no
// filled pile, and "an upgraded base" wants a Fortify upgrade. Judged sessions: scratchpad judge-7-w23.md (Cad Bane) and
// judge-8-w23.md (Warrior). Card rows from the 2026-11-01 run (originals 2026-10-16), text verbatim.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const MARROK = "08010030";
const JUSTIFIER = "08010146";
const BOSHEK = "04010215";
const BT1 = "07010173";
const AMIDALA = "09010260";
const CAMP = "09010216";
const BOWCASTER = "09010127";

const CARDS = {
  [MARROK]: {
    cardKey: MARROK, title: "Marrok", subtitle: "Mysterious Warrior", type: "Unit", cost: 3, power: 2, hp: 6, arenas: "Ground", aspects: "Vigilance|Aggression|Villainy",
    traits: "Force|Inquisitor", keywords: "Sentinel|Saboteur", unique: true, text: "Sentinel\nWhile this unit is upgraded, he loses Sentinel and gains Saboteur.",
  },
  [JUSTIFIER]: {
    cardKey: JUSTIFIER, title: "Justifier", subtitle: "Relentless", type: "Unit", cost: 5, power: 4, hp: 5, arenas: "Space", aspects: "Aggression|Villainy",
    traits: "Underworld|Vehicle|Transport", unique: true,
    text: "When Played/On Attack: You may deal 1 damage to a unit. If that unit is defeated this way, give an Advantage token to a unit.",
  },
  [BOSHEK]: {
    cardKey: BOSHEK, title: "BoShek", subtitle: "Charismatic Smuggler", type: "Unit", cost: 3, power: 3, hp: 4, arenas: "Ground", aspects: "Cunning",
    traits: "Fringe|Pilot", keywords: "Piloting", unique: true, text: "",
    epicAction: "Piloting [2 resources Cunning] (You may play this as an upgrade on a friendly Vehicle without a Pilot.)\nWhen played as an upgrade: Discard 2 cards from your deck. Return each of those cards with an odd cost to your hand.",
  },
  [BT1]: {
    cardKey: BT1, title: "BT-1", subtitle: "Blastomech", type: "Unit", cost: 2, power: 2, hp: 4, arenas: "Ground", aspects: "Aggression|Villainy", traits: "Underworld|Droid", unique: true,
    text: "On Attack: Discard a card from your deck. If it's Aggression, you may deal 1 damage to a ground unit.",
  },
  [AMIDALA]: {
    cardKey: AMIDALA, title: "Queen Amidala", subtitle: "Retaking Theed", type: "Unit", cost: 4, power: 4, hp: 4, arenas: "Ground", aspects: "Heroism",
    traits: "Naboo|Official", keywords: "Restore", unique: true, text: "If you control an upgraded base, this unit costs 2 resources less to play.\nRestore 2",
  },
  [CAMP]: {
    cardKey: CAMP, title: "Insurgent Camp", type: "Upgrade", cost: 1, aspects: "Cunning|Heroism", traits: "Fortification", keywords: "Fortify",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  [BOWCASTER]: {
    cardKey: BOWCASTER, title: "Chewbacca's Bowcaster", subtitle: "Handcrafted Tradition", type: "Upgrade", cost: 3, aspects: "Command|Heroism", traits: "Item|Weapon", unique: true,
    text: "Attach to a non-Vehicle unit.\nWhen Played: If attached unit is Chewbacca, resource the top card of your deck. (It enters play exhausted.)",
  },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B170", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => `${r.offer} -> ${r.want}`) ?? [];
const wantsOf = (key: string) => (FEATURES.find((f) => f.cardKey === key)?.tags.wants ?? []).map((w) => w.tag);

describe("an Advantage token is a Token Upgrade, so it feeds an 'upgraded' want (#170 item 1, D89)", () => {
  it("Justifier's Advantage token feeds Marrok's 'While this unit is upgraded'", () => {
    expect(rowsOf(JUSTIFIER, MARROK)).toContain("offers:give-advantage -> wants:upgrades-attached");
  });

  it("the token is discarded after the attack, so it feeds the upgrade-stacking row below a lasting upgrade", () => {
    const row = COMMITTED_TABLE.rows.find((r) => r.id === "upgrade-stacking");
    const advantage = row?.offers["offers:give-advantage"] ?? 0;
    expect(advantage).toBeGreaterThan(0);
    expect(advantage).toBeLessThan(row?.offers["offers:give-experience"] ?? 0);
    expect((COMMITTED_TABLE.feedsNothing ?? []).map((n) => n.tag)).not.toContain("offers:give-advantage");
  });
});

describe("a return of the card's own discards wants no filled discard pile (#170 item 2, D89)", () => {
  it("BoShek returns 'each of those cards' it discarded itself: no wants:cards-in-discard, and BT-1's self-mill does not feed it", () => {
    expect(wantsOf(BOSHEK)).not.toContain("wants:cards-in-discard");
    expect(rowsOf(BT1, BOSHEK)).toEqual([]);
  });
});

describe("'an upgraded base' wants a Fortify upgrade (#170 item 5, D89)", () => {
  it("Queen Amidala, Retaking Theed reads as wants:base-upgrade, not as an upgraded unit", () => {
    expect(wantsOf(AMIDALA)).toContain("wants:base-upgrade");
    expect(wantsOf(AMIDALA)).not.toContain("wants:upgrades-attached");
  });

  it("a Fortify upgrade (Insurgent Camp) feeds her; an upgrade attached to a unit (Chewbacca's Bowcaster) does not", () => {
    expect(rowsOf(CAMP, AMIDALA).some((r) => r.endsWith("-> wants:base-upgrade"))).toBe(true);
    expect(rowsOf(BOWCASTER, AMIDALA)).toEqual([]);
  });

  it("a unit-upgraded want still takes unit upgrades and refuses a Fortify upgrade (D74)", () => {
    expect(rowsOf(BOWCASTER, MARROK)).toContain("offers:upgrade-to-attach -> wants:upgrades-attached");
    expect(rowsOf(CAMP, MARROK)).toEqual([]);
  });
});
