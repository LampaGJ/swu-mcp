import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadContext, DEFAULT_ORIGINALS, DEFAULT_RUN, type SimContext } from "../../../scripts/sims/context.js";
import { prepareDeck } from "../../../scripts/sims/decks.js";
import { REPO_ROOT } from "../../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../../src/sims/engine-pin.js";
import { startGame } from "../../../src/sims/engine.js";
import { playMatch, replayMatch, type DeckInput, type MatchSpec } from "../../../src/sims/match.js";
import { POLICIES, PolicyChain } from "../../../src/sims/policy.js";
import { determinize, type MonteCarloCounters } from "../../../src/sims/policies/flat-mc.js";
import type { LookaheadCounters } from "../../../src/sims/policies/rung3.js";
import { registerRungs } from "../../../src/sims/policies/typed-adapter.js";
import { decidingSeats } from "../../../src/sims/search-leaf.js";
import { Session, stateFingerprint } from "../../../src/sims/session.js";
import { loadTables } from "../../../src/sims/policies/tables.js";

/**
 * [engine] Rung 3 on the pinned forceteki: needs the clone, the 2026-10-31 run and the mault originals, skips without.
 * One rung 3 game with K = 3 costs a few seconds on one thread.
 */

const hasEngine = existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(DEFAULT_RUN, "replay.json")) && existsSync(DEFAULT_ORIGINALS);
const NAMES = ["rung1", "rung3:k=1", "rung3", "rung3:horizon=reply", "rung3mc:n=2", "rung3mc:n=1,playout=rung1"];

describe.skipIf(!hasEngine)("[engine] rung 3 lookahead on engine snapshots", () => {
  let ctx: SimContext;
  let warrior: DeckInput;
  let cadBane: DeckInput;
  const spec = (seed: string, policies: [string, string], over: Partial<MatchSpec> = {}): MatchSpec => ({ seed, decks: [warrior, cadBane], policies, recordMode: "compact", undo: true, codeCommit: "test", ...over });

  beforeAll(() => {
    ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    const tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), NAMES, tables);
    const deck = (rel: string) => prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")), `file:${rel}`);
    warrior = deck("tests/fixtures/decks/warrior-chewie-raid.swudb.json");
    cadBane = deck("data/originals/decks/2026-10-17/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json");
  }, 60_000);

  it("undo mode does not change rung 1's trace, and rung 3 with K = 1 plays rung 1's trace exactly", { timeout: 60_000 }, async () => {
    const keys = ctx.bridge.engineCardKeys;
    const off = (await playMatch(ctx.engine, spec("21", ["rung1", "rung1"], { undo: false }), keys)).record.footer;
    const on = (await playMatch(ctx.engine, spec("21", ["rung1", "rung1"]), keys)).record.footer;
    const k1 = (await playMatch(ctx.engine, spec("21", ["rung3:k=1", "rung1"]), keys)).record.footer;
    expect(off.result.endCondition).toBe("base_destroyed");
    expect(on.traceSha256).toBe(off.traceSha256);
    expect(k1.traceSha256).toBe(off.traceSha256);
  });

  it("refuses to search with undo off instead of playing on a state it cannot restore", { timeout: 60_000 }, async () => {
    const r = (await playMatch(ctx.engine, spec("22", ["rung3", "rung1"], { undo: false }), ctx.bridge.engineCardKeys)).record.footer;
    expect(r.result.endCondition).toBe("error");
    expect(r.error).toMatch(/undo mode is off/);
  });

  for (const name of ["rung3", "rung3:horizon=reply", "rung3mc:n=2", "rung3mc:n=1,playout=rung1"]) {
    it(`${name}: every rollback restores the full state fingerprint, and the record replays by descriptor with no trials to the same trace (replay oracle)`, { timeout: 120_000 }, async () => {
      const keys = ctx.bridge.engineCardKeys;
      const played = await playMatch(ctx.engine, spec("23", [name, "rung1"]), keys, { verifyRollback: true });
      const { record, session } = played;
      expect(record.footer.error).toBeNull();
      expect(record.footer.result.endCondition).toBe("base_destroyed");
      if (session === null) throw new Error("no session");
      const counters = (session.opts.chains[0].top as unknown as { counters: LookaheadCounters & MonteCarloCounters }).counters;
      expect(counters.searches).toBeGreaterThan(5);
      if (name.startsWith("rung3mc")) {
        expect(counters.playouts).toBeGreaterThanOrEqual(2 * counters.searches);
        expect(counters.playoutErrors).toBe(0);
        expect(session.search.rollbacks).toBeGreaterThanOrEqual(counters.playouts);
      } else {
        expect(counters.trials).toBeGreaterThanOrEqual(2 * counters.searches);
        expect(session.search.rollbacks).toBe(counters.trials);
      }
      expect(session.search.verified).toBe(session.search.rollbacks);
      const oracle = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys, { byDescriptor: true });
      expect(oracle.mismatch).toBeNull();
      expect(oracle.traceSha256).toBe(record.footer.traceSha256);
      const again = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys);
      expect(again.mismatch).toBeNull();
    });
  }
});

describe.skipIf(!hasEngine)("[engine] flat Monte Carlo determinization", () => {
  it("samples the hidden zones by key: same key same world, opponent hand size and our hand kept, the real state back on rollback", { timeout: 60_000 }, async () => {
    const ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    const tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), ["rung1"], tables);
    const deck = prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")), "file:w");
    const started = await startGame(ctx.engine, [deck.list, deck.list], { engineSeed: "engine:31", undo: true });
    const keys = ctx.bridge.engineCardKeys;
    const session = new Session(started, { seed: "31", cardKeys: keys, chains: [POLICIES.rung1() as never, POLICIES.rung1() as never], recordMode: "none", playedMetric: ctx.engine.playedMetric, manualSnapshotType: ctx.engine.SnapshotType.Manual });
    session.run({ until: (p) => p.promptKind === "mainAction" && p.k > 40 });
    expect(session.ended).toBe(false);
    const seat = decidingSeats(started.players)[0];
    const [me, opp] = (seat === 1 ? started.players : [started.players[1], started.players[0]]) as unknown as { hand: { uuid: string }[]; drawDeck: { uuid: string }[] }[];
    const ids = (cs: { uuid: string }[]) => cs.map((c) => c.uuid).join(",");
    const real = stateFingerprint(started.game, started.players, keys, started.rng.draws);
    const realOpp = ids(opp.hand);
    const myHand = ids(me.hand);
    const hooks = session.hooks[seat - 1];
    const mark = hooks.bookmark();
    const world = (key: string) => {
      determinize(started.game, started.players, seat, key);
      const out = { opp: ids(opp.hand), oppDeck: ids(opp.drawDeck), myDeck: ids(me.drawDeck), mine: ids(me.hand), oppSize: opp.hand.length };
      hooks.rollback(mark);
      return out;
    };
    const a = world("w|a");
    const a2 = world("w|a");
    const b = world("w|b");
    hooks.release(mark);
    expect(a2).toEqual(a);
    expect(a.mine).toBe(myHand);
    expect(a.oppSize).toBe(realOpp.split(",").filter(Boolean).length);
    expect([a.oppDeck, a.myDeck]).not.toEqual([b.oppDeck, b.myDeck]);
    expect(stateFingerprint(started.game, started.players, keys, started.rng.draws)).toBe(real);
  });
});
