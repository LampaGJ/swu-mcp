import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CardRow, CardStore } from "../../src/data.js";
import { LiveStats } from "../../src/sims/live-stats.js";
import { simulateMatchup, type SimsDeps } from "../../src/tools/sims.js";

const LEADER = "09010018";
const BASE = "09010024";
const row = (cardKey: string, type: string, extra: Record<string, unknown> = {}): CardRow => ({ cardKey, title: `card ${cardKey}`, type, ...extra }) as unknown as CardRow;
const mainKeys = Array.from({ length: 17 }, (_, i) => `0101${100 + i}`);
const cards = [row(LEADER, "Leader", { expansion: "LAW", cardNumber: 18 }), row(BASE, "Base", { expansion: "LAW", cardNumber: 24 }), ...mainKeys.map((k, i) => row(k, "Unit", { expansion: "SOR", cardNumber: 100 + i }))];
const store = { dataDir: "/nowhere", cards, byKey: new Map(cards.map((c) => [c.cardKey, c])), facets: new Map() } as unknown as CardStore;
const deck = { leader: LEADER, base: BASE, cards: [...mainKeys.slice(0, 16).map((cardKey) => ({ cardKey, count: 3 })), { cardKey: mainKeys[16], count: 2 }] };

const passingRecord = (spec: string, rung: number, external = true) => {
  const failedGates = external ? [] : ["external"];
  return {
    schemaVersion: 1,
    step: `calibration-${spec}`,
    calibrationVersion: "1",
    label: `bot play (forceteki ${spec}), not human results`,
    policy: { spec, id: "x", version: "1", rung, params: {}, paramsSha256: "a".repeat(64), driverPolicy: spec },
    engine: { repo: "r", commit: "445792e6185c", cardDataVersion: "v", cardDataSha256: "b".repeat(64) },
    inputs: { scoresSha256: "c".repeat(64), coefficientsSha256: "c".repeat(64), featuresSha256: "c".repeat(64), leaderCardsSha256: "c".repeat(64), winratesSha256: "c".repeat(64), archetypesSha256: "c".repeat(64) },
    pilotRun: "2026-10-31",
    metaRun: "2026-11-01",
    decks: "data/originals/decks/2026-10-17",
    codeCommit: "abcdef1",
    thresholds: { spearmanMin: 0.5, favouriteAlpha: 0.05, nonDecisiveMax: 0.02, fallbackMax: 0.05, replayMatches: 50, minN: 10 },
    seeds: { from: 4000000, to: 4065019, gamesPerPair: 40, scheme: "s" },
    panel: [],
    gates: {
      replay: { pass: true, matches: 50, workerEqualsThread: 50, replayed: 50, undoIdentical: 50, evidence: [], note: "", failures: [] },
      health: { pass: true, games: 10, nonDecisive: 0, decisions: 10, fallback: 0, nonDecisiveShare: 0, fallbackShare: 0, endConditions: {} },
      ladder: { pass: true, steps: [] },
      external: { pass: external, failed: external ? [] : ["spearman"], pairs: 66, spearman: external ? 0.6 : -0.17, favourite: { counted: 37, agree: external ? 30 : 15, disagree: 7, simTies: 0, pValue: external ? 0.0001 : 0.9 }, simLabel: "s", tournamentLabel: "t", rows: [] },
    },
    pass: external,
    servesWinShare: external,
    failedGates,
  };
};

let root: string;
let spawned: string[];
let alive: Set<number>;
const deps = (): SimsDeps => ({
  root,
  engine: () => ({ commit: "445792e6185c", cardDataSha256: "b".repeat(64) }),
  codeCommit: () => "abcdef1234",
  spawnJob: (jobFile) => {
    spawned.push(jobFile);
    alive.add(4242);
    return 4242;
  },
  isAlive: (pid) => alive.has(pid),
  workers: 12,
});
const writeRecord = (rec: unknown, name: string): void => {
  const dir = path.join(root, "data/pinned/sim-calibration-v1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(rec));
};
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("");

beforeEach(() => {
  mkdirSync(path.resolve("tmp"), { recursive: true });
  root = mkdtempSync(path.resolve("tmp/sims-tool-test-"));
  spawned = [];
  alive = new Set();
});
afterEach(() => {
  alive.clear();
});

describe("simulate_matchup tool", () => {
  it("refuses with a plain sentence naming the failed gate when no rung passed (D9)", () => {
    writeRecord(passingRecord("rung1", 1, false), "calibration-rung1.json");
    const r = simulateMatchup(store, { deck, opponent: "field" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no bot rung has passed every calibration gate/);
    expect(text(r)).toMatch(/rung1 failed the external calibration gate/);
    expect(spawned).toEqual([]);
  });

  it("says so when the engine clone is absent", () => {
    const r = simulateMatchup(store, { deck, opponent: "field" }, { ...deps(), engine: () => null });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/forceteki/);
  });

  it("rejects a deck outside Premier's 50 to 60 cards before anything runs", () => {
    writeRecord(passingRecord("rung3:k=8", 3), "calibration-rung3-k-8.json");
    const r = simulateMatchup(store, { deck: { ...deck, cards: deck.cards.slice(1) }, opponent: "field" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/47 cards/);
  });

  it("starts one detached job, reports progress on a repeat call, and serves the cached result", () => {
    writeRecord(passingRecord("rung3:k=8", 3), "calibration-rung3-k-8.json");
    writeRecord(passingRecord("rung1", 1), "calibration-rung1.json");
    const first = simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    expect(first.isError).toBeUndefined();
    expect(text(first)).toMatch(/jobState: started/);
    expect(text(first)).toMatch(/rung3:k=8/);
    expect(spawned).toHaveLength(1);
    const job = JSON.parse(readFileSync(spawned[0], "utf8"));
    expect(job.input.policy).toBe("rung3:k=8");
    expect(job.plannedGames).toBe(70);
    const dir = path.dirname(spawned[0]);
    writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ done: 35, total: 70, pct: 50, eta_s: 30, phase: "games" }));
    const second = simulateMatchup(store, { deck: { ...deck, cards: [...deck.cards].reverse() }, opponent: "field", games: 10 }, deps());
    expect(text(second)).toMatch(/jobState: running/);
    expect(text(second)).toMatch(/done: 35/);
    expect(spawned).toHaveLength(1);
    writeFileSync(path.join(dir, "result.json"), JSON.stringify({ label: "bot play (forceteki rung3:k=8), not human results", status: "candidate", winShare: 0.41, replay: { inputHash: job.inputHash, outputHash: "d".repeat(64) } }));
    alive.clear();
    const third = simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    expect(text(third)).toMatch(/jobState: done/);
    expect(text(third)).toMatch(/winShare: 0.41/);
    expect(text(third)).toMatch(/status: candidate/);
  });

  it("carries the running stats of the heartbeat in the status reply, and drops a payload that does not parse (#178)", () => {
    writeRecord(passingRecord("rung1", 1), "calibration-rung1.json");
    simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    const dir = path.dirname(spawned[0]);
    const live = new LiveStats({ kind: "matchup", provenance: { policies: [{ name: "rung1", paramsSha256: "a".repeat(64) }], seeds: null, enginePin: "445792e6185c", codeCommit: "abcdef1", run: "2026-10-31" } });
    live.beginPhase("games", 70, { subject: "your deck", other: "the field" });
    for (let i = 0; i < 10; i++) live.add({ seed: String(i), winnerSeat: 1, endCondition: "base_destroyed", error: null, rounds: 6, decisions: 90, won: i < 6 });
    writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ done: 10, total: 70, pct: 14.3, eta_s: 40, phase: "games", games_per_s: 2.25, stats: live.snapshot() }));
    const reply = text(simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps()));
    expect(reply).toMatch(/gamesPerSecond: 2.25/);
    expect(reply).toMatch(/wins: 6/);
    expect(reply).toMatch(/share: 0.6/);
    writeFileSync(path.join(dir, "progress.json"), JSON.stringify({ done: 10, total: 70, pct: 14.3, eta_s: 40, phase: "games", stats: { version: 9 } }));
    const bad = text(simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps()));
    expect(bad).toMatch(/done: 10/);
    expect(bad).toMatch(/stats: null/);
  });

  it("runs one job at a time and reports the other job as busy", () => {
    writeRecord(passingRecord("rung3:k=8", 3), "calibration-rung3-k-8.json");
    simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    const other = simulateMatchup(store, { deck, opponent: "t001", games: 10 }, deps());
    expect(text(other)).toMatch(/jobState: busy/);
    expect(spawned).toHaveLength(1);
  });

  it("restarts after a dead job and reports a failed job once as an error", () => {
    writeRecord(passingRecord("rung3:k=8", 3), "calibration-rung3-k-8.json");
    simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    const dir = path.dirname(spawned[0]);
    alive.clear();
    writeFileSync(path.join(dir, "status.json"), JSON.stringify({ state: "failed", key: path.basename(dir), pid: 4242, plannedGames: 70, error: "the engine has no card for cardKey 0101100" }));
    const failed = simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/no card for cardKey 0101100/);
    expect(existsSync(path.join(dir, "status.json"))).toBe(false);
    const retry = simulateMatchup(store, { deck, opponent: "field", games: 10 }, deps());
    expect(text(retry)).toMatch(/jobState: started/);
    expect(spawned).toHaveLength(2);
  });

  it("plans without starting on dryRun, and takes a SWUDB document for the deck", () => {
    writeRecord(passingRecord("rung1", 1), "calibration-rung1.json");
    const swudb = { leader: { id: "LAW_018", count: 1 }, base: { id: "LAW_024", count: 1 }, deck: deck.cards.map((c, i) => ({ id: `SOR_${100 + i}`, count: c.count })) };
    const r = simulateMatchup(store, { swudb, variant: [`${mainKeys[0]}>${mainKeys[16]}`], dryRun: true }, deps());
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/jobState: plan/);
    expect(text(r)).toMatch(/plannedGames: 300/);
    expect(text(r)).toMatch(/policy: rung1/);
    expect(spawned).toEqual([]);
  });

  it("refuses a requested policy that has no passing record", () => {
    writeRecord(passingRecord("rung3:k=8", 3), "calibration-rung3-k-8.json");
    const r = simulateMatchup(store, { deck, opponent: "field", policy: "rung3mc:playout=rung1,n=2" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/has no calibration gate record/);
  });

  it("names an unknown policy plainly", () => {
    writeRecord(passingRecord("rung3:k=8", 3), "calibration-rung3-k-8.json");
    const r = simulateMatchup(store, { deck, opponent: "field", policy: "rung9" }, deps());
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/policy rung9: unknown policy/);
  });

  describe("relative mode (D108)", () => {
    const swap = [`${mainKeys[0]}>${mainKeys[16]}`];
    const LABEL = (spec: string) => `bot play (forceteki ${spec}), relative comparison on identical shuffles, not a human or tournament win rate`;
    const failing = (spec: string, rung: number, gate: "replay" | "health" | "ladder") => {
      const rec = passingRecord(spec, rung, false);
      (rec.gates[gate] as { pass: boolean }).pass = false;
      rec.failedGates = [gate, "external"];
      return rec;
    };

    it("serves a relative comparison when no rung passes the external gate, labelled as the issue says, on the strongest rung that passes the other three", () => {
      writeRecord(passingRecord("rung1", 1, false), "calibration-rung1.json");
      writeRecord(passingRecord("rung3:k=8", 3, false), "calibration-rung3-k-8.json");
      const plan = simulateMatchup(store, { deck, variant: swap, relative: true, dryRun: true }, deps());
      expect(plan.isError).toBeUndefined();
      expect(text(plan)).toMatch(/jobState: plan/);
      expect(text(plan)).toMatch(/mode: relative/);
      expect(text(plan)).toMatch(/policy: "?rung3:k=8"?/);
      expect(text(plan)).toContain(LABEL("rung3:k=8"));
      expect(text(plan)).toMatch(/#183/);
      expect(text(plan)).toMatch(/plannedGames: 300/);
      const started = simulateMatchup(store, { deck, variant: swap, relative: true, games: 10 }, deps());
      expect(started.isError).toBeUndefined();
      expect(text(started)).toMatch(/jobState: started/);
      const job = JSON.parse(readFileSync(spawned[0], "utf8"));
      expect(job.input).toMatchObject({ mode: "relative", policy: "rung3:k=8", variant: swap });
      expect(job.gateRecord).toBe("data/pinned/sim-calibration-v1/calibration-rung3-k-8.json");
      expect(job.plannedGames).toBe(30);
    });

    it("adds the paired field comparison when opponent is given, and takes a second full deck", () => {
      writeRecord(passingRecord("rung1", 1, false), "calibration-rung1.json");
      const field = text(simulateMatchup(store, { deck, variant: swap, opponent: "field", relative: true, games: 10, dryRun: true }, deps()));
      expect(field).toMatch(/plannedGames: 170/);
      const second = { ...deck, cards: [...deck.cards.slice(1), { cardKey: mainKeys[0], count: 3 }] };
      const r = simulateMatchup(store, { deck, opponentDeck: second, relative: true, dryRun: true }, deps());
      expect(r.isError).toBeUndefined();
      expect(text(r)).toMatch(/policy: rung1/);
      expect(text(r)).not.toMatch(/#183/);
    });

    it("serves the finished relative result from the cache with its label", () => {
      writeRecord(passingRecord("rung1", 1, false), "calibration-rung1.json");
      simulateMatchup(store, { deck, variant: swap, relative: true, games: 10 }, deps());
      const dir = path.dirname(spawned[0]);
      const job = JSON.parse(readFileSync(spawned[0], "utf8"));
      writeFileSync(path.join(dir, "result.json"), JSON.stringify({ label: LABEL("rung1"), status: "candidate", mode: "relative", headToHead: { winShare: 0.6 }, replay: { inputHash: job.inputHash, outputHash: "d".repeat(64) } }));
      alive.clear();
      const done = text(simulateMatchup(store, { deck, variant: swap, relative: true, games: 10 }, deps()));
      expect(done).toMatch(/jobState: done/);
      expect(done).toContain(LABEL("rung1"));
      expect(done).toMatch(/winShare: 0.6/);
    });

    it("keeps every absolute mode refused on the same records, and points a deck pair at relative mode", () => {
      writeRecord(passingRecord("rung1", 1, false), "calibration-rung1.json");
      writeRecord(passingRecord("rung3:k=8", 3, false), "calibration-rung3-k-8.json");
      for (const args of [{ deck, opponent: "field" }, { deck, opponent: "t001" }, { deck, variant: swap }, { deck, variant: swap, opponent: "field" }, { deck, opponentDeck: deck }, { deck, variant: swap, relative: false }]) {
        const r = simulateMatchup(store, args, deps());
        expect(r.isError, JSON.stringify(args)).toBe(true);
        expect(text(r)).toMatch(/no bot rung has passed every calibration gate/);
      }
      expect(text(simulateMatchup(store, { deck, variant: swap }, deps()))).toMatch(/relative: true/);
      expect(text(simulateMatchup(store, { deck, opponent: "field" }, deps()))).not.toMatch(/relative: true/);
      expect(spawned).toEqual([]);
    });

    it("still refuses relative mode when replay, health or ladder fails, naming the gate", () => {
      for (const gate of ["replay", "health", "ladder"] as const) {
        writeRecord(failing("rung1", 1, gate), "calibration-rung1.json");
        const r = simulateMatchup(store, { deck, variant: swap, relative: true }, deps());
        expect(r.isError, gate).toBe(true);
        expect(text(r)).toMatch(/no bot rung has passed the replay, health and ladder gates/);
        expect(text(r)).toContain(`rung1 failed the ${gate} gate`);
      }
      writeRecord(passingRecord("rung3:k=8", 3, false), "calibration-rung3-k-8.json");
      const r = simulateMatchup(store, { deck, variant: swap, relative: true, policy: "rung1" }, deps());
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/rung1 failed the ladder gate, so it may not report a relative comparison/);
      expect(spawned).toEqual([]);
    });

    it("refuses a relative request that names no second deck, or two", () => {
      writeRecord(passingRecord("rung1", 1, false), "calibration-rung1.json");
      expect(text(simulateMatchup(store, { deck, opponent: "field", relative: true }, deps()))).toMatch(/relative compares two decks/);
      expect(text(simulateMatchup(store, { deck, variant: swap, opponentDeck: deck, relative: true }, deps()))).toMatch(/not both/);
    });
  });
});
