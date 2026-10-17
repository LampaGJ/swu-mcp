import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Nearest ancestor holding package.json, so the same code finds the root from src/, src/tools/ and the bundled dist/. */
function findPackageRoot(from: string): string {
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) throw new Error(`no package.json above ${from}`);
  }
}

export const REPO_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
