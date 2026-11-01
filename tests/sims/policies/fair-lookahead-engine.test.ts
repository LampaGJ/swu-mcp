import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildViewKeys } from "../../../scripts/sims/evaluator-hook.js";
import { loadContext, DEFAULT_ORIGINALS, DEFAULT_RUN, type SimContext } from "../../../scripts/sims/context.js";
import { prepareDeck } from "../../../scripts/sims/decks.js";
import { registerLearned } from "../../../scripts/sims/policy/learned.js";
import type { LearnedCounters } from "../../../scripts/sims/policy/search.js";
import { REPO_ROOT } from "../../../src/paths.js";
import type { CanonicalAction } from "../../../src/sims/actions.js";
import { DEFAULT_FORCETEKI } from "../../../src/sims/engine-pin.js";
import { startGame, type EnginePlayer } from "../../../src/sims/engine.js";
import { playMatch, replayMatch, type DeckInput, type MatchSpec } from "../../../src/sims/match.js";
import { POLICIES, PolicyChain, type SearchHooks } from "../../../src/sims/policy.js";
import { hiddenViewOf } from "../../../src/sims/policies/hidden-sampler.js";
import type { LookaheadCounters } from "../../../src/sims/policies/rung3.js";
import { registerRungs } from "../../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../../src/sims/policies/tables.js";
import { DecisionRandom } from "../../../src/sims/rng.js";
import { fullDecisionSchema } from "../../../src/sims/schemas.js";
import { decidingSeats } from "../../../src/sims/search-leaf.js";
import { Session } from "../../../src/sims/session.js";

/**
 * [engine] The fair lookahead (#183) on the pinned forceteki: needs the clone, the 2026-10-31 run and the mault
 * originals, skips without. The swap probe plays about a hundred searches; budget a few minutes on one thread.
 */

type AnyCard = any;

const hasEngine = existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(DEFAULT_RUN, "replay.json")) && existsSync(DEFAULT_ORIGINALS);
const OLD3 = "rung3:k=8";
const FAIR3 = "rung3:k=8,det=2,belief=known";
const OLD3V = "rung3v:k=8,ev=v1,horizon=round,noPass=1";
const FAIR3V = "rung3v:k=8,ev=v1,horizon=round,noPass=1,det=2,belief=known";
/** Decisions probed by the swap test, spread over several games (at most four each). */
const PROBES = 32;

describe.skipIf(!hasEngine)("[engine] fair lookahead: re-dealt hidden cards (#183)", () => {
  let ctx: SimContext;
  let warrior: DeckInput;
  let cadBane: DeckInput;
  const spec = (seed: string, policies: [string, string], over: Partial<MatchSpec> = {}): MatchSpec => ({ seed, decks: [warrior, cadBane], policies, recordMode: "compact", undo: true, codeCommit: "test", ...over });

  beforeAll(() => {
    ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
    const tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    const makeChain = (ps: unknown[]) => new PolicyChain(ps as never);
    registerRungs(POLICIES, makeChain, ["rung1", OLD3, FAIR3], tables);
    registerLearned(POLICIES, makeChain, [OLD3V, FAIR3V], tables, { viewKeys: buildViewKeys(ctx.bridge.engineCardKeys) });
    const deck = (rel: string) => prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")), `file:${rel}`);
    warrior = deck("tests/fixtures/decks/warrior-chewie-raid.swudb.json");
    cadBane = deck("data/originals/decks/2026-10-17/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json");
  }, 60_000);

  it("the old leaking names still play their traces byte for byte (hashes taken on main d9e5b3e before the change)", { timeout: 120_000 }, async () => {
    const keys = ctx.bridge.engineCardKeys;
    const r3 = (await playMatch(ctx.engine, spec("23", [OLD3, "rung1"]), keys)).record.footer;
    expect(r3.traceSha256).toBe("321f0fc7e81a5928d0e65b2aa269c7e22f221f624a72880cf0274112dd6cad51");
    const r3v = (await playMatch(ctx.engine, spec("23", [OLD3V, "rung1"]), keys)).record.footer;
    expect(r3v.traceSha256).toBe("67b71da47dd18d3fb6310aa4ae1e4c24dd415616ab191cc2a71ab98bf18a3610");
    expect(r3v.search?.searchSha256).toBe("698d22f81a652b609f14337691707f6a8ae87788bd118a691422b02a6f841135");
  });

  it("swapping the opponent's hand for other unseen cards (same public state) never moves a fair pilot's choice, and does move the leaking pilots' choices", { timeout: 600_000 }, async () => {
    const keys = ctx.bridge.engineCardKeys;
    const tally = { probes: 0, fair3Moved: 0, fair3vMoved: 0, old3Moved: 0, old3vMoved: 0 };
    for (let seed = 61; tally.probes < PROBES && seed < 100; seed++) {
      const started = await startGame(ctx.engine, [warrior.list, cadBane.list], { engineSeed: `engine:${seed}`, undo: true });
      const session = new Session(started, { seed: String(seed), cardKeys: keys, chains: [POLICIES.rung1() as never, POLICIES.rung1() as never], recordMode: "none", playedMetric: ctx.engine.playedMetric, manualSnapshotType: ctx.engine.SnapshotType.Manual });
      const g = started.game as AnyCard;
      let last = -1;
      let probedThisGame = 0;
      const box: { p: { seat: 1 | 2; k: number; promptKind: string; actions: CanonicalAction[] } | null } = { p: null };
      while (tally.probes < PROBES && probedThisGame < 4) {
        const state = session.run({
          until: (p) => {
            if (p.k <= last || p.promptKind !== "mainAction" || p.actions.length < 3 || g.currentPhase !== "action") return false;
            box.p = p;
            return true;
          },
        });
        const p = box.p;
        if (state !== "paused" || p === null) break;
        box.p = null;
        last = p.k;
        const seat = p.seat;
        const players = started.players as readonly [EnginePlayer, EnginePlayer];
        const opp = players[2 - seat] as AnyCard;
        const hand = [...(opp.hand as AnyCard[])];
        const names = new Set(hand.map((c) => String(c.internalName)));
        const repl = (opp.drawDeck as AnyCard[]).filter((c) => !names.has(String(c.internalName))).slice(-hand.length);
        if (hand.length === 0 || repl.length < hand.length || p.k % 3 !== 0) continue;
        const out = hand.map((c) => String(c.uuid));
        const into = repl.map((c) => String(c.uuid));
        const swap = (): void => {
          const find = (id: string) => [...(opp.hand as AnyCard[]), ...(opp.drawDeck as AnyCard[])].find((c) => String(c.uuid) === id);
          for (const id of out) find(id).moveTo("deckBottom");
          for (const id of into) find(id).moveTo("hand");
        };
        const real = session.hooks[seat - 1];
        const restore = (): void => {
          const m = real.bookmark();
          real.rollback(m);
          real.release(m);
        };
        const swapped: SearchHooks = { ...real, rollback: (m) => (real.rollback(m), swap()) };
        const choose = (name: string, hooks: SearchHooks): number => {
          const view = { seat, k: p.k, promptKind: p.promptKind, multi: (players[seat - 1] as AnyCard).promptState.selectCardMode === "multiple", game: started.game, players, search: hooks };
          return (POLICIES[name]() as unknown as PolicyChain).choose(
            p.actions.map((a) => a.action),
            view as never,
            new DecisionRandom(String(seed), seat, p.k).next,
          ).index;
        };
        const before = JSON.stringify(hiddenViewOf(players, seat).view.opponentHandSize);
        const plain = Object.fromEntries([OLD3, FAIR3, OLD3V, FAIR3V].map((n) => [n, choose(n, real)]));
        const moved: Record<string, number> = {};
        for (const n of [OLD3, FAIR3, OLD3V, FAIR3V]) {
          swap();
          if (n === FAIR3) expect(JSON.stringify(hiddenViewOf(players, seat).view.opponentHandSize)).toBe(before);
          moved[n] = choose(n, swapped) === plain[n] ? 0 : 1;
          restore();
        }
        expect((opp.hand as AnyCard[]).map((c) => String(c.uuid))).toEqual(out);
        tally.probes++;
        probedThisGame++;
        // Each probe runs about ten seconds of searches synchronously; yield so vitest's worker RPC does not time out.
        await new Promise((r) => setImmediate(r));
        tally.fair3Moved += moved[FAIR3];
        tally.fair3vMoved += moved[FAIR3V];
        tally.old3Moved += moved[OLD3];
        tally.old3vMoved += moved[OLD3V];
      }
    }
    console.log(`swap probe ${JSON.stringify(tally)}`);
    expect(tally.probes).toBe(PROBES);
    expect(tally.fair3Moved).toBe(0);
    expect(tally.fair3vMoved).toBe(0);
    expect(tally.old3Moved).toBeGreaterThan(0);
    expect(tally.old3vMoved).toBeGreaterThan(0);
  });

  for (const name of [FAIR3, FAIR3V]) {
    it(`${name}: one re-deal per trial, every rollback restores the full fingerprint, and the record replays by descriptor and by policy`, { timeout: 300_000 }, async () => {
      const keys = ctx.bridge.engineCardKeys;
      const { record, session } = await playMatch(ctx.engine, spec("23", [name, "rung1"], { recordMode: "full" }), keys, { verifyRollback: true });
      expect(record.footer.error).toBeNull();
      expect(record.footer.result.endCondition).toBe("base_destroyed");
      if (session === null) throw new Error("no session");
      const counters = (session.opts.chains[0].top as unknown as { counters: LookaheadCounters & LearnedCounters }).counters;
      expect(counters.searches).toBeGreaterThan(5);
      expect(counters.trialErrors).toBe(0);
      if (name.startsWith("rung3v")) {
        expect(counters.determinizations).toBe(counters.trials);
        const blocks = record.decisions.flatMap((d) => fullDecisionSchema.parse(d).search ?? []);
        expect(blocks.length).toBeGreaterThan(5);
        for (const b of blocks) expect(b).toMatchObject({ rung: 3, mode: "canonical", determinizations: 2 });
      } else {
        expect(counters.redeals).toBe(counters.trials);
        expect(session.search.rollbacks).toBe(counters.trials);
      }
      expect(session.search.verified).toBe(session.search.rollbacks);
      const oracle = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys, { byDescriptor: true });
      expect(oracle.mismatch).toBeNull();
      expect(oracle.traceSha256).toBe(record.footer.traceSha256);
      const again = await playMatch(ctx.engine, spec("23", [name, "rung1"]), keys);
      expect(again.record.footer.traceSha256).toBe(record.footer.traceSha256);
      expect(again.record.footer.search?.searchSha256).toBe(record.footer.search?.searchSha256);
    });
  }

  it("a re-deal keeps our hand, the opponent's hand size and every multiset, and is the same world for the same key whatever the true hidden order", { timeout: 60_000 }, async () => {
    const { redealHidden, BELIEF } = await import("../../../src/sims/policies/hidden-sampler.js");
    const keys = ctx.bridge.engineCardKeys;
    const started = await startGame(ctx.engine, [warrior.list, cadBane.list], { engineSeed: "engine:31", undo: true });
    const session = new Session(started, { seed: "31", cardKeys: keys, chains: [POLICIES.rung1() as never, POLICIES.rung1() as never], recordMode: "none", playedMetric: ctx.engine.playedMetric, manualSnapshotType: ctx.engine.SnapshotType.Manual });
    session.run({ until: (p) => p.promptKind === "mainAction" && p.k > 40 });
    const seat = decidingSeats(started.players)[0];
    const players = started.players as readonly [EnginePlayer, EnginePlayer];
    const [me, opp] = (seat === 1 ? players : [players[1], players[0]]) as AnyCard[];
    const ids = (cs: AnyCard[]) => cs.map((c) => String(c.uuid));
    const sorted = (cs: AnyCard[]) => ids(cs).sort().join(",");
    const root = { mine: ids(me.hand).join(","), oppSize: opp.hand.length, oppPool: sorted([...opp.hand, ...opp.drawDeck]), myDeck: sorted(me.drawDeck) };
    const hooks = session.hooks[seat - 1];
    const world = (key: string, scramble: boolean) => {
      const m = hooks.bookmark();
      if (scramble) {
        for (const c of [...opp.hand]) c.moveTo("deckBottom");
        opp.drawCardsToHand(root.oppSize);
        for (const c of (me.deckZone.clearDeck() as AnyCard[]).reverse()) me.deckZone.addCardToBottom(c);
      }
      redealHidden(started.game, players, seat, BELIEF.known, key);
      const out = { mine: ids(me.hand).join(","), oppHand: ids(opp.hand).join(","), oppDeck: ids(opp.drawDeck).join(","), myDeck: ids(me.drawDeck).join(","), oppPool: sorted([...opp.hand, ...opp.drawDeck]), myPool: sorted(me.drawDeck) };
      hooks.rollback(m);
      hooks.release(m);
      return out;
    };
    const a = world("w|a", false);
    expect(a.mine).toBe(root.mine);
    expect(a.oppHand.split(",").length).toBe(root.oppSize);
    expect(a.oppPool).toBe(root.oppPool);
    expect(a.myPool).toBe(root.myDeck);
    expect(world("w|a", true)).toEqual(a);
    expect(world("w|b", false)).not.toEqual(a);
    expect(ids(me.hand).join(",")).toBe(root.mine);
  });
});
