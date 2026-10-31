import { createHash } from "node:crypto";
import { compareCodePoints } from "../../swu/canonical.js";
import { makeRandomPolicy } from "./random.js";
import { makeRulePolicy, RUNG1_PARAMS, type RuleParams } from "./rules.js";
import type { CardTables } from "./tables.js";
import type { BotPolicy } from "./types.js";

/**
 * @displayName Bot policy registry
 * @strategicPurpose One place that turns a policy name on a command line into a versioned, parameter-hashed bot, so
 * every result names the rung, version and parameters it was played with.
 * @tacticalObjective Parses `random`, `rung1` and `rung2[:mu=..,lambda=..,...]` into BotPolicy instances and hashes
 * their parameters; `rung0` names the typed driver's own random rung and `greedy-hash` the spike's name-hash baseline (typed-adapter.ts).
 */

export const RUNG1_VERSION = "1";
export const RUNG2_VERSION = "1";

export type PolicySpec =
  | { kind: "random-spike" }
  | { kind: "greedy-hash" }
  | { kind: "random" }
  | { kind: "rules"; rung: 1 | 2; params: RuleParams };

export function parsePolicySpec(text: string): PolicySpec {
  const [name, rest] = text.split(":");
  if (name === "random-spike" || name === "rung0") return { kind: "random-spike" };
  if (name === "greedy-hash" || name === "greedy") return { kind: "greedy-hash" };
  if (name === "random") return { kind: "random" };
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
  s.kind === "rules"
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
  if (spec.kind === "rules") {
    const params = { ...spec.params };
    return { spec: specName(spec), id: spec.rung === 1 ? "rung1-rules" : "rung2-pairs", version: spec.rung === 1 ? RUNG1_VERSION : RUNG2_VERSION, rung: spec.rung, params, paramsSha256: paramsSha256(params) };
  }
  const id = spec.kind === "greedy-hash" ? "greedy-hash" : "rung0-random";
  return { spec: specName(spec), id, version: spec.kind === "greedy-hash" ? "spike-9f224cf" : "1", rung: 0, params: {}, paramsSha256: paramsSha256({}) };
}
