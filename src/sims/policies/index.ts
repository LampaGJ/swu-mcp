import { createHash } from "node:crypto";
import { compareCodePoints } from "../../swu/canonical.js";
import { makeRandomPolicy } from "./random.js";
import { HORIZON, LOOKAHEAD_PILOT_KEYS, MC_LENGTH, MC_PARAMS, MC_PLAYOUT, MC_VERSION, RUNG3_PARAMS, RUNG3_VERSION, type LookaheadParams, type MonteCarloParams } from "./lookahead.js";
import { makeRulePolicy, RULE_PILOT_KEYS, RUNG1_PARAMS, type RuleParams } from "./rules.js";
import type { CardTables } from "./tables.js";
import type { BotPolicy } from "./types.js";

/**
 * @displayName Bot policy registry
 * @strategicPurpose One place that turns a policy name on a command line into a versioned, parameter-hashed bot, so
 * every result names the rung, version and parameters it was played with.
 * @tacticalObjective Parses `random`, `rung1`, `rung2[:mu=..,lambda=..,...]` and `rung3[:k=..,horizon=reply|round,wBase=..,...]`
 * (rung 3 has a driver form only, src/sims/policies/rung3.ts) into policies and hashes
 * their parameters; `rung0` names the typed driver's own random rung and `greedy-hash` the spike's name-hash baseline (typed-adapter.ts).
 * `rung3v:k=..,ev=v1` and `rung4:d=..,k=..,m=..,ev=v1` are the learned rungs (#128): this file only names and hashes
 * them; their policy lives in scripts/sims/policy/ and is registered from there, so nothing under src/ runs a model (D1).
 */

export const RUNG1_VERSION = "1";
export const RUNG2_VERSION = "1";

export type PolicySpec =
  | { kind: "random-spike" }
  | { kind: "greedy-hash" }
  | { kind: "random" }
  | { kind: "rules"; rung: 1 | 2; params: RuleParams }
  | { kind: "lookahead"; params: LookaheadParams }
  | { kind: "montecarlo"; params: MonteCarloParams }
  | { kind: "learned"; rung: 3 | 4; params: LearnedParams };

export const LEARNED_VERSION = "1";

/** Learned rung parameters (#128), numbers only so the params hash stays a number map. */
export interface LearnedParams {
  /** Candidates: the ranking pilot's top k by exclusion (Pass and Claim Initiative are added when legal). */
  k: number;
  /** Opponent replies per candidate (rung 4); 0 at rung 3. */
  m: number;
  /** Determinizations (rung 4, at least 2); 1 at rung 3, which reads the true state. */
  d: number;
  /** Evaluator version: 1 is data/pinned/sim-evaluators/v1.json. */
  ev: number;
  maxTrialDecisions: number;
  /**
   * Leaf: absent or 0 at the next main-action prompt (where #125 took its afterstates); 1 after the pilots play on to
   * the end of the action phase (rung 3's round horizon); 2 on through the regroup phase to the next round's first main action.
   */
  horizon?: number;
  /** 1: Pass is a candidate only when the pilot itself passes (V at a leaf rates unspent cards and resources above their use, D97). */
  noPass?: number;
  /** The ranking and trial pilot is rung 1 with these switches on (D92, D95): rung 2 was never promoted (D79). */
  sacGuard: number;
  handCap: number;
  /** 1: every leaf scores 0, so the choice is the ranking pilot's own (the neutrality test). */
  stub?: number;
}

export const RUNG3V_PARAMS: LearnedParams = { k: 8, m: 0, d: 1, ev: 1, maxTrialDecisions: 400, sacGuard: 1, handCap: 1 };
/** d 3, k 5, m 2 is #128's design point; measured to fit a 2,640-game calibration run in about 1.1 hours on 12 workers (D97). */
export const RUNG4_PARAMS: LearnedParams = { k: 5, m: 2, d: 3, ev: 1, maxTrialDecisions: 400, sacGuard: 1, handCap: 1 };

function parseLearned(rung: 3 | 4, text: string, rest: string | undefined): PolicySpec {
  const params: LearnedParams = { ...(rung === 3 ? RUNG3V_PARAMS : RUNG4_PARAMS) };
  const allowed = rung === 3 ? ["k", "maxTrialDecisions"] : ["k", "m", "d", "maxTrialDecisions"];
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    const ev = /^v([1-9][0-9]*)$/.exec(v ?? "");
    if (k === "ev" && ev !== null) params.ev = Number(ev[1]);
    else if (k === "stub" && v === "1") params.stub = 1;
    else if (k === "stub" && v === "0") delete params.stub;
    else if (k === "horizon" && v === "round") params.horizon = 1;
    else if (k === "horizon" && v === "next") params.horizon = 2;
    else if (k === "horizon" && v === "reply") delete params.horizon;
    else if (k === "noPass" && v === "1") params.noPass = 1;
    else if (k === "noPass" && v === "0") delete params.noPass;
    else if (allowed.includes(k) && /^[0-9]+$/.test(v ?? "")) (params as unknown as Record<string, number>)[k] = Number(v);
    else throw new Error(`bad policy parameter ${kv} in ${text}${rung === 3 && (k === "d" || k === "m") ? " (rung3v reads the true state: no determinizations, no replies)" : ""}`);
  }
  if (params.k < 1) throw new Error(`${text}: k must be at least 1`);
  if (rung === 4 && params.d < 2) throw new Error(`${text}: rung 4 needs at least 2 determinizations`);
  if (rung === 4 && params.m < 1) throw new Error(`${text}: rung 4 needs at least 1 reply`);
  return { kind: "learned", rung, params };
}

/** Canonical learned name: k (and d, m at rung 4) and ev always, then any other parameter off its default. */
function learnedName(rung: 3 | 4, p: LearnedParams): string {
  const def = rung === 3 ? RUNG3V_PARAMS : RUNG4_PARAMS;
  const parts = rung === 3 ? [`k=${p.k}`] : [`d=${p.d}`, `k=${p.k}`, `m=${p.m}`];
  parts.push(`ev=v${p.ev}`);
  if (p.horizon === 1) parts.push("horizon=round");
  if (p.horizon === 2) parts.push("horizon=next");
  if (p.noPass === 1) parts.push("noPass=1");
  if (p.maxTrialDecisions !== def.maxTrialDecisions) parts.push(`maxTrialDecisions=${p.maxTrialDecisions}`);
  if (p.stub === 1) parts.push("stub=1");
  return `${rung === 3 ? "rung3v" : "rung4"}:${parts.join(",")}`;
}

const MC_TUNABLE = ["n", "cap", "sub", "depth", "maxPlayoutDecisions", "determinize", "wBase", "wBoard", "wHand", "wResources", "wReady", "wScore"] as const;

function parseMonteCarlo(text: string, rest: string | undefined): PolicySpec {
  const params: MonteCarloParams = { ...MC_PARAMS };
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (k === "length" && (v === "game" || v === "round")) params.length = MC_LENGTH[v];
    else if (k === "playout" && (v === "rung0" || v === "rung1")) params.playout = MC_PLAYOUT[v];
    else if ((MC_TUNABLE as readonly string[]).includes(k) && Number.isFinite(Number(v))) (params as unknown as Record<string, number>)[k] = Number(v);
    else throw new Error(`bad policy parameter ${kv} in ${text}`);
  }
  if (!Number.isInteger(params.n) || params.n < 1) throw new Error(`rung3mc needs an integer n >= 1 in ${text}`);
  return { kind: "montecarlo", params };
}

/** Canonical flat Monte Carlo name: length and playout first, then every other parameter that differs from MC_PARAMS. */
function monteCarloName(p: MonteCarloParams): string {
  const parts: string[] = [];
  if (p.length !== MC_PARAMS.length) parts.push(`length=${p.length === MC_LENGTH.game ? "game" : "round"}`);
  if (p.playout !== MC_PARAMS.playout) parts.push(`playout=${p.playout === MC_PLAYOUT.rung1 ? "rung1" : "rung0"}`);
  for (const k of MC_TUNABLE) if (p[k] !== MC_PARAMS[k]) parts.push(`${k}=${p[k]}`);
  return parts.length === 0 ? "rung3mc" : `rung3mc:${parts.join(",")}`;
}

const RUNG3_TUNABLE = ["k", "wBase", "wBoard", "wHand", "wResources", "wReady", "wScore", "maxTrialDecisions"] as const;
/** Rung 3 pilot switches (#174): rung 1's switches for its ranking and rollouts, then its own. */
const RUNG3_PILOT_KEYS = [...RULE_PILOT_KEYS, ...LOOKAHEAD_PILOT_KEYS] as const;

/** A pilot switch is 0 or 1; it enters the params (and so the params hash and the name) only when it is 1. */
function setSwitch(params: Record<string, number>, k: string, v: string, text: string): void {
  if (v !== "0" && v !== "1") throw new Error(`pilot switch ${k} takes 0 or 1 in ${text}`);
  if (v === "1") params[k] = 1;
  else delete params[k];
}

const switchSuffix = (p: Readonly<Record<string, number | undefined>>, keys: readonly string[]): string[] => keys.filter((k) => p[k] === 1).map((k) => `${k}=1`);

function parseLookahead(text: string, rest: string | undefined): PolicySpec {
  const params: LookaheadParams = { ...RUNG3_PARAMS };
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (k === "horizon" && (v === "reply" || v === "round")) params.horizon = HORIZON[v];
    else if ((RUNG3_PILOT_KEYS as readonly string[]).includes(k)) setSwitch(params as unknown as Record<string, number>, k, v, text);
    else if ((RUNG3_TUNABLE as readonly string[]).includes(k) && Number.isFinite(Number(v))) (params as unknown as Record<string, number>)[k] = Number(v);
    else throw new Error(`bad policy parameter ${kv} in ${text}`);
  }
  if (!Number.isInteger(params.k) || params.k < 1) throw new Error(`rung3 needs an integer k >= 1 in ${text}`);
  return { kind: "lookahead", params };
}

/** Canonical rung 3 name: every parameter that differs from RUNG3_PARAMS, in RUNG3_TUNABLE order, horizon first. */
function lookaheadName(p: LookaheadParams): string {
  const parts: string[] = [];
  if (p.horizon !== RUNG3_PARAMS.horizon) parts.push(`horizon=${p.horizon === HORIZON.reply ? "reply" : "round"}`);
  for (const k of RUNG3_TUNABLE) if (p[k] !== RUNG3_PARAMS[k]) parts.push(`${k}=${p[k]}`);
  parts.push(...switchSuffix(p as unknown as Record<string, number>, RUNG3_PILOT_KEYS));
  return parts.length === 0 ? "rung3" : `rung3:${parts.join(",")}`;
}

export function parsePolicySpec(text: string): PolicySpec {
  const [name, rest] = text.split(":");
  if (name === "random-spike" || name === "rung0") return { kind: "random-spike" };
  if (name === "greedy-hash" || name === "greedy") return { kind: "greedy-hash" };
  if (name === "random") return { kind: "random" };
  if (name === "rung3") return parseLookahead(text, rest);
  if (name === "rung3mc") return parseMonteCarlo(text, rest);
  if (name === "rung3v") return parseLearned(3, text, rest);
  if (name === "rung4") return parseLearned(4, text, rest);
  if (name !== "rung1" && name !== "rung2") throw new Error(`unknown policy ${text}`);
  const params: RuleParams = { ...RUNG1_PARAMS };
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (name === "rung1" && (RULE_PILOT_KEYS as readonly string[]).includes(k)) {
      setSwitch(params as unknown as Record<string, number>, k, v, text);
      continue;
    }
    if (!(k in params) || !Number.isFinite(Number(v))) throw new Error(`bad policy parameter ${kv} in ${text}`);
    (params as unknown as Record<string, number>)[k] = Number(v);
  }
  if (name === "rung1" && (params.mu !== 0 || params.lambda !== 0)) throw new Error("rung1 takes mu = lambda = 0; use rung2");
  return { kind: "rules", rung: name === "rung1" ? 1 : 2, params };
}

export const specName = (s: PolicySpec): string =>
  s.kind === "learned"
    ? learnedName(s.rung, s.params)
    : s.kind === "montecarlo"
    ? monteCarloName(s.params)
    : s.kind === "lookahead"
    ? lookaheadName(s.params)
    : s.kind === "rules"
    ? s.rung === 2
      ? `rung2:mu=${s.params.mu},lambda=${s.params.lambda}`
      : ((sw) => (sw.length === 0 ? "rung1" : `rung1:${sw.join(",")}`))(switchSuffix(s.params as unknown as Record<string, number>, RULE_PILOT_KEYS))
    : s.kind;

export function paramsSha256(params: Readonly<Record<string, number>>): string {
  const canon = JSON.stringify(Object.fromEntries(Object.entries(params).sort(([a], [b]) => compareCodePoints(a, b))));
  return createHash("sha256").update(canon).digest("hex");
}

export function policyOf(spec: PolicySpec, tables: CardTables): BotPolicy | null {
  if (spec.kind === "random") return makeRandomPolicy();
  if (spec.kind !== "rules") return null;
  return spec.rung === 1
    ? makeRulePolicy({ id: "rung1-rules", version: RUNG1_VERSION, rung: 1, params: spec.params })
    : makeRulePolicy({ id: "rung2-pairs", version: RUNG2_VERSION, rung: 2, params: spec.params, pairs: tables });
}

export function policyHeader(spec: PolicySpec): { spec: string; id: string; version: string; rung: number; params: Record<string, number>; paramsSha256: string } {
  if (spec.kind === "learned") {
    const params = { ...spec.params } as unknown as Record<string, number>;
    return { spec: specName(spec), id: spec.rung === 3 ? "rung3-value" : "rung4-search", version: LEARNED_VERSION, rung: spec.rung, params, paramsSha256: paramsSha256(params) };
  }
  if (spec.kind === "montecarlo") {
    const params = { ...spec.params } as unknown as Record<string, number>;
    return { spec: specName(spec), id: "rung3-flat-mc", version: MC_VERSION, rung: 3, params, paramsSha256: paramsSha256(params) };
  }
  if (spec.kind === "lookahead") {
    const params = { ...spec.params } as unknown as Record<string, number>;
    return { spec: specName(spec), id: "rung3-lookahead", version: RUNG3_VERSION, rung: 3, params, paramsSha256: paramsSha256(params) };
  }
  if (spec.kind === "rules") {
    const params = { ...spec.params };
    return { spec: specName(spec), id: spec.rung === 1 ? "rung1-rules" : "rung2-pairs", version: spec.rung === 1 ? RUNG1_VERSION : RUNG2_VERSION, rung: spec.rung, params, paramsSha256: paramsSha256(params) };
  }
  const id = spec.kind === "greedy-hash" ? "greedy-hash" : "rung0-random";
  return { spec: specName(spec), id, version: spec.kind === "greedy-hash" ? "spike-9f224cf" : "1", rung: 0, params: {}, paramsSha256: paramsSha256({}) };
}
