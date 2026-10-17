import { execFileSync } from "node:child_process";
import { REPO_ROOT } from "../../src/paths.js";

export function git(args: readonly string[], root: string = REPO_ROOT): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** HEAD, suffixed -dirty when anything in the scope (or the whole tree) differs from it. */
export function codeCommit(scope: readonly string[] | "whole-tree", root: string = REPO_ROOT): string {
  const status = git(scope === "whole-tree" ? ["status", "--porcelain"] : ["status", "--porcelain", "--", ...scope], root);
  return `${git(["rev-parse", "HEAD"], root)}${status === "" ? "" : "-dirty"}`;
}
