import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSynergyRun } from "../../src/synergy/run.js";
import { replaySchema } from "../../src/synergy/schema.js";
import { sha256Hex } from "../../src/swu/canonical.js";
import { mk } from "./fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLE_TEXT = readFileSync(path.resolve(here, "../../data/complementarity.json"), "utf8");

const cards = [
  mk("A1", "Always Two", { offers: ["offers:defeat-friendly-unit"], aspects: ["Command"], icons: ["Command"] }),
  mk("A2", "Desperate Commando", {
    offers: ["offers:has-when-defeated"],
    wants: ["wants:self-defeated"],
    aspects: ["Aggression"],
    icons: ["Aggression"],
  }),
  mk("A3", "Grand Admiral Thrawn", { type: "Leader", wants: ["wants:when-defeated-cards"], icons: ["Cunning", "Villainy"] }),
  mk("B1", "Death Trooper", { offers: ["offers:damage-friendly-unit"], aspects: ["Vigilance"], icons: ["Vigilance"] }),
  mk("B2", "The Elite Squad", { wants: ["wants:damage-friendly"], aspects: ["Aggression"], icons: ["Aggression"] }),
  mk("BASE", "A Base", { type: "Base", icons: ["Command"] }),
];
const features = JSON.stringify(cards);

describe("buildSynergyRun", () => {
  const run = buildSynergyRun(features, TABLE_TEXT, "test-commit");

  it("writes pairs, trios, fungibility classes, a report and a replay record", () => {
    expect(Object.keys(run.files).sort()).toEqual(["fungibility.json", "pairs.toon", "replay.json", "report.json", "trios.toon"]);
    expect(run.report.pairs).toBeGreaterThanOrEqual(3);
    expect((run.report.exampleChecks as { matches: boolean }[]).filter((c) => c.matches)).toHaveLength(3);
  });

  it("records input hashes, the table version and an output hash per file", () => {
    const replay = replaySchema.parse(JSON.parse(run.files["replay.json"]));
    expect(replay.inputHash["features.json"]).toBe(sha256Hex(features));
    expect(replay.inputHash["complementarity.json"]).toBe(sha256Hex(TABLE_TEXT));
    expect(replay.complementarityTableVersion).toBe(4);
    expect(replay.codeCommit).toBe("test-commit");
    for (const name of ["fungibility.json", "pairs.toon", "report.json", "trios.toon"]) {
      expect(replay.outputHash[name]).toBe(sha256Hex(run.files[name]));
    }
  });

  it("replays to identical bytes", () => {
    const again = buildSynergyRun(features, TABLE_TEXT, "test-commit");
    expect(again.files).toEqual(run.files);
  });

  it("changes the output hash when the input changes", () => {
    const changed = buildSynergyRun(JSON.stringify(cards.slice(0, 3)), TABLE_TEXT, "test-commit");
    expect(changed.replay.outputHash["pairs.toon"]).not.toBe(run.replay.outputHash["pairs.toon"]);
  });

  it("rejects a feature file that fails the consumer gate", () => {
    expect(() => buildSynergyRun(JSON.stringify([{ cardKey: "x" }]), TABLE_TEXT, "c")).toThrow();
  });

  it("rejects a table with an unknown schema version", () => {
    const bad = JSON.stringify({ ...JSON.parse(TABLE_TEXT), schemaVersion: 2 });
    expect(() => buildSynergyRun(features, bad, "c")).toThrow();
  });
});
