/**
 * @displayName SWU rules fetch script
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#6): the official Comprehensive Rules PDF and mault's raw
 * card pages in; sections.json, card-rulings.json, keyword_rules.json, core-primer.md and replay.json out,
 * replayable from the pinned PDF and pages to identical bytes.
 * @tacticalObjective Downloads (or reads) the PDF, stores it under data/originals/rules/<version>/ with its sha256,
 * extracts text with poppler's pdftotext, parses the numbered sections, and extracts dated per-card rulings.
 *
 * Usage: pnpm rules:fetch [--url <pdf url>] [--pdf <local pdf>] [--originals <swu-originals dir>] [--skip-rulings]
 *                         [--glossary <file>] [--core <file>] [--rules-originals <dir>] [--date <YYYY-MM-DD>]
 *                         [--fetched-at <YYYY-MM-DD>] [--out <dir>] [--max-primer-tokens <n>]
 *   --url            default: the v8.0 CDN link (the filename carries a hash, so there is no stable "latest" URL)
 *   --pdf            read this file instead of downloading
 *   --originals      default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --out            default: <repo>/data/runs/<date>/rules, <date> = --date or the fetch date
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import { buildRulesRun } from "../src/rules/build.js";
import { buildCardRulings } from "../src/rules/rulings.js";
import { rulesCoreFileSchema, rulesReplaySchema, type CardRulingsFile } from "../src/rules/schemas.js";
import { canonicalJson, sha256Hex } from "../src/swu/canonical.js";
import type { RawCardRecord } from "../src/swu/llm-flatten.js";
import { swuGlossarySchema } from "../src/swu/llm-flatten.js";
import { swuRawCacheManifestSchema } from "../src/swu/raw-manifest.js";
import { codeCommit } from "./lib/code-commit.js";
import { DEFAULT_ORIGINALS_ROOT, expandHome, newestDatedDir } from "./lib/originals.js";
import { progress } from "./lib/progress.mjs";
import { REPO_ROOT } from "../src/paths.js";

const DEFAULT_URL = "https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf";
const DEFAULT_PRIMER_TOKENS = 4000;

const pageSchema = z.object({ data: z.array(z.looseObject({ attributes: z.record(z.string(), z.unknown()) })) });
const fetchRecordSchema = z.strictObject({ url: z.string().nullable(), fetchedAt: z.iso.date(), sha256: z.string(), bytes: z.number().int(), fileName: z.string() });

function pdftotextVersion(): string {
  const result = spawnSync("pdftotext", ["-v"], { encoding: "utf8" });
  return `${result.stderr}${result.stdout}`.split("\n")[0].trim();
}

async function acquirePdf(url: string, local: string | undefined): Promise<{ bytes: Buffer; downloaded: boolean; url: string | null }> {
  if (local !== undefined) return { bytes: readFileSync(path.resolve(expandHome(local))), downloaded: false, url: null };
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), downloaded: true, url };
}

function loadRawRecords(originalsDir: string, tick: (done: number) => void): { records: RawCardRecord[]; source: CardRulingsFile["source"] } {
  const pagesDir = path.join(originalsDir, "swu-cards/raw-pages");
  const manifestBody = readFileSync(path.join(pagesDir, "manifest.json"));
  const manifest = swuRawCacheManifestSchema.parse(JSON.parse(manifestBody.toString("utf8")));
  if (!manifest.complete) throw new Error(`raw run in ${pagesDir} is not complete`);
  const records: RawCardRecord[] = [];
  [...manifest.pages]
    .sort((a, b) => a.page - b.page)
    .forEach((entry, index) => {
      const name = `page-${String(entry.page).padStart(4, "0")}.json`;
      const body = readFileSync(path.join(pagesDir, name));
      if (sha256Hex(body) !== entry.sha256) throw new Error(`${name}: sha256 does not match the manifest`);
      for (const record of pageSchema.parse(JSON.parse(body.toString("utf8"))).data) records.push(record);
      tick(index + 1);
    });
  return { records, source: { originalsRun: path.basename(originalsDir), rawPagesManifestSha256: sha256Hex(manifestBody) } };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: DEFAULT_URL },
      pdf: { type: "string" },
      originals: { type: "string" },
      "skip-rulings": { type: "boolean", default: false },
      glossary: { type: "string" },
      core: { type: "string" },
      "rules-originals": { type: "string" },
      date: { type: "string" },
      "fetched-at": { type: "string" },
      out: { type: "string" },
      "max-primer-tokens": { type: "string" },
    },
  });
  const p = progress("rules-fetch", { everyN: 10 });
  const rulesOriginals = path.resolve(expandHome(values["rules-originals"] ?? path.join(REPO_ROOT, "data/originals/rules")));
  mkdirSync(rulesOriginals, { recursive: true });

  p.log({ phase: "pdf" });
  const pdf = await acquirePdf(values.url as string, values.pdf);
  const pdfSha256 = sha256Hex(pdf.bytes);
  const staging = path.join(rulesOriginals, `.staging-${pdfSha256}.pdf`);
  writeFileSync(staging, pdf.bytes);
  const text = execFileSync("pdftotext", ["-layout", staging, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

  const glossary = swuGlossarySchema.parse(JSON.parse(readFileSync(path.resolve(expandHome(values.glossary ?? path.join(REPO_ROOT, "docs/concepts/swu-glossary.json"))), "utf8")));
  const core = rulesCoreFileSchema.parse(JSON.parse(readFileSync(path.resolve(expandHome(values.core ?? path.join(REPO_ROOT, "data/rules-core.json"))), "utf8")));

  let cardRulings: CardRulingsFile | null = null;
  if (!values["skip-rulings"]) {
    const originalsDir = path.resolve(expandHome(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT, "originals")));
    p.log({ phase: "read-pages", originalsDir });
    const { records, source } = loadRawRecords(originalsDir, (done) => p.tick(done, { phase: "read-pages" }));
    cardRulings = buildCardRulings(records, source);
  }

  p.log({ phase: "parse" });
  const run = buildRulesRun({
    text,
    pdfSha256,
    glossaryVersion: glossary.version,
    glossaryKeywords: glossary.facets.keyword ?? [],
    core,
    cardRulings,
    primerMaxTokens: Number(values["max-primer-tokens"] ?? DEFAULT_PRIMER_TOKENS),
    countTokens,
  });

  const version = run.parsed.version;
  const pdfDir = path.join(rulesOriginals, version);
  const fileName = path.basename(new URL(values.url as string).pathname);
  const recordPath = path.join(pdfDir, "fetch.json");
  mkdirSync(pdfDir, { recursive: true });
  const stored = path.join(pdfDir, fileName);
  if (existsSync(stored) && sha256Hex(readFileSync(stored)) !== pdfSha256) {
    throw new Error(`${stored} exists with a different sha256; a new CR needs a new version directory, not an overwrite`);
  }
  renameSync(staging, stored);
  const today = new Date().toISOString().slice(0, 10);
  const previous = existsSync(recordPath) ? fetchRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8"))) : null;
  const fetchRecord =
    previous !== null && previous.sha256 === pdfSha256
      ? previous
      : { url: pdf.url, fetchedAt: values["fetched-at"] ?? today, sha256: pdfSha256, bytes: pdf.bytes.length, fileName };
  writeFileSync(recordPath, `${JSON.stringify(fetchRecord, null, 1)}\n`);

  const outDir = path.resolve(expandHome(values.out ?? path.join(REPO_ROOT, "data/runs", values.date ?? fetchRecord.fetchedAt, "rules")));
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(run.files)) writeFileSync(path.join(outDir, name), content);

  const replay = rulesReplaySchema.parse({
    schemaVersion: 1,
    source: { url: fetchRecord.url, fetchedAt: fetchRecord.fetchedAt, pdfSha256, pdfBytes: fetchRecord.bytes },
    tool: { pdftotext: pdftotextVersion(), codeCommit: codeCommit(["src", "scripts", "data/rules-core.json"]) },
    rulesVersion: version,
    textSha256: sha256Hex(text),
    rulings: cardRulings === null ? null : cardRulings.source,
    outputs: run.hashes,
  });
  writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(JSON.parse(canonicalJson(replay)), null, 1)}\n`);

  p.done({ sections: run.parsed.sections.length });
  console.log(
    JSON.stringify(
      {
        outDir,
        pdf: stored,
        version,
        coverDate: run.parsed.coverDate,
        pdfSha256,
        sections: run.parsed.sections.length,
        anomalies: run.parsed.anomalies,
        primer: { tokens: run.primer.tokens, full: run.primer.fullIds.length, outline: run.primer.outlineIds.length },
        rulings: cardRulings?.stats ?? null,
        outputs: run.hashes,
      },
      null,
      1,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
