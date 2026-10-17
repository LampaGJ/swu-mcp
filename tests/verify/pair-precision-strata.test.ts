import { describe, expect, it } from "vitest";
import { report } from "../../scripts/verify/pair-precision.js";

// LampaGJ/swu-mcp#24: pairs-v1 precision with and without trait rows.
const item = (id: string, label: "correct" | "wrong", row: string) => ({ id, offer: "a", want: "b", row, label, reason: "r" });
const items = [
  item("1", "correct", "r1"),
  item("2", "wrong", "r1"),
  item("3", "correct", "trait-reference:Rebel"),
  item("4", "correct", "trait-reference:Jedi"),
  item("5", "wrong", "trait-reference:Jedi"),
];
const fixture = { version: 1 as const, seed: "s", sourceRun: { date: "d", buildHash: "h" }, inputsSha256: "0".repeat(64), items };

describe("pair precision strata", () => {
  it("reports precision overall, on mechanical rows only and on trait rows only", () => {
    const r = report(fixture, new Set(["1", "2", "3", "4", "5"])) as Record<string, any>;
    expect(r.overall.precision).toMatchObject({ n: 3, of: 5 });
    expect(r.mechanical.precision).toMatchObject({ n: 1, of: 2 });
    expect(r.traitOnly.precision).toMatchObject({ n: 2, of: 3 });
  });
});
