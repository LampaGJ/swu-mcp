import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildKeywordRules } from "../../src/rules/keywords.js";
import { parseComprehensiveRules } from "../../src/rules/parse-cr.js";
import { assertCoreIdsExist, buildCorePrimer } from "../../src/rules/primer.js";
import { rulesCoreFileSchema } from "../../src/rules/schemas.js";
import { REPO_ROOT, SLICE, countByLength, fixtureRun } from "./helpers.js";

const parsed = parseComprehensiveRules(SLICE);
const core = (ids: string[]) => ({ schemaVersion: 1 as const, entries: ids.map((id) => ({ id, topic: `topic ${id}`, why: "why" })) });

describe("buildKeywordRules", () => {
  const file = buildKeywordRules(1, [{ value: "Deck", definition: "d" }, { value: "Comprehensive", definition: null }, { value: "Ready", definition: null }, { value: "Zzz", definition: null }], parsed.sections);
  it("maps a keyword to the section whose heading it is", () => {
    expect(file.keywords.find((k) => k.keyword === "Deck")?.sections).toEqual(["1.2"]);
  });
  it("lists whole-word mentions outside the defining tree, in document order", () => {
    const word = file.keywords.find((k) => k.keyword === "Comprehensive");
    expect(word?.mentionedIn.slice(0, 2)).toEqual(["1.1.1", "1.3.1"]);
    const deck = file.keywords.find((k) => k.keyword === "Deck");
    expect(deck?.mentionedIn.some((id) => id.startsWith("1.2."))).toBe(false);
  });
  it("keeps keywords the CR does not define with empty sections", () => {
    expect(file.keywords.find((k) => k.keyword === "Zzz")).toMatchObject({ sections: [], mentionedIn: [] });
  });
  it("sorts keywords by code point", () => {
    expect(file.keywords.map((k) => k.keyword)).toEqual(["Comprehensive", "Deck", "Ready", "Zzz"]);
  });
});

describe("core primer", () => {
  it("fails when a core id is not in the sections", () => {
    expect(() => assertCoreIdsExist(core(["1.3", "99.9"]), parsed.sections)).toThrow(/99\.9/);
  });

  it("is byte-deterministic", () => {
    const list = core(["1.3", "1.5.2", "1.7.1"]);
    const a = fixtureRun(list);
    const b = fixtureRun(list);
    expect(a.files["core-primer.md"]).toBe(b.files["core-primer.md"]);
    expect(a.hashes).toEqual(b.hashes);
  });

  it("prefixes each line with its id and quotes the rule text verbatim", () => {
    const primer = buildCorePrimer(parsed.sections, core(["1.3"]), { maxTokens: 100000, version: "8.0", countTokens: countByLength });
    expect(primer.markdown).toContain("[1.3.2] Do as Much as You Can: While resolving a card ability");
    expect(primer.fullIds).toEqual(["1.3"]);
  });

  it("cuts the last entries back to child links when over budget, keeping the first entries whole", () => {
    const list = core(["1.3", "1.5.2"]);
    const whole = buildCorePrimer(parsed.sections, list, { maxTokens: 100000, version: "8.0", countTokens: countByLength });
    const tight = buildCorePrimer(parsed.sections, list, { maxTokens: whole.tokens - 40, version: "8.0", countTokens: countByLength });
    expect(tight.fullIds).toEqual(["1.3"]);
    expect(tight.outlineIds).toEqual(["1.5.2"]);
    expect(tight.markdown).toContain("see [1.5.2.a] A player is the “owner”");
    expect(tight.tokens).toBeLessThanOrEqual(whole.tokens - 40);
  });
});

describe("data/rules-core.json", () => {
  const list = rulesCoreFileSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, "data/rules-core.json"), "utf8")));
  it("has unique ids, each with a topic and a one-line reason", () => {
    expect(new Set(list.entries.map((e) => e.id)).size).toBe(list.entries.length);
    expect(list.entries.every((e) => !e.why.includes("\n"))).toBe(true);
  });

  const REAL_TEXT = process.env.SWU_CR_TEXT ?? "/Volumes/Local Files/Projects/swu-mcp/tmp/rules/cr-v8.txt";
  it.skipIf(!existsSync(REAL_TEXT))("resolves every id against the full v8.0 sections", () => {
    const full = parseComprehensiveRules(readFileSync(REAL_TEXT, "utf8"));
    expect(() => assertCoreIdsExist(list, full.sections)).not.toThrow();
  });
});
