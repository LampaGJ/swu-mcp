import { z } from "zod";
import type { CardRow, CardStore } from "../data.js";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName SWUDB deck interchange
 * @strategicPurpose Owner ruling 2026-10-31 (#143, D55): a builder pastes the deck export of SWUDB, melee.gg,
 * Karabast or SWU Stats into any deck tool and gets an answer, with no out-of-band id mapping.
 * @tacticalObjective Parses the interchange document at the tool boundary (Zod v4, strict), maps each
 * SET_NNN id to a cardKey through the card table's expansion, cardNumber and sets columns, and rewrites the
 * document into the {card, count} line form the deck tools already take. An id the table cannot place is an
 * error that names the id, never a skipped line.
 */

/** A printing id: the set code and the three-digit card number, for example HMW_018. */
export const SWUDB_ID = /^[A-Z0-9]{2,5}_\d{3}$/;

export const isSwudbId = (ref: string): boolean => SWUDB_ID.test(ref.trim());

const entrySchema = z.strictObject({
  id: z.string().regex(SWUDB_ID, { error: "an id like HMW_018: the set code, an underscore and a three-digit number" }),
  count: z.number().int().min(1).max(99),
  /** Exports from the SWUDB crawl carry the card name beside the id; it is informational and never used to resolve. */
  _name: z.string().optional(),
});

const singleSchema = entrySchema.extend({ count: z.number().int().min(1).max(1) });

/** The SWUDB JSON interchange document, the shape forceteki's Deck takes. */
export const swudbDeckSchema = z.strictObject({
  metadata: z.record(z.string(), z.unknown()).optional(),
  leader: singleSchema,
  base: singleSchema,
  deck: z.array(entrySchema).min(1).max(250),
  sideboard: z.array(entrySchema).max(250).optional(),
});
export type SwudbDeck = z.infer<typeof swudbDeckSchema>;

export const swudbField = swudbDeckSchema
  .optional()
  .describe(
    "The deck as the SWUDB JSON interchange document (SWUDB, melee.gg, Karabast and SWU Stats exports): {leader:{id,count},base:{id,count},deck:[{id,count}],sideboard?:[{id,count}],metadata?}, ids like HMW_018. Give this instead of decklist, leader and base, not with them",
  );

const cardColumns = z.looseObject({ expansion: z.string().min(1), cardNumber: z.number().int().min(0) });

const pad3 = (n: number): string => String(n).padStart(3, "0");

interface PrintingIndex {
  /** A card's own printing: its expansion code and card number. */
  own: Map<string, CardRow[]>;
  /** A reprint: a set the card's sets column lists besides its expansion, with the first printing's number. */
  reprint: Map<string, CardRow[]>;
}

const indexes = new WeakMap<CardStore, PrintingIndex>();

function printingIndex(store: CardStore): PrintingIndex {
  const hit = indexes.get(store);
  if (hit !== undefined) return hit;
  const own = new Map<string, CardRow[]>();
  const reprint = new Map<string, CardRow[]>();
  const add = (map: Map<string, CardRow[]>, key: string, row: CardRow): void => {
    const list = map.get(key) ?? [];
    if (!list.includes(row)) list.push(row);
    map.set(key, list);
  };
  for (const row of store.cards) {
    const columns = cardColumns.safeParse(row);
    if (!columns.success) continue;
    const { expansion, cardNumber } = columns.data;
    add(own, `${expansion}_${pad3(cardNumber)}`, row);
    for (const set of (row.sets ?? "").split("|")) if (set !== "" && set !== expansion) add(reprint, `${set}_${pad3(cardNumber)}`, row);
  }
  const built = { own, reprint };
  indexes.set(store, built);
  return built;
}

/**
 * The cards a SET_NNN id can name. A card's own printing wins; only when no card is printed under that
 * expansion and number does a reprint match, through the sets column. Several rows can share one number
 * (a token takes its parent's number), so the caller narrows by type.
 */
export function swudbCandidates(store: CardStore, id: string): CardRow[] {
  const key = id.trim();
  const { own, reprint } = printingIndex(store);
  const direct = own.get(key);
  if (direct !== undefined && direct.length > 0) return [...direct].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
  return [...(reprint.get(key) ?? [])].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
}

/** Whether the table carries the expansion and cardNumber columns the SET_NNN mapping reads. */
export function hasPrintingColumns(store: CardStore): boolean {
  return printingIndex(store).own.size > 0;
}

const FORM_KEYS = ["decklist", "leader", "base"] as const;

export type SwudbExpansion = { input: unknown } | { error: string };

/**
 * Rewrites an input holding a swudb document into the line form (decklist, leader, base, and sideboard when
 * the document has one). Input without swudb passes through unchanged. Giving swudb beside decklist, leader
 * or base is an error naming the ones given, because two sources for one deck cannot both be right.
 */
export function expandSwudb(input: unknown): SwudbExpansion {
  if (typeof input !== "object" || input === null || (input as Record<string, unknown>).swudb === undefined) return { input };
  const { swudb, ...rest } = input as Record<string, unknown>;
  const given = FORM_KEYS.filter((key) => rest[key] !== undefined);
  if (given.length > 0) return { error: `give either swudb or ${given.join(", ")}, not both: swudb already carries the leader, base and deck` };
  const parsed = swudbDeckSchema.safeParse(swudb);
  if (!parsed.success) return { error: `swudb is not a SWUDB interchange document: ${z.prettifyError(parsed.error)}` };
  const doc = parsed.data;
  const lines = (entries: readonly { id: string; count: number }[]) => entries.map((e) => ({ card: e.id, count: e.count }));
  return {
    input: {
      ...rest,
      decklist: lines(doc.deck),
      leader: doc.leader.id,
      base: doc.base.id,
      ...(doc.sideboard === undefined || doc.sideboard.length === 0 ? {} : { sideboard: lines(doc.sideboard) }),
    },
  };
}
