import { execFile } from "node:child_process";
import path from "node:path";
import { parseWorktreeList, type Source } from "./watch.js";

/**
 * @displayName Simulation heartbeat sources
 * @strategicPurpose One answer to "which checkouts hold simulation heartbeats" for every reader (sims:watch, sims:summary),
 * so the viewer and the widget summary never disagree about where to look (#179 of #104, D100).
 * @tacticalObjective Lists the main checkout and every linked worktree with `git worktree list --porcelain` as Source
 * records, falling back to the given root alone when git fails, and tests whether a heartbeat's pid still exists.
 */

export function listSources(repoRoot: string): Promise<Source[]> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], { encoding: "utf8", timeout: 60_000 }, (err, stdout) => {
      const trees = err === null ? parseWorktreeList(stdout) : [];
      if (trees.length === 0) return resolve([{ root: repoRoot, label: path.basename(repoRoot), branch: null, main: true }]);
      resolve(trees.map((t) => ({ root: t.path, label: t.main ? `${path.basename(t.path)} (main checkout)` : path.basename(t.path), branch: t.branch, main: t.main })));
    });
  });
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};
