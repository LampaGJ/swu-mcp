import { parsePolicySpec, policyHeader as specHeader, policyOf, type PolicySpec } from "./index.js";
import { ViewBuilder, type TypedAction } from "./engine-view.js";
import { flatMonteCarloPolicy } from "./flat-mc.js";
import { lookaheadPolicy } from "./rung3.js";
import type { CardTables } from "./tables.js";
import type { BotPolicy } from "./types.js";

/**
 * @displayName Bot rungs on the typed simulation driver
 * @strategicPurpose Runs the rung 1 and rung 2 bots (and the old name-hash greedy baseline) inside the typed driver's
 * policy chain (#110, src/sims/policy.ts), so ladder and deck figures come from the driver the MCP tool will use.
 * @tacticalObjective Wraps a BotPolicy as a driver Policy: the view is read from the live engine through ViewBuilder,
 * the answers from the driver's canonical actions; a prompt no rule covers returns null, so the chain descends to
 * rung 0 and the driver's coverage counter records it. `registerRungs` adds named chains to the driver's POLICIES
 * registry, the two rung 3 searches included (rung3.ts top-K lookahead, flat-mc.ts flat Monte Carlo, #163). The
 * driver's types are restated structurally here, so this file compiles with or without the driver.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- engine objects are untyped JavaScript */
export interface DriverPolicyView {
  seat: 1 | 2;
  k: number;
  promptKind: string;
  multi: boolean;
  game: any;
  players: readonly any[];
  /** The session's bookmark and rollback hooks (src/sims/policy.ts SearchHooks); only rung 3 reads them. */
  search?: unknown;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface DriverPolicy {
  rung: number;
  policyId: string;
  policyVersion: string;
  params: unknown;
  inputs: Record<string, string>;
  covers(kind: string): boolean;
  choose(actions: readonly TypedAction[], view: DriverPolicyView, random: () => number): { index: number } | null;
}

/** The pinned tables a rung reads, by name, for the match header (only the ones it reads). */
export function inputsOf(spec: PolicySpec, tables: CardTables): Record<string, string> {
  if (spec.kind !== "rules" && spec.kind !== "lookahead" && spec.kind !== "montecarlo") return {};
  const p = tables.pins;
  const base: Record<string, string> = { scores: p.scoresSha256, coefficients: p.coefficientsSha256, features: p.featuresSha256 };
  if (spec.kind === "lookahead" || spec.kind === "montecarlo" || spec.rung === 1) return base;
  if (p.pairsSha256 === null || p.pairPrecisionSha256 === null || p.complementaritySha256 === null) throw new Error("rung 2 needs the pair table loaded");
  return { ...base, leaderCards: p.leaderCardsSha256, pairs: p.pairsSha256, pairPrecision: p.pairPrecisionSha256, complementarity: p.complementaritySha256 };
}

/** One driver policy per match seat; it keeps the ViewBuilder's memory (last click, cancelled actions) for its game. */
export function driverPolicy(bot: BotPolicy, tables: CardTables, inputs: Record<string, string>): DriverPolicy {
  let game: unknown = null;
  let builder: ViewBuilder | null = null;
  return {
    rung: bot.rung,
    policyId: bot.id,
    policyVersion: bot.version,
    params: bot.params,
    inputs,
    covers: () => true,
    choose(actions, view, random) {
      if (builder === null || game !== view.game) {
        game = view.game;
        builder = new ViewBuilder(view.game, view.seat, tables);
      }
      const { view: gv, answers } = builder.build(actions, random);
      const i = bot.tryChoose(answers, gv);
      if (i === null) return null;
      builder.record(gv, answers[i]);
      return { index: i };
    },
  };
}

/**
 * The spike's synthetic greedy policy (scripts/sims/play-game.mjs makeGreedyPolicy at 9f224cf), ported to the driver
 * as the "name-hash" baseline the owner rejected: a hand card scores 100 + cost + hash(name), another card 50 +
 * hash(name), plus hash(name|board card) per friendly card in play; Pass 0, other buttons 5; a multi-select prompt
 * plays as rung 0. It is kept only to measure rung 1 against it.
 */
export function greedyHashPolicy(): DriverPolicy {
  const h = (s: string): number => {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
    return (x >>> 0) / 4294967296;
  };
  return {
    rung: 0,
    policyId: "greedy-hash",
    policyVersion: "spike-9f224cf",
    params: {},
    inputs: {},
    covers: () => true,
    choose(actions, view, random) {
      if (view.multi) {
        const done = actions.findIndex((a) => a.kind === "done");
        if (done >= 0 && random() < 0.5) return { index: done };
        return { index: Math.floor(random() * actions.length) };
      }
      const player = view.players[view.seat - 1];
      const board: string[] = (player.getArenaCards() as { internalName: string }[]).map((c) => c.internalName);
      const costOf = (name: string | null): number => (player.hand as { internalName: string; cost?: number }[]).find((c) => c.internalName === name)?.cost ?? 0;
      let best = 0;
      let bestScore = -Infinity;
      actions.forEach((a, i) => {
        let s: number;
        if (a.engineCardId !== null && a.zone !== null && a.zone !== "display" && a.kind !== "distribute") {
          s = (a.zone === "hand" ? 100 + costOf(a.engineCardId) : 50) + h(a.engineCardId);
          for (const other of board) s += h(`${a.engineCardId}|${other}`);
        } else if (a.kind === "pass") s = 0;
        else if (["takeInitiative", "done", "mulligan", "choose"].includes(a.kind)) s = 5;
        else s = 1;
        s += random() * 0.001;
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      });
      return { index: best };
    },
  };
}

/** Adds one chain per policy name to the driver's registry; `rung0` is the driver's own. */
export function registerRungs(
  registry: Record<string, () => unknown>,
  makeChain: (policies: DriverPolicy[]) => unknown,
  names: readonly string[],
  tables: CardTables,
): void {
  for (const name of names) {
    if (name === "rung0" || registry[name] !== undefined) continue;
    if (name === "greedy-hash") {
      registry[name] = () => makeChain([greedyHashPolicy()]);
      continue;
    }
    const spec = parsePolicySpec(name);
    if (spec.kind === "montecarlo") {
      const inputs = inputsOf(spec, tables);
      const params = spec.params;
      registry[name] = () => makeChain([flatMonteCarloPolicy(tables, params, inputs)]);
      continue;
    }
    if (spec.kind === "lookahead") {
      const inputs = inputsOf(spec, tables);
      const params = spec.params;
      registry[name] = () => makeChain([lookaheadPolicy(tables, params, inputs)]);
      continue;
    }
    if (spec.kind !== "rules") throw new Error(`policy ${name} has no driver form`);
    const inputs = inputsOf(spec, tables);
    registry[name] = () => {
      const bot = policyOf(spec, tables);
      if (bot === null) throw new Error(name);
      return makeChain([driverPolicy(bot, tables, inputs)]);
    };
  }
}

/** The driver registry name of a harness policy spec ("random-spike" and "rung0" are the driver's rung 0). */
export function driverName(text: string): string {
  const spec = parsePolicySpec(text);
  if (spec.kind === "random-spike" || spec.kind === "random") return "rung0";
  if (spec.kind === "greedy-hash") return "greedy-hash";
  return specHeader(spec).spec;
}
