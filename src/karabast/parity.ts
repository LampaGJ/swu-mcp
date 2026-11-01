import { enumerateActions } from "../sims/actions.js";
import { startGame, type Engine, type EngineGame } from "../sims/engine.js";
import type { DeckInput } from "../sims/match.js";
import { intentOfTitle, ViewBuilder, type TypedAction } from "../sims/policies/engine-view.js";
import type { CardTables } from "../sims/policies/tables.js";
import type { BotPolicy, CardView, GameView } from "../sims/policies/types.js";
import { policyChain } from "../sims/policy.js";
import { DecisionRandom, type Seat } from "../sims/rng.js";
import { Session, type EndCondition } from "../sims/session.js";
import { LiveBot } from "./bot.js";
import type { CardIndex } from "./player-view.js";
import { liveActions } from "./player-view.js";
import { gameStateSchema, type GameCommand } from "./schemas.js";

/**
 * @displayName Player-view parity oracle
 * @strategicPurpose Before a bot plays from what a karabast server sends, measure on the true engine how much of the
 * simulator's decision it can rebuild from that alone (#182 phase 1): legal actions, the command that answers each,
 * the prompt kind and intent rung 1 reads, and rung 1's own choice.
 * @tacticalObjective Plays one rung 1 mirror on the in-process engine (src/sims/session.ts). At every decision it
 * takes the gamestate the gamenode would send each seat (Game.getState, JSON round trip as on the wire), parses it
 * with the socket schemas, rebuilds the canonical descriptors from it and compares them with enumerateActions on the
 * engine; compares the socket command for the chosen action with the engine call the session then makes; compares
 * the live prompt kind, intent and source with engine-view.ts's; and asks a second rung 1 instance to choose from the
 * live view. Both views then record the engine's choice, so each decision is compared on the same history.
 */

export interface MismatchExample {
  promptKind: string;
  onlyEngine: string[];
  onlyLive: string[];
}

export interface ParityTally {
  decisions: number;
  descriptorMatch: number;
  /** The non-deciding seat at each decision: engine and live agree it has (or has not) the same actions. */
  idleChecks: number;
  idleMatch: number;
  commandChecks: number;
  commandMatch: number;
  schemaFailures: number;
  schemaExamples: string[];
  /** Per engine-view prompt kind: decisions, live kind equal, live intent equal, live source card equal. */
  kinds: Record<string, { n: number; kind: number; intent: number; source: number; confusions: Record<string, number>; titles: string[]; titleOnlyIntent: number }>;
  rung1: { compared: number; same: number; engineRuled: number; liveRuled: number; bothRuledSame: number };
  /** Each rung 1 disagreement by its first cause: kind, intent, source, fallback, or the first differing view field. */
  rung1Causes: Record<string, number>;
  /** At every compared decision, which view fields differ between the engine view and the live view (gap G4). */
  fieldDiffs: Record<string, number>;
  mismatchClasses: Record<string, number>;
  examples: Record<string, MismatchExample[]>;
  gaps: { hiddenSelectable: number; unmapped: number; ambiguousSource: number; missingSource: number };
}

export const emptyTally = (): ParityTally => ({
  decisions: 0,
  descriptorMatch: 0,
  idleChecks: 0,
  idleMatch: 0,
  commandChecks: 0,
  commandMatch: 0,
  schemaFailures: 0,
  schemaExamples: [],
  kinds: {},
  rung1: { compared: 0, same: 0, engineRuled: 0, liveRuled: 0, bothRuledSame: 0 },
  rung1Causes: {},
  fieldDiffs: {},
  mismatchClasses: {},
  examples: {},
  gaps: { hiddenSelectable: 0, unmapped: 0, ambiguousSource: 0, missingSource: 0 },
});

const strip = (d: string): string => d.replace(/\|\d+(\||$)/, "|#$1");

/** Names why two descriptor lists differ, from the descriptors and the live view's gap counts. */
export function classifyMismatch(onlyEngine: readonly string[], onlyLive: readonly string[], hiddenSelectable: number): string {
  if (onlyLive.some((d) => d.includes("|~?"))) return "unmapped-card";
  if (onlyEngine.length > 0 && onlyLive.length === 0 && hiddenSelectable > 0) return "hidden-selectable";
  if (onlyEngine.some((d) => /\|p\d\.deck\|/.test(d))) return "deck-card-not-sent";
  const a = onlyEngine.map(strip).sort();
  const b = onlyLive.map(strip).sort();
  if (a.length === b.length && a.every((x, i) => x === b[i])) return "ordinal";
  if (onlyEngine.length > 0 && onlyLive.length === 0) return "missing-in-live";
  if (onlyLive.length > 0 && onlyEngine.length === 0) return "extra-in-live";
  return "different";
}

const MAX_EXAMPLES = 5;

const cardFields = (c: CardView): Record<string, string> => ({
  cost: String(c.cost),
  power: String(c.power),
  hp: String(c.hp),
  damage: String(c.damage),
  exhausted: String(c.exhausted),
  keywords: [...c.keywords].sort().join(","),
  raid: String(c.raid),
  shield: String(c.shield),
  unique: String(c.unique),
  kind: c.kind,
  cardKey: String(c.cardKey),
});

/** The GameView fields where the live view differs from the engine view, named `side.field` or `card.field`. */
export function viewDiff(e: GameView, l: GameView): string[] {
  const out = new Set<string>();
  for (const [name, a, b] of [
    ["me", e.me, l.me],
    ["opp", e.opp, l.opp],
  ] as const) {
    if (a.base.damage !== b.base.damage) out.add(`${name}.baseDamage`);
    if (a.resources.total !== b.resources.total || a.resources.ready !== b.resources.ready) out.add(`${name}.resources`);
    if (a.handSize !== b.handSize) out.add(`${name}.handSize`);
    if (a.deckSize !== b.deckSize) out.add(`${name}.deckSize`);
    if (a.hasInitiative !== b.hasInitiative) out.add(`${name}.hasInitiative`);
    if (a.leaderDeployed !== b.leaderDeployed) out.add(`${name}.leaderDeployed`);
    if (a.units.map((u) => u.id).join() !== b.units.map((u) => u.id).join()) out.add(`${name}.unitOrder`);
  }
  if (e.me.maxDeckCost !== l.me.maxDeckCost) out.add("me.maxDeckCost");
  const aspects = (v: GameView): string => JSON.stringify(Object.entries(v.me.deckAspects?.() ?? {}).sort((x, y) => (x[0] < y[0] ? -1 : 1)));
  if (aspects(e) !== aspects(l)) out.add("me.deckAspects");
  for (const [id, c] of e.cards) {
    const d = l.cards.get(id);
    if (d === undefined) {
      out.add("card.missing");
      continue;
    }
    const x = cardFields(c);
    const y = cardFields(d);
    for (const k of Object.keys(x)) if (x[k] !== y[k]) out.add(`card.${k}`);
  }
  return [...out].sort();
}

function addMismatch(t: ParityTally, cls: string, ex: MismatchExample): void {
  t.mismatchClasses[cls] = (t.mismatchClasses[cls] ?? 0) + 1;
  const list = (t.examples[cls] ??= []);
  if (list.length < MAX_EXAMPLES) list.push(ex);
}

export interface ParityGameOptions {
  engine: Engine;
  decks: readonly [DeckInput, DeckInput];
  ownDecks: readonly [readonly string[], readonly string[]];
  seed: string;
  autoSingleTarget: boolean;
  cardKeys: Readonly<Record<string, string>>;
  tables: CardTables;
  index: CardIndex;
  /** A fresh rung 1 bot per seat for the live side. */
  makeBot: () => BotPolicy;
  /** false plays the same game without probing, for the does-not-perturb check. */
  probe?: boolean;
}

export interface ParityGameResult {
  endCondition: EndCondition;
  decisions: number;
  traceSha256: string;
  error: string | null;
}

const SEAT_IDS = ["player1", "player2"] as const;

function engineCommand(method: string, args: unknown[]): GameCommand {
  switch (method) {
    case "cardClicked":
      return ["cardClicked", String(args[1])];
    case "menuButton":
      return ["menuButton", args[1] as string | number, String(args[2])];
    case "perCardMenuButton":
      return ["perCardMenuButton", args[1] as string | number, String(args[2]), String(args[3])];
    default: {
      const r = args[1] as { type: string; valueDistribution: { uuid: string; amount: number }[] };
      return ["statefulPromptResults", { type: r.type, valueDistribution: r.valueDistribution.map((v) => ({ uuid: v.uuid, amount: v.amount })) }, String(args[2])];
    }
  }
}

export async function playParityGame(o: ParityGameOptions, t: ParityTally): Promise<ParityGameResult> {
  const started = await startGame(o.engine, [o.decks[0].list, o.decks[1].list], { engineSeed: `engine:${o.seed}`, undo: false });
  const game = started.game as EngineGame & { getState(id: string): unknown; toggleOptionSetting(id: string, name: string, v: boolean): void } & Record<string, unknown>;
  for (const id of SEAT_IDS) game.toggleOptionSetting(id, "autoSingleTarget", o.autoSingleTarget);
  const session = new Session(started, { seed: o.seed, cardKeys: o.cardKeys, chains: [policyChain("rung1"), policyChain("rung1")], recordMode: "none", playedMetric: o.engine.playedMetric });
  if (o.probe === false) {
    session.run();
    return { endCondition: session.endCondition ?? "error", decisions: session.k, traceSha256: session.traceSha256(), error: session.error };
  }
  let expected: GameCommand | null = null;
  for (const m of ["cardClicked", "menuButton", "perCardMenuButton", "statefulPromptResults"]) {
    const orig = (game[m] as (...a: unknown[]) => unknown).bind(game);
    game[m] = (...args: unknown[]) => {
      if (expected !== null) {
        t.commandChecks += 1;
        if (JSON.stringify(engineCommand(m, args)) === JSON.stringify(expected)) t.commandMatch += 1;
        else addMismatch(t, "command", { promptKind: m, onlyEngine: [JSON.stringify(engineCommand(m, args))], onlyLive: [JSON.stringify(expected)] });
        expected = null;
      }
      return orig(...args);
    };
  }
  const engineViews = [new ViewBuilder(game, 1, o.tables), new ViewBuilder(game, 2, o.tables)];
  const liveBots = ([1, 2] as const).map((seat) => new LiveBot({ seat, seatIds: SEAT_IDS, seed: o.seed, policy: o.makeBot(), tables: o.tables, index: o.index, cardKeys: o.cardKeys, ownDeck: o.ownDecks[seat - 1] }));
  const viewOf = (seat: Seat) => {
    const raw: unknown = JSON.parse(JSON.stringify(game.getState(SEAT_IDS[seat - 1])));
    const parsed = gameStateSchema.safeParse(raw);
    if (!parsed.success) {
      t.schemaFailures += 1;
      for (const issue of parsed.error.issues) {
        const where = `${issue.path.map((x) => (typeof x === "number" ? "#" : String(x))).join(".")}: ${issue.message}`;
        if (!t.schemaExamples.includes(where) && t.schemaExamples.length < 40) t.schemaExamples.push(where);
      }
      return null;
    }
    return parsed.data;
  };

  session.run({
    check: (pending, choice) => {
      const seat = pending.seat;
      t.decisions += 1;
      const engineDescs = pending.actions.map((a) => a.action.descriptor);
      const chosen = engineDescs[choice.index];
      const state = viewOf(seat);
      if (state === null) return false;
      const live = liveActions(state, SEAT_IDS, seat, o.cardKeys, o.index);
      const liveDescs = live.actions.map((a) => a.action.descriptor);
      t.gaps.hiddenSelectable += live.gaps.hiddenSelectable;
      t.gaps.unmapped += live.gaps.unmapped;
      const typed = pending.actions.map((a) => a.action) as unknown as TypedAction[];
      const ev = engineViews[seat - 1].build(typed, () => 0);
      const kind = ev.view.prompt.kind;
      if (liveDescs.length === engineDescs.length && liveDescs.every((d, i) => d === engineDescs[i])) t.descriptorMatch += 1;
      else {
        const le = new Set(liveDescs);
        const ee = new Set(engineDescs);
        const onlyEngine = engineDescs.filter((d) => !le.has(d));
        const onlyLive = liveDescs.filter((d) => !ee.has(d));
        addMismatch(t, classifyMismatch(onlyEngine, onlyLive, live.gaps.hiddenSelectable), { promptKind: kind, onlyEngine, onlyLive });
      }
      const liveChosen = live.actions.find((a) => a.action.descriptor === chosen);
      expected = liveChosen?.command ?? null;

      const bot = liveBots[seat - 1];
      const gapsBefore = { ...bot.builder.gaps };
      const lc = bot.choose(state, new DecisionRandom(o.seed, seat, pending.k).next);
      t.gaps.ambiguousSource += bot.builder.gaps.ambiguousSource - gapsBefore.ambiguousSource;
      t.gaps.missingSource += bot.builder.gaps.missingSource - gapsBefore.missingSource;
      const k = (t.kinds[kind] ??= { n: 0, kind: 0, intent: 0, source: 0, confusions: {}, titles: [], titleOnlyIntent: 0 });
      k.n += 1;
      if (lc !== null) {
        const lp = lc.view.prompt;
        if (lp.kind === kind) k.kind += 1;
        else k.confusions[lp.kind] = (k.confusions[lp.kind] ?? 0) + 1;
        const intentOk = lp.intent === ev.view.prompt.intent;
        const sourceOk = lp.sourceCardKey === ev.view.prompt.sourceCardKey;
        if (intentOk) k.intent += 1;
        if ((lp.kind === "target" ? intentOfTitle(lp.title) : lp.intent) === ev.view.prompt.intent) k.titleOnlyIntent += 1;
        if (sourceOk) k.source += 1;
        if ((lp.kind !== kind || !intentOk || !sourceOk) && k.titles.length < 8) {
          const why = `${lp.kind}/${lp.intent ?? "-"}/${lp.sourceCardKey ?? "-"} vs ${kind}/${ev.view.prompt.intent ?? "-"}/${ev.view.prompt.sourceCardKey ?? "-"}: ${lp.title}`;
          if (!k.titles.includes(why)) k.titles.push(why);
        }
        if (liveChosen !== undefined) {
          t.rung1.compared += 1;
          const liveDesc = lc.actions[lc.index].action.descriptor;
          const engineRuled = choice.policy.rung === 1;
          const liveRuled = lc.answeredBy === "rung1";
          if (engineRuled) t.rung1.engineRuled += 1;
          if (liveRuled) t.rung1.liveRuled += 1;
          const diffs = viewDiff(ev.view, lc.view);
          for (const d of diffs) t.fieldDiffs[d] = (t.fieldDiffs[d] ?? 0) + 1;
          if (liveDesc === chosen) {
            t.rung1.same += 1;
            if (engineRuled && liveRuled) t.rung1.bothRuledSame += 1;
          } else {
            const cause = lp.kind !== kind ? "kind" : !intentOk ? "intent" : !sourceOk ? "source" : engineRuled !== liveRuled ? "fallback" : diffs.length > 0 ? `view:${diffs[0]}` : "same-view";
            t.rung1Causes[`${kind}:${cause}`] = (t.rung1Causes[`${kind}:${cause}`] ?? 0) + 1;
          }
          const li = lc.answers.findIndex((a) => a.descriptor === chosen);
          if (li >= 0) bot.builder.record(lc.view, lc.answers[li]);
        }
      } else k.confusions.none = (k.confusions.none ?? 0) + 1;
      engineViews[seat - 1].record(ev.view, ev.answers[choice.index]);

      const other = (3 - seat) as Seat;
      const otherState = viewOf(other);
      if (otherState !== null) {
        t.idleChecks += 1;
        const e = enumerateActions(game, session.players, other, o.cardKeys).map((a) => a.action.descriptor);
        const l = liveActions(otherState, SEAT_IDS, other, o.cardKeys, o.index).actions.map((a) => a.action.descriptor);
        if (e.length === l.length && e.every((d, i) => d === l[i])) t.idleMatch += 1;
        else addMismatch(t, "idle-seat", { promptKind: "idle", onlyEngine: e.filter((d) => !l.includes(d)), onlyLive: l.filter((d) => !e.includes(d)) });
      }
      return false;
    },
  });
  return { endCondition: session.endCondition ?? "error", decisions: session.k, traceSha256: session.traceSha256(), error: session.error };
}
