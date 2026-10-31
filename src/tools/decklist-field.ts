import { z } from "zod";

/**
 * @displayName Decklist argument shape
 * @strategicPurpose The {card, count} line every deck tool takes (#5, #143); a leaf module so the synergy tools can
 * share the shape without an import cycle through deck.ts.
 * @tacticalObjective One strict Zod shape: a count from 1 to 99 and a card named by cardKey, SET_NNN id or exact title.
 */
export const deckLineSchema = z.strictObject({
  card: z
    .string()
    .min(1)
    .describe(
      "A cardKey (for example 0101033), a SWUDB printing id (SET_NNN, for example HMW_018) or an exact card title; 'Title, Subtitle' picks one of several cards that share a title",
    ),
  count: z.number().int().min(1).max(99).default(1),
});

export const cardList = (what: string) => z.array(deckLineSchema).min(1).max(250).describe(what);
export const decklistField = cardList("Cards as {card, count}; the same card listed twice is added up");
