import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../../scripts/bench/card-map.js";
import { REPO_ROOT } from "../../src/paths.js";
import { deckPanel, loadOpponentPool, mapCardKeyOf, poolReport, sampleStratified, stratifiedPlan } from "../../src/sims/opponents.js";

const RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");
const ARCHETYPES = path.join(RUN, "meta/archetypes.json");
const DECKS = path.join(REPO_ROOT, "data/originals/decks/2026-10-17");
const ORIGINALS = path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16");
const present = [ARCHETYPES, DECKS, path.join(RUN, "replay.json"), path.join(ORIGINALS, "swu-cards/raw-pages")].every((p) => existsSync(p));

// Smoke test on the pinned 2026-10-31 run; it skips where the run or the mault originals are not on disk.
describe.skipIf(!present)("opponent sampler on the 2026-10-31 run", () => {
  const pool = present
    ? loadOpponentPool({ archetypesFile: ARCHETYPES, decksDir: DECKS, cardKeyOf: mapCardKeyOf(loadCardMap(RUN, ORIGINALS).setNumber.byId) })
    : (undefined as never);

  it("assigns the melee lists of the window to the top archetypes in about the numbers the meta step counted", () => {
    expect(pool.lists.length + pool.unassigned.length).toBe(pool.counts.melee - pool.counts.outOfWindow);
    for (const a of pool.archetypes.slice(0, 6)) {
      const n = pool.byArchetype.get(a.id)?.length ?? 0;
      expect(Math.abs(n - a.decks) / a.decks).toBeLessThan(0.2);
    }
    expect(pool.counts.nonMelee).toBeGreaterThan(0);
  });

  it("picks a placement-1 or better-weighted list for each of the top six archetypes", () => {
    const panel = deckPanel(pool);
    expect(panel).toHaveLength(6);
    for (const p of panel) {
      expect(p.list).not.toBeNull();
      expect(p.list?.archetypeId).toBe(p.archetypeId);
      expect(p.list?.weight).toBeGreaterThan(1.9);
    }
  });

  it("draws the same six-plus-rest stratified sample twice", () => {
    const plan = stratifiedPlan(pool, { top: 6, perStratum: 20, restOfField: 20 });
    expect(plan).toHaveLength(7);
    const draw = () => sampleStratified(pool, plan, { seed: "smoke" }).draws.map((d) => d.source);
    expect(draw()).toEqual(draw());
    expect(draw()).toHaveLength(140);
  });

  it("reports every list it leaves out", () => {
    const report = poolReport(pool);
    expect(report.lists).toBe(pool.lists.length);
    expect(report.unassigned.count).toBe(pool.unassigned.length);
    expect(report.population).toContain("melee tournament decklists, 2026-07-20 to 2026-10-17");
  });
}, 60000);
