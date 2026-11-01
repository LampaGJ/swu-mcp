/**
 * @displayName Branch-sampled decision values
 * @strategicPurpose The evaluator's supervision is the mean outcome of every legal action at sampled decisions,
 * estimated over re-dealt hidden information and seeded continuations; this module fixes that dataset's record and
 * manifest contract and every seed it uses, so a dataset replays from its manifest and refuses human-derived inputs.
 * @tacticalObjective Zod v4 schemas for one branch record, the dataset manifest and both worker seams (task in, result
 * out), the keyed seed strings, the keyed-uniform sampling rule, the candidate rule, per-action aggregation of a K x N
 * outcome grid, the 70/15/15 seed split, and the input refusals (deck sources, evaluator D22 class, seed ranges
 * overlapping the inventory's evaluation range). Pure.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { mulberry32 } from "../embed/math.js";
import { hex64 } from "../schemas/hash.js";
import { compareCodePoints } from "../swu/canonical.js";
import { engineListSchema, END_CONDITIONS } from "./schemas.js";
import { encodedStateSchema } from "./state.js";

export const BRANCH_LABEL = "bot play (D21): continuation values under the named rung, never pooled with tournament data";
/** The determinization primitive the sampler reuses (#163's flat Monte Carlo); #128 imports the same function. */
export const DETERMINIZE_PRIMITIVE = "src/sims/policies/flat-mc.ts determinize";
/** Deck sources a source batch may use: tournament lists (melee) and community lists (swudb). Anything else, Karabast included, is refused by name. */
export const deckSourceSchema = z.enum(["melee", "swudb"]);
export const seedRangeSchema = z.strictObject({ from: z.int().min(0), count: z.int().positive() });
export type SeedRange = z.infer<typeof seedRangeSchema>;

/** Same value as seededRandom(key)() in scripts/bench/stats.ts:13; src/ may not import scripts/. */
export function keyedUniform(key: string): number {
  return mulberry32(createHash("sha256").update(key, "utf8").digest().readUInt32BE(0))();
}

export const seedKeys = {
  sample: (run: string, gameId: string, k: number): string => `branch-sample|${run}|${gameId}|${k}`,
  det: (run: string, gameId: string, k: number, j: number): string => `det|${run}|${gameId}|${k}|${j}`,
  engine: (run: string, gameId: string, k: number, j: number, i: number): string => `branch|${run}|${gameId}|${k}|${j}|${i}`,
  cont: (run: string, gameId: string, k: number, j: number, i: number): string => `cont|${run}|${gameId}|${k}|${j}|${i}`,
  after: (run: string, gameId: string, k: number): string => `after|${run}|${gameId}|${k}`,
};

export interface Candidate {
  gameId: string;
  k: number;
}

/**
 * A main-action prompt of the action phase at a fresh timepoint (the snapshot id changed) with at least two legal
 * answers. The manual snapshot equals the live state only at a main-action prompt (src/sims/engine.ts:311), and a
 * single-answer decision carries no signal.
 */
export function isCandidate(prevSnapshotId: unknown, snapshotId: unknown, phase: string | null, promptKind: string, legalCount: number): boolean {
  return snapshotId !== prevSnapshotId && phase === "action" && promptKind === "mainAction" && legalCount >= 2;
}

/** Keeps candidates whose keyed uniform is below rate, then the `target` smallest; independent of worker count and order. */
export function selectDecisions(run: string, candidates: readonly Candidate[], rate: number, target: number): Candidate[] {
  return candidates
    .map((c) => ({ c, u: keyedUniform(seedKeys.sample(run, c.gameId, c.k)) }))
    .filter((row) => row.u < rate)
    .sort((a, b) => a.u - b.u || compareCodePoints(a.c.gameId, b.c.gameId) || a.c.k - b.c.k)
    .slice(0, target)
    .map((row) => row.c)
    .sort((a, b) => compareCodePoints(a.gameId, b.gameId) || a.k - b.k);
}

/** #126's 70/15/15 split of a contiguous source range into disjoint {from, count} ranges; test takes the remainder. */
export function splitSeedRange(r: SeedRange): { train: SeedRange; validation: SeedRange; test: SeedRange } {
  const train = Math.floor(r.count * 0.7);
  const validation = Math.floor(r.count * 0.15);
  return {
    train: { from: r.from, count: train },
    validation: { from: r.from + train, count: validation },
    test: { from: r.from + train + validation, count: r.count - train - validation },
  };
}

export type Outcome = "win" | "loss" | "draw" | "timeout" | "error";
export type EndCondition = (typeof END_CONDITIONS)[number];

/** A continuation's end from the acting seat; stuck counts as a timeout (no result), an error as no outcome. */
export function continuationOutcome(end: EndCondition, winner: 1 | 2 | null, actor: 1 | 2): Outcome {
  if (end === "base_destroyed") return winner === actor ? "win" : "loss";
  if (end === "draw") return "draw";
  if (end === "error") return "error";
  return "timeout";
}

/** #126's outcome-row label: the actor's result in the source game, null when it ended in an error. */
export function sourceOutcomeOf(end: EndCondition, winner: 1 | 2 | null, actor: 1 | 2): 0 | 0.5 | 1 | null {
  const o = continuationOutcome(end, winner, actor);
  return o === "error" ? null : o === "win" ? 1 : o === "loss" ? 0 : 0.5;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const share = (os: readonly Outcome[]): { n: number; nWin: number; nDraw: number; nTimeout: number; nErr: number; mean: number | null } => {
  const nWin = os.filter((o) => o === "win").length;
  const nTimeout = os.filter((o) => o === "timeout").length;
  const nDraw = os.filter((o) => o === "draw").length + nTimeout;
  const nErr = os.filter((o) => o === "error").length;
  const n = os.length - nErr;
  return { n, nWin, nDraw, nTimeout, nErr, mean: n === 0 ? null : round6((nWin + 0.5 * nDraw) / n) };
};

/** grid[j][i]: outcome of continuation i under determinization j, from the acting seat. An error is excluded, never a 0 or 1. */
export function aggregateAction(grid: readonly (readonly Outcome[])[]) {
  const all = share(grid.flat());
  return { ...all, perDet: grid.map((row) => share(row).mean) };
}

const prob = z.number().min(0).max(1);
export const actionValueSchema = z.strictObject({
  descriptor: z.string().min(1),
  kind: z.string().min(1),
  cardKey: z.string().min(1).nullable(),
  mean: prob.nullable(),
  n: z.int().min(0),
  nWin: z.int().min(0),
  nDraw: z.int().min(0),
  nTimeout: z.int().min(0),
  nErr: z.int().min(0),
  perDet: z.array(prob.nullable()),
  afterState: encodedStateSchema.nullable(),
  /** "error" when the afterstate could not be reached (an engine error, timeout or stuck loop); its state is then null. */
  afterTerminal: z.enum(["none", "win", "loss", "draw", "error"]),
});
export type ActionValue = z.infer<typeof actionValueSchema>;

export const sourceOutcomeSchema = z.union([z.literal(0), z.literal(0.5), z.literal(1)]).nullable();

export const branchRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    gameId: z.string().min(1),
    seed: z.int().min(0),
    k: z.int().min(0),
    round: z.int().min(0),
    phase: z.literal("action"),
    actor: z.union([z.literal(1), z.literal(2)]),
    promptKind: z.string().min(1),
    state: encodedStateSchema,
    legalActions: z.array(actionValueSchema).min(2),
    chosen: z.strictObject({ descriptor: z.string().min(1), index: z.int().min(0).nullable() }),
    sourceOutcome: sourceOutcomeSchema,
    rngCursor: z.string().min(1),
    rootMatched: z.boolean(),
    determinization: z.strictObject({ mode: z.enum(["multiset", "decks"]), K: z.int().positive(), N: z.int().positive() }),
  })
  .superRefine((r, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => ctx.addIssue({ code: "custom", message, path });
    const { K, N } = r.determinization;
    r.legalActions.forEach((a, i) => {
      const p = ["legalActions", i];
      if (i > 0 && compareCodePoints(r.legalActions[i - 1].descriptor, a.descriptor) >= 0) issue("descriptors must be unique and sorted by code point", [...p, "descriptor"]);
      if (a.n + a.nErr !== K * N) issue(`n + nErr must equal K x N = ${K * N}`, [...p, "n"]);
      if (a.perDet.length !== K) issue(`perDet must hold K = ${K} values`, [...p, "perDet"]);
      if (a.nWin + a.nDraw > a.n || a.nTimeout > a.nDraw) issue("win, draw and timeout counts exceed n", [...p, "nWin"]);
      const expected = a.n === 0 ? null : round6((a.nWin + 0.5 * a.nDraw) / a.n);
      if (a.mean !== expected) issue(`mean must be ${expected}`, [...p, "mean"]);
      if ((a.afterState === null) !== (a.afterTerminal !== "none")) issue("afterState is null exactly when the action ends the game or errors", [...p, "afterState"]);
    });
    const at = r.chosen.index;
    if (at !== null && r.legalActions[at]?.descriptor !== r.chosen.descriptor) issue("chosen.index does not point at chosen.descriptor", ["chosen", "index"]);
    if (at === null && r.legalActions.some((a) => a.descriptor === r.chosen.descriptor)) issue("chosen.index is null but the descriptor is legal", ["chosen", "index"]);
    if (at === null && r.rootMatched) issue("a chosen action can be absent only when the restored root differs", ["rootMatched"]);
  });
export type BranchRecord = z.infer<typeof branchRecordSchema>;

export const humanDerivedInputSchema = z.strictObject({
  kind: z.enum(["deck", "evaluator", "rollout-policy"]),
  id: z.string().min(1),
  reason: z.string().min(1),
});

const splitRangeSchema = z.strictObject({ from: z.int().min(0), count: z.int().min(0) });

export const rangesOverlap = (a: SeedRange, b: SeedRange): boolean => a.from < b.from + b.count && b.from < a.from + a.count;

/** The committed ladder record showing the continuation rung beat the rung below it (D95: what "rung 2 or higher" means). */
export const ladderEvidenceSchema = z.strictObject({ step: z.string().min(1), file: z.string().min(1), sha256: hex64, passed: z.boolean() });

export const branchManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    label: z.literal(BRANCH_LABEL),
    purpose: z.enum(["pilot", "dataset", "fixture"]),
    trainingEligible: z.boolean(),
    parameters: z.strictObject({
      runSeed: z.string().min(1),
      rate: z.number().gt(0).max(1),
      target: z.int().positive(),
      K: z.int().positive(),
      N: z.int().positive(),
      rung: z.int().min(0).max(4),
      maxContinuationDecisions: z.int().positive(),
      /** Source games past this cap end as timeouts and, like errors and stuck games, give no candidates. */
      maxSourceDecisions: z.int().positive(),
      date: z.iso.date(),
    }),
    determinization: z.strictObject({ mode: z.enum(["multiset", "decks"]), primitive: z.literal(DETERMINIZE_PRIMITIVE) }),
    engine: z.strictObject({ commit: z.string().min(7), cardDataSha256: hex64, node: z.string().min(1), undoMode: z.literal("free") }),
    continuationPolicy: z.strictObject({
      rung: z.int().min(0).max(4),
      spec: z.string().min(1),
      policyId: z.string().min(1),
      version: z.string().min(1),
      paramsSha256: hex64,
      evaluatorManifestSha256: hex64.nullable(),
      ladder: ladderEvidenceSchema.nullable(),
    }),
    vocab: z.strictObject({ dataVersion: z.string().min(1), contentSha256: hex64 }),
    state: z.strictObject({ stateVersion: z.int().positive(), layoutSha256: hex64 }),
    source: z.strictObject({
      /** sha256 of the canonical source batch: every game's seed, decks and policies (generated in this run; #111 did not land). */
      batchSha256: hex64,
      generator: z.literal("in-run"),
      policy: z.string().min(1),
      seedRanges: z.array(seedRangeSchema).min(1),
      /** #126's advisory 70/15/15 split; a fixture-sized range may leave a split empty. */
      splits: z.strictObject({ train: splitRangeSchema, validation: splitRangeSchema, test: splitRangeSchema }),
      evaluationSeedRange: seedRangeSchema,
      deckSources: z.array(deckSourceSchema).min(1),
    }),
    counts: z.strictObject({
      sourceGames: z.int().min(0),
      sourceErrors: z.int().min(0),
      sourceTimeouts: z.int().min(0),
      sourceReplayMismatch: z.int().min(0),
      candidates: z.int().min(0),
      singleAnswerSkipped: z.int().min(0),
      sampled: z.int().min(0),
      sampledGames: z.int().min(0),
      testGames: z.int().min(0),
      records: z.int().min(0),
      rootMismatch: z.int().min(0),
      actions: z.int().min(0),
      continuations: z.int().min(0),
      draws: z.int().min(0),
      timeouts: z.int().min(0),
      afterTerminal: z.int().min(0),
      errors: z.record(z.string().min(1), z.int().min(0)),
      unknownCards: z.int().min(0),
      unitOverflow: z.int().min(0),
    }),
    humanDerivedInputs: z.array(humanDerivedInputSchema).max(0),
    outputs: z.strictObject({ records: z.int().min(0), jsonlSha256: hex64, gzSha256: hex64 }),
    replay: z.strictObject({ inputHash: hex64, codeCommit: z.string().min(7), outputHash: hex64 }),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]): void => ctx.addIssue({ code: "custom", message, path });
    const policy = m.continuationPolicy;
    if (m.trainingEligible && (policy.rung < 1 || policy.ladder === null || !policy.ladder.passed))
      issue("a dataset is training-eligible only with continuations at a rung above 0 that passed its ladder step (D95)", ["trainingEligible"]);
    if (policy.rung !== m.parameters.rung) issue("continuation rung differs from parameters.rung", ["continuationPolicy", "rung"]);
    m.source.seedRanges.forEach((r, i) => {
      if (rangesOverlap(r, m.source.evaluationSeedRange)) issue("source seeds overlap the inventory's evaluationSeedRange", ["source", "seedRanges", i]);
    });
  });
export type BranchManifest = z.infer<typeof branchManifestSchema>;

/** Refusals checked before any game runs; each throws naming the offending input. */
export function assertInputsAllowed(input: { deckSources: readonly string[]; seedRanges: readonly SeedRange[]; evaluationSeedRange: SeedRange; evaluatorD22: "clear" | "quarantined" | null }): void {
  for (const source of input.deckSources) {
    if (!deckSourceSchema.safeParse(source).success) throw new Error(`deck source "${source}" is not allowed in a branch dataset (allowed: melee, swudb)`);
  }
  for (const r of input.seedRanges) {
    if (rangesOverlap(r, input.evaluationSeedRange)) throw new Error(`source seeds ${r.from}..${r.from + r.count - 1} overlap the evaluation range`);
  }
  if (input.evaluatorD22 === "quarantined") throw new Error("the continuation evaluator is D22 quarantined");
}

// ---------------------------------------------------------------------------------------------------------------------
// Worker seams: the main thread validates each task it posts and parses each result that arrives; the worker parses the
// task it receives and validates the result before posting it.

const deckInputSchema = z.strictObject({
  list: engineListSchema,
  leader: z.string().min(1),
  base: z.string().min(1),
  cards: z.array(z.strictObject({ cardKey: z.string().min(1), count: z.int().positive() })),
  source: z.string().min(1),
});
export const sourceSpecSchema = z.strictObject({
  seed: z.string().regex(/^\d+$/),
  decks: z.tuple([deckInputSchema, deckInputSchema]),
  policies: z.tuple([z.string().min(1), z.string().min(1)]),
  recordMode: z.literal("none"),
  undo: z.literal(true),
  codeCommit: z.string().min(7),
});
export type SourceSpec = z.infer<typeof sourceSpecSchema>;

const seat = z.union([z.literal(1), z.literal(2)]);
const endConditionSchema = z.enum(END_CONDITIONS);

/** A candidate decision as the source pass saw it; the branch pass must reach the same legal set and RNG cursor at k. */
const candidateDecisionSchema = z.strictObject({ k: z.int().min(0), actor: seat, chosen: z.string().min(1), legalActionsSha256: hex64, rngCursor: z.string().min(1) });

export const candidateTaskSchema = z.strictObject({ gameId: z.string().min(1), spec: sourceSpecSchema, maxSourceDecisions: z.int().positive() });
export type CandidateTask = z.infer<typeof candidateTaskSchema>;

export const candidateResultSchema = z.strictObject({
  gameId: z.string().min(1),
  endCondition: endConditionSchema,
  winner: seat.nullable(),
  decisions: z.int().min(0),
  traceSha256: hex64,
  candidates: z.array(candidateDecisionSchema),
  singleAnswer: z.int().min(0),
});
export type CandidateResult = z.infer<typeof candidateResultSchema>;

export const branchTaskSchema = z.strictObject({
  gameId: z.string().min(1),
  spec: sourceSpecSchema,
  ks: z.array(candidateDecisionSchema).min(1),
  traceSha256: hex64,
  sourceOutcome: z.strictObject({ endCondition: endConditionSchema, winner: seat.nullable() }),
  K: z.int().positive(),
  N: z.int().positive(),
  runSeed: z.string().min(1),
  maxContinuationDecisions: z.int().positive(),
  maxSourceDecisions: z.int().positive(),
});
export type BranchTask = z.infer<typeof branchTaskSchema>;

const msList = z.array(z.number().min(0));
export const branchStatsSchema = z.strictObject({
  rollbackMs: msList,
  determinizeMs: msList,
  afterstateMs: msList,
  continuationMs: z.number().min(0),
  continuations: z.int().min(0),
  /** Decisions whose actor deck held 10 or more cards, and how many of those had 2+ distinct top-5 orders across the K deals. */
  decks10: z.int().min(0),
  decksDistinctTop5: z.int().min(0),
  /** Deals that changed the opponent's hand-plus-deck multiset (must stay 0). */
  multisetViolations: z.int().min(0),
  /** Deals of one j that differed between continuations or actions (common random numbers broken; must stay 0). */
  dealDrift: z.int().min(0),
  /** Restores whose legal descriptor set differed from the root's after a continuation (the eviction hazard; must stay 0). */
  rootDrift: z.int().min(0),
});
export type BranchStats = z.infer<typeof branchStatsSchema>;

export const branchTaskResultSchema = z.strictObject({
  gameId: z.string().min(1),
  /** The first sampled k whose replayed legal set or RNG cursor differed from the source pass: the game stops there and later ks are dropped and counted. */
  replayMismatchAt: z.int().min(0).nullable(),
  /** The source game, run on after its last branch, ended on the source pass's traceSha256 (branching left it unperturbed). */
  traceMatched: z.boolean(),
  records: z.array(branchRecordSchema),
  errors: z.record(z.string().min(1), z.int().min(0)),
  stats: branchStatsSchema,
});
export type BranchTaskResult = z.infer<typeof branchTaskResultSchema>;
