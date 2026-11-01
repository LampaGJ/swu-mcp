import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildViewKeys, loadLearnedInputs, OBSERVER_NAMES } from "../../../scripts/sims/evaluator-hook.js";
import { detKey } from "../../../scripts/sims/policy/search.js";
import { startGame } from "../../../src/sims/engine.js";
import { determinize } from "../../../src/sims/policies/flat-mc.js";
import { decidingSeats } from "../../../src/sims/search-leaf.js";
import { Session } from "../../../src/sims/session.js";
import { extractStateView } from "../../../src/sims/state-view.js";
import { encodeState, stateSha256 } from "../../../src/sims/state.js";
import { registerLearned, registerObservers } from "../../../scripts/sims/policy/learned.js";
import type { LearnedCounters } from "../../../scripts/sims/policy/search.js";
import { loadContext, DEFAULT_ORIGINALS, DEFAULT_RUN, type SimContext } from "../../../scripts/sims/context.js";
import { prepareDeck } from "../../../scripts/sims/decks.js";
import { REPO_ROOT } from "../../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../../src/sims/engine-pin.js";
import { playMatch, replayMatch, type DeckInput, type MatchSpec } from "../../../src/sims/match.js";
import { OBSERVERS, POLICIES, PolicyChain } from "../../../src/sims/policy.js";
import { registerRungs } from "../../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../../src/sims/policies/tables.js";
import { fullDecisionSchema, matchFooterSchema } from "../../../src/sims/schemas.js";

/**
 * [engine] The evaluator observer (#127) and the learned rungs (#128) on the pinned forceteki: needs the clone, the
 * 2026-10-31 run and the mault originals, skips without. A rung 4 game with d 2, k 2, m 1 costs tens of seconds.
 */

const hasEngine = existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(DEFAULT_RUN, "replay.json")) && existsSync(DEFAULT_ORIGINALS);
const PILOT = "rung1:sacGuard=1,handCap=1";
const NAMES = ["rung1", PILOT];
const LEARNED = ["rung3v:k=8,ev=v1", "rung3v:k=8,ev=v1,stub=1", "rung4:d=2,k=2,m=1,ev=v1"];

describe.skipIf(!hasEngine)("[engine] evaluator observer and learned rungs", () => {
  let ctx: SimContext;
  let warrior: DeckInput;
  let cadBane: DeckInput;
  let viewKeys: ReturnType<typeof buildViewKeys>;
  const spec = (seed: string, policies: [string, string], over: Partial<MatchSpec> = {}): MatchSpec => ({ seed, decks: [warrior, cadBane], policies, recordMode: "compact", undo: true, codeCommit: "test", ...over });

  beforeAll(() => {
    ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    const tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    const makeChain = (ps: unknown[]) => new PolicyChain(ps as never);
    registerRungs(POLICIES, makeChain, NAMES, tables);
    viewKeys = buildViewKeys(ctx.bridge.engineCardKeys);
    registerLearned(POLICIES, makeChain, LEARNED, tables, { viewKeys });
    registerObservers(OBSERVERS, { evaluator: "v1", viewKeys });
    const deck = (rel: string) => prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")), `file:${rel}`);
    warrior = deck("tests/fixtures/decks/warrior-chewie-raid.swudb.json");
    cadBane = deck("data/originals/decks/2026-10-17/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json");
  }, 60_000);

  it("the observer scores every main-action state, never moves the trace, and its two hashes repeat", { timeout: 60_000 }, async () => {
    const keys = ctx.bridge.engineCardKeys;
    const off = (await playMatch(ctx.engine, spec("21", [PILOT, PILOT], { undo: false }), keys)).record.footer;
    const on = (await playMatch(ctx.engine, spec("21", [PILOT, PILOT], { undo: false, observer: OBSERVER_NAMES["per-prompt"] }), keys)).record.footer;
    const again = (await playMatch(ctx.engine, spec("21", [PILOT, PILOT], { undo: false, observer: OBSERVER_NAMES["per-prompt"] }), keys)).record.footer;
    const each = (await playMatch(ctx.engine, spec("21", [PILOT, PILOT], { undo: false, observer: OBSERVER_NAMES["per-action"] }), keys)).record.footer;
    expect(matchFooterSchema.safeParse(on).success).toBe(true);
    expect(off.observer).toBeUndefined();
    expect(on.traceSha256).toBe(off.traceSha256);
    expect(each.traceSha256).toBe(off.traceSha256);
    const o = on.observer;
    if (o === undefined) throw new Error("no observer block");
    expect(o.mainDecisions).toBeGreaterThan(0);
    expect(o.calls).toBe(o.mainDecisions);
    expect(o.sha256).toBe("75a972ea6de8b132b91f7c64e48dd13a5654c8ea2c3d6b7c0fdc98cc318dcd27");
    expect(again.observer?.recordSha256).toBe(o.recordSha256);
    expect(again.observer?.valueSha256).toBe(o.valueSha256);
    expect(each.observer?.calls).toBeGreaterThan(o.calls);
    expect(each.observer?.mainDecisions).toBe(o.mainDecisions);
  });

  it("a stub rung3v (every leaf 0) plays its ranking pilot's trace exactly, undo on", { timeout: 120_000 }, async () => {
    const keys = ctx.bridge.engineCardKeys;
    const pilot = (await playMatch(ctx.engine, spec("24", [PILOT, "rung1"]), keys)).record.footer;
    const stub = (await playMatch(ctx.engine, spec("24", ["rung3v:k=8,ev=v1,stub=1", "rung1"]), keys)).record.footer;
    expect(pilot.result.endCondition).toBe("base_destroyed");
    expect(stub.traceSha256).toBe(pilot.traceSha256);
    expect(stub.search?.decisions).toBeGreaterThan(5);
  });

  for (const name of ["rung3v:k=8,ev=v1", "rung4:d=2,k=2,m=1,ev=v1"]) {
    it(`${name}: every rollback restores the full fingerprint, the record carries parseable search blocks naming the evaluator, and it replays by descriptor and by policy`, { timeout: 180_000 }, async () => {
      const keys = ctx.bridge.engineCardKeys;
      const { record, session } = await playMatch(ctx.engine, spec("23", [name, "rung1"], { recordMode: "full" }), keys, { verifyRollback: true });
      expect(record.footer.error).toBeNull();
      if (session === null) throw new Error("no session");
      const counters = (session.opts.chains[0].top as unknown as { counters: LearnedCounters }).counters;
      expect(counters.searches).toBeGreaterThan(5);
      expect(counters.evaluatorCalls).toBeGreaterThan(counters.searches);
      expect(session.search.verified).toBe(session.search.rollbacks);
      expect(session.search.rollbacks).toBeGreaterThanOrEqual(counters.trials);
      const blocks = record.decisions.flatMap((d) => {
        const full = fullDecisionSchema.parse(d);
        return full.search === undefined ? [] : [{ full, search: full.search }];
      });
      expect(blocks.length).toBe(record.footer.search?.decisions);
      for (const { full, search } of blocks) {
        expect(full.evaluator.sha256).toBe("75a972ea6de8b132b91f7c64e48dd13a5654c8ea2c3d6b7c0fdc98cc318dcd27");
        expect(search.chosen).toBe(full.chosen.descriptor);
        expect(search.rung).toBe(name.startsWith("rung4") ? 4 : 3);
      }
      if (name.startsWith("rung4")) {
        expect(counters.determinizations).toBe(counters.trials);
        expect(counters.replies).toBeGreaterThan(0);
      }
      const oracle = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys, { byDescriptor: true });
      expect(oracle.mismatch).toBeNull();
      expect(oracle.traceSha256).toBe(record.footer.traceSha256);
      const again = await playMatch(ctx.engine, spec("23", [name, "rung1"], { recordMode: "compact" }), keys);
      expect(again.record.footer.traceSha256).toBe(record.footer.traceSha256);
      expect(again.record.footer.search?.searchSha256).toBe(record.footer.search?.searchSha256);
    });
  }

  it("rung 4's re-deal keeps the actor's view and every multiset, moves the hidden order, repeats per key after a rollback, and the root comes back (#128 determinization a to e)", { timeout: 120_000 }, async () => {
    const keys = ctx.bridge.engineCardKeys;
    const compiled = loadLearnedInputs({ evaluator: "v1", viewKeys }).compiled;
    const tally = { decisions: 0, viewSame: 0, multisetSame: 0, orderMoved: 0, repeatSame: 0, rootSame: 0, snapshotSame: 0 };
    const names = (cs: any[]) => cs.map((c) => String(c.internalName)).sort().join(",");
    const order = (cs: any[]) => cs.map((c) => String(c.uuid)).join(",");
    for (let seed = 41; tally.decisions < 200 && seed < 60; seed++) {
      const started = await startGame(ctx.engine, [warrior.list, cadBane.list], { engineSeed: `engine:${seed}`, undo: true });
      const session = new Session(started, { seed: String(seed), cardKeys: keys, chains: [POLICIES[PILOT]() as never, POLICIES[PILOT]() as never], recordMode: "none", playedMetric: ctx.engine.playedMetric, manualSnapshotType: ctx.engine.SnapshotType.Manual, verifyRollback: true });
      const g = started.game as any;
      let last = -1;
      while (tally.decisions < 200 && session.run({ until: (p) => p.k > last && p.promptKind === "mainAction" && p.actions.length >= 2 && g.currentPhase === "action" }) === "paused") {
        const seat = decidingSeats(started.players)[0];
        last = session.k;
        const [me, opp] = (seat === 1 ? started.players : [started.players[1], started.players[0]]) as any[];
        const view = () => stateSha256(encodeState(extractStateView(started.game, seat, viewKeys), compiled));
        const hidden = () => `${order(me.drawDeck)}|${order(opp.hand)}|${order(opp.drawDeck)}`;
        const multisets = () => `${names(me.drawDeck)}|${names([...opp.hand, ...opp.drawDeck])}`;
        const hooks = session.hooks[seat - 1];
        const mark = hooks.bookmark();
        const root = { view: view(), hidden: hidden(), multisets: multisets(), cursor: JSON.stringify(session.cursorNow()), snapshot: g.snapshotManager.currentSnapshotId };
        determinize(started.game, started.players, seat, detKey(String(seed), seat, session.k, 0));
        const dealt = hidden();
        tally.decisions++;
        if (view() === root.view) tally.viewSame++;
        if (multisets() === root.multisets) tally.multisetSame++;
        if (dealt !== root.hidden) tally.orderMoved++;
        hooks.rollback(mark);
        if (g.snapshotManager.currentSnapshotId === root.snapshot) tally.snapshotSame++;
        determinize(started.game, started.players, seat, detKey(String(seed), seat, session.k, 0));
        if (hidden() === dealt) tally.repeatSame++;
        hooks.rollback(mark);
        hooks.release(mark);
        if (view() === root.view && hidden() === root.hidden && JSON.stringify(session.cursorNow()) === root.cursor) tally.rootSame++;
      }
    }
    expect(tally.decisions).toBe(200);
    expect(tally).toMatchObject({ viewSame: 200, multisetSame: 200, repeatSame: 200, rootSame: 200, snapshotSame: 200 });
    expect(tally.orderMoved).toBeGreaterThanOrEqual(180);
  });

  it("refuses to search with undo off", { timeout: 60_000 }, async () => {
    const r = (await playMatch(ctx.engine, spec("22", ["rung3v:k=8,ev=v1", "rung1"], { undo: false }), ctx.bridge.engineCardKeys)).record.footer;
    expect(r.result.endCondition).toBe("error");
    expect(r.error).toMatch(/undo mode is off/);
  });
});
