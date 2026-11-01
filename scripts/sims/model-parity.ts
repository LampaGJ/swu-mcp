/**
 * @displayName Legacy-model loader parity
 * @strategicPurpose A loader's score is trusted only once it reproduces the original runtime on the same inputs.
 * @tacticalObjective 64 seeded vectors per model, half on split thresholds, scored by Booster.predict in the .venv or
 * by the harness's RandomForest in a scratch copy under <repo>/tmp (never inside /Volumes/Models), parsed and compared.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../../src/paths.js";
import { type Forest, predictForest } from "../../src/sims/forest.js";
import { parityFileSchema } from "../../src/sims/model-manifest.js";
import { predictXgb, type XgbModel } from "../../src/sims/xgb.js";
import { seededRandom } from "../bench/stats.js";

export const PARITY_VECTORS = 64;
export const XGB_TOLERANCE = 1e-6;
export const VENV_PYTHON = path.join(REPO_ROOT, ".venv/bin/python");
export const hasVenv = (): boolean => existsSync(VENV_PYTHON);
const TMP = path.join(REPO_ROOT, "tmp");
const childEnv = { ...process.env, TMPDIR: TMP, UV_CACHE_DIR: path.join(TMP, "uv-cache") };

export function parityVectors(sha256: string, numFeatures: number, thresholds: ReadonlyMap<number, readonly number[]>): number[][] {
  return Array.from({ length: PARITY_VECTORS }, (_, i) => {
    const rnd = seededRandom(`parity|${sha256}|${i}`);
    return Array.from({ length: numFeatures }, (_, column) => {
      const ties = thresholds.get(column) ?? [];
      if (i % 2 === 1 && ties.length > 0) return ties[Math.floor(rnd() * ties.length)];
      return Math.round((rnd() * 40 - 5) * 1e4) / 1e4;
    });
  });
}

export function xgbThresholds(model: XgbModel): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const t of model.trees)
    t.left_children.forEach((left, n) =>
      left === -1 ? undefined : out.set(t.split_indices[n], [...(out.get(t.split_indices[n]) ?? []), t.split_conditions[n]]),
    );
  return out;
}

export function forestThresholds(forest: Forest): Map<number, number[]> {
  const out = new Map<number, number[]>();
  forest.trees.forEach((tree, i) => {
    const visit = (node: Forest["trees"][number]): void => {
      if (node.type === "leaf") return;
      const column = forest.featureSubsets[i][node.featureIndex];
      out.set(column, [...(out.get(column) ?? []), node.threshold]);
      visit(node.left);
      visit(node.right);
    };
    visit(tree);
  });
  return out;
}

export function xgbParity(
  modelFile: string,
  sha256: string,
  model: XgbModel,
): { ok: boolean; maxAbsDiff: number; file: z.infer<typeof parityFileSchema> } {
  const python = VENV_PYTHON;
  if (!hasVenv()) throw new Error(`no ${python}; create it per scripts/sims/py/requirements.txt`);
  const vectors = parityVectors(sha256, model.numFeature, xgbThresholds(model));
  mkdirSync(TMP, { recursive: true });
  const vectorsFile = path.join(TMP, `parity-${sha256.slice(0, 12)}.json`);
  writeFileSync(vectorsFile, JSON.stringify(vectors));
  const out = execFileSync(python, ["-I", path.join(REPO_ROOT, "scripts/sims/py/xgb_parity.py"), modelFile, vectorsFile, sha256], {
    encoding: "utf8",
    env: childEnv,
    maxBuffer: 1 << 26,
  });
  const file = parityFileSchema.parse(JSON.parse(out));
  if (file.modelSha256 !== sha256) throw new Error(`parity output names ${file.modelSha256}, expected ${sha256}`);
  const diffs = vectors.map((v, i) => Math.abs(predictXgb(model, v) - file.booster[i]));
  const maxAbsDiff = Math.max(...diffs);
  return { ok: maxAbsDiff <= XGB_TOLERANCE, maxAbsDiff, file };
}

/** Copies the harness's src/ into <repo>/tmp and links its node_modules, so nothing is written under the volume. */
export function harnessCopy(harness: string, head: string): string {
  const dir = path.join(TMP, "sims-harness", head.slice(0, 12));
  if (!existsSync(path.join(dir, "src"))) {
    mkdirSync(dir, { recursive: true });
    cpSync(path.join(harness, "src"), path.join(dir, "src"), { recursive: true });
    for (const f of ["package.json", "tsconfig.json"])
      if (existsSync(path.join(harness, f))) cpSync(path.join(harness, f), path.join(dir, f));
    symlinkSync(path.join(harness, "node_modules"), path.join(dir, "node_modules"));
  }
  return dir;
}

export function runHarnessProbe(dir: string, source: string): unknown {
  const probe = path.join(dir, `probe-${process.pid}.ts`);
  writeFileSync(probe, source);
  return JSON.parse(
    // node plus the tsx entry, not the node_modules/.bin shim: a shim launch stalls 16-31 s on this volume (CLAUDE.md).
    execFileSync(process.execPath, [path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs"), probe], {
      cwd: dir,
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 1 << 26,
    }),
  );
}

export function forestParity(dir: string, modelFile: string, sha256: string, forest: Forest): { ok: boolean; mismatches: number } {
  const vectors = parityVectors(sha256, forest.numFeatures, forestThresholds(forest));
  const vectorsFile = path.join(dir, `vectors-${sha256.slice(0, 12)}.json`);
  writeFileSync(vectorsFile, JSON.stringify(vectors));
  const reference = z
    .array(z.number())
    .length(vectors.length)
    .parse(
      runHarnessProbe(
        dir,
        [
          `import { readFileSync } from "node:fs";`,
          `import { RandomForest } from "./src/ml/RandomForest";`,
          `const forest = RandomForest.fromJSON(JSON.parse(readFileSync(${JSON.stringify(modelFile)}, "utf8")).data);`,
          `const vectors: number[][] = JSON.parse(readFileSync(${JSON.stringify(vectorsFile)}, "utf8"));`,
          `console.log(JSON.stringify(vectors.map((v) => forest.predict(v))));`,
        ].join("\n"),
      ),
    );
  const mismatches = vectors.filter((v, i) => predictForest(forest, v) !== reference[i]).length;
  return { ok: mismatches === 0, mismatches };
}
