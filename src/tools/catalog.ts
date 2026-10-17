import MiniSearch from "minisearch";
import { z } from "zod";
import { splitCell, type CardRow, type CardStore } from "../data.js";
import { rulesFor } from "../rules/store.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { ToolResult } from "../tools.js";
import { ok, fail } from "./common.js";

/**
 * @displayName Catalog tools
 * @strategicPurpose Read-only lookups an assistant needs before any deeper tool: many cards in one call, a typo-tolerant
 * name resolver, printings, sets, format legality and a ruling search.
 * @tacticalObjective Answers from the shipped card table, its expansion index and card-rulings.json only. Set legality is
 * parsed from the expansion definitions, so a set whose note is not understood reads "unknown", never "legal".
 */

const FORMATS = ["premier", "eternal", "twin_suns"] as const;

const DEFAULT_BATCH_FIELDS = ["cardKey", "title", "subtitle", "type", "cost", "power", "hp", "aspects", "traits", "keywords", "arenas", "text", "sets"];

export const getCardsBatchShape = {
  cardKeys: z.array(z.string().min(1)).min(1).max(50).describe("Exact cardKeys, for example 0101033"),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(`Columns to return per card; default ${DEFAULT_BATCH_FIELDS.join(", ")}. Add priceNormal, rarity, firstSet or any other card column.`),
};

export const resolveCardNameShape = {
  text: z.string().min(1).describe("A name or partial name, typos and missing accents tolerated, for example 'dath troper'"),
  limit: z.number().int().min(1).max(20).default(5),
};

export const getPrintingsShape = {
  cardKey: z.string().min(1).describe("Exact cardKey, for example 0101033"),
};

export const listSetsShape = {};

export const formatLegalityShape = {
  cardKey: z.string().min(1).describe("Exact cardKey, for example 0101033"),
  format: z.enum(FORMATS).optional().describe("One format; default all three"),
};

export const searchRulingsShape = {
  query: z.string().min(1).optional().describe("Words that must all appear in the ruling text, case-insensitive"),
  keyword: z.string().min(1).optional().describe("A keyword such as Raid: rulings on cards that carry it, or whose text names it"),
  since: z.iso.date().optional().describe("Only dated rulings on or after this date (YYYY-MM-DD); undated rulings are left out"),
  limit: z.number().int().min(1).max(100).default(20),
};

interface SetInfo {
  code: string;
  name: string;
  kind: "main" | "weekly_play" | "promo";
  mainSet: number | null;
  released: string | null;
  premier: "legal" | "rotated" | "by_card" | "unknown";
  premierAsOf: string | null;
  cards: number;
  printings: number | null;
}

const setsCache = new WeakMap<CardStore, Map<string, SetInfo>>();

function parseSet(code: string, cards: number, definition: string): Omit<SetInfo, "premier" | "premierAsOf"> & { premier: SetInfo["premier"] | "inherit"; parent: string | null; premierAsOf: string | null } {
  const name = /^(.*?)(?:\. |: )/.exec(definition)?.[1] ?? code;
  const main = /Main set (\d+)/.exec(definition);
  const weekly = /go with main set (\d+) \(([A-Z0-9]+)\)/.exec(definition);
  const kind = main !== null ? "main" : weekly !== null ? "weekly_play" : "promo";
  const premier: SetInfo["premier"] | "inherit" =
    kind === "promo" ? "by_card" : kind === "weekly_play" ? "inherit" : /Premier legal/.test(definition) ? "legal" : /Premier rotated/.test(definition) ? "rotated" : "unknown";
  return {
    code,
    name,
    kind,
    mainSet: Number((main ?? weekly)?.[1] ?? Number.NaN) || null,
    released: /released (\d{4}-\d{2}-\d{2})/.exec(definition)?.[1] ?? null,
    premier,
    premierAsOf: /legal as of (\d{4}-\d{2}-\d{2})/.exec(definition)?.[1] ?? null,
    cards,
    printings: Number(/(\d+) printings/.exec(definition)?.[1] ?? Number.NaN) || null,
    parent: weekly?.[2] ?? null,
  };
}

function setsOf(store: CardStore): Map<string, SetInfo> {
  const hit = setsCache.get(store);
  if (hit !== undefined) return hit;
  const parsed = (store.facets.get("expansion") ?? []).map((entry) => parseSet(entry.value, entry.cards, entry.definition ?? ""));
  const byCode = new Map(parsed.map((set) => [set.code, set]));
  const sets = new Map<string, SetInfo>();
  for (const { parent, ...set } of parsed) {
    const premier = set.premier === "inherit" ? ((parent === null ? undefined : byCode.get(parent)?.premier) ?? "unknown") : set.premier;
    sets.set(set.code, { ...set, premier: premier === "inherit" ? "unknown" : premier });
  }
  setsCache.set(store, sets);
  return sets;
}

export function getCardsBatch(store: CardStore, input: unknown): ToolResult {
  const args = z.object(getCardsBatchShape).parse(input);
  const fields = args.fields ?? DEFAULT_BATCH_FIELDS;
  const known = new Set(Object.keys(store.cards[0] ?? {}));
  const unknown = fields.filter((field) => !known.has(field));
  if (unknown.length > 0) return fail(`unknown field ${unknown.join(", ")}; card columns are ${[...known].join(", ")}`);
  const found = args.cardKeys.flatMap((key) => {
    const card = store.byKey.get(key);
    return card === undefined ? [] : [card];
  });
  if (found.length === 0) return fail(`none of ${args.cardKeys.length} cardKeys is in the loaded package`);
  const missing = args.cardKeys.filter((key) => !store.byKey.has(key));
  return ok({
    found: found.length,
    missing,
    cards: found.map((card) => Object.fromEntries(fields.map((field) => [field, card[field] ?? null]))),
  });
}

const normalizeName = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "");

// Hand-rolled Levenshtein for the fuzzy-match tie-break: MiniSearch reports a score, not an edit distance.
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    previous = row;
  }
  return previous[b.length];
}

const nameIndexCache = new WeakMap<CardStore, MiniSearch<{ id: string; title: string; subtitle: string }>>();

function nameIndexOf(store: CardStore): MiniSearch<{ id: string; title: string; subtitle: string }> {
  const hit = nameIndexCache.get(store);
  if (hit !== undefined) return hit;
  const index = new MiniSearch<{ id: string; title: string; subtitle: string }>({
    idField: "id",
    fields: ["title", "subtitle"],
    tokenize: (text) => normalizeName(text).split(/[^a-z0-9]+/).filter((word) => word !== ""),
    searchOptions: { boost: { title: 2 }, prefix: true, fuzzy: 0.25, combineWith: "OR" },
  });
  index.addAll(store.cards.map((card) => ({ id: card.cardKey, title: card.title, subtitle: card.subtitle ?? "" })));
  nameIndexCache.set(store, index);
  return index;
}

export function resolveCardName(store: CardStore, input: unknown): ToolResult {
  const args = z.object(resolveCardNameShape).parse(input);
  const wanted = normalizeName(args.text).trim();
  const isExact = (card: CardRow): boolean =>
    [card.title, card.subtitle === null ? card.title : `${card.title} ${card.subtitle}`, card.subtitle === null ? card.title : `${card.title}, ${card.subtitle}`].some(
      (name) => normalizeName(name) === wanted,
    );
  const ranked = nameIndexOf(store)
    .search(args.text)
    .map((hit) => ({ card: store.byKey.get(hit.id) as CardRow, score: Math.round(hit.score * 1e4) / 1e4 }))
    .map((row) => ({
      ...row,
      exact: isExact(row.card),
      distance: Math.min(editDistance(wanted, normalizeName(row.card.title)), editDistance(wanted, normalizeName(`${row.card.title} ${row.card.subtitle ?? ""}`.trim()))),
    }))
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.distance - b.distance || compareCodePoints(a.card.cardKey, b.card.cardKey));
  const shown = ranked.slice(0, args.limit);
  return ok({
    text: args.text,
    total: ranked.length,
    shown: shown.length,
    candidates: shown.map(({ card, score, exact, distance }) => ({
      cardKey: card.cardKey,
      title: card.title,
      subtitle: card.subtitle,
      type: card.type,
      match: exact ? "exact" : "fuzzy",
      score,
      distance,
    })),
  });
}

export function getPrintings(store: CardStore, input: unknown): ToolResult {
  const args = z.object(getPrintingsShape).parse(input);
  const card = store.byKey.get(args.cardKey);
  if (card === undefined) return fail(`no card with cardKey ${args.cardKey}`);
  const sets = setsOf(store);
  return ok({
    cardKey: card.cardKey,
    title: card.title,
    subtitle: card.subtitle,
    printingCount: card.printingCount ?? null,
    firstSet: card.firstSet ?? null,
    canonicalSet: card.expansion ?? null,
    canonicalCardNumber: card.cardNumber ?? null,
    canonicalRarity: card.rarity ?? null,
    imageStem: card.artFront ?? null,
    thumbnailStem: card.artThumbnail ?? null,
    variants: splitCell(card.variants as string | null),
    sets: splitCell(card.sets).map((code) => {
      const set = sets.get(code);
      return { set: code, name: set?.name ?? null, kind: set?.kind ?? null, premier: set?.premier ?? "unknown" };
    }),
    limits: "The shipped package keeps one row per card: the number, rarity and image shown are the canonical printing's. Per-printing numbers and rarities, and the raw 49 fields, are not in it.",
  });
}

export function listSets(store: CardStore): ToolResult {
  const rows = [...setsOf(store).values()].sort((a, b) => compareCodePoints(a.code, b.code));
  return ok({
    total: rows.length,
    sets: rows,
    limits:
      "Parsed from the expansion notes in the data package. released is filled only where the note states it; premierAsOf is the date the note says Premier legality was checked. cards counts only cards in the package. Eternal and Twin Suns allow every card.",
  });
}

export function formatLegality(store: CardStore, input: unknown): ToolResult {
  const args = z.object(formatLegalityShape).parse(input);
  const card = store.byKey.get(args.cardKey);
  if (card === undefined) return fail(`no card with cardKey ${args.cardKey}`);
  const sets = setsOf(store);
  const codes = splitCell(card.sets);
  const legalIn = codes.filter((code) => sets.get(code)?.premier === "legal");
  const unknownIn = codes.filter((code) => (sets.get(code)?.premier ?? "unknown") === "unknown");
  const premier =
    legalIn.length > 0
      ? { legal: true as boolean | null, reason: `printed in ${legalIn.join(", ")}, in a Premier-legal set` }
      : unknownIn.length > 0
        ? { legal: null, reason: `legality of ${unknownIn.join(", ")} is not stated in the data` }
        : { legal: false, reason: `printed only in rotated or promo sets (${codes.join(", ")})` };
  const everything = { legal: true as boolean | null, reason: "the data states Eternal and Twin Suns allow every card" };
  const byFormat = { premier, eternal: everything, twin_suns: everything };
  const wanted = args.format === undefined ? FORMATS : [args.format];
  return ok({
    cardKey: card.cardKey,
    title: card.title,
    subtitle: card.subtitle,
    formats: wanted.map((format) => ({ format, ...byFormat[format] })),
    limits:
      "Current set-based legality only. The package holds no ban or suspension list and no legality history, so a banned or suspended card still reads legal and asOf dates are not supported. Check the official site before an event.",
  });
}

export function searchRulings(store: CardStore, input: unknown): ToolResult {
  const args = z.object(searchRulingsShape).parse(input);
  const rules = rulesFor(store.dataDir);
  if (rules.cardRulings === null) return fail("this rules run has no card-rulings.json; run pnpm rules:fetch without --skip-rulings");
  const terms = (args.query ?? "").toLowerCase().split(/\s+/).filter((term) => term !== "");
  const keyword = args.keyword?.trim().toLowerCase();
  const keywordWord = keyword === undefined ? undefined : new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const rows = rules.cardRulings.cards.flatMap((entry) => {
    const carries = keyword !== undefined && splitCell(store.byKey.get(entry.cardKey)?.keywords).some((item) => item.toLowerCase() === keyword);
    return entry.rulings
      .filter((ruling) => {
        const text = ruling.text.toLowerCase();
        if (!terms.every((term) => text.includes(term))) return false;
        if (keywordWord !== undefined && !carries && !keywordWord.test(ruling.text)) return false;
        return args.since === undefined || (ruling.date !== null && ruling.date >= args.since);
      })
      .map((ruling) => ({ cardKey: entry.cardKey, title: entry.title, subtitle: entry.subtitle, date: ruling.date, dated: ruling.date !== null, text: ruling.text }));
  });
  rows.sort(
    (a, b) =>
      Number(b.dated) - Number(a.dated) ||
      compareCodePoints(b.date ?? "", a.date ?? "") ||
      compareCodePoints(a.cardKey, b.cardKey) ||
      compareCodePoints(a.text, b.text),
  );
  const shown = rows.slice(0, args.limit);
  return ok({
    rulingsRun: rules.cardRulings.source.originalsRun,
    rulesVersion: rules.document.version,
    total: rows.length,
    shown: shown.length,
    rulings: shown,
    limits: "Filters by text, keyword and date only. Linking a ruling to a Comprehensive Rules section is not available; use rules_search for that.",
  });
}

export const CATALOG_TOOLS = {
  get_cards_batch: {
    title: "Get many cards",
    description:
      "Up to 50 cards by cardKey in one call, projected to the columns you name (default: identity, stats, aspects, traits, keywords, arenas, text, sets). Unknown cardKeys are listed in missing.",
    shape: getCardsBatchShape,
    handler: getCardsBatch,
  },
  resolve_card_name: {
    title: "Resolve a card name",
    description:
      "Typo-tolerant name lookup: turns a rough or partial name (voice transcript, scan guess) into ranked candidate cards with cardKey, match kind (exact or fuzzy), score and edit distance to the name (ties on score break by distance). Use the cardKey with the other tools.",
    shape: resolveCardNameShape,
    handler: resolveCardName,
  },
  get_printings: {
    title: "Printings of a card",
    description:
      "Where a card is printed: every set it appears in (with set name and Premier status), printing count, variants, and the canonical printing's number, rarity and image file stem. The package keeps no per-printing rows, so numbers and rarities of other printings are not available.",
    shape: getPrintingsShape,
    handler: getPrintings,
  },
  list_sets: {
    title: "List sets",
    description:
      "Every expansion in the data with code, name, kind (main, weekly_play, promo), main set number, release date when stated, Premier status and card count. Parsed from the expansion notes, so dates are present only where the notes state them.",
    shape: listSetsShape,
    handler: (store: CardStore) => listSets(store),
  },
  format_legality: {
    title: "Format legality",
    description:
      "Whether a card is legal in Premier, Eternal and Twin Suns, with the reason. Premier follows its set printings; Eternal and Twin Suns allow every card. Current state only: there is no ban or suspension list in the data, so a banned card still reads legal.",
    shape: formatLegalityShape,
    handler: formatLegality,
  },
  search_rulings: {
    title: "Search rulings",
    description:
      "Search all official card rulings by text, keyword and date (newest first; undated rulings last and excluded by since). Returns card, date, ruling text. Cannot filter by Comprehensive Rules section.",
    shape: searchRulingsShape,
    handler: searchRulings,
  },
} as const;
