import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../src/paths.js";
import { effectProfileOf, loadTables, MECHANICAL_PRIOR, normalizeCardName, shrunkRowPrecision } from "../../../src/sims/policies/tables.js";

const RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");

describe("policy tables", () => {
  it("reads removal and healing from parsed effect vectors", () => {
    expect(effectProfileOf({ "text:defeat": { byTarget: { any_unit: 1 } } })).toEqual({ removal: true, heal: false });
    expect(effectProfileOf({ "text:damage": { byTarget: { friendly_base: 1 } }, "text:heal": { byTarget: { any_unit: 1 } } })).toEqual({ removal: false, heal: true });
  });

  it("shrinks a row's fixture precision toward the mechanical prior with 10 pseudo-items", () => {
    expect(shrunkRowPrecision(0, 0)).toBeCloseTo(MECHANICAL_PRIOR, 10);
    expect(shrunkRowPrecision(0, 3)).toBeCloseTo((10 * MECHANICAL_PRIOR) / 13, 10);
    expect(shrunkRowPrecision(9, 11)).toBeCloseTo((9 + 7.267) / 21, 10);
  });

  it("folds accents and curly quotes in card names", () => {
    expect(normalizeCardName("Sabine’s Lightsaber", "Not Alone")).toBe("sabine's lightsaber, not alone");
  });

  it.skipIf(!existsSync(path.join(RUN, "scores/scores.json")))("loads the pinned run: names, null scores at the type median, leader inclusion, pinned pair edges", () => {
    const t = loadTables({ runDir: RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: true });
    expect(t.keyOf("The Chieftain", "Here Since the Oceans Dried")).toBe("09010212");
    expect(t.score("09010212")).toBeCloseTo(1.0536, 4);
    expect(t.score("09010018")).toBe(0);
    expect(t.leaderInclusion("09010018", "09010212")).toBeGreaterThanOrEqual(0);
    expect(t.pins.pairsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(t.edgeWeight("0101033", "0101165")).toBeGreaterThan(0);
  });
});
