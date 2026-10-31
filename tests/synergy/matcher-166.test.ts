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

// LampaGJ/swu-mcp#166 items 1 and 6, D84: an offer reaches only what its text names (a non-unit leader, a unit an opponent
// controls, a unit with 6 or more power, a Force upgrade), and "can't attack unless it's damaged" wants the card damaged.
// Judged sessions: scratchpad judge-8-w19.md (Warrior) and judge-7-w19.md (Cad Bane). Card rows from the 2026-11-01 run
// (originals 2026-10-16), text verbatim.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const TRAYA = "06010188";
const CHEWBACCA = "09010117";
const INSURGENT_CAMP = "09010216";
const BEGUILE = "06010233";
const EXPLOIT = "09010238";
const TIE_DAGGER = "04010239";
const FAR_FAR_AWAY = "08010236";
const PADAWAN = "0301058";
const LAST_WORDS = "05010263";
const MARROK = "08010030";
const OGGDO = "05010063";
const CAD_BANE = "08010011";
const LOBOT_LIKE = "T166GRIT";
const BIG_UNIT = "T166BIG";
const FORCE_SABER = "T166SABER";

const CARDS = {
  [TRAYA]: {
    cardKey: TRAYA, title: "Darth Traya", subtitle: "Lord of Betrayal", type: "Unit", cost: 3, power: 2, hp: 5, arenas: "Ground", aspects: "Cunning|Villainy", traits: "Force|Sith", unique: true,
    text: "On Attack: You may ready a non-unit leader.",
  },
  [CHEWBACCA]: {
    cardKey: CHEWBACCA, title: "Chewbacca", subtitle: "Resourceful Wookiee", type: "Unit", cost: 3, power: 0, hp: 5, arenas: "Ground", aspects: "Command|Heroism", traits: "Wookiee", keywords: "Raid|Overwhelm", unique: true,
    text: "This unit gains Raid 1 for each exhausted resource you control.\nWhile each resource you control is exhausted, this unit gains Overwhelm.",
  },
  [INSURGENT_CAMP]: {
    cardKey: INSURGENT_CAMP, title: "Insurgent Camp", type: "Upgrade", cost: 1, aspects: "Cunning", traits: "Fortification", keywords: "Fortify",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  [BEGUILE]: {
    cardKey: BEGUILE, title: "Beguile", type: "Event", cost: 3, aspects: "Cunning", traits: "Trick",
    text: "Look at an opponent's hand. Then, choose a non-leader unit that opponent controls that costs 6 or less and return it to its owner's hand.",
  },
  [EXPLOIT]: { cardKey: EXPLOIT, title: "Exploit Confidence", type: "Event", cost: 2, aspects: "Cunning", traits: "Tactic", text: "Return a non-leader unit with 6 or more power to its owner's hand." },
  [TIE_DAGGER]: {
    cardKey: TIE_DAGGER, title: "TIE Dagger Vanguard", type: "Unit", cost: 3, power: 2, hp: 2, arenas: "Space", aspects: "Villainy", traits: "First Order|Sith|Vehicle|Fighter",
    text: "When Played: You may deal 2 damage to a damaged unit.",
  },
  [BIG_UNIT]: {
    cardKey: BIG_UNIT, title: "Big Test Unit", type: "Unit", cost: 6, power: 7, hp: 7, arenas: "Ground", aspects: "Cunning", traits: "Fringe",
    text: "When Played: Deal 2 damage to a unit.",
  },
  [FAR_FAR_AWAY]: { cardKey: FAR_FAR_AWAY, title: "Far Far Away", type: "Event", cost: 3, aspects: "Cunning", traits: "Force", text: "Return a friendly non-leader unit to its owner's hand." },
  [PADAWAN]: {
    cardKey: PADAWAN, title: "Padawan Starfighter", type: "Unit", cost: 2, power: 1, hp: 3, arenas: "Space", aspects: "Vigilance", traits: "Jedi|Republic|Vehicle|Fighter",
    text: "While you control a Force unit or a Force upgrade, this unit gets +1/+1.",
  },
  [FORCE_SABER]: { cardKey: FORCE_SABER, title: "Test Force Saber", type: "Upgrade", cost: 2, aspects: "Vigilance", traits: "Force|Item|Lightsaber", text: "Attached unit gets +2/+0." },
  [LAST_WORDS]: { cardKey: LAST_WORDS, title: "Last Words", type: "Event", cost: 2, traits: "Learned", text: "If a friendly unit was defeated this phase, give 2 Experience tokens to a unit." },
  [MARROK]: {
    cardKey: MARROK, title: "Marrok", subtitle: "Mysterious Warrior", type: "Unit", cost: 3, power: 2, hp: 6, arenas: "Ground", aspects: "Vigilance|Aggression|Villainy", traits: "Force|Inquisitor", keywords: "Sentinel|Saboteur", unique: true,
    text: "Sentinel\nWhile this unit is upgraded, he loses Sentinel and gains Saboteur.",
  },
  [OGGDO]: {
    cardKey: OGGDO, title: "Oggdo Bogdo", subtitle: "Bogano Brute", type: "Unit", cost: 3, power: 5, hp: 5, arenas: "Ground", aspects: "Vigilance", traits: "Creature", unique: true,
    text: "This unit can't attack unless it's damaged.\nWhen this unit attacks and defeats a unit: Heal 2 damage from this unit.",
  },
  [LOBOT_LIKE]: { cardKey: LOBOT_LIKE, title: "Grit Test Unit", type: "Unit", cost: 2, power: 1, hp: 4, arenas: "Ground", aspects: "Vigilance", traits: "Fringe", keywords: "Grit", text: "Grit" },
  [CAD_BANE]: {
    cardKey: CAD_BANE, title: "Cad Bane", subtitle: "Still Faster than You", type: "Leader", cost: 6, power: 4, hp: 7, arenas: "Ground", aspects: "Aggression|Villainy", traits: "Underworld|Bounty Hunter", keywords: "Overwhelm", unique: true,
    text: "Action [Exhaust]: Deal 1 damage to a unit with 2 or more remaining HP.",
    deployBox: "Overwhelm (When attacking an enemy unit, deal excess damage to the opponent's base.)\nOn Attack: You may deal 1 damage to a unit with 2 or more remaining HP.",
    epicAction: "Epic Action: If you control 6 or more resources, deploy this leader.",
  },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B166", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const wantsOf = (k: string) => card(k).tags.wants.map((t) => t.tag);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => r.row) ?? [];

describe("a ready of a non-unit leader readies no unit (#166 item 1)", () => {
  it("Darth Traya gives Chewbacca no extra attack; Insurgent Camp still does", () => {
    expect(rowsOf(TRAYA, CHEWBACCA)).toEqual([]);
    expect(rowsOf(INSURGENT_CAMP, CHEWBACCA)).toContain("ready-reuse");
  });
});

describe("a bounce reaches only the units its text names (#166 item 1)", () => {
  it("Beguile returns a unit that opponent controls, so it replays none of your When Played units", () => {
    expect(rowsOf(BEGUILE, TIE_DAGGER)).toEqual([]);
    expect(rowsOf(BEGUILE, BIG_UNIT)).toEqual([]);
  });
  it("Exploit Confidence returns a unit with 6 or more power: not the 2-power TIE Dagger Vanguard, but a 7-power unit", () => {
    expect(rowsOf(EXPLOIT, TIE_DAGGER)).toEqual([]);
    expect(rowsOf(EXPLOIT, BIG_UNIT)).toContain("bounce-replay");
  });
  it("Far Far Away still replays TIE Dagger Vanguard", () => {
    expect(rowsOf(FAR_FAR_AWAY, TIE_DAGGER)).toContain("bounce-replay");
  });
});

describe("a want for an upgrade of a trait is fed only by an upgrade of that trait (#166 item 1)", () => {
  it("Padawan Starfighter wants a Force upgrade: Last Words' Experience tokens do not feed it, a Force upgrade does", () => {
    expect(rowsOf(LAST_WORDS, PADAWAN)).toEqual([]);
    expect(rowsOf(FORCE_SABER, PADAWAN)).toContain("upgrade-stacking");
  });
  it("Marrok wants any upgrade, so Last Words still feeds him", () => {
    expect(rowsOf(LAST_WORDS, MARROK)).toContain("upgrade-stacking");
  });
});

describe("\"can't attack unless it's damaged\" wants the card damaged (#166 item 6)", () => {
  it("Oggdo Bogdo wants:self-damaged, like a Grit unit", () => {
    expect(wantsOf(OGGDO)).toContain("wants:self-damaged");
    expect(wantsOf(LOBOT_LIKE)).toContain("wants:self-damaged");
  });
  it("Cad Bane's ping and TIE Dagger Vanguard's damage feed Oggdo Bogdo", () => {
    expect(rowsOf(CAD_BANE, OGGDO).length).toBeGreaterThan(0);
    expect(rowsOf(CAD_BANE, LOBOT_LIKE)).toEqual(rowsOf(CAD_BANE, OGGDO));
  });
});
