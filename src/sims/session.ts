import { createHash } from "node:crypto";
import { compareCodePoints } from "../swu/canonical.js";
import { enumerateActions, promptKindOf, type CanonicalAction, type PromptKind } from "./actions.js";
import { rngCursor, type EngineGame, type EnginePlayer, type StartedGame } from "./engine.js";
import { PolicyChain, type ChainChoice } from "./policy.js";
import { DecisionRandom, type Seat } from "./rng.js";
import { legalActionsSha256, type CompactDecision, type FullDecision, type MatchFooter, type RngCursor } from "./schemas.js";

/**
 * @displayName Headless match session
 * @strategicPurpose Play a seeded match to the end, or pause before any single decision so a search or a branch can
 * take over (#110, #141), writing the decision records replay asserts against.
 * @tacticalObjective Visits the two seats in a fixed cycle, as the spike did, but keeps the cycle position across a
 * pause, so pausing changes where the loop yields, not what it does. Every engine or driver exception ends the match
 * with endCondition error and a null winner; nothing is dropped.
 */

export type EndCondition = MatchFooter["result"]["endCondition"];
export type RecordMode = "full" | "compact" | "none";

export interface Pending {
  seat: Seat;
  k: number;
  promptKind: PromptKind;
  actions: CanonicalAction[];
  legalActionsSha256: string;
  rngCursor: RngCursor;
}

export interface SessionOptions {
  seed: string;
  cardKeys: Readonly<Record<string, string>>;
  chains: readonly [PolicyChain, PolicyChain];
  recordMode: RecordMode;
  playedMetric: number;
  maxDecisions?: number;
}

export interface RunOptions {
  /** Called before every decision; true pauses the session with that decision still pending. */
  until?: (pending: Pending, session: Session) => boolean;
  /** Called after the policy chose and before the choice is applied; true stops (the decision stays pending). */
  check?: (pending: Pending, choice: ChainChoice, session: Session) => boolean;
  /** Replaces the policy for this run: returns the index to apply (branching applies an alternative this way). */
  force?: (pending: Pending, session: Session) => number | null;
}

export const MAX_DECISIONS = 20000;
const UNOBSERVED_CURSOR: RngCursor = { engineDraws: 0, engineStateSha: "0000000000000000", botDraws: 0 };
const MAX_IDLE_PASSES = 50;

export class Session {
  readonly game: EngineGame;
  readonly players: [EnginePlayer, EnginePlayer];
  readonly decisions: (FullDecision | CompactDecision)[] = [];
  k = 0;
  botDraws = 0;
  endCondition: EndCondition | null = null;
  error: string | null = null;
  errorStack: string | null = null;
  readonly coverage = { decisions: [0, 0] as [number, number], answered: [0, 0] as [number, number] };
  readonly gaps = { cardRefs: 0, nullCardKey: 0 };
  private cursor: 0 | 1 = 0;
  private actedThisPass = false;
  private idle = 0;
  private readonly hash = createHash("sha256");
  private readonly started: StartedGame;

  constructor(
    started: StartedGame,
    readonly opts: SessionOptions,
  ) {
    this.started = started;
    this.game = started.game;
    this.players = started.players;
  }

  get ended(): boolean {
    return this.endCondition !== null;
  }

  cursorNow(): RngCursor {
    return rngCursor(this.game, this.started.rng, this.botDraws);
  }

  /** Record mode none with no observer needs neither hash: skipping them is the bulk throughput path. */
  private pendingFor(seat: Seat, actions: CanonicalAction[], observed: boolean): Pending {
    const hashes = observed || this.opts.recordMode !== "none";
    return {
      seat,
      k: this.k,
      promptKind: promptKindOf(this.players[seat - 1]),
      actions,
      legalActionsSha256: hashes ? legalActionsSha256(actions.map((a) => a.action.descriptor)) : "",
      rngCursor: hashes ? this.cursorNow() : UNOBSERVED_CURSOR,
    };
  }

  private advance(): void {
    if (this.cursor === 1) {
      if (!this.actedThisPass) {
        this.game.continue();
        if (++this.idle > MAX_IDLE_PASSES) this.endCondition = "stuck";
      } else this.idle = 0;
      this.actedThisPass = false;
    }
    this.cursor = this.cursor === 0 ? 1 : 0;
  }

  run(opts: RunOptions = {}): "paused" | "ended" {
    const max = this.opts.maxDecisions ?? MAX_DECISIONS;
    try {
      while (this.endCondition === null) {
        if (this.game.isEnded) {
          this.endCondition = this.game.winnerNames.length === 1 ? "base_destroyed" : "draw";
          break;
        }
        if (this.k >= max) {
          this.endCondition = "timeout";
          break;
        }
        const seat = (this.cursor + 1) as Seat;
        const actions = enumerateActions(this.game, this.players, seat, this.opts.cardKeys);
        if (actions.length === 0) {
          this.advance();
          continue;
        }
        const pending = this.pendingFor(seat, actions, opts.until !== undefined || opts.check !== undefined);
        if (opts.until?.(pending, this) === true) return "paused";
        if (!this.decide(pending, opts)) return "paused";
        this.actedThisPass = true;
        if (this.game.isEnded) continue;
        this.advance();
      }
    } catch (e) {
      this.endCondition = "error";
      this.error = String((e as Error)?.message ?? e).slice(0, 300);
      this.errorStack = (e as Error)?.stack ?? null;
    }
    return "ended";
  }

  private decide(pending: Pending, opts: RunOptions): boolean {
    const { seat, actions } = pending;
    const random = new DecisionRandom(this.opts.seed, seat, this.k);
    const chain = this.opts.chains[seat - 1];
    const forced = opts.force?.(pending, this) ?? null;
    const choice: ChainChoice =
      forced === null
        ? chain.choose(
            actions.map((a) => a.action),
            { seat, k: this.k, promptKind: pending.promptKind, multi: this.players[seat - 1].promptState.selectCardMode === "multiple", game: this.game, players: this.players },
            random.next,
          )
        : { index: forced, policy: chain.top, fallback: "forced", utilities: null };
    if (opts.check?.(pending, choice, this) === true) return false;
    const chosen = actions[choice.index];
    this.coverage.decisions[seat - 1] += 1;
    if (choice.policy === chain.top && forced === null) this.coverage.answered[seat - 1] += 1;
    for (const a of actions) {
      for (const ref of a.action.engineCardId === null ? a.action.targets : [a.action]) {
        this.gaps.cardRefs += 1;
        if (ref.cardKey === null) this.gaps.nullCardKey += 1;
      }
    }
    this.hash.update(`${seat}|${chosen.action.descriptor}\n`);
    if (this.opts.recordMode === "full") {
      const phase = this.game.currentPhase;
      if (phase !== "setup" && phase !== "action" && phase !== "regroup") throw new Error(`unexpected engine phase ${String(phase)} at decision ${this.k}`);
      this.decisions.push({
        k: this.k,
        round: this.game.roundNumber,
        phase,
        actor: seat,
        promptKind: pending.promptKind,
        legalActions: actions.map((a) => a.action),
        legalActionsSha256: pending.legalActionsSha256,
        chosen: { i: choice.index, descriptor: chosen.action.descriptor },
        rngCursor: pending.rngCursor,
        evaluator: { rung: choice.policy.rung, version: choice.policy.policyVersion, sha256: null },
        utilities: choice.utilities,
        fallback: choice.fallback,
      });
    } else if (this.opts.recordMode === "compact") {
      this.decisions.push({ k: this.k, actor: seat, legalActionsSha256: pending.legalActionsSha256, chosen: chosen.action.descriptor, rngCursor: pending.rngCursor });
    }
    this.k += 1;
    chosen.run(random.next);
    this.botDraws += random.draws;
    this.game.continue();
    return true;
  }

  traceSha256(): string {
    return this.hash.copy().digest("hex");
  }

  footer(): MatchFooter {
    if (this.endCondition === null) throw new Error("footer of an unfinished session");
    const names = this.game.winnerNames;
    const winner: Seat | null = this.endCondition === "base_destroyed" && names.length === 1 ? (names[0] === "sim1" ? 1 : 2) : null;
    const ident = (internalName: string): string => this.opts.cardKeys[internalName] ?? `~${internalName}`;
    const played = this.players.map((p) => {
      const counts = new Map<string, number>();
      for (const m of this.game.statsTracker.cardMetrics) if (m.metric === this.opts.playedMetric && m.player === p.trackingId) counts.set(m.cardInternalName, (counts.get(m.cardInternalName) ?? 0) + 1);
      return [...counts]
        .map(([engineCardId, count]) => ({ cardKey: this.opts.cardKeys[engineCardId] ?? null, engineCardId, count }))
        .sort((a, b) => compareCodePoints(ident(a.engineCardId), ident(b.engineCardId)));
    }) as MatchFooter["cardsPlayed"];
    return {
      result: { winner, endCondition: this.endCondition, rounds: this.game.roundNumber, decisions: this.k },
      error: this.endCondition === "error" ? (this.error ?? "unknown error") : null,
      coverage: { decisions: [...this.coverage.decisions], answered: [...this.coverage.answered] },
      gaps: { ...this.gaps },
      cardsPlayed: played,
      baseDamage: [this.players[0].base.damage, this.players[1].base.damage],
      endBoard: this.players.map((p) =>
        p
          .getArenaCards()
          .map((c) => ident(c.internalName))
          .sort(compareCodePoints),
      ) as MatchFooter["endBoard"],
      finalRngCursor: this.cursorNow(),
      traceSha256: this.traceSha256(),
    };
  }
}

