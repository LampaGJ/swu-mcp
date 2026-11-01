import { z } from "zod";
import { hex64 } from "../schemas/hash.js";

/**
 * @displayName Sleeper-card data product schema
 * @strategicPurpose The seam between the sleeper-card step (scripts/meta/sleepers.ts) and the sleeper_cards tool
 * (LampaGJ/swu-mcp#184): the step validates what it writes and the tool parses what it reads, so a renamed field
 * fails loudly on both sides instead of reading as "no sleepers".
 * @tacticalObjective Strict Zod shapes for <run>/sleepers/sleepers.json and its replay record. Public tournament
 * aggregates only: no player name, player id or event id field exists anywhere in the shape.
 */

const estimate = z.strictObject({
  value: z.number(),
  low: z.number(),
  high: z.number(),
  /** Two-sided p for "no difference" from the event-clustered bootstrap standard error (normal approximation). */
  p: z.number().min(0).max(1),
  /** Benjamini-Hochberg q within the row's family (valid under positive dependence only). */
  qBH: z.number().min(0).max(1),
  /** Benjamini-Yekutieli q within the row's family (valid under any dependence); the publish gate reads this one. */
  qBY: z.number().min(0).max(1),
});
export type SleeperEstimate = z.infer<typeof estimate>;

const interval = z.strictObject({ value: z.number(), low: z.number(), high: z.number() });

export const SLEEPER_VERDICTS = ["sleeper", "proven-winner", "loses-ground", "no-clear-effect"] as const;

export const sleeperRowSchema = z.strictObject({
  cardKey: z.string().min(1),
  /** "Title, Subtitle" from the raw printings, so a rotated card the package no longer lists still has a name. */
  title: z.string().min(1),
  /** Not in the package's card list: a set Premier has rotated out. Measured in the seasons it was legal; not playable now. */
  rotated: z.boolean(),
  decksWith: z.number().int().nonnegative(),
  decksWithout: z.number().int().nonnegative(),
  eventsWith: z.number().int().nonnegative(),
  /** Kish effective number of events behind the with-card side: (sum of matches per event)^2 / sum of squares. */
  effectiveEvents: z.number().nonnegative(),
  matchesWith: z.number().int().nonnegative(),
  matchesWithout: z.number().int().nonnegative(),
  /** Share of the comparable decks (same meta period, leader and base aspects) that play the card. */
  playRate: z.number().min(0).max(1),
  /** Match win rate with the card minus without it, pooled over comparable strata. */
  gap: estimate,
  skill: z
    .strictObject({
      gapStrong: z.number(),
      gapWeak: z.number(),
      decksStrong: z.number().int().nonnegative(),
      decksWeak: z.number().int().nonnegative(),
      /** gapStrong - gapWeak: how much more the card's gap is among the strongest third of players than the weakest third. */
      interaction: estimate,
    })
    .nullable(),
  /** The same comparison inside one player's own decks (same leader and base aspects), bootstrap over players. */
  withinPlayer: interval.extend({ players: z.number().int().nonnegative() }).nullable(),
  /** The gap inside one build style (archetype cluster of the same period, leader and base aspects). */
  withinStyle: interval.nullable(),
  latestPeriod: z.string(),
  verdict: z.enum(SLEEPER_VERDICTS),
  skilledEdge: z.boolean(),
  selectionWarning: z.boolean(),
});
export type SleeperRow = z.infer<typeof sleeperRowSchema>;

const scopeSchema = z.strictObject({
  key: z.string().min(1),
  leader: z.string().nullable(),
  baseAspects: z.array(z.string()).nullable(),
  aspects: z.array(z.string()),
  decks: z.number().int().nonnegative(),
  rows: z.array(sleeperRowSchema),
});
export type SleeperScope = z.infer<typeof scopeSchema>;

const simEffect = z.strictObject({
  experiment: z.string(),
  role: z.enum(["added", "removed"]),
  copies: z.number().int().positive(),
  swaps: z.array(z.string()),
  pilot: z.string(),
  pilotKind: z.enum(["rules", "lookahead"]),
  effect: z.number(),
  low: z.number(),
  high: z.number(),
  games: z.number().int().positive(),
  pValue: z.number().min(0).max(1),
});

export const sleeperSimSchema = z.strictObject({
  label: z.string(),
  caveat: z.string(),
  deck: z.string(),
  opponents: z.string(),
  records: z.record(z.string(), hex64),
  cards: z.record(
    z.string(),
    z.strictObject({
      effects: z.array(simEffect),
      /** Lookahead-bot effect minus rules-bot effect for the same swap, where both were run. */
      pilotSensitivity: z.array(
        z.strictObject({ experiment: z.string(), lookahead: z.string(), value: z.number(), low: z.number(), high: z.number() }),
      ),
    }),
  ),
});
export type SleeperSim = z.infer<typeof sleeperSimSchema>;

const fdrCheck = z.strictObject({
  method: z.string(),
  replicates: z.number().int().positive(),
  rows: z.number().int().nonnegative(),
  passBH: z.number().int().nonnegative(),
  passBY: z.number().int().nonnegative(),
  minP: z.number().min(0).max(1).nullable(),
});

export const sleepersFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.string(),
  population: z.string(),
  precedence: z.string(),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  periods: z.array(
    z.strictObject({ label: z.string(), from: z.iso.date(), to: z.iso.date(), decks: z.number().int(), events: z.number().int() }),
  ),
  counts: z.strictObject({
    decks: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    players: z.number().int().nonnegative(),
    decksWithSkill: z.number().int().nonnegative(),
    strata: z.number().int().nonnegative(),
    styles: z.number().int().nonnegative(),
  }),
  method: z.strictObject({
    unit: z.string(),
    outcome: z.string(),
    comparison: z.string(),
    interval: z.string(),
    coverage: z.number(),
    test: z.string(),
    fdr: z.string(),
    q: z.number(),
    replicates: z.number().int().positive(),
    seed: z.string(),
    minDecks: z.number().int().positive(),
    minEvents: z.number().int().positive(),
    minTierDecks: z.number().int().positive(),
    minPlayers: z.number().int().positive(),
    skill: z.strictObject({
      definition: z.string(),
      priorMatches: z.number(),
      betweenPlayerSd: z.number(),
      tierCuts: z.tuple([z.number(), z.number()]),
    }),
    nullCheck: fdrCheck,
    verdicts: z.string(),
  }),
  global: z.array(sleeperRowSchema),
  aspects: z.array(scopeSchema),
  archetypes: z.array(scopeSchema),
  simulator: sleeperSimSchema.nullable(),
});
export type SleepersFile = z.infer<typeof sleepersFileSchema>;

export const sleepersReplaySchema = z.strictObject({
  inputHash: z.strictObject({
    captureManifest: hex64,
    rawPages: hex64,
    "features.json": hex64,
    rawManifest: hex64,
    simRecords: z.record(z.string(), hex64),
  }),
  codeCommit: z.string(),
  outputHash: z.record(z.string(), hex64),
});
