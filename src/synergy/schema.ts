import { z } from "zod";
import { hex64 } from "../schemas/hash.js";

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

/** Which side of the board an offer's effect lands on: an enemy unit, the player's own, or either (the clause says "a unit"). */
export const REASON_SIDES = ["enemy", "own", "any"] as const;
export type ReasonSide = (typeof REASON_SIDES)[number];

/** A reason per target side, for a row whose wording depends on where the offer lands (LampaGJ/swu-mcp#121). */
export const reasonBySideSchema = z.strictObject({
  enemy: z.string().min(1).optional(),
  own: z.string().min(1).optional(),
  any: z.string().min(1).optional(),
});
export type ReasonBySide = z.infer<typeof reasonBySideSchema>;

export const complementarityRowSchema = z.strictObject({
  id: z.string().min(1),
  /**
   * "trait": expanded per trait; "name": links a card to the cards its text names by title (D62), never matched by tag;
   * "stat": expanded per stat-count want (`wants:unit-power-0`), fed by every Unit whose printed stat meets it (D72), never matched by tag.
   */
  family: z.enum(["trait", "name", "stat"]).optional(),
  offers: tagWeights,
  // The trait and stat family rows list their wants as bare tag patterns; they are expanded and never read as a record.
  wants: z.union([tagWeights, z.array(z.string())]),
  strength: z.number().positive(),
  reason: z.string().min(1),
  /** Tool-side wording by the offer's actual target side; a side without an entry falls back to `reason`. The data release keeps `reason`. */
  reasonBySide: reasonBySideSchema.optional(),
  example: z.tuple([z.string(), z.string()]).nullable(),
});
export type ComplementarityRow = z.infer<typeof complementarityRowSchema>;

/** An offer tag the table decides feeds no want, with the reason, so an uncovered tag is a choice and not a gap. */
export const feedsNothingSchema = z.strictObject({ tag: z.string().min(1), note: z.string().min(1) });

/** A want tag every deck feeds by playing cards at all (paying costs exhausts resources), with the reason (D62). */
export const genericallyFedSchema = z.strictObject({ tag: z.string().startsWith("wants:"), note: z.string().min(1) });

export const complementarityTableSchema = z.strictObject({
  schemaVersion: z.literal(SYNERGY_TABLE_SCHEMA_VERSION),
  tableVersion: z.number().int().positive(),
  note: z.string().optional(),
  rows: z.array(complementarityRowSchema).min(1),
  feedsNothing: z.array(feedsNothingSchema).optional(),
  genericallyFed: z.array(genericallyFedSchema).optional(),
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
    power: z.number().nullable().optional(),
    aspects: z.array(z.string()),
    aspectIcons: z.array(z.string()),
    arenas: z.array(z.string()).optional(),
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
  /** Evidence a row reads off the card rather than a tag (the name and stat families): the naming clause and the named title, or the printed stat. */
  offerWhy?: string;
  wantWhy?: string;
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
  /** Set only on a conditional link (#108): the traits a third card must put on the board for the link to fire. */
  needs?: string[];
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
    "features.json": hex64,
    "complementarity.json": hex64,
  }),
  codeCommit: z.string().min(1),
  complementarityTableVersion: z.number().int(),
  outputHash: z.record(z.string(), hex64),
});
export type SynergyReplay = z.infer<typeof replaySchema>;
