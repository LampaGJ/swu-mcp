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

export interface Ruling {
  date: string;
  text: string;
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
    rulings.push({ date: isoDate(cells.eq(0).text()), text: body.text().replace(/\s+/g, " ").trim() });
  });
  return rulings;
}

export function compareRulings(a: Ruling, b: Ruling): number {
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
  const perCard = new Map<string, Map<string, Ruling>>();
  const plainTexts = new Set<string>();
  let printingsWithRulings = 0;
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
    if (typeof styled !== "string" || !styled.includes("<tr")) return;
    const rulings = parseRulesStyled(styled);
    if (rulings.length === 0) return;
    printingsWithRulings += 1;
    if (typeof record.attributes.rules === "string") plainTexts.add(record.attributes.rules);
    const bucket = perCard.get(cardKey) ?? new Map<string, Ruling>();
    perCard.set(cardKey, bucket);
    for (const ruling of rulings) {
      rulingRows += 1;
      bucket.set(`${ruling.date}\u0000${ruling.text}`, ruling);
    }
  });

  const dated = new Set<string>();
  const texts = new Set<string>();
  const cards = [...perCard.entries()]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([cardKey, bucket]) => {
      const rulings = [...bucket.values()].sort(compareRulings);
      for (const ruling of rulings) {
        dated.add(`${ruling.date}\u0000${ruling.text}`);
        texts.add(ruling.text);
      }
      const names = titles.get(cardKey) ?? { title: "", subtitle: null };
      return { cardKey, title: names.title, subtitle: names.subtitle, printings: printingCount.get(cardKey) ?? 0, rulings };
    });

  return {
    schemaVersion: 1,
    source,
    stats: {
      printingsWithRulings,
      logicalCardsWithRulings: cards.length,
      distinctRulesFields: plainTexts.size,
      distinctRulingTexts: texts.size,
      distinctDatedRulings: dated.size,
      rulingRows,
    },
    cards,
  };
}
