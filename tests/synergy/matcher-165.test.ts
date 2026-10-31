import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { evidenceSpan } from "../../src/synergy/evidence.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema, type SynergyCard, type TrioRecord } from "../../src/synergy/schema.js";
import { searchTrios } from "../../src/synergy/trios.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#165 items 1 to 6, D83: harmful upgrades, a cross-clause pronoun, self-only heals and bounces, defeats that
// meet no "this phase" want, and a name-locked offer. Judged session: scratchpad judge-7-w18.md (Cad Bane). Card rows from the
// 2026-11-01 run (originals 2026-10-16), text verbatim; DARTH_MAUL_UNIT is a test fixture standing in for a Darth Maul unit.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CONDEMN = "06010038";
const JOCASTA = "05010248";
const MARROK = "08010030";
const AMBITIONS_REWARD = "06010175";
const TREE = "07010132";
const LAST_WORDS = "05010263";
const OGGDO = "05010063";
const SILVER_ANGEL = "04010062";
const REPAIR = "0101074";
const GRIEVOUS = "06010187";
const TIE_DAGGER = "04010239";
const FAR_FAR_AWAY = "08010236";
const TRAP_FIELD = "09010171";
const SALVAGED = "07010245";
const CONTRACTED = "04010216";
const KOSKA = "08010079";
const POACHER = "09010153";
const MAUL_SABER = "05010140";
const MIGS = "08010168";
const DARTH_MAUL_UNIT = "T165MAUL";

const CARDS = {
  [CONDEMN]: {
    cardKey: CONDEMN, title: "Condemn", type: "Upgrade", cost: 3, aspects: "Vigilance|Villainy", traits: "Condition",
    text: "While attached unit is attacking, it gains: “On Attack: The defending player may disclose VigilanceVillainy. If they do, this unit gets –6/–0 for this attack” and loses all other abilities.",
  },
  [JOCASTA]: {
    cardKey: JOCASTA, title: "Jocasta Nu", subtitle: "The Gift of Knowledge", type: "Unit", cost: 3, power: 3, hp: 4, arenas: "Ground", aspects: "Heroism", traits: "Force|Jedi|Republic", unique: true,
    text: "When Played: You may attach a friendly upgrade on a friendly unit to a different eligible unit.",
  },
  [MARROK]: {
    cardKey: MARROK, title: "Marrok", subtitle: "Mysterious Warrior", type: "Unit", cost: 3, power: 2, hp: 6, arenas: "Ground", aspects: "Vigilance|Aggression|Villainy", traits: "Force|Inquisitor", keywords: "Sentinel|Saboteur", unique: true,
    text: "Sentinel\nWhile this unit is upgraded, he loses Sentinel and gains Saboteur.",
  },
  [AMBITIONS_REWARD]: { cardKey: AMBITIONS_REWARD, title: "Ambition's Reward", type: "Upgrade", cost: 2, aspects: "Aggression", traits: "Law", text: "When Played: Create a Spy token." },
  [TREE]: { cardKey: TREE, title: "The Tree Remembers", type: "Event", cost: 4, aspects: "Vigilance", traits: "Tactic", text: "An enemy unit loses all abilities for this phase. If it costs 3 or less, defeat it." },
  [LAST_WORDS]: { cardKey: LAST_WORDS, title: "Last Words", type: "Event", cost: 2, traits: "Learned", text: "If a friendly unit was defeated this phase, give 2 Experience tokens to a unit." },
  [OGGDO]: {
    cardKey: OGGDO, title: "Oggdo Bogdo", subtitle: "Bogano Brute", type: "Unit", cost: 3, power: 5, hp: 5, arenas: "Ground", aspects: "Vigilance", traits: "Creature", unique: true,
    text: "This unit can't attack unless it's damaged.\nWhen this unit attacks and defeats a unit: Heal 2 damage from this unit.",
  },
  [SILVER_ANGEL]: {
    cardKey: SILVER_ANGEL, title: "Silver Angel", subtitle: "Trace's Hope", type: "Unit", cost: 2, power: 2, hp: 3, arenas: "Space", aspects: "Vigilance", traits: "Fringe|Vehicle|Transport", unique: true,
    text: "When 1 or more damage is healed from this unit: You may deal 1 damage to a space unit.",
  },
  [REPAIR]: { cardKey: REPAIR, title: "Repair", type: "Event", cost: 1, aspects: "Vigilance", traits: "Supply", text: "Heal 3 damage from a unit or base." },
  [GRIEVOUS]: {
    cardKey: GRIEVOUS, title: "General Grievous", subtitle: "Scuttling to Safety", type: "Unit", cost: 2, power: 3, hp: 3, arenas: "Ground", aspects: "Cunning|Villainy", traits: "Separatist|Official", keywords: "Hidden", unique: true,
    text: "Hidden (This unit can't be attacked if he was played this phase.)\nWhen this unit is attacked: Return him to his owner's hand (before damage is dealt).",
  },
  [TIE_DAGGER]: {
    cardKey: TIE_DAGGER, title: "TIE Dagger Vanguard", type: "Unit", cost: 3, power: 2, hp: 2, arenas: "Space", aspects: "Villainy", traits: "First Order|Sith|Vehicle|Fighter",
    text: "When Played: You may deal 2 damage to a damaged unit.",
  },
  [FAR_FAR_AWAY]: { cardKey: FAR_FAR_AWAY, title: "Far Far Away", type: "Event", cost: 3, aspects: "Cunning", traits: "Force", text: "Return a friendly non-leader unit to its owner's hand." },
  [TRAP_FIELD]: {
    cardKey: TRAP_FIELD, title: "Trap Field", type: "Upgrade", cost: 2, aspects: "Aggression|Heroism", traits: "Fortification", keywords: "Fortify",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen a non-leader ground unit enters play (including token units): You may defeat this upgrade. If you do, deal 3 damage to that unit.",
  },
  [SALVAGED]: {
    cardKey: SALVAGED, title: "Salvaged Materials", type: "Event", cost: 1, aspects: "Cunning", traits: "Supply",
    text: "Play an Item upgrade from your discard pile. It costs 3 resources less. At the start of the next regroup phase, defeat it.",
  },
  [CONTRACTED]: {
    cardKey: CONTRACTED, title: "Contracted Hunter", type: "Unit", cost: 3, power: 4, hp: 4, arenas: "Ground", aspects: "Cunning", traits: "Underworld|Bounty Hunter", keywords: "Ambush",
    text: "Ambush (When you play this unit, it may attack an enemy unit.)\nWhen the regroup phase starts: Defeat this unit.",
  },
  [KOSKA]: {
    cardKey: KOSKA, title: "Koska Reeves", subtitle: "Warrior of Mandalore", type: "Unit", cost: 4, power: 4, hp: 4, arenas: "Ground", aspects: "Vigilance", traits: "Mandalorian", keywords: "Sentinel", unique: true,
    text: "While you control a token unit, this unit gains Sentinel.\nWhen Played: If a friendly unit was defeated this phase, create a Mandalorian token.",
  },
  [POACHER]: {
    cardKey: POACHER, title: "Poacher's Starfighter", type: "Unit", cost: 2, power: 3, hp: 1, arenas: "Space", aspects: "Aggression|Villainy", traits: "Underworld|Vehicle|Fighter",
    text: "When Played: You may defeat this unit. If you do, create a Beast token and deal 1 damage to it.",
  },
  [MAUL_SABER]: {
    cardKey: MAUL_SABER, title: "Darth Maul's Lightsaber", type: "Upgrade", cost: 3, aspects: "Aggression|Villainy", traits: "Item|Weapon|Lightsaber",
    text: "Attach to a friendly non-Vehicle unit.\nWhen Played: If attached unit is Darth Maul, you may attack with him. For this attack, he gains Overwhelm and can't attack bases.",
  },
  [MIGS]: {
    cardKey: MIGS, title: "Migs Mayfeld", subtitle: "How About a Toast?", type: "Unit", cost: 2, power: 2, hp: 3, arenas: "Ground", aspects: "Aggression", traits: "Fringe", keywords: "Support", unique: true,
    text: "Support\nOn Attack: Deal 1 damage to the defending unit. If this unit is upgraded, deal 2 damage to the defending unit instead.",
  },
  [DARTH_MAUL_UNIT]: {
    cardKey: DARTH_MAUL_UNIT, title: "Darth Maul", subtitle: "Test Fixture", type: "Unit", cost: 5, power: 5, hp: 5, arenas: "Ground", aspects: "Aggression|Villainy", traits: "Force|Sith", unique: true,
    text: "On Attack: Deal 1 damage to a unit.",
  },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B165", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const offersOf = (k: string) => card(k).tags.offers.map((t) => t.tag);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => r.row) ?? [];
const allTrios: TrioRecord[] = Object.values(searchTrios(graph, coverCombos(CARDS_ALL)).trios).flat();
const trioOf = (...keys: string[]): TrioRecord | undefined => allTrios.find((t) => keys.every((k) => [t.cardA, t.cardB, t.cardC].includes(k)));

describe("an upgrade that harms its carrier feeds no friendly upgrade want (#165 item 1)", () => {
  it("Condemn (\"loses all other abilities\" while attacking, -6/-0) feeds neither Jocasta Nu's move nor Marrok", () => {
    expect(rowsOf(CONDEMN, JOCASTA)).toEqual([]);
    expect(rowsOf(CONDEMN, MARROK)).toEqual([]);
    expect(trioOf(CONDEMN, JOCASTA, MARROK)).toBeUndefined();
  });
  it("a plain upgrade still feeds both: Ambition's Reward -> Jocasta Nu and -> Marrok", () => {
    expect(rowsOf(AMBITIONS_REWARD, JOCASTA)).toContain("upgrade-stacking");
    expect(rowsOf(AMBITIONS_REWARD, MARROK)).toContain("upgrade-stacking");
  });
});

describe("a pronoun with its antecedent in the clause before is read from that clause (#165 item 2)", () => {
  it("The Tree Remembers defeats the enemy unit of its first clause, not itself", () => {
    expect(offersOf(TREE)).toContain("offers:defeat-enemy-unit");
    expect(offersOf(TREE)).not.toContain("offers:defeat-self");
  });
  it("The Tree Remembers feeds no friendly-defeat want (Last Words), so no trio rests on it", () => {
    expect(rowsOf(TREE, LAST_WORDS)).toEqual([]);
    expect(trioOf(TREE, LAST_WORDS, MARROK)).toBeUndefined();
  });
});

describe("a heal or a bounce that can only land on the card itself feeds no other card (#165 items 3 and 4)", () => {
  it("Oggdo Bogdo heals only himself: offers:heal-self, no link to Silver Angel; Repair still feeds Silver Angel", () => {
    expect(offersOf(OGGDO)).toContain("offers:heal-self");
    expect(offersOf(OGGDO)).not.toContain("offers:heal");
    expect(rowsOf(OGGDO, SILVER_ANGEL)).toEqual([]);
    expect(rowsOf(REPAIR, SILVER_ANGEL)).toContain("heal-payoff");
  });
  it("General Grievous returns only himself: offers:return-self-to-hand, no link to TIE Dagger Vanguard; Far Far Away still feeds it", () => {
    expect(offersOf(GRIEVOUS)).toContain("offers:return-self-to-hand");
    expect(offersOf(GRIEVOUS)).not.toContain("offers:return-own-to-hand");
    expect(rowsOf(GRIEVOUS, TIE_DAGGER)).toEqual([]);
    expect(rowsOf(FAR_FAR_AWAY, TIE_DAGGER)).toContain("bounce-replay");
  });
  it("a replay want quotes the card's When Played clause, not the category label (\"When Played (damage)\")", () => {
    const why = card(TIE_DAGGER).tags.wants.find((t) => t.tag === "wants:replay-when-played")?.why as string;
    expect(why).toMatch(/When Played \(/);
    expect(evidenceSpan(card(TIE_DAGGER), why)).toBe("text: When Played: You may deal 2 damage to a damaged unit.");
  });
});

describe("a defeat that meets no friendly-unit-defeated-this-phase want (#165 item 5)", () => {
  it("Trap Field and Salvaged Materials defeat an upgrade, not a unit", () => {
    expect(offersOf(TRAP_FIELD)).toContain("offers:defeat-own-upgrade");
    expect(offersOf(TRAP_FIELD)).not.toContain("offers:defeat-self");
    expect(offersOf(SALVAGED)).toContain("offers:defeat-own-upgrade");
    expect(offersOf(SALVAGED)).not.toContain("offers:defeat-self");
    expect(rowsOf(TRAP_FIELD, KOSKA)).toEqual([]);
    expect(rowsOf(SALVAGED, LAST_WORDS)).toEqual([]);
  });
  it("Contracted Hunter defeats itself when the regroup phase starts, so Koska Reeves and Last Words never see it this phase", () => {
    expect(offersOf(CONTRACTED)).toContain("offers:defeat-self");
    expect(rowsOf(CONTRACTED, KOSKA)).not.toContain("self-defeat-defeat-watcher");
    expect(rowsOf(CONTRACTED, LAST_WORDS)).not.toContain("self-defeat-defeat-watcher");
  });
  it("Poacher's Starfighter defeats itself as it is played and still feeds Koska Reeves", () => {
    expect(rowsOf(POACHER, KOSKA)).toContain("self-defeat-defeat-watcher");
  });
});

describe("an offer gated on the attached unit's name feeds only that card (#165 item 6)", () => {
  it("Darth Maul's Lightsaber gives Migs Mayfeld no extra attack, only the upgrade", () => {
    expect(rowsOf(MAUL_SABER, MIGS)).toContain("upgrade-stacking");
    expect(rowsOf(MAUL_SABER, MIGS)).not.toContain("extra-attack-on-attack");
  });
  it("Darth Maul's Lightsaber still gives Darth Maul the extra attack", () => {
    expect(rowsOf(MAUL_SABER, DARTH_MAUL_UNIT)).toContain("extra-attack-on-attack");
  });
});
