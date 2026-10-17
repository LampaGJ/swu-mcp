/**
 * @displayName SWU field-guide counts
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#13, verification RC21): every number the field
 * guide quotes about hp, rulesStyled and variantId is recomputed from the pinned raw card list, so the
 * guide cannot drift from the originals and each count names the snapshot it covers.
 * @tacticalObjective Reads the complete raw run in a mault originals folder (page hashes checked) and
 * prints one JSON object of counts to stdout, or to --out. Same inputs give the same bytes.
 *
 * Usage: pnpm exec tsx scripts/glossary/field-guide-counts.ts [--originals <dir>] [--out <file>]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { expandHome, loadOriginals, newestOriginalsDir, type RawPrinting } from "./originals.js";

type Attrs = Record<string, unknown>;

const relationName = (value: unknown): string | undefined => {
  const data = (value as { data?: { attributes?: { name?: unknown } } | null } | null | undefined)?.data;
  const name = data?.attributes?.name;
  return typeof name === "string" ? name : undefined;
};
const relationNames = (value: unknown): string[] =>
  ((value as { data?: { attributes?: { name?: unknown } }[] } | null | undefined)?.data ?? [])
    .map((entry) => entry.attributes?.name)
    .filter((name): name is string => typeof name === "string");
const isNonEmptyString = (value: unknown): boolean => typeof value === "string" && value !== "";
const sortedEntries = (counts: Map<string, number>): Record<string, number> => Object.fromEntries([...counts].sort((a, b) => compareCodePoints(a[0], b[0])));
const tally = (values: Iterable<string>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

/** The Printing-section counts of the field guide, over every raw printing. */
function printingCounts(attrs: readonly Attrs[]) {
  const typeOf = (a: Attrs): string => relationName(a.type) ?? "none";
  const foils = attrs.flatMap((a) => ((a.variantTypes as { data?: { attributes?: { foil?: unknown } }[] } | null)?.data ?? []).map((v) => String(v.attributes?.foil ?? null)));
  return {
    cardNumberDistinct: new Set(attrs.map((a) => a.cardNumber)).size,
    titleDistinct: new Set(attrs.map((a) => a.title)).size,
    subtitleEmpty: attrs.filter((a) => a.subtitle === "").length,
    subtitleNull: attrs.filter((a) => a.subtitle == null).length,
    textEmpty: attrs.filter((a) => a.text === "").length,
    textNull: attrs.filter((a) => a.text == null).length,
    deployBoxNonNullByType: sortedEntries(tally(attrs.filter((a) => a.deployBox != null).map(typeOf))),
    epicActionEmpty: attrs.filter((a) => a.epicAction === "").length,
    epicActionNull: attrs.filter((a) => a.epicAction == null).length,
    epicActionNonEmptyByType: sortedEntries(tally(attrs.filter((a) => isNonEmptyString(a.epicAction)).map(typeOf))),
    costNull: attrs.filter((a) => a.cost == null).length,
    powerNull: attrs.filter((a) => a.power == null).length,
    byType: sortedEntries(tally(attrs.map(typeOf))),
    byRarity: sortedEntries(tally(attrs.map((a) => relationName(a.rarity) ?? "none"))),
    byAspect: sortedEntries(tally(attrs.flatMap((a) => relationNames(a.aspects)))),
    foil: sortedEntries(tally(foils)),
    withKeyword: attrs.filter((a) => relationNames(a.keywords).length > 0).length,
    traitlessBases: attrs.filter((a) => typeOf(a) === "Base" && relationNames(a.traits).length === 0).length,
  };
}

export function fieldGuideCounts(raw: readonly RawPrinting[], runDate: string) {
  const attrs: Attrs[] = raw.map((record) => record.attributes);
  const hp = attrs.map((a) => a.hp);
  const hpValues = hp.filter((v): v is number => typeof v === "number");

  const rulesStyled = attrs.map((a) => a.rulesStyled);
  const styledNonEmpty = attrs.filter((a) => isNonEmptyString(a.rulesStyled));
  const plainNonEmpty = attrs.filter((a) => isNonEmptyString(a.rules));

  let serialDigits34 = 0;
  let serialDigits45 = 0;
  let serialNeither = 0;
  let noVariant = 0;
  const serialNeitherExamples: string[] = [];
  const namesByCode = new Map<string, Set<string>>();
  const namesBySerialDigits = new Map<string, Set<string>>();
  for (const a of attrs) {
    const entries = (a.variantTypes as { data?: { attributes?: { name?: unknown; variantId?: unknown } }[] } | null)?.data ?? [];
    if (entries.length !== 1) {
      if (entries.length === 0) noVariant += 1;
      else throw new Error(`${String(a.serialCode)} has ${entries.length} variantTypes`);
      continue;
    }
    const id = String(entries[0].attributes?.variantId);
    const name = String(entries[0].attributes?.name);
    const serial = String(a.serialCode);
    if (serial.slice(2, 4) === id) serialDigits34 += 1;
    else if (serial.slice(3, 5) === id) serialDigits45 += 1;
    else {
      serialNeither += 1;
      if (serialNeitherExamples.length < 5) serialNeitherExamples.push(`${serial} ${name} (variantId ${id})`);
    }
    namesByCode.set(id, (namesByCode.get(id) ?? new Set()).add(name));
    namesBySerialDigits.set(serial.slice(2, 4), (namesBySerialDigits.get(serial.slice(2, 4)) ?? new Set()).add(name));
  }
  const names = (map: Map<string, Set<string>>, key: string): string[] => [...(map.get(key) ?? [])].sort(compareCodePoints);

  return {
    snapshot: `raw card list finished ${runDate}`,
    printings: attrs.length,
    hp: {
      nullCount: hp.filter((v) => v == null).length,
      nullByType: sortedEntries(tally(attrs.filter((a) => a.hp == null).map((a) => relationName(a.type) ?? "none"))),
      min: Math.min(...hpValues),
      max: Math.max(...hpValues),
      thirtyCount: hp.filter((v) => v === 30).length,
      thirtyByType: sortedEntries(tally(attrs.filter((a) => a.hp === 30).map((a) => relationName(a.type) ?? "none"))),
    },
    rulesStyled: {
      strings: rulesStyled.filter((v) => typeof v === "string").length,
      emptyStrings: rulesStyled.filter((v) => v === "").length,
      nonEmpty: styledNonEmpty.length,
      nonEmptyWithoutPlainRules: styledNonEmpty.filter((a) => !isNonEmptyString(a.rules)).length,
      plainRulesWithoutNonEmptyStyled: plainNonEmpty.filter((a) => !isNonEmptyString(a.rulesStyled)).length,
      rulesNonNull: attrs.filter((a) => a.rules != null).length,
    },
    variantId: {
      withOneVariant: attrs.length - noVariant,
      withNoVariant: noVariant,
      serialDigits3to4EqualVariantId: serialDigits34,
      serialDigits4to5EqualVariantId: serialDigits45,
      serialMatchesNeither: serialNeither,
      serialMatchesNeitherExamples: serialNeitherExamples,
      namesForVariantId60: names(namesByCode, "60"),
      namesForVariantId05: names(namesByCode, "05"),
      namesForSerialDigits3to4Equal60: names(namesBySerialDigits, "60"),
    },
    printing: printingCounts(attrs),
    other: {
      deployBoxNonNull: attrs.filter((a) => a.deployBox != null).length,
      artistDistinct: new Set(attrs.map((a) => a.artist)).size,
    },
  };
}

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, out: { type: "string" } } });
  const originals = loadOriginals(path.resolve(expandHome(values.originals ?? newestOriginalsDir())));
  const text = `${JSON.stringify(fieldGuideCounts(originals.raw, originals.runDate), null, 2)}\n`;
  if (values.out !== undefined) writeFileSync(path.resolve(expandHome(values.out)), text);
  else process.stdout.write(text);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
