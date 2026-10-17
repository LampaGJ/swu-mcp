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
});
