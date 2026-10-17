import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FormatRejects, premierVerdict, snapshotDeclaresPremier } from "../../src/meta/format.js";

const deck = (format: unknown) => ({
  metadata: { source: "melee", createdAt: "2026-10-06T16:00:00.000Z", ...(format === undefined ? {} : { format }) },
  leader: { id: "ASH_005", count: 1 },
  base: { id: "ASH_021", count: 1 },
  deck: [{ id: "ASH_056", count: 3 }],
});

const tmpRoot = path.resolve("tmp");

describe("Premier format gate (owner ruling 2026-10-17: no Eternal decks)", () => {
  it("rejects a synthetic Eternal deck with reason format:<value>", () => {
    expect(premierVerdict(deck("eternal"), false)).toEqual({ keep: false, reason: "format:eternal" });
    expect(premierVerdict(deck("Eternal"), true)).toEqual({ keep: false, reason: "format:Eternal" });
  });

  it("keeps Premier in any case", () => {
    expect(premierVerdict(deck("premier"), false)).toEqual({ keep: true });
    expect(premierVerdict(deck("PREMIER"), false)).toEqual({ keep: true });
  });

  it("rejects a deck with no format unless the snapshot manifest declares Premier", () => {
    expect(premierVerdict(deck(undefined), false)).toEqual({ keep: false, reason: "format:missing" });
    expect(premierVerdict(deck(undefined), true)).toEqual({ keep: true });
  });

  it("reads the snapshot-wide declaration from manifest.json only when it says Premier", () => {
    mkdirSync(tmpRoot, { recursive: true });
    const declared = mkdtempSync(path.join(tmpRoot, "fmt-"));
    writeFileSync(path.join(declared, "manifest.json"), JSON.stringify({ format: "Premier" }));
    const silent = mkdtempSync(path.join(tmpRoot, "fmt-"));
    writeFileSync(path.join(silent, "manifest.json"), JSON.stringify({ snapshot: "x" }));
    const none = mkdtempSync(path.join(tmpRoot, "fmt-"));
    expect(snapshotDeclaresPremier(declared)).toBe(true);
    expect(snapshotDeclaresPremier(silent)).toBe(false);
    expect(snapshotDeclaresPremier(none)).toBe(false);
  });

  it("tallies rejections by reason in code-point order", () => {
    const tally = new FormatRejects();
    for (const d of [deck("eternal"), deck("premier"), deck(undefined), deck("eternal"), deck("Twin Suns")]) {
      const v = premierVerdict(d, false);
      if (!v.keep) tally.add(v.reason);
    }
    expect(tally.total).toBe(4);
    expect(JSON.stringify(tally)).toBe('{"format:Twin Suns":1,"format:eternal":2,"format:missing":1}');
  });
});
