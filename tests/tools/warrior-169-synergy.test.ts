import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#169, D87: the find_trios and find_pairings items of wave 23. Judged sessions: scratchpad judge-8-w22.md (Warrior)
// and judge-7-w22.md (Cad Bane).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as { deck: { id: string; count: number }[] };
const DECKLIST = OWNER.deck.map((d) => ({ card: d.id, count: d.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));
const real = hasData ? loadStore(builtRun as string) : (undefined as never);

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const CAD_BANE = "08010011";
const NEVARRO = "08010020";
const INSURGENT_CAMP = "09010216";
const BOWCASTER = "09010127";
const CHEWBACCA = "09010117";
const C3PO_TRANSLATION = "C-3PO, Translation Protocol";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const trios = (args: Record<string, unknown>): Record<string, any> => body(SYNERGY_TOOLS.find_trios.handler(real, { withAlternatives: false, evidence: false, ...args }));
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const variantTitles = (t: Record<string, any>): string[] => ((t.variants ?? []) as Record<string, any>[]).map((v) => String(v.title));

describe.skipIf(!hasData)("the D49 fold keeps a trio whose third card fails the variant check (#169 item 1, D87)", () => {
  it("Bowcaster + Insurgent Camp + Chewbacca, which shares two members with the Catch Unawares trio but not its role, is its own row in the session's page", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", decklist: DECKLIST, limit: 6 }).trios as Record<string, any>[];
    const shown = list.map((t) => `${t.cards} [${variantTitles(t).join(", ")}]`).join(" | ");
    const camp = list.find((t) => [BOWCASTER, INSURGENT_CAMP, CHEWBACCA].every((k) => keysOf(t).includes(k)));
    expect(camp, shown).toBeDefined();
  });
});

describe.skipIf(!hasData)("a leader-trait gift is judged on variants with a decklist and no leader (#169 item 3, D87)", () => {
  it("Cad Bane's session step 6 (aspects and decklist, no leader): C-3PO, Translation Protocol is no variant, and a trio holding it carries riderUnmet", () => {
    const list = trios({ leaderAspects: ["Aggression", "Villainy"], baseAspects: ["Vigilance"], decklist: CAD_CORE, limit: 40 }).trios as Record<string, any>[];
    const hosts = list.filter((t) => variantTitles(t).includes(C3PO_TRANSLATION)).map((t) => t.cards);
    expect(hosts).toEqual([]);
    for (const t of list.filter((x) => String(x.cards).includes(C3PO_TRANSLATION))) expect(String(t.riderUnmet), t.cards).toContain("no leader is given");
  });

  it("with Cad Bane given, C-3PO feeding Marrok is still no variant (D84)", () => {
    const list = trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 40 }).trios as Record<string, any>[];
    expect(list.filter((t) => variantTitles(t).includes(C3PO_TRANSLATION)).map((t) => t.cards)).toEqual([]);
  });
});

const FAR_FAR_AWAY = "08010236";
const NEEL = "08010248";
const AETHERSPRITE = "05010197";

describe.skipIf(!hasData)("wants:when-played-cards is a generic trigger want (#169 item 4, D87)", () => {
  it("Far Far Away + Neel + Qui-Gon Jinn's Aethersprite rests only on generic wants (bounce-replay and any When Played): genericLinksOnly names wants:when-played-cards", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 50, cardKey: AETHERSPRITE }).trios as Record<string, any>[];
    const trio = list.find((t) => [FAR_FAR_AWAY, NEEL, AETHERSPRITE].every((k) => keysOf(t).includes(k)));
    expect(trio, list.map((t) => t.cards).join(" | ")).toBeDefined();
    expect(String(trio?.genericLinksOnly)).toContain("wants:when-played-cards");
  });
});

const CHIEFTAIN = "09010212";
const MARCHION_RO = "05010186";
const OPPO = "05010105";
const FIGURE = "06010104";
const pairings = (args: Record<string, unknown>): Record<string, any>[] =>
  body(SYNERGY_TOOLS.find_pairings.handler(real, { evidence: false, withAlternatives: false, perLink: 100, limit: 100, ...args })).pairings;

describe.skipIf(!hasData)("the redundancy discount spares a want that counts or doubles (#169 item 6, D87)", () => {
  it("Marchion Ro doubles each friendly unit's Raid, so a tenth raider still raises his payoff: no redundantKeyword on The Chieftain's row into him", () => {
    const rows = pairings({ cardKey: CHIEFTAIN, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST });
    const ro = rows.find((r) => r.cardKey === MARCHION_RO) as Record<string, any>;
    expect(ro, rows.map((r) => r.title).join("; ")).toBeDefined();
    expect(ro.redundantKeyword).toBeUndefined();
    expect(ro.redundantFactor).toBeUndefined();
  });

  it("Oppo Rancisis gains Raid 2 once from any raider, so Figure of Unity's Raid row stays discounted (D85)", () => {
    const rows = pairings({ cardKey: OPPO, leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", decklist: DECKLIST });
    expect(String(rows.find((r) => r.cardKey === FIGURE)?.redundantKeyword)).toMatch(/^Raid, Restore: /);
  });
});

describe.skipIf(!hasData)("substitutes and variants take the base-lock check (#169 item 8, D87)", () => {
  const altText = (rows: Record<string, any>[]): string =>
    rows.flatMap((r) => [...((r.alternatives ?? []) as unknown[]).flatMap((a) => (typeof a === "string" ? [a] : ((a as Record<string, any>).substitutes ?? []) as string[]))]).join(" | ");

  it("Cad Bane under Nevarro City: find_pairings offers no Nightfall (its attack needs an Endor base) as an alternative", () => {
    const rows = body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: CAD_BANE, leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 10, evidence: false })).pairings as Record<string, any>[];
    const text = altText(rows);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("Nightfall");
  });

  it("Cad Bane under Nevarro City: find_trios offers no Nightfall as a slot substitute, and a base-locked variant follows every unlocked one", () => {
    const list = body(SYNERGY_TOOLS.find_trios.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 50, evidence: false })).trios as Record<string, any>[];
    expect(altText(list)).not.toContain("Nightfall");
    for (const t of list) {
      const locks = ((t.variants ?? []) as Record<string, any>[]).map((v) => v.baseLocked !== undefined);
      const first = locks.indexOf(true);
      if (first >= 0) expect(locks.slice(first).every(Boolean), t.cards).toBe(true);
    }
  });
});

describe.skipIf(!hasData)("leaderAlreadyFeeds sorts before the deck-card tier (#169 item 10, D87)", () => {
  const LOCKS = ["baseLocked", "nameLocked", "needsForce", "needsTrait", "needsHost", "leaderClash", "riderUnmet", "drawback"];
  it("Cad Bane's step 14: no unlocked trio without leaderAlreadyFeeds follows one with it, whatever its deck-card tier", () => {
    const list = trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 50 }).trios as Record<string, any>[];
    const first = list.findIndex((t) => t.leaderAlreadyFeeds !== undefined);
    expect(first, list.map((t) => t.cards).join(" | ")).toBeGreaterThanOrEqual(0);
    const later = list.slice(first + 1).filter((t) => LOCKS.every((f) => t[f] === undefined) && t.leaderAlreadyFeeds === undefined && t.score > 0);
    expect(later.map((t) => t.cards)).toEqual([]);
  });
});
