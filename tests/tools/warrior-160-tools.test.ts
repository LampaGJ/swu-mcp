import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { hasWeakClosingLink } from "../../src/synergy/slots.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS, resolveRef } from "../../src/tools/deck.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

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
const OPPO = "05010105";
const CHIEFTAIN = "09010212";
const SOARING_CAN_CELL = "09010131";
const KASHYYYK_CARDS = ["09010131", "09010142", "09010145", "09010151"];

const real = hasData ? loadStore(builtRun as string) : (undefined as never);
const ctx = hasData ? synergyContextOf(real) : (undefined as never);
const IN_DECK = new Set(
  DECKLIST.map((d) => {
    const hit = hasData ? resolveRef(real, d.card, "main") : undefined;
    return hit?.ok ? hit.row.cardKey : d.card;
  }),
);
const lockedKeys = ["needsHost", "baseLocked", "nameLocked", "needsForce", "needsTrait"];
const isLocked = (t: Record<string, any>): boolean => lockedKeys.some((k) => t[k] !== undefined);
const members = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");
const heldInDeck = (t: Record<string, any>): number => members(t).filter((k) => IN_DECK.has(k)).length;
const tierOf = (t: Record<string, any>): number => (heldInDeck(t) === 3 ? 1 : heldInDeck(t) === 0 ? 2 : 0);
const weak = (t: Record<string, any>): boolean => {
  const [a, b, c] = members(t);
  return hasWeakClosingLink(ctx.graph, { cardA: a, cardB: b, cardC: c, shape: t.shape });
};

describe.skipIf(!hasData)("find_trios with a decklist leads with a trio that adds a card (#160, D73)", () => {
  const step6 = (extra: object = {}): Record<string, any>[] =>
    body(
      SYNERGY_TOOLS.find_trios.handler(real, {
        leaderAspects: ["Cunning", "Heroism"],
        baseAspects: ["Command"],
        decklist: DECKLIST,
        limit: 6,
        evidence: false,
        withAlternatives: false,
        ...extra,
      }),
    ).trios;
  const step14 = (extra: object = {}): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 5, evidence: false, withAlternatives: false, ...extra })).trios;

  it("step 6: the first trio holds a deck card and a card that is not in the deck", () => {
    const first = step6()[0];
    expect(heldInDeck(first)).toBeGreaterThanOrEqual(1);
    expect(heldInDeck(first)).toBeLessThanOrEqual(2);
    expect(first.deckMembers).toBe(heldInDeck(first));
  });

  it("step 14: the first trio holds a deck card and a card that is not in the deck", () => {
    const first = step14()[0];
    expect(heldInDeck(first)).toBeGreaterThanOrEqual(1);
    expect(heldInDeck(first)).toBeLessThanOrEqual(2);
  });

  it("orders the unlocked trios by tier (mixed, all-deck, no deck card), then strong before weak closing links", () => {
    for (const trios of [step6({ limit: 50 }), step14({ limit: 50 })]) {
      const open = trios.filter((t) => !isLocked(t));
      expect(open.map(tierOf)).toEqual([...open.map(tierOf)].sort((x, y) => x - y));
      for (const tier of [0, 1, 2]) {
        const inTier = open.filter((t) => tierOf(t) === tier).map((t) => Number(weak(t)));
        expect(inTier, `tier ${tier}`).toEqual([...inTier].sort((x, y) => x - y));
      }
      expect(open.some((t) => tierOf(t) === 0)).toBe(true);
    }
  });

  it("puts no weak-closing mixed trio ahead of a strong one on the first page of step 6", () => {
    const rows = step6({ limit: 50 }).filter((t) => tierOf(t) === 0 && !isLocked(t));
    const firstWeak = rows.findIndex(weak);
    if (firstWeak >= 0) expect(rows.slice(firstWeak).every(weak)).toBe(true);
  });
});

describe.skipIf(!hasData)("find_pairings applies the aspect penalty to the leader-weighted rank (#160, D73)", () => {
  const pairings = (cardKey: string, extra: object = {}): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 100, perLink: 100, evidence: false, withAlternatives: false, ...extra })).pairings;
  const at = (rows: Record<string, any>[], title: string): number => rows.findIndex((r) => r.title === title);

  it("ranks Commandeered Tour Shuttle (penalty 2) after Insurgent Camp (penalty 0) for The Chieftain", () => {
    const rows = pairings(CHIEFTAIN);
    expect(rows[at(rows, "Commandeered Tour Shuttle")].penalty).toBe(2);
    expect(rows[at(rows, "Insurgent Camp")].penalty).toBe(0);
    expect(at(rows, "Insurgent Camp")).toBeLessThan(at(rows, "Commandeered Tour Shuttle"));
  });

  it("ranks Punishing One (penalty 2) after the penalty-0 engine partners of the same score for the leader", () => {
    const rows = pairings(WARRIOR);
    const punishing = rows.find((r) => r.title === "Punishing One, Takes No Prisoners") as Record<string, any>;
    expect(punishing.penalty).toBe(2);
    for (const r of rows.filter((x) => !isLocked(x) && x.penalty === 0 && x.score >= punishing.score)) expect(r.rank, r.title).toBeGreaterThan(punishing.rank);
  });

  it("states the factor in rankNote, and the base-enabled factor only when a partner carries it", () => {
    const run = (cardKey: string, extra: object = {}): Record<string, any> =>
      body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 100, perLink: 100, evidence: false, withAlternatives: false, ...extra }));
    expect(run(CHIEFTAIN).rankNote).toContain("score / (1 + penalty)");
    expect(run(CHIEFTAIN).rankNote).toContain("divided by 3");
    expect(run(CHIEFTAIN, { weighting: "none" }).rankNote).toBeUndefined();
    expect(run(OPPO, { decklist: undefined }).rankNote).toContain("baseEnabled");
  });

  it("keeps the unweighted rank (weighting none) as before: score divided by 1 + penalty / 2", () => {
    const rows = pairings(CHIEFTAIN, { weighting: "none" });
    const shuttle = rows[at(rows, "Commandeered Tour Shuttle")];
    expect(shuttle.rank).toBe(Math.round((shuttle.score / 2) * 1000) / 1000);
  });
});

describe.skipIf(!hasData)("base-location-enabled cards are marked and promoted (#160, D73)", () => {
  it("find_pairings marks Soaring Can-Cell baseEnabled: Kashyyyk under Origin Tree, quotes the clause, and ranks it higher than under a Tatooine base", () => {
    const under = (base: string): Record<string, any> | undefined =>
      (body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: OPPO, leader: WARRIOR, base, maxCost: 2, limit: 100, perLink: 100, evidence: false, withAlternatives: false })).pairings as Record<string, any>[]).find(
        (r) => r.cardKey === SOARING_CAN_CELL,
      );
    const tree = under(ORIGIN_TREE) as Record<string, any>;
    expect(tree.baseEnabled).toBe("Kashyyyk");
    expect(tree.baseEnabledClause).toBe("While you control a Kashyyyk base, this unit gains Ambush.");
    const dune = under("Jundland Wastes");
    // Under Jundland Wastes the card is not enabled; it either falls off the first 100 rows or ranks below its Origin Tree row.
    expect(dune?.baseEnabled).toBeUndefined();
    expect(dune?.rank ?? 0).toBeLessThan(tree.rank);
  });

  it("playable_cards lists the Kashyyyk cards under Origin Tree with baseEnabled and the clause, first within their cost", () => {
    const rows = body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, limit: 60, perCost: 6 })).cards as Record<string, any>[];
    const enabled = rows.filter((r) => r.baseEnabled !== undefined);
    expect(enabled.map((r) => r.cardKey).sort()).toEqual(expect.arrayContaining([SOARING_CAN_CELL, "09010145"]));
    for (const r of enabled) {
      expect(r.baseEnabled).toBe("Kashyyyk");
      expect(String(r.baseEnabledClause)).toContain("Kashyyyk base");
      expect(KASHYYYK_CARDS).toContain(r.cardKey);
      const sameCost = rows.filter((x) => x.cost === r.cost && x.cardKey !== null && x.baseLocked === undefined && x.needsUnitAspect === undefined);
      expect(sameCost[0].baseEnabled, `${r.title} leads cost ${r.cost}`).toBeDefined();
    }
  });

  it("playable_cards marks nothing under a base that enables no card of its list", () => {
    const rows = body(DECK_TOOLS.playable_cards.handler(real, { leader: WARRIOR, base: "Jundland Wastes", limit: 60, perCost: 6 })).cards as Record<string, any>[];
    expect(rows.filter((r) => KASHYYYK_CARDS.includes(r.cardKey))).toEqual([]);
  });
});
