import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { progress } from "../../scripts/lib/progress.mjs";

const LIVE = path.resolve("reports/.progress");
const JOB = "progress-dir-guard-job";
const listing = (): string[] => (existsSync(LIVE) ? readdirSync(LIVE).sort() : []);

const restore = (v: string | undefined): void => {
  if (v === undefined) delete process.env.SWU_MCP_PROGRESS_DIR;
  else process.env.SWU_MCP_PROGRESS_DIR = v;
};

describe("heartbeat output directory (scripts/lib/progress.mjs, #180)", () => {
  afterEach(() => {
    for (const f of [`${JOB}.json`, `${JOB}.jsonl`]) rmSync(path.join(LIVE, f), { force: true });
  });

  it("keeps heartbeats written under the test environment out of the repo's reports/.progress", () => {
    const before = listing();
    progress(JOB, { total: 1, everyN: 1 }).done();
    expect(listing()).toEqual(before);
    expect(process.env.SWU_MCP_PROGRESS_DIR).toBeTruthy();
    expect(existsSync(path.join(process.env.SWU_MCP_PROGRESS_DIR as string, `${JOB}.json`))).toBe(true);
  });

  it("writes to SWU_MCP_PROGRESS_DIR when no dir option is given, and an explicit dir still wins", () => {
    const saved = process.env.SWU_MCP_PROGRESS_DIR;
    const viaEnv = mkdtempSync(path.join(os.tmpdir(), "progress-env-"));
    const explicit = mkdtempSync(path.join(os.tmpdir(), "progress-explicit-"));
    try {
      process.env.SWU_MCP_PROGRESS_DIR = viaEnv;
      progress(JOB, { total: 1, everyN: 1 }).done();
      progress(`${JOB}-explicit`, { dir: explicit, total: 1, everyN: 1 }).done();
      expect(existsSync(path.join(viaEnv, `${JOB}.json`))).toBe(true);
      expect(existsSync(path.join(explicit, `${JOB}-explicit.json`))).toBe(true);
      expect(existsSync(path.join(viaEnv, `${JOB}-explicit.json`))).toBe(false);
    } finally {
      restore(saved);
      rmSync(viaEnv, { recursive: true, force: true });
      rmSync(explicit, { recursive: true, force: true });
    }
  });

  it("falls back to the repo's reports/.progress when the variable is unset or empty", () => {
    const saved = process.env.SWU_MCP_PROGRESS_DIR;
    try {
      delete process.env.SWU_MCP_PROGRESS_DIR;
      progress(JOB, { total: 1, everyN: 1 }).done();
      expect(existsSync(path.join(LIVE, `${JOB}.json`))).toBe(true);
    } finally {
      restore(saved);
    }
  });
});
