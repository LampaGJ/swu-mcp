/**
 * @displayName Originals root and newest-dated-directory helpers
 * @strategicPurpose One definition of where the mault originals live and how "newest dated directory" is decided, so the build scripts cannot drift apart on either.
 * @tacticalObjective Exports the default originals root, `~/` expansion, and a newest-dated-directory lookup that throws a labelled error when none exists.
 */
import os from "node:os";
import path from "node:path";
import { newestRun } from "../../src/data.js";

export const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";

export function expandHome(value: string): string {
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

export function newestDatedDir(root: string, label: string): string {
  const newest = newestRun(root);
  if (newest === undefined) throw new Error(`no dated ${label} directory under ${root}`);
  return newest;
}

export function newestOriginalsDir(root: string = DEFAULT_ORIGINALS_ROOT): string {
  return newestDatedDir(root, "originals");
}
