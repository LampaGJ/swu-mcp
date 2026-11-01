import { canonicalJson, sha256Hex } from "../swu/canonical.js";
import type { PromptKind } from "./actions.js";
import type { EngineGame, EnginePlayer } from "./engine.js";
import type { Seat } from "./rng.js";
import type { LegalAction, SearchBlock } from "./schemas.js";

/**
 * @displayName Bot policy contract and rung 0
 * @strategicPurpose Every rung of the bot ladder is a pure function from the actor's view, the canonical legal
 * actions, its pinned tables and the decision randomness to one index (docs/research/sim-bot-policy-ladder.md,
 * "Shape shared by every rung"). A prompt a rung does not cover descends to the next rung down, ending at rung 0, and
 * the share a rung answered itself is reported with every result.
 * @tacticalObjective The Policy interface, the fallback chain with its per-seat coverage counter, and rung 0:
 * uniform over the canonical actions, Done half the time on a multi-select prompt.
 */

export interface PolicyView {
  seat: Seat;
  k: number;
  promptKind: PromptKind;
  /** The prompt toggles one card per click and ends on Done. */
  multi: boolean;
  game: EngineGame;
  players: readonly [EnginePlayer, EnginePlayer];
  /** Bookmark and rollback for a search (rung 3); a policy that uses it must leave the state as it found it. */
  search?: SearchHooks;
}

export interface SearchBookmark {
  readonly snapshotId: number;
}

export interface SearchHooks {
  cardKeys: Readonly<Record<string, string>>;
  /** The match seed, for a search's own counter-based randomness. */
  seed: string;
  /** Marks the current state; throws when the match runs with undo off. */
  bookmark(): SearchBookmark;
  /** Puts the bookmarked state back, the engine RNG and its draw counter included. */
  rollback(b: SearchBookmark): void;
  /** Frees the bookmark once the decision is made. */
  release(b: SearchBookmark): void;
}

export interface PolicyChoice {
  index: number;
  utilities?: number[];
  /** A learned search's values for this decision (#128). */
  search?: SearchBlock;
}

/**
 * Scores a state before the policy chooses, for measurement (#127): the values never reach the choice, and scoring
 * must not change the engine state. Registered by name, so a match spec can name it across worker threads.
 */
export interface DecisionObserver {
  version: string;
  sha256: string;
  load: "per-prompt" | "per-action";
  /** One logit per scored input: one at per-prompt, one per legal answer at per-action. */
  score(game: EngineGame, seat: Seat, nAnswers: number): number[];
}

export const OBSERVERS: Record<string, () => DecisionObserver> = {};

export interface Policy {
  rung: number;
  policyId: string;
  policyVersion: string;
  params: unknown;
  /** Table name to sha256 of each pinned table the policy reads. */
  inputs: Record<string, string>;
  /** sha256 of the evaluator weights a learned rung reads; the decision record's evaluator block names it. */
  evaluatorSha256?: string;
  covers(kind: PromptKind): boolean;
  /** Null hands the decision to the next rung down. */
  choose(actions: readonly LegalAction[], view: PolicyView, random: () => number): PolicyChoice | null;
}

export const policyHeader = (p: Policy) => ({ rung: p.rung, policyId: p.policyId, policyVersion: p.policyVersion, paramsSha256: sha256Hex(canonicalJson(p.params)), inputs: p.inputs });

export const RUNG0_DONE_PROBABILITY = 0.5;

export const rung0: Policy = {
  rung: 0,
  policyId: "rung0-random",
  policyVersion: "1",
  params: { doneProbability: RUNG0_DONE_PROBABILITY },
  inputs: {},
  covers: () => true,
  choose(actions, view, random) {
    const done = actions.findIndex((a) => a.kind === "done");
    if (view.multi && done >= 0 && random() < RUNG0_DONE_PROBABILITY) return { index: done };
    return { index: Math.floor(random() * actions.length) };
  },
};

export interface ChainChoice {
  index: number;
  policy: Policy;
  fallback: string | null;
  utilities: number[] | null;
  search: SearchBlock | null;
}

/** Policies from the top rung down; rung 0 is appended when absent, so every decision gets an answer. */
export class PolicyChain {
  readonly policies: readonly Policy[];

  constructor(policies: readonly Policy[]) {
    const list = [...policies];
    if (list.length === 0 || list[list.length - 1].rung !== 0) list.push(rung0);
    for (let i = 1; i < list.length; i++) if (list[i].rung >= list[i - 1].rung && list[i].rung !== 0) throw new Error("policy chain must descend by rung");
    this.policies = list;
  }

  get top(): Policy {
    return this.policies[0];
  }

  choose(actions: readonly LegalAction[], view: PolicyView, random: () => number): ChainChoice {
    const reasons: string[] = [];
    for (const policy of this.policies) {
      if (!policy.covers(view.promptKind)) {
        reasons.push(`${policy.policyId} does not cover ${view.promptKind}`);
        continue;
      }
      const c = policy.choose(actions, view, random);
      if (c === null) {
        reasons.push(`${policy.policyId} declined`);
        continue;
      }
      if (!Number.isInteger(c.index) || c.index < 0 || c.index >= actions.length) throw new Error(`${policy.policyId} returned index ${c.index} of ${actions.length}`);
      return { index: c.index, policy, fallback: reasons.length === 0 ? null : reasons.join("; "), utilities: c.utilities ?? null, search: c.search ?? null };
    }
    throw new Error("no policy answered; the chain must end at rung 0");
  }
}

export const POLICIES: Record<string, () => PolicyChain> = { rung0: () => new PolicyChain([rung0]) };

export function policyChain(name: string): PolicyChain {
  const make = POLICIES[name];
  if (make === undefined) throw new Error(`unknown policy ${name}; known: ${Object.keys(POLICIES).join(", ")}`);
  return make();
}
