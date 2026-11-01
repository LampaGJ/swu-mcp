import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCardBridge, type CardBridge } from "../../scripts/sims/card-bridge.js";
import { loadDeck } from "../../scripts/sims/decks.js";
import { loadStore } from "../../src/data.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { installSelectableCardsMemo, loadEngine, startGame, type Engine, type EngineGame } from "../../src/sims/engine.js";
import { buildHeader, chainForHeader, type DeckInput } from "../../src/sims/match.js";
import { Session } from "../../src/sims/session.js";
import { encodeState, rawStateViewSchema, SLOT_NAMES, type EncodedState, type RawStateView } from "../../src/sims/state.js";
import { cardKeyOf, extractStateView, stateViewKeysOf, type StateViewKeys } from "../../src/sims/state-view.js";
import { assertChildOf, compileVocab, parseVocab, type CompiledVocab } from "../../src/sims/vocab.js";
import { canonicalJson } from "../../src/swu/canonical.js";

/** [engine] tests: they need the pinned clone, the 2026-10-31 run, the mault originals and the pinned vocabulary, and skip without them. */
const RUN = "data/runs/2026-10-31";
const RELEASE_RUN = "data/runs/2026-10-30";
const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";
const DECKS = "data/originals/decks/2026-10-17";
const VOCAB = "data/pinned/sim-vocab/2026-10-30.r6.json";
const VOCAB_V2 = "data/pinned/sim-vocab/2026-10-30.r6.v2.json";
const hasEngine =
  existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) &&
  existsSync(path.join(RUN, "replay.json")) &&
  existsSync(path.join(RELEASE_RUN, "llm/cards.toon")) &&
  existsSync(ORIGINALS) &&
  existsSync(DECKS) &&
  existsSync(VOCAB) &&
  existsSync(VOCAB_V2);
const T = { timeout: 60_000 };

/** Engine objects are untyped JavaScript from the forceteki build. */
type AnyObj = any;

type Extractor = (game: EngineGame, seat: 1 | 2, keys: StateViewKeys) => RawStateView;

/** Positions of an encoded state that hold a vocabulary index (never a count or a stat). */
function indexPositions(e: EncodedState): number[] {
  const upgradeCols = ["upgrade1", "upgrade2", "upgrade3"].map((n) => SLOT_NAMES.indexOf(n as (typeof SLOT_NAMES)[number]));
  const card = SLOT_NAMES.indexOf("cardIndex");
  const fromSlots = [...e.slots.me, ...e.slots.opp].flatMap((row) => [row[card], ...upgradeCols.map((c) => row[c])]);
  const hist = [...e.discardHist.me, ...e.discardHist.opp, ...e.libraryHist].map((r) => r[0]);
  return [...fromSlots, ...e.hand, ...hist, ...e.identity.me, ...e.identity.opp];
}

/** Engine methods use decorated accessors, so they must run with the real object as `this`, never the proxy. */
const bound = (t: AnyObj, p: string | symbol): unknown => {
  const v = Reflect.get(t, p, t);
  return typeof v === "function" ? v.bind(t) : v;
};

/** A view of the game whose players answer `hand` and `drawDeck` from the given arrays; everything else is the live engine. */
function withZones(game: EngineGame, zones: Record<string, { hand?: unknown[]; drawDeck?: unknown[] }>): EngineGame {
  const players = new Map<string, AnyObj>();
  const proxied = (id: string): AnyObj => {
    if (!players.has(id)) {
      const real = (game as AnyObj).getPlayerById(id);
      const z = zones[id] ?? {};
      players.set(
        id,
        new Proxy(real, {
          get: (t, p) => (p === "hand" && z.hand ? z.hand : p === "drawDeck" && z.drawDeck ? z.drawDeck : bound(t, p)),
        }),
      );
    }
    return players.get(id);
  };
  return new Proxy(game as AnyObj, {
    get: (t, p) =>
      p === "getPlayerById"
        ? proxied
        : p === "actionPhaseActivePlayer"
          ? t.actionPhaseActivePlayer
            ? proxied(t.actionPhaseActivePlayer.id)
            : null
          : bound(t, p),
  }) as EngineGame;
}

/**
 * Content-level leak check for seat 1. Fails when (a) a vocabulary index of a card held only in the opponent's hand
 * appears in an index position, or (b) swapping cards between the opponent's hand and deck, and reversing the viewer's
 * deck, changes the encoded state.
 */
function leakFailures(
  extract: Extractor,
  game: EngineGame,
  keys: StateViewKeys,
  vocab: CompiledVocab,
  keyOf: (c: AnyObj) => string,
): string[] {
  const failures: string[] = [];
  const g = game as AnyObj;
  const me = g.getPlayerById("player1");
  const opp = g.getPlayerById("player2");
  const encoded = encodeState(extract(game, 1, keys), vocab);
  const arena: AnyObj[] = [...me.getArenaCards(), ...opp.getArenaCards()];
  const elsewhere = new Set<string>(
    [
      ...me.hand,
      ...me.drawDeck,
      ...me.discard,
      ...opp.discard,
      ...arena,
      ...arena.filter((c) => c.isUnit()).flatMap((c) => [...c.upgrades]),
      me.base,
      opp.base,
      me.getSingleLeader(),
      opp.getSingleLeader(),
    ].map(keyOf),
  );
  const hiddenOnly = (opp.hand as AnyObj[]).map(keyOf).filter((k) => !elsewhere.has(k));
  const positions = new Set(indexPositions(encoded));
  for (const k of hiddenOnly) {
    const i = vocab.index.get(k);
    if (i !== undefined && positions.has(i)) failures.push(`opponent-hand card ${k} (index ${i}) appears in the encoded state`);
  }
  const oppHand = [...(opp.hand as AnyObj[])];
  const oppDeck = [...(opp.drawDeck as AnyObj[])];
  if (oppHand.length > 0 && oppDeck.length > 0) [oppHand[0], oppDeck[0]] = [oppDeck[0], oppHand[0]];
  const swapped = withZones(game, {
    player2: { hand: oppHand, drawDeck: oppDeck },
    player1: { drawDeck: [...(me.drawDeck as AnyObj[])].reverse() },
  });
  if (canonicalJson(encodeState(extract(swapped, 1, keys), vocab)) !== canonicalJson(encoded))
    failures.push("swapping opponent hand and deck cards changed the encoded state");
  return failures;
}

describe.skipIf(!hasEngine)("[engine] state view extractor on the pinned forceteki", () => {
  let engine: Engine;
  let bridge: CardBridge;
  let vocab: CompiledVocab;
  let keys: StateViewKeys;
  let decks: [DeckInput, DeckInput];

  beforeAll(() => {
    engine = loadEngine(DEFAULT_FORCETEKI);
    installSelectableCardsMemo(DEFAULT_FORCETEKI);
    bridge = loadCardBridge(RUN, ORIGINALS, DEFAULT_FORCETEKI);
    vocab = compileVocab(parseVocab(JSON.parse(readFileSync(VOCAB, "utf8"))));
    keys = stateViewKeysOf(loadStore(RELEASE_RUN).cards, bridge.engineCardKeys);
    decks = [
      loadDeck(bridge, `${DECKS}/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json`),
      loadDeck(bridge, `${DECKS}/melee-0b373cb2-6dfb-425e-842d-b4a700e2d337.json`),
    ];
  }, 60_000);

  /** Plays rung 0 until `stop` holds at a pending decision; returns the paused session. */
  async function pausedAt(seed: string, stop: (s: Session) => boolean): Promise<Session> {
    const header = buildHeader(
      engine,
      { seed, decks, policies: ["rung0", "rung0"], recordMode: "none", undo: false, codeCommit: "test" },
      bridge.engineCardKeys,
    );
    const started = await startGame(engine, [header.decks[0].engineList, header.decks[1].engineList], {
      engineSeed: header.rng.engineSeed,
      undo: false,
    });
    const session = new Session(started, {
      seed,
      cardKeys: bridge.engineCardKeys,
      chains: [chainForHeader(header.policies[0]), chainForHeader(header.policies[1])],
      recordMode: "none",
      playedMetric: engine.playedMetric,
    });
    session.run({ until: (_p, s) => stop(s) });
    return session;
  }

  const keyOf = (c: AnyObj): string => cardKeyOf(c, keys);

  it("every engine KeywordName is in the pinned vocabulary and encodes to its own bit", () => {
    const { KeywordName } = createRequire(import.meta.url)(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Constants.js")) as {
      KeywordName: Record<string, string>;
    };
    const names = Object.values(KeywordName);
    expect(names.length).toBeGreaterThanOrEqual(17);
    const bits = names.map((n) => vocab.keywordBit.get(n));
    expect(bits.filter((b) => b === undefined)).toEqual([]);
    expect(new Set(bits).size).toBe(names.length);
    expect(bits.every((b) => (b as number) >= 1)).toBe(true);
  });

  it("extracts a parse-valid view at an action-phase decision, with no opponent hand or library and no engine uuid", T, async () => {
    const s = await pausedAt("sv-1", (x) => x.game.currentPhase === "action" && x.game.roundNumber >= 3);
    const view = extractStateView(s.game, 1, keys);
    expect(rawStateViewSchema.parse(view)).toEqual(view);
    expect(Object.keys(view.opp)).not.toContain("hand");
    expect(Object.keys(view.opp)).not.toContain("library");
    expect(JSON.stringify(view)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    const encoded = encodeState(view, vocab);
    expect(encoded.scalars[0]).toBe(s.game.roundNumber);
    // Cards outside the data release are unknown to the stateVersion 1 vocabulary; the count must be exact, never silent.
    const refs = [view.me, view.opp].flatMap((side) => [
      ...side.units.flatMap((u) => [u.cardKey, ...u.upgrades]),
      ...side.discard,
      side.baseCardKey,
      side.leader.cardKey,
    ]);
    const handRefs = view.me.hand;
    const libraryRefs = view.me.library.map((r) => r.cardKey);
    const expected = [...refs, ...handRefs, ...libraryRefs].filter((k) => !vocab.index.has(k)).length;
    expect(encoded.unknown).toBe(expected);
    expect(encoded.unknownKeywords).toBe(0);
    expect([...refs, ...handRefs].every((k) => !k.startsWith("~") || !vocab.index.has(k))).toBe(true);
    expect(canonicalJson(encodeState(extractStateView(s.game, 1, keys), vocab))).toBe(canonicalJson(encoded));
  });

  it("seat swap: the view of seat 2 is the mirror of seat 1 on public fields", T, async () => {
    const s = await pausedAt("sv-2", (x) => x.game.currentPhase === "action" && x.game.roundNumber >= 2);
    const v1 = extractStateView(s.game, 1, keys);
    const v2 = extractStateView(s.game, 2, keys);
    const pub = (side: RawStateView["opp"] | RawStateView["me"]): RawStateView["opp"] => {
      const copy: Record<string, unknown> = { ...side };
      delete copy.hand;
      delete copy.library;
      return copy as RawStateView["opp"];
    };
    const me1 = pub(v1.me);
    const me2 = pub(v2.me);
    expect(pub(v2.opp)).toEqual(pub(me1));
    expect(pub(v1.opp)).toEqual(pub(me2));
    expect(v1.hasInitiative).toBe(!v2.hasInitiative);
  });

  it("content level: no opponent-hand card leaks, and hand/deck swaps leave the encoding byte-identical", T, async () => {
    let checked = 0;
    for (const seed of ["sv-3", "sv-4", "sv-5"]) {
      const s = await pausedAt(
        seed,
        (x) => x.game.currentPhase === "action" && x.game.roundNumber >= 2 && (x.game as AnyObj).getPlayerById("player2").hand.length > 0,
      );
      if (s.ended) continue;
      expect(leakFailures(extractStateView, s.game, keys, vocab, keyOf)).toEqual([]);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("negative control: an extractor that copies the opponent hand into me.discard fails the content test", T, async () => {
    const leaky: Extractor = (game, seat, k) => {
      const v = extractStateView(game, seat, k);
      const opp = (game as AnyObj).getPlayerById(seat === 1 ? "player2" : "player1");
      const discard = [...v.me.discard, ...(opp.hand as AnyObj[]).map(keyOf)];
      return { ...v, me: { ...v.me, discard, discardCount: discard.length } };
    };
    const s = await pausedAt(
      "sv-3",
      (x) => x.game.currentPhase === "action" && x.game.roundNumber >= 2 && (x.game as AnyObj).getPlayerById("player2").hand.length > 0,
    );
    expect(leakFailures(leaky, s.game, keys, vocab, keyOf).length).toBeGreaterThan(0);
  });

  it("revision 2 extends r6 and encodes every card of a tournament-deck state by identity", T, async () => {
    const r6 = parseVocab(JSON.parse(readFileSync(VOCAB, "utf8")));
    const v2 = parseVocab(JSON.parse(readFileSync(VOCAB_V2, "utf8")));
    expect(() => assertChildOf(v2, r6)).not.toThrow();
    const s = await pausedAt("sv-1", (x) => x.game.currentPhase === "action" && x.game.roundNumber >= 3);
    const view = extractStateView(s.game, 1, keys);
    expect(encodeState(view, vocab).unknown).toBeGreaterThan(0);
    expect(encodeState(view, compileVocab(v2)).unknown).toBe(0);
  });

  it("maps engine tokens through the store's token titles", () => {
    expect(keys.tokenKeys.Shield).toBe("04010t04");
    expect(keys.tokenKeys.Experience).toBe("04010t03");
    expect(vocab.index.get(keys.tokenKeys.Shield)).toBe(vocab.index.get("09010t01"));
  });
});
