import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { progress } from "../../scripts/lib/progress.mjs";

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "progress-test-"));
const latest = (dir: string, job: string): Record<string, unknown> => JSON.parse(readFileSync(path.join(dir, `${job}.json`), "utf8"));

describe("heartbeat contract (scripts/lib/progress.mjs)", () => {
  it("keeps the fields other jobs and hooks read, at the same paths", () => {
    const dir = tmp();
    const p = progress("job", { dir, total: 10, everyN: 1 });
    p.tick(4, { phase: "scan", found: 2 });
    const r = latest(dir, "job");
    expect(r).toMatchObject({ job: "job", done: 4, total: 10, pct: 40, phase: "scan", found: 2 });
    expect(typeof r.ts).toBe("string");
    expect(Number.isInteger(r.rate_per_s)).toBe(true);
    expect(typeof r.eta_s === "number" || r.eta_s === null).toBe(true);
    expect(typeof r.elapsed_s).toBe("number");
    expect(existsSync(path.join(dir, "job.jsonl"))).toBe(true);
  });

  it("adds pid, a two-decimal games_per_s and moved_ts; rate_per_s stays the rounded integer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
      const dir = tmp();
      const p = progress("fast", { dir, total: 100, everyN: 1 });
      vi.setSystemTime(new Date("2026-11-01T12:00:08.000Z"));
      p.tick(10, {});
      const r = latest(dir, "fast");
      expect(r.games_per_s).toBe(1.25);
      expect(r.rate_per_s).toBe(1);
      expect(r.pid).toBe(process.pid);
      expect(r.moved_ts).toBe("2026-11-01T12:00:08.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("calls an extra function only when a record is written", () => {
    const dir = tmp();
    const extra = vi.fn(() => ({ stats: { n: 1 } }));
    const p = progress("lazy", { dir, total: 1000, everyN: 100, everyMs: 1e9 });
    p.tick(1, extra);
    expect(extra).toHaveBeenCalledTimes(1);
    p.tick(2, extra);
    p.tick(3, extra);
    expect(extra).toHaveBeenCalledTimes(1);
    p.tick(150, extra);
    expect(extra).toHaveBeenCalledTimes(2);
    p.done(() => ({ stats: { n: 2 } }));
    expect(latest(dir, "lazy")).toMatchObject({ phase: "done", stats: { n: 2 } });
  });

  it("keepAliveMs rewrites the latest file with a fresh ts and the same payload, leaves the history alone, and stops at done", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
      const dir = tmp();
      const p = progress("alive", { dir, total: 10, everyN: 1, keepAliveMs: 1000 });
      p.tick(3, { phase: "games", stats: { n: 3 } });
      const lines = (): number => readFileSync(path.join(dir, "alive.jsonl"), "utf8").trim().split("\n").length;
      expect(lines()).toBe(1);
      vi.setSystemTime(new Date("2026-11-01T12:00:05.000Z"));
      vi.advanceTimersByTime(1000);
      const r = latest(dir, "alive");
      expect(r).toMatchObject({ done: 3, phase: "games", stats: { n: 3 }, ts: "2026-11-01T12:00:06.000Z", moved_ts: "2026-11-01T12:00:00.000Z" });
      expect(lines()).toBe(1);
      p.done({});
      expect(latest(dir, "alive").phase).toBe("done");
      vi.advanceTimersByTime(5000);
      expect(latest(dir, "alive").phase).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
