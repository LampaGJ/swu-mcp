import { canonicalJson, sha256Hex } from "../swu/canonical.js";
import { buildKeywordRules, type GlossaryKeyword } from "./keywords.js";
import { parseComprehensiveRules, type ParsedRules } from "./parse-cr.js";
import { buildCorePrimer, type Primer } from "./primer.js";
import { sectionsFileSchema, type CardRulingsFile, type RulesCoreFile } from "./schemas.js";

export interface RulesRunInput {
  text: string;
  pdfSha256: string;
  glossaryVersion: number;
  glossaryKeywords: readonly GlossaryKeyword[];
  core: RulesCoreFile;
  cardRulings: CardRulingsFile | null;
  primerMaxTokens: number;
  countTokens: (text: string) => number;
}

export interface RulesRun {
  parsed: ParsedRules;
  primer: Primer;
  files: Record<string, string>;
  hashes: Record<string, string>;
}

/** Keys sorted by code point at every depth, so the bytes do not depend on construction order. */
const json = (value: unknown): string => `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 1)}\n`;

/** Pure: the same CR text, glossary, core list and rulings give the same bytes. */
export function buildRulesRun(input: RulesRunInput): RulesRun {
  const parsed = parseComprehensiveRules(input.text);
  const byDepth = [0, 0, 0, 0];
  for (const section of parsed.sections) byDepth[section.depth] += 1;
  const sectionsFile = sectionsFileSchema.parse({
    schemaVersion: 1,
    document: {
      name: "Star Wars: Unlimited Comprehensive Rules",
      version: parsed.version,
      coverDate: parsed.coverDate,
      pages: parsed.pages,
      pdfSha256: input.pdfSha256,
      preamble: parsed.preamble,
    },
    stats: { sections: parsed.sections.length, byDepth, iconGlyphs: parsed.iconGlyphs },
    anomalies: parsed.anomalies,
    sections: parsed.sections,
  });
  const primer = buildCorePrimer(parsed.sections, input.core, {
    maxTokens: input.primerMaxTokens,
    version: parsed.version,
    countTokens: input.countTokens,
  });
  const files: Record<string, string> = {
    "sections.json": json(sectionsFile),
    "keyword_rules.json": json(buildKeywordRules(input.glossaryVersion, input.glossaryKeywords, parsed.sections)),
    "core-primer.md": primer.markdown,
  };
  if (input.cardRulings !== null) files["card-rulings.json"] = json(input.cardRulings);
  const hashes = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, sha256Hex(content)]));
  return { parsed, primer, files, hashes };
}
