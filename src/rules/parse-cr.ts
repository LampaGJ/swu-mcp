/**
 * @displayName Comprehensive Rules parser
 * @strategicPurpose Manipulation node (reduces): `pdftotext -layout` text of the official Comprehensive Rules in,
 * a flat list of numbered sections out, so assistants can cite rule ids instead of quoting from memory.
 * @tacticalObjective Pure and deterministic. Levels come from the numbering sequence and the page footer, not from
 * raw indentation, because the PDF's indentation drifts between pages (checked on v8.0).
 */
import { compareCodePoints } from "../swu/canonical.js";

export interface RuleSection {
  /** "7", "7.5", "7.5.11", "7.5.11.b". */
  id: string;
  parentId: string | null;
  /** 0 section, 1 subsection, 2 item, 3 lettered sub-item. */
  depth: 0 | 1 | 2 | 3;
  /** Heading text for depth 0/1, and for an item that has lettered children and a short heading line. */
  title: string | null;
  /** Paragraphs joined by "\n"; the first holds the marker line's text. */
  text: string;
  /** Section ids this text points at ("See 8.1."), resolved, unique, in order of appearance. */
  refs: string[];
  /** 1-based PDF page where the section starts. */
  page: number;
}

export interface ParsedRules {
  version: string;
  coverDate: string;
  pages: number;
  preamble: string;
  sections: RuleSection[];
  /** Reference strings that point at no parsed section, and marker-like lines folded into the previous text. */
  anomalies: string[];
  iconGlyphs: number;
}

const FOOTER = /^(\d+)\.\s+(\S.*?)\s{2,}CONTENTS\s+GLOSSARY\s+StarWarsUnlimited\.com\s*\d*\s*$/;
const NUMERIC_MARKER = /^\s*(\d+)\.\s+(\S.*)$/;
const LETTER_MARKER = /^\s*([a-z])\.\s+(\S.*)$/;
const BULLET = /^\s*•\s*/;
const COPYRIGHT = /^\s*© & ™/;
const PRIVATE_USE = /\s*([\uE000-\uF8FF]+)/g;
const VERSION = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[–—-]\s*V\s*(\d+(?:\.\d+)*)/;
/** The PDF draws aspect, exhaust and similar icons as private-use glyphs; their identity is not recoverable from text. */
const ICON = "[icon]";
const SENTENCE_END = /[.!?:”")]$/;

const isAllCaps = (text: string): boolean => !/[a-z]/.test(text.replaceAll("[icon]", ""));
const normalizeTitle = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]+/g, "");

interface Pending {
  node: RuleSection;
  paragraphs: string[];
  open: boolean;
}

function join(previous: string, next: string): string {
  return /[-/]$/.test(previous) ? `${previous}${next}` : `${previous} ${next}`;
}

/** Short heading line on an item that goes on to have lettered children, for example "Ownership and Control". */
function headingOf(first: string): string | null {
  return first.length <= 60 && !/[.:;,?!]$/.test(first) ? first : null;
}

export function parseComprehensiveRules(rawText: string): ParsedRules {
  let iconGlyphs = 0;
  const clean = (value: string): string =>
    value
      .replace(PRIVATE_USE, (_match, run: string) => {
        iconGlyphs += run.length;
        return ` ${[...run].map(() => ICON).join("")}`;
      })
      .replace(/\s+/g, " ")
      .replace(/\( \[icon\]/g, "([icon]")
      .trim();

  const pages = rawText.split("\f");
  if (pages.at(-1)?.trim() === "") pages.pop();
  const cover = VERSION.exec(pages[0] ?? "");
  if (cover === null) throw new Error("no 'D/M/YY – V x.y' version string on the cover page");

  const anomalies: string[] = [];
  const nodes: Pending[] = [];
  const preamble: string[] = [];
  const counters: number[] = [];
  let depth = -1;
  let lastLetter = "";
  let current: Pending | undefined;

  const open = (node: RuleSection, first: string): void => {
    current = { node, paragraphs: [first], open: true };
    nodes.push(current);
  };

  pages.forEach((page, pageIndex) => {
    const lines = page.split("\n");
    const footerLine = lines.findLast((line) => FOOTER.test(line));
    const footer = footerLine === undefined ? null : FOOTER.exec(footerLine);
    if (footer === null) {
      if (nodes.length === 0) preamble.push(...lines.map(clean).filter((line) => line !== ""));
      return;
    }
    const footerSection = Number(footer[1]);
    const footerTitle = normalizeTitle(footer[2]);
    let skipping = false;
    let atPageStart = true;
    for (const line of lines) {
      if (line === footerLine) break;
      if (COPYRIGHT.test(line)) skipping = true;
      if (line.trim() === "") {
        skipping = false;
        if (current) current.open = false;
        continue;
      }
      if (skipping) continue;

      const numeric = NUMERIC_MARKER.exec(line);
      const letter = LETTER_MARKER.exec(line);
      const pageNo = pageIndex + 1;

      if (numeric !== null) {
        const n = Number(numeric[1]);
        const text = clean(numeric[2]);
        const valid = (k: number): boolean => (k <= depth ? n === (counters[k] ?? -2) + 1 : k === depth + 1 && k <= 2 && (n === 1 || (n === 0 && k === 2)));
        let level = -1;
        if (valid(0) && depth >= 0 && n === footerSection && normalizeTitle(text) === footerTitle) level = 0;
        else if (depth === -1 && n === 1 && footerSection === 1 && normalizeTitle(text) === footerTitle) level = 0;
        else {
          const options = [1, 2].filter(valid);
          if (options.length === 1) level = options[0];
          else if (options.length === 2) level = isAllCaps(text) ? options[0] : options[1];
        }
        if (level >= 0) {
          counters.length = level;
          counters[level] = n;
          depth = level;
          lastLetter = "";
          const id = counters.slice(0, level + 1).join(".");
          const parentId = level === 0 ? null : counters.slice(0, level).join(".");
          const heading = level <= 1 ? text : null;
          if (level === 1 && !isAllCaps(text)) anomalies.push(`mixed-case level-1 heading ${id}: ${text}`);
          open({ id, parentId, depth: level as 0 | 1 | 2, title: heading, text: "", refs: [], page: pageNo }, text);
          atPageStart = false;
          continue;
        }
        anomalies.push(`marker-like line folded into text (page ${pageNo}): ${clean(line).slice(0, 60)}`);
      } else if (letter !== null && current !== undefined && depth === 2) {
        const expected = lastLetter === "" ? "a" : String.fromCharCode(lastLetter.charCodeAt(0) + 1);
        if (letter[1] === expected) {
          lastLetter = expected;
          const parentId = counters.slice(0, 3).join(".");
          open({ id: `${parentId}.${expected}`, parentId, depth: 3, title: null, text: "", refs: [], page: pageNo }, clean(letter[2]));
          atPageStart = false;
          continue;
        }
        anomalies.push(`out-of-sequence letter marker folded into text (page ${pageNo}): ${clean(line).slice(0, 60)}`);
      }

      if (current === undefined) continue;
      const text = clean(line);
      const last = current.paragraphs.length - 1;
      const startsNew = BULLET.test(line) || !current.open || (atPageStart && SENTENCE_END.test(current.paragraphs[last]));
      if (startsNew) current.paragraphs.push(text);
      else current.paragraphs[last] = join(current.paragraphs[last], text);
      current.open = true;
      atPageStart = false;
    }
    if (current) current.open = false;
  });

  // An item with lettered children keeps its first line as a heading when it is short; the rest stays text.
  const hasChildren = new Set(nodes.map((entry) => entry.node.parentId));
  const sections = nodes.map(({ node, paragraphs }): RuleSection => {
    const [first, ...rest] = paragraphs;
    if (node.depth === 2 && hasChildren.has(node.id)) {
      const title = headingOf(first);
      return { ...node, title, text: (title === null ? paragraphs : rest).join("\n") };
    }
    return { ...node, text: (node.depth <= 1 ? rest : paragraphs).join("\n") };
  });

  const known = new Set(sections.map((section) => section.id));
  for (const section of sections) {
    const resolved: string[] = [];
    for (const raw of referencesIn(`${section.title ?? ""}\n${section.text}`)) {
      if (known.has(raw)) {
        if (!resolved.includes(raw)) resolved.push(raw);
      } else anomalies.push(`unresolved reference ${raw} in ${section.id}`);
    }
    section.refs = resolved;
  }

  return {
    version: cover[2],
    coverDate: cover[1],
    pages: pages.length,
    preamble: preamble.join("\n"),
    sections,
    anomalies: [...new Set(anomalies)].sort(compareCodePoints),
    iconGlyphs: iconGlyphs,
  };
}

const SEE = /\b[Ss]ee\s+(\d+(?:\.\d+)*)(?:\.?([A-Za-z])(?![A-Za-z]))?/g;
const SECTIONS = /\bSections?\s+(\d+)(?:\s+(?:and|or)\s+(\d+))?/g;

/** Candidate section ids named by "See 7.6.3A" / "See 8.1." / "Sections 11 and 12", in order of appearance. */
export function referencesIn(text: string): string[] {
  const found: { at: number; id: string }[] = [];
  for (const match of text.matchAll(SEE)) {
    found.push({ at: match.index, id: match[2] === undefined ? match[1] : `${match[1]}.${match[2].toLowerCase()}` });
  }
  for (const match of text.matchAll(SECTIONS)) {
    found.push({ at: match.index, id: match[1] });
    if (match[2] !== undefined) found.push({ at: match.index + 1, id: match[2] });
  }
  return found.sort((a, b) => a.at - b.at || compareCodePoints(a.id, b.id)).map((entry) => entry.id);
}
