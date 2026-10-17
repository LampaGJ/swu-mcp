import { decode } from "@toon-format/toon";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "./paths.js";
import { compareCodePoints } from "./swu/canonical.js";
import { INDEX_FACETS, type IndexFacet } from "./swu/llm-flatten.js";

/** A derived data directory the package does not hold; every other load failure is a defect, not an absence. */
export class MissingDataError extends Error {
  override name = "MissingDataError";
}

export const DATED_DIR = /^\d{4}-\d{2}-\d{2}$/;

const text = z.string().nullable();
const num = z.number().nullable();

const cardRowSchema = z.looseObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: text,
  type: z.string(),
  cost: num,
  power: num,
  hp: num,
  aspects: text,
  traits: text,
  keywords: text,
  arenas: text,
  text: text,
  sets: text,
});
export type CardRow = z.infer<typeof cardRowSchema>;

const cardsFileSchema = z.object({ cards: z.array(cardRowSchema) });

const indexRowSchema = z.object({
  value: z.string(),
  cards: z.number().int(),
  definition: text,
  cardKeys: z.string(),
});
export interface FacetEntry {
  value: string;
  cards: number;
  definition: string | null;
  cardKeys: string[];
}

export interface CardStore {
  dataDir: string;
  cards: CardRow[];
  byKey: Map<string, CardRow>;
  facets: Map<IndexFacet, FacetEntry[]>;
}

/** The built package directory (parent of llm/), where features/, scores/, synergy/ and rules/ live. */
export function packageDirOf(store: CardStore): string {
  return path.basename(store.dataDir) === "llm" ? path.dirname(store.dataDir) : store.dataDir;
}

export function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function splitCell(value: string | null | undefined): string[] {
  return value === null || value === undefined || value === "" ? [] : value.split("|");
}

/** Newest dated directory under <runsDir>, or undefined when there is none. */
export function newestRun(runsDir: string): string | undefined {
  if (!existsSync(runsDir)) return undefined;
  const newest = readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && DATED_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareCodePoints)
    .at(-1);
  return newest === undefined ? undefined : path.join(runsDir, newest);
}

/** SWU_MCP_DATA wins; otherwise the newest dated directory under <repo>/data/runs. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = z.string().min(1).optional().parse(env.SWU_MCP_DATA);
  if (configured !== undefined) return path.resolve(configured);
  const runs = path.join(REPO_ROOT, "data/runs");
  const newest = newestRun(runs);
  if (newest === undefined) throw new Error(`no data package under ${runs}; run "pnpm export:package" or set SWU_MCP_DATA`);
  return newest;
}

function readToon(file: string): unknown {
  return decode(readFileSync(file, "utf8"));
}

/** Accepts either a package directory (containing llm/) or the llm directory itself. */
export function loadStore(dataDir: string): CardStore {
  const llm = existsSync(path.join(dataDir, "llm")) ? path.join(dataDir, "llm") : dataDir;
  const cards = cardsFileSchema.parse(readToon(path.join(llm, "cards.toon"))).cards;
  const byKey = new Map(cards.map((card) => [card.cardKey, card]));
  if (byKey.size !== cards.length) throw new Error("cards.toon holds duplicate cardKey values");

  const facets = new Map<IndexFacet, FacetEntry[]>();
  for (const facet of INDEX_FACETS) {
    const file = path.join(llm, "index", `${facet}.toon`);
    if (!existsSync(file)) continue;
    const rows = z.object({ [facet]: z.array(indexRowSchema) }).parse(readToon(file))[facet];
    facets.set(
      facet,
      rows.map((row) => ({ ...row, cardKeys: splitCell(row.cardKeys) })),
    );
  }
  return { dataDir: llm, cards, byKey, facets };
}
