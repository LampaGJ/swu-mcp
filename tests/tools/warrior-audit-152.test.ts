import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS } from "../../src/tools/meta.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK: unknown = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8"));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/archetypes.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

// The owner's deck: leader The Warrior, Deft Duelist (09010018), base Origin Tree (09010024), judged in session eight (#152).
describe.skipIf(!hasData)("the owner's Warrior / Origin Tree deck against the built data (#152)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);

  describe("deck_audit cluster gaps count printed keywords", () => {
    const gaps = (): { clusterId: number; label: string; deckCards: number }[] =>
      body(DECK_TOOLS.deck_audit.handler(real, { swudb: OWNER_DECK, gapLimit: 32 })).clusterGaps.clusters;

    it("no longer reports Raid units as 3 held: the core's 16 copies of printed-Raid units close that gap", () => {
      const raid = gaps().find((r) => r.label === "Raid units");
      expect(raid === undefined || raid.deckCards >= 16, JSON.stringify(raid)).toBe(true);
    });

    it("counts the core's printed Ambush and Saboteur units in their clusters, not 1 and 0", () => {
      for (const label of ["Ambush and Support units", "Saboteur units"]) {
        const row = gaps().find((r) => r.label === label);
        expect(row === undefined || row.deckCards >= 4, JSON.stringify(row)).toBe(true);
      }
    });

  });

  describe("deck_audit orphan wants", () => {
    const orphans = (): { card: string; wants: string; feeders: string }[] => body(DECK_TOOLS.deck_audit.handler(real, { swudb: OWNER_DECK })).orphanWants;

    it("does not flag Lifetree Caravan (control 3 or more units) in a core of 31 units", () => {
      expect(orphans().map((o) => o.card)).not.toContain("Lifetree Caravan");
    });

    it("does not flag a wide-board want the unit count already meets", () => {
      expect(orphans().filter((o) => o.wants.includes("wants:wide-board"))).toEqual([]);
    });
  });

  describe("meta_answers credits a threshold only against threats that meet it", () => {
    const answers = (): Record<string, any>[] => {
      const out = body(META_TOOLS.meta_answers.handler(real, { leader: "09010018", base: "09010024", decklist: [{ card: "09010238", count: 1 }], archetypes: 6, limit: 5 }));
      return [...out.staples, ...out.additions];
    };

    it("does not list Ant Droid (1 power) among the units Exploit Confidence returns", () => {
      const exploit = answers().find((a) => a.cardKey === "09010238");
      expect(exploit, "Exploit Confidence is an answer").toBeDefined();
      const removed = exploit?.answers.map((g: Record<string, any>) => String(g.keyUnitsRemoved)).join(" | ");
      expect(removed).not.toContain("Ant Droid");
    });

    it("shows the 6-power floor on the answer", () => {
      const exploit = answers().find((a) => a.cardKey === "09010238");
      expect(exploit?.answers[0].threshold).toBe("power 6 or more");
    });
  });

  describe("meta_threats community fallback", () => {
    const out = (): Record<string, any> => body(META_TOOLS.meta_threats.handler(real, { archetype: "09010018", coreLimit: 8 }));

    it("reports one consistent source: fallback true in sources and in leaderSource", () => {
      const o = out();
      expect(o.leaderSource.fallback).toBe(true);
      expect(o.sources.fallback).toBe(true);
      expect(o.sources.population).toBe("community");
    });

    it("does not claim a tournament record when tournamentRecord is null", () => {
      const o = out();
      expect(o.archetype.tournamentRecord).toBeNull();
      expect(o.note).not.toContain("the record against the field is still tournament data");
      expect(o.note).toContain("tournamentRecord is null");
    });
  });
});
