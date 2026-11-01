/**
 * @displayName Evaluator parity and move-choice check
 * @strategicPurpose Proves the TypeScript runtime computes the same logit as a float64 NumPy forward pass over the
 * exported weights (#127 parity), and that V picks the best action more often than the constant model where one
 * action is best (#126's move-choice check on untied decisions, coordinator ruling 2), before a rung searches with it.
 * @tacticalObjective Reads #126's pinned dataset manifest and records file (sha256 checked), takes the test split's
 * afterstates in file order, flattens them with the runtime layout, scores them in TypeScript, scores the same rows with
 * scripts/sims/py/reference_forward.py (float64, plus MLX float32 reported, not gated), and on every test decision
 * compares V's argmax with the constant's first action on decisions whose best label is unique. Writes one JSON report.
 *
 * Usage: tsx scripts/sims/evaluator-parity.ts --out data/pinned/sim-evaluators/v1-parity.json [--states 1000]
 *   [--python tmp/venv-train/bin/python]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { REPO_ROOT } from "../../src/paths.js";
import { branchManifestSchema, branchRecordSchema } from "../../src/sims/branches.js";
import { flattenState } from "../../src/sims/features.js";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import { codeCommit, isMain } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_VOCAB, EVALUATOR_MANIFESTS, loadLearnedInputs } from "./evaluator-hook.js";
import { readManifest } from "./evaluator.js";
import { untiedTop1 } from "./policy/search-core.js";

export const PARITY_TOLERANCE = 1e-5;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      evaluator: { type: "string", default: EVALUATOR_MANIFESTS[1] },
      dataset: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-datasets/branches-2026-11-01.manifest.json") },
      records: { type: "string", default: path.join(REPO_ROOT, "data/originals/sims/branches/2026-11-01/branches.jsonl.gz") },
      states: { type: "string", default: "1000" },
      python: { type: "string", default: process.env.SWU_SIMS_PYTHON ?? path.join(REPO_ROOT, "tmp/venv-train/bin/python") },
      out: { type: "string" },
    },
  });
  if (values.out === undefined) throw new Error("--out is required");
  const manifest = readManifest(values.evaluator);
  const dataset = branchManifestSchema.parse(JSON.parse(readFileSync(values.dataset, "utf8")));
  const gz = readFileSync(values.records);
  if (sha256Hex(gz) !== dataset.outputs.gzSha256) throw new Error(`${values.records}: sha256 ${sha256Hex(gz)}, manifest says ${dataset.outputs.gzSha256}`);
  if (sha256Hex(readFileSync(values.dataset)) !== manifest.dataset.manifestSha256) throw new Error(`${values.dataset} is not the dataset evaluator ${manifest.evaluatorVersion} was trained on`);
  // No engine is read here, so the view keys are never used: an empty table keeps the loader's vocabulary and layout checks.
  const li = loadLearnedInputs({ evaluator: values.evaluator, vocab: DEFAULT_VOCAB, viewKeys: { bridge: {}, byName: {}, tokenKeys: {}, ambiguousNames: 0 } });
  const test = dataset.source.splits.test;
  const lines = gunzipSync(gz).toString("utf8").split("\n").filter(Boolean);
  const p = progress("sims-evaluator-parity", { total: lines.length, everyN: 500 });
  const nStates = Number(values.states);
  const rows: { indices: number[]; values: number[] }[] = [];
  const decisions: { pred: number[]; label: number[] }[] = [];
  lines.forEach((line, i) => {
    const raw = JSON.parse(line) as { seed: number };
    if (raw.seed >= test.from && raw.seed < test.from + test.count) {
      const r = branchRecordSchema.parse(raw);
      const scored = r.legalActions.filter((a) => a.afterState !== null && a.mean !== null);
      const flat = scored.map((a) => flattenState(a.afterState as NonNullable<typeof a.afterState>, li.layout));
      for (const f of flat) if (rows.length < nStates) rows.push(f);
      if (scored.length >= 2) decisions.push({ pred: flat.map((f) => li.evaluator.logit(f)), label: scored.map((a) => a.mean as number) });
    }
    p.tick(i + 1);
  });
  const ts = rows.map((r) => li.evaluator.logit(r));
  const dir = path.join(REPO_ROOT, "tmp", "evaluator-parity");
  mkdirSync(dir, { recursive: true });
  const rowsFile = path.join(dir, "rows.jsonl");
  writeFileSync(rowsFile, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const weights = manifest.pinnedWeights === null ? null : path.join(REPO_ROOT, manifest.pinnedWeights.path);
  if (weights === null) throw new Error("parity reads the pinned weights copy; this manifest has none");
  const ref = JSON.parse(execFileSync(values.python, ["-I", path.join(REPO_ROOT, "scripts/sims/py/reference_forward.py"), "--weights", weights, "--rows", rowsFile], { encoding: "utf8", env: { ...process.env, TMPDIR: path.join(REPO_ROOT, "tmp") }, maxBuffer: 64 * 1024 * 1024 })) as { numpy: number[]; mlx: number[] | null; mlxError: string | null };
  if (ref.numpy.length !== ts.length) throw new Error(`reference scored ${ref.numpy.length} rows, expected ${ts.length}`);
  const maxDiff = (a: readonly number[]): number => a.reduce((m, v, i) => Math.max(m, Math.abs(v - ts[i])), 0);
  const numpyMax = maxDiff(ref.numpy);
  const choice = untiedTop1(decisions);
  const inputs = { evaluator: { version: manifest.evaluatorVersion, sha256: manifest.files[0].sha256 }, dataset: { manifestSha256: manifest.dataset.manifestSha256, gzSha256: dataset.outputs.gzSha256, test }, states: rows.length, layoutSha256: li.layout.sha256 };
  const body = {
    schemaVersion: 1,
    label: "bot play (D21): branch values under the named rung, test split only; parity is arithmetic, not play",
    inputs,
    parity: { tolerance: PARITY_TOLERANCE, states: rows.length, maxAbsDiffNumpyFloat64: numpyMax, pass: numpyMax <= PARITY_TOLERANCE },
    mlxFloat32: ref.mlx === null ? { available: false, error: ref.mlxError } : { available: true, maxAbsDiff: maxDiff(ref.mlx), gated: false },
    moveChoice: { rule: "untied top-1: decisions whose best action label is unique; the model's argmax V(afterstate) against the constant model's first action in code-point order (#126, coordinator ruling 2)", ...choice, pass: choice.model > choice.constant && choice.pValue !== null && choice.pValue < 0.05 },
  };
  const report = { ...body, replay: { inputHash: sha256Hex(canonicalJson(inputs)), codeCommit: codeCommit(), outputHash: sha256Hex(canonicalJson({ parity: body.parity, moveChoice: body.moveChoice })) } };
  mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  writeFileSync(path.resolve(values.out), `${JSON.stringify(report, null, 1)}\n`);
  p.done({ pass: body.parity.pass && body.moveChoice.pass });
  console.log(JSON.stringify({ parity: body.parity, mlxFloat32: body.mlxFloat32, moveChoice: body.moveChoice }, null, 1));
  process.exitCode = body.parity.pass && body.moveChoice.pass ? 0 : 1;
}

if (isMain(import.meta.url)) await main();
