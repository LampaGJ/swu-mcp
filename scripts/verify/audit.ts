/**
 * Deterministic audit of every derived data product against the originals (LampaGJ/swu-mcp#9, Part A).
 *
 * The audit re-derives each claim from raw JSON, the pinned captures and the CR PDF with its own small logic.
 * From the project it imports only the raw-manifest Zod contract (a schema, not a derivation). It does not
 * import the production flattener, folder, price builder or CR parser, so a bug there cannot hide by being
 * compared with itself. The TOON decoder and Zod are shared libraries.
 *
 * Usage: pnpm verify:audit [--originals <dir>] [--run <dir>] [--pinned <dir>] [--date <YYYY-MM-DD>]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --run        default: <repo>/data/runs/<date>
 *   --pinned     default: <repo>/data/pinned/gt
 *   --date       default: the day the raw card-list run finished
 * Output: <run>/verify/audit.json. Exit 1 when any check has a failure.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { swuRawCacheManifestSchema } from "../../src/swu/raw-manifest.js";
import { progress } from "../lib/progress.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";
const CDN = "https://cdn.starwarsunlimited.com/";
const EXAMPLE_LIMIT = 20;

type Cell = string | number | boolean | null;
type Rec = Record<string, unknown>;

export interface AuditCheck {
  name: string;
  description: string;
  unit: string;
  universe: Record<string, number>;
  population: number;
  checked: number;
  passed: number;
  failed: number;
  examples: Rec[];
  notes: string[];
}

class Check implements AuditCheck {
  population = 0;
  checked = 0;
  passed = 0;
  failed = 0;
  examples: Rec[] = [];
  notes: string[] = [];
  universe: Record<string, number> = {};
  constructor(
    readonly name: string,
    readonly description: string,
    readonly unit: string,
  ) {}
  expect(ok: boolean, evidence: () => Rec): void {
    this.population += 1;
    this.checked += 1;
    if (ok) {
      this.passed += 1;
      return;
    }
    this.failed += 1;
    if (this.examples.length < EXAMPLE_LIMIT) this.examples.push(evidence());
  }
}

const clip = (value: unknown, limit = 300): unknown => {
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}…(${value.length} chars)` : value;
  if (Array.isArray(value) && value.length > 12) return [...value.slice(0, 12), `…(${value.length} items)`];
  return value;
};

function codePointCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const d = (x[i].codePointAt(0) as number) - (y[i].codePointAt(0) as number);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const split = (value: unknown): string[] => (typeof value === "string" && value !== "" ? value.split("|") : []);
const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort(codePointCompare);

/** Every foreign file passes through here: a schema failure names the file and the offending path. */
function parseAt<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${z.prettifyError(result.error)}`);
  return result.data;
}

const readText = (file: string): string => readFileSync(file, "utf8");
const readJson = <T>(file: string, schema: z.ZodType<T>): T => parseAt(schema, JSON.parse(readText(file)), file);

const manifestSchema = swuRawCacheManifestSchema;
const pageSchema = z.looseObject({
  data: z.array(z.looseObject({ attributes: z.record(z.string(), z.unknown()) })),
  meta: z.looseObject({ pagination: z.looseObject({ page: z.number().int(), pageCount: z.number().int(), total: z.number().int() }) }),
});
const priceRowSchema = z.looseObject({
  card_id: z.string(),
  variant: z.string(),
  product_id: z.number().int(),
  price_normal: z.number().nullable(),
  price_foil: z.number().nullable(),
  price_source: z.string().nullable(),
  conformance: z.string().nullable(),
});
const priceImportSchema = z.looseObject({ id: z.number().int(), finished_at: z.string().nullable() });
const pricesFileSchema = z.looseObject({
  priceImportId: z.number().int(),
  priceImportFinishedAt: z.string().nullable(),
  cards: z.array(
    z.looseObject({
      cardKey: z.string(),
      normal: z.number().nullable(),
      foil: z.number().nullable(),
      printings: z.array(
        z.looseObject({
          cardId: z.string(),
          variant: z.string(),
          productId: z.number().int(),
          normal: z.number().nullable(),
          foil: z.number().nullable(),
          priceSource: z.string().nullable(),
          conformance: z.string().nullable(),
        }),
      ),
    }),
  ),
});
const rulingsFileSchema = z.looseObject({
  source: z.looseObject({ rawPagesManifestSha256: z.string() }),
  stats: z.looseObject({
    printingsWithRulings: z.number(),
    logicalCardsWithRulings: z.number(),
    distinctRulesFields: z.number(),
    distinctRulingTexts: z.number(),
    distinctDatedRulings: z.number(),
    distinctUndatedRulings: z.number(),
    rulingRows: z.number(),
  }),
  cards: z.array(
    z.looseObject({
      cardKey: z.string(),
      title: z.string(),
      subtitle: z.string().nullable(),
      printings: z.number(),
      rulings: z.array(z.looseObject({ date: z.string().nullable(), source: z.string(), text: z.string() })),
    }),
  ),
});
const playFileSchema = z.looseObject({
  windows: z.array(z.looseObject({ id: z.string(), startWeek: z.number(), endWeek: z.number(), startDate: z.string(), endDate: z.string(), sha256: z.string(), playerGames: z.number() })),
  cards: z.array(z.looseObject({ cardKey: z.string(), byWindow: z.record(z.string(), z.looseObject({ included: z.number(), wins: z.number() })) })),
});
const captureSchema = z.array(z.looseObject({ cardUid: z.union([z.string(), z.number()]), timesIncluded: z.number(), timesIncludedInWins: z.number() }));
const glossarySchema = z.looseObject({
  facets: z.record(z.string(), z.array(z.looseObject({ value: z.string(), definition: z.string().nullish(), inScope: z.boolean().optional() }))),
});
const sectionsFileSchema = z.looseObject({
  document: z.looseObject({ pages: z.number(), pdfSha256: z.string(), version: z.string() }),
  stats: z.looseObject({ sections: z.number(), byDepth: z.array(z.number()) }),
  anomalies: z.array(z.string()),
  sections: z.array(
    z.looseObject({
      id: z.string(),
      parentId: z.string().nullable(),
      depth: z.number(),
      title: z.string().nullable(),
      text: z.string(),
      page: z.number(),
    }),
  ),
});
const replaySchema = z.looseObject({ inputs: z.looseObject({ rawManifestSha256: z.string(), pages: z.array(z.string()) }) });

// ---------------------------------------------------------------- raw originals

interface Printing {
  serial: string;
  uid: string;
  cells: Record<string, Cell>;
  rules: string | null;
  rulesStyled: string | null;
  page: number;
}

const DROPPED_KEYS = new Set(["localizations", "linkHtml", "createdAt", "updatedAt", "publishedAt"]);
const isDropped = (key: string): boolean => DROPPED_KEYS.has(key) || key.endsWith("Styled");

function isRelation(value: unknown): value is { data: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "data" in value;
}

function attrOf(entry: unknown, field: string): unknown {
  return ((entry as { attributes?: Rec } | null)?.attributes ?? {})[field];
}

/** Raw Strapi value -> the cell the flattened table is documented to hold. */
function reduceValue(key: string, value: unknown): Cell {
  if (!isRelation(value)) return value === undefined ? null : (value as Cell);
  const data = value.data;
  if (key === "variantOf" || key === "reprintOf") return data === null || data === undefined ? "" : String(attrOf(data, "serialCode") ?? "");
  if (Array.isArray(data)) return data.map((entry) => String(attrOf(entry, "name") ?? "")).join("|");
  if (data === null || data === undefined) return "";
  const url = attrOf(data, "url");
  if (typeof url === "string") return url.startsWith(CDN) ? url.slice(CDN.length) : url;
  const name = attrOf(data, key === "expansion" ? "code" : "name");
  return typeof name === "string" ? name : "";
}

const SET_ORDER: Record<string, number> = { SOR: 1, SHD: 2, TWI: 3, JTL: 4, LOF: 5, SEC: 6, LAW: 7, ASH: 8, HMW: 9 };
const UNKNOWN_ORDER = 1_000_000;
const FIRST_CURRENT_ORDER = 4;

/** Release order of a set code; a Weekly Play code "<set>P" takes its base set's order. */
function orderOf(code: string): number {
  const direct = SET_ORDER[code];
  if (direct !== undefined) return direct;
  const base = code.endsWith("P") ? SET_ORDER[code.slice(0, -1)] : undefined;
  return base ?? UNKNOWN_ORDER;
}

const cellStr = (p: Printing, key: string): string => {
  const v = p.cells[key];
  return typeof v === "string" ? v : "";
};
const expansionOf = (p: Printing): string => cellStr(p, "expansion");
const earlierFirst = (a: Printing, b: Printing): number =>
  orderOf(expansionOf(a)) - orderOf(expansionOf(b)) || codePointCompare(a.serial, b.serial);

interface Logical {
  cardKey: string;
  canonical: Printing;
  members: Printing[];
  eligible: Printing[];
  kept: boolean;
  sets: string[];
  firstSet: string;
  variants: string[];
}

function foldPrintings(printings: Printing[]): { logical: Logical[]; danglingLinks: number } {
  const bySerial = new Map(printings.map((p) => [p.serial, p]));
  const parent = new Map<string, string>(printings.map((p) => [p.serial, p.serial]));
  const find = (s: string): string => {
    let root = s;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let walk = s;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) as string;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  let danglingLinks = 0;
  for (const p of printings) {
    for (const link of ["variantOf", "reprintOf"]) {
      const target = cellStr(p, link);
      if (target === "") continue;
      if (!bySerial.has(target)) danglingLinks += 1;
      else parent.set(find(p.serial), find(target));
    }
  }
  const groups = new Map<string, Printing[]>();
  for (const p of printings) {
    const root = find(p.serial);
    const list = groups.get(root) ?? [];
    list.push(p);
    groups.set(root, list);
  }
  const logical: Logical[] = [];
  for (const members of groups.values()) {
    const unlinked = members.filter((m) => cellStr(m, "variantOf") === "" && cellStr(m, "reprintOf") === "");
    const eligible = unlinked.length > 0 ? unlinked : members;
    const canonical = [...eligible].sort(earlierFirst)[0];
    const earliest = [...members].sort(earlierFirst)[0];
    const codes = uniqueSorted(members.map(expansionOf).filter((c) => c !== ""));
    const sets = codes.sort((a, b) => orderOf(a) - orderOf(b) || codePointCompare(a, b));
    logical.push({
      cardKey: canonical.serial,
      canonical,
      members,
      eligible,
      kept: members.some((m) => {
        const order = orderOf(expansionOf(m));
        return order !== UNKNOWN_ORDER && order >= FIRST_CURRENT_ORDER;
      }),
      sets,
      firstSet: expansionOf(earliest),
      variants: uniqueSorted(members.flatMap((m) => split(m.cells.variantTypes))),
    });
  }
  logical.sort((a, b) => codePointCompare(a.cardKey, b.cardKey));
  return { logical, danglingLinks };
}

// ---------------------------------------------------------------- context

interface Ctx {
  originalsDir: string;
  runDir: string;
  pinnedDir: string;
  date: string;
  printings: Printing[];
  manifestBytes: Buffer;
  manifest: z.infer<typeof manifestSchema>;
  pageResults: { page: number; file: string; bytes: number; digest: string; total: number; metaPage: number; metaPageCount: number; records: number }[];
  logical: Logical[];
  danglingLinks: number;
  cardKeyOfSerial: Map<string, string>;
  byCardKey: Map<string, Logical>;
  cards: Rec[];
  inputs: { file: string; sha256: string }[];
}

const inputRecord = (ctx: Ctx, file: string): void => {
  if (!ctx.inputs.some((i) => i.file === file)) ctx.inputs.push({ file, sha256: sha256(readFileSync(file)) });
};

function newestDatedDir(root: string): string {
  const names = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort(codePointCompare);
  const newest = names.at(-1);
  if (newest === undefined) throw new Error(`no dated originals directory under ${root}`);
  return path.join(root, newest);
}

function loadRaw(originalsDir: string, p: ReturnType<typeof progress>): Pick<Ctx, "printings" | "manifestBytes" | "manifest" | "pageResults"> {
  const pagesDir = path.join(originalsDir, "swu-cards/raw-pages");
  const manifestBytes = readFileSync(path.join(pagesDir, "manifest.json"));
  const manifest = parseAt(manifestSchema, JSON.parse(manifestBytes.toString("utf8")), "raw-pages/manifest.json");
  const printings: Printing[] = [];
  const pageResults: Ctx["pageResults"] = [];
  for (const entry of [...manifest.pages].sort((a, b) => a.page - b.page)) {
    const file = `page-${String(entry.page).padStart(4, "0")}.json`;
    const body = readFileSync(path.join(pagesDir, file));
    const parsed = parseAt(pageSchema, JSON.parse(body.toString("utf8")), file);
    for (const record of parsed.data) {
      const attrs = record.attributes;
      const cells: Record<string, Cell> = {};
      for (const [key, value] of Object.entries(attrs)) {
        if (!isDropped(key)) cells[key] = reduceValue(key, value);
      }
      printings.push({
        serial: String(attrs.serialCode ?? ""),
        uid: attrs.cardUid === null || attrs.cardUid === undefined ? "" : String(attrs.cardUid),
        cells,
        rules: typeof attrs.rules === "string" ? attrs.rules : null,
        rulesStyled: typeof attrs.rulesStyled === "string" ? attrs.rulesStyled : null,
        page: entry.page,
      });
    }
    pageResults.push({
      page: entry.page,
      file,
      bytes: body.length,
      digest: sha256(body),
      total: parsed.meta.pagination.total,
      metaPage: parsed.meta.pagination.page,
      metaPageCount: parsed.meta.pagination.pageCount,
      records: parsed.data.length,
    });
    p.tick(pageResults.length, { phase: "load-raw-pages" });
  }
  return { printings, manifestBytes, manifest, pageResults };
}

const decodeTable = (file: string, name: string): Rec[] => {
  const table = decode(readText(file)) as Record<string, unknown>;
  const rows = table[name];
  if (!Array.isArray(rows)) throw new Error(`${file}: no "${name}" table`);
  return rows as Rec[];
};

// ---------------------------------------------------------------- check 1

function check1(ctx: Ctx): AuditCheck {
  const c = new Check("raw-pages", "Raw pages: sha256/byteLength vs manifest; record count = API total.", "page or assertion");
  const manifestPages = [...ctx.manifest.pages].sort((a, b) => a.page - b.page);
  const pagesDir = path.join(ctx.originalsDir, "swu-cards/raw-pages");
  const onDisk = readdirSync(pagesDir).filter((f) => /^page-\d+\.json$/.test(f)).sort(codePointCompare);
  const declared = ctx.pageResults[0]?.total ?? -1;
  c.universe = { pages: manifestPages.length, records: ctx.printings.length, apiTotal: declared };
  for (const [i, entry] of manifestPages.entries()) {
    const got = ctx.pageResults[i];
    c.expect(got.bytes === entry.byteLength, () => ({ id: got.file, field: "byteLength", expected: entry.byteLength, actual: got.bytes }));
    c.expect(got.digest === entry.sha256, () => ({ id: got.file, field: "sha256", expected: entry.sha256, actual: got.digest }));
    c.expect(entry.status === 200, () => ({ id: got.file, field: "status", expected: 200, actual: entry.status }));
    c.expect(got.metaPage === entry.page, () => ({ id: got.file, field: "meta.pagination.page", expected: entry.page, actual: got.metaPage }));
    c.expect(got.total === declared, () => ({ id: got.file, field: "meta.pagination.total", expected: declared, actual: got.total }));
    c.expect(got.metaPageCount === manifestPages.length, () => ({ id: got.file, field: "meta.pagination.pageCount", expected: manifestPages.length, actual: got.metaPageCount }));
  }
  c.expect(ctx.manifest.complete, () => ({ id: "manifest", field: "complete", expected: true, actual: ctx.manifest.complete }));
  c.expect(ctx.manifest.pageCount === manifestPages.length, () => ({ id: "manifest", field: "pageCount vs pages.length", expected: ctx.manifest.pageCount, actual: manifestPages.length }));
  c.expect(manifestPages.every((e, i) => e.page === i + 1), () => ({ id: "manifest", field: "page numbers contiguous 1..n" }));
  c.expect(same(onDisk, manifestPages.map((e) => `page-${String(e.page).padStart(4, "0")}.json`)), () => ({ id: "raw-pages dir", field: "files vs manifest", actual: clip(onDisk) }));
  c.expect(ctx.printings.length === declared, () => ({ id: "records", field: "sum of page records vs API total", expected: declared, actual: ctx.printings.length }));
  c.expect(declared === 10246, () => ({ id: "records", field: "API total vs issue's 10,246", expected: 10246, actual: declared }));
  c.expect(new Set(ctx.printings.map((p) => p.serial)).size === ctx.printings.length, () => ({ id: "records", field: "serialCode unique" }));
  c.expect(ctx.printings.every((p) => p.serial !== ""), () => ({ id: "records", field: "serialCode present" }));
  const replayFile = path.join(ctx.runDir, "replay.json");
  const replay = readJson(replayFile, replaySchema);
  inputRecord(ctx, replayFile);
  c.expect(replay.inputs.rawManifestSha256 === sha256(ctx.manifestBytes), () => ({ id: "replay.json", field: "inputs.rawManifestSha256", expected: sha256(ctx.manifestBytes), actual: replay.inputs.rawManifestSha256 }));
  c.expect(same(replay.inputs.pages, manifestPages.map((e) => e.sha256)), () => ({ id: "replay.json", field: "inputs.pages vs manifest page hashes" }));
  return c;
}

// ---------------------------------------------------------------- check 2

function check2(ctx: Ctx): AuditCheck {
  const c = new Check("folding", "Folding: each printing in exactly one logical card; canonical follows the rule; JTL+ filter exact.", "assertion");
  const kept = ctx.logical.filter((l) => l.kept);
  c.universe = { printings: ctx.printings.length, logicalCards: ctx.logical.length, keptByAudit: kept.length, cardsToon: ctx.cards.length, danglingLinks: ctx.danglingLinks };

  const seen = new Map<string, number>();
  for (const l of ctx.logical) for (const m of l.members) seen.set(m.serial, (seen.get(m.serial) ?? 0) + 1);
  for (const p of ctx.printings) {
    c.expect(seen.get(p.serial) === 1, () => ({ id: p.serial, field: "components containing printing", expected: 1, actual: seen.get(p.serial) ?? 0 }));
  }
  for (const l of ctx.logical) {
    const beats = (a: Printing, b: Printing): boolean => earlierFirst(a, b) < 0;
    const hasUnlinked = l.members.some((m) => cellStr(m, "variantOf") === "" && cellStr(m, "reprintOf") === "");
    const canonLinked = cellStr(l.canonical, "variantOf") !== "" || cellStr(l.canonical, "reprintOf") !== "";
    const better = l.eligible.find((m) => m !== l.canonical && beats(m, l.canonical));
    c.expect(!(hasUnlinked && canonLinked) && better === undefined, () => ({ id: l.cardKey, field: "canonical rule", members: l.members.map((m) => m.serial), better: better?.serial }));
  }
  let tableMismatch = 0;
  for (const p of ctx.printings) {
    const code = expansionOf(p);
    if (SET_ORDER[code] !== undefined && Number(p.serial.slice(0, 2)) !== SET_ORDER[code]) tableMismatch += 1;
  }
  c.expect(tableMismatch === 0, () => ({ id: "set order table", field: "serial prefix vs release order", actual: `${tableMismatch} printings disagree` }));

  const toonKeys = new Set(ctx.cards.map((r) => String(r.cardKey)));
  const keptKeys = new Set(kept.map((l) => l.cardKey));
  for (const l of kept) c.expect(toonKeys.has(l.cardKey), () => ({ id: l.cardKey, field: "kept card missing from cards.toon", sets: l.sets }));
  for (const key of toonKeys) {
    const logical = ctx.byCardKey.get(key);
    c.expect(keptKeys.has(key), () => ({ id: key, field: "cards.toon card not kept by the JTL+/Weekly Play rule", sets: logical?.sets, isLogicalCardKey: logical !== undefined }));
  }
  c.expect(ctx.cards.length === kept.length, () => ({ id: "cards.toon", field: "card count", expected: kept.length, actual: ctx.cards.length }));
  c.expect(ctx.cards.every((r, i) => i === 0 || codePointCompare(String(ctx.cards[i - 1].cardKey), String(r.cardKey)) < 0), () => ({ id: "cards.toon", field: "sorted by cardKey" }));

  for (const row of ctx.cards) {
    const key = String(row.cardKey);
    const l = ctx.byCardKey.get(key);
    if (l === undefined) continue;
    c.expect(row.printingCount === l.members.length, () => ({ id: key, field: "printingCount", expected: l.members.length, actual: row.printingCount }));
    c.expect(row.sets === l.sets.join("|"), () => ({ id: key, field: "sets", expected: l.sets.join("|"), actual: row.sets }));
    c.expect(row.firstSet === l.firstSet, () => ({ id: key, field: "firstSet", expected: l.firstSet, actual: row.firstSet }));
    c.expect(row.variants === l.variants.join("|"), () => ({ id: key, field: "variants", expected: l.variants.join("|"), actual: row.variants }));
  }

  const excludedWithWeeklyPlay = ctx.logical.filter((l) => !l.kept && l.members.some((m) => split(m.cells.variantTypes).some((v) => v.startsWith("Weekly Play"))));
  c.notes.push(
    `${excludedWithWeeklyPlay.length} excluded cards carry a printing whose variantTypes include "Weekly Play" but whose expansion is a year-1 set (SOR/SHD/TWI). The filter counts "<set>P" codes as Weekly Play, not the variant name; the issue's literal wording ("a JTL+ or Weekly Play printing") would keep them. Examples: ${excludedWithWeeklyPlay.slice(0, 5).map((l) => `${l.cardKey} ${String(l.canonical.cells.title)} [${l.sets.join("|")}]`).join("; ")}`,
  );
  c.notes.push(`${ctx.danglingLinks} variantOf/reprintOf links name a serialCode absent from the raw pages.`);
  c.notes.push(`${ctx.logical.filter((l) => l.eligible.length !== 1).length} components have zero or several unlinked printings (canonical chosen among the eligible pool).`);
  return c;
}

// ---------------------------------------------------------------- check 3

function check3(ctx: Ctx): AuditCheck {
  const c = new Check("cards-fields", "cards.toon fields equal the canonical raw printing's attributes, field by field.", "column or card x field");
  const derived = new Set(["cardKey", "sets", "firstSet", "printingCount", "variants", "priceNormal", "priceFoil"]);
  const perPrintingOnly = new Set(["serialCode", "variantTypes", "variantOf", "reprintOf"]);
  c.universe = { cards: ctx.cards.length };
  const expectedColumns = new Set<string>(derived);
  for (const row of ctx.cards) {
    const l = ctx.byCardKey.get(String(row.cardKey));
    if (l === undefined) continue;
    for (const key of Object.keys(l.canonical.cells)) if (!perPrintingOnly.has(key)) expectedColumns.add(key);
  }
  const actualColumns = new Set(ctx.cards.flatMap((r) => Object.keys(r)));
  for (const col of expectedColumns) c.expect(actualColumns.has(col), () => ({ id: "cards.toon header", field: col, note: "raw attribute missing from the table" }));
  for (const col of actualColumns) c.expect(expectedColumns.has(col), () => ({ id: "cards.toon header", field: col, note: "column with no raw source" }));
  for (const row of ctx.cards) {
    const key = String(row.cardKey);
    const l = ctx.byCardKey.get(key);
    if (l === undefined) {
      c.expect(false, () => ({ id: key, field: "cardKey", note: "no logical card with this key in the raw pages" }));
      continue;
    }
    const raw = l.canonical.cells;
    for (const col of actualColumns) {
      if (derived.has(col)) continue;
      const expected = raw[col] ?? null;
      const actual = row[col] === undefined ? null : row[col];
      c.expect(expected === actual, () => ({ id: key, field: col, expected: clip(expected), actual: clip(actual) }));
    }
  }
  return c;
}

// ---------------------------------------------------------------- check 4

function check4(ctx: Ctx): AuditCheck {
  const c = new Check("prices", "Prices: cards.toon and market/prices.json equal the tcg_printings rows in the originals.", "row, card or assertion");
  const pricesDir = path.join(ctx.originalsDir, "tcgplayer-prices");
  const rows = readJson(path.join(pricesDir, "printings.json"), z.array(priceRowSchema));
  const importRow = readJson(path.join(pricesDir, "price-import.json"), priceImportSchema);
  const prices = readJson(path.join(ctx.runDir, "market/prices.json"), pricesFileSchema);
  for (const f of [path.join(pricesDir, "printings.json"), path.join(pricesDir, "price-import.json"), path.join(ctx.runDir, "market/prices.json")]) inputRecord(ctx, f);
  c.universe = { priceRows: rows.length, pricesJsonCards: prices.cards.length, cardsToon: ctx.cards.length };

  const byCard = new Map<string, typeof rows>();
  let unmapped = 0;
  for (const row of rows) {
    const key = ctx.cardKeyOfSerial.get(row.card_id);
    if (key === undefined) {
      unmapped += 1;
      c.expect(false, () => ({ id: row.card_id, field: "card_id", note: "price row names no raw printing", variant: row.variant }));
      continue;
    }
    byCard.set(key, [...(byCard.get(key) ?? []), row]);
  }
  c.expect(unmapped === 0, () => ({ id: "price rows", field: "unmapped", actual: unmapped }));
  c.expect(prices.priceImportId === importRow.id, () => ({ id: "prices.json", field: "priceImportId", expected: importRow.id, actual: prices.priceImportId }));
  c.expect(prices.priceImportFinishedAt === importRow.finished_at, () => ({ id: "prices.json", field: "priceImportFinishedAt", expected: importRow.finished_at, actual: prices.priceImportFinishedAt }));

  const pricedCards = new Map(prices.cards.map((card) => [card.cardKey, card]));
  c.expect(pricedCards.size === prices.cards.length, () => ({ id: "prices.json", field: "cardKey unique" }));
  c.expect(pricedCards.size === byCard.size, () => ({ id: "prices.json", field: "card count", expected: byCard.size, actual: pricedCards.size }));
  const priceCells = (cardKey: string): { normal: number | null; foil: number | null } => {
    const own = [...(byCard.get(cardKey) ?? [])].filter((r) => r.card_id === cardKey).sort((a, b) => a.product_id - b.product_id);
    return { normal: own.find((r) => r.price_normal !== null)?.price_normal ?? null, foil: own.find((r) => r.price_foil !== null)?.price_foil ?? null };
  };
  for (const [key, own] of byCard) {
    const got = pricedCards.get(key);
    c.expect(got !== undefined, () => ({ id: key, field: "prices.json card", note: "missing", rows: own.length }));
    if (got === undefined) continue;
    const expectedCells = priceCells(key);
    c.expect(got.normal === expectedCells.normal, () => ({ id: key, field: "prices.json normal", expected: expectedCells.normal, actual: got.normal }));
    c.expect(got.foil === expectedCells.foil, () => ({ id: key, field: "prices.json foil", expected: expectedCells.foil, actual: got.foil }));
    c.expect(got.printings.length === own.length, () => ({ id: key, field: "prices.json printings", expected: own.length, actual: got.printings.length }));
    const gotRows = new Map(got.printings.map((g) => [`${g.cardId}\t${g.variant}\t${g.productId}`, g]));
    for (const row of own) {
      const g = gotRows.get(`${row.card_id}\t${row.variant}\t${row.product_id}`);
      const ok = g !== undefined && g.normal === row.price_normal && g.foil === row.price_foil && g.priceSource === row.price_source && g.conformance === row.conformance;
      c.expect(ok, () => ({ id: `${row.card_id}/${row.variant}/${row.product_id}`, field: "prices.json printing row", expected: { normal: row.price_normal, foil: row.price_foil, source: row.price_source, conformance: row.conformance }, actual: g }));
    }
  }
  for (const key of pricedCards.keys()) c.expect(byCard.has(key), () => ({ id: key, field: "prices.json card", note: "has no price rows in the originals" }));

  for (const row of ctx.cards) {
    const key = String(row.cardKey);
    const expectedCells = priceCells(key);
    c.expect(row.priceNormal === expectedCells.normal, () => ({ id: key, field: "cards.toon priceNormal", expected: expectedCells.normal, actual: row.priceNormal }));
    c.expect(row.priceFoil === expectedCells.foil, () => ({ id: key, field: "cards.toon priceFoil", expected: expectedCells.foil, actual: row.priceFoil }));
  }

  const tsvPath = path.join(ctx.pinnedDir, "tcg-prices-import43.tsv");
  const tsv = readText(tsvPath).split("\n").filter((l) => l !== "");
  inputRecord(ctx, tsvPath);
  const numberOrNull = (s: string | undefined): number | null => (s === undefined || s === "" ? null : Number(s));
  const tsvCount = new Map<string, number>();
  for (const line of tsv) {
    const [cardId, variant, normal, foil, source, conformance] = line.split("\t");
    const k = JSON.stringify([cardId, variant, numberOrNull(normal), numberOrNull(foil), source ?? "", conformance ?? ""]);
    tsvCount.set(k, (tsvCount.get(k) ?? 0) + 1);
  }
  c.expect(tsv.length === rows.length, () => ({ id: "tcg-prices-import43.tsv", field: "row count vs printings.json", expected: rows.length, actual: tsv.length }));
  for (const row of rows) {
    const k = JSON.stringify([row.card_id, row.variant, row.price_normal, row.price_foil, row.price_source ?? "", row.conformance ?? ""]);
    const left = tsvCount.get(k) ?? 0;
    c.expect(left > 0, () => ({ id: `${row.card_id}/${row.variant}`, field: "printings.json row vs pinned TSV", expected: k }));
    if (left > 0) tsvCount.set(k, left - 1);
  }

  const siblingOnly = ctx.cards.filter((r) => {
    const l = ctx.byCardKey.get(String(r.cardKey));
    if (l === undefined || r.priceNormal !== null) return false;
    const members = new Set(l.members.map((m) => m.serial));
    return (byCard.get(l.cardKey) ?? []).some((x) => members.has(x.card_id) && x.price_normal !== null);
  });
  c.notes.push(`${siblingOnly.length} kept cards show priceNormal null although a sibling printing has a normal price (the canonical printing's own rows alone set the card price). Examples: ${siblingOnly.slice(0, 5).map((r) => `${r.cardKey} ${String(r.title)}`).join("; ")}`);
  return c;
}

// ---------------------------------------------------------------- check 5

function check5(ctx: Ctx): AuditCheck {
  const c = new Check("indexes", "Indexes: every facet index's membership and counts equal a recomputation from cards.toon.", "index row or assertion");
  const facetValues: Record<string, (r: Rec) => string[]> = {
    aspect: (r) => split(r.aspects),
    trait: (r) => split(r.traits),
    keyword: (r) => split(r.keywords),
    type: (r) => [...split(r.type), ...split(r.type2)],
    arena: (r) => split(r.arenas),
    rarity: (r) => split(r.rarity),
    expansion: (r) => split(r.sets),
    variant: (r) => split(r.variants),
  };
  c.universe = { cards: ctx.cards.length };
  for (const [facet, valuesOf] of Object.entries(facetValues)) {
    const file = path.join(ctx.runDir, `llm/index/${facet}.toon`);
    inputRecord(ctx, file);
    const rows = decodeTable(file, facet);
    const expected = new Map<string, Set<string>>();
    for (const r of ctx.cards) for (const v of valuesOf(r)) expected.set(v, (expected.get(v) ?? new Set()).add(String(r.cardKey)));
    c.universe[`${facet}Values`] = expected.size;
    const got = new Map(rows.map((row) => [String(row.value), row]));
    c.expect(got.size === rows.length, () => ({ id: facet, field: "value unique" }));
    c.expect(rows.every((row, i) => i === 0 || codePointCompare(String(rows[i - 1].value), String(row.value)) < 0), () => ({ id: facet, field: "rows sorted by value" }));
    for (const [value, keys] of expected) {
      const row = got.get(value);
      const wantKeys = [...keys].sort(codePointCompare);
      c.expect(row !== undefined, () => ({ id: `${facet}:${value}`, field: "index row", note: "missing", cards: wantKeys.length }));
      if (row === undefined) continue;
      c.expect(row.cards === wantKeys.length, () => ({ id: `${facet}:${value}`, field: "cards", expected: wantKeys.length, actual: row.cards }));
      c.expect(row.cardKeys === wantKeys.join("|"), () => ({ id: `${facet}:${value}`, field: "cardKeys", expected: clip(wantKeys.join("|")), actual: clip(row.cardKeys) }));
    }
    for (const value of got.keys()) c.expect(expected.has(value), () => ({ id: `${facet}:${value}`, field: "index row", note: "no card in cards.toon carries this value" }));
  }
  const nameFile = path.join(ctx.runDir, "llm/index/names.toon");
  inputRecord(ctx, nameFile);
  const nameRows = decodeTable(nameFile, "names");
  const expectedNames = new Map<string, { title: string; subtitle: string; keys: string[] }>();
  for (const r of ctx.cards) {
    const title = typeof r.title === "string" ? r.title : "";
    const subtitle = typeof r.subtitle === "string" ? r.subtitle : "";
    const id = JSON.stringify([title, subtitle]);
    const entry = expectedNames.get(id) ?? { title, subtitle, keys: [] };
    entry.keys.push(String(r.cardKey));
    expectedNames.set(id, entry);
  }
  const gotNames = new Map(nameRows.map((row) => [JSON.stringify([String(row.title ?? ""), typeof row.subtitle === "string" ? row.subtitle : ""]), row]));
  c.expect(gotNames.size === nameRows.length, () => ({ id: "names", field: "(title, subtitle) unique" }));
  for (const [id, entry] of expectedNames) {
    const row = gotNames.get(id);
    const want = [...entry.keys].sort(codePointCompare).join("|");
    c.expect(row !== undefined && row.cardKeys === want, () => ({ id: `names:${id}`, field: "cardKeys", expected: want, actual: row?.cardKeys }));
  }
  for (const id of gotNames.keys()) c.expect(expectedNames.has(id), () => ({ id: `names:${id}`, field: "name row", note: "no card carries this title/subtitle" }));
  return c;
}

// ---------------------------------------------------------------- check 6

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&rsquo;": "’", "&lsquo;": "‘", "&ldquo;": "“", "&rdquo;": "”" };

function stripTags(html: string): string {
  return html
    .replace(/<img\b[^>]*\bsrc="([^"]*)"[^>]*>/g, (_m, src: string) => {
      const name = /icon_([a-z]+)/.exec(src.split("/").at(-1) ?? "")?.[1] ?? "icon";
      return name === "unique" ? "<uq>" : `<${name}>`;
    })
    .replace(/<\/?(?:p|br|strong|b|i|em|span|a|figure|table|tbody|thead|td|tr)\b[^>]*>/g, "")
    .replace(/&(?:nbsp|amp|lt|gt|quot|rsquo|lsquo|ldquo|rdquo|#39);/g, (e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim();
}

/** M/D/YYYY (or MM/DD/YYYY) -> YYYY-MM-DD. */
function isoOf(raw: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  return m === null ? null : `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

interface DatedRuling {
  date: string | null;
  source: "rulesStyled" | "rules";
  text: string;
}

/** Whitespace and quote-style folding used to match a plain `rules` line to a styled ruling. */
const foldText = (t: string): string => t.replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"').replace(/\s+/g, " ").trim();

const plainLinesOf = (rules: string | null): string[] => (rules ?? "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l !== "");

function compareRulingOrder(a: DatedRuling, b: DatedRuling): number {
  if (a.date === null || b.date === null) return a.date === null && b.date === null ? codePointCompare(a.text, b.text) : a.date === null ? 1 : -1;
  return codePointCompare(b.date, a.date) || codePointCompare(a.text, b.text);
}

function rawRulings(html: string): DatedRuling[] | null {
  const out: DatedRuling[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length !== 2) return null;
    const date = isoOf(stripTags(cells[0]));
    if (date === null) return null;
    out.push({ date, source: "rulesStyled", text: stripTags(cells[1]) });
  }
  return out;
}

function check6(ctx: Ctx): AuditCheck {
  const c = new Check("rulings", "Rulings: card-rulings equal the raw rules/rulesStyled fields (dated styled rows, plus undated plain lines with no styled match); no plain rules line is dropped.", "card or assertion");
  const file = path.join(ctx.runDir, "rules/card-rulings.json");
  inputRecord(ctx, file);
  const prod = readJson(file, rulingsFileSchema);
  const styledByCard = new Map<string, Map<string, DatedRuling>>();
  const printingsWith = new Set<string>();
  let rulingRows = 0;
  const plainFields = new Set<string>();
  let unparseable = 0;
  let plainDisagree = 0;
  const plainExamples: Rec[] = [];
  for (const p of ctx.printings) {
    const key = ctx.cardKeyOfSerial.get(p.serial) as string;
    if (p.rulesStyled === null || !p.rulesStyled.includes("<tr")) continue;
    const parsed = rawRulings(p.rulesStyled);
    if (parsed === null) {
      unparseable += 1;
      c.expect(false, () => ({ id: p.serial, field: "rulesStyled", note: "rows are not (date, text) pairs", html: clip(p.rulesStyled) }));
      continue;
    }
    if (parsed.length === 0) continue;
    printingsWith.add(p.serial);
    const plainLines = plainLinesOf(p.rules);
    if (!same(plainLines, parsed.map((r) => r.text))) {
      plainDisagree += 1;
      if (plainExamples.length < 3) plainExamples.push({ serial: p.serial, styled: parsed.map((r) => r.text), plain: plainLines });
    }
    const bucket = styledByCard.get(key) ?? new Map<string, DatedRuling>();
    styledByCard.set(key, bucket);
    for (const r of parsed) {
      rulingRows += 1;
      bucket.set(`${r.date}\u0000${r.text}`, r);
    }
  }
  const perCard = new Map<string, Map<string, DatedRuling>>();
  for (const [key, bucket] of styledByCard) perCard.set(key, new Map(bucket));
  let undatedLines = 0;
  for (const p of ctx.printings) {
    const key = ctx.cardKeyOfSerial.get(p.serial) as string;
    const styledFolded = new Set([...(styledByCard.get(key)?.values() ?? [])].map((r) => foldText(r.text)));
    for (const line of plainLinesOf(p.rules)) {
      printingsWith.add(p.serial);
      if (p.rules !== null) plainFields.add(p.rules);
      if (styledFolded.has(foldText(line))) continue;
      undatedLines += 1;
      rulingRows += 1;
      const bucket = perCard.get(key) ?? new Map<string, DatedRuling>();
      perCard.set(key, bucket);
      const k = `\u0000undated\u0000${foldText(line)}`;
      if (!bucket.has(k)) bucket.set(k, { date: null, source: "rules", text: line });
    }
  }
  c.universe = { printingsWithRulings: printingsWith.size, cardsWithRulings: perCard.size, rulingRows, undatedPlainLines: undatedLines, productionCards: prod.cards.length };
  const gotCards = new Map(prod.cards.map((card) => [card.cardKey, card]));
  c.expect(gotCards.size === prod.cards.length, () => ({ id: "card-rulings.json", field: "cardKey unique" }));
  c.expect(gotCards.size === perCard.size, () => ({ id: "card-rulings.json", field: "card count", expected: perCard.size, actual: gotCards.size }));
  c.expect(prod.source.rawPagesManifestSha256 === sha256(ctx.manifestBytes), () => ({ id: "card-rulings.json", field: "source.rawPagesManifestSha256", expected: sha256(ctx.manifestBytes), actual: prod.source.rawPagesManifestSha256 }));
  const distinctDated = new Set<string>();
  const distinctUndated = new Set<string>();
  const distinctTexts = new Set<string>();
  for (const [key, bucket] of perCard) {
    for (const [k, r] of bucket) {
      if (r.date === null) distinctUndated.add(`${key}${k}`);
      else distinctDated.add(k);
      distinctTexts.add(r.text);
    }
  }
  const statsWant = { printingsWithRulings: printingsWith.size, logicalCardsWithRulings: perCard.size, distinctRulesFields: plainFields.size, distinctRulingTexts: distinctTexts.size, distinctDatedRulings: distinctDated.size, distinctUndatedRulings: distinctUndated.size, rulingRows };
  for (const [field, want] of Object.entries(statsWant)) {
    c.expect((prod.stats as Rec)[field] === want, () => ({ id: "card-rulings.json stats", field, expected: want, actual: (prod.stats as Rec)[field] }));
  }
  for (const [key, bucket] of perCard) {
    const got = gotCards.get(key);
    const l = ctx.byCardKey.get(key) as Logical;
    const want = [...bucket.values()].sort(compareRulingOrder);
    c.expect(got !== undefined, () => ({ id: key, field: "card-rulings entry", note: "missing", rulings: want.length }));
    if (got === undefined) continue;
    c.expect(same(got.rulings.map((r) => ({ date: r.date, source: r.source, text: r.text })), want), () => ({ id: key, title: got.title, field: "rulings (date, source, text, order)", expected: clip(want), actual: clip(got.rulings) }));
    const subtitle = typeof l.canonical.cells.subtitle === "string" && l.canonical.cells.subtitle !== "" ? l.canonical.cells.subtitle : null;
    c.expect(got.title === String(l.canonical.cells.title ?? "") && got.subtitle === subtitle, () => ({ id: key, field: "title/subtitle", expected: [l.canonical.cells.title, subtitle], actual: [got.title, got.subtitle] }));
    c.expect(got.printings === l.members.length, () => ({ id: key, field: "printings", expected: l.members.length, actual: got.printings }));
  }
  for (const key of gotCards.keys()) c.expect(perCard.has(key), () => ({ id: key, field: "card-rulings entry", note: "no raw printing of this card has rulings" }));
  // No silent drops: every plain line of every printing must be present in its card's shipped rulings.
  let plainLinesChecked = 0;
  for (const p of ctx.printings) {
    const key = ctx.cardKeyOfSerial.get(p.serial) as string;
    const shipped = new Set((gotCards.get(key)?.rulings ?? []).map((r) => foldText(r.text)));
    for (const line of plainLinesOf(p.rules)) {
      plainLinesChecked += 1;
      c.expect(shipped.has(foldText(line)), () => ({ id: p.serial, card: key, field: "plain rules line", note: "not in card-rulings.json", line }));
    }
  }
  c.notes.push(`${plainLinesChecked} plain \`rules\` lines checked; each lands in card-rulings.json (${undatedLines} as undated rulings with date null and source "rules", the rest matched a dated styled ruling).`);
  c.notes.push(`${plainDisagree} printings have a plain \`rules\` field that differs from their styled table (second witness; counted, not failed). Examples: ${JSON.stringify(plainExamples)}`);
  c.notes.push(`${unparseable} printings had a rulesStyled table the audit's own parser could not read.`);
  return c;
}

// ---------------------------------------------------------------- check 7

function check7(ctx: Ctx): AuditCheck {
  const c = new Check("play-stats", "Play stats: market/play.json equals the pinned SWU Stats capture rows.", "window, card or cell");
  const playFile = path.join(ctx.runDir, "market/play.json");
  inputRecord(ctx, playFile);
  const play = readJson(playFile, playFileSchema);
  const uidToKeys = new Map<string, Set<string>>();
  for (const p of ctx.printings) {
    if (p.uid === "") continue;
    uidToKeys.set(p.uid, (uidToKeys.get(p.uid) ?? new Set()).add(ctx.cardKeyOfSerial.get(p.serial) as string));
  }
  const leaders = new Set(ctx.logical.filter((l) => l.canonical.cells.type === "Leader").map((l) => l.cardKey));
  const files = readdirSync(ctx.pinnedDir).filter((f) => /^swustats-premier-w\d+-\d+\.json$/.test(f)).sort(codePointCompare);
  c.universe = { captureFiles: files.length, windows: play.windows.length, playCards: play.cards.length, leaders: leaders.size };
  c.expect(files.length === play.windows.length, () => ({ id: "play.json", field: "window count", expected: files.length, actual: play.windows.length }));
  const dayMs = 86_400_000;
  const base = Date.parse("2025-09-20T00:00:00Z");
  const isoDay = (offset: number): string => new Date(base + offset * dayMs).toISOString().slice(0, 10);
  const expectedCells = new Map<string, { included: number; wins: number }>();
  for (const f of files) {
    const m = /^swustats-premier-(w(\d+)-(\d+))\.json$/.exec(f) as RegExpExecArray;
    const [id, start, end] = [m[1], Number(m[2]), Number(m[3])];
    const bytes = readFileSync(path.join(ctx.pinnedDir, f));
    inputRecord(ctx, path.join(ctx.pinnedDir, f));
    const rows = parseAt(captureSchema, JSON.parse(bytes.toString("utf8")), f);
    const win = play.windows.find((w) => w.id === id);
    c.expect(win !== undefined, () => ({ id, field: "window", note: "missing from play.json" }));
    let playerGames = 0;
    for (const row of rows) {
      const keys = uidToKeys.get(String(row.cardUid));
      c.expect(keys !== undefined && keys.size === 1, () => ({ id: `${f}:${row.cardUid}`, field: "cardUid -> logical card", actual: keys === undefined ? "no raw printing" : [...keys] }));
      if (keys === undefined || keys.size !== 1) continue;
      const key = [...keys][0];
      const cell = expectedCells.get(`${key}\u0000${id}`) ?? { included: 0, wins: 0 };
      cell.included += row.timesIncluded;
      cell.wins += row.timesIncludedInWins;
      expectedCells.set(`${key}\u0000${id}`, cell);
      if (leaders.has(key)) playerGames += row.timesIncluded;
    }
    if (win === undefined) continue;
    c.expect(win.sha256 === sha256(bytes), () => ({ id, field: "window sha256", expected: sha256(bytes), actual: win.sha256 }));
    c.expect(win.playerGames === playerGames, () => ({ id, field: "playerGames (sum of leader inclusions)", expected: playerGames, actual: win.playerGames }));
    c.expect(win.startWeek === start && win.endWeek === end, () => ({ id, field: "weeks", expected: [start, end], actual: [win.startWeek, win.endWeek] }));
    c.expect(win.startDate === isoDay(7 * start) && win.endDate === isoDay(7 * end + 6), () => ({ id, field: "dates", expected: [isoDay(7 * start), isoDay(7 * end + 6)], actual: [win.startDate, win.endDate] }));
  }
  const gotCells = new Map<string, { included: number; wins: number }>();
  for (const card of play.cards) for (const [id, cell] of Object.entries(card.byWindow)) gotCells.set(`${card.cardKey}\u0000${id}`, cell);
  c.expect(new Set(play.cards.map((x) => x.cardKey)).size === play.cards.length, () => ({ id: "play.json", field: "cardKey unique" }));
  for (const [k, want] of expectedCells) {
    const got = gotCells.get(k);
    c.expect(got !== undefined && got.included === want.included && got.wins === want.wins, () => ({ id: k.replace("\u0000", " @ "), field: "included/wins", expected: want, actual: got }));
  }
  for (const k of gotCells.keys()) c.expect(expectedCells.has(k), () => ({ id: k.replace("\u0000", " @ "), field: "cell", note: "no capture row feeds this cell" }));
  const sum = (cells: Iterable<{ included: number; wins: number }>): number[] => {
    let included = 0;
    let wins = 0;
    for (const x of cells) {
      included += x.included;
      wins += x.wins;
    }
    return [included, wins];
  };
  c.expect(same(sum(expectedCells.values()), sum(gotCells.values())), () => ({ id: "play.json", field: "total included/wins", expected: sum(expectedCells.values()), actual: sum(gotCells.values()) }));
  return c;
}

// ---------------------------------------------------------------- check 8

function check8(ctx: Ctx): AuditCheck {
  const c = new Check("glossary", "Glossary: every facet value in the data has an entry; no orphans.", "facet value or assertion");
  const file = path.join(ctx.runDir, "docs/swu-glossary.json");
  inputRecord(ctx, file);
  const glossary = readJson(file, glossarySchema);
  const facetOf: Record<string, (cells: Record<string, Cell>) => string[]> = {
    aspect: (x) => split(x.aspects),
    trait: (x) => split(x.traits),
    keyword: (x) => split(x.keywords),
    type: (x) => [...split(x.type), ...split(x.type2)],
    arena: (x) => split(x.arenas),
    rarity: (x) => split(x.rarity),
    expansion: (x) => split(x.expansion),
    variant: (x) => split(x.variantTypes),
  };
  const keptFacet: Record<string, (r: Rec) => string[]> = {
    aspect: (r) => split(r.aspects),
    trait: (r) => split(r.traits),
    keyword: (r) => split(r.keywords),
    type: (r) => [...split(r.type), ...split(r.type2)],
    arena: (r) => split(r.arenas),
    rarity: (r) => split(r.rarity),
    expansion: (r) => split(r.sets),
    variant: (r) => split(r.variants),
  };
  c.universe = {};
  for (const [facet, valuesOf] of Object.entries(facetOf)) {
    const entries = glossary.facets[facet] ?? [];
    const entryByValue = new Map(entries.map((e) => [e.value, e]));
    c.expect(entryByValue.size === entries.length, () => ({ id: facet, field: "glossary values unique" }));
    const inRaw = new Set(ctx.printings.flatMap((p) => valuesOf(p.cells)));
    const inKept = new Set(ctx.cards.flatMap((r) => keptFacet[facet](r)));
    c.universe[`${facet}InRaw`] = inRaw.size;
    for (const v of inRaw) {
      const e = entryByValue.get(v);
      c.expect(e !== undefined && typeof e.definition === "string" && e.definition !== "", () => ({ id: `${facet}:${v}`, field: "glossary entry", note: e === undefined ? "missing" : "empty definition", inKeptCards: inKept.has(v) }));
    }
    for (const v of inKept) c.expect(inRaw.has(v), () => ({ id: `${facet}:${v}`, field: "kept-card value", note: "absent from raw printings" }));
    for (const e of entries) c.expect(inRaw.has(e.value), () => ({ id: `${facet}:${e.value}`, field: "glossary entry", note: "orphan: no raw printing carries this value" }));
  }
  const isToken = (cells: Record<string, Cell>): boolean => [...split(cells.type), ...split(cells.type2)].some((t) => t.includes("Token"));
  const tokenTitles = new Set(ctx.printings.filter((p) => isToken(p.cells)).map((p) => String(p.cells.title ?? "")));
  const tokenEntries = glossary.facets.token ?? [];
  c.universe.tokenTitlesInRaw = tokenTitles.size;
  for (const t of tokenTitles) c.expect(tokenEntries.some((e) => e.value === t), () => ({ id: `token:${t}`, field: "glossary entry", note: "missing" }));
  for (const e of tokenEntries) c.expect(tokenTitles.has(e.value), () => ({ id: `token:${e.value}`, field: "glossary entry", note: "orphan: no raw Token-type printing has this title" }));
  c.expect(Object.keys(glossary.facets).every((f) => f === "token" || f in facetOf), () => ({ id: "glossary", field: "facet names", actual: Object.keys(glossary.facets) }));

  for (const facet of Object.keys(facetOf)) {
    const rows = decodeTable(path.join(ctx.runDir, `llm/index/${facet}.toon`), facet);
    const entryByValue = new Map((glossary.facets[facet] ?? []).map((e) => [e.value, e.definition ?? ""]));
    for (const row of rows) {
      const want = entryByValue.get(String(row.value)) ?? "";
      c.expect(row.definition === want, () => ({ id: `${facet}:${row.value}`, field: "index definition vs glossary", expected: clip(want), actual: clip(row.definition) }));
    }
  }
  return c;
}

// ---------------------------------------------------------------- check 9

const squash = (s: string): string => s.replace(/[-]/g, "").replace(/\[icon\]/g, "").replace(/\s+/g, "");

function pdfBodyStream(pdfText: string): { stream: string; pages: number } {
  const pages = pdfText.split("\f");
  if (pages.at(-1)?.trim() === "") pages.pop();
  // The cover, introduction and contents pages carry an unnumbered footer; the body starts at the first "1. ..." footer.
  const kept: string[] = [];
  for (const page of pages) {
    const lines = page.split("\n");
    const footerAt = lines.findLastIndex((l) => /^\s*\d+\.\s+\S/.test(l) && l.includes("CONTENTS") && l.includes("GLOSSARY") && l.includes("StarWarsUnlimited.com"));
    if (footerAt < 0) continue;
    let skipping = false;
    for (const line of lines.slice(0, footerAt)) {
      if (/^\s*© & ™/.test(line)) skipping = true;
      if (line.trim() === "") {
        skipping = false;
        continue;
      }
      if (skipping) continue;
      kept.push(line.replace(/^\s*\d+\.\s+/, "").replace(/^\s*[a-z]\.\s+/, ""));
    }
  }
  return { stream: squash(kept.join("\n")), pages: pages.length };
}

function check9(ctx: Ctx): AuditCheck {
  const c = new Check("rules-sections", "Rules sections: section text in order reproduces the pdftotext body (modulo whitespace).", "section or assertion");
  const sectionsPath = path.join(ctx.runDir, "rules/sections.json");
  inputRecord(ctx, sectionsPath);
  const file = readJson(sectionsPath, sectionsFileSchema);
  const pdfDir = path.join(REPO_ROOT, "data/originals/rules", file.document.version);
  const pdfName = existsSync(pdfDir) ? readdirSync(pdfDir).find((f) => f.endsWith(".pdf")) : undefined;
  if (pdfName === undefined) {
    c.expect(false, () => ({ id: "pdf", field: "CR PDF", note: `no PDF under ${pdfDir}` }));
    return c;
  }
  const pdfPath = path.join(pdfDir, pdfName);
  const pdfBytes = readFileSync(pdfPath);
  inputRecord(ctx, pdfPath);
  c.expect(sha256(pdfBytes) === file.document.pdfSha256, () => ({ id: "pdf", field: "sha256", expected: file.document.pdfSha256, actual: sha256(pdfBytes) }));
  const tmp = path.join(REPO_ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TMPDIR: tmp } });
  const { stream, pages } = pdfBodyStream(text);
  c.universe = { sections: file.sections.length, pdfPages: pages, pdfBodyChars: stream.length };
  c.expect(file.document.pages === pages, () => ({ id: "document", field: "pages", expected: pages, actual: file.document.pages }));
  c.expect(file.stats.sections === file.sections.length, () => ({ id: "stats", field: "sections", expected: file.sections.length, actual: file.stats.sections }));
  const depthCounts = [0, 0, 0, 0];
  for (const s of file.sections) if (s.depth >= 0 && s.depth <= 3) depthCounts[s.depth] += 1;
  c.expect(same(file.stats.byDepth, depthCounts), () => ({ id: "stats", field: "byDepth", expected: depthCounts, actual: file.stats.byDepth }));

  const ids = new Set<string>();
  let lastPage = 0;
  const lastChild = new Map<string, number | string>();
  for (const s of file.sections) {
    const segs = s.id.split(".");
    const wantDepth = segs.length - 1;
    const wantParent = segs.length > 1 ? segs.slice(0, -1).join(".") : null;
    c.expect(!ids.has(s.id), () => ({ id: s.id, field: "id unique" }));
    c.expect(s.depth === wantDepth && s.parentId === wantParent, () => ({ id: s.id, field: "depth/parentId vs id", expected: [wantDepth, wantParent], actual: [s.depth, s.parentId] }));
    c.expect(wantParent === null || ids.has(wantParent), () => ({ id: s.id, field: "parent precedes child", parent: wantParent }));
    c.expect(s.page >= lastPage && s.page <= pages, () => ({ id: s.id, field: "page monotonic and within PDF", actual: s.page, previous: lastPage }));
    const last = segs.at(-1) as string;
    const prev = lastChild.get(wantParent ?? "");
    if (s.depth === 3) {
      c.expect(prev === undefined ? last === "a" : String.fromCharCode((prev as string).charCodeAt(0) + 1) === last, () => ({ id: s.id, field: "letter sequence", previous: prev }));
    } else {
      const n = Number(last);
      c.expect(Number.isInteger(n) && (prev === undefined ? n === 1 || (n === 0 && s.depth === 2) : n === (prev as number) + 1), () => ({ id: s.id, field: "number sequence", previous: prev }));
    }
    lastChild.set(wantParent ?? "", s.depth === 3 ? last : Number(last));
    ids.add(s.id);
    lastPage = s.page;
  }

  let cursor = 0;
  for (const s of file.sections) {
    const want = squash(`${s.title ?? ""}${s.text}`);
    if (stream.startsWith(want, cursor)) {
      c.expect(true, () => ({}));
      cursor += want.length;
      continue;
    }
    const at = want.length >= 20 ? stream.indexOf(want, cursor) : -1;
    const resync = at >= 0 && at - cursor < 5000;
    c.expect(false, () => ({
      id: s.id,
      field: "section text vs pdftotext body",
      page: s.page,
      expected: clip(want, 160),
      pdfAtCursor: stream.slice(cursor, cursor + 160),
      pdfTextSkippedBeforeSection: resync ? stream.slice(cursor, at).slice(0, 200) : null,
    }));
    if (resync) cursor = at + want.length;
  }
  const leftover = stream.length - cursor;
  c.expect(leftover === 0, () => ({ id: "pdf body", field: "text not covered by any section", chars: leftover, startsWith: stream.slice(cursor, cursor + 200) }));
  return c;
}

// ---------------------------------------------------------------- main

export function runAudit(options: { originalsDir: string; runDir: string; pinnedDir: string; date?: string }): { report: Rec; failed: number } {
  const p = progress("verify-audit", { total: 103 + 9, everyN: 10 });
  const raw = loadRaw(options.originalsDir, p);
  const { logical, danglingLinks } = foldPrintings(raw.printings);
  const cardKeyOfSerial = new Map<string, string>();
  for (const l of logical) for (const m of l.members) cardKeyOfSerial.set(m.serial, l.cardKey);
  const cardsFile = path.join(options.runDir, "llm/cards.toon");
  const ctx: Ctx = {
    ...options,
    date: options.date ?? raw.manifest.finishedAt.slice(0, 10),
    ...raw,
    logical,
    danglingLinks,
    cardKeyOfSerial,
    byCardKey: new Map(logical.map((l) => [l.cardKey, l])),
    cards: decodeTable(cardsFile, "cards"),
    inputs: [],
  };
  inputRecord(ctx, path.join(options.originalsDir, "swu-cards/raw-pages/manifest.json"));
  inputRecord(ctx, cardsFile);

  const checks: AuditCheck[] = [];
  for (const run of [check1, check2, check3, check4, check5, check6, check7, check8, check9]) {
    checks.push(run(ctx));
    p.tick(103 + checks.length, { phase: "checks", last: checks.at(-1)?.name });
  }
  const failed = checks.reduce((n, check) => n + check.failed, 0);
  const report = {
    schemaVersion: 1,
    date: ctx.date,
    inputs: [...ctx.inputs].sort((a, b) => codePointCompare(a.file, b.file)),
    summary: Object.fromEntries(checks.map((k) => [k.name, { checked: k.checked, passed: k.passed, failed: k.failed }])),
    checks: checks.map((k) => ({
      name: k.name,
      description: k.description,
      unit: k.unit,
      universe: k.universe,
      population: k.population,
      checked: k.checked,
      passed: k.passed,
      failed: k.failed,
      examples: k.examples,
      notes: k.notes,
    })),
    totalFailed: failed,
  };
  p.done({ failed });
  return { report, failed };
}

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, run: { type: "string" }, pinned: { type: "string" }, date: { type: "string" } } });
  const originalsDir = path.resolve(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT));
  const manifest = readJson(path.join(originalsDir, "swu-cards/raw-pages/manifest.json"), manifestSchema);
  const date = values.date ?? manifest.finishedAt.slice(0, 10);
  const runDir = path.resolve(values.run ?? path.join(REPO_ROOT, "data/runs", date));
  const pinnedDir = path.resolve(values.pinned ?? path.join(REPO_ROOT, "data/pinned/gt"));
  const { report, failed } = runAudit({ originalsDir, runDir, pinnedDir, date });
  const out = path.join(runDir, "verify/audit.json");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  for (const k of report.checks as AuditCheck[]) console.log(`${k.failed === 0 ? "PASS" : "FAIL"} ${k.name}: checked ${k.checked}, passed ${k.passed}, failed ${k.failed}`);
  console.log(`wrote ${out}`);
  if (failed > 0) process.exit(1);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
