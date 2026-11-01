import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, discoverJobs, heartbeatSchema, parseWorktreeList, selectVisible, STALLED_AFTER_S, type JobView } from "../../src/sims/watch.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (agoS: number): string => new Date(NOW - agoS * 1000).toISOString();
const hb = (over: Record<string, unknown> = {}) => ({ ts: iso(3), job: "sims-ladder-h2h-x", done: 10, total: 100, pct: 10, rate_per_s: 2, eta_s: 45, elapsed_s: 5, ...over });

describe("worktree discovery", () => {
  const PORCELAIN = [
    "worktree /Volumes/Local Files/Projects/swu-mcp",
    "HEAD b64be4a0000000000000000000000000000000",
    "branch refs/heads/main",
    "",
    "worktree /Volumes/Local Files/Projects/swu-mcp/.claude/worktrees/sims-live",
    "HEAD b64be4a0000000000000000000000000000000",
    "branch refs/heads/feat/sims-live-stats",
    "",
    "worktree /Volumes/Local Files/Projects/swu-mcp/.claude/worktrees/e9",
    "HEAD 1111111000000000000000000000000000000000",
    "detached",
    "",
  ].join("\n");

  it("parses paths with spaces, branches and a detached head; the first entry is the main checkout", () => {
    expect(parseWorktreeList(PORCELAIN)).toEqual([
      { path: "/Volumes/Local Files/Projects/swu-mcp", branch: "main", main: true },
      { path: "/Volumes/Local Files/Projects/swu-mcp/.claude/worktrees/sims-live", branch: "feat/sims-live-stats", main: false },
      { path: "/Volumes/Local Files/Projects/swu-mcp/.claude/worktrees/e9", branch: null, main: false },
    ]);
  });

  it("returns no worktrees for empty output", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("reads heartbeats from every root and counts files it could not read", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "sims-watch-"));
    const main = path.join(base, "main");
    const wt = path.join(base, "wt");
    for (const [root, name] of [
      [main, "a"],
      [wt, "b"],
    ] as const) {
      mkdirSync(path.join(root, "reports/.progress"), { recursive: true });
      writeFileSync(path.join(root, "reports/.progress", `${name}.json`), `${JSON.stringify(hb({ job: name }))}\n`);
    }
    writeFileSync(path.join(wt, "reports/.progress", "broken.json"), "{not json");
    writeFileSync(path.join(wt, "reports/.progress", "old.json"), `${JSON.stringify({ job: "old", done: 1 })}\n`);
    writeFileSync(path.join(wt, "reports/.progress", "b.jsonl"), "ignored\n");
    mkdirSync(path.join(wt, "tmp/sims-jobs/abc123def456789/"), { recursive: true });
    writeFileSync(path.join(wt, "tmp/sims-jobs/abc123def456789/progress.json"), `${JSON.stringify(hb({ job: "progress" }))}\n`);
    const found = discoverJobs(
      [
        { root: main, label: "main", branch: "main" },
        { root: wt, label: "wt", branch: null },
      ],
      NOW,
      () => true,
    );
    expect(found.jobs.map((j) => `${j.source.label}:${j.job}`)).toEqual(["main:a", "wt:b", "wt:matchup-abc123def456"]);
    expect(found.skipped.map((s) => path.basename(s.file)).sort()).toEqual(["broken.json", "old.json"]);
  });
});

describe("heartbeat and state", () => {
  it("keeps every field the other jobs write", () => {
    const r = heartbeatSchema.parse(hb({ found: 3, custom: "x" }));
    expect(r).toMatchObject({ found: 3, custom: "x", done: 10 });
  });

  it("accepts the Python writer's offset timestamp with microseconds", () => {
    const r = heartbeatSchema.parse(hb({ ts: "2026-11-01T13:01:29.288404+00:00", fraction: 1.0 }));
    expect(classify(r, Date.parse("2026-11-01T13:01:39.288Z"), null).ageS).toBe(10);
  });

  it("reports why a heartbeat does not parse in one short phrase", () => {
    const base = mkdtempSync(path.join(os.tmpdir(), "sims-watch-"));
    mkdirSync(path.join(base, "reports/.progress"), { recursive: true });
    writeFileSync(path.join(base, "reports/.progress/x.json"), JSON.stringify(hb({ ts: "yesterday" })));
    const found = discoverJobs([{ root: base, label: "m", branch: null }], NOW, () => true);
    expect(found.skipped).toHaveLength(1);
    expect(found.skipped[0].reason).toMatch(/^ts: /);
    expect(found.skipped[0].reason).not.toContain("\n");
  });

  it("classifies running, stalled past five minutes, done and dead", () => {
    expect(STALLED_AFTER_S).toBe(300);
    const view = (over: Record<string, unknown>, alive: boolean | null = true) => classify(heartbeatSchema.parse(hb(over)), NOW, alive);
    expect(view({}).state).toBe("running");
    expect(view({ ts: iso(299) }).state).toBe("running");
    expect(view({ ts: iso(301) }).state).toBe("stalled");
    expect(view({ phase: "done", ts: iso(9000) }).state).toBe("done");
    expect(view({}, false).state).toBe("dead");
    expect(view({ phase: "done" }, false).state).toBe("done");
    expect(view({ pid: undefined }, null).state).toBe("running");
    expect(view({ ts: iso(12) }).ageS).toBe(12);
  });

  it("falls back to ts when a heartbeat has no moved_ts", () => {
    expect(classify(heartbeatSchema.parse(hb({ ts: iso(10) })), NOW, true).movedAgeS).toBe(10);
    expect(classify(heartbeatSchema.parse(hb({ ts: iso(10), moved_ts: iso(250) })), NOW, true).movedAgeS).toBe(250);
  });
});

describe("what the default view shows", () => {
  const v = (name: string, over: Record<string, unknown>, alive: boolean | null = true): JobView => ({
    ...classify(heartbeatSchema.parse(hb({ job: name, ...over })), NOW, alive),
    source: { root: "/r", label: "main", branch: "main" },
    file: `/r/${name}.json`,
    stats: null,
    statsError: null,
    job: name,
  });
  it("shows live jobs, a stalled job whose process lives, and anything finished in the last hour; --all shows the rest", () => {
    const jobs = [
      v("live", {}),
      v("done-recent", { phase: "done", ts: iso(600) }),
      v("done-old", { phase: "done", ts: iso(7200) }),
      v("hung", { ts: iso(7200) }),
      v("dead-old", { ts: iso(7200) }, false),
      v("dead-recent", { ts: iso(100) }, false),
    ];
    expect(selectVisible(jobs, false).map((j) => j.job)).toEqual(["live", "hung", "dead-recent", "done-recent"]);
    expect(selectVisible(jobs, true)).toHaveLength(6);
  });
});
