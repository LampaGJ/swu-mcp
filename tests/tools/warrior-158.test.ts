import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { makesForce } from "../../src/synergy/clause-lock.js";
import { loadSynergyContext } from "../../src/synergy/context.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as { deck: { id: string; count: number }[] };
const DECKLIST = OWNER_DECK.deck.map((l) => ({ card: l.id, count: l.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const JEDI_CONSULAR = "05010094";
const NEEL = "08010248";
const INSURGENT_CAMP = "09010216";
const LUKE_BEGINNING = "05010249";
const COUNCILOR = "06010249";
const LOCKS = ["baseLocked", "nameLocked", "needsForce", "needsTrait"];
const locked = (r: Record<string, any>): boolean => LOCKS.some((k) => r[k] !== undefined);
const members = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");

// The owner's deck (leader The Warrior, Deft Duelist, base Origin Tree), judged in session eight, sixth judge (#158, D68).
describe.skipIf(!hasData)("The Warrior / Origin Tree against the built data (#158, D68)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const trios = (extra: object = {}): Record<string, any>[] => body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, ...extra })).trios;
  const pairings = (extra: object = {}): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, limit: 100, withAlternatives: false, ...extra })).pairings;

  it("Jedi Consular + Neel + Insurgent Camp no longer tops find_trios, with or without the decklist (judge line 2700)", () => {
    for (const extra of [{}, { decklist: DECKLIST }]) {
      const top = trios({ limit: 5, ...extra })[0];
      expect([...members(top)].sort()).not.toEqual([JEDI_CONSULAR, NEEL, INSURGENT_CAMP].sort());
      expect(locked(top)).toBe(false);
    }
  });

  it("a trio holding Jedi Consular carries needsForce unless a member makes the Force, and the locked trios follow the unlocked ones", () => {
    const ctx = loadSynergyContext(builtRun as string);
    const rows = trios({ cardKey: JEDI_CONSULAR, limit: 50, withAlternatives: false, evidence: false, minPlayed: 0 });
    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      const maker = members(t).some((k) => makesForce(ctx.graph.byKey.get(k) as SynergyCard));
      if (maker) expect(t, t.cards).not.toHaveProperty("needsForce");
      else expect(String(t.needsForce), t.cards).toContain("use the Force");
    }
    const first = rows.findIndex(locked);
    if (first >= 0) expect(rows.slice(first).every(locked)).toBe(true);
  });

  it("Jedi Consular's evidence quotes its 'use the Force' cost on whichever side of the link it stands (judge line 2719)", () => {
    const rows = trios({ cardKey: JEDI_CONSULAR, limit: 5, withAlternatives: false, minPlayed: 0 });
    const quoted = rows.flatMap((t) =>
      (t.evidence as Record<string, string>[]).flatMap((e) => (e.link.startsWith("Jedi Consular >") ? [e.offer] : e.link.endsWith("> Jedi Consular") ? [e.want] : [])),
    );
    expect(quoted.length).toBeGreaterThan(0);
    for (const text of quoted) expect(text).toContain("use the Force");
  });

  for (const weighting of ["leader", "none"] as const) {
    it(`find_pairings (weighting ${weighting}) with the decklist flags Luke (needsForce) and High Command Councilor (needsTrait) and ranks them after every unlocked row (judge lines 2538, 2637)`, () => {
      const rows = pairings({ weighting, decklist: DECKLIST });
      const luke = rows.findIndex((r) => r.cardKey === LUKE_BEGINNING);
      const councilor = rows.findIndex((r) => r.cardKey === COUNCILOR);
      expect(rows[luke].needsForce).toBe("use the Force");
      expect(rows[councilor].needsTrait).toBe("Official");
      const first = rows.findIndex(locked);
      expect(first).toBeLessThanOrEqual(Math.min(luke, councilor));
      expect(rows.slice(first).every(locked)).toBe(true);
    });
  }

  it("find_pairings without the decklist reads the leader's played lists: no Warrior list makes the Force, so Luke stays locked", () => {
    const rows = pairings({ weighting: "none" });
    const luke = rows.find((r) => r.cardKey === LUKE_BEGINNING);
    expect(luke?.needsForce).toBe("use the Force");
  });
});
