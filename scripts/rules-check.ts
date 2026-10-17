/**
 * @displayName SWU rules check script
 * @strategicPurpose Read-only change detector (LampaGJ/swu-mcp#5): says whether the Comprehensive Rules PDF
 * pinned in data/runs/<date>/rules/replay.json is still the newest official one.
 * @tacticalObjective HEADs the pinned CDN URL, scans official pages for CR filenames, and reads the newest
 * articles from admin.starwarsunlimited.com/api/articles. Writes nothing.
 *
 * Usage: pnpm rules:check [--data <package dir>] [--verify-hash]
 *   --verify-hash  also download the pinned URL and compare its sha256 with the pinned one
 * Exit code: 0 current, 10 newer available, 2 network or input error.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { resolveDataDir } from "../src/data.js";
import { sha256Hex } from "../src/swu/canonical.js";
import { CR_FILE_NAME, EXIT_CURRENT, EXIT_ERROR, EXIT_NEWER, evaluate, pinnedRulesSchema, type Article, type Observed, type Pinned } from "../src/rules/check.js";
import { REPO_ROOT } from "../src/paths.js";

const DEFAULT_URL = "https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf";
const PAGES = ["https://starwarsunlimited.com/how-to-play", "https://starwarsunlimited.com/organized-play"];
const ARTICLES = "https://admin.starwarsunlimited.com/api/articles";
const TIMEOUT_MS = 30_000;

const fetchRecordSchema = z.looseObject({ url: z.string().nullable(), fileName: z.string() });
const articlesSchema = z.object({
  data: z.array(z.object({ attributes: z.object({ title: z.string(), slug: z.string().optional(), publishOn: z.string().nullable(), updatedAt: z.string().nullable() }) })),
});

async function http(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, headers: { "accept-encoding": "identity" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

function loadPinned(dataDir: string): Pinned {
  const replay = pinnedRulesSchema.parse(JSON.parse(readFileSync(path.join(dataDir, "rules/replay.json"), "utf8")));
  const record = path.join(REPO_ROOT, "data/originals/rules", replay.rulesVersion, "fetch.json");
  const fetched = existsSync(record) ? fetchRecordSchema.parse(JSON.parse(readFileSync(record, "utf8"))) : null;
  const url = fetched?.url ?? DEFAULT_URL;
  return { rulesVersion: replay.rulesVersion, fetchedAt: replay.source.fetchedAt, pdfSha256: replay.source.pdfSha256, pdfBytes: replay.source.pdfBytes, url, fileName: fetched?.fileName ?? path.basename(new URL(url).pathname) };
}

async function articles(query: string): Promise<Article[]> {
  const response = await http(`${ARTICLES}?${query}`);
  if (!response.ok) throw new Error(`GET ${ARTICLES} -> ${response.status}`);
  return articlesSchema.parse(await response.json()).data.map((row) => row.attributes);
}

async function observe(pinned: Pinned, verifyHash: boolean): Promise<Observed> {
  const head = await http(pinned.url, { method: "HEAD" });
  if (head.status >= 500) throw new Error(`HEAD ${pinned.url} -> ${head.status}`);
  const length = head.headers.get("content-length");
  const listedFileNames: string[] = [];
  for (const page of PAGES) {
    const response = await http(page);
    if (response.status >= 500) throw new Error(`GET ${page} -> ${response.status}`);
    if (response.ok) listedFileNames.push(...((await response.text()).match(CR_FILE_NAME) ?? []));
  }
  const rulesArticles = await articles("filters[title][$containsi]=rules&fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&sort=publishOn:desc&pagination[pageSize]=25");
  const newest = await articles("fields[0]=title&fields[1]=slug&fields[2]=publishOn&fields[3]=updatedAt&sort=updatedAt:desc&pagination[pageSize]=1");
  let downloadedSha256: string | undefined;
  if (verifyHash && head.status === 200) {
    const body = await http(pinned.url);
    if (!body.ok) throw new Error(`GET ${pinned.url} -> ${body.status}`);
    downloadedSha256 = sha256Hex(Buffer.from(await body.arrayBuffer()));
  }
  return {
    pdfHead: { status: head.status, contentLength: length === null ? null : Number(length), lastModified: head.headers.get("last-modified") },
    listedFileNames,
    rulesArticles,
    newestArticle: newest[0] ?? null,
    downloadedSha256,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { data: { type: "string" }, "verify-hash": { type: "boolean", default: false } } });
  const dataDir = path.resolve(values.data ?? resolveDataDir());
  const pinned = loadPinned(dataDir);
  const observed = await observe(pinned, values["verify-hash"] === true);
  const verdict = evaluate(pinned, observed);
  console.log(JSON.stringify({ ...verdict, pinned, observed }, null, 1));
  return verdict.status === "current" ? EXIT_CURRENT : EXIT_NEWER;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = EXIT_ERROR;
  },
);
