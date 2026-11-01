/**
 * @displayName Learned rung and evaluator observer registration
 * @strategicPurpose Puts the learned rungs (#128) and the evaluator observer (#127) into the typed driver's registries
 * from scripts/, so nothing under src/ imports a model runtime (D1) and every worker thread builds the same policies.
 * @tacticalObjective The parent loads the inputs once to fail fast (weights hash, layout, vocabulary), writes the
 * state-view keys to a file and names everything in SIMS_* variables; the preload in each worker reads them and
 * registers the same chains. A learned rung's header inputs carry the evaluator's and the vocabulary's sha256.
 */
import { parsePolicySpec, specName } from "../../../src/sims/policies/index.js";
import type { CardTables } from "../../../src/sims/policies/tables.js";
import { inputsOf } from "../../../src/sims/policies/typed-adapter.js";
import type { DecisionObserver } from "../../../src/sims/policy.js";
import type { StateViewKeys } from "../../../src/sims/state-view.js";
import { buildViewKeys, createScorer, evaluatorObserver, LEARNED_ENV, loadLearnedInputs, OBSERVER_NAMES, readViewKeysFile, writeViewKeysFile, type LearnedInputs } from "../evaluator-hook.js";
import { learnedSearchPolicy } from "./search.js";

export const isLearned = (name: string): boolean => {
  try {
    return parsePolicySpec(name).kind === "learned";
  } catch {
    return false;
  }
};

const cache = new Map<string, LearnedInputs>();
function inputsFor(evaluator: string, viewKeys: StateViewKeys, vocab?: string): LearnedInputs {
  const key = `${evaluator}|${vocab ?? ""}`;
  let li = cache.get(key);
  if (li === undefined) {
    li = loadLearnedInputs({ evaluator, vocab, viewKeys });
    cache.set(key, li);
  }
  return li;
}

export function registerLearned(registry: Record<string, () => unknown>, makeChain: (ps: unknown[]) => unknown, names: readonly string[], tables: CardTables, o: { viewKeys: StateViewKeys; vocab?: string }): void {
  for (const name of names) {
    const spec = parsePolicySpec(name);
    if (spec.kind !== "learned") continue;
    const li = inputsFor(`v${spec.params.ev}`, o.viewKeys, o.vocab);
    const inputs = { ...inputsOf(spec, tables), evaluator: li.evaluator.sha256, vocab: li.vocab.contentSha256 };
    const make = () => makeChain([learnedSearchPolicy({ rung: spec.rung, params: spec.params, tables, inputs, scorer: createScorer(li), evaluatorSha256: li.evaluator.sha256 })]);
    registry[name] = make;
    registry[specName(spec)] = make;
  }
}

export function registerObservers(observers: Record<string, () => DecisionObserver>, o: { evaluator: string; vocab?: string; viewKeys: StateViewKeys }): void {
  const li = inputsFor(o.evaluator, o.viewKeys, o.vocab);
  for (const load of ["per-prompt", "per-action"] as const) observers[OBSERVER_NAMES[load]] = () => evaluatorObserver(li, load);
}

/**
 * Parent side: loads (and so verifies) what the learned names and the evaluator flag need, then names them in the
 * environment the worker preload reads. Returns the view keys, or null when nothing learned is asked for.
 */
export function prepareLearned(o: { names: readonly string[]; engineCardKeys: Readonly<Record<string, string>>; evaluator?: string; vocab?: string }): StateViewKeys | null {
  const learned = o.names.filter(isLearned);
  if (learned.length === 0 && o.evaluator === undefined) return null;
  const viewKeys = buildViewKeys(o.engineCardKeys);
  process.env[LEARNED_ENV.viewKeys] = writeViewKeysFile(viewKeys);
  if (o.vocab !== undefined) process.env[LEARNED_ENV.vocab] = o.vocab;
  if (o.evaluator !== undefined) {
    process.env[LEARNED_ENV.evaluator] = o.evaluator;
    inputsFor(o.evaluator, viewKeys, o.vocab);
  }
  for (const name of learned) inputsFor(`v${(parsePolicySpec(name) as { params: { ev: number } }).params.ev}`, viewKeys, o.vocab);
  return viewKeys;
}

/** Worker side (the preload): registers what the parent named in the environment. */
export function registerFromEnv(registry: Record<string, () => unknown>, makeChain: (ps: unknown[]) => unknown, names: readonly string[], tables: CardTables, observers: Record<string, () => DecisionObserver>): void {
  const file = process.env[LEARNED_ENV.viewKeys];
  if (file === undefined) return;
  const viewKeys = readViewKeysFile(file);
  const vocab = process.env[LEARNED_ENV.vocab];
  registerLearned(registry, makeChain, names, tables, { viewKeys, vocab });
  const evaluator = process.env[LEARNED_ENV.evaluator];
  if (evaluator !== undefined) registerObservers(observers, { evaluator, vocab, viewKeys });
}
