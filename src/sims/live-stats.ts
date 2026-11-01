import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import { shareOf, signTest } from "./policies/ladder-stats.js";

/**
 * @displayName Live simulation stats
 * @strategicPurpose Lets the owner watch a long simulation run (x of y games, who is ahead, whether the games are
 * healthy) without waiting for the pinned record (#178 of #104). The payload rides in the heartbeat only, so a gate or
 * match record never holds it and two runs of the same seeds still write the same bytes (D99).
 * @tacticalObjective A Zod v4 strict schema for the running stats and the tally that builds it from finished games:
 * per phase games done of total, decisive, draws, timeouts, stuck and errors with seeds; the running win share with its
 * Wilson 95% interval; the running exact sign test on duplicate pairs; the seat-1 share; rows by opponent or stratum and
 * groups by subject; mean rounds and decisions; fallback share; search counters; provenance. No clock field: games
 * per second and the eta belong to the heartbeat envelope (scripts/lib/progress.mjs), which is not a data product.
 * Writers (scripts/sims/ladder.ts, calibration-gate.ts, sample-branches.ts, matchup-job.ts) and the reader
 * (scripts/sims/watch.ts, src/tools/sims.ts) share this module.
 */

const count = z.int().nonnegative();
const fraction = z.number().min(0).max(1);

export const shareSchema = z.strictObject({ wins: count, n: count, share: fraction.nullable(), low: fraction.nullable(), high: fraction.nullable() });
export type ShareStat = z.infer<typeof shareSchema>;

/** Duplicate pairs: both games of a seed, the seats swapped. subjectBoth won the seed in both seats, otherBoth lost it in both. */
export const pairedSchema = z.strictObject({ pairs: count, subjectBoth: count, otherBoth: count, pValue: fraction });
export type PairedStat = z.infer<typeof pairedSchema>;

const gamesSchema = z.strictObject({ done: count, total: count.nullable(), decisive: count, draws: count, timeouts: count, stuck: count, errors: count });

export const LIVE_KINDS = ["ladder", "grid", "tune", "h2h", "field", "cost", "calibration", "branches", "matchup"] as const;

const sidesSchema = z.strictObject({ subject: z.string(), other: z.string().nullable() });

const completedSchema = z.strictObject({ phase: z.string(), games: count, sides: sidesSchema.nullable(), result: shareSchema.nullable(), paired: pairedSchema.nullable() });

export const provenanceSchema = z.strictObject({
  policies: z.array(z.strictObject({ name: z.string(), paramsSha256: z.string() })),
  seeds: z.strictObject({ from: z.number(), to: z.number() }).nullable(),
  enginePin: z.string().nullable(),
  codeCommit: z.string().nullable(),
  run: z.string().nullable(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const liveStatsSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(LIVE_KINDS),
  /** The phase running now; "starting" before the first. */
  phase: z.string(),
  /** 1-based position of the running phase; 0 before the first. */
  phaseIndex: count,
  /** Whose share `result` is: the subject's, the other side being the comparator. */
  sides: sidesSchema.nullable(),
  games: gamesSchema,
  /** Subject's share of decisive games in this phase; null where the phase has no subject (a mirror, a cost run). */
  result: shareSchema.nullable(),
  paired: pairedSchema.nullable(),
  /** Seat 1's share of decisive games: over mirror games when the phase has any, else over every game. */
  seat1: shareSchema.extend({ scope: z.enum(["mirror", "all"]) }).nullable(),
  /** Per opponent or stratum, keyed by the stratum (prefixed by its group when there is one). */
  rows: z.record(z.string(), shareSchema),
  /** Per subject or candidate when a phase plays several. */
  groups: z.record(z.string(), z.strictObject({ result: shareSchema, paired: pairedSchema.nullable() })),
  health: z.strictObject({
    meanRounds: z.number().nullable(),
    meanDecisions: z.number().nullable(),
    fallbackShare: fraction.nullable(),
    errorSeeds: z.array(z.strictObject({ seed: z.string(), error: z.string() })).max(5),
  }),
  /** Named integer counters: search rollbacks and bookmarks where a policy exposes them, replay checks in the calibration gate. */
  counters: z.record(z.string(), z.number()),
  completed: z.array(completedSchema).max(500),
  runTotals: z.strictObject({ games: count, draws: count, timeouts: count, stuck: count, errors: count }),
  provenance: provenanceSchema,
});
export type LiveStatsPayload = z.infer<typeof liveStatsSchema>;
export type LiveKind = (typeof LIVE_KINDS)[number];

/** One finished game, as the writer saw it. */
export interface GameObs {
  seed: string | number;
  /** The engine's winner when the base was destroyed, else null. */
  winnerSeat: 1 | 2 | null;
  endCondition: string;
  error: string | null;
  /** Absent where the writer's result carries neither (the branch sampler's source games). */
  rounds?: number;
  decisions?: number;
  /** Did the subject win? null when the game is not decisive or has no subject. */
  won: boolean | null;
  /** Row key (an opponent or deck). */
  stratum?: string;
  /** Subject or candidate when a phase plays several. */
  group?: string;
  /** Both games of a duplicate pair share this id; the second closes the pair. */
  pair?: string;
  /** The same policy and deck on both seats: feeds seat1 only. */
  mirror?: boolean;
  /** False keeps the game out of `result` and `paired` (a second subject, a tuning candidate). Default true. */
  headline?: boolean;
  /** Decisions the game had and how many fell to rung 0. */
  fallback?: { decisions: number; fallback: number };
}

interface Wins {
  wins: number;
  n: number;
}
interface PairTally {
  pairs: number;
  subjectBoth: number;
  otherBoth: number;
  open: Map<string, boolean | null>;
}
const newPairs = (): PairTally => ({ pairs: 0, subjectBoth: 0, otherBoth: 0, open: new Map() });

function pairedOf(t: PairTally | null): PairedStat | null {
  if (t === null) return null;
  const n = t.subjectBoth + t.otherBoth;
  return { pairs: t.pairs, subjectBoth: t.subjectBoth, otherBoth: t.otherBoth, pValue: Number(signTest(t.subjectBoth, n).toPrecision(4)) };
}

function closePair(t: PairTally, id: string, won: boolean | null): void {
  if (!t.open.has(id)) {
    t.open.set(id, won);
    return;
  }
  const first = t.open.get(id) as boolean | null;
  t.open.delete(id);
  t.pairs++;
  if (first === true && won === true) t.subjectBoth++;
  if (first === false && won === false) t.otherBoth++;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

class Phase {
  rounds = 0;
  roundsN = 0;
  decisions = 0;
  decisionsN = 0;
  done = 0;
  decisive = 0;
  draws = 0;
  timeouts = 0;
  stuck = 0;
  errors = 0;
  errorSeeds: { seed: string; error: string }[] = [];
  head: Wins = { wins: 0, n: 0 };
  headPairs: PairTally | null = null;
  rows = new Map<string, Wins>();
  groups = new Map<string, { share: Wins; pairs: PairTally | null }>();
  seatAll: Wins = { wins: 0, n: 0 };
  seatMirror: Wins = { wins: 0, n: 0 };
  fbDecisions = 0;
  fbFallback = 0;
  constructor(
    readonly name: string,
    readonly total: number | null,
    readonly sides: { subject: string; other: string | null } | null,
  ) {}
}

const bump = (w: Wins, won: boolean): void => {
  w.n++;
  if (won) w.wins++;
};

export class LiveStats {
  private phase: Phase | null = null;
  private index = 0;
  private completed: z.infer<typeof completedSchema>[] = [];
  private counters = new Map<string, number>();
  private totals = { games: 0, draws: 0, timeouts: 0, stuck: 0, errors: 0 };

  private provenance: Provenance;

  constructor(private readonly opts: { kind: LiveKind; provenance: Provenance }) {
    this.provenance = opts.provenance;
  }

  setProvenance(p: Provenance): void {
    this.provenance = p;
  }

  beginPhase(name: string, total: number | null, sides: { subject: string; other: string | null } | null): void {
    if (this.phase !== null) this.endPhase();
    this.index++;
    this.phase = new Phase(name, total, sides);
  }

  /** One finished unit of work that is not a game of this phase's tally (the branch sampler's finished source-game tasks). */
  check(): void {
    if (this.phase === null) throw new Error("LiveStats.check before beginPhase");
    this.phase.done++;
  }

  endPhase(): void {
    const ph = this.phase;
    if (ph === null) return;
    this.completed.push({ phase: ph.name, games: ph.done, sides: ph.sides, result: ph.head.n === 0 ? null : shareOf(ph.head.wins, ph.head.n), paired: pairedOf(ph.headPairs) });
    this.phase = null;
  }

  setCounter(name: string, value: number): void {
    this.counters.set(name, value);
  }

  addCounter(name: string, by: number): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  add(g: GameObs): void {
    const ph = this.phase;
    if (ph === null) throw new Error("LiveStats.add before beginPhase");
    ph.done++;
    this.totals.games++;
    if (g.rounds !== undefined) {
      ph.rounds += g.rounds;
      ph.roundsN++;
    }
    if (g.decisions !== undefined) {
      ph.decisions += g.decisions;
      ph.decisionsN++;
    }
    // The engine ends a drawn game as base_destroyed with no winner.
    const end = g.endCondition === "base_destroyed" && g.winnerSeat === null ? "draw" : g.endCondition;
    if (end === "base_destroyed") ph.decisive++;
    if (end === "draw") {
      ph.draws++;
      this.totals.draws++;
    } else if (end === "timeout") {
      ph.timeouts++;
      this.totals.timeouts++;
    } else if (end === "stuck") {
      ph.stuck++;
      this.totals.stuck++;
    } else if (end === "error") {
      ph.errors++;
      this.totals.errors++;
      if (ph.errorSeeds.length < 5) ph.errorSeeds.push({ seed: String(g.seed), error: (g.error ?? "error").slice(0, 200) });
    }
    if (g.fallback) {
      ph.fbDecisions += g.fallback.decisions;
      ph.fbFallback += g.fallback.fallback;
    }
    if (g.winnerSeat !== null) {
      bump(ph.seatAll, g.winnerSeat === 1);
      if (g.mirror) bump(ph.seatMirror, g.winnerSeat === 1);
    }
    if (g.mirror) return;
    if (g.won !== null) {
      if (g.headline !== false) bump(ph.head, g.won);
      if (g.stratum !== undefined || g.group !== undefined) {
        const key = [g.group, g.stratum].filter((x) => x !== undefined).join(" | ");
        let w = ph.rows.get(key);
        if (w === undefined) ph.rows.set(key, (w = { wins: 0, n: 0 }));
        bump(w, g.won);
      }
    }
    if (g.group !== undefined) {
      let e = ph.groups.get(g.group);
      if (e === undefined) ph.groups.set(g.group, (e = { share: { wins: 0, n: 0 }, pairs: null }));
      if (g.won !== null) bump(e.share, g.won);
      if (g.pair !== undefined) closePair((e.pairs ??= newPairs()), g.pair, g.won);
    }
    if (g.pair !== undefined && g.headline !== false) closePair((ph.headPairs ??= newPairs()), g.pair, g.won);
  }

  snapshot(): LiveStatsPayload {
    const ph = this.phase;
    const sortedRows = (m: Map<string, Wins>): [string, ShareStat][] => [...m].sort(([a], [b]) => compareCodePoints(a, b)).map(([k, w]) => [k, shareOf(w.wins, w.n)]);
    const mirror = ph !== null && ph.seatMirror.n > 0;
    const seat = ph === null ? null : mirror ? ph.seatMirror : ph.seatAll;
    return {
      version: 1,
      kind: this.opts.kind,
      phase: ph?.name ?? "starting",
      phaseIndex: this.index,
      sides: ph?.sides ?? null,
      games: {
        done: ph?.done ?? 0,
        total: ph?.total ?? null,
        decisive: ph?.decisive ?? 0,
        draws: ph?.draws ?? 0,
        timeouts: ph?.timeouts ?? 0,
        stuck: ph?.stuck ?? 0,
        errors: ph?.errors ?? 0,
      },
      result: ph === null || ph.head.n === 0 ? null : shareOf(ph.head.wins, ph.head.n),
      paired: pairedOf(ph?.headPairs ?? null),
      seat1: seat === null || seat.n === 0 ? null : { ...shareOf(seat.wins, seat.n), scope: mirror ? "mirror" : "all" },
      rows: Object.fromEntries(sortedRows(ph?.rows ?? new Map())),
      groups: Object.fromEntries([...(ph?.groups ?? [])].sort(([a], [b]) => compareCodePoints(a, b)).map(([k, e]) => [k, { result: shareOf(e.share.wins, e.share.n), paired: pairedOf(e.pairs) }])),
      health: {
        meanRounds: ph === null || ph.roundsN === 0 ? null : r2(ph.rounds / ph.roundsN),
        meanDecisions: ph === null || ph.decisionsN === 0 ? null : Math.round((ph.decisions / ph.decisionsN) * 10) / 10,
        fallbackShare: ph === null || ph.fbDecisions === 0 ? null : Math.round((ph.fbFallback / ph.fbDecisions) * 1e4) / 1e4,
        errorSeeds: ph?.errorSeeds ?? [],
      },
      counters: Object.fromEntries([...this.counters].sort(([a], [b]) => compareCodePoints(a, b))),
      completed: this.completed,
      runTotals: { ...this.totals },
      provenance: this.provenance,
    };
  }
}
