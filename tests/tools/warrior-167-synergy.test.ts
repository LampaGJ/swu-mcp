import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#167 items 1, 2, 5, 6, 7 and 11, D85: leaderTier from the leader-engine links find_pairings uses, keyword links the
// deck already supplies three times over, trio substitutes no dearer in penalty than the member, no damaged-only damage into a
// damaged gate, opponent-chosen modes and self-defeat riders, and a member that is any upgrade. Judged sessions: scratchpad
// judge-8-w20.md (Warrior) and judge-7-w20.md (Cad Bane).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as { deck: { id: string; count: number }[] };
const DECKLIST = OWNER.deck.map((d) => ({ card: d.id, count: d.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const CAD_BANE = "08010011";
const NEVARRO = "08010020";
const BOBA = "09010225";
const CHIEFTAIN = "09010212";
const CHEWBACCA = "09010117";
const CAMP = "09010216";
const FETTS_FIRESPRAY_TITLE = "Fett's Firespray, Settling the Score";
const OPPO = "05010105";
const FIGURE = "06010104";
const ARCANA = "08010084";
const FLASH = "07010205";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const real = hasData ? loadStore(builtRun as string) : (undefined as never);
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const trios = (args: Record<string, unknown>): Record<string, any> => body(SYNERGY_TOOLS.find_trios.handler(real, { withAlternatives: false, evidence: false, ...args }));
const pairings = (args: Record<string, unknown>): Record<string, any> => body(SYNERGY_TOOLS.find_pairings.handler(real, { withAlternatives: false, evidence: false, ...args }));
const warriorNone = (extra: Record<string, unknown> = {}) => trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, weighting: "none", limit: 10, ...extra });
const warriorWeighted = (extra: Record<string, unknown> = {}) => trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 5, ...extra });
const cadStep6 = (extra: Record<string, unknown> = {}) => trios({ leaderAspects: ["Aggression", "Villainy"], baseAspects: ["Vigilance"], decklist: CAD_CORE, limit: 50, ...extra });
const cadStep14 = (extra: Record<string, unknown> = {}) => trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 50, ...extra });
const ENGINE_LINK = /^leader:|^offers:ready-leader -> leader:action/;

describe.skipIf(!hasData)("leaderTier takes the leader-engine links find_pairings uses (#167 item 1, D85)", () => {
  it("unweighted, The Warrior's tier holds Boba Fett, The Chieftain, Chewbacca and Insurgent Camp, each with its leader-engine link", () => {
    const tier = warriorNone().leaderTier as Record<string, any>[];
    const keys = tier.map((r) => r.cardKey);
    for (const k of [BOBA, CHIEFTAIN, CHEWBACCA, CAMP]) expect(keys, tier.map((r) => `${r.title} (${r.link})`).join("; ")).toContain(k);
    const camp = tier.find((r) => r.cardKey === CAMP) as Record<string, any>;
    expect(camp.link).toBe("leader:grant-ambush -> offers:ready-played-unit");
    expect(String(camp.leaderClause)).toContain("Play a unit with 3 or less power");
    for (const r of tier) expect(r.link, r.title).not.toBe("offers:paid-play -> wants:units-played");
  });

  it("weighted, Insurgent Camp keeps its specific link and sits ahead of the penalised Fett's Firespray; Boba Fett is listed", () => {
    const tier = warriorWeighted().leaderTier as Record<string, any>[];
    const titles = tier.map((r) => String(r.title));
    const at = (k: string) => tier.findIndex((r) => r.cardKey === k);
    expect(at(CAMP), titles.join("; ")).toBeGreaterThanOrEqual(0);
    expect(tier[at(CAMP)].link).toBe("leader:grant-ambush -> offers:ready-played-unit");
    expect(at(BOBA), titles.join("; ")).toBeGreaterThanOrEqual(0);
    const fett = titles.indexOf(FETTS_FIRESPRAY_TITLE);
    if (fett >= 0) expect(at(CAMP)).toBeLessThan(fett);
  });

  it("a generic play link follows every leader-engine row in the tier", () => {
    for (const tier of [warriorNone().leaderTier, warriorWeighted().leaderTier] as Record<string, any>[][]) {
      const firstGeneric = tier.findIndex((r) => !ENGINE_LINK.test(String(r.link)) && String(r.link).includes("wants:units-played"));
      if (firstGeneric < 0) continue;
      for (const r of tier.slice(firstGeneric)) expect(ENGINE_LINK.test(String(r.link)), r.title).toBe(false);
    }
  });

  it("Cad Bane's tier still quotes the Action and holds Rancor Keeper", () => {
    const tier = cadStep14({ limit: 5 }).leaderTier as Record<string, any>[];
    const keeper = tier.find((r) => r.title === "Rancor Keeper") as Record<string, any>;
    expect(keeper, tier.map((r) => r.title).join("; ")).toBeDefined();
    expect(keeper.leaderClause).toContain("Deal 1 damage to a unit with 2 or more remaining HP");
  });
});

describe.skipIf(!hasData)("a keyword the deck already supplies three times over is a redundant link (#167 item 2, D85)", () => {
  it("Figure of Unity -> Oppo Rancisis: the deck holds 9 cards that give Oppo Raid and 4 that give him Restore, so the trio names the link redundant and scores it lower", () => {
    const all = warriorNone({ limit: 20 }).trios as Record<string, any>[];
    const fig = all.find((t) => keysOf(t).includes(FIGURE) && keysOf(t).includes(OPPO)) as Record<string, any> | undefined;
    if (fig !== undefined) {
      expect(String(fig.redundantLinks), fig.cards).toContain("Figure of Unity -> Oppo Rancisis, Ancient Councilor (Raid, Restore:");
      expect(all.indexOf(fig)).toBeGreaterThan(0);
    }
    const plain = trios({ leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", limit: 50, cardKey: FIGURE }).trios as Record<string, any>[];
    const withDeck = warriorNone({ limit: 50, cardKey: FIGURE }).trios as Record<string, any>[];
    const id = (t: Record<string, any>) => String(t.cardKeys);
    const both = withDeck.filter((t) => keysOf(t).includes(OPPO) && plain.some((p) => id(p) === id(t)));
    expect(both.length, withDeck.map((t) => t.cards).join("; ")).toBeGreaterThan(0);
    for (const t of both) expect(t.score, t.cards).toBeLessThan((plain.find((p) => id(p) === id(t)) as Record<string, any>).score);
  });

  it("find_pairings for Oppo: with the deck, the Figure of Unity row names Raid and Restore redundant; two of its three rows count half", () => {
    const args = { cardKey: OPPO, leader: WARRIOR, base: ORIGIN_TREE, weighting: "none", limit: 100, perLink: 100 };
    const fig = (out: Record<string, any>) => (out.pairings as Record<string, any>[]).find((r) => r.cardKey === FIGURE) as Record<string, any>;
    const plain = fig(pairings(args));
    const withDeck = fig(pairings({ ...args, decklist: DECKLIST }));
    expect(plain.redundantKeyword).toBeUndefined();
    expect(String(withDeck.redundantKeyword)).toMatch(/^Raid, Restore: /);
    expect(withDeck.redundantFactor).toBeCloseTo(1 - 0.5 * (2 / 3), 3);
    expect(withDeck.score).toBeCloseTo(plain.score * withDeck.redundantFactor, 2);
  });
});

describe.skipIf(!hasData)("trio substitutes pay no more aspect penalty than the member (#167 item 5, D85)", () => {
  it("Ahsoka Tano + Insurgent Camp + The Chieftain: slot C lists no Hunting Assassin Droid, Oppo Rancisis or Captain Pellaeon", () => {
    // D87 (#169): a trio that is no variant now keeps its own row and the Chieftain trio left the first 10, so the call names the card.
    const out = trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 10, withAlternatives: true, cardKey: CHIEFTAIN });
    let slots = 0;
    for (const t of out.trios as Record<string, any>[]) {
      for (const alt of (t.alternatives ?? []) as Record<string, any>[]) {
        const text = ((alt.substitutes ?? []) as string[]).join("; ");
        if (!keysOf(t).includes(CHIEFTAIN) || alt.slot !== "ABC"[keysOf(t).indexOf(CHIEFTAIN)]) continue;
        slots++;
        for (const name of ["Hunting Assassin Droid", "Oppo Rancisis", "Captain Pellaeon"]) expect(text, t.cards).not.toContain(name);
      }
    }
    expect(slots).toBeGreaterThan(0);
  });

  it("a member with no penalty takes only covered substitute groups", () => {
    let checked = 0;
    for (const out of [trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 10, withAlternatives: true }), cadStep14({ limit: 10, withAlternatives: true })]) {
      for (const t of out.trios as Record<string, any>[]) {
        if (t.penalty !== 0) continue;
        for (const alt of (t.alternatives ?? []) as Record<string, any>[]) for (const g of (alt.substitutes ?? []) as string[]) {
          checked++;
          expect(g, t.cards).toContain("(covered)");
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasData)("damage to a damaged unit never switches on a damaged gate in a trio (#167 item 6, D85)", () => {
  it("no Cad Bane trio links TIE Dagger Vanguard into Oggdo Bogdo, as a member or a variant", () => {
    for (const out of [cadStep14(), cadStep6()]) {
      for (const t of out.trios as Record<string, any>[]) {
        expect(String(t.reasons), t.cards).not.toContain("TIE Dagger Vanguard -> Oggdo Bogdo, Bogano Brute");
        if (keysOf(t).includes("04010239") && String(t.reasons).includes("TIE Dagger Vanguard -> ")) {
          const fedSlot = String(t.reasons).match(/TIE Dagger Vanguard -> ([^:]+):/)?.[1];
          if (fedSlot !== undefined) expect(((t.variants ?? []) as Record<string, any>[]).map((v) => v.title), t.cards).not.toContain("Oggdo Bogdo, Bogano Brute");
        }
      }
    }
  });
});

describe.skipIf(!hasData)("an opponent-chosen mode never closes a trio; a self-defeat rider is a drawback (#167 item 7, D85)", () => {
  it("Watto's On Attack modes are the opponent's pick, so no trio links Watto into a member", () => {
    for (const t of cadStep6().trios as Record<string, any>[]) expect(String(t.reasons), t.cards).not.toContain("Watto, No Money, No Parts, No Deal -> ");
  });

  it("Flash the Vents defeats the unit it attacks with once that unit damages a base: drawback on every trio it feeds a unit in", () => {
    const withFlash = cadStep6({ cardKey: FLASH }).trios as Record<string, any>[];
    const feeding = withFlash.filter((t) => String(t.reasons).includes("Flash the Vents -> "));
    expect(feeding.length).toBeGreaterThan(0);
    for (const t of feeding) expect(String(t.drawback), t.cards).toContain("defeat that unit");
  });
});

describe.skipIf(!hasData)("a member that is any upgrade drops the trio to a two-card line (#167 item 11, D85)", () => {
  it("Arcana Star Map links only as \"is an upgrade\": no Cad Bane trio holds it", () => {
    for (const t of cadStep6().trios as Record<string, any>[]) expect(keysOf(t), t.cards).not.toContain(ARCANA);
    expect((cadStep6({ cardKey: ARCANA }).trios as Record<string, any>[]).length).toBe(0);
  });

  it("an upgrade with a link of its own (Watchful takes Hotshot Maneuver's extra attack) still closes a trio", () => {
    const all = cadStep6().trios as Record<string, any>[];
    expect(all.some((t) => String(t.cards).includes("Watchful") || ((t.variants ?? []) as Record<string, any>[]).some((v) => v.title === "Watchful")), all.map((t) => t.cards).join("; ")).toBe(true);
  });
});
