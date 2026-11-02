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

  it("emits a plain headline for a live h2h job, with no kind word and no interval", () => {
    const st = {
      ...stats("h2h", "base vs anakin", { subject: "base", other: "anakin" }),
      result: { wins: 2335, n: 4560, share: 0.512, low: 0.479, high: 0.545 },
      paired: { pairs: 2280, subjectBoth: 600, otherBoth: 570, pValue: 0.31 },
    };
    const s = summ([view("sims-ladder-h2h-warrior-h2h-rung3v", { done: 4560, total: 12600, pct: 36.2, eta_s: 6300 }, st)]);
    expect(s.jobs[0].headline).toBe("Warrior h2h rung3v: 4,560 of 12,600 games, 36%, 1h45 left");
    expect(s.jobs[0].headline.length).toBeLessThanOrEqual(MAX_HEADLINE);
    expect(s.jobs[0].headline.length).toBeLessThanOrEqual(MAX_TEXT_WIDTH);
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
    expect(renderSummaryText(s)).toEqual(["Sims: 0 running, 0 finished in the last hour"]);
    expect(summ([]).jobs).toEqual([]);
  });
});

describe("truncation", () => {
  it("cuts a long name at a word boundary or with dots, a long phase to 80, and keeps the counts", () => {
    const longSide = "x".repeat(120);
    const st = { ...stats("h2h", "p".repeat(200), { subject: "base", other: longSide }), result: { wins: 5, n: 10, share: 0.5, low: 0.24, high: 0.76 } };
    const s = summ([view("sims-ladder-h2h-" + "n".repeat(300), {}, st)]);
    const j = s.jobs[0];
    expect(j.headline.length).toBeLessThanOrEqual(MAX_HEADLINE);
    expect(j.headline).toContain("50 of 100 games");
    expect(j.phase).toHaveLength(MAX_PHASE);
    expect(j.phase.endsWith("...")).toBe(true);
    expect(j.id.length).toBeLessThanOrEqual(120);
    expect(simsSummarySchema.safeParse(s).success).toBe(true);
  });
});

describe("text mode", () => {
  it("starts with the totals line and words stalled and dead jobs plainly", () => {
    const lines = renderSummaryText(summ([stalled("sims-ladder-h2h-a"), dead("sims-ladder-field-b"), view("sims-ladder-cost-c"), finished("sims-ladder-tune-d", 90)]));
    expect(lines[0]).toBe("Sims: 1 running, 1 stalled, 1 dead, 1 finished in 1h");
    expect(lines[1]).toMatch(/^A: stalled 6m/);
    expect(lines[2]).toMatch(/^B: stopped \(dead\)/);
    expect(lines[3]).toBe("C: 50 of 100 games, 50%, 16s left");
    expect(lines[4]).toBe("D: finished, 100 games");
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
    expect(lines[1]).toContain("finished, 100 games, failed");
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
    expect(s.jobs[0].headline).toBe("Rung3v k 8: finished, 100 games, failed (ladder, external)");
  });

  it("reports a passing ladder job with no failed gates, and no verdict for other finished kinds or running jobs", () => {
    const s = summ([finished("sims-ladder-ladder-rung3v-vs-rung0-final", 60, { pass: true }), finished("sims-ladder-h2h-x", 70), view("sims-calibration-live", { pass: true }), finished("sims-ladder-field-y", 80, { pass: true })]);
    const by = Object.fromEntries(s.jobs.map((j) => [j.id, j.verdict]));
    expect(by["sims-ladder-ladder-rung3v-vs-rung0-final"]).toEqual({ pass: true, failedGates: [] });
    expect(by["sims-ladder-h2h-x"]).toBeNull();
    expect(by["sims-calibration-live"]).toBeNull();
    expect(by["sims-ladder-field-y"]).toBeNull();
    expect(s.jobs.find((j) => j.id === "sims-ladder-ladder-rung3v-vs-rung0-final")?.headline).toBe("Rung3v vs rung0 final: finished, 100 games, passed");
  });

  it("falls back to the last finished phase for the result of a done job", () => {
    const t = new LiveStats({ kind: "ladder", provenance: PROV });
    t.beginPhase("rung1 vs rung0", 4, { subject: "rung1", other: "rung0" });
    [g(1), g(2), g(3, { won: false, winnerSeat: 2 })].forEach((x) => t.add(x));
    t.endPhase();
    const s = summ([finished("sims-ladder-ladder-x", 60, { pass: true }, t.snapshot())]);
    expect(s.jobs[0].result).toMatchObject({ subject: "rung1", n: 3 });
    expect(s.jobs[0].headline).toBe("X: finished, 100 games, passed, rung1 67%");
  });

  it("carries whole-run errors, draws and timeouts, and zeros when there are no stats", () => {
    const st = stats("h2h", "p", { subject: "a", other: "b" }, [g(1), g(2, { endCondition: "timeout", winnerSeat: null, won: null }), g(3, { endCondition: "error", error: "boom", winnerSeat: null, won: null }), g(4, { endCondition: "base_destroyed", winnerSeat: null, won: null })]);
    const s = summ([view("with-stats", {}, st), view("no-stats")]);
    expect(s.jobs.find((j) => j.id === "with-stats")?.health).toEqual({ errors: 1, draws: 1, timeouts: 1 });
    const bare = s.jobs.find((j) => j.id === "no-stats");
    expect(bare).toMatchObject({ health: { errors: 0, draws: 0, timeouts: 0 }, result: null, verdict: null, kind: "other", phase: "starting" });
    expect(bare?.headline).toBe("No stats: 50 of 100 games, 50%, 16s left");
  });

  it("flags stalled and dead in the state, the headline and the totals", () => {
    const s = summ([stalled("sims-ladder-h2h-s", 600), dead("sims-ladder-h2h-d", 45)]);
    expect(s.jobs.map((j) => [j.state, j.updatedAgeS])).toEqual([["stalled", 600], ["dead", 45]]);
    expect(s.jobs[0].headline).toBe("S: stalled 10m, 50 of 100 games");
    expect(s.jobs[1].headline).toBe("D: stopped (dead), 50 of 100 games");
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
    expect(lines[0]).toMatch(/^Sims: \d+ running, .*\d+ finished in (the last hour|1h)$/);
    expect(run("--json --text").status).toBe(2);
  }, 55_000);
});

describe("plain wording for the widget (#200)", () => {
  const gauntletStats = () =>
    stats("matchup", "screen", null, [
      ...Array.from({ length: 34 }, (_, i) => g(1000 + i, { endCondition: "error", error: "boom", winnerSeat: null, won: null })),
      ...Array.from({ length: 38 }, (_, i) => g(2000 + i, { winnerSeat: null, won: null })),
    ]);
  const gauntlet = (): JobView[] => [
    view("gauntlet-jerjerrod-dume-2026-11-01-screen", { label: "Gauntlet screen", phase: "screen", done: 23040, total: 62600, pct: 36.8, eta_s: 840 }, gauntletStats()),
    finished("gauntlet-smoke-screen", 659, { label: "Gauntlet smoke test", done: 120, total: 120 }, stats("matchup", "screen", null)),
    finished("tournament-panel", 727, { done: 0, total: null, pct: null, eta_s: null }),
  ];

  it("writes the plain lines for the gauntlet jobs; the 14m ETA drops because the full line would be 65 characters", () => {
    expect(renderSummaryText(summ(gauntlet()))).toEqual([
      "Sims: 1 running, 2 finished in the last hour",
      "Gauntlet screen: 23,040 of 62,600 games, 37%, 34 errors",
      "Gauntlet smoke test: finished, 120 games",
      "Tournament panel: finished",
    ]);
  });

  it("shows the ETA when the whole line fits in 60 characters", () => {
    const s = summ([view("j", { label: "Screen", done: 23040, total: 62600, pct: 36.8, eta_s: 840 }, gauntletStats())]);
    expect(s.jobs[0].headline).toBe("Screen: 23,040 of 62,600 games, 37%, 14m left, 34 errors");
  });

  it("shows no internal kind word and never ends a line in dots when the words fit", () => {
    const s = summ(gauntlet());
    for (const l of renderSummaryText(s)) expect(l).not.toMatch(/\b(matchup|other)\b|\.\.\./);
    expect(s.jobs.map((j) => j.headline)).toEqual(["Gauntlet screen: 23,040 of 62,600 games, 37%, 34 errors", "Gauntlet smoke test: finished, 120 games", "Tournament panel: finished"]);
  });

  it("names a job without a label from its id: kind prefix, dates and dashes removed, sentence case", () => {
    const s = summ([view("gauntlet-jerjerrod-dume-2026-11-01-screen", { done: 5, total: 10, pct: 50, eta_s: 30 }), finished("matchup-2026-11-01-abc", 60, { done: 3, total: 3 }, stats("matchup", "p", null))]);
    expect(s.jobs[0].headline.startsWith("Gauntlet jerjerrod dume screen: 5 of 10 games")).toBe(true);
    expect(s.jobs[1].headline).toBe("Abc: finished, 3 games");
  });

  it("keeps the warning wording for stalled and dead jobs, plainer, and lists them first", () => {
    const lines = renderSummaryText(summ([view("run-a", { label: "Run A" }), stalled("stall-b", 360), dead("dead-c")]));
    expect(lines[0]).toBe("Sims: 1 running, 1 stalled, 1 dead, 0 finished in 1h");
    expect(renderSummaryText(summ([stalled("only-stall")]))[0]).toBe("Sims: 0 running, 1 stalled, 0 finished in the last hour");
    expect(lines[1]).toMatch(/^Stall b: stalled 6m, 50 of 100 games/);
    expect(lines[2]).toMatch(/^Dead c: stopped \(dead\)/);
    expect(lines[3]).toMatch(/^Run A: 50 of 100 games/);
  });

  it("drops the ETA, then the percent, before the counts, and never cuts a number", () => {
    const long = (label: string) => summ([view("j", { label, done: 23040, total: 62600, pct: 36.8, eta_s: 840 }, gauntletStats())]).jobs[0].headline;
    expect(long("Gauntlet screen pass")).toBe("Gauntlet screen pass: 23,040 of 62,600 games, 37%, 34 errors");
    expect(long("Gauntlet screen pass two")).toBe("Gauntlet screen pass two: 23,040 of 62,600 games, 34 errors");
    const tight = long("Gauntlet screen with a much longer name than fits");
    expect(tight.length).toBeLessThanOrEqual(MAX_TEXT_WIDTH);
    expect(tight).toContain("23,040 of 62,600 games");
    expect(tight).toContain("34 errors");
    expect(tight).toMatch(/^Gauntlet screen with a\.\.\.: /);
  });

  it("groups thousands with a fixed formatter and shows errors only when above zero", () => {
    const s = summ([view("a", { label: "A", done: 1234567, total: 2000000, pct: 61.7, eta_s: 5400 })]);
    expect(s.jobs[0].headline).toBe("A: 1,234,567 of 2,000,000 games, 62%, 1h30 left");
  });

  it("reads a finished job with a verdict and a single game in plain words", () => {
    const s = summ([finished("sims-calibration-rung3v", 60, { pass: true, done: 1, total: 1 }), finished("sims-ladder-ladder-x", 70, { pass: false, failedGates: ["ladder", "external"], done: 8, total: 8 })]);
    expect(s.jobs[0].headline).toBe("Rung3v: finished, 1 game, passed");
    expect(s.jobs[1].headline).toBe("X: finished, 8 games, failed (ladder, external)");
  });

  it("keeps every text line within 60 characters even for an unbroken long name", () => {
    const lines = renderSummaryText(summ([view("x".repeat(200), { done: 23040, total: 62600, pct: 36.8, eta_s: 840 })]));
    expect(lines[1].length).toBeLessThanOrEqual(MAX_TEXT_WIDTH);
    expect(lines[1]).toContain("23,040 of 62,600 games");
  });

  it("totals line falls back to a short form when stalled and dead make it too long", () => {
    const jobs = [...Array.from({ length: 12 }, (_, i) => view(`r${i}`)), stalled("s"), dead("d")];
    const first = renderSummaryText(summ(jobs))[0];
    expect(first.length).toBeLessThanOrEqual(MAX_TEXT_WIDTH);
    expect(first).toMatch(/^Sims: 12 running, 1 stalled, 1 dead, 0 finished/);
  });

  it("accepts an optional heartbeat label and still parses a heartbeat without one", () => {
    expect(heartbeatSchema.safeParse({ ts: iso(1), job: "a", done: 0, total: null, pct: null, eta_s: null, label: "Nice name" }).success).toBe(true);
    const bad = heartbeatSchema.parse({ ts: iso(1), job: "a", done: 0, total: null, pct: null, eta_s: null, label: 5 });
    expect(bad.label).toBeUndefined();
    expect(heartbeatSchema.safeParse({ ts: iso(1), job: "a", done: 0, total: null, pct: null, eta_s: null }).success).toBe(true);
  });
});
