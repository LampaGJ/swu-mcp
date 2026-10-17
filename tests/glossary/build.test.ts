import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FACETS,
  buildGlossary,
  computeStats,
  expand,
  glossarySourceSchema,
  serializeGlossary,
  validateAgainstSchema,
  type GlossarySource,
} from "../../scripts/glossary/build.js";
import { loadOriginals, type Originals } from "../../scripts/glossary/originals.js";
import type { FlatRow } from "../../src/swu/llm-flatten.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCHEMA = path.join(ROOT, "docs/concepts/swu-glossary.schema.json");
const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";

function row(serialCode: string, over: Record<string, string | number | boolean | null>): FlatRow {
  return { serialCode, title: "T", subtitle: null, type: "Unit", type2: "", aspects: "", traits: "", keywords: "", arenas: "Ground", rarity: "Common", expansion: "JTL", variantTypes: "Standard", text: null, deployBox: null, epicAction: null, ...over };
}

const variantRelation = (name: string, variantId: string): unknown => ({ data: [{ attributes: { name, variantId } }] });

/** Four printings: Rebel Alpha (JTL, kept), a foil reprint of it (SOR), Rebel Beta (SOR only), Gamma naming Rebel (JTL, kept). */
function fakeOriginals(): Originals {
  const printings = [
    row("A1", { title: "Alpha", traits: "Rebel", variantTypes: "Standard" }),
    row("A2", { title: "Alpha", traits: "Rebel", expansion: "SOR", variantTypes: "Hyperspace" }),
    row("B1", { title: "Beta", traits: "Rebel", expansion: "SOR", type: "Leader", rarity: "Special" }),
    row("G1", { title: "Gamma", traits: "Imperial", text: "Deal 1 damage to a Rebel unit. Rebels are not matched, nor is Rebellion." }),
  ];
  const raw = printings.map((_, i) => ({ id: i, attributes: { variantTypes: variantRelation(i === 1 ? "Hyperspace" : "Standard", i === 1 ? "02" : "01") } }));
  const cardKeyOfSerial = new Map([["A1", "A1"], ["A2", "A1"], ["B1", "B1"], ["G1", "G1"]]);
  const logical = [printings[0], printings[2], printings[3]].map((p) => ({ ...p, cardKey: p.serialCode }));
  const kept = [logical[0], logical[2]];
  return { runDate: "2026-01-01", raw, printings, cardKeyOfSerial, logical, kept, keptKeys: new Set(["A1", "G1"]) };
}

const entry = (value: string, definition: string) => ({ value, definition, strategicValue: "s", source: "x" });

describe("placeholder expansion", () => {
  it("fills numbers, pluralises nouns and expands phrases", () => {
    const phrases = { p: "{n:card} here" };
    expect(expand("a {n} b {@p}", { n: 2 }, phrases, "t")).toBe("a 2 b 2 cards here");
    expect(expand("{n:card}", { n: 1 }, phrases, "t")).toBe("1 card");
  });

  it("fails on a placeholder with no value, an unknown phrase or a phrase loop", () => {
    expect(() => expand("{missing}", {}, {}, "t")).toThrow(/no value/);
    expect(() => expand("{@nope}", {}, {}, "t")).toThrow(/unknown phrase/);
    expect(() => expand("{@a}", {}, { a: "{@a}" }, "t")).toThrow(/nesting/);
  });
});

describe("computed counts", () => {
  const stats = computeStats(fakeOriginals());
  const rebel = stats.get("trait")?.get("Rebel");

  it("counts printings and distinct cards across all sets, and in-scope cards separately", () => {
    expect(rebel).toMatchObject({ printings: 3, cards: 2, inScopeCards: 1, inScope: true });
  });

  it("counts a case-sensitive whole-word mention once per card name, never a longer word", () => {
    expect(rebel?.named).toBe(1);
    expect(rebel?.inScopeNamed).toBe(1);
  });

  it("flags scope per facet: card-level for traits, printing-level for expansion and rarity", () => {
    expect(stats.get("expansion")?.get("SOR")).toMatchObject({ printings: 2, inScope: false });
    expect(stats.get("expansion")?.get("JTL")).toMatchObject({ printings: 2, inScope: true });
    expect(stats.get("rarity")?.get("Special")).toMatchObject({ printings: 1, leaderPrintings: 1, inScope: false });
    expect(stats.get("trait")?.get("Imperial")?.inScope).toBe(true);
  });

  it("reads the variant code from the raw relation", () => {
    expect(stats.get("variant")?.get("Hyperspace")?.code).toBe("02");
  });
});

describe("buildGlossary", () => {
  const authored = (extra: Partial<Record<(typeof FACETS)[number], ReturnType<typeof entry>[]>> = {}): GlossarySource => ({
    version: 1,
    phrases: {},
    facets: {
      aspect: [],
      trait: [entry("Imperial", "{printings:printing}; {inScopeCards} of {inScopeTotal} in scope."), entry("Rebel", "{printings} / {cards} / {named}")],
      keyword: [],
      type: [entry("Leader", "l"), entry("Unit", "u")],
      arena: [entry("Ground", "{value}")],
      rarity: [entry("Common", "c"), entry("Special", "s")],
      expansion: [entry("JTL", "j"), entry("SOR", "s")],
      variant: [entry("Hyperspace", "{code}"), entry("Standard", "{code}")],
      token: [],
      ...extra,
    },
  });

  it("derives the counts and the flag from the originals", () => {
    const glossary = buildGlossary(authored() as GlossarySource, fakeOriginals());
    expect(glossary.facets.trait.map((e) => e.definition)).toEqual(["1 printing; 1 of 2 in scope.", "3 / 2 / 1"]);
    expect(glossary.facets.trait.map((e) => e.inScope)).toEqual([true, true]);
    expect(glossary.facets.variant.map((e) => e.definition)).toEqual(["02", "01"]);
  });

  it("is byte-identical on a second run", () => {
    const a = serializeGlossary(buildGlossary(authored() as GlossarySource, fakeOriginals()));
    const b = serializeGlossary(buildGlossary(authored() as GlossarySource, fakeOriginals()));
    expect(a).toBe(b);
  });

  it("fails when the data has a value the source lacks or the source has a value no printing carries", () => {
    const missing = authored({ trait: [entry("Imperial", "i")] });
    expect(() => buildGlossary(missing as GlossarySource, fakeOriginals())).toThrow(/trait:Rebel is in the data but has no source entry/);
    const orphan = authored({ trait: [entry("Imperial", "i"), entry("Rebel", "r"), entry("Sith", "s")] });
    expect(() => buildGlossary(orphan as GlossarySource, fakeOriginals())).toThrow(/trait:Sith is in the source but no printing carries it/);
  });
});

describe("committed glossary", () => {
  const source = glossarySourceSchema.parse(JSON.parse(readFileSync(path.join(ROOT, "docs/concepts/swu-glossary.source.json"), "utf8")));
  const generated = JSON.parse(readFileSync(path.join(ROOT, "docs/concepts/swu-glossary.json"), "utf8"));

  it("validates against the JSON Schema", () => {
    expect(() => validateAgainstSchema(generated, SCHEMA)).not.toThrow();
  });

  it("holds exactly the authored values with every placeholder filled in", () => {
    for (const facet of FACETS) {
      expect(generated.facets[facet].map((e: { value: string }) => e.value)).toEqual(source.facets[facet].map((e) => e.value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    }
    const text = Object.values(generated.facets).flat().flatMap((e: any) => [e.definition, e.strategicValue, e.source]);
    expect(text.filter((t) => /[{}]/.test(t))).toEqual([]);
  });

  it("states the scope of every trait count", () => {
    for (const e of generated.facets.trait) {
      expect(e.definition).toContain("Across all sets and printings");
      expect(e.definition).toMatch(/Among the \d+ in-scope cards/);
    }
  });

  it.skipIf(!existsSync(ORIGINALS))("equals a fresh build from the pinned originals", () => {
    const fresh = serializeGlossary(buildGlossary(source, loadOriginals(ORIGINALS)));
    expect(readFileSync(path.join(ROOT, "docs/concepts/swu-glossary.json"), "utf8")).toBe(fresh);
  });
});
