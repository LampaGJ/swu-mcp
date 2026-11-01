import { describe, expect, it } from "vitest";
import { liveActions, type CardIndex } from "../../src/karabast/player-view.js";
import { parseGameState } from "../../src/karabast/schemas.js";

const INDEX: CardIndex = new Map([
  ["3389903389", { internalName: "black-one#straight-at-them", title: "Black One", subtitle: "Straight At Them", cost: 2, unique: true, keywords: [], unitKeywords: [], types: ["unit"], upgradePower: null, upgradeHp: null, raid: 0, unitRaid: 0, aspects: [] }],
  ["leader-1", { internalName: "the-warrior#deft-duelist", title: "The Warrior", subtitle: "Deft Duelist", cost: 5, unique: true, keywords: [], unitKeywords: [], types: ["leader"], upgradePower: null, upgradeHp: null, raid: 0, unitRaid: 0, aspects: [] }],
]);

const card = (over: Record<string, unknown>) => ({ controllerId: "u1", ownerId: "u1", aspects: [], power: 2, hp: 3, type: "basicUnit", printedType: "basicUnit", isBlanked: false, ...over });

function actionWindow(): unknown {
  const piles = (hand: unknown[]) => ({ hand, outsideTheGame: [], capturedZone: [], resources: [], groundArena: [], spaceArena: [], discard: [], credits: [] });
  return {
    phase: "action",
    players: {
      u1: {
        cardPiles: piles([card({ id: "3389903389", setId: { set: "JTL", number: 147 }, zone: "hand", name: "Black One", uuid: "Card_12", selectable: true, selected: false })]),
        leaders: [card({ id: "leader-1", setId: { set: "LOF", number: 18 }, zone: "base", name: "The Warrior", type: "leader", printedType: "leader", uuid: "Card_3", selectable: true, selected: false })],
        id: "u1",
        numCardsInDeck: 40,
        availableResources: 2,
        hasInitiative: true,
        promptState: { menuTitle: "Choose an action", promptUuid: "p-1", promptType: "actionWindow", buttons: [{ text: "Pass", arg: "pass", command: "menuButton", uuid: "p-1" }], displayCards: [], perCardButtons: [] },
      },
      u2: {
        cardPiles: piles([{ controllerId: "u2", ownerId: "u2", zone: "hand", selectable: false }]),
        leaders: [],
        id: "u2",
        numCardsInDeck: 40,
        availableResources: 2,
        hasInitiative: false,
        promptState: {},
      },
    },
  };
}

describe("karabast player view", () => {
  it("rebuilds the canonical descriptors and the socket commands from per-card selectable flags", () => {
    const state = parseGameState(actionWindow());
    const got = liveActions(state, ["u1", "u2"], 1, {}, INDEX);
    expect(got.actions.map((a) => a.action.descriptor)).toEqual(["act|~the-warrior#deft-duelist|p1.base|0", "pass|-|-|0|Pass", "play|~black-one#straight-at-them|p1.hand|0"]);
    expect(got.actions.map((a) => a.command)).toEqual([
      ["cardClicked", "Card_3"],
      ["menuButton", "pass", "p-1"],
      ["cardClicked", "Card_12"],
    ]);
    expect(got.gaps.hiddenSelectable).toBe(0);
  });

  it("gives the waiting player, viewing its own gamestate, no decision", () => {
    const raw = actionWindow() as { players: Record<string, { promptState: unknown; cardPiles: { hand: { selectable?: boolean }[] }; leaders: { selectable?: boolean }[] }> };
    raw.players.u1.promptState = {};
    for (const c of [...raw.players.u1.cardPiles.hand, ...raw.players.u1.leaders]) c.selectable = false;
    raw.players.u2.promptState = { menuTitle: "Waiting for opponent to take an action or pass", promptUuid: "p-2", buttons: [] };
    expect(liveActions(parseGameState(raw), ["u1", "u2"], 2, {}, INDEX).actions).toEqual([]);
  });

  it("counts a selectable card sent without a uuid instead of guessing it", () => {
    const raw = actionWindow() as { players: Record<string, { cardPiles: { hand: { selectable?: boolean }[] } }> };
    raw.players.u2.cardPiles.hand[0].selectable = true;
    const got = liveActions(parseGameState(raw), ["u1", "u2"], 1, {}, INDEX);
    expect(got.gaps.hiddenSelectable).toBe(1);
    expect(got.actions).toHaveLength(3);
  });

  it("rejects a gamestate carrying a key the pinned server does not send", () => {
    const raw = actionWindow() as { players: Record<string, Record<string, unknown>> };
    raw.players.u1.surpriseField = 1;
    expect(() => parseGameState(raw)).toThrow();
  });
});
