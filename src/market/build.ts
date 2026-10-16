import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import { priceCellsByCardId } from "../swu/llm-flatten.js";

/**
 * @displayName Market data builder
 * @strategicPurpose Manipulation node: price rows and the SWU Stats captures in, compact per-card
 * prices.json and play.json out, so the MCP server never reads 8,882 raw price rows at startup.
 * @tacticalObjective Groups price rows by logical card (via the flattener's printing-to-card map),
 * sums capture rows by logical card (via cardUid), and sorts everything by code point. No clock, no
 * randomness: the same inputs give byte-identical output.
 */

const price = z.number().nullable();

export const priceRowSchema = z.object({
  card_id: z.string(),
  variant: z.string(),
  product_id: z.number().int(),
  price_normal: price,
  price_foil: price,
  price_source: z.string().nullable(),
  conformance: z.string().nullable(),
});
export type PriceRow = z.infer<typeof priceRowSchema>;

export const captureRowSchema = z.object({
  cardUid: z.union([z.string(), z.number()]),
  timesIncluded: z.number().int().nonnegative(),
  timesIncludedInWins: z.number().int().nonnegative(),
});
export type CaptureRow = z.infer<typeof captureRowSchema>;

export const pricesFileSchema = z.strictObject({
  priceImportId: z.number().int(),
  priceImportFinishedAt: z.string().nullable(),
  coverage: z.string(),
  cards: z.array(
    z.strictObject({
      cardKey: z.string().min(1),
      normal: price,
      foil: price,
      printings: z.array(
        z.strictObject({
          cardId: z.string(),
          variant: z.string(),
          productId: z.number().int(),
          normal: price,
          foil: price,
          priceSource: z.string().nullable(),
          conformance: z.string().nullable(),
        }),
      ),
    }),
  ),
});
export type PricesFile = z.infer<typeof pricesFileSchema>;

export const PRICE_COVERAGE = "US market only: TCGplayer prices via TCGCSV, conformed by mault. No other region or marketplace.";

export function buildPrices(input: {
  rows: readonly PriceRow[];
  cardKeyOfPrinting: ReadonlyMap<string, string>;
  importId: number;
  importFinishedAt: string | null;
}): PricesFile {
  const byCard = new Map<string, PriceRow[]>();
  for (const row of input.rows) {
    const cardKey = input.cardKeyOfPrinting.get(row.card_id);
    if (cardKey === undefined) throw new Error(`price row ${row.card_id}/${row.variant} maps to no logical card`);
    byCard.set(cardKey, [...(byCard.get(cardKey) ?? []), row]);
  }
  const canonical = priceCellsByCardId(input.rows.map((row) => ({ cardId: row.card_id, productId: row.product_id, priceNormal: row.price_normal, priceFoil: row.price_foil })));
  const cards = [...byCard.entries()]
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([cardKey, rows]) => ({
      cardKey,
      normal: canonical.get(cardKey)?.priceNormal ?? null,
      foil: canonical.get(cardKey)?.priceFoil ?? null,
      printings: [...rows]
        .sort((a, b) => compareCodePoints(a.card_id, b.card_id) || compareCodePoints(a.variant, b.variant) || a.product_id - b.product_id)
        .map((row) => ({
          cardId: row.card_id,
          variant: row.variant,
          productId: row.product_id,
          normal: row.price_normal,
          foil: row.price_foil,
          priceSource: row.price_source,
          conformance: row.conformance,
        })),
    }));
  return { priceImportId: input.importId, priceImportFinishedAt: input.importFinishedAt, coverage: PRICE_COVERAGE, cards };
}

export const PLAY_NOTE = "inclusion in online Karabast/Petranaki games; not tournament data; HMW has < 1 week";
export const PLAY_SOURCE = "SWU Stats CardMetaStatsAPI (swustats.net), format premier; counts are per player-game whose deck included the card";
const WEEK0 = Date.UTC(2025, 8, 20);

export function weekStartDate(week: number): string {
  return new Date(WEEK0 + week * 7 * 86_400_000).toISOString().slice(0, 10);
}

export function weekEndDate(week: number): string {
  return new Date(WEEK0 + (week * 7 + 6) * 86_400_000).toISOString().slice(0, 10);
}

/** "swustats-premier-w29-55.json" -> { id: "w29-55", startWeek: 29, endWeek: 55 }. */
export function parseWindowId(file: string): { id: string; startWeek: number; endWeek: number } {
  const match = /^swustats-premier-(w(\d+)-(\d+))\.json$/.exec(file);
  if (match === null) throw new Error(`capture file name ${file} is not swustats-premier-w<start>-<end>.json`);
  return { id: match[1], startWeek: Number(match[2]), endWeek: Number(match[3]) };
}

export const playFileSchema = z.strictObject({
  source: z.string(),
  note: z.string(),
  windows: z.array(
    z.strictObject({
      id: z.string(),
      startWeek: z.number().int(),
      endWeek: z.number().int(),
      startDate: z.string(),
      endDate: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      playerGames: z.number().int(),
    }),
  ),
  cards: z.array(
    z.strictObject({
      cardKey: z.string().min(1),
      byWindow: z.record(z.string(), z.strictObject({ included: z.number().int(), wins: z.number().int() })),
    }),
  ),
});
export type PlayFile = z.infer<typeof playFileSchema>;

export interface Capture {
  file: string;
  sha256: string;
  rows: readonly CaptureRow[];
}

/** playerGames is the sum of inclusions over leaders: each Premier player-game has exactly one. */
export function buildPlay(input: { captures: readonly Capture[]; cardKeyOfUid: ReadonlyMap<string, string>; leaderKeys: ReadonlySet<string> }): PlayFile {
  const windows = [...input.captures]
    .map((capture) => ({ capture, ...parseWindowId(capture.file) }))
    .sort((a, b) => a.startWeek - b.startWeek || a.endWeek - b.endWeek);
  const perCard = new Map<string, Record<string, { included: number; wins: number }>>();
  const outWindows = windows.map(({ capture, id, startWeek, endWeek }) => {
    let playerGames = 0;
    for (const row of capture.rows) {
      const cardKey = input.cardKeyOfUid.get(String(row.cardUid));
      if (cardKey === undefined) throw new Error(`${capture.file}: cardUid ${row.cardUid} maps to no logical card`);
      const entry = perCard.get(cardKey) ?? {};
      const cell = entry[id] ?? { included: 0, wins: 0 };
      cell.included += row.timesIncluded;
      cell.wins += row.timesIncludedInWins;
      entry[id] = cell;
      perCard.set(cardKey, entry);
      if (input.leaderKeys.has(cardKey)) playerGames += row.timesIncluded;
    }
    return { id, startWeek, endWeek, startDate: weekStartDate(startWeek), endDate: weekEndDate(endWeek), sha256: capture.sha256, playerGames };
  });
  const cards = [...perCard.entries()].sort(([a], [b]) => compareCodePoints(a, b)).map(([cardKey, byWindow]) => ({ cardKey, byWindow }));
  return { source: PLAY_SOURCE, note: PLAY_NOTE, windows: outWindows, cards };
}
