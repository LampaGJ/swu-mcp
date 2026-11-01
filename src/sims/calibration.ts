import { z } from "zod";
import { wilson } from "../meta/stats.js";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Simulation calibration gate
 * @strategicPurpose A rung's win shares reach simulate_matchup only when a pinned gate record shows it replays, is
 * healthy, beats the rungs below it, and ranks tournament matchups the way tournaments do (#115). Without the last
 * check a bot win share measures tempo, not deck strength. Bot play and tournament results are compared side by
 * side, never pooled (D21).
 * @tacticalObjective Spearman rank correlation on average ranks, the exact one-sided sign test for favourite
 * agreement, tournament matchup lookup by leader and base aspects, the health and ladder checks, the strict schema of
 * the pinned gate record (the tool's trust boundary), and the pilot choice that refuses a rung with a plain sentence
 * naming its failed gate (D9).
 */

export const CALIBRATION_VERSION = "1";

/**
 * Fixed before the first measurement (D88): the research doc's estimates. The first rung 1 and rung 3 measurements
 * were read against these values; changing one after seeing a result needs a new D-entry that says so.
 */
export const CALIBRATION_THRESHOLDS = {
  spearmanMin: 0.5,
  favouriteAlpha: 0.05,
  nonDecisiveMax: 0.02,
  fallbackMax: 0.05,
  replayMatches: 50,
  minN: 10,
} as const;
export type CalibrationThresholds = typeof CALIBRATION_THRESHOLDS;

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;

export function averageRanks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x || a.i - b.i);
  const ranks = new Array<number>(xs.length);
  for (let s = 0; s < order.length; ) {
    let e = s;
    while (e + 1 < order.length && order[e + 1].x === order[s].x) e++;
    const rank = (s + e) / 2 + 1;
    for (let k = s; k <= e; k++) ranks[order[k].i] = rank;
    s = e + 1;
  }
  return ranks;
}

/** Pearson correlation of the average ranks; null below three points or when either side is constant. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const rx = averageRanks(xs);
  const ry = averageRanks(ys);
  const n = xs.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my);
    sxx += (rx[i] - mx) ** 2;
    syy += (ry[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Exact one-sided binomial test at p = 0.5: P(X >= k) for X ~ Bin(n, 0.5). */
export function signTestGreater(k: number, n: number): number {
  if (n === 0 || k <= 0) return 1;
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= n; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= k) tail += Math.exp(logC + n * Math.log(0.5));
  }
  return Math.min(1, tail);
}

export interface Side {
  leader: string;
  /** Base aspects sorted and joined with + (empty for a neutral base), as src/sims/opponents.ts keys an archetype. */
  baseAspects: string;
}

export interface MatchupRow {
  leader: string;
  baseAspects: readonly string[];
  oppLeader: string;
  oppBaseAspects: readonly string[];
  wins: number;
  losses: number;
  draws: number;
}

export interface TournamentShare {
  wins: number;
  losses: number;
  n: number;
  share: number;
  low: number | null;
  high: number | null;
  excludesHalf: boolean;
}

const aspectsKey = (xs: readonly string[]): string => [...xs].sort(compareCodePoints).join("+");

/** A's record against B in swumetastats' tournament matchups, draws left out; null below minN decisive matches. */
export function tournamentRecord(pairs: readonly MatchupRow[], a: Side, b: Side, minN: number): TournamentShare | null {
  const hit = pairs.find((p) => p.leader === a.leader && aspectsKey(p.baseAspects) === a.baseAspects && p.oppLeader === b.leader && aspectsKey(p.oppBaseAspects) === b.baseAspects);
  if (hit === undefined) return null;
  const n = hit.wins + hit.losses;
  if (n < minN) return null;
  const w = wilson(hit.wins, n);
  return { wins: hit.wins, losses: hit.losses, n, share: r4(hit.wins / n), low: w?.low ?? null, high: w?.high ?? null, excludesHalf: w !== null && (w.low > 0.5 || w.high < 0.5) };
}

export interface SimShare {
  wins: number;
  n: number;
  share: number | null;
  low: number | null;
  high: number | null;
  nonDecisive: number;
}

export interface CalibrationRow {
  a: string;
  b: string;
  aName: string;
  bName: string;
  tournament: TournamentShare;
  sim: SimShare;
}

export interface ExternalResult {
  pass: boolean;
  failed: ("spearman" | "favourite")[];
  pairs: number;
  spearman: number | null;
  favourite: { counted: number; agree: number; disagree: number; simTies: number; pValue: number };
}

/**
 * Spearman over every pair with a decisive sim game, oriented from the higher-share archetype; favourite agreement
 * over the pairs whose tournament Wilson interval excludes 50%, a sim share of exactly 50% counting as no agreement.
 */
export function externalGate(rows: readonly CalibrationRow[], th: Pick<CalibrationThresholds, "spearmanMin" | "favouriteAlpha">): ExternalResult {
  const live = rows.filter((r) => r.sim.share !== null);
  const rho = spearman(
    live.map((r) => r.sim.share as number),
    live.map((r) => r.tournament.share),
  );
  let agree = 0;
  let disagree = 0;
  let simTies = 0;
  for (const r of live) {
    if (!r.tournament.excludesHalf) continue;
    const s = r.sim.share as number;
    if (s === 0.5) simTies++;
    else if (s > 0.5 === r.tournament.share > 0.5) agree++;
    else disagree++;
  }
  const counted = agree + disagree + simTies;
  const pValue = signTestGreater(agree, counted);
  const failed: ExternalResult["failed"] = [];
  if (rho === null || rho < th.spearmanMin) failed.push("spearman");
  if (!(pValue < th.favouriteAlpha)) failed.push("favourite");
  return { pass: failed.length === 0, failed, pairs: live.length, spearman: rho === null ? null : r4(rho), favourite: { counted, agree, disagree, simTies, pValue: Number(pValue.toPrecision(4)) } };
}

export function healthGate(x: { games: number; nonDecisive: number; decisions: number; fallback: number }, th: Pick<CalibrationThresholds, "nonDecisiveMax" | "fallbackMax">) {
  const nonDecisiveShare = x.games === 0 ? 1 : r4(x.nonDecisive / x.games);
  const fallbackShare = x.decisions === 0 ? 1 : r4(x.fallback / x.decisions);
  return { pass: x.games > 0 && nonDecisiveShare <= th.nonDecisiveMax && fallbackShare <= th.fallbackMax, ...x, nonDecisiveShare, fallbackShare };
}

export interface LadderWant {
  candidate: string;
  baseline: string;
  engineCommit: string;
  inputs: { scoresSha256: string; coefficientsSha256: string; featuresSha256: string };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- a ladder record is read loosely here and checked field by field */
/** One ladder step from a pinned ladder record: passes only for the same candidate, baseline, engine and tables. */
export function ladderStep(file: string, rec: any, sha256: string | null, want: LadderWant) {
  const base = { record: file, sha256, candidate: want.candidate, against: want.baseline };
  if (rec === null || rec === undefined) return { ...base, pass: false, share: null, pValue: null, stale: "no ladder record" };
  const stale =
    rec.candidate?.spec !== want.candidate
      ? `candidate ${rec.candidate?.spec}, not ${want.candidate}`
      : rec.baseline?.spec !== want.baseline
        ? `baseline ${rec.baseline?.spec}, not ${want.baseline}`
        : rec.engine?.commit !== want.engineCommit
          ? `engine commit ${rec.engine?.commit}, not ${want.engineCommit}`
          : (["scoresSha256", "coefficientsSha256", "featuresSha256"] as const).find((k) => rec.inputs?.[k] !== want.inputs[k])
            ? "the record's card tables differ from the pilot's"
            : null;
  return { ...base, pass: stale === null && rec.summary?.pass === true, share: rec.summary?.pooled?.share ?? null, pValue: rec.summary?.discordant?.pValue ?? null, stale };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, { error: "expected a sha256 hex digest" });
const share = z.number().min(0).max(1);
const nullableShare = share.nullable();

const ladderStepSchema = z.strictObject({
  record: z.string().min(1),
  sha256: hex64.nullable(),
  candidate: z.string().min(1),
  against: z.string().min(1),
  pass: z.boolean(),
  share: nullableShare,
  pValue: z.number().nullable(),
  stale: z.string().nullable(),
});

const rowSchema = z.strictObject({
  a: z.string().min(1),
  b: z.string().min(1),
  aName: z.string().min(1),
  bName: z.string().min(1),
  tournament: z.strictObject({ wins: z.int().nonnegative(), losses: z.int().nonnegative(), n: z.int().positive(), share, low: nullableShare, high: nullableShare, excludesHalf: z.boolean() }),
  sim: z.strictObject({ wins: z.int().nonnegative(), n: z.int().nonnegative(), share: nullableShare, low: nullableShare, high: nullableShare, nonDecisive: z.int().nonnegative() }),
});

/** The pinned calibration gate record; simulate_matchup parses it before it serves a rung. */
export const gateRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  step: z.string().min(1),
  calibrationVersion: z.literal(CALIBRATION_VERSION),
  label: z.string().min(1),
  policy: z.strictObject({
    spec: z.string().min(1),
    id: z.string().min(1),
    version: z.string().min(1),
    rung: z.int().nonnegative(),
    params: z.record(z.string(), z.number()),
    paramsSha256: hex64,
    driverPolicy: z.string().min(1),
  }),
  engine: z.strictObject({ repo: z.string().min(1), commit: z.string().min(7), cardDataVersion: z.string().min(1), cardDataSha256: hex64 }),
  inputs: z.strictObject({
    scoresSha256: hex64,
    coefficientsSha256: hex64,
    featuresSha256: hex64,
    leaderCardsSha256: hex64,
    winratesSha256: hex64,
    archetypesSha256: hex64,
  }),
  pilotRun: z.iso.date(),
  metaRun: z.iso.date(),
  decks: z.string().min(1),
  codeCommit: z.string().min(7),
  thresholds: z.strictObject({
    spearmanMin: z.number(),
    favouriteAlpha: z.number(),
    nonDecisiveMax: z.number(),
    fallbackMax: z.number(),
    replayMatches: z.int().positive(),
    minN: z.int().positive(),
  }),
  seeds: z.strictObject({ from: z.int().nonnegative(), to: z.int().nonnegative(), gamesPerPair: z.int().positive(), scheme: z.string().min(1), listsPerArchetype: z.int().positive().optional() }),
  panel: z.array(
    z.strictObject({ archetype: z.string().min(1), name: z.string().min(1), leader: z.string().min(1), baseAspects: z.string(), share, list: z.string().min(1), sha256: hex64 }),
  ),
  gates: z.strictObject({
    replay: z.strictObject({
      pass: z.boolean(),
      matches: z.int().nonnegative(),
      workerEqualsThread: z.int().nonnegative(),
      replayed: z.int().nonnegative(),
      undoIdentical: z.int().nonnegative().nullable(),
      evidence: z.array(z.strictObject({ file: z.string().min(1), sha256: hex64 })),
      note: z.string(),
      failures: z.array(z.string()),
    }),
    health: z.strictObject({
      pass: z.boolean(),
      games: z.int().nonnegative(),
      nonDecisive: z.int().nonnegative(),
      decisions: z.int().nonnegative(),
      fallback: z.int().nonnegative(),
      nonDecisiveShare: z.number(),
      fallbackShare: z.number(),
      endConditions: z.record(z.string(), z.int().nonnegative()),
    }),
    ladder: z.strictObject({ pass: z.boolean(), steps: z.array(ladderStepSchema) }),
    external: z.strictObject({
      pass: z.boolean(),
      failed: z.array(z.enum(["spearman", "favourite"])),
      pairs: z.int().nonnegative(),
      spearman: z.number().nullable(),
      favourite: z.strictObject({ counted: z.int().nonnegative(), agree: z.int().nonnegative(), disagree: z.int().nonnegative(), simTies: z.int().nonnegative(), pValue: z.number() }),
      simLabel: z.string().min(1),
      tournamentLabel: z.string().min(1),
      rows: z.array(rowSchema),
    }),
  }),
  pass: z.boolean(),
  servesWinShare: z.boolean(),
  failedGates: z.array(z.enum(["replay", "health", "ladder", "external"])),
});
export type GateRecord = z.infer<typeof gateRecordSchema>;

const GATE_NAMES = { replay: "replay gate", health: "health gate", ladder: "ladder gate", external: "external calibration gate" } as const;

/** The plain sentence a refused rung gets (D9); null when every gate passed. */
export function failedGateSentence(rec: GateRecord): string | null {
  const first = rec.failedGates[0];
  if (first === undefined) return null;
  const spec = rec.policy.spec;
  if (first === "external") {
    const e = rec.gates.external;
    return `${spec} failed the external calibration gate: its matchup win shares rank tournament matchups with Spearman ${e.spearman ?? "n/a"} (needs ${rec.thresholds?.spearmanMin ?? CALIBRATION_THRESHOLDS.spearmanMin}) and pick the tournament favourite in ${e.favourite.agree} of ${e.favourite.counted} clear matchups (one-sided p = ${e.favourite.pValue}), so it may not report a win share.`;
  }
  if (first === "health") {
    const h = rec.gates.health;
    return `${spec} failed the health gate: ${h.nonDecisiveShare} of its games were not decisive and ${h.fallbackShare} of its decisions fell back to random play, so it may not report a win share.`;
  }
  return `${spec} failed the ${GATE_NAMES[first]}, so it may not report a win share.`;
}

export type PilotChoice = { spec: string; record: GateRecord } | { error: string };

/**
 * The requested policy when its record passes; otherwise the highest passing rung (ties: the spec name in code-point
 * order). A record pinned to another engine commit serves nothing.
 */
export function choosePilot(records: readonly GateRecord[], requested: string | undefined, engineCommit: string): PilotChoice {
  if (requested !== undefined) {
    const rec = records.find((r) => r.policy.spec === requested);
    if (rec === undefined) return { error: `${requested} has no calibration gate record, so it may not report a win share; run scripts/sims/calibration-gate.ts --policy ${requested} first.` };
    if (rec.engine.commit !== engineCommit) return { error: `the calibration record for ${requested} was measured on engine commit ${rec.engine.commit}, not the pinned ${engineCommit}; re-run the calibration gate.` };
    const why = failedGateSentence(rec);
    return why === null ? { spec: requested, record: rec } : { error: why };
  }
  const passing = records.filter((r) => r.servesWinShare && r.failedGates.length === 0 && r.engine.commit === engineCommit);
  passing.sort((a, b) => b.policy.rung - a.policy.rung || compareCodePoints(a.policy.spec, b.policy.spec));
  if (passing.length > 0) return { spec: passing[0].policy.spec, record: passing[0] };
  const reasons = records.map((r) => (r.engine.commit !== engineCommit ? `${r.policy.spec} was measured on engine commit ${r.engine.commit}, not the pinned ${engineCommit}.` : failedGateSentence(r))).filter((s): s is string => s !== null);
  return { error: `no bot rung has passed every calibration gate, so simulate_matchup reports no win share.${reasons.length > 0 ? ` ${reasons.join(" ")}` : " No calibration gate record exists yet."}` };
}

const Z95 = 1.959964;

/**
 * 95% interval of a Spearman coefficient: Fisher's z with the Bonett-Wright variance (1 + rho^2 / 2) / (n - 3); null
 * below four points.
 */
export function spearmanInterval(rho: number, n: number): { low: number; high: number } | null {
  if (n < 4) return null;
  const z = Math.atanh(rho);
  const se = Math.sqrt((1 + (rho * rho) / 2) / (n - 3));
  return { low: r4(Math.tanh(z - Z95 * se)), high: r4(Math.tanh(z + Z95 * se)) };
}

export const INTERVAL_METHOD = "Spearman: Fisher z with the Bonett-Wright variance; favourite agreement: Wilson score on agree / counted; both 95%";

/** The external gate's two figures with 95% intervals (#171), derived from a record's own fields; reported beside the gate, never part of its verdict. */
export function externalIntervals(ext: { spearman: number | null; pairs: number; favourite: { counted: number; agree: number } }) {
  const s = ext.spearman === null ? null : spearmanInterval(ext.spearman, ext.pairs);
  const f = wilson(ext.favourite.agree, ext.favourite.counted);
  return { spearman95: s === null ? null : ([s.low, s.high] as [number, number]), favourite95: f === null ? null : ([f.low, f.high] as [number, number]), method: INTERVAL_METHOD };
}

export const CALIBRATION_SEED0 = 4_000_000;

/** One calibration game: archetypes i < j in panel order, list ai of i against list bi of j. */
export interface CalibrationJob {
  pair: number;
  i: number;
  j: number;
  seed: number;
  /** True when archetype i sits in seat 1. */
  iFirst: boolean;
  ai: number;
  bi: number;
}

/**
 * Every archetype pair i < j plays seeds 4,000,000 + 1,000p + q for q < gamesPerPair / 2, each seed twice with the seats
 * swapped. With k lists per archetype seed q plays list pairing q mod k^2 (list floor(c / k) of i against list c mod k of
 * j), so every pairing gets the same seeds in both seat orders; k = 1 is the pinned v1 layout.
 */
export function calibrationJobs(archetypes: number, gamesPerPair: number, lists = 1): { pairs: [number, number][]; jobs: CalibrationJob[] } {
  if (!Number.isInteger(gamesPerPair) || gamesPerPair < 2 || gamesPerPair % 2 !== 0) throw new Error("games per pair must be an even integer >= 2");
  const combos = lists * lists;
  if ((gamesPerPair / 2) % combos !== 0) throw new Error(`${gamesPerPair / 2} seeds per pair do not divide evenly over ${combos} list pairings`);
  const pairs: [number, number][] = [];
  for (let i = 0; i < archetypes; i++) for (let j = i + 1; j < archetypes; j++) pairs.push([i, j]);
  const jobs: CalibrationJob[] = [];
  pairs.forEach(([i, j], p) => {
    for (let q = 0; q < gamesPerPair / 2; q++) {
      const c = q % combos;
      const base = { pair: p, i, j, seed: CALIBRATION_SEED0 + 1000 * p + q, ai: Math.floor(c / lists), bi: c % lists };
      jobs.push({ ...base, iFirst: true }, { ...base, iFirst: false });
    }
  });
  return { pairs, jobs };
}

/** Archetype and list in seat 1, then seat 2. */
export const seats = (jb: CalibrationJob): [{ archetype: number; list: number }, { archetype: number; list: number }] =>
  jb.iFirst
    ? [
        { archetype: jb.i, list: jb.ai },
        { archetype: jb.j, list: jb.bi },
      ]
    : [
        { archetype: jb.j, list: jb.bi },
        { archetype: jb.i, list: jb.ai },
      ];

/** The part of a match footer (src/sims/schemas.ts) the gate reads. */
export interface FooterResult {
  result: { winner: 1 | 2 | null; endCondition: string };
}

export const isDecisive = (f: FooterResult): boolean => f.result.endCondition === "base_destroyed" && f.result.winner !== null;

/** Archetype i's decisive record in pair p; footers[k] is the result of jobs[k]. Seat 1 wins for i exactly when i sat in seat 1. */
export function simRecordOf(jobs: readonly CalibrationJob[], footers: readonly FooterResult[], pair: number): { wins: number; n: number; nonDecisive: number } {
  let wins = 0;
  let n = 0;
  let nonDecisive = 0;
  jobs.forEach((jb, k) => {
    if (jb.pair !== pair) return;
    const f = footers[k];
    if (!isDecisive(f)) {
      nonDecisive++;
      return;
    }
    n++;
    if ((f.result.winner === 1) === jb.iFirst) wins++;
  });
  return { wins, n, nonDecisive };
}
