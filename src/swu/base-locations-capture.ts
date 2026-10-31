import { z } from "zod";
import type { CardStore } from "../data.js";
import { baseLocationRowSchema, type BaseLocationRow } from "../schemas/base-locations.js";
import { swudbCandidates } from "../tools/swudb.js";
import { compareCodePoints } from "./canonical.js";

/**
 * @displayName Base location capture mapping
 * @strategicPurpose Seam for the engine's card files (foreign data): each is parsed here before any of it
 * reaches the pinned file, and each engine base is placed on our card table by its printing, never by title.
 * @tacticalObjective Maps an engine base to our cardKey through the SET_NNN printing ids it lists, using the
 * card table's expansion and cardNumber columns (the mapping #143 uses), and refuses a title or location clash.
 */

const printingSchema = z.strictObject({ set: z.string().min(1), number: z.number().int().min(0) });

const engineTypesSchema = z.looseObject({ types: z.array(z.string()) });

const engineBaseSchema = z.looseObject({
  title: z.string(),
  traits: z.array(z.string()),
  setId: printingSchema,
  setCodes: z.array(printingSchema),
});

/** "d'qar" becomes "D'Qar", "narkina 5" becomes "Narkina 5": the first letter of each word and of each apostrophe part. */
export function locationDisplayName(location: string): string {
  return location.replace(/(^|[ '])([a-z])/g, (_all, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

export interface CaptureResult {
  rows: BaseLocationRow[];
  engineBases: number;
  engineBasesNotInCardTable: string[];
}

/**
 * The location of every engine base our card table holds, by cardKey. A card file without a types list, or a
 * base without the fields read here, is an error (a renamed field must not read as "no bases"); so is a base without exactly one trait,
 * a title clash between the engine card and the table card it lands on, and two engine cards placing one table
 * card at different locations.
 */
export function captureBaseLocations(engineCards: readonly unknown[], store: CardStore): CaptureResult {
  const byKey = new Map<string, BaseLocationRow>();
  const notInTable: string[] = [];
  let engineBases = 0;
  for (const raw of engineCards) {
    if (!engineTypesSchema.parse(raw).types.includes("base")) continue;
    const card = engineBaseSchema.parse(raw);
    engineBases += 1;
    if (card.traits.length !== 1) throw new Error(`engine base ${card.title} carries ${card.traits.length} traits; a base location is exactly one`);
    const location = card.traits[0];
    const ids = [...new Set([card.setId, ...card.setCodes].map((p) => `${p.set}_${String(p.number).padStart(3, "0")}`))];
    const hits = new Map<string, BaseLocationRow>();
    for (const id of ids) {
      for (const row of swudbCandidates(store, id).filter((r) => r.type === "Base")) {
        if (row.title !== card.title) throw new Error(`engine base "${card.title}" (${id}) lands on "${row.title}" (${row.cardKey}) in the card table`);
        hits.set(row.cardKey, baseLocationRowSchema.parse({ cardKey: row.cardKey, title: row.title, location, locationName: locationDisplayName(location) }));
      }
    }
    if (hits.size === 0) notInTable.push(card.title);
    for (const [cardKey, row] of hits) {
      const prior = byKey.get(cardKey);
      if (prior !== undefined && prior.location !== location) throw new Error(`${row.title} (${cardKey}) is placed at "${prior.location}" and at "${location}" by different engine cards`);
      byKey.set(cardKey, row);
    }
  }
  return {
    rows: [...byKey.values()].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey)),
    engineBases,
    engineBasesNotInCardTable: notInTable.sort(compareCodePoints),
  };
}
