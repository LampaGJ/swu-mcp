/**
 * @displayName Per-card rulings extractor
 * @strategicPurpose Manipulation node (reduces): raw card-list pages in, one deduplicated dated ruling list per
 * logical card out, because a ruling printed on four printings is still one ruling.
 * @tacticalObjective Reads the HTML table in `rulesStyled` (date cell, text cell per row), keyed by the logical
 * cardKey that buildLogicalCards would give the printing. Dates are M/D/YYYY in the source and ISO here.
 */
import * as cheerio from "cheerio";
import { compareCodePoints } from "../swu/canonical.js";
import { flattenPrinting, newFlattenIssues, printingCardKeys, type FlatRow, type RawCardRecord } from "../swu/llm-flatten.js";
import type { CardRulingsFile } from "./schemas.js";

export type RulingSource = "rulesStyled" | "rules";

export interface Ruling {
  /** ISO date for a styled (dated) row; null for a plain `rules` line that has no styled row. */
  date: string | null;
  source: RulingSource;
  text: string;
}

/** The key two ruling texts share when they differ only in whitespace or quote style. */
export function normaliseRulingText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Non-empty plain `rules` lines, whitespace-collapsed but with the source's own quotes kept. */
export function plainRulesLines(rules: unknown): string[] {
  if (typeof rules !== "string") return [];
  return rules
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line !== "");
}

function isoDate(raw: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (match === null) throw new Error(`unrecognised ruling date "${raw}"`);
  const [month, day, year] = [Number(match[1]), Number(match[2]), match[3]];
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`implausible ruling date "${raw}"`);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Icon images become the same <token> style the plain `rules` field uses for the unique icon ("<uq>"). */
function iconToken(src: string): string {
  const name = /icon_([a-z]+)/.exec(src.split("/").at(-1) ?? "")?.[1] ?? "icon";
  return name === "unique" ? "<uq>" : `<${name}>`;
}

export function parseRulesStyled(html: string): Ruling[] {
  const $ = cheerio.load(html, null, false);
  const rulings: Ruling[] = [];
  $("tr").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length !== 2) throw new Error(`ruling row with ${cells.length} cells`);
    const body = cells.eq(1);
    body.find("img").each((__, img) => {
      $(img).replaceWith($("<span></span>").text(iconToken($(img).attr("src") ?? "")));
    });
    rulings.push({ date: isoDate(cells.eq(0).text()), source: "rulesStyled", text: body.text().replace(/\s+/g, " ").trim() });
  });
  return rulings;
}

/** Dated rulings newest first (then text), then undated rulings by text. */
export function compareRulings(a: Ruling, b: Ruling): number {
  if (a.date === null || b.date === null) {
    if (a.date !== null) return -1;
    if (b.date !== null) return 1;
    return compareCodePoints(a.text, b.text);
  }
  return compareCodePoints(b.date, a.date) || compareCodePoints(a.text, b.text);
}

export function buildCardRulings(
  records: readonly RawCardRecord[],
  source: CardRulingsFile["source"],
): CardRulingsFile {
  const issues = newFlattenIssues();
  const printings: FlatRow[] = records.map((record) => flattenPrinting(record, issues));
  const keys = printingCardKeys(printings);
  const titles = new Map<string, { title: string; subtitle: string | null }>();
  const printingCount = new Map<string, number>();
  const styledByCard = new Map<string, Map<string, Ruling>>();
  const undatedByCard = new Map<string, Map<string, Ruling>>();
  const plainTexts = new Set<string>();
  const printingHasRuling = new Set<number>();
  let rulingRows = 0;

  records.forEach((record, index) => {
    const row = printings[index];
    const serial = String(row.serialCode);
    const cardKey = keys.get(serial) as string;
    printingCount.set(cardKey, (printingCount.get(cardKey) ?? 0) + 1);
    if (serial === cardKey) {
      titles.set(cardKey, { title: String(row.title ?? ""), subtitle: typeof row.subtitle === "string" && row.subtitle !== "" ? row.subtitle : null });
    }
    const styled = record.attributes.rulesStyled;
    const rulings = typeof styled === "string" && styled.includes("<tr") ? parseRulesStyled(styled) : [];
    if (rulings.length > 0) {
      printingHasRuling.add(index);
      const bucket = styledByCard.get(cardKey) ?? new Map<string, Ruling>();
      styledByCard.set(cardKey, bucket);
      for (const ruling of rulings) {
        rulingRows += 1;
        bucket.set(`${ruling.date}\u0000${ruling.text}`, ruling);
      }
    }
  });

  records.forEach((record, index) => {
    const cardKey = keys.get(String(printings[index].serialCode)) as string;
    const styledKeys = new Set([...(styledByCard.get(cardKey)?.values() ?? [])].map((ruling) => normaliseRulingText(ruling.text)));
    for (const line of plainRulesLines(record.attributes.rules)) {
      printingHasRuling.add(index);
      if (typeof record.attributes.rules === "string") plainTexts.add(record.attributes.rules);
      const key = normaliseRulingText(line);
      if (styledKeys.has(key)) continue;
      const bucket = undatedByCard.get(cardKey) ?? new Map<string, Ruling>();
      undatedByCard.set(cardKey, bucket);
      rulingRows += 1;
      if (!bucket.has(key)) bucket.set(key, { date: null, source: "rules", text: line });
    }
  });

  const dated = new Set<string>();
  const undated = new Set<string>();
  const texts = new Set<string>();
  const cardKeys = [...new Set([...styledByCard.keys(), ...undatedByCard.keys()])].sort(compareCodePoints);
  const cards = cardKeys.map((cardKey) => {
    const rulings = [...(styledByCard.get(cardKey)?.values() ?? []), ...(undatedByCard.get(cardKey)?.values() ?? [])].sort(compareRulings);
    for (const ruling of rulings) {
      if (ruling.date === null) undated.add(`${cardKey}\u0000${normaliseRulingText(ruling.text)}`);
      else dated.add(`${ruling.date}\u0000${ruling.text}`);
      texts.add(ruling.text);
    }
    const names = titles.get(cardKey) ?? { title: "", subtitle: null };
    return { cardKey, title: names.title, subtitle: names.subtitle, printings: printingCount.get(cardKey) ?? 0, rulings };
  });

  return {
    schemaVersion: 1,
    source,
    stats: {
      printingsWithRulings: printingHasRuling.size,
      logicalCardsWithRulings: cards.length,
      distinctRulesFields: plainTexts.size,
      distinctRulingTexts: texts.size,
      distinctDatedRulings: dated.size,
      distinctUndatedRulings: undated.size,
      rulingRows,
    },
    cards,
  };
}
