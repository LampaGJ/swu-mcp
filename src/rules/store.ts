/**
 * @displayName Rules store
 * @strategicPurpose Seam gate: the rules files written by scripts/rules-fetch.ts are parsed with Zod here, so the
 * tools never see a malformed section, ruling or replay record.
 * @tacticalObjective Loads sections, rulings, keyword links, the core list, the primer and the replay record from a
 * rules directory and builds one deterministic MiniSearch index over the sections.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import MiniSearch from "minisearch";
import { stemmer } from "stemmer";
import { REPO_ROOT } from "../paths.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { RuleSection } from "./parse-cr.js";
import {
  cardRulingsFileSchema,
  keywordRulesFileSchema,
  rulesCoreFileSchema,
  rulesReplaySchema,
  sectionsFileSchema,
  type CardRulingsFile,
  type KeywordRulesFile,
  type RulesCoreFile,
  type RulesReplay,
  type SectionsFile,
} from "./schemas.js";

const DATED_DIR = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Added to a hit's relevance (best hit of the query = 1.0) when its section is in data/rules-core.json or sits under
 * one of its ids, so a vague query lands on the governing rule. Fixed, not tuned per query.
 */
export const CORE_BOOST = 0.25;

const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does", "for", "how", "i", "if", "in", "is", "it", "of", "on", "or", "the", "to", "what", "when", "with"]);

export interface SearchHit {
  id: string;
  relevance: number;
  score: number;
  core: boolean;
}

export interface RulesStore {
  dir: string;
  document: SectionsFile["document"];
  sections: RuleSection[];
  byId: Map<string, RuleSection>;
  order: Map<string, number>;
  children: Map<string, RuleSection[]>;
  cardRulings: CardRulingsFile | null;
  keywords: KeywordRulesFile;
  coreIds: string[];
  primer: string;
  replay: RulesReplay;
  titlePath(id: string): string;
  search(query: string, limit: number): { total: number; hits: SearchHit[] };
  isCore(id: string): boolean;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** SWU_MCP_RULES wins; then <dataDir>/rules; then the newest data/runs/<date>/rules that holds sections.json. */
export function resolveRulesDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SWU_MCP_RULES;
  if (configured !== undefined && configured !== "") return path.resolve(configured);
  const beside = path.join(dataDir, "rules");
  if (existsSync(path.join(beside, "sections.json"))) return beside;
  const runs = path.join(REPO_ROOT, "data/runs");
  const newest = existsSync(runs)
    ? readdirSync(runs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && DATED_DIR.test(entry.name) && existsSync(path.join(runs, entry.name, "rules/sections.json")))
        .map((entry) => entry.name)
        .sort(compareCodePoints)
        .at(-1)
    : undefined;
  if (newest === undefined) throw new Error(`no rules data under ${runs}; run "pnpm rules:fetch" or set SWU_MCP_RULES`);
  return path.join(runs, newest, "rules");
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => !STOP_WORDS.has(word)).map((word) => stemmer(word));
}

export function loadRules(dir: string, corePath = path.join(REPO_ROOT, "data/rules-core.json")): RulesStore {
  const file = sectionsFileSchema.parse(readJson(path.join(dir, "sections.json")));
  const sections = file.sections;
  const byId = new Map(sections.map((section) => [section.id, section]));
  const order = new Map(sections.map((section, index) => [section.id, index]));
  const children = new Map<string, RuleSection[]>();
  for (const section of sections) {
    if (section.parentId === null) continue;
    children.set(section.parentId, [...(children.get(section.parentId) ?? []), section]);
  }
  const rulingsPath = path.join(dir, "card-rulings.json");
  const cardRulings = existsSync(rulingsPath) ? cardRulingsFileSchema.parse(readJson(rulingsPath)) : null;
  const keywords = keywordRulesFileSchema.parse(readJson(path.join(dir, "keyword_rules.json")));
  const core: RulesCoreFile = rulesCoreFileSchema.parse(readJson(corePath));
  const coreIds = core.entries.map((entry) => entry.id);
  const primerPath = path.join(dir, "core-primer.md");
  const primer = existsSync(primerPath) ? readFileSync(primerPath, "utf8") : "";
  const replay = rulesReplaySchema.parse(readJson(path.join(dir, "replay.json")));

  const titlePath = (id: string): string => {
    const parts: string[] = [];
    for (let current = byId.get(id); current !== undefined; current = current.parentId === null ? undefined : byId.get(current.parentId)) {
      if (current.title !== null || current.id === id) parts.unshift(current.title === null ? current.id : `${current.id} ${current.title}`);
    }
    return parts.join(" > ");
  };

  const isCore = (id: string): boolean => coreIds.some((coreId) => id === coreId || id.startsWith(`${coreId}.`));

  const index = new MiniSearch<{ id: string; title: string; path: string; text: string }>({
    idField: "id",
    fields: ["title", "path", "text"],
    storeFields: [],
    tokenize: (text) => text.split(/[^A-Za-z0-9]+/).filter((word) => word !== ""),
    processTerm: (term) => {
      const lowered = term.toLowerCase();
      return STOP_WORDS.has(lowered) ? null : stemmer(lowered);
    },
    searchOptions: { boost: { title: 6, path: 1.5 }, prefix: false, fuzzy: false, combineWith: "OR" },
  });
  index.addAll(sections.map((section) => ({ id: section.id, title: section.title ?? "", path: titlePath(section.parentId ?? section.id), text: section.text })));

  const search = (query: string, limit: number): { total: number; hits: SearchHit[] } => {
    const raw = index.search(query);
    if (raw.length === 0) return { total: 0, hits: [] };
    const top = Math.max(...raw.map((hit) => hit.score));
    const hits = raw
      .map((hit) => {
        const relevance = Math.round((hit.score / top) * 1e6) / 1e6;
        const core = isCore(hit.id);
        return { id: hit.id, relevance, score: Math.round((relevance + (core ? CORE_BOOST : 0)) * 1e6) / 1e6, core };
      })
      .sort((a, b) => b.score - a.score || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { total: hits.length, hits: hits.slice(0, limit) };
  };

  return { dir, document: file.document, sections, byId, order, children, cardRulings, keywords, coreIds, primer, replay, titlePath, search, isCore };
}

const cache = new Map<string, RulesStore>();

export function rulesFor(dataDir: string): RulesStore {
  const dir = resolveRulesDir(dataDir);
  const cached = cache.get(dir);
  if (cached !== undefined) return cached;
  const loaded = loadRules(dir);
  cache.set(dir, loaded);
  return loaded;
}
