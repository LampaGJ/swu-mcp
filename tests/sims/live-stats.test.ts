import { describe, expect, it } from "vitest";
import { LiveStats, liveStatsSchema, type GameObs } from "../../src/sims/live-stats.js";

const PROV = { policies: [{ name: "rung1", paramsSha256: "a".repeat(64) }], seeds: { from: 1, to: 20 }, enginePin: "c0ffee", codeCommit: "deadbeef", run: "2026-10-31" };
const game = (over: Partial<GameObs> = {}): GameObs => ({ seed: 1, winnerSeat: 1, endCondition: "base_destroyed", error: null, rounds: 6, decisions: 100, won: true, ...over });

function fresh(kind: "ladder" | "h2h" = "ladder") {
  return new LiveStats({ kind, provenance: PROV });
}

describe("live stats payload", () => {
  it("parses a snapshot before any phase starts", () => {
    const s = fresh().snapshot();
    expect(liveStatsSchema.parse(s)).toEqual(s);
    expect(s.phase).toBe("starting");
    expect(s.result).toBeNull();
    expect(s.games.done).toBe(0);
  });

  it("is a strict schema: an unknown key and a bad share fail to parse", () => {
    const s = fresh().snapshot();
    expect(liveStatsSchema.safeParse({ ...s, extra: 1 }).success).toBe(false);
    expect(liveStatsSchema.safeParse({ ...s, result: { wins: 1, n: 2, share: 3, low: 0, high: 1 } }).success).toBe(false);
    expect(liveStatsSchema.safeParse({ ...s, version: 2 }).success).toBe(false);
  });

  it("running Wilson 95% interval at fixed counts: 7 wins of 10 decisive games", () => {
    const t = fresh();
    t.beginPhase("rung1 vs rung0", 20, { subject: "rung1", other: "rung0" });
    for (let i = 0; i < 10; i++) t.add(game({ seed: i, won: i < 7 }));
    const s = liveStatsSchema.parse(t.snapshot());
    expect(s.result).toEqual({ wins: 7, n: 10, share: 0.7, low: 0.3968, high: 0.8922 });
    expect(s.games).toMatchObject({ done: 10, total: 20, decisive: 10 });
  });

  it("running exact sign test on duplicate pairs: 9 pairs won in both seats against 3 lost in both", () => {
    const t = fresh();
    t.beginPhase("p", 40, { subject: "a", other: "b" });
    let seed = 0;
    const pair = (a: boolean, b: boolean): void => {
      seed++;
      t.add(game({ seed, pair: String(seed), won: a }));
      t.add(game({ seed, pair: String(seed), won: b }));
    };
    for (let i = 0; i < 9; i++) pair(true, true);
    for (let i = 0; i < 3; i++) pair(false, false);
    pair(true, false);
    const s = t.snapshot();
    expect(s.paired).toEqual({ pairs: 13, subjectBoth: 9, otherBoth: 3, pValue: 0.146 });
  });

  it("an open pair (one game of two) counts in the share but not in the pair test", () => {
    const t = fresh();
    t.beginPhase("p", 4, null);
    t.add(game({ pair: "1", won: true }));
    const s = t.snapshot();
    expect(s.paired).toEqual({ pairs: 0, subjectBoth: 0, otherBoth: 0, pValue: 1 });
    expect(s.result?.n).toBe(1);
  });

  it("9 against 1 gives p = 0.02148", () => {
    const t = fresh();
    t.beginPhase("p", 20, null);
    for (let i = 0; i < 10; i++) {
      const w = i < 9;
      t.add(game({ seed: i, pair: String(i), won: w }));
      t.add(game({ seed: i, pair: String(i), won: w }));
    }
    expect(t.snapshot().paired?.pValue).toBe(0.02148);
  });

  it("counts draws, timeouts, stuck games and errors with seeds, and keeps non-decisive games out of the share", () => {
    const t = fresh();
    t.beginPhase("p", 10, null);
    t.add(game({ seed: 1 }));
    t.add(game({ seed: 2, winnerSeat: null, endCondition: "draw", won: null }));
    t.add(game({ seed: 3, winnerSeat: null, endCondition: "timeout", won: null }));
    t.add(game({ seed: 4, winnerSeat: null, endCondition: "stuck", won: null }));
    t.add(game({ seed: 5, winnerSeat: null, endCondition: "error", error: "engine threw", won: null }));
    const s = liveStatsSchema.parse(t.snapshot());
    expect(s.games).toEqual({ done: 5, total: 10, decisive: 1, draws: 1, timeouts: 1, stuck: 1, errors: 1 });
    expect(s.result).toEqual({ wins: 1, n: 1, share: 1, low: 0.2065, high: 1 });
    expect(s.health.errorSeeds).toEqual([{ seed: "5", error: "engine threw" }]);
    expect(s.health.meanRounds).toBe(6);
    expect(s.health.meanDecisions).toBe(100);
  });

  it("keeps at most five error seeds", () => {
    const t = fresh();
    t.beginPhase("p", 10, null);
    for (let i = 0; i < 8; i++) t.add(game({ seed: i, winnerSeat: null, endCondition: "error", error: "boom", won: null }));
    const s = t.snapshot();
    expect(s.games.errors).toBe(8);
    expect(s.health.errorSeeds).toHaveLength(5);
  });

  it("mirror games give the seat-1 share and stay out of the headline share", () => {
    const t = fresh("h2h");
    t.beginPhase("mirror", 6, null);
    t.add(game({ mirror: true, won: null, winnerSeat: 1 }));
    t.add(game({ mirror: true, won: null, winnerSeat: 1 }));
    t.add(game({ mirror: true, won: null, winnerSeat: 2 }));
    const s = t.snapshot();
    expect(s.result).toBeNull();
    expect(s.seat1).toMatchObject({ scope: "mirror", wins: 2, n: 3, share: 0.6667 });
  });

  it("rows by stratum and groups with their own pair test", () => {
    const t = fresh();
    t.beginPhase("tuning", 8, null);
    t.add(game({ group: "rung3:k=2", pair: "a1", won: true, headline: false }));
    t.add(game({ group: "rung3:k=2", pair: "a1", won: true, headline: false }));
    t.add(game({ group: "rung3:k=5", pair: "b1", won: false, headline: false, stratum: "deck-x" }));
    t.add(game({ group: "rung3:k=5", pair: "b1", won: true, headline: false, stratum: "deck-x" }));
    const s = liveStatsSchema.parse(t.snapshot());
    expect(s.result).toBeNull();
    expect(s.groups["rung3:k=2"].paired).toEqual({ pairs: 1, subjectBoth: 1, otherBoth: 0, pValue: 1 });
    expect(s.groups["rung3:k=5"].result).toMatchObject({ wins: 1, n: 2 });
    expect(s.rows["rung3:k=5 | deck-x"]).toMatchObject({ wins: 1, n: 2 });
  });

  it("sums fallback decisions into the fallback share and keeps counters", () => {
    const t = fresh();
    t.beginPhase("p", 2, null);
    t.add(game({ fallback: { decisions: 100, fallback: 5 } }));
    t.add(game({ fallback: { decisions: 100, fallback: 15 } }));
    t.setCounter("searchRollbacks", 41);
    t.addCounter("searchRollbacks", 1);
    const s = t.snapshot();
    expect(s.health.fallbackShare).toBe(0.1);
    expect(s.counters).toEqual({ searchRollbacks: 42 });
  });

  it("moves finished phases to the completed list and keeps run totals", () => {
    const t = fresh();
    t.beginPhase("first", 2, { subject: "a", other: "b" });
    t.add(game({ won: true }));
    t.add(game({ won: false, winnerSeat: 2 }));
    t.endPhase();
    t.beginPhase("second", 2, null);
    t.add(game({ winnerSeat: null, endCondition: "draw", won: null }));
    const s = liveStatsSchema.parse(t.snapshot());
    expect(s.phase).toBe("second");
    expect(s.phaseIndex).toBe(2);
    expect(s.completed).toHaveLength(1);
    expect(s.completed[0]).toMatchObject({ phase: "first", games: 2, sides: { subject: "a", other: "b" }, result: { wins: 1, n: 2 } });
    expect(s.runTotals).toEqual({ games: 3, draws: 1, timeouts: 0, stuck: 0, errors: 0 });
  });

  it("is deterministic: the same observations give the same bytes", () => {
    const run = (): string => {
      const t = fresh();
      t.beginPhase("p", 6, { subject: "a", other: "b" });
      for (let i = 0; i < 6; i++) t.add(game({ seed: i, pair: String(Math.floor(i / 2)), won: i % 3 !== 0, stratum: i % 2 === 0 ? "z" : "a" }));
      return JSON.stringify(t.snapshot());
    };
    expect(run()).toBe(run());
  });

  it("advances a phase by a finished task without adding a game to the run totals", () => {
    const t = fresh();
    t.beginPhase("branches", 6, null);
    t.check();
    t.check();
    const s = liveStatsSchema.parse(t.snapshot());
    expect(s.games).toMatchObject({ done: 2, total: 6 });
    expect(s.runTotals.games).toBe(0);
  });

  it("leaves mean rounds and decisions null when the writer has neither (the branch sampler)", () => {
    const t = fresh();
    t.beginPhase("candidates", 2, null);
    t.add({ seed: "g1", winnerSeat: 1, endCondition: "base_destroyed", error: null, won: null });
    const s = liveStatsSchema.parse(t.snapshot());
    expect(s.health.meanRounds).toBeNull();
    expect(s.health.meanDecisions).toBeNull();
    expect(s.games.decisive).toBe(1);
  });

  it("reads a base destroyed with no winner as a draw", () => {
    const t = fresh();
    t.beginPhase("p", 1, null);
    t.add(game({ winnerSeat: null, won: null }));
    expect(t.snapshot().games).toMatchObject({ draws: 1, decisive: 0 });
  });

  it("carries the provenance it was given and takes a new one", () => {
    const t = fresh();
    expect(t.snapshot().provenance).toEqual(PROV);
    t.setProvenance({ ...PROV, seeds: null });
    expect(t.snapshot().provenance.seeds).toBeNull();
  });
});
