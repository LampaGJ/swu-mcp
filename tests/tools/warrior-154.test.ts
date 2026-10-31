import { decode } from "@toon-format/toon";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { META_TOOLS } from "../../src/tools/meta.js";
import { SYNERGY_TOOLS } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/archetypes.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const RITUAL_DRAGON = "09010234";
const BOBA_FETT = "09010225";
const OPPO = "05010105";

// The owner's deck: leader The Warrior, Deft Duelist, base Origin Tree (tests/fixtures/decks/warrior-chewie-raid.swudb.json), judged in session eight (#154).
describe.skipIf(!hasData)("The Warrior / Origin Tree against the built data (#154, D63)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const LOCK_FIELDS = ["baseLocked", "nameLocked", "needsForce", "needsTrait"];
  const pairings = (extra: object = {}): Record<string, any> =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, limit: 100, perLink: 100, ...extra }));

  describe.each([
    ["leader-weighted", {}],
    ["weighting none", { weighting: "none" }],
  ])("find_pairings, %s", (_, extra) => {
    it("lists Ritual Dragon (Tatooine clause) after every unlocked partner, with its curated clause text", () => {
      const rows: Record<string, any>[] = pairings(extra).pairings;
      const at = rows.findIndex((r) => r.cardKey === RITUAL_DRAGON);
      expect(at, "Ritual Dragon is a partner").toBeGreaterThanOrEqual(0);
      expect(rows[at].baseLocked).toBe("Tatooine");
      // D68: Force- and trait-locked partners share the locked tail, so it is every lock, not only the base lock, that follows.
      expect(rows.slice(at).every((r) => LOCK_FIELDS.some((k) => r[k] !== undefined))).toBe(true);
      expect(rows.slice(0, at).every((r) => r.baseLocked === undefined)).toBe(true);
      expect(JSON.stringify(rows[at].evidence)).not.toMatch(/curated cur-\d/);
      expect(rows[at].evidence[0].offer).toContain("text:");
    });

    it("keeps a locked partner behind the unlocked ones under the default perLink cap", () => {
      const rows: Record<string, any>[] = pairings({ ...extra, perLink: 3, limit: 100 }).pairings;
      const firstLocked = rows.findIndex((r) => LOCK_FIELDS.some((k) => r[k] !== undefined));
      expect(firstLocked).toBeGreaterThanOrEqual(0);
      expect(rows.slice(firstLocked).every((r) => LOCK_FIELDS.some((k) => r[k] !== undefined))).toBe(true);
    });

    it("lists the leader-engine rows Boba Fett, Family Found and Oppo Rancisis", () => {
      const rows: Record<string, any>[] = pairings(extra).pairings;
      const engine = rows.filter((r) => r.linkKind === "leader-engine").map((r) => r.cardKey);
      expect(engine).toEqual(expect.arrayContaining([BOBA_FETT, OPPO]));
    });
  });

  it("find_pairings: weighting none lists exactly the leader-engine rows the weighted call lists", () => {
    const keys = (o: Record<string, any>): string[] => o.pairings.filter((r: any) => r.linkKind === "leader-engine").map((r: any) => r.cardKey).sort();
    expect(keys(pairings({ weighting: "none" }))).toEqual(keys(pairings()));
  });

  it("find_trios: every trio with a base-locked member follows every unlocked trio", () => {
    const trios: Record<string, any>[] = body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, limit: 40, evidence: false, withAlternatives: false })).trios;
    const firstLocked = trios.findIndex((t) => t.baseLocked !== undefined);
    if (firstLocked >= 0) expect(trios.slice(firstLocked).every((t) => t.baseLocked !== undefined)).toBe(true);
    const out = body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, limit: 40, minPlayed: 0, weighting: "none", evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    const locked = out.findIndex((t) => t.baseLocked !== undefined);
    if (locked >= 0) expect(out.slice(locked).every((t) => t.baseLocked !== undefined)).toBe(true);
  });

  describe("meta_threats faces", () => {
    const faces = (extra: object = {}): Record<string, any> =>
      body(META_TOOLS.meta_threats.handler(real, { archetype: WARRIOR, coreLimit: 8, ...extra })).faces;

    it("lists the six largest tournament archetypes with source, population and minN", () => {
      const f = faces();
      expect(f.population).toBe("tournament");
      expect(f.source).toContain("swumetastats");
      expect(f.minN).toBe(10);
      expect(f.rows).toHaveLength(6);
      const shares: number[] = f.rows.map((r: any) => r.share);
      expect(shares).toEqual([...shares].sort((a, b) => b - a));
    });

    it("states no measured matchup where fewer than minN decisive matches exist, and measures only rows that meet it", () => {
      const f = faces({ facesLimit: 20 });
      const unmeasured = f.rows.filter((r: any) => r.winRate === null);
      expect(unmeasured.length, "The Warrior has few measured matchups").toBeGreaterThan(0);
      for (const r of unmeasured) expect(r.record).toBe("no measured matchup (n < 10)");
      for (const r of f.rows.filter((x: any) => x.winRate !== null)) {
        expect(r.n).toBeGreaterThanOrEqual(10);
        expect(r.wins + r.losses).toBe(r.n);
        expect(r.ci95).toMatch(/^\d/);
      }
    });

    it("leaves the block out at facesLimit 0", () => {
      expect(body(META_TOOLS.meta_threats.handler(real, { archetype: WARRIOR, facesLimit: 0 }))).not.toHaveProperty("faces");
    });
  });
});
