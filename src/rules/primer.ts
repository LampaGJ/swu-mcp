/**
 * @displayName Core rules primer builder
 * @strategicPurpose Manipulation node (reduces): the owner's ordered list of core rule ids plus the parsed
 * Comprehensive Rules in, one short markdown primer of verbatim rule text out, so an assistant reads the governing
 * rules before it searches.
 * @tacticalObjective Every entry starts as its own item plus "see" lines for its children (abridged when the item is only a heading). Entries are then promoted
 * to full text (item and all descendants) in list order while the primer stays within the token budget, so the
 * topics listed first keep the most text. Same sections and list give the same bytes.
 */
import type { RuleSection } from "./parse-cr.js";
import type { RulesCoreFile } from "./schemas.js";

export interface PrimerOptions {
  maxTokens: number;
  version: string;
  countTokens: (text: string) => number;
}

export interface Primer {
  markdown: string;
  tokens: number;
  fullIds: string[];
  outlineIds: string[];
}

export function assertCoreIdsExist(core: RulesCoreFile, sections: readonly RuleSection[]): void {
  const known = new Set(sections.map((section) => section.id));
  const missing = core.entries.filter((entry) => !known.has(entry.id)).map((entry) => entry.id);
  if (missing.length > 0) throw new Error(`rules-core.json names ids that are not in sections.json: ${missing.join(", ")}`);
}

function line(section: RuleSection): string {
  const text = section.text.replace(/\n/g, "\n  ");
  const head = section.title === null ? `[${section.id}]` : `[${section.id}] ${section.title}`;
  if (text === "") return head;
  return section.title === null ? `${head} ${text}` : `${head}: ${text}`;
}

const ABRIDGED_MAX = 70;

/** Child id plus its heading, or its first sentence cut at 70 characters, marked "..." when shortened. */
function abridged(section: RuleSection): string {
  const first = section.text.split("\n")[0];
  const sentenceEnd = first.search(/[.:?!](\s|$)/);
  const cut = sentenceEnd >= 0 ? first.slice(0, sentenceEnd + 1) : first;
  const short = cut.length > ABRIDGED_MAX ? `${cut.slice(0, ABRIDGED_MAX).trimEnd()}...` : cut;
  const body = section.title ?? short;
  return `  see [${section.id}] ${body}`;
}

export function buildCorePrimer(sections: readonly RuleSection[], core: RulesCoreFile, options: PrimerOptions): Primer {
  assertCoreIdsExist(core, sections);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const childrenOf = (id: string): RuleSection[] => sections.filter((section) => section.parentId === id);
  const descendantsOf = (id: string): RuleSection[] => sections.filter((section) => section.id.startsWith(`${id}.`));

  const render = (full: ReadonlySet<string>): string => {
    const blocks = core.entries.map((entry) => {
      const own = byId.get(entry.id) as RuleSection;
      if (full.has(entry.id)) return [`## ${entry.topic}`, line(own), ...descendantsOf(entry.id).map(line)].join("\n");
      const kids = childrenOf(entry.id);
      const outline = own.text !== "" ? (kids.length === 0 ? [] : [`  see: ${kids.map((kid) => kid.id).join(", ")}`]) : kids.map(abridged);
      return [`## ${entry.topic}`, line(own), ...outline].join("\n");
    });
    return [
      `# Star Wars: Unlimited Comprehensive Rules v${options.version}: core primer`,
      'Verbatim official text, each line prefixed by its section id. A "see" line points at child rules and abridges them when the parent has no text of its own; read the full text with get_rule.',
      "",
      blocks.join("\n\n"),
      "",
    ].join("\n");
  };

  const full = new Set(core.entries.filter((entry) => childrenOf(entry.id).length > 0).map((entry) => entry.id));
  for (const entry of [...core.entries].reverse()) {
    if (options.countTokens(render(full)) <= options.maxTokens) break;
    full.delete(entry.id);
  }
  const markdown = render(full);
  return {
    markdown,
    tokens: options.countTokens(markdown),
    fullIds: core.entries.map((entry) => entry.id).filter((id) => full.has(id)),
    outlineIds: core.entries.map((entry) => entry.id).filter((id) => !full.has(id)),
  };
}
