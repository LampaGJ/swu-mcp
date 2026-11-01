import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LiveStats, type GameObs, type LiveKind } from "../../src/sims/live-stats.js";
import { MAX_HEADLINE, MAX_JOBS, MAX_PHASE, MAX_TEXT_LINES, MAX_TEXT_WIDTH, kindOf, renderSummaryText, simsSummaryJsonSchema, simsSummarySchema, summarize } from "../../src/sims/summary.js";
import { classify, heartbeatSchema, type JobView, type Source } from "../../src/sims/watch.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (agoS: number): string => new Date(NOW - agoS * 1000).toISOString();
const MAIN: Source = { root: "/Volumes/Local Files/Projects/swu-mcp", label: "swu-mcp (main checkout)", branch: "main", main: true };
const WT: Source = { root: "/Volumes/Local Files/Projects/swu-mcp/.claude/worktrees/e9", label: "e9", branch: null };
const PROV = { policies: [], seeds: null, enginePin: null, codeCommit: null, run: null };
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const g = (seed: number, over: Partial<GameObs> = {}): GameObs => ({ seed, winnerSeat: 1, endCondition: "base_destroyed", error: null, rounds: 7, decisions: 100, won: true, ...over });

function stats(kind: LiveKind, phase: string, sides: { subject: string; other: string | null } | null, games: GameObs[] = []) {
  const t = new LiveStats({ kind, provenance: PROV });
  t.beginPhase(phase, 100, sides);
  games.forEach((x) => t.add(x));
  return t.snapshot();
}

function view(job: string, over: Record<string, unknown> = {}, st: ReturnType<typeof stats> | null = null, source: Source = MAIN, alive: boolean | null = true): JobView {
  const hb = heartbeatSchema.parse({ ts: iso(4), job, done: 50, total: 100, pct: 50, rate_per_s: 3, games_per_s: 3.07, eta_s: 16, elapsed_s: 20, pid: 4242, moved_ts: iso(4), ...over, ...(st ? { stats: st } : {}) });
  return { ...classify(hb, NOW, alive), source, file: "/r/x.json", stats: st, statsError: null };
}
const finished = (job: string, ageS: number, extra: Record<string, unknown> = {}, st: ReturnType<typeof stats> | null = null, source: Source = MAIN) =>
  view(job, { ts: iso(ageS), moved_ts: iso(ageS), done: 100, total: 100, pct: 100, eta_s: 0, phase: "done", ...extra }, st, source, false);
const stalled = (job: string, ageS = 400) => view(job, { ts: iso(ageS), moved_ts: iso(ageS) }, null, MAIN, true);
const dead = (job: string, ageS = 120) => view(job, { ts: iso(ageS), moved_ts: iso(ageS) }, null, MAIN, false);

const summ = (jobs: JobView[]) => summarize({ jobs, repo: "swu-mcp", nowMs: NOW });

describe("shape and the emitter gate", () => {
  it("produces a schemaVersion 1 document with the contract's fields and nothing else", () => {
    const s = summ([view("sims-ladder-h2h-x", {}, stats("h2h", "base vs anakin", { subject: "base", other: "anakin" }, [g(1), g(2, { won: false, winnerSeat: 2 })]))]);
    expect(s.schemaVersion).toBe(1);
    expect(s.generatedAt).toBe("2026-11-01T12:00:00.000Z");
    expect(s.repo).toBe("swu-mcp");
    expect(Object.keys(s)).toEqual(["schemaVersion", "generatedAt", "repo", "totals", "jobs"]);
    expect(Object.keys(s.totals)).toEqual(["running", "stalled", "dead", "doneLastHour"]);
    expect(Object.keys(s.jobs[0])).toEqual(["id", "worktree", "kind", "state", "phase", "done", "total", "pct", "etaS", "gamesPerS", "updatedAgeS", "result", "health", "verdict", "headline"]);
    expect(s.jobs[0]).toMatchObject({ id: "sims-ladder-h2h-x", worktree: "main", kind: "h2h", state: "running", phase: "base vs anakin", done: 50, total: 100, pct: 50, etaS: 16, gamesPerS: 3.07, updatedAgeS: 4 });
    expect(s.jobs[0].result).toMatchObject({ subject: "base", n: 2, p: null });
  });

  it("rejects an extra field, a wrong version and a path or hostname (the schema is the gate)", () => {
    const ok = summ([]);
    expect(simsSummarySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(simsSummarySchema.safeParse({ ...ok, schemaVersion: 2 }).success).toBe(false);
    expect(simsSummarySchema.safeParse({ ...ok, repo: "/Users/someone/swu-mcp" }).success).toBe(false);
    const withJob = summ([view("a")]);
    expect(simsSummarySchema.safeParse({ ...withJob, jobs: [{ ...withJob.jobs[0], headline: "see /Volumes/Models/x" }] }).success).toBe(false);
    expect(simsSummarySchema.safeParse({ ...withJob, jobs: [{ ...withJob.jobs[0], phase: "on box.local" }] }).success).toBe(false);
  });

  it("emits the contract's example headline for a live h2h job", () => {
    const st = {
      ...stats("h2h", "base vs anakin", { subject: "base", other: "anakin" }),
      result: { wins: 2335, n: 4560, share: 0.512, low: 0.479, high: 0.545 },
      paired: { pairs: 2280, subjectBoth: 600, otherBoth: 570, pValue: 0.31 },
    };
    const s = summ([view("sims-ladder-h2h-warrior-h2h-rung3v", { done: 4560, total: 12600, pct: 36.2, eta_s: 6300 }, st)]);
    expect(s.jobs[0].headline).toBe("h2h base vs anakin 36% 4560/12600 ETA 1h45 base 51.2% [47.9,54.5] p .31");
    expect(s.jobs[0].headline.length).toBeLessThanOrEqual(MAX_HEADLINE);
    expect(s.jobs[0].result).toEqual({ subject: "base", share: 0.512, low: 0.479, high: 0.545, p: 0.31, n: 4560 });
  });
});

describe("ordering and the cap", () => {
  it("lists stalled, dead, running, then done within the hour newest first; an older done job is hidden", () => {
    const s = summ([
      finished("done-old", 1800),
      view("run-b", { ts: iso(30), moved_ts: iso(30) }),
      finished("done-new", 60),
      dead("dead-1"),
      view("run-a"),
      stalled("stalled-1"),
      finished("done-ancient", 7200),
    ]);
    expect(s.jobs.map((j) => j.id)).toEqual(["stalled-1", "dead-1", "run-a", "run-b", "done-new", "done-old"]);
    expect(s.totals).toEqual({ running: 2, stalled: 1, dead: 1, doneLastHour: 2 });
  });

  it("caps jobs at 8 and keeps the urgent ones, while totals count every visible job", () => {
    const jobs = [...Array.from({ length: 6 }, (_, i) => view(`run-${i}`)), ...Array.from({ length: 4 }, (_, i) => finished(`done-${i}`, 100 + i)), stalled("late-stall")];
    const s = summ(jobs);
    expect(MAX_JOBS).toBe(8);
    expect(s.jobs).toHaveLength(8);
    expect(s.jobs[0].id).toBe("late-stall");
    expect(s.jobs.filter((j) => j.state === "done")).toHaveLength(1);
    expect(s.totals).toEqual({ running: 6, stalled: 1, dead: 0, doneLastHour: 4 });
  });

  it("is empty and valid when nothing ran recently", () => {
    const s = summ([finished("ancient", 99999)]);
    expect(s.jobs).toEqual([]);
    expect(s.totals).toEqual({ running: 0, stalled: 0, dead: 0, doneLastHour: 0 });
    expect(renderSummaryText(s)).toEqual(["SWU sims 0 running, 0 stalled, 0 done/1h"]);
    expect(summ([]).jobs).toEqual([]);
  });
});

describe("truncation", () => {
  it("cuts a long headline to 72 characters and a long phase to 80, ending in dots, and keeps the result", () => {
    const longSide = "x".repeat(120);
    const st = { ...stats("h2h", "p".repeat(200), { subject: "base", other: longSide }), result: { wins: 5, n: 10, share: 0.5, low: 0.24, high: 0.76 } };
    const s = summ([view("sims-ladder-h2h-" + "n".repeat(300), {}, st)]);
    const j = s.jobs[0];
    expect(j.headline.length).toBeLessThanOrEqual(MAX_HEADLINE);
    expect(j.headline).toContain("base 50.0% [24.0,76.0]");
    expect(j.phase).toHaveLength(MAX_PHASE);
    expect(j.phase.endsWith("...")).toBe(true);
    expect(j.id.length).toBeLessThanOrEqual(120);
    expect(simsSummarySchema.safeParse(s).success).toBe(true);
  });
});

describe("text mode", () => {
  it("starts with the totals line and flags stalled and dead jobs in capitals", () => {
    const lines = renderSummaryText(summ([stalled("sims-ladder-h2h-a"), dead("sims-ladder-field-b"), view("sims-ladder-cost-c"), finished("sims-ladder-tune-d", 90)]));
    expect(lines[0]).toBe("SWU sims 1 running, 1 STALLED, 1 DEAD, 1 done/1h");
    expect(lines[1]).toMatch(/^STALLED h2h a /);
    expect(lines[2]).toMatch(/^DEAD field b /);
    expect(lines[3]).toMatch(/^cost c 50% ETA 16s/);
    expect(lines[4]).toMatch(/^tune d done/);
  });

  it("never exceeds 5 lines of 60 characters, with a more-line when jobs overflow", () => {
    const jobs = Array.from({ length: 9 }, (_, i) => view(`sims-ladder-h2h-${"long-name-".repeat(12)}${i}`, {}, stats("h2h", "q", { subject: "subject-with-a-long-name", other: "other" }, [g(1)])));
    const lines = renderSummaryText(summ(jobs));
    expect(lines).toHaveLength(MAX_TEXT_LINES);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(MAX_TEXT_WIDTH);
    expect(lines[4]).toBe("+5 more jobs");
    const four = renderSummaryText(summ(jobs.slice(0, 4)));
    expect(four).toHaveLength(5);
    expect(four.every((l) => l.length <= MAX_TEXT_WIDTH)).toBe(true);
  });

  it("keeps the verdict and result visible at 60 characters", () => {
    const st = { ...stats("calibration", "x", null), result: { wins: 5, n: 10, share: 0.5, low: 0.24, high: 0.76 } };
    const lines = renderSummaryText(summ([finished("sims-calibration-" + "z".repeat(80), 30, { pass: false, failedGates: ["ladder", "external"] }, st)]));
    expect(lines[1].length).toBeLessThanOrEqual(MAX_TEXT_WIDTH);
    expect(lines[1]).toContain("done FAIL");
  });
});

describe("kind, health and verdict", () => {
  it("takes the kind from the stats, maps grid to other, and falls back to the job name for an old heartbeat", () => {
    expect(kindOf("x", stats("field", "p", null))).toBe("field");
    expect(kindOf("x", stats("grid", "p", null))).toBe("other");
    expect(kindOf("sims-ladder-ladder-rung3v-vs-rung0", null)).toBe("ladder");
    expect(kindOf("sims-ladder-h2h-warrior", null)).toBe("h2h");
    expect(kindOf("sims-calibration-rung3v", null)).toBe("calibration");
    expect(kindOf("sample-branches-pilot", null)).toBe("branches");
    expect(kindOf("matchup-abc123", null)).toBe("matchup");
    expect(kindOf("train-evaluator", null)).toBe("other");
  });

  it("reports the verdict of a finished calibration job with its failed gates", () => {
    const s = summ([finished("sims-calibration-rung3v-k-8", 60, { pass: false, failedGates: ["ladder", "external"] })]);
    expect(s.jobs[0]).toMatchObject({ kind: "calibration", state: "done", verdict: { pass: false, failedGates: ["ladder", "external"] }, etaS: null, phase: "done" });
    expect(s.jobs[0].headline).toContain("FAIL ladder,external");
  });

  it("reports a passing ladder job with no failed gates, and no verdict for other finished kinds or running jobs", () => {
    const s = summ([finished("sims-ladder-ladder-rung3v-vs-rung0-final", 60, { pass: true }), finished("sims-ladder-h2h-x", 70), view("sims-calibration-live", { pass: true }), finished("sims-ladder-field-y", 80, { pass: true })]);
    const by = Object.fromEntries(s.jobs.map((j) => [j.id, j.verdict]));
    expect(by["sims-ladder-ladder-rung3v-vs-rung0-final"]).toEqual({ pass: true, failedGates: [] });
    expect(by["sims-ladder-h2h-x"]).toBeNull();
    expect(by["sims-calibration-live"]).toBeNull();
    expect(by["sims-ladder-field-y"]).toBeNull();
    expect(s.jobs.find((j) => j.id === "sims-ladder-ladder-rung3v-vs-rung0-final")?.headline).toContain("PASS");
  });

  it("falls back to the last finished phase for the result of a done job", () => {
    const t = new LiveStats({ kind: "ladder", provenance: PROV });
    t.beginPhase("rung1 vs rung0", 4, { subject: "rung1", other: "rung0" });
    [g(1), g(2), g(3, { won: false, winnerSeat: 2 })].forEach((x) => t.add(x));
    t.endPhase();
    const s = summ([finished("sims-ladder-ladder-x", 60, { pass: true }, t.snapshot())]);
    expect(s.jobs[0].result).toMatchObject({ subject: "rung1", n: 3 });
    expect(s.jobs[0].headline).toContain("rung1 66.7%");
  });

  it("carries whole-run errors, draws and timeouts, and zeros when there are no stats", () => {
    const st = stats("h2h", "p", { subject: "a", other: "b" }, [g(1), g(2, { endCondition: "timeout", winnerSeat: null, won: null }), g(3, { endCondition: "error", error: "boom", winnerSeat: null, won: null }), g(4, { endCondition: "base_destroyed", winnerSeat: null, won: null })]);
    const s = summ([view("with-stats", {}, st), view("no-stats")]);
    expect(s.jobs.find((j) => j.id === "with-stats")?.health).toEqual({ errors: 1, draws: 1, timeouts: 1 });
    const bare = s.jobs.find((j) => j.id === "no-stats");
    expect(bare).toMatchObject({ health: { errors: 0, draws: 0, timeouts: 0 }, result: null, verdict: null, kind: "other", phase: "starting" });
    expect(bare?.headline).toBe("other no-stats 50% 50/100 ETA 16s");
  });

  it("flags stalled and dead in the state, the headline and the totals", () => {
    const s = summ([stalled("sims-ladder-h2h-s", 600), dead("sims-ladder-h2h-d", 45)]);
    expect(s.jobs.map((j) => [j.state, j.updatedAgeS])).toEqual([["stalled", 600], ["dead", 45]]);
    expect(s.jobs[0].headline).toBe("STALLED h2h s 50% 50/100 quiet 10m");
    expect(s.jobs[1].headline).toBe("DEAD h2h d 50% 50/100 quiet 45s");
    expect(s.totals).toMatchObject({ stalled: 1, dead: 1, running: 0 });
  });
});

describe("no absolute path or hostname leaves the summary", () => {
  it("scrubs paths and hostnames from names, phases, gates and sides, and names linked worktrees by basename", () => {
    const st = stats("h2h", "reading /Volumes/Models/swu/x.bin on mac.local", { subject: "/Users/graham/subj", other: "host.ts.net" });
    const j1 = view("job /Users/graham/Projects/swu-mcp/tmp/a.json", {}, st, WT);
    const j2 = finished("sims-calibration-z", 30, { pass: false, failedGates: ["/private/tmp/gate", "ladder"] });
    const s = summ([j1, j2]);
    const out = JSON.stringify(s) + renderSummaryText(s).join("\n");
    expect(out).not.toMatch(/\/Users|\/Volumes|\/private|\.local\b|\.ts\.net|graham/);
    expect(s.jobs.find((j) => j.worktree === "e9")).toBeDefined();
    expect(simsSummarySchema.safeParse(s).success).toBe(true);
  });

  it("keeps the repo name to a basename", () => {
    expect(summarize({ jobs: [], repo: "/Volumes/Local Files/Projects/swu-mcp", nowMs: NOW }).repo).toBe("swu-mcp");
  });
});

describe("the committed JSON Schema export", () => {
  it("is exactly what scripts/sims/export-summary-schema.ts writes from the Zod schema (run pnpm sims:summary:schema when this fails)", () => {
    const committed = readFileSync(path.join(REPO_ROOT, "docs/schemas/sims-summary.v1.schema.json"), "utf8");
    expect(committed).toBe(`${JSON.stringify(simsSummaryJsonSchema(), null, 2)}\n`);
  });

  it("describes a closed object whose summaries validate", () => {
    const js = simsSummaryJsonSchema() as { additionalProperties: boolean; properties: { jobs: { maxItems: number } } };
    expect(js.additionalProperties).toBe(false);
    expect(js.properties.jobs.maxItems).toBe(MAX_JOBS);
  });
});

describe("the command", () => {
  it("exits 0 and prints a document that passes the schema, in both modes, with no absolute path", () => {
    const run = (flag: string) => spawnSync(process.execPath, [path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(REPO_ROOT, "scripts/sims/summary.ts"), flag], { cwd: REPO_ROOT, encoding: "utf8", timeout: 50_000 });
    const json = run("--json");
    expect(json.status).toBe(0);
    const parsed = simsSummarySchema.parse(JSON.parse(json.stdout));
    expect(json.stdout).not.toMatch(/\/Users|\/Volumes/);
    expect(parsed.schemaVersion).toBe(1);
    const txt = run("--text");
    expect(txt.status).toBe(0);
    const lines = txt.stdout.trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(MAX_TEXT_LINES);
    expect(lines.every((l) => l.length <= MAX_TEXT_WIDTH)).toBe(true);
    expect(lines[0]).toMatch(/^SWU sims \d+ running, \d+ (stalled|STALLED)/);
    expect(run("--json --text").status).toBe(2);
  }, 55_000);
});
