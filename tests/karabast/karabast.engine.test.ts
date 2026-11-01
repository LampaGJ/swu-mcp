import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORIGINALS, DEFAULT_RUN, loadContext, type SimContext } from "../../scripts/sims/context.js";
import { DEFAULT_DECKS, ladderDecks, ownDeckOf, registerRung1, rung1Bot, rung1Tables } from "../../scripts/karabast/context.js";
import { playLocalGame, startLocalGamenode, type LocalGamenode } from "../../scripts/karabast/local-run.js";
import { loadSocketIoClient } from "../../src/karabast/client.js";
import { emptyTally, playParityGame } from "../../src/karabast/parity.js";
import { loadCardIndex, type CardIndex } from "../../src/karabast/player-view.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import type { DeckInput } from "../../src/sims/match.js";
import type { CardTables } from "../../src/sims/policies/tables.js";

/**
 * Engine-backed karabast client tests, tagged [engine]: they need the pinned forceteki clone (its build, card data
 * and node_modules/socket.io-client), the 2026-10-31 run and the ladder decks, and skip without them. The socket
 * test starts the clone's gamenode on a loopback port (about 5 s) and plays one game.
 */

const hasEngine =
  existsSync(path.join(DEFAULT_FORCETEKI, "build/server/gamenode/index.js")) &&
  existsSync(path.join(DEFAULT_FORCETEKI, "node_modules/socket.io-client/package.json")) &&
  existsSync(path.join(DEFAULT_RUN, "replay.json")) &&
  existsSync(DEFAULT_ORIGINALS) &&
  existsSync(DEFAULT_DECKS);
const T = { timeout: 120_000 };

describe.skipIf(!hasEngine)("[engine] karabast live client on the pinned forceteki", () => {
  let ctx: SimContext;
  let tables: CardTables;
  let index: CardIndex;
  let decks: DeckInput[];
  let owns: string[][];
  let node: LocalGamenode | null = null;

  beforeAll(() => {
    ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    tables = rung1Tables(DEFAULT_RUN);
    registerRung1(tables);
    index = loadCardIndex(DEFAULT_FORCETEKI);
    decks = ladderDecks(ctx, DEFAULT_RUN, DEFAULT_DECKS, DEFAULT_FORCETEKI);
    owns = decks.map((d) => ownDeckOf(d.list, DEFAULT_FORCETEKI));
  }, 120_000);

  afterAll(() => node?.stop());

  it("rebuilds every decision's descriptors and commands from the player view, autoSingleTarget off, without perturbing the game", T, async () => {
    const t = emptyTally();
    const base = { engine: ctx.engine, autoSingleTarget: false, cardKeys: ctx.bridge.engineCardKeys, tables, index, makeBot: () => rung1Bot(tables) };
    for (const [a, b, seed] of [
      [0, 6, "karabast-test:1"],
      [6, 3, "karabast-test:2"],
    ] as const) {
      const one = { ...base, decks: [decks[a], decks[b]] as const, ownDecks: [owns[a], owns[b]] as const, seed };
      const probed = await playParityGame(one, t);
      const plain = await playParityGame({ ...one, probe: false }, emptyTally());
      expect(probed.traceSha256).toBe(plain.traceSha256);
      expect(probed.endCondition).toBe("base_destroyed");
    }
    expect(t.decisions).toBeGreaterThan(100);
    expect(t.schemaFailures).toBe(0);
    expect(t.descriptorMatch).toBe(t.decisions);
    expect(t.idleMatch).toBe(t.idleChecks);
    expect(t.commandMatch).toBe(t.commandChecks);
    expect(t.commandChecks).toBe(t.decisions);
    expect(t.gaps.hiddenSelectable).toBe(0);
    expect(t.rung1.same / t.rung1.compared).toBeGreaterThan(0.9);
  });

  it("plays one game over sockets against the local gamenode with no protocol error, and replays both seats from their streams", T, async () => {
    const out = path.join(REPO_ROOT, "tmp/karabast/test", String(process.pid));
    mkdirSync(out, { recursive: true });
    node = await startLocalGamenode({ forceteki: DEFAULT_FORCETEKI, port: 9600 + (process.pid % 300), out, healthMs: 90_000 });
    const env = {
      node,
      io: loadSocketIoClient(DEFAULT_FORCETEKI).io,
      tables,
      index,
      cardKeys: ctx.bridge.engineCardKeys,
      makeBot: () => rung1Bot(tables),
      forcetekiCommit: ctx.engine.pin.commit,
      out,
      stallMs: 20_000,
      gameMs: 90_000,
      format: "open",
      cardPool: "unlimited",
    };
    const row = await playLocalGame(env, 0, [{ deck: decks[6], own: owns[6] }, { deck: decks[0], own: owns[0] }], false);
    expect(row.protocolErrors).toEqual([]);
    expect(row.serverRejects).toBe(0);
    expect(row.winner).not.toBeNull();
    expect(row.leaks).toBe(0);
    expect(row.replay.map((r) => r.identical)).toEqual([true, true]);
    expect(row.replay.map((r) => r.decisions)).toEqual(row.decisions);
  });
});
