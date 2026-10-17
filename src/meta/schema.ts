import { z } from "zod";

/**
 * @displayName Meta defense schemas
 * @strategicPurpose Trust boundary for the meta step and the meta tools (LampaGJ/swu-mcp#25): the deck snapshot
 * files, the optional outcome extracts (tournament match results, human games), the committed counter table and the
 * emitted archetype and win-rate files are all parsed here, on both sides of the seam.
 * @tacticalObjective Deck files and outcome extracts are foreign data, so they are loose objects that keep only the
 * fields the step reads; the emitted files are strict, so a renamed field fails at the emitter, not in a tool.
 */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const entry = z.looseObject({ id: z.string().min(1), count: z.number().int().nonnegative().optional() });

/** One decklist file of a snapshot (data/originals/decks/<date>/*.json). The author field is never read. */
export const snapshotDeckSchema = z.looseObject({
  metadata: z
    .looseObject({
      source: z.string().optional(),
      createdAt: z.string().optional(),
      via: z.string().optional(),
      event: z
        .looseObject({
          id: z.union([z.number(), z.string()]).optional(),
          name: z.string().optional(),
          date: z.string().optional(),
          players: z.number().int().positive().optional(),
        })
        .nullish(),
      placement: z.number().int().positive().nullish(),
    })
    .optional(),
  leader: entry,
  base: entry,
  deck: z.array(entry),
});
export type SnapshotDeck = z.infer<typeof snapshotDeckSchema>;

export const POPULATIONS = ["tournament", "community"] as const;
export type Population = (typeof POPULATIONS)[number];

const cardShare = z.strictObject({
  cardKey: z.string(),
  title: z.string(),
  inclusion: z.number(),
  meanCopies: z.number(),
});

const keyUnit = z.strictObject({
  cardKey: z.string(),
  title: z.string(),
  cost: z.number().nullable(),
  power: z.number().nullable(),
  hp: z.number().nullable(),
  arenas: z.array(z.string()),
  keywords: z.array(z.string()),
  traits: z.array(z.string()),
  meanCopies: z.number(),
  inclusion: z.number(),
});
export type KeyUnit = z.infer<typeof keyUnit>;

/** Mean copies per deck of cards that carry a mark, so thresholds in data/counters.json read one number. */
export const threatProfileSchema = z.strictObject({
  cardsKnown: z.number(),
  units: z.number(),
  events: z.number(),
  upgrades: z.number(),
  arena: z.strictObject({ ground: z.number(), space: z.number(), spaceShare: z.number() }),
  curve: z.record(z.string(), z.number()),
  meanCost: z.number().nullable(),
  keywords: z.record(z.string(), z.number()),
  /** Mean copies per deck carrying each offers: tag, for the tags data/counters.json threat metrics read. */
  offers: z.record(z.string(), z.number()),
  cheapUnits: z.number(),
  cheapUnitMedianHp: z.number().nullable(),
  leader: z.strictObject({ power: z.number().nullable(), hp: z.number().nullable(), arenas: z.array(z.string()) }),
  keyUnits: z.array(keyUnit),
});
export type ThreatProfile = z.infer<typeof threatProfileSchema>;

export const archetypeSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  population: z.enum(POPULATIONS),
  leader: z.strictObject({ cardKey: z.string(), title: z.string(), aspects: z.array(z.string()) }),
  baseAspects: z.array(z.string()),
  bases: z.array(z.strictObject({ cardKey: z.string(), title: z.string(), decks: z.number().int() })),
  decks: z.number().int(),
  weight: z.number(),
  share: z.number(),
  top8: z.number().int(),
  top8Share: z.number().nullable(),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  cohesion: z.number(),
  core: z.array(cardShare),
  profile: threatProfileSchema,
});
export type Archetype = z.infer<typeof archetypeSchema>;

const populationSummary = z.strictObject({
  population: z.enum(POPULATIONS),
  decks: z.number().int(),
  weight: z.number(),
  top8: z.number().int(),
  events: z.number().int(),
  sources: z.record(z.string(), z.number().int()),
  archetypes: z.number().int(),
  clustered: z.number().int(),
});

export const metaFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date(), days: z.number().int() }),
  primary: z.enum(POPULATIONS),
  fallback: z.boolean(),
  method: z.strictObject({
    seed: z.string(),
    joinJaccard: z.number(),
    coreInclusion: z.number(),
    minDecks: z.number().int(),
    rounds: z.number().int(),
    weighting: z.string(),
  }),
  populations: z.array(populationSummary),
  archetypes: z.array(archetypeSchema),
});
export type MetaFile = z.infer<typeof metaFileSchema>;

export const CARD_OUTCOME_SOURCES = ["tournament-results", "karabast-human"] as const;
export type CardOutcomeSource = (typeof CARD_OUTCOME_SOURCES)[number];

const record3 = { wins: z.number().int(), losses: z.number().int(), draws: z.number().int() };

/** Card-level win rates against one opponent leader, from one outcome source. */
export const cardOutcomesSchema = z.strictObject({
  source: z.enum(CARD_OUTCOME_SOURCES),
  rank: z.number().int(),
  label: z.string(),
  basis: z.string(),
  period: z.strictObject({ from: z.string().nullable(), to: z.string().nullable() }),
  sides: z.number().int(),
  byLeader: z.array(
    z.strictObject({
      leader: z.string(),
      against: z.strictObject({ wins: z.number().int(), n: z.number().int() }),
      cards: z.array(z.strictObject({ cardKey: z.string(), wins: z.number().int(), n: z.number().int() })),
    }),
  ),
});
export type CardOutcomes = z.infer<typeof cardOutcomesSchema>;

export const winRatesFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  minN: z.number().int(),
  /** Aggregate tournament matchups, leader and base aspect against leader and base aspect: the primary source. */
  matchups: z
    .strictObject({
      source: z.literal("swumetastats-matchups"),
      label: z.string(),
      period: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
      rows: z.number().int(),
      unresolvedRows: z.number().int(),
      matches: z.number().int(),
      pairs: z.array(
        z.strictObject({
          leader: z.string(),
          baseAspects: z.array(z.string()),
          oppLeader: z.string(),
          oppBaseAspects: z.array(z.string()),
          ...record3,
        }),
      ),
    })
    .nullable(),
  /** Card-level sources, best first: match results with decklists (#26) when present, then human games. */
  cards: z.array(cardOutcomesSchema),
});
export type WinRatesFile = z.infer<typeof winRatesFileSchema>;

export const metaReplaySchema = z.strictObject({
  inputHash: z.strictObject({
    decks: z.record(z.string(), sha256),
    "features.json": sha256,
    rawManifest: sha256,
    outcomes: z.record(z.string(), sha256),
  }),
  codeCommit: z.string().min(1),
  outputHash: z.record(z.string(), sha256),
});

/**
 * Pluggable tournament match results (LampaGJ/swu-mcp#26): one row per match with both decklists as cardKeys and the
 * winning side. A results extract in this shape is the primary outcome source; human games are secondary.
 */
export const tournamentResultsSchema = z.looseObject({
  kind: z.literal("tournament-matches"),
  source: z.string().min(1),
  matches: z.array(
    z.looseObject({
      date: z.string().nullish(),
      sides: z
        .array(
          z.looseObject({ leader: z.string().nullable(), base: z.string().nullable(), cards: z.array(z.tuple([z.string(), z.number()])) }),
        )
        .length(2),
      winner: z.union([z.literal(0), z.literal(1), z.null()]),
    }),
  ),
});
export type TournamentResults = z.infer<typeof tournamentResultsSchema>;

/** One line of the human-game extract (scripts/bench/extract-games.ts); only the fields the win rates read. */
export const humanGameSchema = z.looseObject({
  sides: z.array(
    z.looseObject({
      leader: z.string().nullable(),
      won: z.union([z.literal(0), z.literal(1), z.null()]),
      cards: z.array(z.tuple([z.string(), z.number()])),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------
// Counter table (data/counters.json)

export const COUNTER_SCHEMA_VERSION = 1;

const qualifierSchema = z.strictObject({
  /** The offer must remove a key unit: its parsed cost, HP, arena and trait limits are checked against the unit. */
  removesKeyUnit: z.boolean().optional(),
  /** The offer hits every enemy unit (each, all), not one. */
  sweep: z.boolean().optional(),
  /** Damage or remaining-HP limit must reach the archetype's median cheap-unit HP. */
  reachesCheapHp: z.boolean().optional(),
  /** The effect is limited to this arena, or names no arena. */
  arena: z.enum(["space", "ground"]).optional(),
  /** The healing reaches a base. */
  healsBase: z.boolean().optional(),
  /** A unit offered as an answer needs at least this power. */
  minPower: z.number().int().optional(),
});
export type CounterQualifier = z.infer<typeof qualifierSchema>;

export const counterThreatSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  /** profile path read with the threshold: units, upgrades, arena.spaceShare, keywords.Sentinel, offers.offers:draw, meanCost, cheapUnits, keyUnits. */
  metrics: z.array(z.string().min(1)).min(1),
  min: z.number().optional(),
  max: z.number().optional(),
  reason: z.string().min(1),
});
export type CounterThreat = z.infer<typeof counterThreatSchema>;

export const counterRelationSchema = z.strictObject({
  id: z.string().min(1),
  threat: z.string().min(1),
  offers: z.record(z.string(), z.number().positive()),
  qualifier: qualifierSchema,
  reason: z.string().min(1),
  example: z.strictObject({ card: z.string().min(1), cardKey: z.string().min(1), clause: z.string().min(1) }),
});
export type CounterRelation = z.infer<typeof counterRelationSchema>;

export const counterTableSchema = z.strictObject({
  schemaVersion: z.literal(COUNTER_SCHEMA_VERSION),
  tableVersion: z.number().int().positive(),
  note: z.string().optional(),
  threats: z.array(counterThreatSchema).min(1),
  relations: z.array(counterRelationSchema).min(1),
});
export type CounterTable = z.infer<typeof counterTableSchema>;
