import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { reasonOfHit } from "../../src/synergy/reasons.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import { drawbackOf } from "../../src/tools/deck.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#173 items 2, 3 and 4, D91: a take-control-then-defeat defeats a unit you control, an Advantage token given to
// "this unit" stays on the giver, and a clause that readies an enemy unit is a drawback. Judged sessions: scratchpad
// judge-7-w24.md (Cad Bane) and judge-8-w24.md (Warrior, probe w24-blueace.out). Card rows from the 2026-11-01 run (originals
// 2026-10-16), text verbatim.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const NO_GLORY = "04010043";
const KOSKA = "08010079";
const HK47 = "05010130";
const DENGAR = "07010053";
const CHIMAERA = "08010052";
const AXE_UNDAUNTED = "08010169";
const MARROK = "08010030";
const JUSTIFIER = "08010146";
const BLUE_ACE = "06010204";
const JOD = "08010219";
const RAIDING_PARTY = "09010230";
const COMMENCE_PATROL = "04010205";

const CARDS = {
  [NO_GLORY]: {
    cardKey: NO_GLORY, title: "No Glory, Only Results", type: "Event", cost: 5, aspects: "Vigilance|Villainy", traits: "Tactic", unique: true,
    text: "Take control of a non-leader unit, then defeat it.",
  },
  [KOSKA]: {
    cardKey: KOSKA, title: "Koska Reeves", subtitle: "Warrior of Mandalore", type: "Unit", cost: 4, power: 4, hp: 4, arenas: "Ground", aspects: "Vigilance",
    traits: "Mandalorian", keywords: "Sentinel", unique: true,
    text: "While you control a token unit, this unit gains Sentinel.\nWhen Played: If a friendly unit was defeated this phase, create a Mandalorian token.",
  },
  [HK47]: {
    cardKey: HK47, title: "HK-47", subtitle: "Exclamation: Die, Meatbag!", type: "Unit", cost: 2, power: 2, hp: 4, arenas: "Ground", aspects: "Aggression|Villainy",
    traits: "Sith|Droid", unique: true, text: "When an enemy unit is defeated: Deal 1 damage to its controller's base.",
  },
  [DENGAR]: {
    cardKey: DENGAR, title: "Dengar", subtitle: "Take Your Shot", type: "Unit", cost: 3, power: 4, hp: 3, arenas: "Ground", aspects: "Command|Aggression|Villainy",
    traits: "Underworld|Bounty Hunter", unique: true,
    text: "When a unit with the highest cost among enemy units is defeated: Create a Credit token. Use this ability only once each round.",
  },
  [CHIMAERA]: {
    cardKey: CHIMAERA, title: "Chimaera", subtitle: "A Frightening Reality", type: "Unit", cost: 7, power: 6, hp: 6, arenas: "Space", aspects: "Vigilance|Villainy",
    traits: "Imperial|Vehicle|Capital Ship", unique: true,
    text: "When Played: You may choose a friendly unit and an enemy non-leader unit. If you do, defeat those units.\nWhen an enemy unit is defeated: Heal 2 damage from your base.",
  },
  [AXE_UNDAUNTED]: {
    cardKey: AXE_UNDAUNTED, title: "Axe Woves", subtitle: "Undaunted", type: "Unit", cost: 3, power: 2, hp: 4, arenas: "Ground", aspects: "Aggression",
    traits: "Mandalorian", unique: true, text: "When you draw 1 or more cards (including during the regroup phase): Give an Advantage token to this unit.",
  },
  [MARROK]: {
    cardKey: MARROK, title: "Marrok", subtitle: "Mysterious Warrior", type: "Unit", cost: 3, power: 2, hp: 6, arenas: "Ground", aspects: "Vigilance|Aggression|Villainy",
    traits: "Force|Inquisitor", keywords: "Sentinel|Saboteur", unique: true, text: "Sentinel\nWhile this unit is upgraded, he loses Sentinel and gains Saboteur.",
  },
  [JUSTIFIER]: {
    cardKey: JUSTIFIER, title: "Justifier", subtitle: "Relentless", type: "Unit", cost: 5, power: 4, hp: 5, arenas: "Space", aspects: "Aggression|Villainy",
    traits: "Underworld|Vehicle|Transport", unique: true,
    text: "When Played/On Attack: You may deal 1 damage to a unit. If that unit is defeated this way, give an Advantage token to a unit.",
  },
  [BLUE_ACE]: {
    cardKey: BLUE_ACE, title: "Blue Ace", subtitle: "Colorful Racer", type: "Unit", cost: 4, power: 4, hp: 5, arenas: "Space", aspects: "Cunning|Heroism",
    traits: "Resistance|Vehicle|Fighter", keywords: "Ambush", unique: true, text: "Ambush\nOn Attack: Ready an exhausted enemy unit.",
  },
  [JOD]: {
    cardKey: JOD, title: "Jod Na Nawood", subtitle: "Keeping Secrets", type: "Unit", cost: 3, power: 4, hp: 3, arenas: "Ground", aspects: "Cunning",
    traits: "Force|Underworld", keywords: "Sentinel", unique: true,
    text: "Sentinel\nWhen Played: You may pay 4 resources. If you do, choose an arena. Exhaust each unit in that arena.",
  },
  [RAIDING_PARTY]: {
    cardKey: RAIDING_PARTY, title: "Raiding Party", type: "Unit", cost: 5, power: 0, hp: 6, arenas: "Ground", aspects: "Cunning", traits: "Tusken", keywords: "Raid",
    text: "Raid 6 (This unit gets +6/+0 while attacking.)\nWhen Played: If you control another Tusken unit or a Tatooine base, you may exhaust a ground unit.",
  },
  [COMMENCE_PATROL]: {
    cardKey: COMMENCE_PATROL, title: "Commence Patrol", type: "Event", cost: 1, aspects: "Cunning|Heroism", traits: "Tactic",
    text: "Put another card in a discard pile on the bottom of its owner's deck. If you do, create an X-Wing token.",
  },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B173", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => `${r.offer} -> ${r.want}`) ?? [];
const offersOf = (key: string) => (FEATURES.find((f) => f.cardKey === key)?.tags.offers ?? []).map((o) => o.tag);
const wantsOf = (key: string) => (FEATURES.find((f) => f.cardKey === key)?.tags.wants ?? []).map((w) => w.tag);
const synOf = (key: string) => CARDS_ALL.find((c) => c.cardKey === key) as SynergyCard;

describe("take control of a unit, then defeat it, defeats a unit you control (#173 item 2, D91; CR 8.27.1, 8.27.2, 8.11.1)", () => {
  it("No Glory, Only Results offers a friendly-unit defeat, and keeps its enemy-unit removal tag for meta_answers", () => {
    expect(offersOf(NO_GLORY)).toContain("offers:defeat-friendly-unit");
    expect(offersOf(NO_GLORY)).toContain("offers:defeat-enemy-unit");
  });

  it("it is no sacrifice outlet: the unit it defeats is the one taken from an opponent, so it wants no fodder of yours", () => {
    expect(wantsOf(NO_GLORY)).not.toContain("wants:sac-fodder");
  });

  it("it feeds Koska Reeves' 'If a friendly unit was defeated this phase', and the link is not worded as a sacrifice outlet", () => {
    expect(rowsOf(NO_GLORY, KOSKA)).toContain("offers:defeat-friendly-unit -> wants:friendly-unit-defeated");
    const edge = graph.edgeByKey.get(`${NO_GLORY}>${KOSKA}`);
    const hit = edge?.rows.find((r) => r.offer === "offers:defeat-friendly-unit");
    expect(edge !== undefined && hit !== undefined ? reasonOfHit(graph, edge, hit) : "").toMatch(/^It takes control of a unit, then defeats it: .*CR 8\.27\.1/);
  });

  it("it never feeds 'when an enemy unit is defeated' (HK-47, Dengar, Chimaera): the unit is yours when it leaves play", () => {
    expect(rowsOf(NO_GLORY, HK47)).toEqual([]);
    expect(rowsOf(NO_GLORY, DENGAR)).toEqual([]);
    expect(rowsOf(NO_GLORY, CHIMAERA).filter((r) => r.endsWith("wants:enemy-unit-defeated"))).toEqual([]);
  });

  it("the defeated unit goes to its owner's discard pile, so it fills none of yours (Commence Patrol reads any pile, but no fill-discard row)", () => {
    expect(rowsOf(NO_GLORY, COMMENCE_PATROL).filter((r) => r.endsWith("wants:cards-in-discard"))).toEqual([]);
  });

  it("a defeat with no take-control first is unchanged: Chimaera's enemy defeat still feeds HK-47", () => {
    expect(rowsOf(CHIMAERA, HK47).some((r) => r.endsWith("-> wants:enemy-unit-defeated"))).toBe(true);
  });
});

describe("an Advantage token given to 'this unit' stays on the giver (#173 item 3, D91)", () => {
  it("Axe Woves, Undaunted offers give-advantage-self, not give-advantage", () => {
    expect(offersOf(AXE_UNDAUNTED)).toContain("offers:give-advantage-self");
    expect(offersOf(AXE_UNDAUNTED)).not.toContain("offers:give-advantage");
  });

  it("Axe Woves, Undaunted does not feed Marrok; Justifier's 'to a unit' still does", () => {
    expect(rowsOf(AXE_UNDAUNTED, MARROK)).toEqual([]);
    expect(rowsOf(JUSTIFIER, MARROK)).toContain("offers:give-advantage -> wants:upgrades-attached");
  });

  it("give-advantage-self is reviewed as feeding nothing, like give-shield-self and give-experience-self", () => {
    expect((COMMITTED_TABLE.feedsNothing ?? []).map((n) => n.tag)).toContain("offers:give-advantage-self");
  });
});

describe("a clause that readies an enemy unit is a drawback, not a want (#173 item 4, D91)", () => {
  it("Blue Ace's 'On Attack: Ready an exhausted enemy unit' is no wants:exhausted-enemy", () => {
    expect(wantsOf(BLUE_ACE)).not.toContain("wants:exhausted-enemy");
  });

  it("Jod Na Nawood and Raiding Party, which exhaust enemy units, do not feed Blue Ace", () => {
    expect(rowsOf(JOD, BLUE_ACE)).toEqual([]);
    expect(rowsOf(RAIDING_PARTY, BLUE_ACE)).toEqual([]);
  });

  it("the clause is printed as the card's drawback", () => {
    expect(drawbackOf(synOf(BLUE_ACE))).toBe("Ready an exhausted enemy unit.");
  });
});
