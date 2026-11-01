import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#166 items 1 to 3, 5, 7 and 12, D84: variants pass the member checks, dead filler and leader-unplayable variants,
// the penalty already in a trio's score, arena-limited extra attacks, the leader-anchored first tier, and a trait gate read from the
// quoted mode only. Judged sessions: scratchpad judge-8-w19.md (Warrior) and judge-7-w19.md (Cad Bane).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
};
const DECKLIST = OWNER_DECK.deck.map((d) => ({ card: d.id, count: d.count }));

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
const GORN = "07010221";
const RAMPART = "09010060";
const LAST_WORDS = "05010263";
const SINISTER_MEMORIAL = "09010113";
const C3PO_TP = "07010152";
const MARROK = "08010030";
const ATTACK_RUN = "04010261";
const CLANDESTINE = "06010264";
const RANCOR_KEEPER = "08010032";
const CHOOSE_PATH = "08010257";
const KOSKA = "08010079";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

const real = hasData ? loadStore(builtRun as string) : (undefined as never);
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const variantTitles = (t: Record<string, any>): string[] => ((t.variants ?? []) as Record<string, any>[]).map((v) => String(v.title));
const trios = (args: Record<string, unknown>): Record<string, any> =>
  body(SYNERGY_TOOLS.find_trios.handler(real, { withAlternatives: false, evidence: false, ...args }));
const warriorNone = (extra: Record<string, unknown> = {}) => trios({ leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, weighting: "none", limit: 50, ...extra });
const cadStep6 = (extra: Record<string, unknown> = {}) => trios({ leaderAspects: ["Aggression", "Villainy"], baseAspects: ["Vigilance"], decklist: CAD_CORE, limit: 50, ...extra });
const cadStep14 = (extra: Record<string, unknown> = {}) => trios({ leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 50, ...extra });

describe.skipIf(!hasData)("a variant passes the member's rider and gate checks (#166 item 1, D84)", () => {
  it("C-3PO, Translation Protocol gives Experience only to a unit sharing a trait with a friendly leader; Marrok shares none with Cad Bane: riderUnmet, never a variant", () => {
    const out = cadStep14();
    for (const t of out.trios as Record<string, any>[]) {
      expect(variantTitles(t).join("; "), t.cards).not.toContain("C-3PO, Translation Protocol");
      if (keysOf(t).includes(C3PO_TP) && keysOf(t).includes(MARROK)) expect(t.riderUnmet, t.cards).toContain("shares a Trait with a friendly leader");
    }
    // D87 (#169): a trio that is no variant now keeps its own row, so the unlocked C-3PO trios fill a 50-row page; each shape is read apart.
    const withC3po = ["chain", "convergent-same-want"].flatMap((shape) => cadStep14({ cardKey: C3PO_TP, minPlayed: 0, shape }).trios as Record<string, any>[]);
    const onMarrok = withC3po.filter((t) => keysOf(t).includes(MARROK) && String(t.reasons).includes("C-3PO, Translation Protocol -> Marrok"));
    expect(onMarrok.length).toBeGreaterThan(0);
    for (const t of onMarrok) expect(t.riderUnmet, t.cards).toContain("C-3PO, Translation Protocol");
  });

  it("Vice Admiral Rampart, A New Era of Safety defeats himself only to save an upgrade on your base; the Cad Bane core has none: riderUnmet, never a variant", () => {
    for (const t of cadStep6().trios as Record<string, any>[]) expect(variantTitles(t).join("; "), t.cards).not.toContain("Vice Admiral Rampart, A New Era of Safety");
    const withRampart = cadStep6({ cardKey: RAMPART }).trios as Record<string, any>[];
    expect(withRampart.length).toBeGreaterThan(0);
    // D89 (#170): Justifier's Advantage token already feeds Marrok, so Last Words into Marrok proposes nothing (D82); any Last Words trio carries the rider.
    const lastWords = withRampart.find((x) => keysOf(x).includes(LAST_WORDS)) as Record<string, any>;
    expect(lastWords, withRampart.map((x) => x.cards).join("; ")).toBeDefined();
    expect(lastWords.riderUnmet).toContain("upgrade on your base");
    // Sinister War Memorial is a Fortify upgrade on your base, so beside it Rampart's replacement can fire.
    const memorial = withRampart.find((x) => keysOf(x).includes(SINISTER_MEMORIAL));
    if (memorial !== undefined) expect(String(memorial.riderUnmet ?? ""), memorial.cards).not.toContain("Vice Admiral Rampart");
  });

  it("no variant carries a lock the member checks give (leaderClash or riderUnmet would name it)", () => {
    for (const out of [warriorNone(), cadStep6(), cadStep14()]) {
      for (const t of out.trios as Record<string, any>[]) {
        for (const title of variantTitles(t)) {
          expect(String(t.riderUnmet ?? ""), `${t.cards}: ${title}`).not.toContain(`${title}:`);
          expect(String(t.leaderClash ?? ""), `${t.cards}: ${title}`).not.toContain(`${title}:`);
        }
      }
    }
  });
});

describe.skipIf(!hasData)("dead filler and variants the leader cannot play (#166 item 2, D84)", () => {
  it("Lieutenant Gorn only takes an enemy Credit token, which nothing in the deck makes for the opponent: riderUnmet as a member, never a variant", () => {
    for (const t of warriorNone().trios as Record<string, any>[]) expect(variantTitles(t).join("; "), t.cards).not.toContain("Lieutenant Gorn");
    const withGorn = warriorNone({ cardKey: GORN }).trios as Record<string, any>[];
    expect(withGorn.length).toBeGreaterThan(0);
    for (const t of withGorn) expect(t.riderUnmet, t.cards).toContain("Credit token");
  });

  it("a variant the leader cannot play, for a member the leader plays (The Warrior: 3 or less power), says so and follows the ones it can play", () => {
    let flagged = 0;
    for (const t of warriorNone().trios as Record<string, any>[]) {
      const vs = (t.variants ?? []) as Record<string, any>[];
      for (const slot of ["A", "B", "C"]) {
        const inSlot = vs.filter((v) => v.slot === slot);
        const first = inSlot.findIndex((v) => v.leaderCannotPlay !== undefined);
        if (first < 0) continue;
        flagged++;
        for (const v of inSlot.slice(first)) expect(v.leaderCannotPlay, `${t.cards}: ${v.title} after a flagged variant`).toBeDefined();
        expect(String(inSlot[first].leaderCannotPlay)).toContain("The Warrior, Deft Duelist");
      }
    }
    expect(flagged).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasData)("the aspect penalty in a trio's order is shown (#166 item 3, D84)", () => {
  it("a trio with a penalty prints penaltyFactor = 1 / (1 + penalty / 2), already inside its score, and the order note says so", () => {
    const out = warriorNone({ limit: 6 });
    expect(String(out.order)).toContain("penaltyFactor");
    const penalised = (out.trios as Record<string, any>[]).filter((t) => t.penalty > 0);
    expect(penalised.length).toBeGreaterThan(0);
    for (const t of out.trios as Record<string, any>[]) {
      if (t.penalty > 0) expect(t.penaltyFactor, t.cards).toBeCloseTo(1 / (1 + t.penalty / 2), 3);
      else expect(t.penaltyFactor, t.cards).toBeUndefined();
    }
  });
});

describe.skipIf(!hasData)("an arena-limited extra attack reaches only an upgrade on a unit of that arena (#166 item 5, D84)", () => {
  it("Attack Run (space units only) does not feed Clandestine Connections on Marrok (ground): no such trio, and Attack Run is no variant for a ground carrier", () => {
    for (const t of cadStep6().trios as Record<string, any>[]) {
      const keys = keysOf(t);
      expect(keys.includes(ATTACK_RUN) && keys.includes(CLANDESTINE) && keys.includes(MARROK), t.cards).toBe(false);
      if (keys.includes(MARROK) && String(t.reasons).includes("-> Marrok, Mysterious Warrior: upgrade-stacking")) expect(variantTitles(t), t.cards).not.toContain("Attack Run");
    }
  });
});

describe.skipIf(!hasData)("trios list the leader's own ability first (#166 item 7, D84)", () => {
  it("Cad Bane's ping feeds Rancor Keeper: find_trios lists it in leaderTier, before the trios, quoting the leader's Action", () => {
    const out = cadStep14({ limit: 5 });
    const tier = out.leaderTier as Record<string, any>[];
    expect(Array.isArray(tier)).toBe(true);
    const keeper = tier.find((r) => r.cardKey === RANCOR_KEEPER) as Record<string, any>;
    expect(keeper, tier.map((r) => r.title).join("; ")).toBeDefined();
    expect(keeper.leaderClause).toContain("Deal 1 damage to a unit with 2 or more remaining HP");
    expect(Object.keys(out).indexOf("leaderTier")).toBeLessThan(Object.keys(out).indexOf("trios"));
    expect(String(out.leaderTierNote)).toContain("D84");
  });

  it("the leader tier is ranked like find_pairings and lists only cards a deck can hold", () => {
    const tier = cadStep14({ limit: 5 }).leaderTier as Record<string, any>[];
    expect(tier.length).toBeGreaterThan(0);
    for (const r of tier) expect(["Unit", "Event", "Upgrade"]).toContain(r.type);
    const unlocked = tier.filter((r) => r.baseLocked === undefined && r.needsForce === undefined && r.needsTrait === undefined && r.nameLocked === undefined);
    for (let i = 1; i < unlocked.length; i++) expect(unlocked[i].rank <= unlocked[i - 1].rank, `${unlocked[i - 1].title} before ${unlocked[i].title}`).toBe(true);
  });

  it("without a leader there is no leader tier", () => {
    expect(cadStep6({ limit: 3 }).leaderTier).toBeUndefined();
  });
});

describe.skipIf(!hasData)("traitGateMetBy reads the quoted mode only (#166 item 12, D84)", () => {
  it("Choose Your Path's Mandalorian mode is met by Koska Reeves, not by the Force units of mode 1", () => {
    const out = body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: KOSKA, leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 50, perLink: 100, tribalLimit: 50 }));
    const all: Record<string, any>[] = [...((out.tribal?.pairings ?? []) as Record<string, any>[]), ...(out.pairings as Record<string, any>[])];
    const path_ = all.find((r) => r.cardKey === CHOOSE_PATH) as Record<string, any>;
    expect(path_, all.map((r) => r.title).join("; ")).toBeDefined();
    expect(path_.traitGateMetBy).toContain("Koska Reeves");
    expect(path_.traitGateMetBy).not.toContain("Marrok");
    expect(path_.traitGateMetBy).not.toContain("Ninth Sister");
  });
});
