import { createHash } from "node:crypto";
import type { BotPolicy, GameView, LegalAnswer } from "../sims/policies/types.js";
import type { CardTables } from "../sims/policies/tables.js";
import { RUNG0_DONE_PROBABILITY } from "../sims/policy.js";
import { DecisionRandom, type Seat } from "../sims/rng.js";
import { liveActions, type CardIndex, type LiveAction, type ViewGaps } from "./player-view.js";
import { LiveViewBuilder, type LiveViewGaps } from "./live-view.js";
import type { GameCommand, GameState } from "./schemas.js";

/**
 * @displayName Karabast live decision layer
 * @strategicPurpose The part of the live client that must replay byte for byte from a recorded gamestate stream
 * (#182, gap G7: the live server is never seeded, so the game cannot be replayed, only the decisions).
 * @tacticalObjective A pure state machine over the gamestates one seat receives, in order: when the seat has a
 * decision whose key (prompt uuid plus every selection flag) differs from the last one answered, it enumerates the
 * canonical actions from the player view, asks the rung 1 bot, falls back to rung 0 (src/sims/policy.ts) on the
 * same seeded decision randomness the simulator uses, and returns the command to send. Nothing here reads a clock or
 * the socket, so feeding the recorded stream again yields the same commands and the same trace hash.
 */

export interface BotOptions {
  seat: Seat;
  seatIds: readonly [string, string];
  seed: string;
  policy: BotPolicy;
  tables: CardTables;
  index: CardIndex;
  cardKeys: Readonly<Record<string, string>>;
  ownDeck: readonly string[];
}

export interface BotDecision {
  k: number;
  descriptor: string;
  command: GameCommand;
  /** "rung1", "rung0" (no rule applied) or "loop-guard". */
  answeredBy: string;
  legal: number;
}

/** Whether a gamestate is one the bot may answer: both players present and no winner yet. The client and the replay share it. */
export const decidable = (state: GameState): boolean => Object.keys(state.players).length >= 2 && (state.winners?.length ?? 0) === 0;

/** What makes two gamestates the same decision: the prompt uuid and every selection flag the viewer sees. */
export function decisionKey(state: GameState, selfId: string): string {
  const p = state.players[selfId];
  if (p === undefined) return "";
  const ps = p.promptState ?? {};
  const flags: string[] = [];
  for (const pl of Object.values(state.players)) {
    for (const pile of Object.values(pl.cardPiles)) for (const c of pile ?? []) if (c.selectable === true || c.selected === true) flags.push(`${c.uuid ?? "?"}:${c.selectable === true ? 1 : 0}${c.selected === true ? 1 : 0}`);
    for (const c of [...(pl.leaders ?? []), ...(pl.base === undefined ? [] : [pl.base])]) if (c.selectable === true || c.selected === true) flags.push(`${c.uuid ?? "?"}:${c.selectable === true ? 1 : 0}${c.selected === true ? 1 : 0}`);
    if (pl.forceToken?.selectionState?.selectable === true) flags.push(`force:${pl.id}`);
  }
  const shown = (ps.displayCards ?? []).map((d) => `${d.cardUuid}:${d.selectionState}`);
  const buttons = (ps.buttons ?? []).map((b) => `${b.arg}:${b.disabled === true ? 0 : 1}`);
  return `${ps.promptUuid ?? ""}|${ps.promptType ?? ""}|${ps.menuTitle ?? ""}|${flags.sort().join(",")}|${shown.join(",")}|${buttons.join(",")}|${JSON.stringify(ps.distributeAmongTargets ?? null)}`;
}

export class LiveBot {
  readonly builder: LiveViewBuilder;
  readonly decisions: BotDecision[] = [];
  readonly gaps: ViewGaps & LiveViewGaps = { hiddenSelectable: 0, unmapped: 0, ambiguousSource: 0, missingSource: 0 };
  private lastKey = "";
  private readonly hash = createHash("sha256");

  constructor(readonly opts: BotOptions) {
    this.builder = new LiveViewBuilder({ seat: opts.seat, seatIds: opts.seatIds, tables: opts.tables, index: opts.index, ownDeck: opts.ownDeck });
  }

  get selfId(): string {
    return this.opts.seatIds[this.opts.seat - 1];
  }

  get k(): number {
    return this.decisions.length;
  }

  /**
   * Enumerates and chooses without recording: the view, the answers and the chosen index. `random` is the seat's
   * decision randomness for this k.
   */
  choose(state: GameState, random: () => number): { actions: LiveAction[]; view: GameView; answers: LegalAnswer[]; index: number; answeredBy: string; gaps: ViewGaps } | null {
    const live = liveActions(state, this.opts.seatIds, this.opts.seat, this.opts.cardKeys, this.opts.index);
    if (live.actions.length === 0) return null;
    const { view, answers } = this.builder.build(
      state,
      live.actions.map((a) => a.action),
      live.shim,
      random,
    );
    const before = this.opts.policy.stats.fallbackBy["loop-guard"] ?? 0;
    const ruled = this.opts.policy.tryChoose(answers, view);
    let index: number;
    let answeredBy = "rung1";
    if (ruled === null) {
      answeredBy = (this.opts.policy.stats.fallbackBy["loop-guard"] ?? 0) > before ? "loop-guard" : "rung0";
      const done = live.actions.findIndex((a) => a.action.kind === "done");
      index = view.prompt.multiple && done >= 0 && random() < RUNG0_DONE_PROBABILITY ? done : Math.floor(random() * live.actions.length);
    } else index = ruled;
    return { actions: live.actions, view, answers, index, answeredBy, gaps: live.gaps };
  }

  /** One received gamestate in; the command to send, or null when the seat has no new decision. */
  onState(state: GameState): BotDecision | null {
    this.builder.observe(state);
    const key = decisionKey(state, this.selfId);
    if (key === this.lastKey) return null;
    const random = new DecisionRandom(this.opts.seed, this.opts.seat, this.k);
    const c = this.choose(state, random.next);
    if (c === null) return null;
    this.lastKey = key;
    this.gaps.hiddenSelectable += c.gaps.hiddenSelectable;
    this.gaps.unmapped += c.gaps.unmapped;
    this.builder.record(c.view, c.answers[c.index]);
    const chosen = c.actions[c.index];
    const d: BotDecision = { k: this.k, descriptor: chosen.action.descriptor, command: chosen.command, answeredBy: c.answeredBy, legal: c.actions.length };
    this.decisions.push(d);
    this.hash.update(`${d.k}|${d.descriptor}|${JSON.stringify(d.command)}\n`);
    return d;
  }

  /** sha256 over every decision's k, descriptor and command, in order. */
  traceSha256(): string {
    return this.hash.copy().digest("hex");
  }

  /** Forgets the last answered key, so the same decision is answered again (after a command the server rejected). */
  forgetLastKey(): void {
    this.lastKey = "";
  }
}

