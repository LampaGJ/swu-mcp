import { encode } from "@toon-format/toon";
import { z } from "zod";
import type { CardStore } from "../data.js";
import type { RuleSection } from "../rules/parse-cr.js";
import { CORE_BOOST, rulesFor, tokenize, type RulesStore } from "../rules/store.js";
import type { ToolResult } from "../tools.js";

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: encode(value) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const SNIPPET_LENGTH = 220;

export const rulesSearchShape = {
  query: z.string().min(1).describe("Words to look for in the Comprehensive Rules, for example 'aspect penalty' or 'When Defeated'"),
  limit: z.number().int().min(1).max(50).default(10),
};

export const getRuleShape = {
  section: z.string().min(1).describe("Section id such as 7.5.11, 1.6.3.b or 8.1 (a trailing dot and forms like 7.6.3A are accepted)"),
  depth: z.number().int().min(0).max(3).default(1).describe("How many levels of children to include with full text"),
  include: z
    .array(z.enum(["children", "parent", "siblings"]))
    .default(["children"])
    .describe("Which relatives to return: children (to depth), parent, siblings (id and title only)"),
};

export const cardRulingsShape = {
  cardKey: z.string().min(1).optional().describe("Exact cardKey, for example 0101010"),
  title: z.string().min(1).optional().describe("Exact card title, case-insensitive"),
  subtitle: z.string().optional().describe("Exact subtitle, case-insensitive; narrows a title shared by several leaders"),
};

export const keywordRulesShape = {
  keyword: z.string().min(1).describe("A keyword such as Sentinel, Grit or Smuggle"),
};

export const rulesVersionShape = {};
export const rulesCoreShape = {};

/** "7.6.3A" and "7.6.3.A" and "7.6.3." all mean 7.6.3.a. */
export function normalizeSectionId(raw: string): string {
  const text = raw.trim().replace(/^section\s+/i, "").replace(/\.$/, "");
  const match = /^(\d+(?:\.\d+)*)\.?([A-Za-z])?$/.exec(text);
  return match === null ? text : match[2] === undefined ? match[1] : `${match[1]}.${match[2].toLowerCase()}`;
}

function snippetOf(section: RuleSection, query: string): string {
  const text = (section.text === "" ? (section.title ?? "") : section.text).replace(/\s+/g, " ");
  if (text.length <= SNIPPET_LENGTH) return text;
  const wanted = new Set(tokenize(query));
  const words = [...text.matchAll(/[A-Za-z0-9]+/g)];
  const first = words.find((word) => tokenize(word[0]).some((stem) => wanted.has(stem)));
  const start = first === undefined ? 0 : Math.max(0, first.index - 60);
  const from = start === 0 ? 0 : text.indexOf(" ", start) + 1;
  const piece = text.slice(from, from + SNIPPET_LENGTH);
  return `${from > 0 ? "..." : ""}${piece}${from + SNIPPET_LENGTH < text.length ? "..." : ""}`;
}

function meta(rules: RulesStore): Record<string, string> {
  return { rulesVersion: rules.document.version };
}

export function rulesSearch(store: CardStore, input: unknown): ToolResult {
  const args = z.object(rulesSearchShape).parse(input);
  const rules = rulesFor(store.dataDir);
  const { total, hits } = rules.search(args.query, args.limit);
  return ok({
    ...meta(rules),
    query: args.query,
    coreBoost: CORE_BOOST,
    total,
    shown: hits.length,
    results: hits.map((hit) => {
      const section = rules.byId.get(hit.id) as RuleSection;
      return { id: hit.id, path: rules.titlePath(hit.id), snippet: snippetOf(section, args.query), score: hit.score, core: hit.core };
    }),
  });
}

function view(section: RuleSection, rules: RulesStore, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { id: section.id, title: section.title, text: section.text, page: section.page };
  if (depth > 0) {
    const kids = rules.children.get(section.id) ?? [];
    if (kids.length > 0) out.children = kids.map((kid) => view(kid, rules, depth - 1));
  }
  return out;
}

export function getRule(store: CardStore, input: unknown): ToolResult {
  const args = z.object(getRuleShape).parse(input);
  const rules = rulesFor(store.dataDir);
  const id = normalizeSectionId(args.section);
  const section = rules.byId.get(id);
  if (section === undefined) return fail(`no rule section ${id} in Comprehensive Rules v${rules.document.version}; use rules_search to find one`);
  const brief = (target: RuleSection): Record<string, unknown> => ({ id: target.id, title: target.title ?? target.text.slice(0, 80) });
  const result: Record<string, unknown> = {
    ...meta(rules),
    path: rules.titlePath(id),
    rule: view(section, rules, args.include.includes("children") ? args.depth : 0),
    links: section.refs.map((ref) => brief(rules.byId.get(ref) as RuleSection)),
  };
  if (args.include.includes("parent") && section.parentId !== null) result.parent = brief(rules.byId.get(section.parentId) as RuleSection);
  if (args.include.includes("siblings")) {
    const peers = section.parentId === null ? rules.sections.filter((s) => s.parentId === null) : (rules.children.get(section.parentId) ?? []);
    result.siblings = peers.filter((peer) => peer.id !== id).map(brief);
  }
  return ok(result);
}

export function cardRulings(store: CardStore, input: unknown): ToolResult {
  const args = z.object(cardRulingsShape).parse(input);
  const rules = rulesFor(store.dataDir);
  if (rules.cardRulings === null) return fail("this rules run has no card-rulings.json; run pnpm rules:fetch without --skip-rulings");
  if (args.cardKey === undefined && args.title === undefined) return fail("give cardKey, or title with an optional subtitle");
  const source = { rulingsRun: rules.cardRulings.source.originalsRun, rulesVersion: rules.document.version };
  const entries = rules.cardRulings.cards;
  const hits =
    args.cardKey !== undefined
      ? entries.filter((entry) => entry.cardKey === args.cardKey)
      : entries.filter(
          (entry) =>
            entry.title.toLowerCase() === (args.title as string).toLowerCase() &&
            (args.subtitle === undefined || (entry.subtitle ?? "").toLowerCase() === args.subtitle.toLowerCase()),
        );
  if (hits.length > 0) {
    const cards = hits.map((entry) => ({
      cardKey: entry.cardKey,
      title: entry.title,
      subtitle: entry.subtitle,
      rulings: entry.rulings.map((ruling) => ({ ...ruling, dated: ruling.date !== null })),
    }));
    return ok({ ...source, cards });
  }
  const known =
    args.cardKey !== undefined
      ? store.byKey.get(args.cardKey)
      : store.cards.find((card) => card.title.toLowerCase() === (args.title as string).toLowerCase());
  if (known === undefined) return fail(`no card ${args.cardKey ?? args.title} in the loaded package`);
  return ok({ ...source, cards: [{ cardKey: known.cardKey, title: known.title, subtitle: known.subtitle, rulings: [] }] });
}

export function keywordRules(store: CardStore, input: unknown): ToolResult {
  const args = z.object(keywordRulesShape).parse(input);
  const rules = rulesFor(store.dataDir);
  const entry = rules.keywords.keywords.find((candidate) => candidate.keyword.toLowerCase() === args.keyword.trim().toLowerCase());
  if (entry === undefined) return fail(`"${args.keyword}" is not a glossary keyword; known: ${rules.keywords.keywords.map((k) => k.keyword).join(", ")}`);
  const sections = entry.sections.map((id) => {
    const section = rules.byId.get(id) as RuleSection;
    return view(section, rules, 3);
  });
  return ok({
    ...meta(rules),
    keyword: entry.keyword,
    definition: entry.definition,
    sections,
    inCr: entry.sections.length > 0,
    mentionedIn: entry.mentionedIn,
  });
}

export function rulesVersion(store: CardStore): ToolResult {
  const rules = rulesFor(store.dataDir);
  const { replay, document } = rules;
  return ok({
    rulesVersion: document.version,
    coverDate: document.coverDate,
    pages: document.pages,
    sections: rules.sections.length,
    pdfSha256: document.pdfSha256,
    sourceUrl: replay.source.url,
    fetchedAt: replay.source.fetchedAt,
    rulingsSource: replay.rulings,
    outputs: replay.outputs,
    codeCommit: replay.tool.codeCommit,
  });
}

export function rulesCore(store: CardStore): ToolResult {
  const rules = rulesFor(store.dataDir);
  if (rules.primer === "") return fail("this rules run has no core-primer.md; run pnpm rules:fetch");
  return { content: [{ type: "text", text: rules.primer }] };
}

export const RULES_TOOLS = {
  rules_core: {
    title: "Core rules primer",
    description:
      "Read this first for any rules question: the verbatim text of the core Comprehensive Rules (golden rules, round structure, resources and cost, attacks, card types and zones, triggers, damage, keywords, effects, tokens), each line prefixed by its section id.",
    shape: rulesCoreShape,
    handler: (store: CardStore) => rulesCore(store),
  },
  rules_search: {
    title: "Search the rules",
    description:
      "Ranked keyword search over the official Comprehensive Rules sections. Returns section id, title path, snippet and score; sections in the core rules list get a fixed boost. Follow up with get_rule.",
    shape: rulesSearchShape,
    handler: rulesSearch,
  },
  get_rule: {
    title: "Get a rule",
    description:
      "One Comprehensive Rules section by id (for example 7.5.11 or 1.6.3.b) with its children, optional parent and siblings, and the sections it cross-references.",
    shape: getRuleShape,
    handler: getRule,
  },
  card_rulings: {
    title: "Card rulings",
    description: "Official rulings for one card, by cardKey or by exact title: dated rulings newest first, then undated ones (date null, dated false, source rules: the card text carries them with no date). Quote dated rulings with their date; say plainly when a ruling is undated.",
    shape: cardRulingsShape,
    handler: cardRulings,
  },
  keyword_rules: {
    title: "Keyword rules",
    description: "The glossary definition of a keyword and the Comprehensive Rules sections that define it (with their text), plus sections that mention it.",
    shape: keywordRulesShape,
    handler: keywordRules,
  },
  rules_version: {
    title: "Rules version",
    description: "Which Comprehensive Rules the rules tools use: version, cover date, PDF sha256, fetch date and the rulings source hash. Report this with every rules answer.",
    shape: rulesVersionShape,
    handler: (store: CardStore) => rulesVersion(store),
  },
} as const;
