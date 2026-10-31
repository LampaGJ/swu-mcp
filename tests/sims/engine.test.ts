import { existsSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCardBridge, type CardBridge } from "../../scripts/sims/card-bridge.js";
import { loadDeck } from "../../scripts/sims/decks.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { installSelectableCardsMemo, loadEngine, startGame, type Engine } from "../../src/sims/engine.js";
import { playMatch, replayMatch, summarize, type DeckInput, type MatchSpec } from "../../src/sims/match.js";
import { PolicyChain, rung0, type Policy } from "../../src/sims/policy.js";
import { createPool } from "../../src/sims/pool.js";
import { matchRecordSchema, type FullDecision, type MatchRecord } from "../../src/sims/schemas.js";
import { decidingSeats, searchLeaf } from "../../src/sims/search-leaf.js";
import { Session } from "../../src/sims/session.js";
import { canonicalJson } from "../../src/swu/canonical.js";

/**
 * Engine-backed tests, tagged [engine]: they need the pinned forceteki clone, the 2026-10-31 run and the mault
 * originals, and skip without them. Kept few; each match costs about 0.2 to 0.4 s.
 */

const RUN = "data/runs/2026-10-31";
const ORIGINALS = "/Volumes/Local Files/Projects/mault/data/swu-originals/2026-10-16";
const DECKS = "data/originals/decks/2026-10-17";
const hasEngine = existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(RUN, "replay.json")) && existsSync(ORIGINALS) && existsSync(DECKS);
const T = { timeout: 60_000 };

describe.skipIf(!hasEngine)("[engine] typed driver on the pinned forceteki", () => {
  let engine: Engine;
  let bridge: CardBridge;
  let cadBane: DeckInput;
  let krennic: DeckInput;
  let warrior: DeckInput;
  const spec = (seed: string, over: Partial<MatchSpec> = {}): MatchSpec => ({ seed, decks: [cadBane, krennic], policies: ["rung0", "rung0"], recordMode: "compact", undo: false, codeCommit: "test", ...over });

  beforeAll(() => {
    engine = loadEngine(DEFAULT_FORCETEKI);
    installSelectableCardsMemo(DEFAULT_FORCETEKI);
    bridge = loadCardBridge(RUN, ORIGINALS, DEFAULT_FORCETEKI);
    cadBane = loadDeck(bridge, `${DECKS}/melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json`);
    krennic = loadDeck(bridge, `${DECKS}/melee-0b373cb2-6dfb-425e-842d-b4a700e2d337.json`);
    warrior = loadDeck(bridge, "tests/fixtures/decks/warrior-chewie-raid.swudb.json");
  }, 60_000);

  it("seeds before the first engine draw: the coin flip is already counted at decision 0", T, async () => {
    const { record } = await playMatch(engine, spec("3", { recordMode: "full" }), bridge.engineCardKeys);
    const first = record.decisions[0] as FullDecision;
    expect(first.rngCursor.engineDraws).toBeGreaterThan(0);
    expect(first.phase).toBe("setup");
    expect(matchRecordSchema.parse(JSON.parse(JSON.stringify(record)))).toBeTruthy();
    expect(JSON.stringify(record)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-1[0-9a-f]{3}-/);
    const played = record.footer.cardsPlayed[0].length + record.footer.cardsPlayed[1].length;
    expect(played).toBeGreaterThan(0);
  });

  it("pauses before every decision, on both seat orders, and pausing changes no trace (#141)", T, async () => {
    for (const decks of [
      [cadBane, krennic],
      [krennic, cadBane],
    ] as const) {
      const straight = (await playMatch(engine, spec("11", { decks }), bridge.engineCardKeys)).record;
      const started = await startGame(engine, [decks[0].list, decks[1].list], { engineSeed: "engine:11", undo: false });
      const session = new Session(started, { seed: "11", cardKeys: bridge.engineCardKeys, chains: [new PolicyChain([rung0]), new PolicyChain([rung0])], recordMode: "compact", playedMetric: engine.playedMetric });
      const pauses: { k: number; seat: number }[] = [];
      let last = -1;
      while (session.run({ until: (p) => p.k > last }) === "paused") {
        const pending = { k: session.k, seat: 0 };
        session.run({
          until: (p) => {
            pending.seat = p.seat;
            return true;
          },
        });
        expect(searchLeaf(session.game, session.players)).toBe(true);
        expect(decidingSeats(session.players)).toContain(pending.seat);
        pauses.push(pending);
        last = session.k;
      }
      for (let i = 1; i < pauses.length; i++) expect(pauses[i].k - pauses[i - 1].k).toBe(1);
      const switches = new Set(pauses.slice(1).map((p, i) => `${pauses[i].seat}>${p.seat}`));
      expect(switches).toContain("1>2");
      expect(switches).toContain("2>1");
      expect(session.footer().traceSha256).toBe(straight.footer.traceSha256);
      expect(session.footer().result).toEqual(straight.footer.result);
    }
  });

  it("replay stops at the first mismatch and names k and the field", T, async () => {
    const compact = (await playMatch(engine, spec("21"), bridge.engineCardKeys)).record;
    expect((await replayMatch(engine, compact, bridge.engineCardKeys)).ok).toBe(true);
    const tamper = (f: (r: MatchRecord) => void): MatchRecord => {
      const r = JSON.parse(JSON.stringify(compact)) as MatchRecord;
      f(r);
      return r;
    };
    const cursor = await replayMatch(engine, tamper((r) => (r.decisions[10].rngCursor.engineDraws += 1)), bridge.engineCardKeys);
    expect(cursor.mismatch).toMatchObject({ k: 10, field: "rngCursor.engineDraws" });
    const legal = await replayMatch(engine, tamper((r) => (r.decisions[30].legalActionsSha256 = "0".repeat(64))), bridge.engineCardKeys);
    expect(legal.mismatch).toMatchObject({ k: 30, field: "legalActionsSha256" });
    const trace = await replayMatch(engine, tamper((r) => (r.footer.traceSha256 = "0".repeat(64))), bridge.engineCardKeys);
    expect(trace.mismatch).toMatchObject({ field: "traceSha256" });

    const full = (await playMatch(engine, spec("21", { recordMode: "full" }), bridge.engineCardKeys)).record;
    const k = full.decisions.findIndex((d) => (d as FullDecision).legalActions.length > 1);
    const swapped = JSON.parse(JSON.stringify(full)) as MatchRecord;
    const d = swapped.decisions[k] as FullDecision;
    const other = d.legalActions.find((a) => a.descriptor !== d.chosen.descriptor);
    d.chosen = { i: other?.i ?? 0, descriptor: other?.descriptor ?? "" };
    expect((await replayMatch(engine, swapped, bridge.engineCardKeys)).mismatch).toMatchObject({ k, field: "chosen" });
  });

  it("an exception during play ends as an error with a null winner and counts in errorRate", T, async () => {
    const boom: Policy = { ...rung0, rung: 1, policyId: "boom", choose: (_a, view) => (view.k === 5 ? (() => { throw new Error("policy blew up"); })() : null) };
    const started = await startGame(engine, [cadBane.list, krennic.list], { engineSeed: "engine:5", undo: false });
    const session = new Session(started, { seed: "5", cardKeys: bridge.engineCardKeys, chains: [new PolicyChain([boom]), new PolicyChain([boom])], recordMode: "compact", playedMetric: engine.playedMetric });
    expect(session.run()).toBe("ended");
    const f = session.footer();
    expect(f.result).toMatchObject({ winner: null, endCondition: "error", decisions: 5 });
    expect(f.error).toBe("policy blew up");
    expect(f.coverage.answered).toEqual([0, 0]);
    expect(summarize([{ seed: "5", footer: f }])).toMatchObject({ errors: 1, decided: 0, winShare: null, errorRate: 1 });
  });

  it("pins a known engine fault as an error record (GravCharge contextTitle reads a detached upgrade's parent)", T, async () => {
    const deck = loadDeck(bridge, `${DECKS}/melee-0d2f71a3-c3d0-4478-815c-b492007f3b8b.json`);
    const { record, session } = await playMatch(engine, spec("1092", { decks: [deck, cadBane] }), bridge.engineCardKeys);
    expect(record.footer.result).toEqual({ winner: null, endCondition: "error", rounds: record.footer.result.rounds, decisions: 164 });
    expect(record.footer.error).toBe("Contract assertion failure: Null-like object value: null");
    expect(record.footer.traceSha256).toBe("d689ba446294d4e66262ce7eb98ad9325efb48e5d4659ebbd0c8791bf5ff9b46");
    expect(session?.errorStack).toMatch(/GravCharge/);
    expect((await replayMatch(engine, record, bridge.engineCardKeys)).ok).toBe(true);
  });

  it("worker threads return the records one thread does, and undo mode does not move a rung-0 trace", T, async () => {
    const specs = ["31", "32", "33", "34"].map((s, i) => spec(s, { decks: i % 2 === 0 ? [warrior, krennic] : [cadBane, warrior] }));
    const single = [];
    for (const s of specs) single.push((await playMatch(engine, s, bridge.engineCardKeys)).record);
    const pool = await createPool({ workers: 2, pin: engine.pin });
    try {
      const pooled = await pool.run({ specs, cardKeys: bridge.engineCardKeys });
      expect(pooled.map((r) => canonicalJson(r))).toEqual(single.map((r) => canonicalJson(r)));
    } finally {
      await pool.close();
    }
    for (const [i, s] of specs.slice(0, 2).entries()) {
      const undo = (await playMatch(engine, { ...s, undo: true }, bridge.engineCardKeys)).record;
      expect(undo.footer).toEqual(single[i].footer);
      expect(undo.header.engine.undoMode).toBe("free");
    }
  });
});
