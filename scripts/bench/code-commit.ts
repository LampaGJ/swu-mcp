import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareCodePoints } from "../../src/swu/canonical.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** HEAD, suffixed -dirty when src/, scripts/ or package.json differ from it. */
export function codeCommit(): string {
  const git = (args: string[]): string => execFileSync("git", ["-C", REPO_ROOT, ...args], { encoding: "utf8" }).trim();
  const dirty = git(["status", "--porcelain", "--", "src", "scripts", "package.json"]) === "" ? "" : "-dirty";
  return `${git(["rev-parse", "HEAD"])}${dirty}`;
}

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
