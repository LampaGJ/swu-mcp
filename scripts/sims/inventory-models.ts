/**
 * @displayName Existing-model inventory walk
 * @strategicPurpose Pins what models already exist, by hash and provenance, before anything new is trained, and fences
 * every human-derived model under D22 by default.
 * @tacticalObjective Walks the volume, hashes each model file, classifies it from pick-only reads, optionally checks
 * loader parity, writes the committed manifest, README and doc list, and puts recorded metrics in a git-ignored report.
 *
 * Usage: pnpm sims:inventory [--root /Volumes/Models/swu] [--producer /Volumes/Models/swu-data] [--parity]
 *   [--report data/originals/sims/model-inventory] (any git-ignored directory; a linked worktree's data/originals is a
 *   symlink into the main checkout, so a worktree run passes a worktree-local ignored path such as reports/sims/model-inventory)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "../../src/paths.js";
import { parseForest, predictForest } from "../../src/sims/forest.js";
import {
  type ManifestEntry,
  type ModelManifest,
  modelManifestSchema,
  sessionMetadataPick,
  trainingRunRowPick,
} from "../../src/sims/model-manifest.js";
import { parseXgb } from "../../src/sims/xgb.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { seededRandom } from "../bench/stats.js";
import { codeCommit } from "../lib/code-commit.js";
import { forestParity, harnessCopy, hasVenv, xgbParity } from "./model-parity.js";

/** Reserved for the fresh-batch scoring positions; every training and branch-sampling seed range must avoid it. */
export const EVALUATION_SEED_RANGE = { from: 9_000_000, count: 2_000 } as const;
const HUMAN_DIRS: Readonly<Record<string, "human-games" | "human-inferred">> = {
  "models/human-trained/": "human-games",
  "models/bootstrap-trained/": "human-inferred",
  "models/filtered-trained/": "human-inferred",
  "models/strict-trained/": "human-inferred",
};
const HUMAN_ROLLOUT = /models\/(human|bootstrap|filtered|strict)-trained\//;
/** Training-data directories whose deck sources are proven free of Karabast lists. Empty: no session metadata names a deck source, so no bot model is clear until a cited proof is added here. */
const PROVEN_DECK_DIRS: ReadonlySet<string> = new Set<string>();
const SESSION_FILE = /^iter-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-metadata\.json$/;
const ITER_MODEL = /model-iter-(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.json$/;

export interface InventoryOptions {
  root: string;
  producer: string;
  out: string;
  doc: string;
  report: string;
  parity: boolean;
}

const rel = (root: string, p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const layoutOf = (n: number | null): ManifestEntry["featureLayout"] =>
  n === 500 ? "core500" : n === 595 ? "core500+plugins" : n === 360 ? "legacy360" : n === 583 ? "phase3-583" : "unknown";
const objectiveOf = (s: string | null | undefined): ManifestEntry["objective"] =>
  s === "binary_win" || s === "binary:logistic"
    ? "binary_win"
    : s === "q_value"
      ? "q_value"
      : s === "loss_prevention"
        ? "loss_prevention"
        : "unknown";

function git(args: string[]): string | null {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function assertIgnored(file: string): void {
  if (!path.resolve(file).startsWith(`${REPO_ROOT}/`)) return;
  if (git(["-C", REPO_ROOT, "check-ignore", "-q", path.relative(REPO_ROOT, file)]) === null)
    throw new Error(`${file} must be git-ignored before a metric is written to it`);
}

export function runInventory(o: InventoryOptions): ModelManifest {
  const runsFile = path.join(o.root, "manifests/training-runs.jsonl");
  const lines = readFileSync(runsFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  const rows: z.infer<typeof trainingRunRowPick>[] = [];
  const recorded: Record<string, unknown> = {};
  let badRows = 0;
  lines.forEach((line, i) => {
    let raw: unknown = null;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = null;
    }
    const parsed = trainingRunRowPick.safeParse(raw);
    if (!parsed.success) {
      badRows += 1;
      console.error(`training-runs.jsonl line ${i + 1}: does not parse (${parsed.error.issues.map((x) => x.path.join(".")).join(", ")})`);
      return;
    }
    rows.push(parsed.data);
    // Pick-only, like trainingRunRowPick: only the metrics block survives, bound for the git-ignored report.
    const metrics = z.object({ metrics: z.record(z.string(), z.number().nullable()).optional() }).safeParse(raw);
    recorded[parsed.data.id] = {
      model: rel(o.root, parsed.data.model_output),
      metrics: metrics.success ? (metrics.data.metrics ?? null) : null,
    };
  });
  const rowByOutput = new Map(rows.map((r) => [r.model_output, r]));

  const listed = (dir: string, keep: (name: string) => boolean): string[] =>
    existsSync(path.join(o.root, dir))
      ? readdirSync(path.join(o.root, dir), { withFileTypes: true })
          .filter((d) => d.isFile() && !d.name.startsWith(".") && keep(d.name))
          .map((d) => `${dir}/${d.name}`)
      : [];
  const modelDirs = existsSync(path.join(o.root, "models"))
    ? readdirSync(path.join(o.root, "models"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => `models/${d.name}`)
    : [];
  const paths = [
    ...new Set([
      ...modelDirs.flatMap((d) => listed(d, () => true)),
      ...listed("iterative-training/models", (n) => n.endsWith(".json")),
      ...(existsSync(path.join(o.root, "iterative-training/checkpoint.json")) ? ["iterative-training/checkpoint.json"] : []),
      ...rows.map((r) => rel(o.root, r.model_output)),
    ]),
  ].sort(compareCodePoints);

  const sessionDir = path.join(o.root, "iterative-training/data");
  const sessions = existsSync(sessionDir)
    ? readdirSync(sessionDir)
        .map((n) => SESSION_FILE.exec(n))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ iter: Number(m[1]), ts: m[2], file: path.join(sessionDir, m[0]) }))
    : [];
  const metadataFor = (p: string, row: z.infer<typeof trainingRunRowPick> | undefined): string[] => {
    const m = ITER_MODEL.exec(p);
    if (m !== null) {
      const match = sessions
        .filter((s) => s.iter === Number(m[1]) && compareCodePoints(s.ts, m[2]) <= 0)
        .sort((a, b) => compareCodePoints(b.ts, a.ts))[0];
      return match === undefined ? [] : [match.file];
    }
    return (row?.training_files ?? []).map((tf) => tf.replace(/\.jsonl$/, "-metadata.json")).filter((f) => existsSync(f));
  };
  const producerHead = git(["-C", o.producer, "rev-parse", "HEAD"]);
  const harness = path.join(o.producer, "simulation");
  const parityDir = o.parity && producerHead !== null ? harnessCopy(harness, producerHead) : null;
  const xgbParityRuns = o.parity && hasVenv();
  if (o.parity && !xgbParityRuns)
    console.error(
      "sims:inventory: no .venv (scripts/sims/py/requirements.txt), so XGBoost Booster parity is not run; those entries carry parity not-run",
    );

  const entries: ManifestEntry[] = paths.map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(o.root, p);
    const row = rowByOutput.get(abs);
    const humanDir = Object.keys(HUMAN_DIRS).find((d) => p.startsWith(d));
    const name = path.basename(p);
    const base = { path: p, runId: row?.id ?? null, sha256: null, bytes: null, numFeatures: null } as const;
    const producer: ManifestEntry["producer"] =
      producerHead === null
        ? null
        : p === "models/human-trained/xgboost-model.json"
          ? { project: "swu-data/simulation", script: "python/train_human_combined.py", repoCommit: producerHead, confidence: "confirmed" }
          : humanDir !== undefined
            ? { project: "swu-data/simulation", script: null, repoCommit: producerHead, confidence: "inferred" }
            : p.startsWith("iterative-training/")
              ? {
                  project: "swu-data/simulation",
                  script: "src/ml/iterative-training-cli.ts",
                  repoCommit: producerHead,
                  confidence: "confirmed",
                }
              : row !== undefined
                ? { project: "swu-data/simulation", script: "src/ml/train-cli.ts", repoCommit: producerHead, confidence: "inferred" }
                : null;

    const metas = humanDir === undefined ? metadataFor(p, row).map((f) => sessionMetadataPick.parse(readJson(f))) : [];
    const humanRollout = metas.some((m) => HUMAN_ROLLOUT.test(m.config?.mlRollout ?? "") || HUMAN_ROLLOUT.test(m.rolloutPolicy ?? ""));
    const trainingDirs = (row?.training_files ?? []).map((tf) => path.dirname(rel(o.root, tf)));
    const provenance: ManifestEntry["provenance"] =
      humanDir !== undefined
        ? HUMAN_DIRS[humanDir]
        : humanRollout
          ? "bot-games-human-rollout"
          : metas.length === 0
            ? "unknown"
            : trainingDirs.length > 0 && trainingDirs.every((d) => PROVEN_DECK_DIRS.has(d))
              ? "bot-games"
              : "bot-games-unproven-decks";
    const d22 = provenance === "bot-games" ? "clear" : "quarantined";
    const common = { ...base, producer, provenance, d22 } as const;

    if (!existsSync(abs))
      return {
        ...common,
        format: "other",
        objective: objectiveOf(row?.hyperparams?.objective),
        featureLayout: "unknown",
        verdict: "missing",
        reason: "file-missing",
        parity: "not-applicable",
      };
    const bytes = readFileSync(abs);
    const sha256 = sha256Hex(bytes);
    const known = { ...common, sha256, bytes: bytes.length, parity: "not-applicable" } as const;
    if (name === "checkpoint.json")
      return {
        ...known,
        format: "checkpoint-json",
        objective: "unknown",
        featureLayout: "unknown",
        verdict: "not-scored",
        reason: "format-not-scorable",
      };
    if (name === "training-summary.json")
      return {
        ...known,
        format: "summary-json",
        objective: "unknown",
        featureLayout: "unknown",
        verdict: "not-scored",
        reason: "format-not-scorable",
      };
    if (name.endsWith(".npz"))
      return {
        ...known,
        format: "mlx-npz",
        objective: "unknown",
        featureLayout: "unknown",
        verdict: "not-scored",
        reason: "format-not-scorable",
      };

    const raw = JSON.parse(bytes.toString("utf8")) as unknown;
    if (name === "xgboost-model.json") {
      const model = parseXgb(raw);
      const entry = {
        ...known,
        format: "xgboost-json",
        objective: "binary_win",
        numFeatures: model.numFeature,
        featureLayout: layoutOf(model.numFeature),
      } as const;
      if (!xgbParityRuns) return { ...entry, verdict: "not-scored", reason: "awaiting-fresh-batch", parity: "not-run" };
      if (!xgbParity(abs, sha256, model).ok) return { ...entry, verdict: "unreusable", reason: "loader-parity-failed", parity: "failed" };
      return { ...entry, verdict: "not-scored", reason: "awaiting-fresh-batch", parity: "passed" };
    }
    const forest = parseForest(raw);
    const objective = objectiveOf(row?.hyperparams?.objective ?? forest.objective);
    const entry = {
      ...known,
      format: "rf-json",
      objective,
      numFeatures: forest.numFeatures,
      featureLayout: layoutOf(forest.numFeatures),
      parity: "not-run",
    } as const;
    const probes = Array.from({ length: 100 }, (_, i) => {
      const rnd = seededRandom(`constant|${sha256}|${i}`);
      return predictForest(
        forest,
        Array.from({ length: forest.numFeatures }, () => rnd() * 30),
      );
    });
    if (probes.every((v) => v === probes[0])) return { ...entry, verdict: "unreusable", reason: "constant-prediction" };
    if (objective !== "binary_win") return { ...entry, verdict: "not-scored", reason: "different-target" };
    if (entry.featureLayout === "unknown") return { ...entry, verdict: "unreusable", reason: "feature-schema-unrecoverable" };
    if (parityDir === null) return { ...entry, verdict: "not-scored", reason: "awaiting-fresh-batch" };
    if (!forestParity(parityDir, abs, sha256, forest).ok)
      return { ...entry, verdict: "unreusable", reason: "loader-parity-failed", parity: "failed" };
    return { ...entry, verdict: "not-scored", reason: "awaiting-fresh-batch", parity: "passed" };
  });

  const present = rows.filter((r) => existsSync(r.model_output)).length;
  const body = {
    schemaVersion: 1 as const,
    root: "SWU_MODELS_ROOT" as const,
    producerRepo: { path: "swu-data", head: producerHead },
    counts: {
      entries: entries.length,
      manifestRows: lines.length,
      manifestOutputsPresent: present,
      manifestOutputsMissing: rows.length - present,
      badManifestRows: badRows,
      clear: entries.filter((e) => e.d22 === "clear").length,
      quarantined: entries.filter((e) => e.d22 === "quarantined").length,
    },
    evaluationSeedRange: { ...EVALUATION_SEED_RANGE },
    entries,
  };
  const manifest = modelManifestSchema.parse({
    ...body,
    replay: {
      inputHash: sha256Hex(
        canonicalJson({
          files: entries.map((e) => [e.path, e.sha256]),
          runs: sha256Hex(readFileSync(runsFile)),
          proven: [...PROVEN_DECK_DIRS].sort(compareCodePoints),
        }),
      ),
      codeCommit: codeCommit(["scripts/sims/inventory-models.ts", "scripts/sims/model-parity.ts", "src/sims"]),
      outputHash: sha256Hex(canonicalJson(body)),
    },
  });

  mkdirSync(o.out, { recursive: true });
  writeFileSync(path.join(o.out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  const line = (e: ManifestEntry): string =>
    `- \`${e.path}\`: ${e.format}, ${e.objective}, layout ${e.featureLayout}, provenance ${e.provenance}, D22 ${e.d22}, verdict ${e.verdict} (${e.reason}), parity ${e.parity}, sha256 ${e.sha256 === null ? "none" : `\`${e.sha256.slice(0, 12)}\``}`;
  const reused = entries.filter((e) => e.verdict === "reusable");
  writeFileSync(
    path.join(o.out, "README.md"),
    [
      "# Existing models (generated by `pnpm sims:inventory`; do not edit)",
      "",
      "Weights stay on /Volumes/Models/swu; this directory holds hashes and provenance only. Metrics live in the git-ignored local report.",
      "",
      "## Reused",
      "",
      ...(reused.length === 0 ? ["- none yet: no model has passed fresh-batch scoring"] : reused.map(line)),
      "",
      "## Rejected or not yet scored",
      "",
      ...entries.filter((e) => e.verdict !== "reusable").map(line),
      "",
    ].join("\n"),
  );
  if (existsSync(o.doc)) {
    const doc = readFileSync(o.doc, "utf8");
    const begin = "<!-- inventory:begin -->";
    const end = "<!-- inventory:end -->";
    if (!doc.includes(begin) || !doc.includes(end)) throw new Error(`${o.doc} lacks the ${begin} / ${end} markers`);
    writeFileSync(
      o.doc,
      `${doc.slice(0, doc.indexOf(begin) + begin.length)}\n${entries.map(line).join("\n")}\n${doc.slice(doc.indexOf(end))}`,
    );
  }
  assertIgnored(o.report);
  mkdirSync(o.report, { recursive: true });
  writeFileSync(path.join(o.report, "recorded-metrics.json"), `${JSON.stringify(recorded, null, 1)}\n`);
  return manifest;
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: process.env.SWU_MODELS_ROOT ?? "/Volumes/Models/swu" },
      producer: { type: "string", default: "/Volumes/Models/swu-data" },
      parity: { type: "boolean", default: false },
      report: { type: "string", default: path.join(REPO_ROOT, "data/originals/sims/model-inventory") },
    },
  });
  const manifest = runInventory({
    root: values.root,
    producer: values.producer,
    parity: values.parity,
    out: path.join(REPO_ROOT, "data/pinned/sim-models"),
    doc: path.join(REPO_ROOT, "docs/research/existing-models-inventory.md"),
    report: path.resolve(values.report),
  });
  console.log(JSON.stringify({ counts: manifest.counts, outputHash: manifest.replay.outputHash }));
  if (manifest.counts.badManifestRows > 0) process.exit(1);
}
