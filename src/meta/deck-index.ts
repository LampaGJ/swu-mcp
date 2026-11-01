import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import { parseMatchRecord, type MatchRecord } from "./outcomes.js";

/**
 * @displayName Deck index
 * @strategicPurpose The per-deck table behind deck_remixer (LampaGJ/swu-mcp#193, owner 2026-11-01: "deck_remixer should find
 * cards to replace a given deck by referencing similar decks for popular or sleeper cards to try for inclusion"). One row
 * per real decklist, so the tool can find the decks nearest a given list instead of averaging a leader's lists.
 * @tacticalObjective Codes each tier's decks against shared dictionaries (cards, aspect sets, events) and sorts them by
 * code point, so the same decks in any order give the same bytes. The strict schema is the seam: the build step writes
 * through it and the tool parses through it. A deck carries its leader, base, aspects, event, date, whole-event match
 * record and placement where the source states them, and never a player name, an author or a deck id.
 */

export const INDEX_TIERS = ["tournament", "community"] as const;
export type IndexTier = (typeof INDEX_TIERS)[number];

/** One deck as the build step hands it over: card keys, not dictionary positions. */
export interface RawIndexDeck {
  leader: string;
  base: string | null;
  /** The leader's and the base's aspect icons, duplicates kept, in any order. */
  aspects: readonly string[];
  event: string | null;
  date: string;
  /** The deck's whole-event match record as "W-L-D". */
  record: string | null;
  placement: number | null;
  cards: readonly (readonly [string, number])[];
}

export interface TierInput {
  tier: IndexTier;
  source: string;
  population: string;
  /** Names the pinned capture or snapshot the decks were read from. */
  capture: string;
  /** Keep decks dated within this many days of the newest deck of the tier. */
  windowDays?: number;
  decks: readonly RawIndexDeck[];
}

const dictIndex = z.number().int().nonnegative();
const row = z.tuple([
  dictIndex, // leader
  dictIndex.nullable(), // base
  dictIndex, // aspect set
  dictIndex.nullable(), // event
  z.iso.date(), // date
  z
    .string()
    .regex(/^\d+-\d+-\d+$/)
    .nullable(), // whole-event match record W-L-D
  z.number().int().positive().nullable(), // placement
  z.array(z.number().int().nonnegative()).refine((a) => a.length % 2 === 0, { error: "cards are card, copies pairs" }), // flat card index, copies pairs
]);

export const COLUMNS = ["leader", "base", "aspects", "event", "date", "record", "placement", "cards"] as const;

const tierSchema = z.strictObject({
  tier: z.enum(INDEX_TIERS),
  source: z.string().min(1),
  population: z.string().min(1),
  capture: z.string().min(1),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  windowDays: z.number().int().positive().nullable(),
  decks: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  withRecord: z.number().int().nonnegative(),
  rows: z.array(row),
});

export const deckIndexFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  note: z.string(),
  columns: z.tuple([
    z.literal("leader"),
    z.literal("base"),
    z.literal("aspects"),
    z.literal("event"),
    z.literal("date"),
    z.literal("record"),
    z.literal("placement"),
    z.literal("cards"),
  ]),
  cardKeys: z.array(z.string()),
  aspectSets: z.array(z.string()),
  events: z.array(z.string()),
  tiers: z.array(tierSchema),
});
export type DeckIndexFile = z.infer<typeof deckIndexFileSchema>;
export type DeckIndexTierMeta = Omit<z.infer<typeof tierSchema>, "rows">;

export const deckIndexReplaySchema = z.strictObject({
  inputHash: z.record(z.string(), z.string()),
  codeCommit: z.string(),
  outputHash: z.record(z.string(), z.string()),
});

/** A deck read back from the index, ready to compare. */
export interface IndexDeck {
  /** The deck's position in its tier, the last tie-break so equal decks keep a fixed order. */
  index: number;
  leader: string;
  base: string | null;
  /** Sorted icons joined by "+", for example "Command+Cunning+Heroism". */
  aspects: string;
  event: string | null;
  date: string;
  record: MatchRecord | null;
  placement: number | null;
  cards: ReadonlyMap<string, number>;
}

/** The day `days` before an ISO date (UTC), without reading a clock. */
export function daysBefore(date: string, days: number): string {
  const ms = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) - days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

const aspectKey = (aspects: readonly string[]): string => [...aspects].sort(compareCodePoints).join("+");
const deckSortKey = (d: RawIndexDeck): string =>
  [
    d.date,
    d.leader,
    d.base ?? "",
    d.event ?? "",
    d.record ?? "",
    d.placement ?? "",
    [...d.cards]
      .sort((a, b) => compareCodePoints(a[0], b[0]))
      .map(([k, n]) => `${k}x${n}`)
      .join(","),
  ].join("\u0000");

export function buildDeckIndex(inputs: readonly TierInput[]): DeckIndexFile {
  const kept = inputs.map((input) => {
    const newest = input.decks.reduce((max, d) => (compareCodePoints(d.date, max) > 0 ? d.date : max), "");
    const floor = input.windowDays === undefined || newest === "" ? null : daysBefore(newest, input.windowDays);
    const decks = input.decks
      .filter((d) => floor === null || compareCodePoints(d.date, floor) >= 0)
      .map((d) => ({ ...d, cards: [...d.cards].filter(([, n]) => n > 0).sort((a, b) => compareCodePoints(a[0], b[0])) }))
      .sort((a, b) => compareCodePoints(deckSortKey(a), deckSortKey(b)));
    return { input, decks };
  });
  const dictionary = (values: Iterable<string>): string[] => [...new Set(values)].sort(compareCodePoints);
  const cardKeys = dictionary(
    kept.flatMap(({ decks }) => decks.flatMap((d) => [d.leader, ...(d.base === null ? [] : [d.base]), ...d.cards.map(([k]) => k)])),
  );
  const aspectSets = dictionary(kept.flatMap(({ decks }) => decks.map((d) => aspectKey(d.aspects))));
  const events = dictionary(kept.flatMap(({ decks }) => decks.flatMap((d) => (d.event === null ? [] : [d.event]))));
  const at = (list: readonly string[]) => new Map(list.map((v, i) => [v, i] as const));
  const cardAt = at(cardKeys);
  const aspectAt = at(aspectSets);
  const eventAt = at(events);
  const need = (map: Map<string, number>, key: string): number => {
    const hit = map.get(key);
    if (hit === undefined) throw new Error(`deck index dictionary lacks ${key}`);
    return hit;
  };
  return deckIndexFileSchema.parse({
    schemaVersion: 1,
    note: "One row per decklist. leader, base, aspects, event index cardKeys, aspectSets and events; cards is a flat list of (cardKeys index, copies) pairs. No player, author or deck id is stored.",
    columns: [...COLUMNS],
    cardKeys,
    aspectSets,
    events,
    tiers: kept.map(({ input, decks }) => {
      const dates = decks.map((d) => d.date);
      return {
        tier: input.tier,
        source: input.source,
        population: input.population,
        capture: input.capture,
        window: { from: dates[0] ?? "1970-01-01", to: dates.at(-1) ?? "1970-01-01" },
        windowDays: input.windowDays ?? null,
        decks: decks.length,
        events: new Set(decks.flatMap((d) => (d.event === null ? [] : [d.event]))).size,
        withRecord: decks.filter((d) => d.record !== null).length,
        rows: decks.map((d) => [
          need(cardAt, d.leader),
          d.base === null ? null : need(cardAt, d.base),
          need(aspectAt, aspectKey(d.aspects)),
          d.event === null ? null : need(eventAt, d.event),
          d.date,
          d.record,
          d.placement,
          d.cards.flatMap(([k, n]) => [need(cardAt, k), n]),
        ]),
      };
    }),
  });
}

/** The decks of one tier with their tier-level facts; null when the file holds no such tier. */
export function expandTier(file: DeckIndexFile, tier: IndexTier): { meta: DeckIndexTierMeta; decks: IndexDeck[] } | null {
  const hit = file.tiers.find((t) => t.tier === tier);
  if (hit === undefined) return null;
  const { rows, ...meta } = hit;
  const card = (i: number): string => file.cardKeys[i];
  const decks = rows.map((r, index): IndexDeck => {
    const pairs = new Map<string, number>();
    for (let i = 0; i < r[7].length; i += 2) pairs.set(card(r[7][i]), r[7][i + 1]);
    return {
      index,
      leader: card(r[0]),
      base: r[1] === null ? null : card(r[1]),
      aspects: file.aspectSets[r[2]],
      event: r[3] === null ? null : file.events[r[3]],
      date: r[4],
      record: parseMatchRecord(r[5]),
      placement: r[6],
      cards: pairs,
    };
  });
  return { meta, decks };
}
