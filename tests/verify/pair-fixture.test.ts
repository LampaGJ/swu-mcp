import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allocate, pairUnits, parseUnitId, selectFixtureUnits, unitId } from "../../scripts/verify/pair-fixture.js";
import { pinFixture } from "../../scripts/verify/pair-fixture-pin.js";
import { measure, report, wilson } from "../../scripts/verify/pair-precision.js";
import { serialize } from "../../scripts/verify/sample.js";

const ROW_SIZES: Record<string, number> = { big: 600, mid: 300, small: 40, tiny: 4, two: 2 };

function syntheticPairs(): Record<string, unknown>[] {
  const pairs: Record<string, unknown>[] = [];
  for (const [row, size] of Object.entries(ROW_SIZES)) {
    for (let i = 0; i < size; i += 1) pairs.push({ cardA: `${row}-a${i}`, cardB: `${row}-b${i}`, rows: row });
  }
  pairs.push({ cardA: "x", cardB: "y", rows: "big:t|mid" });
  return pairs;
}

describe("pair units", () => {
  it("expands a multi-row pair into one unit per row and round-trips ids", () => {
    const units = pairUnits([{ cardA: "x", cardB: "y", rows: "big:t|mid" }]);
    expect(units.map((u) => u.id)).toEqual(["x>y:big", "x>y:mid"]);
    expect(parseUnitId(unitId("0101033", "04010001", "ready-reuse"))).toEqual({ offer: "0101033", want: "04010001", row: "ready-reuse" });
  });
});

describe("selectFixtureUnits", () => {
  const units = pairUnits(syntheticPairs());

  it("is deterministic for a seed and differs across seeds", () => {
    const ids = (seed: string): string[] => selectFixtureUnits(units, seed, 100, 3).map((u) => u.id);
    expect(ids("s")).toEqual(ids("s"));
    expect(ids("s")).not.toEqual(ids("t"));
  });

  it("returns the requested total with the floor honoured and tiny rows capped", () => {
    const chosen = selectFixtureUnits(units, "s", 100, 3);
    expect(chosen).toHaveLength(100);
    const per = new Map<string, number>();
    for (const u of chosen) per.set(u.row, (per.get(u.row) ?? 0) + 1);
    expect(per.get("tiny")).toBeGreaterThanOrEqual(3);
    expect(per.get("small")).toBeGreaterThanOrEqual(3);
    expect(per.get("two") ?? 0).toBeLessThanOrEqual(2);
    expect(per.get("big")).toBeGreaterThan(per.get("mid") as number);
  });

  it("allocates the floor even when proportional share is below it", () => {
    const a = allocate(new Map([["a", 10000], ["b", 3], ["c", 2]]), 20, 3);
    expect(a.get("b")).toBe(3);
    expect(a.get("c")).toBeLessThanOrEqual(2);
    expect([...a.values()].reduce((x, y) => x + y, 0)).toBe(20);
  });
});

describe("pinFixture", () => {
  function setup(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "pair-fixture-"));
    mkdirSync(path.join(dir, "verdicts"));
    mkdirSync(path.join(dir, "adjudication"));
    writeFileSync(path.join(dir, "index.json"), serialize({ seed: "pair-fixture-v1", sourceRun: { date: "2026-10-17", buildHash: "abc" } }));
    writeFileSync(
      path.join(dir, "verdicts/p1.json"),
      serialize({ packet: "p1", items: [{ id: "b>c:r1", verdict: "correct", reason: "ok" }, { id: "a>d:r2", verdict: "wrong", reason: "no" }, { id: "a>d:r2", verdict: "unsure", reason: "hm" }] }),
    );
    writeFileSync(path.join(dir, "verdicts/p2.json"), serialize({ packet: "p2", items: [{ id: "e>f:r1", verdict: "unsure", reason: "?" }] }));
    writeFileSync(path.join(dir, "adjudication/p2.json"), serialize({ items: [{ id: "e>f:r1", final: "correct", reason: "settled" }] }));
    return dir;
  }

  it("sorts by id, applies adjudication and is byte-identical on rerun", () => {
    const dir = setup();
    const first = serialize(pinFixture(dir));
    expect(serialize(pinFixture(dir))).toBe(first);
    const fixture = JSON.parse(first) as { items: { id: string; label: string; row: string }[]; inputsSha256: string };
    expect(fixture.items.map((i) => i.id)).toEqual(["a>d:r2", "b>c:r1", "e>f:r1"]);
    expect(fixture.items.map((i) => i.label)).toEqual(["wrong", "correct", "correct"]);
    expect(fixture.inputsSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the input hash when a verdict file changes and rejects bad verdicts", () => {
    const dir = setup();
    const before = pinFixture(dir).inputsSha256;
    writeFileSync(path.join(dir, "adjudication/p2.json"), serialize({ items: [{ id: "e>f:r1", final: "wrong", reason: "flipped" }] }));
    expect(pinFixture(dir).inputsSha256).not.toBe(before);
    writeFileSync(path.join(dir, "verdicts/p2.json"), serialize({ items: [{ id: "e>f:r1", verdict: "maybe", reason: "" }] }));
    expect(() => pinFixture(dir)).toThrow();
    expect(readFileSync(path.join(dir, "index.json"), "utf8")).toContain("pair-fixture-v1");
  });
});

describe("pair precision maths", () => {
  const item = (id: string, label: "correct" | "wrong" | "unsure", row = "r1") => ({ id, offer: "o", want: "w", row, label, reason: "" });
  const items = [item("1", "correct"), item("2", "correct"), item("3", "correct"), item("4", "wrong"), item("5", "wrong"), item("6", "unsure"), item("7", "correct", "r2")];

  it("computes precision, recall and wrong-still-emitted over the still-emitted subset", () => {
    const m = measure(items, new Set(["1", "2", "4", "6", "7"]));
    expect(m.stillEmitted).toBe(5);
    expect(m.precision).toMatchObject({ n: 3, of: 4, value: 0.75 });
    expect(m.recallOfCorrect).toMatchObject({ n: 3, of: 4, value: 0.75 });
    expect(m.wrongStillEmitted).toMatchObject({ n: 1, of: 2, value: 0.5 });
  });

  it("matches the Wilson interval for 8 of 10 and handles empty denominators", () => {
    const w = wilson(8, 10);
    expect(w.low).toBeCloseTo(0.4902, 3);
    expect(w.high).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0)).toMatchObject({ value: null, low: null, high: null });
  });

  it("breaks the report down per row", () => {
    const r = report({ version: 1, seed: "s", sourceRun: { date: "d", buildHash: "h" }, inputsSha256: "0".repeat(64), items }, new Set(["1", "7"])) as { perRow: Record<string, { precision: { value: number } }> };
    expect(Object.keys(r.perRow)).toEqual(["r1", "r2"]);
    expect(r.perRow.r2?.precision.value).toBe(1);
  });
});
