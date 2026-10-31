import { z } from "zod";
import { hex64 } from "./hash.js";

/**
 * @displayName Pinned base locations
 * @strategicPurpose The official card API ships every base with an empty subtitle and no traits, so the
 * location a clause names ("a Tatooine base") cannot be checked against a base. This is the trust boundary for
 * the one captured input that supplies it: the forceteki engine's card data, read once by a committed script.
 * @tacticalObjective Schemas for the pinned file (one row per base our card table holds) and its manifest.
 * `location` is the engine's source string, `locationName` the display name the features step merges into traits.
 */

export const baseLocationRowSchema = z.strictObject({
  cardKey: z.string().min(1),
  title: z.string().min(1),
  location: z.string().min(1),
  locationName: z.string().min(1),
});
export type BaseLocationRow = z.infer<typeof baseLocationRowSchema>;

export const baseLocationsFileSchema = z.strictObject({
  source: z.literal("forceteki"),
  cardDataHash: hex64,
  rows: z.array(baseLocationRowSchema).min(1),
});
export type BaseLocationsFile = z.infer<typeof baseLocationsFileSchema>;

export const baseLocationsManifestSchema = z.strictObject({
  file: z.string().min(1),
  sha256: hex64,
  source: z.literal("forceteki"),
  engineCommit: z.string().regex(/^[0-9a-f]{40}$/),
  cardDataHash: hex64,
  cardTableSha256: hex64,
  engineBases: z.number().int().min(1),
  mappedBases: z.number().int().min(1),
  engineBasesNotInCardTable: z.array(z.string()),
});
export type BaseLocationsManifest = z.infer<typeof baseLocationsManifestSchema>;
