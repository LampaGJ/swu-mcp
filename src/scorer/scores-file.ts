import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import type { CardScore } from "./score.js";

/**
 * @displayName Scores file schemas
 * @strategicPurpose The contract between `pnpm score` (emitter) and the MCP value tools (consumer),
 * parsed on both sides so a changed shape fails where it was produced.
 * @tacticalObjective Declares scores.json and its replay record; rounds every number to 4 decimals
 * so the file bytes do not depend on floating-point noise.
 */

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const nullableNumber = z.number().nullable();

export const scoreComponentsSchema = z.strictObject({
  expectedStats: nullableNumber,
  statSurplus: z.number(),
  costTerm: z.number(),
  keywordPoints: z.number(),
  effectPoints: z.number(),
  modifiers: z.number(),
  playabilityT: z.number(),
  playabilityTStat: z.number(),
});

export const scoreRowSchema = z.strictObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullable(),
  type: z.string(),
  cost: nullableNumber,
  set: z.string().nullable(),
  scored: z.boolean(),
  model: z.enum(["unit", "event", "upgrade", "leader", "base"]).nullable(),
  components: scoreComponentsSchema,
  efficiency: nullableNumber,
  total: nullableNumber,
  playCalibrated: nullableNumber,
  playCalibratedNoT: nullableNumber,
  flags: z.array(z.string()),
  unclassifiedClauses: z.number().int(),
  terms: z.array(
    z.strictObject({ term: z.string(), component: z.enum(["statSurplus", "keywordPoints", "effectPoints", "modifiers", "playCalibrated"]), value: z.number() }),
  ),
  /** Percent of same-type scored cards at or below this card, by total and by playCalibrated. */
  percentile: z.strictObject({ total: nullableNumber, playCalibrated: nullableNumber }),
});
export type ScoreRow = z.infer<typeof scoreRowSchema>;

export const scoresFileSchema = z.strictObject({
  rubricVersion: z.string(),
  coefficientsSha256: sha,
  cards: z.array(scoreRowSchema),
});

export const scoresReplaySchema = z.strictObject({
  rubricVersion: z.string(),
  inputHashes: z.strictObject({
    featuresJson: sha,
    cardsToon: sha,
    featuresReplayInputHash: sha,
    coefficientsFile: sha,
    swuStatsCapture: sha,
  }),
  codeCommit: z.string().min(1),
  coefficientsSha256: sha,
  scoredCards: z.number().int(),
  outputHash: sha,
});
export type ScoresReplay = z.infer<typeof scoresReplaySchema>;

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const r4n = (x: number | null): number | null => (x === null ? null : r4(x));

function percentiles(values: Map<string, number>): Map<string, number> {
  const sorted = [...values.values()].sort((a, b) => a - b);
  const out = new Map<string, number>();
  for (const [key, v] of values) {
    let atOrBelow = 0;
    while (atOrBelow < sorted.length && sorted[atOrBelow] <= v) atOrBelow++;
    out.set(key, Math.round((1000 * atOrBelow) / sorted.length) / 10);
  }
  return out;
}

/** Rounds every number and adds within-type percentiles; output order is cardKey by code point. */
export function toScoreRows(scores: readonly CardScore[]): ScoreRow[] {
  const byType = new Map<string, CardScore[]>();
  for (const s of scores) if (s.scored) byType.set(s.type, [...(byType.get(s.type) ?? []), s]);
  const pTotal = new Map<string, number>();
  const pPlay = new Map<string, number>();
  for (const group of byType.values()) {
    const t = percentiles(new Map(group.flatMap((s) => (s.total === null ? [] : [[s.cardKey, r4(s.total)] as const]))));
    const p = percentiles(new Map(group.flatMap((s) => (s.playCalibrated === null ? [] : [[s.cardKey, r4(s.playCalibrated)] as const]))));
    for (const [k, v] of t) pTotal.set(k, v);
    for (const [k, v] of p) pPlay.set(k, v);
  }
  return [...scores]
    .sort((a, b) => compareCodePoints(a.cardKey, b.cardKey))
    .map((s) => ({
      ...s,
      components: {
        expectedStats: r4n(s.components.expectedStats),
        statSurplus: r4(s.components.statSurplus),
        costTerm: r4(s.components.costTerm),
        keywordPoints: r4(s.components.keywordPoints),
        effectPoints: r4(s.components.effectPoints),
        modifiers: r4(s.components.modifiers),
        playabilityT: r4(s.components.playabilityT),
        playabilityTStat: r4(s.components.playabilityTStat),
      },
      efficiency: r4n(s.efficiency),
      total: r4n(s.total),
      playCalibrated: r4n(s.playCalibrated),
      playCalibratedNoT: r4n(s.playCalibratedNoT),
      terms: s.terms.map((t) => ({ ...t, value: r4(t.value) })).filter((t) => t.value !== 0),
      percentile: { total: pTotal.get(s.cardKey) ?? null, playCalibrated: pPlay.get(s.cardKey) ?? null },
    }));
}
