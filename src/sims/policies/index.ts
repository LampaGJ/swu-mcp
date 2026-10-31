import { createHash } from "node:crypto";
import { compareCodePoints } from "../../swu/canonical.js";
import { makeRandomPolicy } from "./random.js";
import { HORIZON, MC_LENGTH, MC_PARAMS, MC_PLAYOUT, MC_VERSION, RUNG3_PARAMS, RUNG3_VERSION, type LookaheadParams, type MonteCarloParams } from "./lookahead.js";
import { makeRulePolicy, RUNG1_PARAMS, type RuleParams } from "./rules.js";
import type { CardTables } from "./tables.js";
import type { BotPolicy } from "./types.js";

/**
 * @displayName Bot policy registry
 * @strategicPurpose One place that turns a policy name on a command line into a versioned, parameter-hashed bot, so
 * every result names the rung, version and parameters it was played with.
 * @tacticalObjective Parses `random`, `rung1`, `rung2[:mu=..,lambda=..,...]` and `rung3[:k=..,horizon=reply|round,wBase=..,...]`
 * (rung 3 has a driver form only, src/sims/policies/rung3.ts) into policies and hashes
 * their parameters; `rung0` names the typed driver's own random rung and `greedy-hash` the spike's name-hash baseline (typed-adapter.ts).
 */

export const RUNG1_VERSION = "1";
export const RUNG2_VERSION = "1";

export type PolicySpec =
  | { kind: "random-spike" }
  | { kind: "greedy-hash" }
  | { kind: "random" }
  | { kind: "rules"; rung: 1 | 2; params: RuleParams }
  | { kind: "lookahead"; params: LookaheadParams }
  | { kind: "montecarlo"; params: MonteCarloParams };

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

function parseLookahead(text: string, rest: string | undefined): PolicySpec {
  const params: LookaheadParams = { ...RUNG3_PARAMS };
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (k === "horizon" && (v === "reply" || v === "round")) params.horizon = HORIZON[v];
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
  return parts.length === 0 ? "rung3" : `rung3:${parts.join(",")}`;
}

export function parsePolicySpec(text: string): PolicySpec {
  const [name, rest] = text.split(":");
  if (name === "random-spike" || name === "rung0") return { kind: "random-spike" };
  if (name === "greedy-hash" || name === "greedy") return { kind: "greedy-hash" };
  if (name === "random") return { kind: "random" };
  if (name === "rung3") return parseLookahead(text, rest);
  if (name === "rung3mc") return parseMonteCarlo(text, rest);
  if (name !== "rung1" && name !== "rung2") throw new Error(`unknown policy ${text}`);
  const params: RuleParams = { ...RUNG1_PARAMS };
  for (const kv of (rest ?? "").split(",").filter(Boolean)) {
    const [k, v] = kv.split("=");
    if (!(k in params) || !Number.isFinite(Number(v))) throw new Error(`bad policy parameter ${kv} in ${text}`);
    (params as unknown as Record<string, number>)[k] = Number(v);
  }
  if (name === "rung1" && (params.mu !== 0 || params.lambda !== 0)) throw new Error("rung1 takes mu = lambda = 0; use rung2");
  return { kind: "rules", rung: name === "rung1" ? 1 : 2, params };
}

export const specName = (s: PolicySpec): string =>
  s.kind === "montecarlo"
    ? monteCarloName(s.params)
    : s.kind === "lookahead"
    ? lookaheadName(s.params)
    : s.kind === "rules"
    ? `rung${s.rung}${s.rung === 2 ? `:mu=${s.params.mu},lambda=${s.params.lambda}` : ""}`
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
