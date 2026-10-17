/**
 * Builds the replayable Star Wars Unlimited data package (ported from mault
 * packages/server/scripts/export-swu-data-package.ts, LampaGJ/mault#323).
 *
 * Input is a mault originals folder (pinned): swu-cards/raw-pages/{page-NNNN.json,manifest.json},
 * swu-cards/catalogue-snapshots/*.json (optional) and
 * tcgplayer-prices/{price-import,printings,corrections,quarantine}.json.
 * Output goes to data/runs/<date>/ (kept: the MCP server reads llm/ from there). The zip for readers is
 * a separate step, `pnpm package:zip`.
 *
 * Usage: pnpm export:package [--originals <dir>] [--runs <dir>] [--date <YYYY-MM-DD>]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --runs       default: <repo>/data/runs
 *   --date       default: the day the raw card-list run finished
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { canonicalJson, compareCodePoints, sha256Hex } from "../src/swu/canonical.js";
import {
  buildFacetIndexes,
  buildLogicalCards,
  buildNameIndex,
  encodeToonTable,
  flattenPrinting,
  newFlattenIssues,
  priceCellsByCardId,
  splitByCurrentSets,
  swuGlossarySchema,
  type FlatRow,
  type SwuGlossary,
} from "../src/swu/llm-flatten.js";
import { buildReadme } from "../src/swu/llm-package-readme.js";
import { swuRawCacheManifestSchema } from "../src/swu/raw-manifest.js";
import { progress } from "./lib/progress.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";
const DATED_DIR = /^\d{4}-\d{2}-\d{2}$/;

const DOCS = [
  {
    from: "docs/concepts/swu-card-data-fields.md",
    name: "swu-card-data-fields.md",
    purpose: "the field guide: the meaning, strategic value and rules interactions of every card field.",
  },
  {
    from: "docs/concepts/swu-card-data.schema.json",
    name: "swu-card-data.schema.json",
    purpose: "the JSON Schema, a machine-checkable definition of the raw pages, the snapshots and the price files.",
  },
  {
    from: "docs/concepts/swu-glossary.json",
    name: "swu-glossary.json",
    purpose:
      "the glossary: a definition of every aspect, trait, keyword, type, arena, rarity, expansion, variant and token, with an inScope flag. It is the source of the definitions in llm/index/.",
  },
  {
    from: "docs/concepts/swu-glossary.schema.json",
    name: "swu-glossary.schema.json",
    purpose: "the JSON Schema for the glossary file.",
  },
  {
    from: "docs/research/swu-card-value-rubric.md",
    name: "swu-card-value-rubric.md",
    purpose: "the value rubric, a draft scoring rubric for how much a card is worth.",
  },
] as const;

const TOKEN_NOTE =
  "Measured on 2026-10-16 with the o200k tokenizer (a proxy), llm/cards.toon is about 310,000 tokens; the raw pages as minified JSON are roughly 50 million (extrapolated from a 546-record sample).";

const pageSchema = z.object({
  data: z.array(z.looseObject({ attributes: z.record(z.string(), z.unknown()) })),
  meta: z.looseObject({ pagination: z.looseObject({ total: z.number().int() }) }),
});

const rowSchema = z.record(z.string(), z.unknown());
const rowsSchema = z.array(rowSchema);
const importRowSchema = z.looseObject({ id: z.number().int() });
const printingPriceSchema = z.object({
  card_id: z.string(),
  product_id: z.number().int(),
  price_normal: z.number().nullable(),
  price_foil: z.number().nullable(),
});

function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function git(args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
}

function newestDatedDir(root: string): string {
  const names = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DATED_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodePoints);
  const newest = names.at(-1);
  if (newest === undefined) throw new Error(`no dated originals directory under ${root}`);
  return path.join(root, newest);
}

function readJson<T>(file: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function writeOut(root: string, relPath: string, content: string | Buffer): void {
  const target = path.join(root, relPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function listFiles(root: string, dir = ""): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      return entry.isDirectory() ? listFiles(root, rel) : [rel];
    })
    .sort(compareCodePoints);
}

function promoExamples(cards: readonly FlatRow[]): FlatRow[] {
  const firstPerSet = new Map<string, FlatRow>();
  for (const card of cards) if (!firstPerSet.has(String(card.firstSet))) firstPerSet.set(String(card.firstSet), card);
  return [...firstPerSet.values()].slice(0, 5);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      originals: { type: "string" },
      runs: { type: "string" },
      date: { type: "string" },
    },
  });
  const originalsDir = path.resolve(expandHome(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT)));
  const runsRoot = path.resolve(expandHome(values.runs ?? path.join(REPO_ROOT, "data/runs")));
  const pagesDir = path.join(originalsDir, "swu-cards/raw-pages");
  const snapshotsDir = path.join(originalsDir, "swu-cards/catalogue-snapshots");
  const pricesDir = path.join(originalsDir, "tcgplayer-prices");

  const p = progress("export-swu-data-package", { everyN: 10 });
  const manifestBytes = readFileSync(path.join(pagesDir, "manifest.json"));
  const manifest = swuRawCacheManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  if (!manifest.complete) throw new Error(`raw run in ${pagesDir} is not complete`);
  if (manifest.pageCount !== manifest.pages.length) throw new Error("manifest pageCount disagrees with its pages");
  const pages = [...manifest.pages]
    .sort((a, b) => a.page - b.page)
    .map((entry, index) => {
      const name = `page-${String(entry.page).padStart(4, "0")}.json`;
      const body = readFileSync(path.join(pagesDir, name));
      if (body.length !== entry.byteLength) throw new Error(`${name}: byteLength ${body.length} != manifest ${entry.byteLength}`);
      const digest = sha256Hex(body);
      if (digest !== entry.sha256) throw new Error(`${name}: sha256 ${digest} != manifest ${entry.sha256}`);
      p.tick(index + 1, { phase: "verify-pages" });
      return { name, body };
    });
  const packageDate = z.iso.date().parse(values.date ?? manifest.finishedAt.slice(0, 10));

  const issues = newFlattenIssues();
  const printings: FlatRow[] = [];
  let declaredTotal = 0;
  for (const page of pages) {
    const parsed = pageSchema.parse(JSON.parse(page.body.toString("utf8")));
    declaredTotal = parsed.meta.pagination.total;
    for (const record of parsed.data) printings.push(flattenPrinting(record, issues));
  }
  if (printings.length !== declaredTotal) {
    throw new Error(`pages hold ${printings.length} records but the API declared ${declaredTotal}`);
  }

  const snapshots = existsSync(snapshotsDir)
    ? readdirSync(snapshotsDir)
        .filter((name) => name.endsWith(".json"))
        .sort(compareCodePoints)
        .map((name) => ({ name, bytes: readFileSync(path.join(snapshotsDir, name)) }))
    : [];

  const importRow = readJson(path.join(pricesDir, "price-import.json"), importRowSchema);
  const importId = importRow.id;
  const priceRows = readJson(path.join(pricesDir, "printings.json"), rowsSchema);
  const corrections = readJson(path.join(pricesDir, "corrections.json"), rowsSchema);
  const quarantine = readJson(path.join(pricesDir, "quarantine.json"), rowsSchema);

  const priceCells = priceCellsByCardId(
    priceRows.map((row) => {
      const parsed = printingPriceSchema.parse(row);
      return { cardId: parsed.card_id, productId: parsed.product_id, priceNormal: parsed.price_normal, priceFoil: parsed.price_foil };
    }),
  );
  const logical = buildLogicalCards(printings, priceCells);

  const docs = DOCS.map((doc) => ({ ...doc, source: path.join(REPO_ROOT, doc.from) }));
  const missingDocs = docs.filter((doc) => !existsSync(doc.source));
  if (missingDocs.length > 0) throw new Error(`docs missing under ${REPO_ROOT}: ${missingDocs.map((doc) => doc.from).join(", ")}`);
  const glossaryDoc = docs.find((doc) => doc.name === "swu-glossary.json");
  if (glossaryDoc === undefined) throw new Error("swu-glossary.json is not in DOCS");
  const glossary: SwuGlossary = swuGlossarySchema.parse(JSON.parse(readFileSync(glossaryDoc.source, "utf8")));
  const split = splitByCurrentSets(logical.cards);
  const keptKeys = new Set(split.kept.map((card) => String(card.cardKey)));
  const keptMismatches = logical.mismatches.filter((mismatch) => keptKeys.has(mismatch.cardKey));
  const indexes = buildFacetIndexes(split.kept, glossary);
  const nameRows = buildNameIndex(split.kept);

  const llmFiles = new Map<string, string>([
    ["llm/cards.toon", encodeToonTable("cards", split.kept)],
    [
      "llm/gameplay-mismatches.toon",
      encodeToonTable(
        "mismatches",
        keptMismatches.map((m) => ({ ...m })),
      ),
    ],
    ["llm/index/names.toon", encodeToonTable("names", nameRows)],
  ]);
  for (const index of indexes) llmFiles.set(`llm/index/${index.facet}.toon`, encodeToonTable(index.facet, index.rows));

  const mismatchesByField = new Map<string, number>();
  for (const mismatch of keptMismatches) mismatchesByField.set(mismatch.field, (mismatchesByField.get(mismatch.field) ?? 0) + 1);
  const dateOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

  const staging = path.join(runsRoot, packageDate);
  rmSync(staging, { recursive: true, force: true });
  writeOut(
    staging,
    "README.md",
    buildReadme({
      packageDate,
      raw: {
        label: manifest.label,
        startedAt: manifest.startedAt,
        finishedAt: manifest.finishedAt,
        pageCount: manifest.pageCount,
        baseUrl: manifest.baseUrl,
      },
      priceImport: { id: importId, startedAt: dateOf(importRow.started_at), finishedAt: dateOf(importRow.finished_at) },
      counts: {
        printings: printings.length,
        logicalCards: split.kept.length,
        allLogicalCards: logical.cards.length,
        oldSetsOnly: split.oldSetsOnly.length,
        promoOnly: split.promoOnly.length,
        printingsFolded: logical.printingsFolded,
        priceRows: priceRows.length,
        corrections: corrections.length,
        quarantine: quarantine.length,
        snapshots: snapshots.length,
        nonStandardCanonical: logical.nonStandardCanonical,
        multiRootComponents: logical.multiRootComponents,
        nameRows: nameRows.length,
      },
      image: { sizeKeys: issues.sizeKeys, unfit: issues.imageUnfit.length, doubleSlash: issues.imageDoubleSlash },
      mismatchesByField,
      mismatchTotal: keptMismatches.length,
      facets: new Map(indexes.map((index) => [index.facet, { values: index.rows.length, missingDefinitions: index.missingDefinitions }])),
      docs: docs.map((doc) => ({ name: doc.name, purpose: doc.purpose })),
      tokenNote: TOKEN_NOTE,
      originalsPath: originalsDir,
    }),
  );
  for (const [relPath, content] of llmFiles) writeOut(staging, relPath, content);
  for (const doc of docs) writeOut(staging, `docs/${doc.name}`, readFileSync(doc.source));

  const dirty = git(["status", "--porcelain"]) === "" ? "" : "-dirty";
  const replay = {
    inputs: {
      rawManifestSha256: sha256Hex(manifestBytes),
      pages: manifest.pages
        .slice()
        .sort((a, b) => a.page - b.page)
        .map((page) => page.sha256),
      priceImportId: importId,
      priceRowsSha256: sha256Hex(canonicalJson({ printings: priceRows, corrections, quarantine })),
      snapshots: snapshots.map((snapshot) => ({ name: snapshot.name, sha256: sha256Hex(snapshot.bytes) })),
    },
    codeCommit: `${git(["rev-parse", "HEAD"])}${dirty}`,
    outputs: Object.fromEntries([...llmFiles].map(([relPath, content]) => [relPath, sha256Hex(content)])),
  };
  writeOut(staging, "replay.json", `${JSON.stringify(replay, null, 2)}\n`);

  const files = listFiles(staging);
  p.done({ files: files.length, logicalCards: split.kept.length });
    console.log(`staging: ${staging}`);
  console.log(`originals: ${originalsDir}`);
  console.log(`files: ${files.length}`);
  console.log(`printings in raw pages: ${printings.length} (declared ${declaredTotal})`);
  console.log(`logical cards (all sets): ${logical.cards.length}; printings folded: ${logical.printingsFolded}`);
  console.log(
    `kept in llm/: ${split.kept.length}; excluded old-sets-only: ${split.oldSetsOnly.length}; excluded promo-only: ${split.promoOnly.length}`,
  );
  console.log(
    `promo-only examples: ${promoExamples(split.promoOnly)
      .map((card) => `${card.firstSet} ${card.cardKey} ${card.title}`)
      .join(" ; ")}`,
  );
  console.log(`price printings: ${priceRows.length}; corrections: ${corrections.length}; quarantine: ${quarantine.length}`);
  console.log(`image cells not fitting the pattern: ${issues.imageUnfit.length}; double-slash images: ${issues.imageDoubleSlash}`);
  console.log(
    `gameplay mismatches (kept cards): ${keptMismatches.length} of ${logical.mismatches.length}; groups without a single unlinked printing: ${logical.multiRootComponents}`,
  );
  console.log(`missing glossary definitions: ${indexes.map((index) => `${index.facet}=${index.missingDefinitions}`).join(" ")}`);
}

main();
