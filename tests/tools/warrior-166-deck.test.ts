import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#166 items 8 to 11, D84: a Darksaber carrier counts as a deck link, sideboard answers are not additions and
// thin-control staples follow significant ones, a cost-curve glut is named with untaxed fills, and budget swaps state their
// own-base damage, their removal cap and the removal job. Judged sessions: scratchpad judge-8-w19.md and judge-7-w19.md.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_SWUDB = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
  sideboard: { id: string; count: number }[];
};
const DECKLIST = OWNER_SWUDB.deck.map((d) => ({ card: d.id, count: d.count }));

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
const OPPO = "05010105";
const QIMIR = "09010196";
const EXPLOIT_CONFIDENCE = "09010238";
const RANCOR = "08010179";
const TREE = "07010132";
const NO_GLORY = "04010043";
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];

describe.skipIf(!hasData)("fungible_substitutes counts a Darksaber carrier as a deck link (#166 item 8, D84)", () => {
  const rec = (): Record<string, any> =>
    body(SYNERGY_TOOLS.fungible_substitutes.handler(real, { cardKey: OPPO, preferAspects: ["Cunning", "Heroism", "Command"], leader: WARRIOR, base: ORIGIN_TREE, candidates: ["LOF_190"], decklist: DECKLIST, evidence: false })).recommendation;

  it("Qimir carries The Darksaber for Darth Traya and Marchion Ro, so wherever it is named its deckLinks is not 0, and the verdict counts carriers", () => {
    const r = rec();
    const cut = r.cutForCandidate as Record<string, any>;
    expect(cut).toBeDefined();
    if (cut.cardKey === QIMIR) {
      expect(cut.deckLinks).toBeGreaterThan(0);
      expect(String(cut.carrierLinks)).toContain("Darth Traya");
      expect(String(r.verdict)).toContain("carrier links through The Darksaber");
    }
    expect(String(r.verdict)).not.toContain("Qimir, Everyone Has a Weakness (penalty 2, unplayed, 0 ");
  });
});

describe.skipIf(!hasData)("meta_answers: sideboard rows are no additions, thin-control staples follow significant ones (#166 item 9, D84)", () => {
  it("Exploit Confidence, in the owner's sideboard, is listed under sideboardAnswers, not additions", () => {
    const out = body(META_TOOLS.meta_answers.handler(real, { swudb: OWNER_SWUDB, limit: 10, archetypes: 6 }));
    expect((out.additions as Record<string, any>[]).map((r) => r.cardKey)).not.toContain(EXPLOIT_CONFIDENCE);
    const side = (out.sideboardAnswers ?? []) as Record<string, any>[];
    const exploit = side.find((r) => r.cardKey === EXPLOIT_CONFIDENCE);
    expect(exploit, side.map((r) => r.title).join("; ")).toBeDefined();
    expect(exploit?.inSideboard).toBe(2);
    for (const r of out.additions as Record<string, any>[]) expect(r.inSideboard, r.title).toBeUndefined();
  });

  it("Cad Bane: no thin-control staple sits above a significant one (Ninth Sister and Marrok after Justifier)", () => {
    const staples = body(META_TOOLS.meta_answers.handler(real, { leader: CAD_BANE, base: NEVARRO, limit: 10, archetypes: 6 })).staples as Record<string, any>[];
    const lastSignificant = staples.map((s) => s.significant === true).lastIndexOf(true);
    expect(lastSignificant).toBeGreaterThanOrEqual(0);
    expect(staples.slice(0, lastSignificant).filter((s) => s.evidenceClass === "thin-control").map((s) => s.title)).toEqual([]);
  });
});

describe.skipIf(!hasData)("deck_audit names a cost-curve glut and untaxed fills at the thin costs (#166 item 10, D84)", () => {
  it("the Warrior list holds 25 three-cost cards of 50: curveGlut names cost 3 and fills at costs 4 and 5, none taxed and none in the deck", () => {
    const a = body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST }));
    const glut = a.curveGlut as Record<string, any>;
    expect(glut).toBeDefined();
    expect(glut.cost).toBe("3");
    expect(glut.cards).toBe(25);
    expect(glut.thinCosts).toEqual(expect.arrayContaining([4, 5]));
    const fills = glut.fills as Record<string, any>[];
    expect(fills.length).toBeGreaterThan(0);
    const deckKeys = new Set(DECKLIST.map((d) => d.card));
    for (const f of fills) {
      expect(f.penalty, f.title).toBe(0);
      expect(deckKeys.has(f.cardKey), f.title).toBe(false);
      expect(glut.thinCosts).toContain(f.cost);
    }
    expect(fills.map((f) => f.title).join("; ")).toContain("Lightmaker");
  });

  it("a flat curve draws no glut (the 34-card Cad Bane core)", () => {
    const a = body(DECK_TOOLS.deck_audit.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE }));
    expect(a.curveGlut).toBeUndefined();
  });
});

describe.skipIf(!hasData)("budget swaps state own-base damage, a removal cap and the removal job (#166 item 11, D84)", () => {
  const budget = (): Record<string, any> => body(DECK_TOOLS.budget_alternatives.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, maxPrice: 2 }));
  const swaps = (out: Record<string, any>) => (out.slots as Record<string, any>[]).flatMap((s) => s.alternatives as Record<string, any>[]);

  it("Boba Fett's Rancor deals 5 damage to your own base: drawback", () => {
    const rancor = swaps(budget()).find((a) => a.cardKey === RANCOR);
    expect(rancor).toBeDefined();
    expect(rancor?.drawback).toContain("Deal 5 damage to your base");
  });

  it("The Tree Remembers defeats only a unit that costs 3 or less: limit", () => {
    const tree = swaps(budget()).find((a) => a.cardKey === TREE);
    expect(tree).toBeDefined();
    expect(tree?.limit).toContain("If it costs 3 or less, defeat it.");
  });

  it("the No Glory slot prints its removal job, and each swap names keepsRole", () => {
    const slot = (budget().slots as Record<string, any>[]).find((s) => s.cardKey === NO_GLORY) as Record<string, any>;
    expect(slot).toBeDefined();
    expect(slot.job).toContain("removes a unit");
    for (const a of slot.alternatives as Record<string, any>[]) expect(a.keepsRole, a.title).toContain("removal");
  });
});
