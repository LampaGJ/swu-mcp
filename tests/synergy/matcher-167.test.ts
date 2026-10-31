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

// LampaGJ/swu-mcp#167 items 6 and 7, D85: damage that only a damaged unit can take never makes a card damaged, and a mode an
// opponent chooses is not an offer the card's controller holds. Judged session: scratchpad judge-7-w20.md (Cad Bane).
// Card rows from the 2026-11-01 run (originals 2026-10-16), text verbatim.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const TIE_DAGGER = "04010239";
const OGGDO = "05010063";
const CAD_BANE = "08010011";
const GRIT_UNIT = "T167GRIT";
const WATTO = "05010065";
const MARROK = "08010030";
const RANCOR_KEEPER = "08010032";
const DAMAGED_PUNCHER = "T167WHILE";

const CARDS = {
  [TIE_DAGGER]: {
    cardKey: TIE_DAGGER, title: "TIE Dagger Vanguard", type: "Unit", cost: 3, power: 2, hp: 2, arenas: "Space", aspects: "Villainy", traits: "First Order|Sith|Vehicle|Fighter",
    text: "When Played: You may deal 2 damage to a damaged unit.",
  },
  [OGGDO]: {
    cardKey: OGGDO, title: "Oggdo Bogdo", subtitle: "Bogano Brute", type: "Unit", cost: 3, power: 5, hp: 5, arenas: "Ground", aspects: "Vigilance", traits: "Creature", unique: true,
    text: "This unit can't attack unless it's damaged.\nWhen this unit attacks and defeats a unit: Heal 2 damage from this unit.",
  },
  [DAMAGED_PUNCHER]: {
    cardKey: DAMAGED_PUNCHER, title: "While Damaged Test Unit", type: "Unit", cost: 3, power: 1, hp: 5, arenas: "Ground", aspects: "Aggression", traits: "Fringe",
    text: "While this unit is damaged, it gets +3/+0.",
  },
  [GRIT_UNIT]: { cardKey: GRIT_UNIT, title: "Grit Test Unit", type: "Unit", cost: 2, power: 1, hp: 4, arenas: "Ground", aspects: "Vigilance", traits: "Fringe", keywords: "Grit", text: "Grit" },
  [RANCOR_KEEPER]: {
    cardKey: RANCOR_KEEPER, title: "Rancor Keeper", type: "Unit", cost: 2, power: 2, hp: 4, arenas: "Ground", aspects: "Vigilance|Aggression", traits: "Underworld",
    text: "When a friendly unit is dealt damage and survives: Deal 1 damage to any number of bases. Use this ability only once each round.",
  },
  [CAD_BANE]: {
    cardKey: CAD_BANE, title: "Cad Bane", subtitle: "Still Faster than You", type: "Leader", cost: 6, power: 4, hp: 7, arenas: "Ground", aspects: "Aggression|Villainy", traits: "Underworld|Bounty Hunter", keywords: "Overwhelm", unique: true,
    text: "Action [Exhaust]: Deal 1 damage to a unit with 2 or more remaining HP.",
    deployBox: "Overwhelm (When attacking an enemy unit, deal excess damage to the opponent's base.)\nOn Attack: You may deal 1 damage to a unit with 2 or more remaining HP.",
    epicAction: "Epic Action: If you control 6 or more resources, deploy this leader.",
  },
  [WATTO]: {
    cardKey: WATTO, title: "Watto", subtitle: "No Money, No Parts, No Deal", type: "Unit", cost: 3, power: 1, hp: 6, arenas: "Ground", aspects: "Vigilance", traits: "Fringe", unique: true,
    text: "On Attack: An opponent chooses one:\nYou give an Experience token to a friendly unit.\nYou draw a card.",
  },
  [MARROK]: {
    cardKey: MARROK, title: "Marrok", subtitle: "Mysterious Warrior", type: "Unit", cost: 3, power: 2, hp: 6, arenas: "Ground", aspects: "Vigilance|Aggression|Villainy", traits: "Force|Inquisitor", keywords: "Sentinel|Saboteur", unique: true,
    text: "Sentinel\nWhile this unit is upgraded, he loses Sentinel and gains Saboteur.",
  },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B167", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => `${r.offer} -> ${r.want}`) ?? [];

describe("damage to a damaged unit never makes a card damaged (#167 item 6, D85)", () => {
  it("TIE Dagger Vanguard's damage reaches only a damaged unit, so it never feeds Oggdo Bogdo's \"can't attack unless it's damaged\"", () => {
    expect(rowsOf(TIE_DAGGER, OGGDO)).not.toContain("offers:damage-any-unit -> wants:self-damaged");
    expect(rowsOf(TIE_DAGGER, DAMAGED_PUNCHER)).not.toContain("offers:damage-any-unit -> wants:self-damaged");
  });
  it("Cad Bane's ping (any unit with 2 or more remaining HP) still feeds Oggdo Bogdo", () => {
    expect(rowsOf(CAD_BANE, OGGDO)).toContain("offers:damage-any-unit -> wants:self-damaged");
  });
  it("a Grit unit counts every damage, so a damaged Grit unit still grows from the Vanguard's 2 damage", () => {
    expect(rowsOf(TIE_DAGGER, GRIT_UNIT)).toContain("offers:damage-any-unit -> wants:self-damaged");
  });
  it("the Vanguard still triggers a damage-taken payoff (Rancor Keeper)", () => {
    expect(rowsOf(TIE_DAGGER, RANCOR_KEEPER)).toContain("offers:damage-any-unit -> wants:damage-friendly");
  });
});

describe("a mode an opponent chooses is not the controller's offer (#167 item 7, D85)", () => {
  it("Watto's Experience mode carries opponentChooses; Cad Bane's ping does not", () => {
    expect(graph.qualifier(WATTO, "offers", "offers:give-experience")?.opponentChooses).toBe(true);
    expect(graph.qualifier(WATTO, "offers", "offers:draw")?.opponentChooses).toBe(true);
    expect(graph.qualifier(CAD_BANE, "offers", "offers:damage-any-unit")?.opponentChooses).toBeUndefined();
  });
  it("the pair itself stays (a pairing is a candidate), so Watto still links to Marrok", () => {
    expect(rowsOf(WATTO, MARROK).length).toBeGreaterThan(0);
  });
});
