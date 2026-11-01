import { describe, expect, it } from "vitest";
import { LiveStats, type GameObs, type LiveKind } from "../../src/sims/live-stats.js";
import { classify, heartbeatSchema, renderJob, renderScreen, type JobView, type Paint, type Source } from "../../src/sims/watch.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const iso = (agoS: number): string => new Date(NOW - agoS * 1000).toISOString();
const MAIN: Source = { root: "/r/main", label: "swu-mcp", branch: "main" };
const WT: Source = { root: "/r/wt", label: "sims-live", branch: "feat/sims-live-stats" };
const PROV = { policies: [{ name: "rung1", paramsSha256: "0123456789abcdef".repeat(4) }], seeds: { from: 2000000, to: 2000199 }, enginePin: "a1b2c3d4e5f60718", codeCommit: "b64be4a1234567890", run: "2026-10-31" };

const g = (seed: number, over: Partial<GameObs> = {}): GameObs => ({ seed, winnerSeat: 1, endCondition: "base_destroyed", error: null, rounds: 7, decisions: 120, won: true, ...over });

function ladderStats() {
  const t = new LiveStats({ kind: "ladder", provenance: PROV });
  t.beginPhase("rung1 vs rung0", 400, { subject: "rung1", other: "rung0" });
  // 30 duplicate pairs: 16 won in both seats, 5 lost in both, 8 split, 1 with a draw.
  const plan: [boolean | null, boolean | null][] = [...Array(16).fill([true, true]), ...Array(5).fill([false, false]), ...Array(8).fill([true, false]), [null, true]];
  plan.forEach(([a, b], i) => {
    const deck = ["krennic", "cad-bane", "sabine"][i % 3];
    for (const won of [a, b]) t.add(g(2000000 + i, { pair: String(i), won, stratum: deck, winnerSeat: won === null ? null : won ? 1 : 2, endCondition: won === null ? "draw" : "base_destroyed", fallback: { decisions: 120, fallback: 3 } }));
  });
  t.addCounter("searchRollbacks", 0);
  return t.snapshot();
}

function view(over: Record<string, unknown>, stats: ReturnType<typeof ladderStats> | null, source: Source = MAIN, alive: boolean | null = true): JobView {
  const hb = heartbeatSchema.parse({ ts: iso(4), job: "sims-ladder-ladder-rung1-vs-rung0", done: 60, total: 400, pct: 15, rate_per_s: 3, games_per_s: 3.07, eta_s: 111, elapsed_s: 20, phase: "rung1 vs rung0", pid: 4242, moved_ts: iso(4), ...over, ...(stats ? { stats } : {}) });
  return { ...classify(hb, NOW, alive), source, file: "/r/x.json", stats, statsError: null };
}

describe("renderJob", () => {
  it("a live ladder job: x of y, bar, ETA, share with interval, paired p, health, provenance", () => {
    const lines = renderJob(view({}, ladderStats()));
    expect(lines).toMatchInlineSnapshot(`
      [
        "sims-ladder-ladder-rung1-vs-rung0  [swu-mcp main]  RUNNING  heartbeat 4s ago",
        "  60 of 400 games (15.0%)  [████░░░░░░░░░░░░░░░░░░░░]  ETA 1m51s  3.07/s  elapsed 20s",
        "  phase 1: rung1 vs rung0  (60 of 400 games in this phase)",
        "  rung1 69.5% (41/59) of decisive games, 95% interval 56.9% to 79.8%",
        "  paired: rung1 won both seats in 16 pairs, rung0 in 5, of 30 pairs; exact sign test p = 0.0266",
        "  health: 59 decisive, 1 draws, 0 timeouts, 0 stuck, 0 errors; mean rounds 7, mean decisions 120; fallback decisions 2.5%",
        "  seat 1 won 69.5% (41/59) of decisive games (all games), 95% interval 56.9% to 79.8%",
        "  rows: cad-bane 65% (13/20); krennic 75% (15/20); sabine 68% (13/19)",
        "  counters: searchRollbacks 0",
        "  provenance: policy rung1 (params 0123456789ab); seeds 2000000 to 2000199; engine pin a1b2c3d4e; code b64be4a12345; run 2026-10-31",
        "  last progress 4s ago",
      ]
    `);
  });

  it("a finished h2h job drops the ETA and lists its finished phases", () => {
    const t = new LiveStats({ kind: "h2h", provenance: { ...PROV, seeds: { from: 1, to: 4 } } });
    t.beginPhase("h2h base vs v1 rung1", 8, { subject: "base", other: "v1" });
    for (let i = 0; i < 4; i++) for (const won of [i < 3, i < 2]) t.add(g(i + 1, { pair: String(i), won, winnerSeat: won ? 1 : 2, group: "v1", headline: true }));
    t.beginPhase("h2h mirror rung1", 4, null);
    for (const w of [1, 2, 1, 1] as const) t.add(g(9, { mirror: true, won: null, winnerSeat: w }));
    const lines = renderJob(view({ phase: "done", done: 12, total: 12, pct: 100, eta_s: 0, ts: iso(90), moved_ts: iso(90), games_per_s: 0.5 }, t.snapshot()));
    expect(lines).toMatchInlineSnapshot(`
      [
        "sims-ladder-ladder-rung1-vs-rung0  [swu-mcp main]  DONE  heartbeat 1m30s ago",
        "  12 of 12 games (100.0%)  [████████████████████████]  0.50/s  elapsed 20s",
        "  phase 2: h2h mirror rung1  (4 of 4 games in this phase)",
        "  health: 4 decisive, 0 draws, 0 timeouts, 0 stuck, 0 errors; mean rounds 7, mean decisions 120; fallback decisions n/a",
        "  seat 1 won 75.0% (3/4) of decisive games (mirror games only), 95% interval 30.1% to 95.4%",
        "  finished phases (1): h2h base vs v1 rung1: 8 games, 62.5% (5/8), p = 1",
        "  provenance: policy rung1 (params 0123456789ab); seeds 1 to 4; engine pin a1b2c3d4e; code b64be4a12345; run 2026-10-31",
        "  last progress 1m30s ago; 12 games played in all phases",
      ]
    `);
  });

  it("a stalled job says so and shows the age", () => {
    const lines = renderJob(view({ ts: iso(400), moved_ts: iso(400) }, ladderStats(), WT));
    expect(lines[0]).toContain("STALLED (no heartbeat for over 5 minutes)");
    expect(lines[0]).toContain("heartbeat 6m40s ago");
    expect(lines[0]).toContain("[sims-live feat/sims-live-stats]");
  });

  it("a dead process is flagged even when the heartbeat is fresh", () => {
    expect(renderJob(view({}, ladderStats(), MAIN, false))[0]).toContain("DEAD (process gone)");
  });

  it("a heartbeat without live stats renders the generic block", () => {
    const lines = renderJob(view({ job: "build-data", phase: "export" }, null));
    expect(lines).toMatchInlineSnapshot(`
      [
        "build-data  [swu-mcp main]  RUNNING  heartbeat 4s ago",
        "  60 of 400 (15.0%)  [████░░░░░░░░░░░░░░░░░░░░]  ETA 1m51s  3.07/s  elapsed 20s",
        "  phase: export",
        "  last progress 4s ago",
      ]
    `);
  });

  it("calibration labels its steps", () => {
    const t = new LiveStats({ kind: "calibration", provenance: PROV });
    t.beginPhase("games", 100, null);
    t.setCounter("replayChecked", 3);
    expect(renderJob(view({ job: "sims-calibration-rung1", done: 100, total: 160 }, t.snapshot() as never))[1]).toContain("100 of 160 steps, games then replay checks");
  });

  it("marks a run from an uncommitted tree", () => {
    const t = new LiveStats({ kind: "ladder", provenance: { ...PROV, codeCommit: "b64be4a1234567890abcdef-dirty" } });
    t.beginPhase("p", 2, null);
    const line = renderJob(view({}, t.snapshot() as never)).find((l) => l.includes("provenance"));
    expect(line).toContain("code b64be4a (uncommitted changes)");
  });

  it("paints through the injected painter and leaves the text alone otherwise", () => {
    const paint: Paint = (f, t) => `<${f}>${t}</${f}>`;
    expect(renderJob(view({}, ladderStats()), paint)[0]).toContain("<green>RUNNING</green>");
    expect(renderJob(view({}, ladderStats()))[0]).not.toContain("<");
  });
});

describe("renderScreen", () => {
  it("shows the live job first, hides an old finished one unless asked, and reports unreadable files", () => {
    const live = view({}, ladderStats());
    const old = view({ job: "old-run", phase: "done", ts: iso(9000), moved_ts: iso(9000) }, null, WT);
    const skipped = [{ file: "/r/wt/reports/.progress/broken.json", reason: "not JSON: Unexpected token" }];
    const lines = renderScreen({ jobs: [old, live], all: false, skipped, sources: [MAIN, WT], nowMs: NOW });
    expect(lines.join("\n")).toContain("1 of 2 jobs shown");
    expect(lines.join("\n")).not.toContain("old-run");
    expect(lines.at(-1)).toContain("1 heartbeat files could not be read: broken.json (not JSON: Unexpected token)");
    expect(renderScreen({ jobs: [old, live], all: true, skipped: [], sources: [MAIN, WT], nowMs: NOW }).join("\n")).toContain("old-run");
  });

  it("says plainly when nothing runs", () => {
    expect(renderScreen({ jobs: [], all: false, skipped: [], sources: [MAIN], nowMs: NOW }).join("\n")).toContain("no live simulation jobs");
  });
});

export type { LiveKind };
