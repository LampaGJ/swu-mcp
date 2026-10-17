import { z } from "zod";

/**
 * @displayName SWU synergy schemas
 * @strategicPurpose Trust boundary for the pairing, trio and fungibility step (LampaGJ/swu-mcp#3):
 * the committed complementarity table and the per-card feature records it reads are parsed
 * here, and every emitted artifact is parsed again before it is written.
 * @tacticalObjective The card input schema is a lean projection of the feature record
 * (src/schemas/card-features.ts): only the fields the synergy step reads, so a feature file
 * from an older extractor still parses as long as those fields exist.
 */

export const SYNERGY_TABLE_SCHEMA_VERSION = 1;

const tagWeights = z.record(z.string(), z.number().positive());

export const complementarityRowSchema = z.strictObject({
  id: z.string().min(1),
  family: z.literal("trait").optional(),
  offers: tagWeights,
  // The trait family row lists its wants as bare tag patterns; it is expanded per trait and never read as a record.
  wants: z.union([tagWeights, z.array(z.string())]),
  strength: z.number().positive(),
  reason: z.string().min(1),
  example: z.tuple([z.string(), z.string()]).nullable(),
});
export type ComplementarityRow = z.infer<typeof complementarityRowSchema>;

/** An offer tag the table decides feeds no want, with the reason, so an uncovered tag is a choice and not a gap. */
export const feedsNothingSchema = z.strictObject({ tag: z.string().min(1), note: z.string().min(1) });

export const complementarityTableSchema = z.strictObject({
  schemaVersion: z.literal(SYNERGY_TABLE_SCHEMA_VERSION),
  tableVersion: z.number().int().positive(),
  note: z.string().optional(),
  rows: z.array(complementarityRowSchema).min(1),
  feedsNothing: z.array(feedsNothingSchema).optional(),
});
export type ComplementarityTable = z.infer<typeof complementarityTableSchema>;

const tag = z.looseObject({ tag: z.string().min(1), why: z.string() });

const clauseLite = z.looseObject({
  text: z.string(),
  curatedId: z.string().optional(),
  effects: z.array(z.looseObject({ n: z.unknown().optional() })),
  conditions: z.array(z.looseObject({ n: z.unknown().optional() })),
});

const abilityLite = z.looseObject({
  kind: z.string(),
  repeat: z.string().optional(),
  triggers: z.array(z.looseObject({ text: z.string().optional(), trigger: z.string().optional() })).optional(),
  clauses: z.array(clauseLite).optional(),
  options: z.array(z.looseObject({ clauses: z.array(clauseLite) })).optional(),
  grantedAbilities: z.array(z.looseObject({ abilities: z.array(z.unknown()) })).optional(),
});
export type AbilityLite = z.infer<typeof abilityLite>;

export const synergyCardSchema = z.looseObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullable(),
  type: z.string(),
  structured: z.looseObject({
    cost: z.number().nullable(),
    aspects: z.array(z.string()),
    aspectIcons: z.array(z.string()),
    traits: z.array(z.string()),
  }),
  faces: z.record(z.string(), z.array(abilityLite)),
  tags: z.strictObject({ offers: z.array(tag), wants: z.array(tag) }),
});
export type SynergyCard = z.infer<typeof synergyCardSchema>;
export const synergyCardsSchema = z.array(synergyCardSchema);

export interface PairRowHit {
  row: string;
  baseId: string;
  offer: string;
  want: string;
  weight: number;
  reason: string;
}

export interface NonObviousness {
  aspects: number;
  traits: number;
  wording: number;
  factor: number;
}

/** What links a pair: table rows other than the trait family, only the trait family, or both (LampaGJ/swu-mcp#24). */
export const LINK_KINDS = ["mechanical", "trait+mechanical", "trait-only"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** How a shared trait counts: not at all, as a small bonus on a mechanical pair (default), or as a link of its own. */
export const TRAITS_MODES = ["exclude", "bonus", "include"] as const;
export type TraitsMode = (typeof TRAITS_MODES)[number];

export interface PairEdge {
  a: string;
  b: string;
  rows: PairRowHit[];
  /** The ranking link: the mechanical rows plus the trait bonus, or the trait rows alone on a trait-only pair. */
  link: number;
  mechanicalLink: number;
  traitLink: number;
  linkKind: LinkKind;
  nonObvious: NonObviousness;
  traitOnly: boolean;
  score: number;
}

export const TRIO_SHAPES = ["chain", "convergent-different-wants", "convergent-same-want", "loop"] as const;
export type TrioShape = (typeof TRIO_SHAPES)[number];

export interface TrioRecord {
  cardA: string;
  cardB: string;
  cardC: string;
  shape: TrioShape;
  totalCost: number;
  allCostLe3: boolean;
  aspectPair: string;
  penalty: number;
  reasons: string;
  score: number;
}

export const replaySchema = z.strictObject({
  inputHash: z.strictObject({
    "features.json": z.string().regex(/^[0-9a-f]{64}$/),
    "complementarity.json": z.string().regex(/^[0-9a-f]{64}$/),
  }),
  codeCommit: z.string().min(1),
  complementarityTableVersion: z.number().int(),
  outputHash: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type SynergyReplay = z.infer<typeof replaySchema>;
