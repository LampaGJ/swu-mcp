import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#168 items 6, 8 and 10, D86: leaderTier copies come from the resolved decklist, a trio that spends cards on what the
// leader feeds every round follows the trios that add something, and a trio resting only on generic wants follows one with a specific
// link. Judged sessions: scratchpad judge-8-w21.md (Warrior) and judge-7-w21.md (Cad Bane).

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
const TIE_DAGGER = "04010239";
const OGGDO = "05010063";
const ARVEL = "07010191";
const AHSOKA_LEARNED = "06010096";
const WIPE_THEM_OUT = "08010137";
const CHIEFTAIN = "09010212";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const trios = (args: Record<string, unknown>): Record<string, any> => body(SYNERGY_TOOLS.find_trios.handler(real, { withAlternatives: false, evidence: false, ...args }));
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const LOCK_FIELDS = ["baseLocked", "nameLocked", "needsForce", "needsTrait", "needsHost", "leaderClash", "riderUnmet", "drawback"];
const unlocked = (t: Record<string, any>): boolean => LOCK_FIELDS.every((f) => t[f] === undefined);

describe.skipIf(!hasData)("leaderTier copies come from the resolved decklist (#168 item 6, D86)", () => {
  it("TIE Dagger Vanguard, 3 copies by name in the decklist, prints copies: 3", () => {
    const tier = trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 5 }).leaderTier as Record<string, any>[];
    const vanguard = tier.find((r) => r.cardKey === TIE_DAGGER) as Record<string, any>;
    expect(vanguard, tier.map((r) => r.title).join("; ")).toBeDefined();
    expect(vanguard.copies).toBe(3);
  });
});

describe.skipIf(!hasData)("a trio spending cards on what the leader feeds every round follows the others (#168 item 8, D86)", () => {
  it("Arvel Skeen's damage into Oggdo Bogdo duplicates Cad Bane's Action: the trio says so and follows every unlocked trio of its tier that adds something", () => {
    const list = trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 50 }).trios as Record<string, any>[];
    const at = list.findIndex((t) => keysOf(t).includes(ARVEL) && keysOf(t)[2] === OGGDO);
    expect(at, list.map((t) => t.cards).join(" | ")).toBeGreaterThanOrEqual(0);
    const dup = list[at];
    expect(String(dup.leaderAlreadyFeeds)).toContain("Cad Bane, Still Faster than You");
    expect(String(dup.leaderAlreadyFeeds)).toContain("Oggdo Bogdo");
    const later = list.slice(at + 1).filter((t) => unlocked(t) && t.deckMembers === dup.deckMembers && t.leaderAlreadyFeeds === undefined && t.genericLinksOnly === undefined && t.score > 0);
    expect(later.map((t) => t.cards)).toEqual([]);
  });
});

describe.skipIf(!hasData)("a trio resting only on generic wants follows one with a specific link (#168 item 10, D86)", () => {
  it("Ahsoka + Wipe Them Out + The Chieftain (two extra attacks into one unit) no longer leads: flagged after every unflagged unlocked trio of its tier, or folded under a trio of the same pair with a specific link", () => {
    const list = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, weighting: "none", limit: 50, cardKey: WIPE_THEM_OUT }).trios as Record<string, any>[];
    const shown = list.map((t) => `${t.cards}${t.genericLinksOnly === undefined ? "" : " [generic]"}`).join(" | ");
    const at = list.findIndex((t) => [AHSOKA_LEARNED, WIPE_THEM_OUT, CHIEFTAIN].every((k) => keysOf(t).includes(k)));
    if (at >= 0) {
      const generic = list[at];
      expect(String(generic.genericLinksOnly), shown).toContain("wants:extra-attacks");
      const later = list.slice(at + 1).filter((t) => unlocked(t) && t.deckMembers === generic.deckMembers && t.genericLinksOnly === undefined && t.leaderAlreadyFeeds === undefined && t.score > 0);
      expect(later.map((t) => t.cards)).toEqual([]);
    } else {
      const pair = list.find((t) => [AHSOKA_LEARNED, WIPE_THEM_OUT].every((k) => keysOf(t).includes(k)));
      expect(pair, shown).toBeDefined();
      expect(pair?.genericLinksOnly, shown).toBeUndefined();
    }
  });
});
