import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { answerOffers, counterCardSchema, loadCounterTable, relationHit } from "../../src/meta/counters.js";
import type { ThreatProfile } from "../../src/meta/schema.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { clauseLock, lockFields, lockSupply, namedCardOfClause } from "../../src/synergy/clause-lock.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema } from "../../src/synergy/schema.js";
import { searchTrios } from "../../src/synergy/trios.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings, findTrios } from "../../src/tools/synergy.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#157, D66: token icons, one-shot enablers, Renew, named-card conditions.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "06010257": { cardKey: "06010257", title: "Restore Freedom", type: "Event", traits: "Gambit", cost: 2, aspects: "Heroism", text: "Play a unit from your hand. It costs 1 resource less for each Heroism aspect icon among friendly units." },
  "08010119": {
    cardKey: "08010119", title: "Greef Karga", subtitle: "Introductions are in Order", type: "Unit", traits: "Official", cost: 2, power: 2, hp: 3, arenas: "Ground", unique: true, aspects: "Command",
    text: "Action [1 resource, Exhaust]: If your base was attacked this phase, create a Mandalorian token.",
  },
  "08010t01": { cardKey: "08010t01", title: "Mandalorian", type: "Token Unit", traits: "Mandalorian", keywords: "Shielded", cost: 0, power: 2, hp: 2, arenas: "Ground", aspects: "Vigilance", text: "Shielded (When you create this token, give a Shield token to it.)" },
  "04010t02": { cardKey: "04010t02", title: "X-Wing", type: "Token Unit", traits: "Vehicle|Fighter", cost: 0, power: 2, hp: 2, arenas: "Space", aspects: "Heroism", text: "" },
  T157X: { cardKey: "T157X", title: "Squadron Muster", type: "Unit", traits: "Rebel", cost: 2, power: 1, hp: 2, arenas: "Ground", aspects: "Command", text: "Action [1 resource, Exhaust]: Create an X-Wing token." },
  "04010121": { cardKey: "04010121", title: "Salvage", type: "Event", traits: "Supply", cost: 0, aspects: "Command", text: "Play a Vehicle unit from your discard pile (paying its cost). Then, deal 1 damage to it." },
  "07010264": { cardKey: "07010264", title: "From a Certain Point of View", type: "Event", traits: "Learned", cost: 1, text: "Play a card from your hand, ignoring its aspect penalties." },
  "09010216": {
    cardKey: "09010216", title: "Insurgent Camp", type: "Upgrade", traits: "Fortification", keywords: "Fortify", cost: 1, aspects: "Cunning|Heroism",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.",
  },
  T157C: {
    cardKey: "T157C", title: "Rally Post", type: "Upgrade", traits: "Fortification", keywords: "Fortify", cost: 1, aspects: "Cunning|Heroism",
    text: "Fortify (Attach this to your base, not a unit.)\nWhen you play a unit with 3 or less power: You may ready that unit.",
  },
  "09010267": { cardKey: "09010267", title: "Renew", type: "Event", traits: "Innate", cost: 2, aspects: "Heroism", text: "You may defeat a Condition upgrade.\nHeal 3 damage from your base." },
  "04010168": { cardKey: "04010168", title: "Insurgent Saboteurs", type: "Unit", traits: "Rebel|Trooper", cost: 4, power: 3, hp: 4, arenas: "Ground", aspects: "Cunning|Heroism", text: "When Played: You may defeat an upgrade." },
  "06010201": {
    cardKey: "06010201", title: "Anakin Skywalker", subtitle: "Secret Husband", type: "Unit", traits: "Force|Jedi|Republic", keywords: "Hidden|Raid", cost: 3, power: 3, hp: 4, arenas: "Ground", unique: true, aspects: "Cunning|Heroism",
    text: "Hidden (This unit can't be attacked if he was played this phase.)\nWhile you control Padmé Amidala (as a leader or unit), this unit gains Raid 2.",
  },
  "06010016": {
    cardKey: "06010016", title: "Padmé Amidala", subtitle: "What Do You Have to Hide?", type: "Leader", traits: "Naboo|Republic|Official", cost: 6, power: 3, hp: 8, arenas: "Ground", unique: true, aspects: "Cunning|Heroism",
    text: "When you reveal or discard 1 or more cards from your hand: You may exhaust this leader. If you do, deal 1 damage to a unit.",
  },
  T157E: { cardKey: "T157E", title: "Extra Swing", type: "Event", traits: "Tactic", cost: 1, aspects: "Cunning", text: "Attack with a unit. It gets +1/+0 for this attack." },
} satisfies Record<string, Spec>;

type Key = keyof typeof CARDS;
const KEYS = Object.keys(CARDS) as Key[];
const FEATURES = KEYS.map((k) => featuresOf(CARDS[k]));
const LEADER = mk("L157", "Test Leader", { type: "Leader", aspects: ["Cunning", "Heroism"], icons: ["Cunning", "Heroism"] });
const BASE = mk("B157", "Test Base", { type: "Base", aspects: ["Command"], icons: ["Command"] });
const CARDS_ALL = [...synergyCardsSchema.parse(FEATURES), LEADER, BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];
const body = (r: ToolResult): Record<string, any> => {
  expect(r.isError, r.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(r.content[0].text) as Record<string, any>;
};

describe("token icons: a token feeds an aspect-icon want only through its printed aspects", () => {
  it("08010119 Greef Karga's Vigilance Mandalorian token does not feed 06010257 Restore Freedom's Heroism icon count (judge line 1564)", () => {
    expect(rowsOf("08010119", "06010257")).toEqual([]);
  });
  it("a card that creates a Heroism X-Wing token still feeds Restore Freedom", () => {
    expect(rowsOf("T157X", "06010257")).toContain("fodder-for-outlet");
  });
});

describe("one-shot enablers: a card that defeats itself after its effect is a non-counting want (D64 substitute rule)", () => {
  const trios = searchTrios(graph, coverCombos(CARDS_ALL));
  const convergent = [...trios.trios["convergent-same-want"], ...trios.trios["convergent-different-wants"]];
  const find = (a: string, b: string, c: string) => convergent.find((t) => [t.cardA, t.cardB].sort().join("|") === [a, b].sort().join("|") && t.cardC === c);
  it("Salvage + From a Certain Point of View into 09010216 Insurgent Camp are substitutes, scored 0 (judge line 1575)", () => {
    expect(rowsOf("04010121", "09010216").length).toBeGreaterThan(0);
    expect(rowsOf("07010264", "09010216").length).toBeGreaterThan(0);
    const t = find("04010121", "07010264", "09010216");
    expect(t?.score).toBe(0);
    expect(t?.reasons.startsWith("substitutes")).toBe(true);
  });
  it("the same two enablers into a payoff that stays on the board remain a combo", () => {
    const t = find("04010121", "07010264", "T157C");
    expect(t?.score).toBeGreaterThan(0);
    expect(t?.reasons.startsWith("substitutes")).toBe(false);
  });
});

describe("Renew: an effect on Condition upgrades does not remove Shield tokens (Armor)", () => {
  const table = loadCounterTable();
  const relation = table.relations.find((r) => r.id === "shield-removal");
  const profile = { keyUnits: [], cheapUnitMedianHp: 2 } as unknown as ThreatProfile;
  const hit = (k: Key) => {
    const card = counterCardSchema.parse(FEATURES[KEYS.indexOf(k)]);
    return relationHit(card, answerOffers(card), relation as NonNullable<typeof relation>, profile);
  };
  it("09010267 Renew answers no shield threat", () => {
    expect(hit("09010267")).toBeNull();
  });
  it("04010168 Insurgent Saboteurs ('defeat an upgrade') still does", () => {
    expect(hit("04010168")).toMatchObject({ relation: "shield-removal", offer: "offers:defeat-upgrade" });
  });
});

describe("named-card conditions: a clause gated on controlling a named card is nameLocked (D59 mechanism)", () => {
  const anakin = byKey.get("06010201")!;
  const padme = byKey.get("06010016")!;
  it("reads the name from 'While you control Padmé Amidala, ...' and none from an aspect, base or count condition", () => {
    expect(namedCardOfClause("While you control Padmé Amidala, this unit gains Raid 2.")).toBe("Padmé Amidala");
    expect(namedCardOfClause("If you control Jabba the Hutt, draw a card.")).toBe("Jabba the Hutt");
    expect(namedCardOfClause("While you control a Tatooine base, draw a card.")).toBeNull();
    expect(namedCardOfClause("While you control another Aggression unit, this unit gains Raid 2.")).toBeNull();
    expect(namedCardOfClause("While you control 6 or more resources, this unit gains Sentinel.")).toBeNull();
  });
  it("locks Anakin Skywalker, Secret Husband unless the leader, base or deck supplies Padmé Amidala", () => {
    expect(lockFields(clauseLock(anakin, lockSupply(LEADER, BASE, [])))).toEqual({ nameLocked: "Padmé Amidala" });
    expect(lockFields(clauseLock(anakin, lockSupply(padme, BASE, [])))).toEqual({});
    expect(lockFields(clauseLock(anakin, lockSupply(LEADER, BASE, [mk("PU", "Padmé Amidala")])))).toEqual({});
  });
  it("an unlocked lock keeps its earlier shape, so callers comparing two fields are unchanged", () => {
    expect(clauseLock(anakin, lockSupply(padme, BASE, []))).toEqual({ baseLocked: [], needsUnitAspect: [] });
  });

  const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
  it("find_pairings flags Anakin as nameLocked and ranks him after the unlocked partners", () => {
    const rows = body(findPairings(ctx, { cardKey: "T157E", limit: 50, perLink: 100, evidence: false, withAlternatives: false })).pairings as Record<string, any>[];
    const at = rows.findIndex((r) => r.cardKey === "06010201");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rows[at].nameLocked).toBe("Padmé Amidala");
    expect(rows.slice(0, at).every((r) => r.nameLocked === undefined && r.baseLocked === undefined)).toBe(true);
  });
  it("find_pairings clears the lock when Padmé Amidala is the leader", () => {
    const rows = body(findPairings(ctx, { cardKey: "T157E", leader: "06010016", base: "B157", limit: 50, perLink: 100, evidence: false, withAlternatives: false })).pairings as Record<string, any>[];
    expect(rows.find((r) => r.cardKey === "06010201")).not.toHaveProperty("nameLocked");
  });
  it("find_trios flags a trio holding Anakin and ranks it after every unlocked trio", () => {
    const trios = body(findTrios(ctx, { leader: "L157", base: "B157", limit: 40, evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    const first = trios.findIndex((t) => t.nameLocked !== undefined);
    const withAnakin = trios.filter((t) => String(t.cardKeys).split("|").includes("06010201"));
    expect(withAnakin.length).toBeGreaterThan(0);
    expect(withAnakin.every((t) => t.nameLocked === "Padmé Amidala")).toBe(true);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(trios.slice(first).every((t) => t.nameLocked !== undefined || t.baseLocked !== undefined)).toBe(true);
  });
});
