import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { swuCardFeaturesFileSchema } from "../schemas/card-features.js";
import { sha256Hex } from "../swu/canonical.js";
import { SET_ORDER, type ScorerCard } from "./features.js";

/**
 * @displayName Scorer input loader
 * @strategicPurpose The seam where feature output and card rows enter the scorer. Both files are
 * parsed here, so the fit script and the score script cannot disagree about what a card is.
 * @tacticalObjective Reads <package>/features/features.json and <package>/llm/cards.toon, joins them
 * on cardKey, and reports the sha256 of each file for the replay record.
 */

const cardRowSchema = z.looseObject({
  cardKey: z.string().min(1),
  cardUid: z.union([z.string(), z.number()]).nullable(),
  rarity: z.string().nullable(),
  sets: z.string().nullable(),
});
export type CardRowLite = z.infer<typeof cardRowSchema>;

export interface ScorerInputs {
  cards: ScorerCard[];
  rows: Map<string, CardRowLite>;
  featuresJsonSha256: string;
  cardsToonSha256: string;
}

/** First JTL-or-later set of a card; a Weekly Play code (JTLP) counts as its parent set. */
export function firstCurrentSet(sets: string | null): string | null {
  const known = new Set<string>(SET_ORDER);
  const found = (sets ?? "")
    .split("|")
    .map((code) => (known.has(code) ? code : code.endsWith("P") && known.has(code.slice(0, -1)) ? code.slice(0, -1) : ""))
    .filter((code) => code !== "");
  if (found.length === 0) return null;
  return [...found].sort((a, b) => (SET_ORDER as readonly string[]).indexOf(a) - (SET_ORDER as readonly string[]).indexOf(b))[0];
}

export function loadScorerInputs(packageDir: string): ScorerInputs {
  const featuresText = readFileSync(path.join(packageDir, "features/features.json"), "utf8");
  const cardsText = readFileSync(path.join(packageDir, "llm/cards.toon"), "utf8");
  const features = swuCardFeaturesFileSchema.parse(JSON.parse(featuresText));
  const rowList = z.object({ cards: z.array(cardRowSchema) }).parse(decode(cardsText)).cards;
  const rows = new Map(rowList.map((row) => [row.cardKey, row]));
  const cards = features.map((card) => {
    const row = rows.get(card.cardKey);
    if (row === undefined) throw new Error(`features.json holds cardKey ${card.cardKey}, which cards.toon lacks`);
    return { features: card, set: firstCurrentSet(row.sets) };
  });
  return { cards, rows, featuresJsonSha256: sha256Hex(featuresText), cardsToonSha256: sha256Hex(cardsText) };
}
