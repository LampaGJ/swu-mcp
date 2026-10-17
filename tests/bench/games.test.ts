import { describe, expect, it } from "vitest";
import { buildNameIndex, buildSetNumberIndex, engineSlug, normalizeName, type Printing } from "../../scripts/bench/card-map.js";
import {
  foldChunk,
  humanRowSchema,
  newGame,
  resolveWinner,
  rowKey,
  voteSeatOne,
  type HumanRow,
  type TokenResolver,
} from "../../scripts/bench/games.js";

const printing = (over: Partial<Printing>): Printing => ({
  serialCode: "S",
  cardKey: "K",
  expansion: "JTL",
  cardNumber: 1,
  title: "T",
  subtitle: null,
  type: "Unit",
  variantTypes: ["Standard"],
  aspectIcons: [],
  ...over,
});

describe("card identity", () => {
  it("set+number folds printings and lets the main-set numbering beat Weekly Play", () => {
    const index = buildSetNumberIndex([
      printing({ serialCode: "a", cardKey: "A", cardNumber: 14 }),
      printing({ serialCode: "a2", cardKey: "A", cardNumber: 300, variantTypes: ["Hyperspace"] }),
      printing({ serialCode: "w", cardKey: "W", cardNumber: 14, variantTypes: ["Weekly Play"] }),
      printing({ serialCode: "t", cardKey: "T", cardNumber: 15, type: "Token Unit" }),
      printing({ serialCode: "x", cardKey: "X", cardNumber: 16 }),
      printing({ serialCode: "y", cardKey: "Y", cardNumber: 16 }),
    ]);
    expect(index.byId.get("JTL_014")).toBe("A");
    expect(index.byId.get("JTL_300")).toBe("A");
    expect(index.byId.has("JTL_015")).toBe(false);
    expect(index.ambiguous).toEqual(["JTL_016"]);
  });

  it("names normalise accents, quotes and the deck-file separator", () => {
    expect(normalizeName("Chirrut Îmwe | Blind, but not Deaf")).toBe("chirrut imwe, blind, but not deaf");
    const names = buildNameIndex([printing({ cardKey: "C", title: "Chirrut Îmwe", subtitle: "Blind, but not Deaf" })]);
    expect(names.get("chirrut imwe, blind, but not deaf")).toEqual(["C"]);
    expect(names.get("unit::chirrut imwe")).toEqual(["C"]);
    expect(names.get("title::chirrut imwe")).toEqual(["C"]);
  });

  it("engine slugs follow title#subtitle", () => {
    expect(engineSlug("Black One", "Straight at Them")).toBe("black-one#straight-at-them");
    expect(engineSlug("Fleet Lieutenant", null)).toBe("fleet-lieutenant");
    expect(engineSlug("4-LOM", "Bounty Hunter for Hire")).toBe("4lom#bounty-hunter-for-hire");
    expect(engineSlug("Green Squadron A-Wing", null)).toBe("green-squadron-awing");
    expect(engineSlug("Chirrut Îmwe", "Blind, but not Deaf")).toBe("chirrut-imwe#blind-but-not-deaf");
  });
});

const row = (over: Partial<HumanRow["metadata"]>, label = 1): HumanRow =>
  humanRowSchema.parse({
    label,
    metadata: {
      gameId: "g1",
      turn: 1,
      timestamp: "t",
      actionType: "pass",
      activePlayerId: "P",
      opponentPlayerId: "Q",
      activePlayerLeader: "Lead P",
      activePlayerBase: "Base P",
      opponentLeader: "Lead Q",
      opponentBase: "Base Q",
      ...over,
    },
  });

const resolver: TokenResolver = {
  setId: (set, number) => `k:${set}${number}`,
  name: (name) => `k:${name}`,
};

describe("seat voting", () => {
  it("activePlayerUnits is seat 1 even when the other player acts", () => {
    const rows = [
      row({
        actionType: "play_unit",
        cardName: "Alpha",
        activePlayerId: "Q",
        opponentPlayerId: "P",
        activePlayerUnits: [{ name: "Alpha" }],
        opponentUnits: [],
      }),
      row({ actionType: "play_unit", cardName: "Beta", activePlayerUnits: [{ name: "Alpha" }], opponentUnits: [{ name: "Beta, Sub" }] }),
    ];
    expect(voteSeatOne(rows)).toEqual({ seatOne: "Q", agree: 2, disagree: 0 });
  });
});

describe("game folding", () => {
  const rows = [
    row({
      actionType: "play_unit",
      turn: 1,
      timestamp: "1",
      cardName: "S1",
      cardSetId: { set: "S", number: 1 },
      cardPrintedType: "basicUnit",
      activePlayerUnits: [{ name: "S1" }],
      opponentUnits: [],
    }),
    row({
      actionType: "play_unit",
      turn: 2,
      timestamp: "2",
      cardName: "S2",
      cardSetId: { set: "S", number: 2 },
      cardPrintedType: "basicUnit",
      activePlayerUnits: [{ name: "S1" }, { name: "S2" }],
      opponentUnits: [{ name: "S9" }],
    }),
    row({
      actionType: "leader_ability",
      turn: 2,
      timestamp: "3",
      cardName: "Lead P",
      cardSetId: { set: "S", number: 50 },
      cardPrintedType: "leader",
      activePlayerUnits: [{ name: "S1" }, { name: "S2" }],
      opponentUnits: [{ name: "S9" }],
    }),
    row(
      {
        actionType: "pass",
        turn: 3,
        activePlayerId: "Q",
        opponentPlayerId: "P",
        activePlayerLeader: "Lead Q",
        opponentLeader: "Lead P",
        timestamp: "4",
        activePlayerUnits: [{ name: "S1" }, { name: "S2" }],
        opponentUnits: [{ name: "S9" }],
      },
      0,
    ),
  ];

  it("records cards, first-seen turns, played-while-in-play and the leader", () => {
    const game = newGame();
    foldChunk(game, 0, rows, resolver);
    const p = game.sides.get("P");
    expect(p?.cards.get("k:S1")).toBe(1);
    expect(p?.cards.get("k:S2")).toBe(2);
    expect(p?.co.has("k:S1\u0000k:S2")).toBe(true);
    expect(p?.co.has("k:S2\u0000k:S1")).toBe(false);
    expect([...(p?.leaderTokens ?? [])]).toEqual(["k:S50"]);
    expect(game.sides.get("Q")?.cards.has("k:S9")).toBe(true);
  });

  it("merging the same game from two files is idempotent", () => {
    const once = newGame();
    foldChunk(once, 0, rows, resolver);
    const twice = newGame();
    foldChunk(twice, 0, rows, resolver);
    foldChunk(twice, 1, rows.slice(1), resolver);
    expect([...(twice.sides.get("P")?.co ?? [])].sort()).toEqual([...(once.sides.get("P")?.co ?? [])].sort());
    expect(twice.files).toEqual(new Set([0, 1]));
  });

  it("winner: complementary labels resolve, equal labels conflict, one side implies the other", () => {
    const game = newGame();
    foldChunk(game, 0, rows, resolver);
    const resolved = resolveWinner(game);
    expect(resolved.status).toBe("resolved");
    expect(resolved.won.get("P")).toBe(1);
    expect(resolved.won.get("Q")).toBe(0);

    const bad = newGame();
    foldChunk(bad, 0, [rows[0], { ...rows[3], label: 1 }], resolver);
    expect(resolveWinner(bad).status).toBe("conflict");

    const one = newGame();
    foldChunk(one, 0, rows.slice(0, 2), resolver);
    expect(resolveWinner(one)).toEqual({
      status: "one-sided",
      won: new Map([
        ["P", 1],
        ["Q", 0],
      ]),
    });
  });

  it("row keys collide only for the same decision", () => {
    expect(rowKey(rows[0].metadata)).toBe(rowKey(row({ ...rows[0].metadata }).metadata));
    expect(rowKey(rows[0].metadata)).not.toBe(rowKey(rows[1].metadata));
  });
});
