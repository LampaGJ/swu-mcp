import { z } from "zod";
import { hex64 } from "../schemas/hash.js";

export const ruleSectionSchema = z.strictObject({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  depth: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  title: z.string().nullable(),
  text: z.string(),
  refs: z.array(z.string()),
  page: z.number().int().min(1),
});

export const sectionsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  document: z.strictObject({
    name: z.literal("Star Wars: Unlimited Comprehensive Rules"),
    version: z.string().min(1),
    coverDate: z.string().min(1),
    pages: z.number().int(),
    pdfSha256: hex64,
    preamble: z.string(),
  }),
  stats: z.strictObject({
    sections: z.number().int(),
    byDepth: z.array(z.number().int()).length(4),
    iconGlyphs: z.number().int(),
  }),
  anomalies: z.array(z.string()),
  sections: z.array(ruleSectionSchema),
});
export type SectionsFile = z.infer<typeof sectionsFileSchema>;

export const rulingSchema = z.strictObject({
  /** ISO date of a styled ruling row; null for an undated plain `rules` line that has no styled row. */
  date: z.iso.date().nullable(),
  source: z.enum(["rulesStyled", "rules"]),
  text: z.string().min(1),
});

export const cardRulingsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.strictObject({
    originalsRun: z.string(),
    rawPagesManifestSha256: hex64,
  }),
  stats: z.strictObject({
    printingsWithRulings: z.number().int(),
    logicalCardsWithRulings: z.number().int(),
    distinctRulesFields: z.number().int(),
    distinctRulingTexts: z.number().int(),
    distinctDatedRulings: z.number().int(),
    distinctUndatedRulings: z.number().int(),
    rulingRows: z.number().int(),
  }),
  cards: z.array(
    z.strictObject({
      cardKey: z.string().min(1),
      title: z.string(),
      subtitle: z.string().nullable(),
      printings: z.number().int(),
      rulings: z.array(rulingSchema).min(1),
    }),
  ),
});
export type CardRulingsFile = z.infer<typeof cardRulingsFileSchema>;

export const keywordRulesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  glossaryVersion: z.number().int(),
  keywords: z.array(
    z.strictObject({
      keyword: z.string().min(1),
      definition: z.string().nullable(),
      /** Sections whose heading is the keyword (for example 7.5.11 Sentinel); empty when the CR has none. */
      sections: z.array(z.string()),
      /** Other sections whose own text names the keyword as a whole word. */
      mentionedIn: z.array(z.string()),
    }),
  ),
});
export type KeywordRulesFile = z.infer<typeof keywordRulesFileSchema>;

export const rulesCoreFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(z.strictObject({ id: z.string().min(1), topic: z.string().min(1), why: z.string().min(1) })).min(1),
});
export type RulesCoreFile = z.infer<typeof rulesCoreFileSchema>;

export const rulesReplaySchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.strictObject({ url: z.string().nullable(), fetchedAt: z.iso.date(), pdfSha256: z.string(), pdfBytes: z.number().int() }),
  tool: z.strictObject({ pdftotext: z.string(), codeCommit: z.string() }),
  rulesVersion: z.string(),
  textSha256: z.string(),
  rulings: z.strictObject({ originalsRun: z.string(), rawPagesManifestSha256: z.string() }).nullable(),
  outputs: z.record(z.string(), z.string()),
});
export type RulesReplay = z.infer<typeof rulesReplaySchema>;
