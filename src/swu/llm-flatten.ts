// Ported from mault packages/server/src/lib/adapters/swu/llm-flatten.ts.
import { swuSetRotation } from "./set-rotation.js";
import { encode } from "@toon-format/toon";
import { z } from "zod";

import { compareCodePoints } from "./canonical.js";

export const CDN_PREFIX = "https://cdn.starwarsunlimited.com/";

export const DROPPED_FIELDS = [
  "id (Strapi record id)",
  "*Styled (textStyled, deployBoxStyled, epicActionStyled, rulesStyled: HTML copies of the plain text)",
  "localizations",
  "linkHtml",
  "createdAt",
  "updatedAt",
  "publishedAt",
] as const;

const DROPPED_EXACT = new Set(["localizations", "linkHtml", "createdAt", "updatedAt", "publishedAt"]);
const LINK_FIELDS = ["variantOf", "reprintOf"] as const;

export const GAMEPLAY_FIELDS = [
  "title",
  "subtitle",
  "type",
  "type2",
  "cost",
  "power",
  "hp",
  "upgradePower",
  "upgradeHp",
  "arenas",
  "aspects",
  "aspectDuplicates",
  "traits",
  "keywords",
  "unique",
  "text",
  "deployBox",
  "epicAction",
  "rules",
] as const;

const LIST_FIELDS = new Set(["arenas", "aspects", "aspectDuplicates", "traits", "keywords"]);
const PER_PRINTING_ONLY = new Set(["variantTypes", ...LINK_FIELDS]);

export type Cell = string | number | boolean | null;
export type FlatRow = Record<string, Cell>;

export interface RawCardRecord {
  id?: number;
  attributes: Record<string, unknown>;
}

export interface FlattenIssues {
  imageUnfit: string[];
  imageDoubleSlash: number;
  sizeKeys: Map<string, Set<string>>;
  danglingLinks: number;
}

interface UploadAttributes {
  url?: unknown;
  hash?: unknown;
  ext?: unknown;
  formats?: unknown;
}

const relationSchema = z.object({
  data: z.union([z.null(), z.array(z.any()), z.object({ attributes: z.record(z.string(), z.unknown()) })]),
});

function isRelation(value: unknown): value is z.infer<typeof relationSchema> {
  return relationSchema.safeParse(value).success;
}

function nameOf(entry: { attributes?: Record<string, unknown> }, key: string): string {
  const value = entry.attributes?.[key];
  return typeof value === "string" ? value : "";
}

/**
 * Reduces an upload relation to its unique file stem. A leading "/" marks the
 * CDN's double-slash URL form; returns null when any URL breaks the pattern.
 */
function uploadStem(upload: UploadAttributes, field: string, issues: FlattenIssues): string | null {
  const { url, hash, ext, formats } = upload;
  if (typeof url !== "string" || typeof hash !== "string" || typeof ext !== "string") return null;
  const stem = `${hash}${ext}`;
  const slash = url.startsWith(`${CDN_PREFIX}/`) ? "/" : "";
  if (url !== `${CDN_PREFIX}${slash}${stem}`) return null;
  const keys = issues.sizeKeys.get(field) ?? new Set<string>();
  issues.sizeKeys.set(field, keys);
  const formatMap = formats && typeof formats === "object" ? (formats as Record<string, UploadAttributes>) : {};
  for (const [sizeKey, format] of Object.entries(formatMap)) {
    keys.add(sizeKey);
    if (typeof format.hash !== "string" || typeof format.ext !== "string" || typeof format.url !== "string") return null;
    if (!format.hash.startsWith(`${sizeKey}_`)) return null;
    if (`${format.hash.slice(sizeKey.length + 1)}${format.ext}` !== stem) return null;
    if (format.url !== `${CDN_PREFIX}${slash}${format.hash}${format.ext}`) return null;
  }
  if (slash) issues.imageDoubleSlash += 1;
  return `${slash}${stem}`;
}

/**
 * @displayName SWU printing flattener
 * @strategicPurpose Turns one nested Strapi card record into a flat row of
 * primitives, so a language model reads names instead of relation envelopes.
 * @tacticalObjective Pure and deterministic: relations become names joined by
 * "|", uploads become unique file stems, and the fields in DROPPED_FIELDS are
 * omitted. Keys come out in code-point order.
 */
export function flattenPrinting(record: RawCardRecord, issues: FlattenIssues): FlatRow {
  const row: FlatRow = {};
  const serial = typeof record.attributes.serialCode === "string" ? record.attributes.serialCode : "?";
  for (const key of Object.keys(record.attributes).sort(compareCodePoints)) {
    if (DROPPED_EXACT.has(key) || key.endsWith("Styled")) continue;
    const value = record.attributes[key];
    if (!isRelation(value)) {
      row[key] = value === undefined ? null : (value as Cell);
      continue;
    }
    const data = value.data;
    if ((LINK_FIELDS as readonly string[]).includes(key)) {
      const target = data && !Array.isArray(data) ? nameOf(data, "serialCode") : "";
      if (data && !target) issues.danglingLinks += 1;
      row[key] = target;
    } else if (Array.isArray(data)) {
      row[key] = data.map((entry) => nameOf(entry, "name")).join("|");
    } else if (data === null) {
      row[key] = "";
    } else if ("formats" in data.attributes) {
      const stem = uploadStem(data.attributes as UploadAttributes, key, issues);
      if (stem === null) {
        issues.imageUnfit.push(`${serial}:${key}`);
        row[key] = typeof data.attributes.url === "string" ? data.attributes.url : "";
      } else row[key] = stem;
    } else {
      row[key] = nameOf(data, key === "expansion" ? "code" : "name");
    }
  }
  return row;
}

export function newFlattenIssues(): FlattenIssues {
  return { imageUnfit: [], imageDoubleSlash: 0, sizeKeys: new Map(), danglingLinks: 0 };
}

export interface PriceCells {
  priceNormal: number | null;
  priceFoil: number | null;
}

export interface GameplayMismatch {
  cardKey: string;
  serialCode: string;
  field: string;
  canonical: Cell;
  other: Cell;
}

export interface LogicalCards {
  cards: FlatRow[];
  mismatches: GameplayMismatch[];
  printingsFolded: number;
  nonStandardCanonical: number;
  multiRootComponents: number;
}

function splitList(value: Cell): string[] {
  return typeof value === "string" && value !== "" ? value.split("|") : [];
}

function comparable(field: string, value: Cell): string {
  if (LIST_FIELDS.has(field)) return JSON.stringify([...new Set(splitList(value))].sort(compareCodePoints));
  if (typeof value === "string") {
    const collapsed = value.replace(/\s+/g, " ").trim();
    return JSON.stringify(collapsed === "" ? null : collapsed);
  }
  return JSON.stringify(value);
}

const UNKNOWN_ORDER = Number.MAX_SAFE_INTEGER;
const FIRST_CURRENT_SET = "JTL";

/** Release order of a set code; a "<set>P" Weekly Play code takes its base set's order. */
export function setReleaseOrder(code: string): number {
  const direct = swuSetRotation(code);
  if (direct) return direct.releaseOrder;
  const weekly = code.endsWith("P") ? swuSetRotation(code.slice(0, -1)) : null;
  return weekly?.releaseOrder ?? UNKNOWN_ORDER;
}

function releaseOrder(row: FlatRow): number {
  return setReleaseOrder(typeof row.expansion === "string" ? row.expansion : "");
}

function cellString(row: FlatRow, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function findRoot(parent: Map<string, string>, serial: string): string {
  let current = serial;
  while (parent.get(current) !== current) current = parent.get(current) as string;
  return current;
}

/**
 * @displayName SWU logical card builder
 * @strategicPurpose Folds every printing of one game card (foil, hyperspace,
 * showcase, promo, reprint) into one row, because a model needs each card once.
 * @tacticalObjective Groups printings connected by variantOf/reprintOf, picks
 * the canonical printing (the one linking to no other; else earliest set by
 * release order, then lowest serialCode), keeps its values, and lists gameplay
 * fields where another printing disagrees after whitespace and list-order
 * normalisation. Output is sorted by cardKey.
 */
export function buildLogicalCards(printings: FlatRow[], prices: ReadonlyMap<string, PriceCells>): LogicalCards {
  const bySerial = new Map<string, FlatRow>();
  for (const row of printings) {
    const serial = cellString(row, "serialCode");
    if (serial === "") throw new Error("printing without serialCode");
    if (bySerial.has(serial)) throw new Error(`duplicate serialCode ${serial}`);
    bySerial.set(serial, row);
  }
  const parent = new Map<string, string>([...bySerial.keys()].map((serial) => [serial, serial]));
  for (const [serial, row] of bySerial) {
    for (const link of LINK_FIELDS) {
      const target = cellString(row, link);
      if (target !== "" && bySerial.has(target)) {
        parent.set(findRoot(parent, serial), findRoot(parent, target));
      }
    }
  }
  const components = new Map<string, FlatRow[]>();
  for (const [serial, row] of bySerial) {
    const root = findRoot(parent, serial);
    components.set(root, [...(components.get(root) ?? []), row]);
  }

  const cards: FlatRow[] = [];
  const mismatches: GameplayMismatch[] = [];
  let printingsFolded = 0;
  let nonStandardCanonical = 0;
  let multiRootComponents = 0;
  for (const members of components.values()) {
    const unlinked = members.filter((row) => cellString(row, "variantOf") === "" && cellString(row, "reprintOf") === "");
    if (unlinked.length !== 1) multiRootComponents += 1;
    const pool = unlinked.length > 0 ? unlinked : members;
    const canonical = [...pool].sort(
      (a, b) => releaseOrder(a) - releaseOrder(b) || compareCodePoints(cellString(a, "serialCode"), cellString(b, "serialCode")),
    )[0];
    const cardKey = cellString(canonical, "serialCode");
    printingsFolded += members.length - 1;

    for (const other of members) {
      if (other === canonical) continue;
      for (const field of GAMEPLAY_FIELDS) {
        if (comparable(field, canonical[field] ?? null) !== comparable(field, other[field] ?? null)) {
          mismatches.push({
            cardKey,
            serialCode: cellString(other, "serialCode"),
            field,
            canonical: canonical[field] ?? null,
            other: other[field] ?? null,
          });
        }
      }
    }

    const variantNames = new Set<string>();
    const sets = new Set<string>();
    for (const row of members) {
      for (const name of splitList(row.variantTypes ?? null)) variantNames.add(name);
      if (cellString(row, "expansion") !== "") sets.add(cellString(row, "expansion"));
    }
    if (!splitList(canonical.variantTypes ?? null).includes("Standard")) nonStandardCanonical += 1;

    const gameplay = new Set<string>(GAMEPLAY_FIELDS);
    const rest = Object.keys(canonical)
      .filter((key) => key !== "serialCode" && !gameplay.has(key) && !PER_PRINTING_ONLY.has(key))
      .sort(compareCodePoints);
    const row: FlatRow = { cardKey };
    for (const field of GAMEPLAY_FIELDS) row[field] = canonical[field] ?? null;
    for (const key of rest) row[key] = canonical[key];
    const earliest = [...members].sort(
      (a, b) => releaseOrder(a) - releaseOrder(b) || compareCodePoints(cellString(a, "serialCode"), cellString(b, "serialCode")),
    )[0];
    row.sets = [...sets]
      .sort((a, b) => releaseOrder({ expansion: a }) - releaseOrder({ expansion: b }) || compareCodePoints(a, b))
      .join("|");
    row.firstSet = cellString(earliest, "expansion");
    row.printingCount = members.length;
    row.variants = [...variantNames].sort(compareCodePoints).join("|");
    const price = prices.get(cardKey);
    row.priceNormal = price?.priceNormal ?? null;
    row.priceFoil = price?.priceFoil ?? null;
    cards.push(row);
  }
  cards.sort((a, b) => compareCodePoints(cellString(a, "cardKey"), cellString(b, "cardKey")));
  mismatches.sort(
    (a, b) =>
      compareCodePoints(a.cardKey, b.cardKey) || compareCodePoints(a.serialCode, b.serialCode) || compareCodePoints(a.field, b.field),
  );
  return { cards, mismatches, printingsFolded, nonStandardCanonical, multiRootComponents };
}

export const swuGlossarySchema = z.object({
  version: z.literal(1),
  facets: z.record(z.string(), z.array(z.object({ value: z.string(), definition: z.string().nullish() }).passthrough())),
});
export type SwuGlossary = z.infer<typeof swuGlossarySchema>;

export const INDEX_FACETS = ["aspect", "trait", "keyword", "type", "arena", "rarity", "expansion", "variant"] as const;
export type IndexFacet = (typeof INDEX_FACETS)[number];

const FACET_VALUES: Record<IndexFacet, (card: FlatRow) => string[]> = {
  aspect: (card) => splitList(card.aspects),
  trait: (card) => splitList(card.traits),
  keyword: (card) => splitList(card.keywords),
  type: (card) => [...splitList(card.type), ...splitList(card.type2)],
  arena: (card) => splitList(card.arenas),
  rarity: (card) => splitList(card.rarity),
  expansion: (card) => splitList(card.sets),
  variant: (card) => splitList(card.variants),
};

export interface FacetIndex {
  facet: IndexFacet;
  rows: FlatRow[];
  missingDefinitions: number;
}

/**
 * @displayName SWU facet indexes
 * @strategicPurpose Lets a model list every logical card with a given aspect,
 * trait, keyword and so on without scanning the whole card table.
 * @tacticalObjective One row per facet value with the card count, the
 * glossary definition (empty and counted when absent) and the code-point sorted
 * "|"-joined card keys.
 */
export function buildFacetIndexes(cards: FlatRow[], glossary: SwuGlossary | null): FacetIndex[] {
  return INDEX_FACETS.map((facet) => {
    const keysByValue = new Map<string, Set<string>>();
    for (const card of cards) {
      for (const value of FACET_VALUES[facet](card)) {
        const keys = keysByValue.get(value) ?? new Set<string>();
        keysByValue.set(value, keys.add(cellString(card, "cardKey")));
      }
    }
    const definitions = new Map((glossary?.facets[facet] ?? []).map((entry) => [entry.value, entry.definition ?? ""]));
    let missingDefinitions = 0;
    const rows = [...keysByValue.keys()].sort(compareCodePoints).map((value) => {
      const definition = definitions.get(value) ?? "";
      if (definition === "") missingDefinitions += 1;
      const keys = [...(keysByValue.get(value) as Set<string>)].sort(compareCodePoints);
      return { value, cards: keys.length, definition, cardKeys: keys.join("|") };
    });
    return { facet, rows, missingDefinitions };
  });
}

/**
 * @displayName SWU name index
 * @strategicPurpose Maps a card's printed name to its card keys, because a
 * model is asked about cards by name.
 * @tacticalObjective One row per (title, subtitle) pair, sorted by code
 * point, with the "|"-joined card keys.
 */
export function buildNameIndex(cards: FlatRow[]): FlatRow[] {
  const groups = new Map<string, { title: string; subtitle: string; keys: string[] }>();
  for (const card of cards) {
    const title = cellString(card, "title");
    const subtitle = cellString(card, "subtitle");
    const id = JSON.stringify([title, subtitle]);
    const group = groups.get(id) ?? { title, subtitle, keys: [] };
    group.keys.push(cellString(card, "cardKey"));
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort((a, b) => compareCodePoints(a.title, b.title) || compareCodePoints(a.subtitle, b.subtitle))
    .map((group) => ({ title: group.title, subtitle: group.subtitle, cardKeys: group.keys.sort(compareCodePoints).join("|") }));
}

/**
 * Encodes rows as a TOON tabular array, giving every row the union of columns
 * (in first-seen order) so the library emits one header.
 */
export function encodeToonTable(name: string, rows: readonly FlatRow[]): string {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const uniform = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
  return `${encode({ [name]: uniform })}\n`;
}

export function priceCellsByCardId(
  rows: readonly { cardId: string; productId: number; priceNormal: number | null; priceFoil: number | null }[],
): Map<string, PriceCells> {
  const sorted = [...rows].sort((a, b) => compareCodePoints(a.cardId, b.cardId) || a.productId - b.productId);
  const out = new Map<string, PriceCells>();
  for (const row of sorted) {
    const current = out.get(row.cardId) ?? { priceNormal: null, priceFoil: null };
    out.set(row.cardId, {
      priceNormal: current.priceNormal ?? row.priceNormal,
      priceFoil: current.priceFoil ?? row.priceFoil,
    });
  }
  return out;
}

export interface CurrentSetSplit {
  kept: FlatRow[];
  oldSetsOnly: FlatRow[];
  promoOnly: FlatRow[];
}

/**
 * @displayName SWU current-sets filter
 * @strategicPurpose Keeps the LLM copy to cards a player can use today, because
 * the year-1 sets rotated out and promo-only cards add rows without adding
 * playable cards.
 * @tacticalObjective Keeps a card when any printing is in a set released at or
 * after Jump to Lightspeed (Weekly Play codes count as their base set), using
 * the release-order table so a new set is included on its own. Excluded cards
 * split into those with a known older set and those with only promo-style sets.
 */
export function splitByCurrentSets(cards: readonly FlatRow[]): CurrentSetSplit {
  const floor = swuSetRotation(FIRST_CURRENT_SET)?.releaseOrder;
  if (floor === undefined) throw new Error(`${FIRST_CURRENT_SET} missing from the set release-order table`);
  const split: CurrentSetSplit = { kept: [], oldSetsOnly: [], promoOnly: [] };
  for (const card of cards) {
    const orders = splitList(card.sets).map(setReleaseOrder);
    if (orders.some((order) => order !== UNKNOWN_ORDER && order >= floor)) split.kept.push(card);
    else if (orders.some((order) => order !== UNKNOWN_ORDER)) split.oldSetsOnly.push(card);
    else split.promoOnly.push(card);
  }
  return split;
}
