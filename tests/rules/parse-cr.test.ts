import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseComprehensiveRules, referencesIn } from "../../src/rules/parse-cr.js";
import { SLICE } from "./helpers.js";

const parsed = parseComprehensiveRules(SLICE);
const find = (id: string) => parsed.sections.find((section) => section.id === id);

describe("parseComprehensiveRules on a slice of the real text", () => {
  it("reads the cover version and date", () => {
    expect(parsed.version).toBe("8.0");
    expect(parsed.coverDate).toBe("7/8/26");
  });

  it("rebuilds hierarchical ids with the right nesting", () => {
    expect(find("1")).toMatchObject({ depth: 0, parentId: null, title: "GAME CONCEPTS" });
    expect(find("1.5")).toMatchObject({ depth: 1, parentId: "1", title: "CARDS" });
    expect(find("1.5.2")).toMatchObject({ depth: 2, parentId: "1.5", title: "Ownership and Control" });
    expect(find("1.5.2.b")).toMatchObject({ depth: 3, parentId: "1.5.2" });
    expect(find("1.5.2.b")?.text).toContain("A player is the “controller” of a card");
    expect(find("2")).toMatchObject({ depth: 0, title: "CARD ANATOMY" });
  });

  it("joins wrapped lines into one paragraph and keeps the section's own page", () => {
    expect(find("1.3.1")?.text).toMatch(/^Card and Rulebook Precedence: If the text of this Comprehensive Rules document directly contradicts/);
    expect(find("1.3.1")?.text).not.toContain("\n");
    expect(find("1.5.2.b")?.page).toBe(5);
  });

  it("keeps cross-references as resolved links", () => {
    expect(find("1.5.1.b")?.refs).toEqual(["1.7"]);
    expect(find("2.6.1")?.refs).toEqual(["1.8"]);
  });

  it("marks icon glyphs instead of leaving private-use characters", () => {
    expect(parsed.iconGlyphs).toBeGreaterThan(0);
    expect(parsed.sections.every((section) => !/[-]/.test(section.text))).toBe(true);
    expect(find("1.7.2")?.text).toContain("[icon]");
  });

  it("reports only references that point outside the slice", () => {
    expect(parsed.anomalies.every((line) => line.startsWith("unresolved reference "))).toBe(true);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(parseComprehensiveRules(SLICE))).toBe(JSON.stringify(parsed));
  });
});

describe("referencesIn", () => {
  it("handles See with trailing title, letter suffix and Sections lists", () => {
    expect(referencesIn("See 8.1. Aspect Penalties")).toEqual(["8.1"]);
    expect(referencesIn("See 7.6.3A for more")).toEqual(["7.6.3.a"]);
    expect(referencesIn("outside of Sections 11 and 12 assume")).toEqual(["11", "12"]);
    expect(referencesIn("the 3.4 rules without a see")).toEqual([]);
  });
});

const REAL_TEXT = process.env.SWU_CR_TEXT ?? "/Volumes/Local Files/Projects/swu-mcp/tmp/rules/cr-v8.txt";
describe.skipIf(!existsSync(REAL_TEXT))("parseComprehensiveRules on the full v8.0 text", () => {
  const full = parseComprehensiveRules(readFileSync(REAL_TEXT, "utf8"));
  it("matches the contents page: 12 sections and 122 subsections, no anomalies", () => {
    expect(full.sections.filter((s) => s.depth === 0)).toHaveLength(12);
    expect(full.sections.filter((s) => s.depth === 1)).toHaveLength(122);
    expect(full.sections.filter((s) => s.parentId === "8" && s.depth === 1)).toHaveLength(38);
    expect(full.anomalies).toEqual([]);
  });
  it("finds keyword headings and the Sentinel rule", () => {
    expect(full.sections.find((s) => s.id === "7.5.11")?.title).toBe("Sentinel");
    expect(full.sections.find((s) => s.id === "6.2.0")?.title).toBe("General");
  });
});
