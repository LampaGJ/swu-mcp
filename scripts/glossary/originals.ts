/**
 * @displayName SWU originals loader for the glossary and field-guide count scripts
 * @strategicPurpose Both count scripts must read the same pinned input the same way, so a count
 * in the glossary and a count in the field guide can never disagree about what a printing is
 * (LampaGJ/swu-mcp#13).
 * @tacticalObjective Reads the complete raw card-list run in a mault originals folder, checks every
 * page against the manifest's byte length and sha256, flattens each record with the data package's
 * flattener, folds printings into logical cards, and marks the cards in the delivered package scope
 * (a printing in Jump to Lightspeed or later).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import {
  buildLogicalCards,
  flattenPrinting,
  newFlattenIssues,
  printingCardKeys,
  setReleaseOrder,
  splitByCurrentSets,
  type Cell,
  type FlatRow,
} from "../../src/swu/llm-flatten.js";
import { swuRawCacheManifestSchema } from "../../src/swu/raw-manifest.js";

export const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";
const DATED_DIR = /^\d{4}-\d{2}-\d{2}$/;

/** Release order that setReleaseOrder returns for a code missing from the table (src/swu/llm-flatten.ts). */
const UNKNOWN_ORDER = Number.MAX_SAFE_INTEGER;

const pageSchema = z.object({
  data: z.array(z.looseObject({ id: z.number().optional(), attributes: z.record(z.string(), z.unknown()) })),
  meta: z.looseObject({ pagination: z.looseObject({ total: z.number().int() }) }),
});

export interface RawPrinting {
  id: number | undefined;
  attributes: Record<string, unknown>;
}

export interface Originals {
  /** The date the raw run finished (UTC), from the manifest. */
  runDate: string;
  /** Raw records exactly as the API returned them, in manifest page order. */
  raw: RawPrinting[];
  /** One flat row per raw record, same order as `raw`. */
  printings: FlatRow[];
  /** serialCode of a printing -> cardKey of its logical card. */
  cardKeyOfSerial: Map<string, string>;
  /** Every logical card, sorted by cardKey. */
  logical: FlatRow[];
  /** Logical cards with a printing in Jump to Lightspeed or later (the delivered package scope). */
  kept: FlatRow[];
  keptKeys: Set<string>;
}

export function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function newestOriginalsDir(root: string = DEFAULT_ORIGINALS_ROOT): string {
  const newest = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DATED_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodePoints)
    .at(-1);
  if (newest === undefined) throw new Error(`no dated originals directory under ${root}`);
  return path.join(root, newest);
}

export function loadOriginals(originalsDir: string): Originals {
  const pagesDir = path.join(originalsDir, "swu-cards/raw-pages");
  const manifest = swuRawCacheManifestSchema.parse(JSON.parse(readFileSync(path.join(pagesDir, "manifest.json"), "utf8")));
  if (!manifest.complete) throw new Error(`raw run in ${pagesDir} is not complete`);
  const issues = newFlattenIssues();
  const raw: RawPrinting[] = [];
  const printings: FlatRow[] = [];
  let declaredTotal = 0;
  for (const entry of [...manifest.pages].sort((a, b) => a.page - b.page)) {
    const name = `page-${String(entry.page).padStart(4, "0")}.json`;
    const body = readFileSync(path.join(pagesDir, name));
    if (body.length !== entry.byteLength) throw new Error(`${name}: byteLength ${body.length} != manifest ${entry.byteLength}`);
    const digest = createHash("sha256").update(body).digest("hex");
    if (digest !== entry.sha256) throw new Error(`${name}: sha256 ${digest} != manifest ${entry.sha256}`);
    const parsed = pageSchema.parse(JSON.parse(body.toString("utf8")));
    declaredTotal = parsed.meta.pagination.total;
    for (const record of parsed.data) {
      raw.push({ id: record.id, attributes: record.attributes });
      printings.push(flattenPrinting(record, issues));
    }
  }
  if (printings.length !== declaredTotal) throw new Error(`pages hold ${printings.length} records but the API declared ${declaredTotal}`);
  const logical = buildLogicalCards(printings, new Map()).cards;
  const kept = splitByCurrentSets(logical).kept;
  return {
    runDate: manifest.finishedAt.slice(0, 10),
    raw,
    printings,
    cardKeyOfSerial: printingCardKeys(printings),
    logical,
    kept,
    keptKeys: new Set(kept.map((row) => String(row.cardKey))),
  };
}

/** Splits a "|" joined flat cell into its values. */
export function cellList(value: Cell | undefined): string[] {
  return typeof value === "string" && value !== "" ? value.split("|") : [];
}

/** True when the printing's set was released at or after Jump to Lightspeed (Weekly Play codes count as their base set). */
export function inScopeSet(expansion: Cell | undefined): boolean {
  const order = setReleaseOrder(typeof expansion === "string" ? expansion : "");
  return order !== UNKNOWN_ORDER && order >= setReleaseOrder("JTL");
}

/** A game card's name key: title and subtitle, which is what "distinct cards" counts. */
export function nameKey(row: FlatRow): string {
  return `${row.title ?? ""}|${row.subtitle ?? ""}`;
}
