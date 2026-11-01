/**
 * @displayName Evaluator hook for the driver
 * @strategicPurpose Connects engine state to the evaluator at a decision (#127) and measures where the time goes, for
 * the match observer that proves the in-loop throughput and for the learned rungs' leaves (#128).
 * @tacticalObjective Loads the evaluator, the pinned vocabulary and the state-view keys once, checks the three agree
 * (vocabulary contentSha256 and feature layout against the manifest), then per call extracts the viewer's state, encodes
 * and flattens it and runs the forward pass; optional per-stage microsecond timings stay in memory for a summary and
 * never enter a record. The view keys reach worker threads as a file the parent writes and each worker parses.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { featureLayout, flattenState, type FeatureLayout } from "../../src/sims/features.js";
import type { EngineGame } from "../../src/sims/engine.js";
import type { DecisionObserver } from "../../src/sims/policy.js";
import { extractStateView, stateViewKeysOf, type StateViewKeys } from "../../src/sims/state-view.js";
import { encodeState, SCALAR_COUNT, U } from "../../src/sims/state.js";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import { compileVocab, FIRST_CARD_INDEX, parseVocab, type CompiledVocab, type Vocab } from "../../src/sims/vocab.js";
import { loadEvaluator, readManifest, syntheticEvaluator, type Evaluator } from "./evaluator.js";

export const DEFAULT_VOCAB = path.join(REPO_ROOT, "data/pinned/sim-vocab/2026-10-30.r6.v2.json");
/** The release the vocabulary and the branch dataset resolved cards against (scripts/sims/sample-branches.ts DEFAULTS.release). */
export const VIEW_KEYS_RELEASE = path.join(REPO_ROOT, "data/runs/2026-10-30");
/** Evaluator versions a learned rung's `ev` parameter names. */
export const EVALUATOR_MANIFESTS: Readonly<Record<number, string>> = { 1: path.join(REPO_ROOT, "data/pinned/sim-evaluators/v1.json") };
export const LEARNED_ENV = { evaluator: "SIMS_EVALUATOR", vocab: "SIMS_VOCAB", viewKeys: "SIMS_VIEW_KEYS" } as const;
export const OBSERVER_NAMES = { "per-prompt": "evaluator-per-prompt", "per-action": "evaluator-per-action" } as const;

export interface LearnedInputs {
  evaluator: Evaluator;
  vocab: Vocab;
  compiled: CompiledVocab;
  layout: FeatureLayout;
  viewKeys: StateViewKeys;
}

/** `evaluator` is a manifest path, `v<n>` for a pinned version, or `synthetic:<widths>` for the latency gate. */
export function loadLearnedInputs(o: { evaluator: string; vocab?: string; viewKeys: StateViewKeys }): LearnedInputs {
  const vocab = parseVocab(JSON.parse(readFileSync(o.vocab ?? DEFAULT_VOCAB, "utf8")));
  const layout = featureLayout(SCALAR_COUNT, U, vocab.keys.length + FIRST_CARD_INDEX, vocab.contentSha256);
  let evaluator: Evaluator;
  if (o.evaluator.startsWith("synthetic:")) {
    evaluator = syntheticEvaluator(layout.width, layout.sha256, o.evaluator.slice("synthetic:".length).split(",").map(Number));
  } else {
    const named = /^v([1-9][0-9]*)$/.exec(o.evaluator);
    const manifest = named === null ? o.evaluator : EVALUATOR_MANIFESTS[Number(named[1])];
    if (manifest === undefined) throw new Error(`no pinned evaluator ${o.evaluator}`);
    const m = readManifest(manifest);
    if (m.vocabSha256 !== vocab.contentSha256) throw new Error(`vocabulary mismatch: evaluator ${m.evaluatorVersion} was trained on ${m.vocabSha256}, runtime vocabulary is ${vocab.contentSha256}`);
    evaluator = loadEvaluator(manifest, layout.sha256);
  }
  return { evaluator, vocab, compiled: compileVocab(vocab), layout, viewKeys: o.viewKeys };
}

export interface StageTimings {
  /** Microseconds per call: engine objects to RawStateView. */
  extract: number[];
  /** Microseconds per call: encodeState plus flattenState. */
  encode: number[];
  /** Microseconds per scored input: the forward pass. */
  forward: number[];
}

export interface StateScorer {
  /** The viewer's win logit for the live state; n copies score the same row n times (the per-action cost probe). */
  score(game: EngineGame, seat: 1 | 2, n?: number): number[];
  timings: StageTimings | null;
  calls: number;
}

export function createScorer(inputs: LearnedInputs, opts: { timed?: boolean } = {}): StateScorer {
  const timings: StageTimings | null = opts.timed === true ? { extract: [], encode: [], forward: [] } : null;
  const scorer: StateScorer = {
    timings,
    calls: 0,
    score(game, seat, n = 1) {
      const t0 = timings === null ? 0 : performance.now();
      const view = extractStateView(game, seat, inputs.viewKeys);
      const t1 = timings === null ? 0 : performance.now();
      const row = flattenState(encodeState(view, inputs.compiled), inputs.layout);
      const t2 = timings === null ? 0 : performance.now();
      const values: number[] = [];
      for (let c = 0; c < n; c++) values.push(inputs.evaluator.logit(row));
      if (timings !== null) {
        const t3 = performance.now();
        timings.extract.push((t1 - t0) * 1000);
        timings.encode.push((t2 - t1) * 1000);
        timings.forward.push(((t3 - t2) * 1000) / n);
      }
      scorer.calls += n;
      return values;
    },
  };
  return scorer;
}

export function evaluatorObserver(inputs: LearnedInputs, load: DecisionObserver["load"], scorer: StateScorer = createScorer(inputs)): DecisionObserver {
  return {
    version: inputs.evaluator.version,
    sha256: inputs.evaluator.sha256,
    load,
    score: (game, seat, nAnswers) => scorer.score(game, seat, load === "per-action" ? nAnswers : 1),
  };
}

export function buildViewKeys(engineCardKeys: Readonly<Record<string, string>>): StateViewKeys {
  return stateViewKeysOf(loadStore(VIEW_KEYS_RELEASE).cards, engineCardKeys);
}

const viewKeysSchema = z.strictObject({
  bridge: z.record(z.string(), z.string()),
  byName: z.record(z.string(), z.string()),
  tokenKeys: z.record(z.string(), z.string()),
  ambiguousNames: z.int().nonnegative(),
});

/** Written by the parent from already-parsed sources; parsed again by each worker that reads it. */
export function writeViewKeysFile(keys: StateViewKeys): string {
  const body = canonicalJson(keys);
  const file = path.join(REPO_ROOT, "tmp", `sims-view-keys-${sha256Hex(body).slice(0, 16)}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

export const readViewKeysFile = (file: string): StateViewKeys => viewKeysSchema.parse(JSON.parse(readFileSync(file, "utf8")));
