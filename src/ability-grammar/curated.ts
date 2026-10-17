import { swuCuratedTableSchema, type SwuCuratedEntry, type SwuCuratedTable } from "./deps.js";
import { sha256Hex } from "./deps.js";
import { normalizeText } from "./segment.js";

export class CuratedTableError extends Error {}

/** Thrown when a curated entry's clause no longer exists in the card text. */
export class StaleCuratedEntriesError extends Error {
  constructor(readonly keys: readonly string[]) {
    super(`stale curated entries: ${keys.join(", ")}`);
  }
}

export interface CuratedSlot {
  entry: SwuCuratedEntry;
  used: boolean;
  redundant: boolean;
}

export type CuratedIndex = Map<string, CuratedSlot>;

export const curatedKey = (cardKey: string, face: string, clauseSha256: string): string => `${cardKey}|${face}|${clauseSha256}`;

/**
 * @displayName SWU curated rule table loader
 * @strategicPurpose Rung 4 of the ability-text ladder is a committed, reviewed
 * input; the loader is its consumer gate, so a hand-edited or rotted table
 * fails loudly instead of silently changing scores (LampaGJ/mault#322).
 * @tacticalObjective Parses the table against the Zod schema, then proves
 * every entry's clauseSha256 is the sha256 of its sourceClause and that no
 * (cardKey, face, clauseSha256) key repeats.
 */
export function loadCuratedTable(json: string): { table: SwuCuratedTable; index: CuratedIndex } {
  // Validate, but keep the parsed-from-text object: Zod rebuilds objects in schema key order, which would change the emitted bytes.
  const raw: unknown = JSON.parse(json);
  swuCuratedTableSchema.parse(raw);
  const table = raw as SwuCuratedTable;
  const index: CuratedIndex = new Map();
  for (const entry of table.entries) {
    const declared = curatedKey(entry.cardKey, entry.face, entry.clauseSha256);
    if (sha256Hex(entry.sourceClause) !== entry.clauseSha256) {
      throw new CuratedTableError(`curated entry ${entry.id} (${declared}): clauseSha256 does not hash sourceClause`);
    }
    // Looked up by the normalised clause, the form the extractor sees, so a table written before a normaliser rule existed still applies.
    const key = curatedKey(entry.cardKey, entry.face, sha256Hex(normalizeText(entry.sourceClause)));
    if (index.has(key)) throw new CuratedTableError(`duplicate curated entry ${key}`);
    index.set(key, { entry, used: false, redundant: false });
  }
  return { table, index };
}

export interface CuratedReport {
  entries: number;
  applied: number;
  stale: string[];
  redundant: string[];
}

/** Stale = never reached by any clause; redundant = reached only by a clause the grammar already classifies. */
export function curatedReport(index: CuratedIndex): CuratedReport {
  const stale: string[] = [];
  const redundant: string[] = [];
  for (const [key, slot] of index) {
    if (!slot.used && !slot.redundant) stale.push(key);
    if (slot.redundant) redundant.push(key);
  }
  return { entries: index.size, applied: index.size - stale.length - redundant.length, stale, redundant };
}
