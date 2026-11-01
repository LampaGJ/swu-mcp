import { decode } from "@toon-format/toon";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

// LampaGJ/swu-mcp#170, D89: the meta_answers, deck_audit, playable_cards and find_pairings items of wave 24. Judged sessions:
// scratchpad judge-8-w23.md (Warrior, the 50-card list) and judge-7-w23.md (Cad Bane core); the calls are the sessions' own.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
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
const WARRIOR_LIST = [
  ["09010254", 2], ["08010248", 2], ["09010208", 1], ["09010196", 2], ["09010209", 3], ["09010224", 3], ["07010246", 1], ["08010114", 1], ["09010117", 3],
  ["06010188", 3], ["09010136", 3], ["09010213", 3], ["09010225", 2], ["09010212", 2], ["09010127", 1], ["08010219", 2], ["08010236", 1], ["05010261", 1],
  ["05010246", 2], ["06010096", 1], ["05010105", 1], ["08010135", 2], ["04010201", 1], ["09010230", 2], ["05010186", 2], ["09010145", 1], ["08010112", 2],
].map(([card, count]) => ({ card, count }));
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 }, { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 }, { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 }, { card: "No Glory, Only Results", count: 3 }, { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 }, { card: "TIE Dagger Vanguard", count: 3 }, { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 }, { card: "Ninth Sister, Hulking Inquisitor", count: 2 }, { card: "Outer Rim Constable", count: 2 },
];
const MARROK = "08010030";

describe.skipIf(!hasData)("Justifier's Advantage token feeds Marrok in the Cad Bane session (#170 item 1, D89)", () => {
  it("meta_answers: Marrok's Saboteur answers carry no conditionUnfed, he covers the threats again, and threatsCovered counts no unfed answer", () => {
    const out = body(META_TOOLS.meta_answers.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE, limit: 30 }));
    const rows = [...((out.staples ?? []) as Record<string, any>[]), ...((out.additions ?? []) as Record<string, any>[])];
    const marrok = rows.find((a) => a.cardKey === MARROK);
    expect(marrok, rows.map((r) => r.title).join("; ")).toBeDefined();
    for (const a of (marrok?.answers ?? []) as Record<string, any>[]) expect(a.conditionUnfed, a.threat).toBeUndefined();
    expect(Number(marrok?.coverage)).toBeGreaterThan(0);
    expect(String(out.threatsCovered)).not.toContain("unfed");
  });

  it("deck_audit: Marrok is no orphan want", () => {
    const out = body(DECK_TOOLS.deck_audit.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE }));
    expect(((out.orphanWants ?? []) as Record<string, any>[]).map((o) => o.cardKey)).not.toContain(MARROK);
  });
});

const HELIX = "08010221";

describe.skipIf(!hasData)("a negative card neither held nor a 50% staple fills no slot (#170 item 6, D89)", () => {
  it("the Warrior's step 4: Helix Starfighter (-39.7 points, 3% of lists) is not listed; negativeHidden counts it", () => {
    const out = body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 24, perCost: 3 }));
    const rows = out.cards as Record<string, any>[];
    expect(rows.map((r) => r.cardKey)).not.toContain(HELIX);
    for (const r of rows.filter((x) => x.evidenceClass === "negative")) expect(r.inDeck === true || (r.leaderInclusion ?? 0) >= 0.5 || r.remainingCopies < 3, r.title).toBe(true);
    expect(Number(out.negativeHidden)).toBeGreaterThanOrEqual(6);
  });

  it("a negative card the deck holds (The Darksaber) and one 50% or more of the lists play (Lightmaker) still show, flagged", () => {
    const out = body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 24, perCost: 3 }));
    const titles = (out.cards as Record<string, any>[]).filter((r) => r.evidenceClass === "negative").map((r) => String(r.title));
    expect(titles.some((t) => t.startsWith("The Darksaber")), titles.join("; ")).toBe(true);
    expect(titles.some((t) => t.startsWith("Lightmaker")), titles.join("; ")).toBe(true);
  });
});

const MARCHION_RO = "05010186";
const CHEWBACCA = "09010117";
const DARTH_TRAYA = "06010188";

describe.skipIf(!hasData)("find_pairings prints and ranks on the penalty the deck's remover leaves (#170 item 7, D89)", () => {
  const pairings = (cardKey: string): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey, leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, limit: 10, aspects: ["Cunning", "Heroism", "Command"], evidence: false })).pairings;

  it("step 5b (Chewbacca): Marchion Ro shows penalty 2 beside effectivePenalty 0 (The Darksaber on a carrier) and makes the top 10", () => {
    const rows = pairings(CHEWBACCA);
    const ro = rows.find((r) => r.cardKey === MARCHION_RO) as Record<string, any>;
    expect(ro, rows.map((r) => r.title).join("; ")).toBeDefined();
    expect(ro.penalty).toBe(2);
    expect(ro.effectivePenalty).toBe(0);
    expect(String(ro.penaltyRemovedBy)).toContain("The Darksaber");
  });

  it("step 5a (The Warrior): Darth Traya shows effectivePenalty 0 beside the printed 2", () => {
    const rows = pairings(WARRIOR);
    const traya = rows.find((r) => r.cardKey === DARTH_TRAYA) as Record<string, any>;
    expect(traya, rows.map((r) => r.title).join("; ")).toBeDefined();
    expect(traya.penalty).toBe(2);
    expect(traya.effectivePenalty).toBe(0);
  });
});

const BD1 = "05010191";

describe.skipIf(!hasData)("evidenceGap prints on ok rows too (#170 item 8, D89)", () => {
  it("BD-1, measured ok at about +7.7 points, prints its positive gap in playable_cards", () => {
    const out = body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: WARRIOR_LIST, costs: [1], perCost: 20, limit: 50 }));
    const bd1 = (out.cards as Record<string, any>[]).find((r) => r.cardKey === BD1) as Record<string, any>;
    expect(bd1).toBeDefined();
    expect(bd1.evidenceClass).toBe("ok");
    expect(Number(bd1.evidenceGap)).toBeGreaterThan(0.05);
  });

  it("deck_audit fills and missing staples print the gap of an ok row too", () => {
    const out = body(DECK_TOOLS.deck_audit.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE }));
    const staples = ((out.leaderComparison?.missingStaples ?? []) as Record<string, any>[]).filter((r) => r.evidenceClass === "ok");
    expect(staples.length).toBeGreaterThan(0);
    expect(staples.some((r) => typeof r.evidenceGap === "number")).toBe(true);
  });
});

describe.skipIf(!hasData)("a pinned cluster label lists only gap cards that carry one of the cluster's defining tags (#170 item 9, D89)", () => {
  it("Cad Bane: 'hand disruption and disclose' no longer offers 0-0-0 or Anakin Skywalker, Champion of Mortis", () => {
    const out = body(DECK_TOOLS.deck_audit.handler(real, { leader: CAD_BANE, base: NEVARRO, decklist: CAD_CORE }));
    const gaps = (out.clusterGaps?.gapCards ?? []) as Record<string, any>[];
    const hand = gaps.find((g) => g.label === "hand disruption and disclose");
    expect(hand, JSON.stringify(gaps)).toBeDefined();
    expect(String(hand?.cards)).not.toContain("0-0-0");
    expect(String(hand?.cards)).not.toContain("Anakin Skywalker");
  });
});
