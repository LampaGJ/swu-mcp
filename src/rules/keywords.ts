/**
 * @displayName Keyword to rule-section linker
 * @strategicPurpose Manipulation node (expands): glossary keywords in, Comprehensive Rules sections out, so a
 * keyword question lands on the governing rule instead of a model's memory of it.
 * @tacticalObjective Deterministic heading match: a section defines keyword K when its heading, minus a trailing
 * parameter such as "X" or "[Y]", equals K ignoring case. Other sections that name K as a whole word are listed as mentions.
 */
import { compareCodePoints } from "../swu/canonical.js";
import type { KeywordRulesFile } from "./schemas.js";
import type { RuleSection } from "./parse-cr.js";

export interface GlossaryKeyword {
  value: string;
  definition?: string | null | undefined;
}

const PARAMETER = /\s*(\[[A-Za-z]\]|[XY])$/;
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function headingKey(title: string | null): string | null {
  return title === null ? null : title.replace(PARAMETER, "").trim().toLowerCase();
}

export function buildKeywordRules(
  glossaryVersion: number,
  keywords: readonly GlossaryKeyword[],
  sections: readonly RuleSection[],
): KeywordRulesFile {
  const rows = [...keywords]
    .sort((a, b) => compareCodePoints(a.value, b.value))
    .map((entry) => {
      const key = entry.value.toLowerCase();
      const defining = sections.filter((section) => section.depth >= 1 && headingKey(section.title) === key);
      const ownIds = new Set(defining.map((section) => section.id));
      const inside = (id: string): boolean => [...ownIds].some((own) => id === own || id.startsWith(`${own}.`));
      const word = new RegExp(`(?<![A-Za-z])${escapeRegExp(entry.value)}(?![A-Za-z])`);
      const mentioned = sections.filter((section) => !inside(section.id) && word.test(`${section.title ?? ""}\n${section.text}`));
      return {
        keyword: entry.value,
        definition: entry.definition ?? null,
        sections: defining.map((section) => section.id),
        mentionedIn: mentioned.map((section) => section.id),
      };
    });
  return { schemaVersion: 1, glossaryVersion, keywords: rows };
}
