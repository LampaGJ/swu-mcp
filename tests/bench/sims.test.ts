import { describe, expect, it } from "vitest";
import { buildSimDeckIndex, disambiguateByHand, matchSimDeck, openingHands, parseSimHeader } from "../../scripts/bench/sims.js";

const decks = [
  { key: "d1", leader: "L1", base: "B1", names: ["Thrawn - Dockyards"] },
  { key: "d2", leader: "L2", base: "B1", names: ["Thrawn - Dockyards"] },
  { key: "d3", leader: "L1", base: "B1", names: ["Twin", "Thrawn - Dockyards"] },
  { key: "d4", leader: "L3", base: "B3", names: ["Solo"] },
];
const byId = new Map([
  ["JTL_002", "L1"],
  ["JTL_027", "B1"],
  ["SOR_010", "L3"],
  ["SOR_020", "B3"],
]);

describe("sim deck join", () => {
  const index = buildSimDeckIndex(decks);

  it("joins on name, leader and base", () => {
    expect(matchSimDeck(index, byId, { deckName: "Solo", leaderId: "SOR_010", baseId: "SOR_020" })).toEqual({ deck: "d4" });
  });

  it("reports a name shared by two lists with the same leader and base as ambiguous", () => {
    expect(matchSimDeck(index, byId, { deckName: "Thrawn - Dockyards", leaderId: "JTL_002", baseId: "JTL_027" })).toEqual({
      ambiguous: ["d1", "d3"],
    });
  });

  it("unknown names and unmapped leaders do not join", () => {
    expect(matchSimDeck(index, byId, { deckName: "Nope", leaderId: "SOR_010", baseId: "SOR_020" })).toEqual({ unknown: true });
    expect(matchSimDeck(index, byId, { deckName: "Solo", leaderId: "XXX_001", baseId: "SOR_020" })).toEqual({ unknown: true });
  });
});

describe("sim header parse", () => {
  it("reads the fields before initialState without parsing the action log", () => {
    const line = `{"gameId":"a__vs__b__game_1","timestamp":"t","durationMs":5,"format":"premier","player1":{"deckId":"a","deckName":"a","leaderId":"SOR_010","baseId":"SOR_020","cardsPlayed":0},"player2":{"deckId":"b","deckName":"b","leaderId":"SOR_010","baseId":"SOR_020","cardsPlayed":3},"winner":2,"winReason":"base_destroyed","turnCount":4,"initialState":{"huge":[1,2,3]},"actions":[]}`;
    const header = parseSimHeader(line);
    expect(header?.winner).toBe(2);
    expect(header?.player2.cardsPlayed).toBe(3);
    expect(parseSimHeader("not json")).toBeNull();
  });
});

describe("opening-hand disambiguation", () => {
  it("reads each player's pre-mulligan hand", () => {
    const line = `{"actions":[{"actionIndex":1,"turn":1,"phase":"setup","player":1,"type":"mulligan","description":"Keep","timestamp":5,"preActionHand":[{"instanceId":"c1","cardId":"4lom#bounty-hunter-for-hire","attachments":[]},{"cardId":"sneak-attack","attachments":[]}],"hasPlayableTurn1Card":true},{"player":2,"type":"mulligan","description":"Keep","preActionHand":[{"cardId":"wing-leader","attachments":[]}],"hasPlayableTurn1Card":false}]}`;
    expect(openingHands(line)).toEqual(
      new Map([
        [1, ["4lom#bounty-hunter-for-hire", "sneak-attack"]],
        [2, ["wing-leader"]],
      ]),
    );
  });

  it("keeps the candidates holding every resolvable hand card", () => {
    const deckCards = new Map([
      ["d1", new Set(["A", "B"])],
      ["d3", new Set(["A", "C"])],
    ]);
    const slugs = new Map([
      ["a", ["A"]],
      ["c", ["C", "C2"]],
    ]);
    expect(disambiguateByHand(["d1", "d3"], ["a", "c", "unknown-slug"], slugs, deckCards)).toEqual(["d3"]);
    expect(disambiguateByHand(["d1", "d3"], ["a"], slugs, deckCards)).toEqual(["d1", "d3"]);
    expect(disambiguateByHand(["d1", "d3"], ["b-slug"], new Map([["b-slug", ["Z"]]]), deckCards)).toEqual([]);
  });
});
