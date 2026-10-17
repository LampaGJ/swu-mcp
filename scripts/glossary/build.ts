/**
 * @displayName SWU glossary builder
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#13): the hand-authored glossary text and the
 * pinned raw card list in, docs/concepts/swu-glossary.json out. Counts and the inScope flag are
 * derived, never typed, so a count always states which population it covers and a hand edit cannot
 * drift from the originals (verification RC20, RC21).
 * @tacticalObjective Reads docs/concepts/swu-glossary.source.json (definition, strategicValue and
 * source text with {placeholders}), recomputes per facet value from the originals the printings,
 * distinct cards, text mentions and scope flag, expands the placeholders, validates the result
 * against docs/concepts/swu-glossary.schema.json, and writes it. Same inputs give the same bytes.
 *
 * Usage: pnpm exec tsx scripts/glossary/build.ts [--originals <dir>] [--source <file>] [--out <file>] [--check]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --source     default: docs/concepts/swu-glossary.source.json
 *   --out        default: docs/concepts/swu-glossary.json
 *   --check      write nothing; exit 1 when --out differs from what the build produces
 *
 * Placeholders in the source text:
 *   {printings} {cards} {named} {inScopePrintings} {inScopeCards} {inScopeNamed} {leaderPrintings} {code}
 *   {inScopeTotal} {value}   numbers or the value itself
 *   {printings:printing}     number plus noun, pluralised with an "s" unless the number is 1
 *   {@name}                  a phrase from the source's "phrases" map, expanded in place
 * Meaning of the counts:
 *   printings        raw printings (all sets, all variants) that carry the value
 *   cards            distinct card names (title and subtitle) among those printings
 *   named            trait only: distinct card names with the trait name as a case-sensitive whole word
 *                    in text, deployBox or epicAction on any printing (carriers included)
 *   inScopeTotal     logical cards in the delivered package (a printing in Jump to Lightspeed or later)
 *   inScopeCards     of those, the ones with a printing that carries the value; inScopeNamed likewise
 *   inScopePrintings printings of the value in a set released at or after Jump to Lightspeed
 *   leaderPrintings  printings that carry the value and have type Leader
 *   code             variant facet only: the API's variantId
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import type { FlatRow } from "../../src/swu/llm-flatten.js";
import { cellList, expandHome, inScopeSet, loadOriginals, nameKey, newestOriginalsDir, type Originals } from "./originals.js";
import { REPO_ROOT } from "../../src/paths.js";


export const FACETS = ["aspect", "trait", "keyword", "type", "arena", "rarity", "expansion", "variant", "token"] as const;
export type Facet = (typeof FACETS)[number];

/** Facets whose inScope test is printing-level; the others are card-level (see the schema's inScope description). */
const PRINTING_LEVEL: ReadonlySet<Facet> = new Set(["rarity", "expansion", "variant"]);

const sourceEntrySchema = z.strictObject({
  value: z.string().min(1),
  definition: z.string().min(1),
  strategicValue: z.string().min(1),
  source: z.string().min(1),
});
export const glossarySourceSchema = z.strictObject({
  version: z.literal(1),
  phrases: z.record(z.string(), z.string()),
  facets: z.strictObject(Object.fromEntries(FACETS.map((facet) => [facet, z.array(sourceEntrySchema).min(1)])) as Record<Facet, z.ZodArray<typeof sourceEntrySchema>>),
});
export type GlossarySource = z.infer<typeof glossarySourceSchema>;

export interface ValueStats {
  value: string;
  printings: number;
  cards: number;
  named?: number;
  inScopePrintings: number;
  inScopeCards: number;
  inScopeNamed?: number;
  leaderPrintings: number;
  code?: string;
  inScope: boolean;
}

function valuesOf(facet: Facet, row: FlatRow): string[] {
  switch (facet) {
    case "aspect":
      return cellList(row.aspects);
    case "trait":
      return cellList(row.traits);
    case "keyword":
      return cellList(row.keywords);
    case "type":
      return [...cellList(row.type), ...cellList(row.type2)];
    case "arena":
      return cellList(row.arenas);
    case "rarity":
      return cellList(row.rarity);
    case "expansion":
      return cellList(row.expansion);
    case "variant":
      return cellList(row.variantTypes);
    case "token":
      return [...cellList(row.type), ...cellList(row.type2)].some((t) => t.includes("Token")) ? [String(row.title ?? "")] : [];
  }
}

function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`);
}

const textBlob = (row: FlatRow): string => [row.text, row.deployBox, row.epicAction].filter((cell) => typeof cell === "string").join(" ");

/** variantId per variant name, read from the raw relations because the flat rows keep names only. */
function variantCodes(originals: Originals): Map<string, string> {
  const codes = new Map<string, Set<string>>();
  for (const record of originals.raw) {
    const relation = record.attributes.variantTypes as { data?: { attributes?: { name?: unknown; variantId?: unknown } }[] } | null | undefined;
    for (const entry of relation?.data ?? []) {
      const name = entry.attributes?.name;
      const id = entry.attributes?.variantId;
      if (typeof name !== "string" || typeof id !== "string") continue;
      codes.set(name, (codes.get(name) ?? new Set()).add(id));
    }
  }
  const out = new Map<string, string>();
  for (const [name, ids] of codes) {
    if (ids.size !== 1) throw new Error(`variant ${name} has ${ids.size} variantIds: ${[...ids].join(", ")}`);
    out.set(name, [...ids][0]);
  }
  return out;
}

/** Recomputes every count and the inScope flag for every value of every facet from the originals. */
export function computeStats(originals: Originals): Map<Facet, Map<string, ValueStats>> {
  const { printings, cardKeyOfSerial, keptKeys } = originals;
  const keptOf = (row: FlatRow): string | undefined => {
    const key = cardKeyOfSerial.get(String(row.serialCode));
    return key !== undefined && keptKeys.has(key) ? key : undefined;
  };
  const blobs = printings.map(textBlob);
  const codes = variantCodes(originals);
  const out = new Map<Facet, Map<string, ValueStats>>();
  for (const facet of FACETS) {
    const carriers = new Map<string, number[]>();
    printings.forEach((row, index) => {
      for (const value of new Set(valuesOf(facet, row))) carriers.set(value, [...(carriers.get(value) ?? []), index]);
    });
    const stats = new Map<string, ValueStats>();
    for (const [value, indexes] of [...carriers].sort((a, b) => compareCodePoints(a[0], b[0]))) {
      const rows = indexes.map((i) => printings[i]);
      const inScopeRows = rows.filter((row) => inScopeSet(row.expansion));
      const keptCards = new Set(rows.map(keptOf).filter((key): key is string => key !== undefined));
      const entry: ValueStats = {
        value,
        printings: rows.length,
        cards: new Set(rows.map(nameKey)).size,
        inScopePrintings: inScopeRows.length,
        inScopeCards: keptCards.size,
        leaderPrintings: rows.filter((row) => row.type === "Leader").length,
        inScope: PRINTING_LEVEL.has(facet) ? inScopeRows.length > 0 : keptCards.size > 0,
      };
      if (facet === "trait") {
        const word = wholeWord(value);
        const names = new Set<string>();
        const keptNamed = new Set<string>();
        printings.forEach((row, index) => {
          if (!word.test(blobs[index])) return;
          names.add(nameKey(row));
          const key = keptOf(row);
          if (key !== undefined) keptNamed.add(key);
        });
        entry.named = names.size;
        entry.inScopeNamed = keptNamed.size;
      }
      if (facet === "variant") entry.code = codes.get(value);
      stats.set(value, entry);
    }
    out.set(facet, stats);
  }
  return out;
}

export type Context = Record<string, string | number | undefined>;

export function expand(template: string, context: Context, phrases: Record<string, string>, where: string, depth = 0): string {
  if (depth > 3) throw new Error(`${where}: phrase nesting deeper than 3`);
  return template.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    if (token.startsWith("@")) {
      const phrase = phrases[token.slice(1)];
      if (phrase === undefined) throw new Error(`${where}: unknown phrase {${token}}`);
      return expand(phrase, context, phrases, where, depth + 1);
    }
    const [key, noun] = token.split(":");
    const value = context[key];
    if (value === undefined) throw new Error(`${where}: {${token}} has no value for this entry`);
    if (noun === undefined) return String(value);
    if (typeof value !== "number") throw new Error(`${where}: {${token}} needs a number`);
    return `${value} ${noun}${value === 1 ? "" : "s"}`;
  });
}

export interface GlossaryEntry {
  value: string;
  definition: string;
  strategicValue: string;
  source: string;
  inScope: boolean;
}
export interface Glossary {
  version: 1;
  facets: Record<Facet, GlossaryEntry[]>;
}

export function buildGlossary(source: GlossarySource, originals: Originals): Glossary {
  const stats = computeStats(originals);
  const inScopeTotal = originals.kept.length;
  const facets = {} as Record<Facet, GlossaryEntry[]>;
  for (const facet of FACETS) {
    const facetStats = stats.get(facet) as Map<string, ValueStats>;
    const authored = new Set(source.facets[facet].map((entry) => entry.value));
    if (authored.size !== source.facets[facet].length) throw new Error(`${facet}: duplicate value in the source`);
    for (const value of facetStats.keys()) if (!authored.has(value)) throw new Error(`${facet}:${value} is in the data but has no source entry`);
    facets[facet] = [...source.facets[facet]]
      .sort((a, b) => compareCodePoints(a.value, b.value))
      .map((entry) => {
        const s = facetStats.get(entry.value);
        if (s === undefined) throw new Error(`${facet}:${entry.value} is in the source but no printing carries it`);
        const where = `${facet}:${entry.value}`;
        const context: Context = { ...Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== "boolean")), inScopeTotal, value: entry.value };
        return {
          value: entry.value,
          definition: expand(entry.definition, context, source.phrases, `${where} definition`),
          strategicValue: expand(entry.strategicValue, context, source.phrases, `${where} strategicValue`),
          source: expand(entry.source, context, source.phrases, `${where} source`),
          inScope: s.inScope,
        };
      });
  }
  return { version: 1, facets };
}

/** Validates against the committed JSON Schema, converted by zod so no second validator is needed. */
export function validateAgainstSchema(glossary: Glossary, schemaPath: string): void {
  const schema = z.fromJSONSchema(JSON.parse(readFileSync(schemaPath, "utf8")));
  const result = schema.safeParse(glossary);
  if (!result.success) throw new Error(`glossary fails ${schemaPath}: ${result.error.issues.slice(0, 5).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
}

export const serializeGlossary = (glossary: Glossary): string => `${JSON.stringify(glossary, null, 2)}\n`;

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, source: { type: "string" }, out: { type: "string" }, check: { type: "boolean", default: false } } });
  const originalsDir = path.resolve(expandHome(values.originals ?? newestOriginalsDir()));
  const sourcePath = path.resolve(expandHome(values.source ?? path.join(REPO_ROOT, "docs/concepts/swu-glossary.source.json")));
  const outPath = path.resolve(expandHome(values.out ?? path.join(REPO_ROOT, "docs/concepts/swu-glossary.json")));
  const source = glossarySourceSchema.parse(JSON.parse(readFileSync(sourcePath, "utf8")));
  const originals = loadOriginals(originalsDir);
  const glossary = buildGlossary(source, originals);
  validateAgainstSchema(glossary, path.join(REPO_ROOT, "docs/concepts/swu-glossary.schema.json"));
  const text = serializeGlossary(glossary);
  if (values.check) {
    const same = readFileSync(outPath, "utf8") === text;
    console.log(JSON.stringify({ check: same ? "same" : "differs", out: outPath, originals: originalsDir }));
    process.exit(same ? 0 : 1);
  }
  writeFileSync(outPath, text);
  const counts = Object.fromEntries(FACETS.map((facet) => [facet, glossary.facets[facet].length]));
  console.log(JSON.stringify({ out: outPath, originals: originalsDir, runDate: originals.runDate, inScopeTotal: originals.kept.length, entries: counts }));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
