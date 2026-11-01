import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

// Heartbeats written by a test must not land in the checkout's reports/.progress, where sims:summary, sims:watch and
// the widgets show them as dead jobs (#180). scripts/lib/progress.mjs reads this variable; child processes and worker
// threads the tests start inherit it.
const dir = mkdtempSync(path.join(os.tmpdir(), "swu-mcp-progress-"));
process.env.SWU_MCP_PROGRESS_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
