import { encode } from "@toon-format/toon";
import { z } from "zod";
import { isFacet, splitCell, type CardRow, type CardStore } from "./data.js";
import { INDEX_FACETS } from "./swu/llm-flatten.js";

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

const HIDDEN_DETAIL = new Set([
  "artBack",
  "artBackHorizontal",
  "artFront",
  "artFrontHorizontal",
  "artThumbnail",
  "artist",
  "cardCount",
  "cardId",
  "cardNumber",
  "cardUid",
  "validationId",
  "locale",
  "hasFoil",
  "hyperspace",
  "showcase",
]);

const SUMMARY_COLUMNS = [
  "cardKey",
  "title",
  "subtitle",
  "type",
  "cost",
  "power",
  "hp",
  "aspects",
  "traits",
  "keywords",
  "sets",
  "priceNormal",
] as const;

const facetName = z.enum(INDEX_FACETS);
const limit = z.number().int().min(1).max(200).default(20);

export const getCardShape = {
  cardKey: z.string().min(1).optional().describe("Exact cardKey, for example 0101033"),
  title: z.string().min(1).optional().describe("Exact card title, case-insensitive"),
  subtitle: z.string().optional().describe("Exact subtitle, case-insensitive; narrows a title shared by several leaders"),
};

export const searchCardsShape = {
  query: z.string().optional().describe("Case-insensitive substring over title, subtitle and card text"),
  type: z.string().optional().describe("Card type, for example Unit, Event, Upgrade, Leader, Base"),
  aspect: z.string().optional().describe("Aspect, for example Vigilance or Villainy"),
  trait: z.string().optional().describe("Trait, for example Imperial"),
  keyword: z.string().optional().describe("Keyword, for example Grit"),
  set: z.string().optional().describe("Expansion code the card has a printing in, for example JTL"),
  maxCost: z.number().int().min(0).optional().describe("Highest cost, inclusive; cards without a cost never match"),
  limit,
};

export const listFacetShape = { facet: facetName };

export const cardsByFacetShape = {
  facet: facetName,
  value: z.string().min(1).describe("A value from list_facet, case-insensitive"),
  limit,
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: encode(value) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const lower = (value: string | null | undefined): string => (value ?? "").toLowerCase();

function detail(card: CardRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(card)) {
    if (HIDDEN_DETAIL.has(key) || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function summary(card: CardRow): Record<string, unknown> {
  return Object.fromEntries(SUMMARY_COLUMNS.map((column) => [column, card[column] ?? null]));
}

function hasValue(cell: string | null, wanted: string): boolean {
  const target = wanted.toLowerCase();
  return splitCell(cell).some((item) => item.toLowerCase() === target);
}

export function getCard(store: CardStore, input: unknown): ToolResult {
  const args = z.object(getCardShape).parse(input);
  if (args.cardKey !== undefined) {
    const card = store.byKey.get(args.cardKey);
    return card === undefined ? fail(`no card with cardKey ${args.cardKey}`) : ok({ card: detail(card) });
  }
  if (args.title === undefined) return fail("give cardKey, or title with an optional subtitle");
  const title = args.title.toLowerCase();
  const subtitle = args.subtitle?.toLowerCase();
  const matches = store.cards.filter(
    (card) => lower(card.title) === title && (subtitle === undefined || lower(card.subtitle) === subtitle),
  );
  if (matches.length === 0)
    return fail(`no card titled "${args.title}"${args.subtitle === undefined ? "" : ` with subtitle "${args.subtitle}"`}`);
  return matches.length === 1 ? ok({ card: detail(matches[0]) }) : ok({ cards: matches.map(detail) });
}

export function searchCards(store: CardStore, input: unknown): ToolResult {
  const args = z.object(searchCardsShape).parse(input);
  const needle = args.query === undefined || args.query === "" ? undefined : args.query.toLowerCase();
  const matches = store.cards.filter((card) => {
    if (needle !== undefined && ![card.title, card.subtitle, card.text].some((field) => lower(field).includes(needle))) return false;
    if (args.type !== undefined && lower(card.type) !== args.type.toLowerCase()) return false;
    if (args.aspect !== undefined && !hasValue(card.aspects, args.aspect)) return false;
    if (args.trait !== undefined && !hasValue(card.traits, args.trait)) return false;
    if (args.keyword !== undefined && !hasValue(card.keywords, args.keyword)) return false;
    if (args.set !== undefined && !hasValue(card.sets, args.set)) return false;
    if (args.maxCost !== undefined && (card.cost === null || card.cost > args.maxCost)) return false;
    return true;
  });
  const shown = matches.slice(0, args.limit);
  return ok({ total: matches.length, shown: shown.length, cards: shown.map(summary) });
}

export function listFacet(store: CardStore, input: unknown): ToolResult {
  const { facet } = z.object(listFacetShape).parse(input);
  const entries = store.facets.get(facet);
  if (entries === undefined) return fail(`facet index "${facet}" is not in the loaded package`);
  return ok({
    facet,
    values: entries.map((entry) => ({ value: entry.value, cards: entry.cards, definition: entry.definition })),
  });
}

export function cardsByFacet(store: CardStore, input: unknown): ToolResult {
  const args = z.object(cardsByFacetShape).parse(input);
  if (!isFacet(args.facet)) return fail(`unknown facet ${args.facet}`);
  const entries = store.facets.get(args.facet);
  if (entries === undefined) return fail(`facet index "${args.facet}" is not in the loaded package`);
  const entry = entries.find((candidate) => candidate.value.toLowerCase() === args.value.toLowerCase());
  if (entry === undefined) return fail(`"${args.value}" is not a ${args.facet} value; call list_facet to see them`);
  const cards = entry.cardKeys.flatMap((key) => {
    const card = store.byKey.get(key);
    return card === undefined ? [] : [card];
  });
  const shown = cards.slice(0, args.limit);
  return ok({
    facet: args.facet,
    value: entry.value,
    definition: entry.definition,
    total: cards.length,
    shown: shown.length,
    cards: shown.map(summary),
  });
}

export const TOOLS = {
  get_card: {
    title: "Get a card",
    description:
      "Full detail of one logical card, by cardKey or by exact title (optionally with subtitle). A title shared by several cards returns all of them.",
    shape: getCardShape,
    handler: getCard,
  },
  search_cards: {
    title: "Search cards",
    description:
      "Case-insensitive substring search over title, subtitle and card text, narrowed by optional type, aspect, trait, keyword, set and maxCost filters.",
    shape: searchCardsShape,
    handler: searchCards,
  },
  list_facet: {
    title: "List a facet",
    description:
      "Every value of one facet (aspect, trait, keyword, type, arena, rarity, expansion or variant) with its card count and plain-language definition.",
    shape: listFacetShape,
    handler: listFacet,
  },
  cards_by_facet: {
    title: "Cards by facet value",
    description: "The cards that carry one facet value, for example facet keyword and value Grit.",
    shape: cardsByFacetShape,
    handler: cardsByFacet,
  },
} as const;
