import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractFeatures, loadCuratedTable } from "../../src/ability-grammar/index.js";
import { swuFeatureInputCardSchema } from "../../src/schemas/card-features.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { roleOf, roleSignatures, roleTagsOf } from "../../src/synergy/fungibility.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { findPairings, fungibleSubstitutes } from "../../src/tools/synergy.js";
import type { CardSpec } from "../ability-grammar/helpers.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

// LampaGJ/swu-mcp#159 Matcher bullets, D70: a self-drawback When Defeated is no enabler; printed keyword roles hold only printers.
// Card rows from the 2026-10-31 run (originals 2026-10-16), text verbatim; T-keys are synthetic.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const { index } = loadCuratedTable(readFileSync(path.join(REPO_ROOT, "data/curated-rules.json"), "utf8"));
type Spec = CardSpec & { subtitle?: string; cost?: number; power?: number; hp?: number; arenas?: string; unique?: boolean; aspects?: string };
const featuresOf = (spec: Spec) => extractFeatures([swuFeatureInputCardSchema.parse({ type2: "", ...spec })], index).cards[0];

const CARDS = {
  "09010117": {
    cardKey: "09010117", title: "Chewbacca", subtitle: "Resourceful Wookiee", type: "Unit", traits: "Wookiee", keywords: "Raid|Overwhelm", cost: 3, power: 0, hp: 5, arenas: "Ground", unique: true, aspects: "Command|Heroism",
    text: "This unit gains Raid 1 for each exhausted resource you control.\nWhile each resource you control is exhausted, this unit gains Overwhelm.",
  },
  "08010216": { cardKey: "08010216", title: "Mandalorian Scout", type: "Unit", traits: "Mandalorian", cost: 2, power: 3, hp: 3, arenas: "Ground", aspects: "Cunning", text: "When Defeated: Exhaust a ready friendly resource." },
  "06010216": { cardKey: "06010216", title: "Regulations Bureaucrat", type: "Unit", traits: "Imperial|Official", cost: 2, power: 0, hp: 5, arenas: "Ground", aspects: "Cunning", text: "Action [Exhaust]: Exhaust a resource." },
  "05010194": {
    cardKey: "05010194", title: "J-Type Nubian Starship", type: "Unit", traits: "Naboo|Vehicle|Transport", cost: 3, power: 2, hp: 4, arenas: "Space", aspects: "Cunning|Heroism",
    text: "When Played: Draw a card.\nWhen Defeated: Discard a card from your hand.",
  },
  "05010137": {
    cardKey: "05010137", title: "Savage Opress", subtitle: "Imbued With Hate", type: "Unit", traits: "Force|Night", keywords: "Overwhelm", cost: 6, power: 9, hp: 6, arenas: "Ground", unique: true, aspects: "Aggression|Villainy",
    text: "Overwhelm (When attacking an enemy unit, deal excess damage to the opponent's base.)\nWhen Played/When Defeated: You may use the Force (lose your Force token). If you don't, deal 9 damage to your base.",
  },
  "08010027": {
    cardKey: "08010027", title: "Enoch", subtitle: "Solemn Servant", type: "Unit", traits: "Imperial|Trooper", cost: 4, power: 4, hp: 5, arenas: "Ground", unique: true, aspects: "Vigilance|Command|Villainy",
    text: "When Defeated: You may deal up to 6 damage to your base. The next unit you play this phase costs 1 resource less for every 2 damage dealt this way.",
  },
  "06010215": { cardKey: "06010215", title: "Emissary's Sheathipede", type: "Unit", traits: "Separatist|Vehicle|Transport", cost: 2, power: 2, hp: 4, arenas: "Space", aspects: "Cunning", text: "When Defeated: Each opponent may ready a resource." },
  T159D: { cardKey: "T159D", title: "Salvage Skiff", type: "Unit", traits: "Vehicle|Transport", cost: 2, power: 2, hp: 3, arenas: "Space", aspects: "Cunning", text: "When Defeated: Draw a card." },
  "04010047": {
    cardKey: "04010047", title: "Admiral Yularen", subtitle: "Fleet Coordinator", type: "Unit", traits: "Republic|Official", keywords: "Grit|Restore|Sentinel|Shielded", cost: 3, power: 1, hp: 5, arenas: "Ground", unique: true, aspects: "Vigilance|Heroism",
    text: "When Played: Choose Grit, Restore 1, Sentinel, or Shielded. While this unit is in play, each friendly Vehicle unit gains the chosen keyword.",
  },
  "07010105": {
    cardKey: "07010105", title: "Cinta Kaz", subtitle: "Stone Cold and Fearless", type: "Unit", traits: "Rebel", keywords: "Sentinel", cost: 3, power: 3, hp: 3, arenas: "Ground", unique: true, aspects: "Vigilance|Heroism",
    text: "While this unit is upgraded, she gains Sentinel.",
  },
  T159G: { cardKey: "T159G", title: "Stubborn Trooper", type: "Unit", traits: "Republic|Trooper", keywords: "Grit", cost: 3, power: 1, hp: 5, arenas: "Ground", aspects: "Vigilance|Heroism", text: "Grit (This unit gets +1/+0 for each damage on it.)" },
  T159S: { cardKey: "T159S", title: "Wall Trooper", type: "Unit", traits: "Republic|Trooper", keywords: "Sentinel", cost: 3, power: 1, hp: 5, arenas: "Ground", aspects: "Vigilance|Heroism", text: "Sentinel (Enemy units in this arena must attack a Sentinel when they attack you.)" },
  T159V: { cardKey: "T159V", title: "Gunship Escort", type: "Unit", traits: "Vehicle|Fighter", cost: 3, power: 2, hp: 3, arenas: "Space", aspects: "Vigilance|Heroism", text: "When Played: Another friendly unit gains Grit for this phase." },
  "06010063": {
    cardKey: "06010063", title: "Rotunda Senate Guards", type: "Unit", traits: "Republic|Trooper", keywords: "Sentinel", cost: 4, power: 4, hp: 5, arenas: "Ground", aspects: "Vigilance",
    text: "While this unit is undamaged, it gains Sentinel. (Enemy units in this arena must attack a Sentinel when they attack you.)",
  },
  "09010259": {
    cardKey: "09010259", title: "Pack Guardian", type: "Unit", traits: "Creature", keywords: "Sentinel", cost: 4, power: 5, hp: 4, arenas: "Ground", aspects: "Heroism",
    text: "While this unit is ready, it gains Sentinel. (Enemy units in this arena must attack a Sentinel when they attack you.)",
  },
  "04010137": {
    cardKey: "04010137", title: "Vonreg's TIE Interceptor", subtitle: "Ace of the First Order", type: "Unit", traits: "First Order|Vehicle|Fighter", keywords: "Overwhelm|Raid", cost: 3, power: 3, hp: 4, arenas: "Space", unique: true, aspects: "Aggression|Villainy",
    text: "While this unit has 4 or more power, it gains Overwhelm. (When attacking an enemy unit, deal excess damage to the opponent's base.)\nWhile this unit has 6 or more power, it gains Raid 1. (It gets +1/+0 while attacking.)",
  },
  "08010049": {
    cardKey: "08010049", title: "Shin Hati", subtitle: "Going Somewhere?", type: "Unit", traits: "Force", keywords: "Sentinel", cost: 5, power: 6, hp: 6, arenas: "Ground", unique: true, aspects: "Vigilance|Villainy",
    text: "While this is the only friendly non-leader ground unit, she gains Sentinel. (Enemy units in this arena must attack a Sentinel when they attack you.)",
  },
  T159P: { cardKey: "T159P", title: "Escort Leader", type: "Unit", traits: "Trooper", cost: 3, power: 2, hp: 3, arenas: "Ground", aspects: "Command", text: "While a friendly unit is attacking, it gains Overwhelm." },
} satisfies Record<string, Spec>;

type Key = keyof typeof CARDS;
const KEYS = Object.keys(CARDS) as Key[];
const FEATURES = KEYS.map((k) => featuresOf(CARDS[k]));
const LEADER = mk("L159", "Test Leader", { type: "Leader", aspects: ["Command", "Heroism"], icons: ["Command", "Heroism"] });
const BASE = mk("B159", "Test Base", { type: "Base", aspects: ["Cunning"], icons: ["Cunning"] });
const CARDS_ALL = [...synergyCardsSchema.parse(FEATURES), LEADER, BASE];
const byKey = new Map(CARDS_ALL.map((c) => [c.cardKey, c]));
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;
const graph = buildPairGraph(CARDS_ALL, COMMITTED_TABLE);
const body = (r: ToolResult): Record<string, any> => {
  expect(r.isError, r.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(r.content[0].text) as Record<string, any>;
};
const offersOf = (k: string) => card(k).tags.offers.map((t) => t.tag);
const wantsOf = (k: string) => card(k).tags.wants.map((t) => t.tag);
const rowsOf = (from: string, to: string) => graph.edgeByKey.get(`${from}>${to}`)?.rows.map((r) => r.row) ?? [];

describe("a When Defeated that costs its own controller is a drawback: no sacrifice payoff, no enabler", () => {
  it("Mandalorian Scout ('Exhaust a ready friendly resource') wants no defeat and offers no resource exhaust", () => {
    expect(wantsOf("08010216")).not.toContain("wants:self-defeated");
    expect(offersOf("08010216")).not.toContain("offers:exhaust-resource");
    expect(offersOf("08010216")).toContain("offers:has-when-defeated");
  });
  it("J-Type Nubian Starship's When Defeated discard is a drawback; its When Played draw still offers", () => {
    expect(wantsOf("05010194")).not.toContain("wants:self-defeated");
    expect(offersOf("05010194")).not.toContain("offers:discard-own");
    expect(offersOf("05010194")).toContain("offers:draw");
  });
  it("Savage Opress wants no defeat; the base damage still offers because the When Played route is chosen on your turn", () => {
    expect(wantsOf("05010137")).not.toContain("wants:self-defeated");
    expect(offersOf("05010137")).toContain("offers:damage-own-base");
  });
  it("Enoch's optional base damage buys a discount, so it is no drawback and still wants the defeat", () => {
    expect(wantsOf("08010027")).toContain("wants:self-defeated");
    expect(offersOf("08010027")).toContain("offers:damage-own-base");
  });
  it("a When Defeated that pays the opponent offers nothing either: Emissary's Sheathipede readies no resource of yours", () => {
    expect(offersOf("06010215")).not.toContain("offers:ready-resource");
    expect(wantsOf("T159D")).toContain("wants:self-defeated");
    expect(offersOf("T159D")).toContain("offers:draw");
  });
  it("Mandalorian Scout no longer feeds Chewbacca, Resourceful Wookiee (dump lines 1261 to 1277); Regulations Bureaucrat still does", () => {
    expect(rowsOf("08010216", "09010117")).toEqual([]);
    expect(rowsOf("06010216", "09010117").length).toBeGreaterThan(0);
  });
  it("find_pairings for Chewbacca lists Regulations Bureaucrat and not Mandalorian Scout", () => {
    const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
    const rows = body(findPairings(ctx, { cardKey: "09010117", leader: "L159", base: "B159", limit: 20, evidence: false, withAlternatives: false })).pairings as Record<string, any>[];
    const keys = rows.map((r) => r.cardKey);
    expect(keys).toContain("06010216");
    expect(keys).not.toContain("08010216");
  });
});

describe("a printed-keyword role class holds only cards that print the keyword; a grant to other units is a grant class", () => {
  const fungibility = createSynergyContext(CARDS_ALL, COMMITTED_TABLE).fungibility;
  it("Admiral Yularen holds no keyword:Grit role (the source lists Grit only because his text names it)", () => {
    const tags = roleSignatures(card("04010047")).map((s) => s.tag);
    for (const k of ["Grit", "Restore", "Sentinel", "Shielded"]) expect(tags).not.toContain(`keyword:${k}`);
  });
  it("Admiral Yularen sits in the grant classes of the four keywords he grants to Vehicles", () => {
    const tags = roleTagsOf(fungibility, "04010047");
    for (const k of ["grit", "restore", "sentinel", "shielded"]) expect(tags.has(`offers:grant-${k}`)).toBe(true);
    expect(roleOf(fungibility, "04010047", "offers:grant-grit")?.side).toBe("offers");
  });
  it("a unit that gains a keyword only under a condition prints none: Cinta Kaz holds no keyword:Sentinel role", () => {
    expect(roleSignatures(card("07010105")).map((s) => s.tag)).not.toContain("keyword:Sentinel");
  });
  it("a unit that prints the keyword keeps its keyword role", () => {
    expect(roleSignatures(card("T159G")).map((s) => s.tag)).toContain("keyword:Grit");
    expect(roleSignatures(card("T159S")).map((s) => s.tag)).toContain("keyword:Sentinel");
  });
  it("a grant the tag step already names is not doubled: Gunship Escort holds one offers:grant-grit role", () => {
    expect(roleSignatures(card("T159V")).filter((s) => s.tag === "offers:grant-grit")).toHaveLength(1);
  });
  it("fungible_substitutes lists Yularen as no stand-in of a printed-Grit unit and quotes his grant clause, not 'printed keyword Grit' (dump line 2384)", () => {
    const ctx = createSynergyContext(CARDS_ALL, COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(ctx, { cardKey: "T159G", tag: "keyword:Grit" }));
    const listed = (out.roles as Record<string, any>[]).flatMap((r) => r.substitutes.flatMap((g: any) => g.cards.map((c: any) => c.cardKey)));
    expect(listed).not.toContain("04010047");
    const grant = body(fungibleSubstitutes(ctx, { cardKey: "04010047", tag: "offers:grant-grit" })).roles[0];
    expect(grant.slotText).toContain("gains the chosen keyword");
    expect(grant.slotText).not.toContain("printed keyword");
  });
});

describe("'it gains', 'he gains' and 'she gains' after 'While this unit ...' is a self-gain", () => {
  it("Rotunda Senate Guards and Pack Guardian hold Sentinel and grant it to no other unit", () => {
    for (const k of ["06010063", "09010259"]) {
      expect(offersOf(k)).toContain("offers:has-keyword-sentinel");
      expect(offersOf(k)).not.toContain("offers:grant-sentinel");
    }
  });
  it("Vonreg's TIE Interceptor holds Overwhelm and Raid and wants extra attacks for them", () => {
    expect(offersOf("04010137")).toEqual(expect.arrayContaining(["offers:has-keyword-overwhelm", "offers:has-keyword-raid"]));
    expect(wantsOf("04010137")).toContain("wants:extra-attacks");
  });
  it("Shin Hati ('While this is the only ..., she gains Sentinel') and Cinta Kaz hold Sentinel and grant none", () => {
    for (const k of ["08010049", "07010105"]) {
      expect(offersOf(k)).toContain("offers:has-keyword-sentinel");
      expect(offersOf(k)).not.toContain("offers:grant-sentinel");
    }
  });
  it("a pronoun whose subject is another unit is no self-gain", () => {
    expect(offersOf("T159P")).not.toContain("offers:has-keyword-overwhelm");
  });
  it("the three units that lost every role hold one again", () => {
    const fungibility = createSynergyContext(CARDS_ALL, COMMITTED_TABLE).fungibility;
    for (const k of ["06010063", "09010259", "04010137"]) expect(roleTagsOf(fungibility, k).size).toBeGreaterThan(0);
  });
});
