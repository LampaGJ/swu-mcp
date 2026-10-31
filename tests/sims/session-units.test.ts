import { describe, expect, it } from "vitest";
import { startGame, type Engine, type EnginePlayer } from "../../src/sims/engine.js";
import { setupErrorFooter, summarize } from "../../src/sims/match.js";
import { matchFooterSchema, type MatchFooter } from "../../src/sims/schemas.js";
import { decidingSeats, searchLeaf } from "../../src/sims/search-leaf.js";

const list = { leader: { id: "SOR_005", count: 1 }, base: { id: "SOR_025", count: 1 }, deck: [{ id: "SOR_100", count: 3 }], sideboard: [] };

function fakeEngine(calls: string[], opts: { drawInSeed?: boolean } = {}): Engine {
  class FakeGame {
    randomGenerator = { next: () => 0.5, rngState: { i: 0, j: 0, S: [] } };
    setRandomSeed(seed: string) {
      if (opts.drawInSeed === true) this.randomGenerator.next();
      calls.push(`setRandomSeed ${seed}`);
    }
    selectDeck(id: string) {
      calls.push(`selectDeck ${id}`);
      this.randomGenerator.next();
    }
    initialiseTokens() {
      calls.push("initialiseTokens");
    }
    async initialiseAsync() {
      calls.push("initialiseAsync");
      this.randomGenerator.next();
    }
    getPlayerById(id: string) {
      return { id };
    }
  }
  return {
    root: "/fake",
    pin: {} as Engine["pin"],
    warnings: [],
    Game: FakeGame as unknown as Engine["Game"],
    Deck: class {} as unknown as Engine["Deck"],
    getter: { tokenData: {} },
    getUserWithDefaultsSet: (u) => u,
    UndoMode: { Disabled: "d", Free: "f" },
    SnapshotType: { Manual: "m" },
    playedMetric: 0,
  };
}

describe("seeding order (#110)", () => {
  it("seeds the engine RNG before selectDeck and initialiseAsync, and counts every draw after", async () => {
    const calls: string[] = [];
    const { rng } = await startGame(fakeEngine(calls), [list, list], { engineSeed: "engine:9", undo: false });
    expect(calls).toEqual(["setRandomSeed engine:9", "selectDeck player1", "selectDeck player2", "initialiseTokens", "initialiseAsync"]);
    expect(rng).toEqual({ draws: 3, seeded: true });
  });

  it("throws on a draw before the seed is in", async () => {
    await expect(startGame(fakeEngine([], { drawInSeed: true }), [list, list], { engineSeed: "engine:9", undo: false })).rejects.toThrow(/drawn before setRandomSeed/);
  });
});

function player(prompt: Record<string, unknown>, selectable: unknown[] = []): EnginePlayer {
  return { id: "p", trackingId: "p", currentPrompt: () => ({ promptUuid: "u", ...prompt }), promptState: { selectableCards: selectable }, getArenaCards: () => [], base: { damage: 0 } } as unknown as EnginePlayer;
}

describe("engine text mode", () => {
  it("installSelectableCardsMemo refuses to load engine modules before loadEngine pinned NODE_ENV", async () => {
    const { installSelectableCardsMemo, ENGINE_NODE_ENV } = await import("../../src/sims/engine.js");
    expect(ENGINE_NODE_ENV).toBe("test");
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => installSelectableCardsMemo("/nonexistent")).toThrow(/NODE_ENV/);
    } finally {
      process.env.NODE_ENV = was;
    }
  });
});

describe("searchLeaf (#141)", () => {
  const waiting = player({ menuTitle: "Waiting for opponent", buttons: [] });
  const deciding = player({ buttons: [{ text: "Pass", arg: "pass" }] });
  const game = (isEnded: boolean) => ({ isEnded }) as never;

  it("is a leaf when the game is over", () => {
    expect(searchLeaf(game(true), [waiting, waiting])).toBe(true);
  });
  it("is a leaf at the own seat's decision", () => {
    expect(searchLeaf(game(false), [deciding, waiting])).toBe(true);
    expect(decidingSeats([deciding, waiting])).toEqual([1]);
  });
  it("is a leaf at the opponent seat's decision", () => {
    expect(searchLeaf(game(false), [waiting, deciding])).toBe(true);
    expect(decidingSeats([waiting, deciding])).toEqual([2]);
  });
  it("is not a leaf at a prompt where both seats only wait", () => {
    expect(searchLeaf(game(false), [waiting, waiting])).toBe(false);
    expect(decidingSeats([waiting, waiting])).toEqual([]);
  });
});

const footer = (winner: 1 | 2 | null, endCondition: MatchFooter["result"]["endCondition"], error: string | null = null): MatchFooter => ({
  ...setupErrorFooter("x"),
  result: { winner, endCondition, rounds: 10, decisions: 300 },
  error,
  coverage: { decisions: [150, 150], answered: [150, 150] },
});

describe("batch summary counts errors (#142)", () => {
  it("excludes errors, draws and timeouts from the win-share denominator and lists errored seeds", () => {
    const s = summarize([
      { seed: "1", footer: footer(1, "base_destroyed") },
      { seed: "2", footer: footer(1, "base_destroyed") },
      { seed: "3", footer: footer(2, "base_destroyed") },
      { seed: "4", footer: footer(null, "error", "Contract assertion failure: Null-like object value: null") },
      { seed: "5", footer: footer(null, "draw") },
      { seed: "6", footer: footer(null, "timeout") },
    ]);
    expect(s.games).toBe(6);
    expect(s.decided).toBe(3);
    expect(s.wins).toEqual([2, 1]);
    expect(s.winShare).toEqual([0.6667, 0.3333]);
    expect(s.errors).toBe(1);
    expect(s.errorRate).toBe(0.1667);
    expect(s.draws).toBe(1);
    expect(s.timeouts).toBe(1);
    expect(s.errorsBySeed).toEqual([{ seed: "4", error: "Contract assertion failure: Null-like object value: null", decisions: 300 }]);
  });

  it("a game that failed to build is an error record, never dropped", () => {
    const f = matchFooterSchema.parse(setupErrorFooter("Card undefined not found in card map"));
    expect(f.result).toEqual({ winner: null, endCondition: "error", rounds: 0, decisions: 0 });
    expect(f.error).toBe("setup: Card undefined not found in card map");
    expect(summarize([{ seed: "1", footer: f }]).errors).toBe(1);
  });
});
