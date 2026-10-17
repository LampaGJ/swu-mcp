import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fieldGuideCounts } from "../../scripts/glossary/field-guide-counts.js";
import { loadOriginals, type RawPrinting } from "../../scripts/glossary/originals.js";

const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";
const GUIDE = readFileSync(path.resolve(import.meta.dirname, "../../docs/concepts/swu-card-data-fields.md"), "utf8");

const rel = (name: string) => ({ data: { attributes: { name } } });
const variant = (name: string, variantId: string) => ({ data: [{ attributes: { name, variantId } }] });
const raw = (attributes: Record<string, unknown>): RawPrinting => ({ id: undefined, attributes });

describe("fieldGuideCounts", () => {
  const counts = fieldGuideCounts(
    [
      raw({ serialCode: "0101001", hp: null, type: rel("Event"), rules: "r", rulesStyled: "<p>r</p>", variantTypes: variant("Standard", "01"), deployBox: null, artist: "A" }),
      raw({ serialCode: "0316002p", hp: 30, type: rel("Base"), rules: "r", rulesStyled: "", variantTypes: variant("Weekly Play", "60"), deployBox: "d", artist: "B" }),
      raw({ serialCode: "0160001a", hp: 5, type: rel("Unit"), rules: null, rulesStyled: null, variantTypes: variant("SS Judge", "45"), deployBox: null, artist: "A" }),
      raw({ serialCode: "0601003", hp: 5, type: rel("Unit"), rules: "x", rulesStyled: null, variantTypes: { data: [] }, deployBox: null, artist: "A" }),
    ],
    "2026-01-01",
  );

  it("counts hp nulls and thirties by type", () => {
    expect(counts.hp).toMatchObject({ nullCount: 1, nullByType: { Event: 1 }, thirtyCount: 1, thirtyByType: { Base: 1 }, min: 5, max: 30 });
  });

  it("separates empty from non-empty styled rulings", () => {
    expect(counts.rulesStyled).toMatchObject({ strings: 2, emptyStrings: 1, nonEmpty: 1, nonEmptyWithoutPlainRules: 0, plainRulesWithoutNonEmptyStyled: 2 });
  });

  it("matches the variant code against serial digits 3-4, then 4-5, else neither", () => {
    expect(counts.variantId).toMatchObject({ withOneVariant: 3, withNoVariant: 1, serialDigits3to4EqualVariantId: 1, serialDigits4to5EqualVariantId: 1, serialMatchesNeither: 1 });
  });
});

describe.skipIf(!existsSync(ORIGINALS))("field guide against the pinned originals", () => {
  const originals = loadOriginals(ORIGINALS);
  const counts = fieldGuideCounts(originals.raw, originals.runDate);

  it("states the recomputed numbers", () => {
    for (const phrase of [
      `null on ${counts.hp.nullCount.toLocaleString("en-US")}`,
      `30 on ${counts.hp.thirtyCount} printings`,
      `${counts.rulesStyled.strings.toLocaleString("en-US")} printings in the 2026-10-16 raw card list, of which ${counts.rulesStyled.emptyStrings} are empty`,
      `${counts.rulesStyled.nonEmpty.toLocaleString("en-US")} each have a plain-text`,
      `${counts.variantId.serialDigits3to4EqualVariantId.toLocaleString("en-US")} of ${counts.variantId.withOneVariant.toLocaleString("en-US")}`,
      `A further ${counts.variantId.serialDigits4to5EqualVariantId}`,
      `${counts.variantId.serialMatchesNeither} match neither`,
    ]) expect(GUIDE).toContain(phrase);
  });

  it("states the Printing-section numbers for the raw card list (verification RC21)", () => {
    const n = (x: number): string => x.toLocaleString("en-US");
    const p = counts.printing;
    const list = (m: Record<string, number>, order: readonly string[]): string => order.map((k) => `${k} ${n(m[k] ?? 0)}`).join(", ");
    const byCount = (m: Record<string, number>): string[] => Object.keys(m).sort((a, b) => m[b] - m[a] || (a < b ? -1 : 1));
    for (const phrase of [
      `${n(p.cardNumberDistinct)} distinct values in the raw card list`,
      `${n(p.titleDistinct)} distinct titles in the raw card list`,
      `In the raw card list ${n(p.subtitleEmpty)} are the empty string and ${n(p.subtitleNull)} are null`,
      `${n(counts.other.artistDistinct)} distinct in the raw card list`,
      `Empty string on ${n(p.textEmpty)} printings; null on ${n(p.textNull)}`,
      `Non-null on ${n(p.deployBoxNonNullByType.Leader)} printings in the raw card list, all Leaders`,
      `Empty string ${n(p.epicActionEmpty)} times, null ${n(p.epicActionNull)}, non-empty on ${n(p.epicActionNonEmptyByType.Leader)} Leaders and ${n(p.epicActionNonEmptyByType.Unit)} Units`,
      `null on ${n(p.costNull)} printings in the raw card list`,
      `null on ${n(p.powerNull)} printings in the raw card list`,
      `Closed set in the raw card list (9): ${list(p.byType, byCount(p.byType))}.`,
      `Observed in the raw card list: ${list(p.byRarity, ["Common", "Uncommon", "Rare", "Legendary", "Special"])}.`,
      `Closed set (6), counted in the raw card list: ${list(p.byAspect, byCount(p.byAspect))}.`,
      `exactly one entry for ${n(counts.variantId.withOneVariant)} printings in the raw card list and is empty for ${counts.variantId.withNoVariant}`,
      `\`false\` ${n(p.foil.false)}; \`true\` ${n(p.foil.true)}; \`null\` ${n(p.foil.null)}`,
      `${n(p.withKeyword)} printings in the raw card list have at least one`,
      `Empty on all ${p.traitlessBases} Bases and 2 Force Tokens in the raw card list`,
    ]) expect(GUIDE).toContain(phrase);
    expect(Object.keys(p.deployBoxNonNullByType)).toEqual(["Leader"]);
    expect(Object.keys(p.epicActionNonEmptyByType)).toEqual(["Leader", "Unit"]);
  });
});
