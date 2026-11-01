import { z } from "zod";

/**
 * @displayName Decklist capture shapes
 * @strategicPurpose The foreign-data seam of the swumetastats decklist capture (LampaGJ/swu-mcp#184): the capture
 * script checks each page as it arrives and the sleeper step parses the same pinned pages again, so an upstream
 * rename fails at both ends instead of reading as zero decks.
 * @tacticalObjective Loose shapes for the API pages (unknown upstream fields pass through), a strict shape for the
 * manifest this repo writes, and the per-deck fields the sleeper analysis reads.
 */

export const tournamentRowSchema = z.looseObject({
  id: z.number().int(),
  startDate: z.string(),
  playerCount: z.number().int().nullish(),
  format: z.string().nullish(),
  _count: z.looseObject({ decklists: z.number().int().nonnegative() }),
});
export type TournamentRow = z.infer<typeof tournamentRowSchema>;
export const tournamentPageSchema = z.looseObject({ tournaments: z.array(tournamentRowSchema), totalCount: z.number().int() });
export const decklistPageSchema = z.looseObject({ decklists: z.array(z.looseObject({ guid: z.string() })), totalCount: z.number().int() });
export const boundariesSchema = z.array(z.looseObject({ start: z.iso.date(), end: z.iso.date().nullable(), label: z.string() }));

export const decklistManifestSchema = z.strictObject({
  kind: z.literal("swumetastats-decklists"),
  snapshot: z.iso.date(),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  userAgent: z.string(),
  fetch: z.strictObject({
    firstAt: z.string().nullable(),
    lastAt: z.string().nullable(),
    requests: z.number().int(),
    reused: z.number().int(),
    minIntervalMs: z.number().int(),
    failures: z.array(z.strictObject({ url: z.string(), status: z.number().int(), note: z.string() })),
  }),
  population: z.string(),
  counts: z.strictObject({
    tournaments: z.number().int(),
    tournamentsWithDecklists: z.number().int(),
    decklistsListed: z.number().int(),
    decklistsCaptured: z.number().int(),
    byMonth: z.record(z.string(), z.number().int()),
    byMetaPeriod: z.record(z.string(), z.number().int()),
    shortEvents: z.array(z.strictObject({ tournamentId: z.number().int(), listed: z.number().int(), captured: z.number().int() })),
  }),
  files: z.record(z.string(), z.string()),
});
export type DecklistManifest = z.infer<typeof decklistManifestSchema>;

const statField = z.union([z.number(), z.string()]).nullish();
const cardLine = z.looseObject({
  count: z.number().int().nonnegative(),
  section: z.string(),
  cardName: z.string(),
  card: z.looseObject({ cost: statField, power: statField, hp: statField }).nullish(),
});

/** The fields of one /api/decklists row the sleeper analysis reads; player stays in memory, never in an output. */
export const decklistRowSchema = z.looseObject({
  guid: z.string().min(1),
  tournamentId: z.number().int(),
  standing: z.number().int().nullish(),
  leaderName: z.string(),
  baseName: z.string(),
  leaderCard: z.looseObject({ name: z.string(), aspect: z.string().nullish(), set: z.string().nullish() }).nullish(),
  baseCard: z.looseObject({ name: z.string(), aspect: z.string().nullish() }).nullish(),
  tournament: z.looseObject({ startDate: z.string() }),
  player: z.looseObject({ name: z.string().nullish() }).nullish(),
  cards: z.array(cardLine),
  matchRecord: z.string().nullish(),
});
export type DecklistRow = z.infer<typeof decklistRowSchema>;
export const decklistRowsPageSchema = z.looseObject({ decklists: z.array(decklistRowSchema), totalCount: z.number().int() });

/** Upstream spellings that differ from the card list: a two-faced leader listed by both faces, and a letter O typed as a zero (C-3P0, B2EM0). */
export function nameVariants(name: string): string[] {
  const out = [name];
  const faces = /^(.*?)\s*\/\/\s*[^|]*?(\s*\|.*)?$/.exec(name);
  if (faces !== null) out.push(`${faces[1]}${faces[2] ?? ""}`);
  const lettered = name.replace(/(?<=[A-Z])0/g, "O");
  if (lettered !== name) out.push(lettered);
  return out;
}

/** A card line's printed numbers ("4" or 4), null when absent or not a number. */
export function statOf(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
