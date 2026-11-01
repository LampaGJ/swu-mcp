import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The evaluator modules (#124 encoder and vocabulary, #123 inventory schemas and loaders) are pure: no engine, no
 * scripts/. The issue drafted the guard over all of src/sims, but on main src/sims also holds the engine adapter
 * (engine.ts loads the clone's build) and src/tools/sims.ts serves simulate_matchup from it, so the guard names the
 * evaluator modules instead of the directory.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
export const EVALUATOR_MODULES = ["sims/state.ts", "sims/vocab.ts", "sims/model-manifest.ts", "sims/xgb.ts", "sims/forest.ts"];
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : [],
  );
const imports = (file: string): string[] => [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
const present = EVALUATOR_MODULES.map((m) => path.join(SRC, m)).filter((f) => files(path.dirname(f)).includes(f));

describe("evaluator module import boundary", () => {
  it("imports neither the engine, the engine adapter nor scripts/", () => {
    const bad = present.flatMap((f) =>
      imports(f)
        .filter(
          (i) =>
            i.includes("scripts/") ||
            i.includes("forceteki") ||
            /\/(engine|session|match|pool|worker)\.js$/.test(i) ||
            i.startsWith("./policies"),
        )
        .map((i) => `${f}: ${i}`),
    );
    expect(present.length).toBeGreaterThan(0);
    expect(bad).toEqual([]);
  });

  it("is not imported by server code outside src/sims, so the public package is unchanged", () => {
    const names = EVALUATOR_MODULES.map((m) => path.basename(m, ".ts"));
    const bad = files(SRC)
      .filter((f) => !f.startsWith(path.join(SRC, "sims") + path.sep))
      .flatMap((f) =>
        imports(f)
          .filter((i) => names.some((n) => new RegExp(`(^|/)sims/${n}\\.js$`).test(i)))
          .map((i) => `${f}: ${i}`),
      );
    expect(bad).toEqual([]);
  });
});
