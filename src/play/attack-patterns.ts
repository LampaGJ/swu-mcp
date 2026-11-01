/**
 * @displayName Attack patterns data product
 * @strategicPurpose Answers "which cards attack most, what do they attack and what happens" from observed play, with
 * human play and computer play side by side and never pooled (D21), so an assistant can compare how people and our
 * bots use a card in combat (#181, D104).
 * @tacticalObjective The strict schema of data/attack-patterns.json, which a build step writes from aggregates only:
 * per population (method and tier) the top attackers with their targets, combat results and the attacking side's
 * game result with a Wilson 95% interval. No field holds a player name, a player id or a game id, and the tool that
 * serves it reads only this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../paths.js";

export const ATTACK_PATTERNS_FILE = path.join(REPO_ROOT, "data/attack-patterns.json");

const count = z.int().min(0);
const share = z.number().min(0).max(1);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const METHODS = ["human play", "computer play"] as const;
/** D21's tier names for the two populations. */
export const TIERS = { "human play": "casual online games", "computer play": "bot simulations" } as const;

/** title: the card's printed "Title, Subtitle", so a card outside the release's card list is still named. */
const targetRow = z.strictObject({ cardKey: z.string().min(1), title: z.string().min(1), attacks: count, share });

export const attackerRowSchema = z.strictObject({
  cardKey: z.string().min(1),
  title: z.string().min(1),
  attacks: count,
  /** Games in which the card attacked at least once. */
  games: count,
  gameShare: share,
  attacksPerGame: z.number().min(0),
  targets: z.strictObject({ base: count, units: count, unresolvedUnits: count, baseShare: share }),
  topTargets: z.array(targetRow),
  results: z.strictObject({
    /** Attacks with a board before and after them. */
    measured: count,
    unitAttacks: count,
    targetDefeated: count,
    attackerDefeated: count,
    both: count,
    neither: count,
    meanDamageToTarget: z.number().min(0).nullable(),
    baseAttacks: count,
    meanBaseDamage: z.number().min(0).nullable(),
  }),
  /** Game-level: each side that attacked with the card counts once, by its game result. */
  sideResult: z.strictObject({ sides: count, wins: count, winShare: share.nullable(), low: share.nullable(), high: share.nullable() }),
});
export type AttackerRow = z.infer<typeof attackerRowSchema>;

export const populationSchema = z.strictObject({
  method: z.enum(METHODS),
  tier: z.enum([TIERS["human play"], TIERS["computer play"]]),
  label: z.string().min(1),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }).nullable(),
  games: count,
  attacks: count,
  unresolvedAttackers: count,
  unresolvedTargets: count,
  measuredAttacks: count,
  attackers: z.array(attackerRowSchema),
  notes: z.array(z.string()),
});
export type AttackPopulation = z.infer<typeof populationSchema>;

export const attackPatternsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  populations: z.array(populationSchema),
  build: z.strictObject({ inputHash: hex64, codeCommit: z.string().min(1) }),
});
export type AttackPatterns = z.infer<typeof attackPatternsSchema>;

/** The shipped product, or null when this checkout has none. */
export function loadAttackPatterns(file = ATTACK_PATTERNS_FILE): AttackPatterns | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return attackPatternsSchema.parse(JSON.parse(text));
}
