import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { REPO_ROOT } from "../../src/paths.js";
import { codeCommit as codeCommitScoped } from "../lib/code-commit.js";

export { REPO_ROOT } from "../../src/paths.js";

/** HEAD, suffixed -dirty when src/, scripts/ or package.json differ from it. */
export const codeCommit = (): string => codeCommitScoped(["src", "scripts", "package.json"]);

export const isMain = (metaUrl: string): boolean => process.argv[1] !== undefined && metaUrl === pathToFileURL(process.argv[1]).href;

/** Newest dated entry under data/runs, following symlinks (a worktree links the built run in). */
export function defaultRun(): string {
  const runs = path.join(REPO_ROOT, "data/runs");
  const newest = readdirSync(runs)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && statSync(path.join(runs, name)).isDirectory())
    .sort(compareCodePoints)
    .at(-1);
  if (newest === undefined) throw new Error(`no dated run under ${runs}`);
  return path.join(runs, newest);
}
