import { describe, expect, it } from "vitest";
import { enumerateActions, hasDecision, promptKindOf } from "../../src/sims/actions.js";
import type { EngineButton, EngineCard, EngineGame, EnginePlayer, EnginePromptView } from "../../src/sims/engine.js";
import { legalActionSchema, legalActionsSha256 } from "../../src/sims/schemas.js";
import { compareCodePoints } from "../../src/swu/canonical.js";

interface Calls {
  log: string[];
}

function fixture(prompt: Partial<EnginePromptView>, selectable: (p: [EnginePlayer, EnginePlayer]) => EngineCard[] = () => [], selectCardMode: string | null = null) {
  const calls: Calls = { log: [] };
  const players = [] as unknown as [EnginePlayer, EnginePlayer];
  const view: EnginePromptView = { promptUuid: "3f1c6a40-b65d-11f0-9a7e-0242ac120002", buttons: [], ...prompt };
  const mk = (id: string): EnginePlayer =>
    ({
      id,
      trackingId: id,
      currentPrompt: () => view,
      promptState: { selectableCards: [] as EngineCard[], selectCardMode },
      getArenaCards: () => [],
      base: { damage: 0 },
    }) as unknown as EnginePlayer;
  players.push(mk("player1"), mk("player2"));
  players[0].promptState.selectableCards = selectable(players);
  const game = {
    cardClicked: (pid: string, uuid: string) => calls.log.push(`click ${pid} ${uuid}`),
    menuButton: (pid: string, arg: string, uuid: string, method?: string) => calls.log.push(`menu ${pid} ${arg} ${uuid} ${method ?? ""}`.trim()),
    perCardMenuButton: (pid: string, arg: string, cardUuid: string, uuid: string) => calls.log.push(`perCard ${pid} ${arg} ${cardUuid} ${uuid}`),
    statefulPromptResults: (pid: string, result: unknown) => calls.log.push(`stateful ${pid} ${JSON.stringify(result)}`),
  } as unknown as EngineGame;
  return { game, players, calls, view };
}

const card = (uuid: string, internalName: string, zoneName: string, controller: EnginePlayer, extra: Partial<EngineCard> = {}): EngineCard =>
  ({ uuid, internalName, zoneName, controller, owner: controller, ...extra }) as EngineCard;

const keys: Record<string, string> = { "wampa#x": "0101111", "cad-bane#he-who-needs-no-introduction": "0201014", "battlefield-marine": "0101095" };

const btn = (text: string, arg: string, disabled = false): EngineButton => ({ text, arg, disabled, uuid: "3f1c6a40-b65d-11f0-9a7e-0242ac120002" });

function check(actions: ReturnType<typeof enumerateActions>) {
  for (const a of actions) legalActionSchema.parse(a.action);
  const ds = actions.map((a) => a.action.descriptor);
  expect([...ds].sort(compareCodePoints)).toEqual(ds);
  expect(new Set(ds).size).toBe(ds.length);
  const text = JSON.stringify(actions.map((a) => a.action));
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  expect(text).not.toMatch(/Card_\d|_\d+"/);
}

describe("canonical legal actions, one fixture per prompt kind", () => {
  it("main action: hand cards play, arena cards act, Pass and Claim Initiative, disabled buttons dropped", () => {
    const { game, players, calls } = fixture(
      { promptType: "actionWindow", buttons: [btn("Pass", "pass"), btn("Claim Initiative", "claimInitiative"), btn("Manual Action", "manual", true)] },
      ([p1, p2]) => [card("Wampa_31", "wampa#x", "groundArena", p1), card("Marine_12", "battlefield-marine", "hand", p1), card("Marine_7", "battlefield-marine", "hand", p1), card("Cad_3", "cad-bane#he-who-needs-no-introduction", "groundArena", p2)],
    );
    const actions = enumerateActions(game, players, 1, keys);
    check(actions);
    expect(promptKindOf(players[0])).toBe("mainAction");
    expect(actions.map((a) => a.action.descriptor)).toEqual([
      "act|0101111|p1.groundArena|0",
      "act|0201014|p2.groundArena|0",
      "pass|-|-|0|Pass",
      "play|0101095|p1.hand|0",
      "play|0101095|p1.hand|1",
      "takeInitiative|-|-|0|Claim Initiative",
    ]);
    actions[3].run(() => 0);
    actions[4].run(() => 0);
    actions[2].run(() => 0);
    expect(calls.log).toEqual(["click player1 Marine_7", "click player1 Marine_12", "menu player1 pass 3f1c6a40-b65d-11f0-9a7e-0242ac120002"]);
  });

  it("mulligan", () => {
    const { game, players } = fixture({ buttons: [btn("Mulligan", "mulligan"), btn("Keep", "keep")] });
    expect(promptKindOf(players[0])).toBe("mulligan");
    const actions = enumerateActions(game, players, 1, keys);
    check(actions);
    expect(actions.map((a) => a.action.descriptor)).toEqual(["mulligan|-|-|0|Keep", "mulligan|-|-|0|Mulligan"]);
  });

  it("resource (multi-select of hand cards with Done)", () => {
    const { game, players } = fixture({ promptType: "resource", buttons: [btn("Done", "done")] }, ([p1]) => [card("Marine_12", "battlefield-marine", "hand", p1), card("Wampa_31", "wampa#x", "hand", p1)], "multiple");
    expect(promptKindOf(players[0])).toBe("resource");
    const actions = enumerateActions(game, players, 1, keys);
    check(actions);
    expect(actions.map((a) => a.action.descriptor)).toEqual(["done|-|-|0|Done", "resource|0101095|p1.hand|0", "resource|0101111|p1.hand|0"]);
  });

  it("target, with an unmapped engine card logged by engine id and cardKey null", () => {
    const { game, players } = fixture({ buttons: [] }, ([p1, p2]) => [card("Shield_40", "shield", "groundArena", p2), card("Wampa_31", "wampa#x", "groundArena", p1)]);
    expect(promptKindOf(players[0])).toBe("target");
    const actions = enumerateActions(game, players, 1, keys);
    check(actions);
    expect(actions.map((a) => a.action.descriptor)).toEqual(["card|0101111|p1.groundArena|0", "card|~shield|p2.groundArena|0"]);
    expect(actions[1].action.cardKey).toBeNull();
    expect(actions[1].action.engineCardId).toBe("shield");
  });

  it("multiSelect", () => {
    const { players } = fixture({ buttons: [btn("Done", "done")] }, ([p1]) => [card("Wampa_31", "wampa#x", "groundArena", p1)], "multiple");
    expect(promptKindOf(players[0])).toBe("multiSelect");
  });

  it("choice: an optional trigger's buttons and a dropdown list", () => {
    const a = fixture({ promptType: "optionalTrigger", buttons: [btn("Trigger the ability", "trigger"), btn("Pass", "pass")] });
    expect(promptKindOf(a.players[0])).toBe("choice");
    check(enumerateActions(a.game, a.players, 1, keys));
    const b = fixture({ dropdownListOptions: ["Vigilance", "Aggression"] });
    const actions = enumerateActions(b.game, b.players, 1, keys);
    check(actions);
    expect(actions.map((x) => x.action.descriptor)).toEqual(["list|-|-|0|Aggression", "list|-|-|0|Vigilance"]);
  });

  it("number", () => {
    const { game, players, calls } = fixture({ selectNumber: { min: 0, max: 2 } });
    expect(promptKindOf(players[0])).toBe("number");
    const actions = enumerateActions(game, players, 1, keys);
    check(actions);
    expect(actions.map((a) => a.action.descriptor)).toEqual(["number|-|-|0|0", "number|-|-|0|1", "number|-|-|0|2"]);
    actions[2].run(() => 0);
    expect(calls.log).toEqual(["menu player1 2 3f1c6a40-b65d-11f0-9a7e-0242ac120002"]);
  });

  it("distribute: one deterministic allocation per lead target, indirect damage capped by remaining HP, the rest to a base", () => {
    const { game, players, calls } = fixture(
      { distributeAmongTargets: { type: "distributeIndirectDamage", amount: 4, isIndirectDamage: true, canDistributeLess: false } },
      ([, p2]) => [card("Wampa_31", "wampa#x", "groundArena", p2, { remainingHp: 2 }), card("Base_2", "battlefield-marine", "base", p2, { isBase: () => true })],
    );
    expect(promptKindOf(players[0])).toBe("distribute");
    const actions = enumerateActions(game, players, 1, keys);
    check(actions);
    expect(actions.map((a) => a.action.descriptor)).toEqual([
      "distribute|-|-|0|distributeIndirectDamage|0101095@p2.base#0=4",
      "distribute|-|-|0|distributeIndirectDamage|0101111@p2.groundArena#0=2,0101095@p2.base#0=2",
    ]);
    expect(actions[1].action.targets.map((t) => t.amount)).toEqual([2, 2]);
    actions[1].run(() => 0);
    expect(calls.log[0]).toBe('stateful player1 {"type":"distributeIndirectDamage","valueDistribution":[{"uuid":"Wampa_31","amount":2},{"uuid":"Base_2","amount":2}]}');
  });

  it("display cards for selection click by card; a display prompt with per-card buttons offers only the buttons (the Card_N fix)", () => {
    const sel = fixture({
      promptType: "displayCards",
      displayCards: [
        { cardUuid: "Wampa_31", internalName: "wampa#x", selectionState: "selectable" },
        { cardUuid: "Marine_12", internalName: "battlefield-marine", selectionState: "invalid" },
      ],
      buttons: [btn("Take nothing", "done")],
    });
    const a = enumerateActions(sel.game, sel.players, 1, keys);
    check(a);
    expect(a.map((x) => x.action.descriptor)).toEqual(["display|0101111|display|0", "done|-|-|0|Take nothing"]);
    a[0].run(() => 0);
    expect(sel.calls.log).toEqual(["menu player1 Wampa_31 3f1c6a40-b65d-11f0-9a7e-0242ac120002 menuButton"]);

    const withButtons = fixture({
      promptType: "displayCards",
      displayCards: [
        { cardUuid: "Wampa_31", internalName: "wampa#x", selectionState: "selectable" },
        { cardUuid: "Marine_12", internalName: "battlefield-marine", selectionState: "selectable" },
      ],
      perCardButtons: [btn("Top", "top"), btn("Bottom", "bottom")],
    });
    const b = enumerateActions(withButtons.game, withButtons.players, 1, keys);
    check(b);
    expect(b.map((x) => x.action.kind)).toEqual(["perCard", "perCard", "perCard", "perCard"]);
    expect(b.map((x) => x.action.descriptor)).toEqual(["perCard|0101095|display|0|Bottom", "perCard|0101095|display|0|Top", "perCard|0101111|display|0|Bottom", "perCard|0101111|display|0|Top"]);
    b[3].run(() => 0);
    expect(withButtons.calls.log).toEqual(["perCard player1 top Wampa_31 3f1c6a40-b65d-11f0-9a7e-0242ac120002"]);
  });

  it("a waiting prompt is no decision", () => {
    const { game, players } = fixture({ menuTitle: "Waiting for opponent", buttons: [] });
    expect(enumerateActions(game, players, 1, keys)).toEqual([]);
    expect(hasDecision(players[0])).toBe(false);
  });

  it("hasDecision agrees with enumeration on every fixture shape", () => {
    const { players } = fixture({ buttons: [btn("Pass", "pass", true)] });
    expect(hasDecision(players[0])).toBe(false);
    const live = fixture({ buttons: [btn("Pass", "pass")] });
    expect(hasDecision(live.players[0])).toBe(true);
  });

  it("legalActionsSha256 is over descriptors only, so it is stable across runs", () => {
    const a = fixture({ selectNumber: { min: 1, max: 2 } });
    const b = fixture({ selectNumber: { min: 1, max: 2 }, promptUuid: "another-uuid" });
    const h = (x: ReturnType<typeof fixture>) => legalActionsSha256(enumerateActions(x.game, x.players, 1, keys).map((y) => y.action.descriptor));
    expect(h(a)).toBe(h(b));
  });
});

describe("byCodePoint", () => {
  it("orders exactly as compareCodePoints, surrogate pairs included", async () => {
    const { byCodePoint } = await import("../../src/sims/actions.js");
    const words = ["", "a", "b", "ab", "a|b", "~shield", "play|0101095|p1.hand|0", "！", "\u{1F600}", "a\u{1F600}", "a￿", "Ä", "z"];
    for (const x of words) for (const y of words) expect(Math.sign(byCodePoint(x, y))).toBe(Math.sign(compareCodePoints(x, y)));
  });
});

describe("descriptors do not depend on NODE_ENV", () => {
  it("drops the '(No effect) ' prefix the engine adds to modal choices only under NODE_ENV=test", () => {
    const under = fixture({ promptType: "modalEffectSelection", buttons: [btn("(No effect) Deal 2 damage to a unit", "0"), btn("Heal 2 damage", "1")] });
    const plain = fixture({ promptType: "modalEffectSelection", buttons: [btn("Deal 2 damage to a unit", "0"), btn("Heal 2 damage", "1")] });
    const d = (x: ReturnType<typeof fixture>) => enumerateActions(x.game, x.players, 1, keys).map((a) => a.action.descriptor);
    expect(d(under)).toEqual(d(plain));
    expect(d(plain)).toEqual(["choose|-|-|0|Deal 2 damage to a unit", "choose|-|-|0|Heal 2 damage"]);
    expect(enumerateActions(under.game, under.players, 1, keys)[0].action.label).toBe("(No effect) Deal 2 damage to a unit");
  });
});
