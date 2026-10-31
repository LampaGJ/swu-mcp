import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../swu/canonical.js";
import { DEFAULT_FORCETEKI, readPin, verifyEngine, type EnginePin } from "./engine-pin.js";
import type { EngineList, RngCursor } from "./schemas.js";

/**
 * @displayName forceteki engine adapter
 * @strategicPurpose One place where swu-mcp touches the compiled rules engine (#110): the clone is loaded only after
 * it verifies against the pin, the engine RNG is seeded before its first draw, and every draw is counted in our
 * adapter rather than by an engine edit.
 * @tacticalObjective Structural types for the engine objects the driver reads, `loadEngine` (pin-verified require of
 * the clone's build), the ActionWindow sweep memo, `startGame` and the rngCursor fingerprint.
 */

export interface EngineButton {
  text: unknown;
  arg: string;
  disabled?: boolean;
  uuid?: string;
  method?: string;
  command?: string;
}

export interface EngineDisplayCard {
  cardUuid: string;
  internalName: string;
  selectionState: string;
}

export interface EngineDistribute {
  type: string;
  amount: number;
  maxTargets?: number;
  canDistributeLess?: boolean;
  isIndirectDamage?: boolean;
}

export interface EnginePromptView {
  promptUuid: string;
  promptType?: string | null;
  menuTitle?: string;
  buttons?: EngineButton[];
  selectCardMode?: string | null;
  selectNumber?: { min: number; max: number } | null;
  distributeAmongTargets?: EngineDistribute | null;
  dropdownListOptions?: string[];
  displayCards?: EngineDisplayCard[];
  perCardButtons?: EngineButton[];
}

export interface EngineCard {
  uuid: string;
  internalName: string;
  zoneName: string;
  controller: EnginePlayer;
  owner: EnginePlayer;
  remainingHp?: number;
  isBase?: () => boolean;
}

export interface EnginePlayer {
  id: string;
  trackingId: string;
  currentPrompt(): EnginePromptView;
  promptState: { selectableCards: EngineCard[]; selectCardMode?: string | null };
  getArenaCards(): EngineCard[];
  base: { damage: number };
}

export interface EngineRandom {
  next(): number;
  readonly rngState: unknown;
}

export interface EngineGame {
  readonly isEnded: boolean;
  readonly winnerNames: readonly string[];
  readonly currentPhase: string | null;
  readonly roundNumber: number;
  readonly randomGenerator: EngineRandom;
  readonly statsTracker: { cardMetrics: readonly { metric: number; cardInternalName: string; player: string }[] };
  readonly snapshotManager: { currentSnapshotId: unknown };
  readonly actionPhaseActivePlayer: EnginePlayer | null;
  getPlayerById(id: string): EnginePlayer;
  cardClicked(playerId: string, cardUuid: string): unknown;
  menuButton(playerId: string, arg: string, uuid: string, method?: string): unknown;
  perCardMenuButton(playerId: string, arg: string, cardUuid: string, uuid: string, method?: string): unknown;
  statefulPromptResults(playerId: string, result: unknown, uuid: string): unknown;
  continue(): unknown;
  setRandomSeed(seed: string): void;
  selectDeck(playerId: string, deck: unknown): void;
  initialiseTokens(tokenData: unknown): void;
  initialiseAsync(): Promise<void>;
  takeManualSnapshot(player: EnginePlayer): number;
  rollbackToSnapshot(playerId: string, settings: unknown): boolean;
}

export interface Engine {
  root: string;
  pin: EnginePin;
  /** Verification warnings (a Node other than the pinned one); empty when not verified. */
  warnings: string[];
  Game: new (config: unknown, options: unknown) => EngineGame;
  Deck: new (list: unknown, getter: unknown) => unknown;
  getter: { tokenData: unknown };
  getUserWithDefaultsSet: (user: { id: string; username: string }) => unknown;
  UndoMode: { Disabled: unknown; Free: unknown };
  SnapshotType: { Manual: unknown };
  /** GameCardMetric.Played in the engine's statistics tracker. */
  playedMetric: number;
}

const require = createRequire(import.meta.url);

/**
 * forceteki words prompts by NODE_ENV, some of it fixed when a module loads (TextHelper.ts:35-37,
 * ModalEffectSelectionPrompt.ts:69, ActionSelectionPrompt), and descriptors carry that text, so the same seed
 * played under vitest and under a CLI diverged. The engine always runs in test mode, the mode its own spec suite
 * uses, which also makes a failed rollback throw instead of being logged.
 */
export const ENGINE_NODE_ENV = "test" as const;

function pinEngineEnv(warnings: string[]): void {
  if (process.env.NODE_ENV === ENGINE_NODE_ENV) return;
  if (process.env.NODE_ENV !== undefined) warnings.push(`NODE_ENV was ${process.env.NODE_ENV}; set to ${ENGINE_NODE_ENV} for the engine, whose prompt text depends on it`);
  process.env.NODE_ENV = ENGINE_NODE_ENV;
}

/**
 * Loads the compiled engine from the clone. `verify` checks the clone against the pin first (commit, card-data
 * version, card-data content hash, build) and throws on any mismatch; a worker whose parent already verified
 * passes false, because hashing 2,500 card files per worker costs more than it proves.
 */
export function loadEngine(root: string = DEFAULT_FORCETEKI, opts: { pin?: EnginePin; verify?: boolean; head?: (root: string) => string | null } = {}): Engine {
  const pin = opts.pin ?? readPin();
  const warnings: string[] = [];
  if (opts.verify !== false) {
    const head = opts.head ?? ((r: string) => execFileSync("git", ["-C", r, "rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    const v = verifyEngine(root, pin, { head, nodeVersion: process.version });
    if (v.problems.length > 0) throw new Error(`forceteki clone does not match the pin:\n- ${v.problems.join("\n- ")}`);
    warnings.push(...v.warnings);
  }
  pinEngineEnv(warnings);
  const load = (p: string): Record<string, unknown> => require(path.join(root, "build", p)) as Record<string, unknown>;
  const { Game } = load("server/game/core/Game.js");
  const { Deck } = load("server/utils/deck/Deck.js");
  const { UnitTestCardDataGetter } = load("server/utils/cardData/UnitTestCardDataGetter.js") as { UnitTestCardDataGetter: new (dir: string) => { tokenData: unknown } };
  const { getUserWithDefaultsSet } = load("server/Settings.js");
  const { UndoMode } = load("server/game/core/snapshot/SnapshotManager.js");
  const { SnapshotType } = load("server/game/core/Constants.js");
  const { GameCardMetric } = load("server/gameStatistics/GameStatisticsTracker.js") as { GameCardMetric: { Played: number } };
  return {
    root,
    pin,
    warnings,
    Game: Game as Engine["Game"],
    Deck: Deck as Engine["Deck"],
    getter: new UnitTestCardDataGetter(path.join(root, "test/json")),
    getUserWithDefaultsSet: getUserWithDefaultsSet as Engine["getUserWithDefaultsSet"],
    UndoMode: UndoMode as Engine["UndoMode"],
    SnapshotType: SnapshotType as Engine["SnapshotType"],
    playedMetric: GameCardMetric.Played,
  };
}

/**
 * ActionWindow.continue() sweeps every card for legal actions twice per prompt on unchanged state (once via
 * setPrompt, once in highlightSelectableCards); this reuses the first sweep inside one continue() only. A runtime
 * prototype patch, measured -25% CPU per game with identical traces (docs/research/sim-compute-measurements.md);
 * the clone's files are not touched, and it throws if the private method's shape changed.
 */
export function installSelectableCardsMemo(root: string = DEFAULT_FORCETEKI): void {
  if (process.env.NODE_ENV !== ENGINE_NODE_ENV) throw new Error(`NODE_ENV is ${String(process.env.NODE_ENV)}; call loadEngine first, it pins the engine's text mode before any engine module loads`);
  const { ActionWindow } = require(path.join(root, "build/server/game/core/gameSteps/ActionWindow.js")) as { ActionWindow: { prototype: Record<string, unknown> } };
  const proto = ActionWindow.prototype;
  const sweep = proto.getSelectableCards;
  const cont = proto.continue;
  if (typeof sweep !== "function" || typeof cont !== "function") throw new Error("ActionWindow shape changed; memo not installed");
  if (proto.__selectableMemo === true) return;
  proto.__selectableMemo = true;
  type Memo = { _memo?: unknown; _inContinue?: boolean };
  proto.getSelectableCards = function (this: Memo) {
    if (this._memo !== undefined) return this._memo;
    const r: unknown = (sweep as (this: Memo) => unknown).call(this);
    if (this._inContinue === true) this._memo = r;
    return r;
  };
  proto.continue = function (this: Memo) {
    this._inContinue = true;
    this._memo = undefined;
    try {
      return (cont as (this: Memo) => unknown).call(this);
    } finally {
      this._inContinue = false;
      this._memo = undefined;
    }
  };
}

/** Logical CPUs in the top performance class (hw.perflevel0); falls back to availableParallelism. */
export function topCoreClassSize(): number {
  try {
    const n = Number(execFileSync("sysctl", ["-n", "hw.perflevel0.logicalcpu"], { encoding: "utf8" }).trim());
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // no sysctl on this platform; availableParallelism below
  }
  return os.availableParallelism();
}

/** Worker heap caps: 12 warm workers fall from 3.4 to 3.6 GB RSS to about 1.5 GB at the same batch time (measured). */
export const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 24 };

const scheduler = {
  setTimeout: () => ({ cancel: () => undefined }),
  setInterval: () => ({ cancel: () => undefined }),
  now: () => 0,
  currentDate: () => new Date(0),
};

export interface RngCounter {
  draws: number;
  seeded: boolean;
}

export interface StartedGame {
  game: EngineGame;
  players: [EnginePlayer, EnginePlayer];
  rng: RngCounter;
}

/**
 * Builds and initialises a game. The engine constructs its generator unseeded (forceteki Game.ts:454) and the first
 * coin flip and shuffles happen inside initialiseAsync, so the seed goes in before selectDeck; the counting wrapper
 * throws on any draw before the seed, which would be unreplayable entropy.
 */
export async function startGame(engine: Engine, lists: readonly [EngineList, EngineList], opts: { engineSeed: string; undo: boolean }): Promise<StartedGame> {
  const { Game, Deck, getter, getUserWithDefaultsSet, UndoMode } = engine;
  const decks = lists.map((l) => new Deck(l, getter));
  const game = new Game(
    {
      id: "sim",
      owner: "sim1",
      allowSpectators: false,
      players: [getUserWithDefaultsSet({ id: "player1", username: "sim1" }), getUserWithDefaultsSet({ id: "player2", username: "sim2" })],
      cardDataGetter: getter,
      pushUpdate: () => true,
      scheduler,
      userTimeoutDisconnect: () => undefined,
      undoMode: opts.undo ? UndoMode.Free : UndoMode.Disabled,
    },
    {
      router: {
        handleGameEnd: () => undefined,
        handleUndoGameEnd: () => undefined,
        handleError: (_g: unknown, e: unknown) => {
          throw e;
        },
      },
    },
  );
  const rng: RngCounter = { draws: 0, seeded: false };
  const generator = game.randomGenerator as EngineRandom & { next: () => number };
  const next = generator.next.bind(generator);
  generator.next = () => {
    if (!rng.seeded) throw new Error("engine RNG drawn before setRandomSeed; the draw could not be replayed");
    rng.draws += 1;
    return next();
  };
  game.setRandomSeed(opts.engineSeed);
  rng.seeded = true;
  game.selectDeck("player1", decks[0]);
  game.selectDeck("player2", decks[1]);
  game.initialiseTokens(getter.tokenData);
  await game.initialiseAsync();
  return { game, players: [game.getPlayerById("player1"), game.getPlayerById("player2")], rng };
}

/**
 * First 16 hex of sha256 over the full seedrandom state (i, j and all 256 S words), stronger than a sample of it.
 * The ARC4 state is encoded directly (canonicalJson costs about 11 µs a decision); any other shape falls back.
 */
export function engineStateSha(game: EngineGame): string {
  const st = game.randomGenerator.rngState as { i?: unknown; j?: unknown; S?: unknown };
  const arc4 = typeof st.i === "number" && typeof st.j === "number" && Array.isArray(st.S) && Object.keys(st).length === 3;
  return sha256Hex(arc4 ? `arc4:${st.i},${st.j},${(st.S as number[]).join(",")}` : canonicalJson(st)).slice(0, 16);
}

export const rngCursor = (game: EngineGame, rng: RngCounter, botDraws: number): RngCursor => ({ engineDraws: rng.draws, engineStateSha: engineStateSha(game), botDraws });
