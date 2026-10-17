import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageDirOf, readJson, splitCell, type CardRow, type CardStore } from "../data.js";
import { playFileSchema, pricesFileSchema, type PlayFile, type PricesFile } from "../market/build.js";
import { scoresFileSchema, type ScoreRow } from "../scorer/scores-file.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { ToolResult } from "../tools.js";
import { ok, fail, lower } from "./common.js";

/**
 * @displayName Market tools
 * @strategicPurpose MCP read-only tools over US prices and online play counts: card_price, play_stats
 * and value_vs_price. Prices and play data answer different questions from the scorer, so they sit in
 * their own tool file.
 * @tacticalObjective Loads <package>/market/{prices,play}.json (built by `pnpm market`) and
 * <package>/scores/scores.json once per store, and answers in compact TOON. Nothing is computed by a model.
 */

export interface MarketData {
  prices: PricesFile;
  play: PlayFile;
  priceByKey: Map<string, PricesFile["cards"][number]>;
  playByKey: Map<string, PlayFile["cards"][number]>;
}

const cache = new WeakMap<CardStore, MarketData>();

export function marketData(store: CardStore): MarketData {
  const hit = cache.get(store);
  if (hit !== undefined) return hit;
  const dir = path.join(packageDirOf(store), "market");
  for (const needed of ["prices.json", "play.json"]) {
    if (!existsSync(path.join(dir, needed))) throw new Error(`${path.join(dir, needed)} is missing; run "pnpm market"`);
  }
  const prices = pricesFileSchema.parse(readJson(path.join(dir, "prices.json")));
  const play = playFileSchema.parse(readJson(path.join(dir, "play.json")));
  const data: MarketData = {
    prices,
    play,
    priceByKey: new Map(prices.cards.map((card) => [card.cardKey, card])),
    playByKey: new Map(play.cards.map((card) => [card.cardKey, card])),
  };
  cache.set(store, data);
  return data;
}

function guarded(handler: (store: CardStore, data: MarketData, input: unknown) => ToolResult): (store: CardStore, input: unknown) => ToolResult {
  return (store, input) => {
    let data: MarketData;
    try {
      data = marketData(store);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return handler(store, data, input);
  };
}

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places || 0;

const cardRef = {
  cardKey: z.string().min(1).optional().describe("Exact cardKey, for example 0101033"),
  title: z.string().min(1).optional().describe("Exact card title, case-insensitive"),
  subtitle: z.string().optional().describe("Exact subtitle, case-insensitive; narrows a title shared by several leaders"),
};

function resolveCard(store: CardStore, args: { cardKey?: string; title?: string; subtitle?: string }): CardRow | string {
  if (args.cardKey !== undefined) return store.byKey.get(args.cardKey) ?? `no card with cardKey ${args.cardKey}`;
  if (args.title === undefined) return "give cardKey, or title with an optional subtitle";
  const title = args.title.toLowerCase();
  const subtitle = args.subtitle?.toLowerCase();
  const matches = store.cards.filter((card) => lower(card.title) === title && (subtitle === undefined || lower(card.subtitle) === subtitle));
  if (matches.length === 0) return `no card titled "${args.title}"${args.subtitle === undefined ? "" : ` with subtitle "${args.subtitle}"`}`;
  if (matches.length > 1) return `"${args.title}" matches ${matches.length} cards (${matches.map((m) => `${m.cardKey} ${m.subtitle ?? ""}`.trim()).join("; ")}); pass the cardKey or a subtitle`;
  return matches[0];
}

const cardHead = (card: CardRow) => ({ cardKey: card.cardKey, title: card.title, subtitle: card.subtitle });

// ---------------------------------------------------------------------------------------------
// card_price

export const cardPriceShape = { ...cardRef };

export const cardPriceHandler = guarded((store, data, input) => {
  const args = z.object(cardPriceShape).parse(input);
  const card = resolveCard(store, args);
  if (typeof card === "string") return fail(card);
  const entry = data.priceByKey.get(card.cardKey);
  const importInfo = { id: data.prices.priceImportId, date: data.prices.priceImportFinishedAt?.slice(0, 10) ?? null };
  if (entry === undefined) return ok({ card: cardHead(card), priced: false, priceImport: importInfo, coverage: data.prices.coverage });
  return ok({
    card: cardHead(card),
    canonical: { normal: entry.normal, foil: entry.foil },
    priceImport: importInfo,
    coverage: data.prices.coverage,
    printings: entry.printings.map((p) => ({ cardId: p.cardId, variant: p.variant, normal: p.normal, foil: p.foil, priceSource: p.priceSource, conformance: p.conformance })),
  });
});

// ---------------------------------------------------------------------------------------------
// play_stats

export const playStatsShape = {
  ...cardRef,
  window: z.string().optional().describe("Capture window id, for example w29-55 (weeks 29 to 55). Omit for every window."),
};

export const playStatsHandler = guarded((store, data, input) => {
  const args = z.object(playStatsShape).parse(input);
  const card = resolveCard(store, args);
  if (typeof card === "string") return fail(card);
  const windows = data.play.windows.filter((w) => args.window === undefined || w.id === args.window);
  if (windows.length === 0) return fail(`no window ${args.window}; available: ${data.play.windows.map((w) => w.id).join(", ")}`);
  const entry = data.playByKey.get(card.cardKey);
  return ok({
    card: cardHead(card),
    note: data.play.note,
    source: data.play.source,
    windows: windows.map((w) => {
      const cell = entry?.byWindow[w.id];
      return {
        window: w.id,
        startDate: w.startDate,
        endDate: w.endDate,
        playerGames: w.playerGames,
        included: cell?.included ?? 0,
        wins: cell?.wins ?? 0,
        winShare: cell !== undefined && cell.included > 0 ? round(cell.wins / cell.included, 4) : null,
        inclusionRate: cell !== undefined && w.playerGames > 0 ? round(cell.included / w.playerGames, 4) : null,
      };
    }),
    ...(entry === undefined ? { missing: "no row for this card in the capture (not played in Premier, or too new)" } : {}),
  });
});

// ---------------------------------------------------------------------------------------------
// value_vs_price

export const valueVsPriceShape = {
  type: z.string().optional().describe("Card type, for example Unit, Event, Upgrade"),
  aspect: z.string().optional().describe("Aspect, for example Vigilance"),
  set: z.string().optional().describe("Set the rubric assigns the card to (its first current set), for example JTL"),
  maxPrice: z.number().positive().optional().describe("Highest canonical normal price in US dollars"),
  limit: z.number().int().min(1).max(200).default(20),
};

const VALUE_NOTE =
  "Price is driven mostly by rarity (price regression R squared 0.757, almost all rarity; rubric section TCGplayer price as a weak signal), so cheap commons dominate any score-per-dollar ranking. Scores are play-calibrated (fitted to Premier inclusion) and rank-meaningful only. Positive scores only; cards without a score or price are excluded.";

export function valueVsPriceRows(store: CardStore, data: MarketData, scores: readonly ScoreRow[], args: z.infer<z.ZodObject<typeof valueVsPriceShape>>) {
  const rows = [];
  for (const score of scores) {
    const card = store.byKey.get(score.cardKey);
    const price = data.priceByKey.get(score.cardKey)?.normal ?? null;
    if (card === undefined || price === null || price <= 0 || score.playCalibrated === null || score.playCalibrated <= 0) continue;
    if (args.type !== undefined && lower(score.type) !== lower(args.type)) continue;
    if (args.set !== undefined && lower(score.set) !== lower(args.set)) continue;
    if (args.aspect !== undefined && !splitCell(card.aspects).some((a) => lower(a) === lower(args.aspect))) continue;
    if (args.maxPrice !== undefined && price > args.maxPrice) continue;
    rows.push({
      cardKey: score.cardKey,
      title: score.title,
      subtitle: score.subtitle,
      type: score.type,
      set: score.set,
      price,
      playCalibrated: score.playCalibrated,
      scorePerDollar: round(score.playCalibrated / price, 3),
    });
  }
  rows.sort((a, b) => b.scorePerDollar - a.scorePerDollar || compareCodePoints(a.cardKey, b.cardKey));
  return rows;
}

export const valueVsPriceHandler = guarded((store, data, input) => {
  const args = z.object(valueVsPriceShape).parse(input);
  const scoresFile = path.join(packageDirOf(store), "scores/scores.json");
  if (!existsSync(scoresFile)) return fail(`${scoresFile} is missing; run "pnpm score"`);
  const scores = scoresFileSchema.parse(readJson(scoresFile));
  const rows = valueVsPriceRows(store, data, scores.cards, args);
  return ok({
    note: VALUE_NOTE,
    rubricVersion: scores.rubricVersion,
    priceImport: { id: data.prices.priceImportId, date: data.prices.priceImportFinishedAt?.slice(0, 10) ?? null },
    matched: rows.length,
    shown: Math.min(rows.length, args.limit),
    cards: rows.slice(0, args.limit),
  });
});

export const MARKET_TOOLS = {
  card_price: {
    title: "Card price",
    description:
      "US TCGplayer market price of one card: the canonical printing's normal and foil price, plus every printing of the logical card (variant, normal, foil, price source, conformance), with the price import id and date. US only.",
    shape: cardPriceShape,
    handler: cardPriceHandler,
  },
  play_stats: {
    title: "Play statistics",
    description:
      "Premier inclusion count, win count, win share and inclusion rate of one card from the pinned SWU Stats capture, with the date range of each window. Inclusion in online Karabast/Petranaki games; not tournament data.",
    shape: playStatsShape,
    handler: playStatsHandler,
  },
  value_vs_price: {
    title: "Value versus price",
    description:
      "Cards ranked by play-calibrated rubric score per dollar of canonical normal price, filtered by type, aspect, set and maximum price. Price is driven mostly by rarity, so read the ranking as cheap playables, not as fair value.",
    shape: valueVsPriceShape,
    handler: valueVsPriceHandler,
  },
} as const;
