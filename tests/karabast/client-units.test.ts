import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decidable, decisionKey, LiveBot } from "../../src/karabast/bot.js";
import { gamenodeLaunch } from "../../src/karabast/gamenode.js";
import { titleIntent } from "../../src/karabast/live-view.js";
import { classifyMismatch } from "../../src/karabast/parity.js";
import { ownKeywords, type CardIndex } from "../../src/karabast/player-view.js";
import { gameCommandSchema, lobbyCommandSchema, parseGameState } from "../../src/karabast/schemas.js";
import { Scrubber } from "../../src/karabast/scrub.js";
import { parseStream, replayStream, type StreamLine } from "../../src/karabast/stream.js";
import type { CardTables } from "../../src/sims/policies/tables.js";
import { emptyStats, type BotPolicy, type CardView } from "../../src/sims/policies/types.js";
import { REPO_ROOT } from "../../src/paths.js";

/** Synthetic fixtures only: two seats named by token, cards from a two-entry index, a policy that always takes answer 0. */

const INDEX: CardIndex = new Map([
  ["base-1", { internalName: "echo-base", title: "Echo Base", subtitle: null, cost: 0, unique: false, keywords: [], unitKeywords: [], types: ["base"], upgradePower: null, upgradeHp: null, raid: 0, unitRaid: 0, aspects: [] }],
  ["leader-1", { internalName: "the-warrior#deft-duelist", title: "The Warrior", subtitle: "Deft Duelist", cost: 5, unique: true, keywords: [], unitKeywords: [], types: ["leader"], upgradePower: null, upgradeHp: null, raid: 0, unitRaid: 0, aspects: [] }],
  ["unit-1", { internalName: "black-one#straight-at-them", title: "Black One", subtitle: "Straight At Them", cost: 2, unique: true, keywords: ["raid"], unitKeywords: ["raid"], types: ["unit"], upgradePower: null, upgradeHp: null, raid: 1, unitRaid: 1, aspects: [] }],
]);

const TABLES = {
  keyOf: () => null,
  score: () => 0,
  effects: () => ({ removal: false, heal: false }),
  ability: () => ({ sacrificeAction: false, whenDefeated: false, takeInitiativeCost: null }),
  upgradeStats: () => ({ power: 0, hp: 0 }),
  aspects: () => [],
  leaderInclusion: () => 0,
  edgeWeight: () => 0,
  pins: { scoresSha256: "", coefficientsSha256: "", featuresSha256: "", leaderCardsSha256: "", pairsSha256: null, pairPrecisionSha256: null, complementaritySha256: null },
  pairTable: null,
  ambiguousNames: 0,
} satisfies CardTables;

const firstAnswer = (): BotPolicy => ({ id: "first", version: "1", rung: 1, params: {}, choose: () => 0, tryChoose: () => 0, stats: emptyStats() });

const side = (id: string, hand: unknown[], prompt: unknown) => ({
  id,
  cardPiles: { hand, resources: [], groundArena: [], spaceArena: [], discard: [], capturedZone: [], outsideTheGame: [], credits: [] },
  base: { id: "base-1", controllerId: id, ownerId: id, zone: "base", uuid: `${id}-base_1`, type: "base", hp: 30, damage: 0, aspects: [] },
  leaders: [{ id: "leader-1", controllerId: id, ownerId: id, zone: "base", uuid: `${id}-leader_2`, type: "leader", aspects: [] }],
  numCardsInDeck: 40,
  availableResources: 3,
  hasInitiative: id === "seat1",
  promptState: prompt,
});

function actionState(promptUuid: string, selectable: boolean): unknown {
  return {
    phase: "action",
    players: {
      seat1: side("seat1", [{ id: "unit-1", controllerId: "seat1", ownerId: "seat1", zone: "hand", uuid: "Card_12", type: "basicUnit", hp: 3, power: 2, selectable }], {
        menuTitle: "Choose an action",
        promptUuid,
        promptType: "actionWindow",
        buttons: [{ text: "Pass", arg: "pass", command: "menuButton", uuid: promptUuid }],
      }),
      seat2: side("seat2", [{ controllerId: "seat2", ownerId: "seat2", zone: "hand" }], {}),
    },
  };
}

const bot = () => new LiveBot({ seat: 1, seatIds: ["seat1", "seat2"], seed: "unit", policy: firstAnswer(), tables: TABLES, index: INDEX, cardKeys: {}, ownDeck: ["black-one#straight-at-them"] });

describe("karabast client units", () => {
  it("scrubs user ids, server usernames and learned ids from values and keys, and reports leaks", () => {
    const id = "a1881248-79d5-473f-87f5-9bff0388d818";
    const s = new Scrubber([{ id, token: "seat1" }]);
    s.learn("92ad80eb-2bd5-4bb4-a0ec-8bd9b69d4811", "lobby");
    const raw = { players: { [id]: { name: "anonymous a18812", link: "https://x/lobby?lobbyId=92ad80eb-2bd5-4bb4-a0ec-8bd9b69d4811" } }, card: "Card_12" };
    const out = s.scrub(raw);
    expect(out).toEqual({ players: { seat1: { name: "seat1", link: "https://x/lobby?lobbyId=lobby" } }, card: "Card_12" });
    expect(s.leaks(JSON.stringify(out))).toEqual([]);
    expect(s.leaks(JSON.stringify(raw)).length).toBe(3);
  });

  it("answers a decision once: a repeated gamestate with the same prompt and flags is not answered again", () => {
    const b = bot();
    const st = parseGameState(actionState("p-1", true));
    expect(b.onState(st)?.descriptor).toBe("pass|-|-|0|Pass");
    expect(b.onState(st)).toBeNull();
    expect(b.onState(parseGameState(actionState("p-2", true)))?.k).toBe(1);
    expect(decisionKey(st, "seat1")).not.toBe(decisionKey(parseGameState(actionState("p-1", false)), "seat1"));
  });

  it("replays a recorded stream to the same commands, and flags a command that differs", () => {
    const b = bot();
    const lines: StreamLine[] = [{ kind: "header", version: 1, seat: 1, seatIds: ["seat1", "seat2"], seed: "unit", policy: "first", ownDeck: ["black-one#straight-at-them"], autoSingleTarget: false, forcetekiCommit: "x" }];
    let seq = 0;
    for (const p of ["p-1", "p-1", "p-2", "p-3", "p-4"]) {
      const raw = actionState(p, p !== "p-3") as { winners?: string[] };
      if (p === "p-4") raw.winners = ["seat2"];
      lines.push({ kind: "in", seq: seq++, event: "gamestate", payload: raw });
      const st = parseGameState(raw);
      if (!decidable(st)) continue;
      const d = b.onState(st);
      if (d !== null) lines.push({ kind: "out", seq: seq++, channel: "game", args: d.command as unknown[], k: d.k, descriptor: d.descriptor });
    }
    lines.push({ kind: "footer", winner: null, decisions: b.k, traceSha256: b.traceSha256(), protocolErrors: [] });
    const text = lines.map((l) => JSON.stringify(l)).join("\n");
    const ctx = { tables: TABLES, index: INDEX, cardKeys: {}, makePolicy: firstAnswer };
    const ok = replayStream(parseStream(text), ctx);
    expect(ok).toMatchObject({ decisions: 3, recorded: 3, mismatches: [] });
    expect(ok.traceSha256).toBe(ok.recordedTraceSha256);
    const tampered = parseStream(text.replace('"args":["menuButton","pass","p-2"]', '"args":["cardClicked","Card_12"]'));
    expect(replayStream(tampered, ctx).mismatches).toEqual([{ k: 1, recorded: '["cardClicked","Card_12"]', replayed: '["menuButton","pass","p-2"]' }]);
  });

  it("refuses commands outside the server allowlist shapes", () => {
    expect(gameCommandSchema.safeParse(["cardClicked", "Card_1"]).success).toBe(true);
    expect(gameCommandSchema.safeParse(["concede"]).success).toBe(false);
    expect(gameCommandSchema.safeParse(["rollbackToSnapshot", {}]).success).toBe(false);
    expect(lobbyCommandSchema.safeParse(["startGameAsync"]).success).toBe(true);
    expect(lobbyCommandSchema.safeParse(["submitReport", "playerReport"]).success).toBe(false);
  });

  it("reads target intent from titles the bare intentOfTitle misreads", () => {
    const upgrade = (power: number, hp: number) => ({ upgradePower: power, upgradeHp: hp }) as CardView;
    expect(titleIntent("Heal 2 damage from a base", false, undefined)).toBe("help");
    expect(titleIntent("Attach Craving Power to a unit", false, upgrade(2, 0))).toBe("help");
    expect(titleIntent("Attach Ion Cannon to a unit", false, upgrade(-2, -1))).toBe("harm");
    expect(titleIntent("Disclose Aggression to choose a unit", false, undefined)).toBe("reveal");
    expect(titleIntent("Give a Weakness token to an enemy unit", false, undefined)).toBe("help");
    expect(titleIntent("Defeat a friendly unit", true, undefined)).toBe("defeatOwn");
    expect(titleIntent("Deal 2 damage to a unit", false, undefined)).toBe("harm");
  });

  it("counts only keywords a card has on its own, not ones its text grants conditionally or to another card", () => {
    expect(ownKeywords("Grit\nRaid 1\nWhile this unit is undamaged it gains Sentinel.", ["grit", "raid", "sentinel"])).toEqual({ keywords: ["grit", "raid"], raid: 1 });
    expect(ownKeywords("Bounty — Deal 3 damage to a unit.\nSmuggle—[5 resources, Cunning]", ["bounty", "smuggle"])).toEqual({ keywords: ["bounty", "smuggle"], raid: 0 });
    expect(ownKeywords("Attached unit gains Raid 2 and Restore 1.", ["raid", "restore"])).toEqual({ keywords: [], raid: 0 });
    expect(ownKeywords("Ambush, Overwhelm", ["ambush", "overwhelm"])).toEqual({ keywords: ["ambush", "overwhelm"], raid: 0 });
    expect(ownKeywords("Shielded (When you play this unit, give a Shield token to it.)\nRaid 3 (This unit gets +3/+0 while attacking.)", ["shielded", "raid"])).toEqual({ keywords: ["raid", "shielded"], raid: 3 });
  });

  it("classifies descriptor mismatches", () => {
    expect(classifyMismatch(["card|~x|p2.resource|0"], [], 1)).toBe("hidden-selectable");
    expect(classifyMismatch(["card|~x|p1.deck|0"], [], 0)).toBe("deck-card-not-sent");
    expect(classifyMismatch([], ["card|~?123|p1.hand|0"], 0)).toBe("unmapped-card");
    expect(classifyMismatch(["play|~x|p1.hand|1"], ["play|~x|p1.hand|0"], 0)).toBe("ordinal");
    expect(classifyMismatch(["pass|-|-|0|Pass"], [], 0)).toBe("missing-in-live");
  });

  it("launches the gamenode with every setting in the environment and no inherited secrets", () => {
    const l = gamenodeLaunch({ forcetekiRoot: "/clone", guard: "/guard.cjs", port: 9600, node: "/node", inherit: { PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x", DISCORD_BUG_REPORT_WEBHOOK_URL: "y", NODE_ENV: "test" } });
    expect(l.args).toEqual(["--require", "/guard.cjs", "/clone/build/server/gamenode/index.js"]);
    expect(l.env).toEqual({ PATH: "/bin", NODE_ENV: "development", ENVIRONMENT: "development", GAME_NODE_HOST: "127.0.0.1", GAME_NODE_NAME: "swu-mcp-local", NEXTAUTH_SECRET: "swu-mcp-local-only", GAME_NODE_SOCKET_IO_PORT: "9600" });
  });

  it("the loopback guard refuses a non-loopback connection and binds a port-only listen to 127.0.0.1", () => {
    const guard = path.join(REPO_ROOT, "scripts/karabast/loopback-guard.cjs");
    const script = [
      'const net = require("node:net");',
      'let refused = "no";',
      'try { net.connect({ host: "192.0.2.1", port: 8080 }); } catch (e) { refused = e.message; }',
      'const s = net.createServer().listen(0, () => { console.log(JSON.stringify({ refused, address: s.address().address })); s.close(); });',
    ].join("\n");
    const out = JSON.parse(execFileSync(process.execPath, ["--require", guard, "-e", script], { encoding: "utf8" })) as { refused: string; address: string };
    expect(out.refused).toMatch(/loopback-guard: refused a connection to 192\.0\.2\.1/);
    expect(out.address).toBe("127.0.0.1");
  });
});
