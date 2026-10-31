import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { compareAnswerRank, META_TOOLS, type AnswerRank } from "../../src/tools/meta.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK: unknown = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8"));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/archetypes.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const BOBA_FETT = "09010225";
const LUKE_BEGINNING = "05010249";
const OBI_WAN = "05010096";
const LEIA = "09010115";
const CHEWBACCA = "09010117";
const CHIEFTAIN = "09010212";
const TRAYA = "06010188";
const NEEL = "08010248";
const SANDCRAWLER = "09010222";

// The owner's deck: leader The Warrior, Deft Duelist, base Origin Tree (tests/fixtures/decks/warrior-chewie-raid.swudb.json), judged in session eight (#156, D65).
describe.skipIf(!hasData)("The Warrior / Origin Tree against the built data (#156, D65)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const pairings = (extra: object = {}): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, limit: 100, perLink: 100, ...extra })).pairings;
  const rowOf = (rows: Record<string, any>[], cardKey: string): Record<string, any> => {
    const row = rows.find((r) => r.cardKey === cardKey);
    expect(row, `${cardKey} is a partner`).toBeDefined();
    return row as Record<string, any>;
  };

  describe("1. leader-engine rows take the played/unplayed factor", () => {
    it("halves every engine row the leader's lists do not play: its rank is at most half its score", () => {
      const engine = pairings().filter((r) => String(r.reason).includes("Leader engine") && (r.leaderInclusion === null || r.leaderInclusion < 0.02));
      expect(engine.length, "the Warrior has unplayed engine partners").toBeGreaterThan(0);
      for (const r of engine) expect(r.rank, `${r.title} rank ${r.rank} score ${r.score}`).toBeLessThanOrEqual(r.score * 0.5 + 0.001);
    });

    it("ranks Boba Fett, Family Found (played by most lists) above Luke, Obi-Wan and Leia, which no Warrior list plays", () => {
      const rows = pairings();
      const boba = rowOf(rows, BOBA_FETT);
      expect(boba.leaderInclusion).toBeGreaterThan(0.5);
      for (const key of [LUKE_BEGINNING, OBI_WAN, LEIA]) {
        const row = rowOf(rows, key);
        expect(row.leaderInclusion).toBeNull();
        expect(row.rank, row.title).toBeLessThan(boba.rank);
      }
    });

    it("leaves weighting none unweighted: no leaderInclusion and the engine rows still listed", () => {
      const rows = pairings({ weighting: "none" });
      expect(rows.every((r) => !("leaderInclusion" in r))).toBe(true);
      expect(rows.some((r) => r.cardKey === BOBA_FETT && r.linkKind === "leader-engine")).toBe(true);
    });
  });

  describe("2. the engine reads what the leader grants and the Action a ready repeats", () => {
    it("lists Chewbacca and The Chieftain as engine partners: Ambush is an attack and each gives itself Raid", () => {
      const rows = pairings();
      for (const key of [CHEWBACCA, CHIEFTAIN]) {
        const row = rowOf(rows, key);
        expect(row.reason, row.title).toContain("Leader engine");
        expect(row.reason).toContain("Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.");
        expect(row.reason).toContain("Ambush, an attack on entry");
        expect(row.reason).toContain("gains Raid");
      }
      expect(rowOf(rows, CHEWBACCA).linkKind).toBe("leader-engine");
    });

    it("lists Darth Traya as an engine partner of the leader's Action and names that Action", () => {
      const row = rowOf(pairings(), TRAYA);
      expect(row.linkKind).toBe("leader-engine");
      expect(row.partnerIs).toBe("enabler");
      expect(row.reason).toContain("Action [1 resource, Exhaust]");
      expect(row.reason).toContain("ready a non-unit leader");
    });

    it("gives the new rows the same unplayed halving (D65) and keeps them in weighting none", () => {
      const rows = pairings();
      for (const key of [CHEWBACCA, CHIEFTAIN, TRAYA]) {
        const row = rowOf(rows, key);
        if (row.leaderInclusion === null || row.leaderInclusion < 0.02) expect(row.rank).toBeLessThanOrEqual(row.score * 0.5 + 0.001);
      }
      const none = pairings({ weighting: "none" });
      for (const key of [CHEWBACCA, CHIEFTAIN, TRAYA]) expect(rowOf(none, key).linkKind).toBe("leader-engine");
    });

    it("keeps a payoff direction free of the Traya enabler row and an enabler direction free of the Ambush payoff rows", () => {
      expect(pairings({ direction: "payoffs" }).some((r) => r.cardKey === TRAYA && r.linkKind === "leader-engine")).toBe(false);
      expect(pairings({ direction: "enablers" }).some((r) => r.cardKey === CHEWBACCA && r.linkKind === "leader-engine")).toBe(false);
    });
  });

  describe("3. budget_alternatives keeps the unit's job for every unit", () => {
    const budget = (): Record<string, any> => body(DECK_TOOLS.budget_alternatives.handler(real, { swudb: OWNER_DECK, maxPrice: 2 }));

    it("offers Neel (readies a unit) only swaps that ready a unit, or says no card does", () => {
      const out = budget();
      const slot = (out.slots as Record<string, any>[]).find((s) => s.cardKey === NEEL);
      const none = (out.noAlternative as Record<string, any>[]).find((n) => n.card.startsWith("Neel"));
      if (slot !== undefined) {
        expect(slot.job).toContain("readies a unit");
        for (const alt of slot.alternatives as Record<string, any>[]) expect(String(alt.keepsRole), alt.title).toContain("ready");
      } else {
        expect(none, "Neel is a slot or a noAlternative row").toBeDefined();
        expect(none?.reason).toContain("readies a unit");
        expect(none?.reason).toContain("no cheaper same-slot card");
      }
    });

    it("no longer offers BD-1, Teeka or Point Rain Reclaimer as Neel's swaps (none of them readies anything)", () => {
      const out = budget();
      const neel = (out.slots as Record<string, any>[]).find((s) => s.cardKey === NEEL);
      const titles = (neel?.alternatives ?? []).map((a: Record<string, any>) => a.title);
      expect(titles).not.toContain("BD-1, Beep Boo Boo Bweep");
      expect(titles).not.toContain("Teeka, You're in Luck");
      expect(titles).not.toContain("Point Rain Reclaimer");
    });

    it("keeps Darth Traya's rule: no card readies a leader", () => {
      const none = (budget().noAlternative as Record<string, any>[]).find((n) => n.card.startsWith("Darth Traya"));
      expect(none?.reason).toBe("no card readies a leader");
    });
  });

  describe("4. meta_answers ranks a partly base-locked answer after the unlocked ones", () => {
    // A row the floor hides is appended after the ranked page (hiddenByFloor), so it is not part of the rank order.
    const additions = (extra: object = {}): Record<string, any>[] =>
      (body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, limit: 40, archetypes: 6, ...extra })).additions as Record<string, any>[]).filter((r) => r.hiddenByFloor !== true);

    it("lists Sandcrawler Sales Team (a Tatooine clause under Origin Tree) after every unlocked addition", () => {
      const rows = additions();
      const at = rows.findIndex((r) => r.cardKey === SANDCRAWLER);
      expect(at, "Sandcrawler Sales Team answers through its printed Saboteur").toBeGreaterThanOrEqual(0);
      expect(rows[at].baseLocked).toBe("Tatooine");
      expect(rows.slice(0, at).every((r) => r.baseLocked === undefined && r.needsUnitAspect === undefined)).toBe(true);
      expect(rows.slice(at).every((r) => r.baseLocked !== undefined || r.needsUnitAspect !== undefined)).toBe(true);
    });

    it("keeps the demotion with the perThreat cap off, and Sandcrawler Sales Team leaves the default ten-row page", () => {
      const rows = additions({ perThreat: 60 });
      const first = rows.findIndex((r) => r.baseLocked !== undefined || r.needsUnitAspect !== undefined);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(rows.slice(first).every((r) => r.baseLocked !== undefined || r.needsUnitAspect !== undefined)).toBe(true);
      expect(additions({ limit: 10 }).map((r) => r.cardKey)).not.toContain(SANDCRAWLER);
    });
  });
});

describe("compareAnswerRank, partly locked answers (#156, D65)", () => {
  const rank = (spec: Partial<AnswerRank> & { cardKey: string }): AnswerRank => ({ penalty: 0, coverage: 0.3927, evidenceClass: "ok", cost: 5, threatCount: 1, ...spec });
  const sorted = (list: AnswerRank[]) => [...list].sort(compareAnswerRank).map((a) => a.cardKey);

  it("sorts a card with a locked clause and an open offer after the unlocked cards, whatever its coverage, but before a fully locked one", () => {
    expect(sorted([rank({ cardKey: "locked", partlyLocked: true, coverage: 0.9 }), rank({ cardKey: "open", coverage: 0.1 })])).toEqual(["open", "locked"]);
    expect(sorted([rank({ cardKey: "out", lockedOut: true }), rank({ cardKey: "locked", partlyLocked: true }), rank({ cardKey: "open" })])).toEqual(["open", "locked", "out"]);
  });
});
