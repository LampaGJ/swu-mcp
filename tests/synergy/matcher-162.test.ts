import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { loadStore, newestRun } from "../../src/data.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema, type SynergyCard, type TrioRecord } from "../../src/synergy/schema.js";
import { searchTrios } from "../../src/synergy/trios.js";
import type { ToolResult } from "../../src/tools.js";
import { fungibleSubstitutes, SYNERGY_TOOLS } from "../../src/tools/synergy.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#162, D76: enemy-only removal is no sacrifice outlet, one single-target defeat cannot count twice in a chain,
// a defeat-gated token comes after the defeat, score-0 trios never top the list, a self-targeted grant feeds no other card.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const NO_GLORY = "04010043";
const EVIL = "06010247";
const ONYX = "04010033";
const PACIFICATION = "09010253";
const APOLOGY = "04010091";
const INVESTIGATION = "06010181";
const KOSKA = "08010079";
const MARROK = "08010030";
const GRIM_VALOR = "04010073";
const WEEQUAY = "07010231";
const HK47 = "05010130";
const POACHER = "09010153";
const ONE_MUST = "08010247";
const CREDITORS_CLAIM = "06010039";

const CARDS = {
  [NO_GLORY]: { cardKey: NO_GLORY, title: "No Glory, Only Results", type: "Event", cost: 5, aspects: "Vigilance|Villainy", traits: "Tactic", text: "Take control of a non-leader unit, then defeat it." },
  [EVIL]: {
    cardKey: EVIL, title: "Evil is Everywhere", type: "Event", cost: 3, aspects: "Villainy", traits: "Disaster",
    text: "Defeat a unit with cost equal to or less than the number of Villainy aspect icons among friendly units.",
  },
  [ONYX]: { cardKey: ONYX, title: "Onyx Squadron Brute", type: "Unit", cost: 2, power: 2, hp: 3, arenas: "Space", aspects: "Vigilance|Villainy", traits: "Imperial|Vehicle|Fighter", text: "When Defeated: Heal 2 damage from a base." },
  [PACIFICATION]: {
    cardKey: PACIFICATION, title: "Forced Pacification", type: "Event", cost: 2, aspects: "Villainy", traits: "Plan",
    text: "Defeat any number of friendly units. For each friendly unit defeated this way, exhaust 2 enemy units.",
  },
  [APOLOGY]: { cardKey: APOLOGY, title: "Apology Accepted", type: "Event", cost: 1, aspects: "Command|Villainy", traits: "Tactic", text: "Defeat a friendly unit. You may give 2 Experience tokens to a unit." },
  [INVESTIGATION]: {
    cardKey: INVESTIGATION, title: "Unauthorized Investigation", type: "Event", cost: 3, aspects: "Aggression", traits: "Plan",
    text: "Create a Spy token.\nYou may disclose Aggression (reveal a card from your hand with this aspect icon). If you do, create another Spy token.",
  },
  [KOSKA]: {
    cardKey: KOSKA, title: "Koska Reeves", subtitle: "Warrior of Mandalore", type: "Unit", cost: 4, power: 4, hp: 4, arenas: "Ground", aspects: "Vigilance", traits: "Mandalorian", keywords: "Sentinel", unique: true,
    text: "While you control a token unit, this unit gains Sentinel.\nWhen Played: If a friendly unit was defeated this phase, create a Mandalorian token.",
  },
  [MARROK]: {
    cardKey: MARROK, title: "Marrok", subtitle: "Mysterious Warrior", type: "Unit", cost: 3, power: 2, hp: 6, arenas: "Ground", aspects: "Vigilance|Aggression|Villainy", traits: "Force|Inquisitor", keywords: "Sentinel|Saboteur", unique: true,
    text: "Sentinel\nWhile this unit is upgraded, he loses Sentinel and gains Saboteur.",
  },
  [GRIM_VALOR]: { cardKey: GRIM_VALOR, title: "Grim Valor", type: "Upgrade", cost: 1, aspects: "Vigilance", traits: "Innate", text: "Attached unit gains: “When Defeated: You may exhaust a unit.”" },
  [WEEQUAY]: {
    cardKey: WEEQUAY, title: "Weequay Pirate", type: "Unit", cost: 2, power: 2, hp: 3, arenas: "Ground", aspects: "Cunning", traits: "Underworld", keywords: "Saboteur",
    text: "Saboteur (When this unit attacks, ignore Sentinel and defeat the defender's Shields.)\nWhen Played: If no resources were paid to play this unit, give an Experience token to it.",
  },
  [HK47]: {
    cardKey: HK47, title: "HK-47", subtitle: "Exclamation: Die, Meatbag!", type: "Unit", cost: 2, power: 2, hp: 4, arenas: "Ground", aspects: "Aggression|Villainy", traits: "Sith|Droid", unique: true,
    text: "When an enemy unit is defeated: Deal 1 damage to its controller's base.",
  },
  [POACHER]: {
    cardKey: POACHER, title: "Poacher's Starfighter", type: "Unit", cost: 2, power: 3, hp: 1, arenas: "Space", aspects: "Aggression|Villainy", traits: "Underworld|Vehicle|Fighter",
    text: "When Played: You may defeat this unit. If you do, create a Beast token and deal 1 damage to it.",
  },
  [ONE_MUST]: {
    cardKey: ONE_MUST, title: "One Must Destroy to Create", type: "Event", cost: 3, aspects: "Villainy", traits: "Plan",
    text: "Defeat a friendly non-leader unit. Then, you may play that unit from your discard pile for free.",
  },
  [CREDITORS_CLAIM]: {
    cardKey: CREDITORS_CLAIM, title: "Creditor's Claim", type: "Upgrade", cost: 3, aspects: "Vigilance|Villainy", traits: "Supply",
    text: "Attached unit gains: “When Defeated: You may defeat a unit with 3 or less remaining HP.”",
  },
} satisfies Record<string, Spec>;

const FEATURES = Object.values(CARDS).map((spec) => featuresOf(spec));
const BASE = mk("B162", "Test Base", { type: "Base", aspects: ["Vigilance"], icons: ["Vigilance"] });
const CARDS_ALL: SynergyCard[] = [...synergyCardsSchema.parse(FEATURES), BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const offersOf = (k: string) => card(k).tags.offers.map((t) => t.tag);
const wantsOf = (k: string) => card(k).tags.wants.map((t) => t.tag);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => r.row) ?? [];
const allTrios: TrioRecord[] = Object.values(searchTrios(graph, coverCombos(CARDS_ALL)).trios).flat();
const chainOf = (a: string, b: string, c: string): TrioRecord | undefined => allTrios.find((t) => t.shape === "chain" && t.cardA === a && t.cardB === b && t.cardC === c);
const SAC_OUTLET = "sac-outlet-when-defeated";
const body = (r: ToolResult): Record<string, any> => {
  expect(r.isError, r.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(r.content[0].text) as Record<string, any>;
};

describe("enemy-only removal is no sacrifice outlet for your own units (#162 item 1)", () => {
  it("Evil is Everywhere's target is any unit: 'among friendly units' counts icons, it names no friendly target", () => {
    expect(offersOf(EVIL)).toContain("offers:defeat-any-unit");
    expect(offersOf(EVIL)).not.toContain("offers:defeat-friendly-unit");
    expect(wantsOf(EVIL)).not.toContain("wants:sac-fodder");
  });
  it("No Glory, Only Results defeats the unit it took control of, which is an enemy's", () => {
    expect(offersOf(NO_GLORY)).toContain("offers:defeat-enemy-unit");
    expect(offersOf(NO_GLORY)).not.toContain("offers:defeat-any-unit");
    expect(offersOf(NO_GLORY)).not.toContain("offers:defeat-friendly-unit");
  });
  it("No Glory feeds no When Defeated of your own (Onyx Squadron Brute, Grim Valor) but still feeds HK-47's enemy-defeat watcher", () => {
    expect(rowsOf(NO_GLORY, ONYX)).not.toContain(SAC_OUTLET);
    expect(rowsOf(NO_GLORY, GRIM_VALOR)).not.toContain(SAC_OUTLET);
    expect(rowsOf(NO_GLORY, HK47)).toContain("removal-defeat-watcher");
  });
  it("a pair keeps a single-target 'defeat a unit' as a weak outlet (pairs-v1 labels Shatterpoint -> Koska correct)", () => {
    expect(rowsOf(EVIL, ONYX)).toContain(SAC_OUTLET);
  });
  it("a trio never rests on a single-target any-side defeat as its sacrifice outlet", () => {
    for (const t of allTrios) {
      const keys = [t.cardA, t.cardB, t.cardC];
      if (keys.includes(EVIL) || keys.includes(NO_GLORY)) expect(t.reasons, `${keys.join("|")}: ${t.reasons}`).not.toMatch(/(?:Evil is Everywhere|No Glory, Only Results) -> [^|]*sac-outlet-when-defeated/);
    }
    expect(chainOf(EVIL, GRIM_VALOR, MARROK)).toBeUndefined();
  });
  it("friendly outlets still make the trios: Forced Pacification, One Must Destroy to Create", () => {
    expect(chainOf(PACIFICATION, GRIM_VALOR, MARROK)).toBeDefined();
    expect(chainOf(ONE_MUST, CREDITORS_CLAIM, MARROK)).toBeDefined();
  });
});

describe("one single-target defeat cannot count twice in a chain; a defeat-gated token comes after the defeat (#162 item 2)", () => {
  it("Unauthorized Investigation -> Apology Accepted -> Onyx Squadron Brute is no chain: Apology defeats one unit, the Spy token or the Brute", () => {
    expect(rowsOf(INVESTIGATION, APOLOGY)).toContain("fodder-for-outlet");
    expect(rowsOf(APOLOGY, ONYX)).toContain(SAC_OUTLET);
    expect(chainOf(INVESTIGATION, APOLOGY, ONYX)).toBeUndefined();
  });
  it("an outlet that defeats any number of units eats the token and the Brute: Unauthorized Investigation -> Forced Pacification -> Onyx Squadron Brute holds", () => {
    expect(chainOf(INVESTIGATION, PACIFICATION, ONYX)).toBeDefined();
  });
  it("Koska Reeves makes her token only after a friendly defeat, so no trio hands it on unless another member defeats a friendly unit first", () => {
    expect(rowsOf(KOSKA, PACIFICATION)).toContain("fodder-for-outlet");
    expect(chainOf(KOSKA, APOLOGY, ONYX)).toBeUndefined();
    expect(chainOf(KOSKA, PACIFICATION, ONYX)).toBeUndefined();
    expect(chainOf(KOSKA, INVESTIGATION, PACIFICATION)).toBeUndefined();
    const koska = "Koska Reeves, Warrior of Mandalore";
    for (const t of allTrios) {
      if (!t.reasons.includes(`${koska} -> `)) continue;
      expect(t.reasons, t.reasons).toMatch(new RegExp(`-> ${koska}: [^|]*wants:friendly-unit-defeated`));
    }
  });
  it("a member that defeats a friendly unit first lets Koska's token feed the outlet: Poacher's Starfighter -> Koska Reeves -> Forced Pacification holds", () => {
    expect(chainOf(POACHER, KOSKA, PACIFICATION)).toBeDefined();
  });
});

describe("a self-targeted grant feeds no other card (#162 item 4)", () => {
  it("Weequay Pirate's Experience token goes to itself: offers:give-experience-self, never offers:give-experience", () => {
    expect(offersOf(WEEQUAY)).toContain("offers:give-experience-self");
    expect(offersOf(WEEQUAY)).not.toContain("offers:give-experience");
    expect(rowsOf(WEEQUAY, MARROK)).toEqual([]);
  });
  it("Apology Accepted's Experience tokens go to a chosen unit and still feed Marrok", () => {
    expect(rowsOf(APOLOGY, MARROK)).toContain("upgrade-stacking");
  });
  it("fungible_substitutes for Marrok does not say Weequay Pirate feeds Marrok", () => {
    const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(ctx, { cardKey: MARROK, evidence: false }));
    expect(JSON.stringify(out)).not.toContain("Weequay Pirate feeds");
    expect(((out.partners ?? []) as Record<string, any>[]).map((p) => p.cardKey)).not.toContain(WEEQUAY);
  });
});

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));
const real = hasData ? loadStore(builtRun as string) : (undefined as never);
// The Cad Bane session's 34-card core (scratchpad/undici-test/session-dump7b.mjs).
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];
const CAD_BANE = "08010011";
const NEVARRO = "08010020";

describe.skipIf(!hasData)("Cad Bane step 14 (find_trios leader and base, the session core) (#162)", () => {
  const step14 = (limit: number): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_trios.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit, withAlternatives: false, evidence: false })).trios;

  it("item 3: a score-0 (substitutes) trio follows every scored trio, so it never fills the top five while a scored trio is left out", () => {
    const top = step14(5);
    const deep = step14(50);
    expect(top.map((t) => t.cardKeys)).toEqual(deep.slice(0, top.length).map((t) => t.cardKeys));
    const firstZero = deep.findIndex((t) => t.score === 0);
    if (firstZero >= 0) for (const t of deep.slice(firstZero)) expect(t.score, `${t.cards} after a score-0 trio`).toBe(0);
    if (deep.filter((t) => t.score > 0).length >= 5) expect(top.every((t) => t.score > 0)).toBe(true);
  });

  it("item 1: no trio spends No Glory, Only Results on your own unit", () => {
    for (const t of step14(5)) expect(t.reasons).not.toMatch(/No Glory, Only Results -> [^|]*sac-outlet-when-defeated/);
  });
});
