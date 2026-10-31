/**
 * @displayName forceteki headless game driver (spike)
 * @strategicPurpose Prove that a complete bot-vs-bot Star Wars: Unlimited game can run from two pinned decklists
 * on the forceteki rules engine with no client, lobby or server, and that a seed makes it replayable.
 * @tacticalObjective Loads the compiled engine from a forceteki clone, builds both decks from SWUDB-format lists
 * (SET_NNN ids), seeds the engine RNG and a separate bot RNG, then answers every prompt through a per-seat policy
 * (default: uniformly random legal choice) until a base falls. Returns the result, a final-board summary and a
 * sha256 of the choice trace. Exposes a Session so a caller can pause at a decision and branch.
 *
 * Usage: node scripts/sims/play-game.mjs --deck1 <json> --deck2 <json> [--games N] [--seed S] [--forceteki <dir>] [--trace] [--policy1 random|greedy] [--policy2 random|greedy] [--undo]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const require = createRequire(import.meta.url);
export const DEFAULT_FORCETEKI = "/Volumes/Local Files/Projects/forceteki";
const MAX_PROMPTS = 20000;

export function loadEngine(root = DEFAULT_FORCETEKI) {
  const load = (p) => require(path.join(root, "build", p));
  const { Game } = load("server/game/core/Game.js");
  const { Deck } = load("server/utils/deck/Deck.js");
  const { UnitTestCardDataGetter } = load("server/utils/cardData/UnitTestCardDataGetter.js");
  const { getUserWithDefaultsSet } = load("server/Settings.js");
  const { UndoMode } = load("server/game/core/snapshot/SnapshotManager.js");
  const { SnapshotType } = load("server/game/core/Constants.js");
  const seedrandom = require(path.join(root, "node_modules/seedrandom"));
  const getter = new UnitTestCardDataGetter(path.join(root, "test/json"));
  return { Game, Deck, getter, getUserWithDefaultsSet, UndoMode, SnapshotType, seedrandom };
}

const scheduler = {
  setTimeout: () => ({ cancel: () => undefined }),
  setInterval: () => ({ cancel: () => undefined }),
  now: () => 0,
  currentDate: () => new Date(0),
};

/** Every legal answer to the player's current prompt: data for a policy, plus a closure that submits it. */
export function legalAnswers(game, player) {
  const prompt = player.currentPrompt();
  const ps = player.promptState;
  const out = [];

  const dist = prompt.distributeAmongTargets;
  if (dist) {
    const targets = ps.selectableCards;
    out.push({
      kind: "distribute",
      label: dist.type,
      run: (rnd) => {
        // Units may not receive more indirect damage than they have HP left, so the excess goes to a base.
        const valueDistribution = [];
        let remaining = dist.amount;
        const order = [...targets];
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        for (const c of order) {
          if (remaining <= 0 || (dist.maxTargets && valueDistribution.length >= dist.maxTargets)) break;
          const isBase = c.isBase?.() === true;
          const cap = isBase || !dist.isIndirectDamage ? remaining : Math.min(remaining, c.remainingHp ?? remaining);
          if (cap > 0) {
            valueDistribution.push({ uuid: c.uuid, amount: cap });
            remaining -= cap;
          }
        }
        if (remaining > 0 && !dist.canDistributeLess) {
          const base = targets.find((c) => c.isBase?.() === true) ?? targets[0];
          if (base) {
            const hit = valueDistribution.find((v) => v.uuid === base.uuid);
            if (hit) hit.amount += remaining;
            else valueDistribution.push({ uuid: base.uuid, amount: remaining });
          }
        }
        game.statefulPromptResults(player.id, { type: dist.type, valueDistribution }, prompt.promptUuid);
      },
    });
    return out;
  }

  for (const opt of prompt.dropdownListOptions ?? []) {
    out.push({ kind: "list", label: String(opt), run: () => game.menuButton(player.id, opt, prompt.promptUuid) });
  }
  if (prompt.selectNumber) {
    for (let n = prompt.selectNumber.min; n <= prompt.selectNumber.max; n++) {
      out.push({ kind: "number", label: String(n), run: () => game.menuButton(player.id, String(n), prompt.promptUuid) });
    }
  }
  for (const dc of prompt.displayCards ?? []) {
    if (dc.selectionState === "selectable" || dc.selectionState === "selected") {
      out.push({ kind: "display", label: dc.internalName, run: () => game.menuButton(player.id, dc.cardUuid, prompt.promptUuid, "menuButton") });
    }
    for (const b of prompt.perCardButtons ?? []) {
      if (!b.disabled)
        out.push({
          kind: "perCard",
          label: `${dc.internalName}:${b.arg}`,
          run: () => game.perCardMenuButton(player.id, b.arg, dc.cardUuid, prompt.promptUuid, b.method),
        });
    }
  }
  for (const card of ps.selectableCards ?? []) {
    out.push({ kind: "card", label: card.internalName, card, run: () => game.cardClicked(player.id, card.uuid) });
  }
  for (const b of prompt.buttons ?? []) {
    if (!b.disabled) out.push({ kind: "button", label: String(b.text), run: () => game.menuButton(player.id, b.arg, b.uuid, b.method) });
  }
  // The engine's option order can differ between a live run and a rolled-back one, so order is canonical, not the engine's.
  const key = (a) => `${a.kind}|${a.label}`;
  return out.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

/** Uniformly random choice; multi-select prompts toggle on each click, so Done is taken half the time. */
export const randomPolicy = (answers, ctx) => {
  const done = answers.findIndex((a) => a.kind === "button" && /^(done|continue)$/i.test(a.label));
  if (ctx.multi && done >= 0 && ctx.rnd() < 0.5) return done;
  return Math.floor(ctx.rnd() * answers.length);
};

/**
 * Synthetic scorer standing in for swu-mcp lookups. A card score and a board-pair edge are Map reads, so the
 * cost it adds per decision matches a real table-driven policy; the weights themselves are meaningless.
 */
export function makeGreedyPolicy() {
  const cardScore = new Map();
  const pairScore = new Map();
  const h = (s) => {
    let x = 2166136261;
    for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
    return (x >>> 0) / 4294967296;
  };
  const score = (name) => cardScore.get(name) ?? (cardScore.set(name, h(name)), cardScore.get(name));
  const pair = (a, b) => {
    const k = `${a}|${b}`;
    return pairScore.get(k) ?? (pairScore.set(k, h(k)), pairScore.get(k));
  };
  return (answers, ctx) => {
    if (ctx.multi) return randomPolicy(answers, ctx);
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      let s;
      if (a.kind === "card") {
        const zone = a.card.zoneName;
        s = (zone === "hand" ? 100 + (a.card.cost ?? 0) : 50) + score(a.label);
        for (const other of ctx.board) s += pair(a.label, other);
      } else if (a.kind === "button") s = /^pass$/i.test(a.label) ? 0 : 5;
      else s = 1;
      s += ctx.rnd() * 0.001;
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  };
}

const POLICIES = { random: () => randomPolicy, greedy: makeGreedyPolicy };

const rngFingerprint = (game) => {
  const s = game.randomGenerator.rngState;
  return `${s.i}.${s.j}.${s.S[0]}.${s.S[1]}.${s.S[2]}.${s.S[255]}`;
};

export async function startGame(engine, deck1, deck2, { seed, undo = false }) {
  const { Game, Deck, getter, getUserWithDefaultsSet, UndoMode } = engine;
  const decks = [new Deck(deck1, getter), new Deck(deck2, getter)];
  const game = new Game(
    {
      id: `sim-${seed}`,
      owner: "sim1",
      allowSpectators: false,
      players: [getUserWithDefaultsSet({ id: "player1", username: "sim1" }), getUserWithDefaultsSet({ id: "player2", username: "sim2" })],
      cardDataGetter: getter,
      pushUpdate: () => true,
      scheduler,
      userTimeoutDisconnect: () => undefined,
      undoMode: undo ? UndoMode.Free : UndoMode.Disabled,
    },
    { router: { handleGameEnd: () => undefined, handleUndoGameEnd: () => undefined, handleError: (_g, e) => { throw e; } } },
  );
  game.setRandomSeed(`engine:${seed}`);
  game.selectDeck("player1", decks[0]);
  game.selectDeck("player2", decks[1]);
  game.initialiseTokens(getter.tokenData);
  await game.initialiseAsync();
  return game;
}

/** One game in progress. `k` counts decisions; `log` holds { k, phase, actor, legalActions, chosen, rngCursor } when tracing. */
export class Session {
  constructor(game, { trace = false } = {}) {
    this.game = game;
    this.players = [game.getPlayerById("player1"), game.getPlayerById("player2")];
    this.trace = trace;
    this.k = 0;
    this.hash = createHash("sha256");
    this.log = [];
    this.idle = 0;
    this.endCondition = "base_destroyed";
    this.error = null;
  }

  /** Runs until the game ends, or until `until(session)` returns true before a decision (returns "paused"). */
  run(rnd, { policies = [randomPolicy, randomPolicy], until, maxPrompts = MAX_PROMPTS } = {}) {
    const { game, players } = this;
    try {
      while (!game.isEnded) {
        if (until?.(this)) return "paused";
        if (this.k >= maxPrompts) {
          this.endCondition = "timeout";
          break;
        }
        let acted = false;
        for (const [i, player] of players.entries()) {
          const answers = legalAnswers(game, player);
          if (answers.length === 0) continue;
          const ctx = {
            rnd,
            multi: player.promptState.selectCardMode === "multiple",
            board: policies[i] === randomPolicy ? [] : player.getArenaCards().map((c) => c.internalName),
          };
          const a = answers[policies[i](answers, ctx)];
          const line = `${i + 1}|${a.kind}|${a.label}`;
          this.hash.update(`${line}\n`);
          if (this.trace)
            this.log.push({
              k: this.k,
              phase: game.currentPhase,
              actor: i + 1,
              legalActions: answers.map((x) => `${x.kind}|${x.label}`),
              chosen: line,
              rngCursor: rngFingerprint(game),
            });
          a.run(rnd);
          game.continue();
          this.k++;
          acted = true;
          if (game.isEnded) break;
        }
        if (!acted) {
          game.continue();
          if (++this.idle > 50) {
            this.endCondition = "stuck";
            break;
          }
        } else this.idle = 0;
      }
    } catch (e) {
      this.endCondition = "error";
      this.error = String(e?.message ?? e).slice(0, 300);
    }
    return "ended";
  }

  summary(seed, ms) {
    const names = [...this.game.winnerNames];
    const winner = names.length === 1 ? (names[0] === "sim1" ? 1 : 2) : null;
    return {
      seed,
      winner,
      endCondition: this.endCondition === "base_destroyed" && winner === null ? "draw" : this.endCondition,
      error: this.error,
      rounds: this.game.roundNumber,
      prompts: this.k,
      ms: Math.round(ms * 10) / 10,
      baseDamage: this.players.map((p) => p.base.damage),
      endBoard: this.players.map((p) => p.getArenaCards().map((c) => c.internalName)),
      traceSha256: this.hash.copy().digest("hex"),
    };
  }
}

export async function playGame(engine, deck1, deck2, { seed, trace = false, policies = ["random", "random"], undo = false } = {}) {
  const t0 = performance.now();
  const game = await startGame(engine, deck1, deck2, { seed, undo });
  const session = new Session(game, { trace });
  const rnd = engine.seedrandom(`bot:${seed}`);
  session.run(rnd, { policies: policies.map((p) => POLICIES[p]()) });
  return { ...session.summary(seed, performance.now() - t0), ...(trace ? { decisions: session.log } : {}) };
}

const readDeck = (file) => JSON.parse(readFileSync(file, "utf8"));

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { values } = parseArgs({
    options: {
      deck1: { type: "string" },
      deck2: { type: "string" },
      games: { type: "string", default: "1" },
      seed: { type: "string", default: "1" },
      forceteki: { type: "string", default: DEFAULT_FORCETEKI },
      trace: { type: "boolean", default: false },
      undo: { type: "boolean", default: false },
      policy1: { type: "string", default: "random" },
      policy2: { type: "string", default: "random" },
    },
  });
  if (!values.deck1 || !values.deck2) throw new Error("--deck1 and --deck2 are required");
  const tLoad = performance.now();
  const engine = loadEngine(values.forceteki);
  const loadMs = Math.round(performance.now() - tLoad);
  const d1 = readDeck(values.deck1);
  const d2 = readDeck(values.deck2);
  const n = Number(values.games);
  const t0 = performance.now();
  for (let g = 0; g < n; g++) {
    const r = await playGame(engine, d1, d2, {
      seed: Number(values.seed) + g,
      trace: values.trace,
      undo: values.undo,
      policies: [values.policy1, values.policy2],
    });
    console.log(JSON.stringify(r));
  }
  console.error(JSON.stringify({ loadMs, games: n, wallMs: Math.round(performance.now() - t0) }));
}
