import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../../scripts/bench/card-map.js";
import { loadCardBridge, type CardBridge } from "../../scripts/sims/card-bridge.js";
import { prepareDeck } from "../../scripts/sims/decks.js";
import { loadStore } from "../../src/data.js";
import { foldMatchups, type MatchupResponse } from "../../src/meta/outcomes.js";
import { winRatesFileSchema } from "../../src/meta/schema.js";
import { REPO_ROOT } from "../../src/paths.js";
import {
  CALIBRATION_SEED0,
  calibrationJobs,
  externalIntervals,
  gateRecordSchema,
  isDecisive,
  seats,
  simRecordOf,
  spearman,
  spearmanInterval,
  tournamentRecord,
  type CalibrationJob,
  type GateRecord,
} from "../../src/sims/calibration.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { installSelectableCardsMemo, loadEngine, type Engine } from "../../src/sims/engine.js";
import { playMatch, type DeckInput } from "../../src/sims/match.js";
import { mapCardKeyOf, storeAspectsOf } from "../../src/sims/opponents.js";
import type { MatchFooter } from "../../src/sims/schemas.js";

/**
 * #171 step 1 and 2: does the calibration gate compare the same archetype on the same side? Traced from the raw
 * swumetastats rows through meta/winrates.json to the gate's pairing and the sim's seat and winner mapping. Synthetic
 * cases always run; the pinned-data and engine cases skip without the local runs, originals and forceteki build.
 */

const decided = (winner: 1 | 2): Pick<MatchFooter, "result"> => ({ result: { winner, endCondition: "base_destroyed", rounds: 9, decisions: 300 } });

describe("calibration orientation, synthetic", () => {
  it("foldMatchups keeps each row's own side, so A's share against B is A's wins and B's row mirrors it", () => {
    const row = { base: "", opponentBase: "", draws: 1 };
    const response: MatchupResponse = {
      matchups: [
        { ...row, leader: "Alpha | One", aspect: "Vigilance", opponentLeader: "Beta | Two", opponentAspect: "Command", wins: 7, losses: 3 },
        { ...row, leader: "Beta | Two", aspect: "Command", opponentLeader: "Alpha | One", opponentAspect: "Vigilance", wins: 3, losses: 7 },
      ],
    };
    const folded = foldMatchups(response, { leader: (n) => ({ "Alpha | One": "A1", "Beta | Two": "B1" })[n] ?? null, baseAspects: () => null }, { from: "2026-01-01", to: "2026-01-31" });
    const a = { leader: "A1", baseAspects: "Vigilance" };
    const b = { leader: "B1", baseAspects: "Command" };
    expect(tournamentRecord(folded.pairs, a, b, 1)).toMatchObject({ wins: 7, losses: 3, share: 0.7 });
    expect(tournamentRecord(folded.pairs, b, a, 1)).toMatchObject({ wins: 3, losses: 7, share: 0.3 });
  });

  it("a seat-1 win counts for archetype i exactly when i sat in seat 1", () => {
    const { jobs } = calibrationJobs(2, 6);
    const iAlways = jobs.map((jb) => decided(jb.iFirst ? 1 : 2));
    const jAlways = jobs.map((jb) => decided(jb.iFirst ? 2 : 1));
    const seat1Always = jobs.map(() => decided(1));
    expect(simRecordOf(jobs, iAlways, 0)).toEqual({ wins: 6, n: 6, nonDecisive: 0 });
    expect(simRecordOf(jobs, jAlways, 0)).toEqual({ wins: 0, n: 6, nonDecisive: 0 });
    expect(simRecordOf(jobs, seat1Always, 0)).toEqual({ wins: 3, n: 6, nonDecisive: 0 });
    for (const jb of jobs) expect(seats(jb).map((s) => s.archetype)).toEqual(jb.iFirst ? [jb.i, jb.j] : [jb.j, jb.i]);
  });

  it("a draw, a timeout or an error is not decisive and is counted apart", () => {
    const { jobs } = calibrationJobs(2, 4);
    const footers = [decided(1), { result: { winner: null, endCondition: "base_destroyed", rounds: 9, decisions: 1 } }, { result: { winner: null, endCondition: "timeout", rounds: 9, decisions: 1 } }, decided(2)] as Pick<MatchFooter, "result">[];
    expect(footers.map(isDecisive)).toEqual([true, false, false, true]);
    expect(simRecordOf(jobs, footers, 0)).toEqual({ wins: 2, n: 2, nonDecisive: 2 });
  });

  it("one list per archetype keeps the pinned seed scheme: pair p plays seeds 4,000,000 + 1,000p + q, each twice with the seats swapped", () => {
    const { pairs, jobs } = calibrationJobs(12, 40);
    expect(pairs).toHaveLength(66);
    expect(jobs).toHaveLength(66 * 40);
    expect(jobs.slice(0, 4).map((jb) => [jb.pair, jb.i, jb.j, jb.seed, jb.iFirst, jb.ai, jb.bi])).toEqual([
      [0, 0, 1, CALIBRATION_SEED0, true, 0, 0],
      [0, 0, 1, CALIBRATION_SEED0, false, 0, 0],
      [0, 0, 1, CALIBRATION_SEED0 + 1, true, 0, 0],
      [0, 0, 1, CALIBRATION_SEED0 + 1, false, 0, 0],
    ]);
    const rec = gateRecordSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, "data/pinned/sim-calibration-v1/calibration-rung1.json"), "utf8")));
    expect([Math.min(...jobs.map((jb) => jb.seed)), Math.max(...jobs.map((jb) => jb.seed))]).toEqual([rec.seeds.from, rec.seeds.to]);
  });

  it("with three lists each of the nine list pairings plays the same number of seeds, each seed in both seat orders", () => {
    const { jobs } = calibrationJobs(3, 36, 3);
    for (let p = 0; p < 3; p++) {
      const mine = jobs.filter((jb) => jb.pair === p);
      expect(mine).toHaveLength(36);
      const per = new Map<string, number>();
      for (const jb of mine) per.set(`${jb.ai}/${jb.bi}/${jb.iFirst}`, (per.get(`${jb.ai}/${jb.bi}/${jb.iFirst}`) ?? 0) + 1);
      expect(per.size).toBe(18);
      expect([...per.values()].every((v) => v === 2)).toBe(true);
    }
    expect(() => calibrationJobs(3, 40, 3)).toThrow(/divide/);
    expect(() => calibrationJobs(3, 7)).toThrow(/even/);
  });

  it("the Spearman interval is Fisher's z with the Bonett-Wright variance and contains the estimate", () => {
    const iv = spearmanInterval(-0.1714, 66) as { low: number; high: number };
    expect(iv.low).toBeLessThan(-0.1714);
    expect(iv.high).toBeGreaterThan(-0.1714);
    expect(iv.high).toBeLessThan(0.5);
    expect(spearmanInterval(0, 66)?.low).toBeCloseTo(-(spearmanInterval(0, 66)?.high as number), 10);
    expect(spearmanInterval(0.3, 3)).toBeNull();
    const ext = externalIntervals({ spearman: -0.1714, pairs: 66, favourite: { counted: 37, agree: 15 } });
    expect(ext.spearman95).toEqual([iv.low, iv.high]);
    expect(ext.favourite95?.[0]).toBeLessThan(15 / 37);
    expect(ext.favourite95?.[1]).toBeGreaterThan(15 / 37);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");
const META = path.join(REPO_ROOT, "data/runs/2026-11-01/meta/winrates.json");
const RAW = path.join(REPO_ROOT, "data/originals/tournaments/2026-10-17/matchups.json");
const DECKS = path.join(REPO_ROOT, "data/originals/decks/2026-10-17");
const ORIGINALS = path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16");
const RECORD = path.join(REPO_ROOT, "data/pinned/sim-calibration-v1/calibration-rung1.json");
const hasData = [RUN, META, RAW, DECKS, ORIGINALS].every((p) => existsSync(p));

interface RawRow {
  leader: string;
  aspect?: string | null;
  opponentLeader: string;
  opponentAspect?: string | null;
  wins: number;
  losses: number;
}

/** The three pinned rows with the most decisive tournament matches; swumetastats names each side by "Title | Subtitle". */
const TRACED = [
  { a: { raw: "Cad Bane | Still Faster Than You", leader: "08010011", baseAspects: "Vigilance", archetype: "t002-6d0fc3" }, b: { raw: "Darth Vader | Victor Squadron Leader", leader: "04010006", baseAspects: "Cunning", archetype: "t005-46ed7e" } },
  { a: { raw: "Cad Bane | Still Faster Than You", leader: "08010011", baseAspects: "Vigilance", archetype: "t002-6d0fc3" }, b: { raw: "Luke Skywalker | Hero of Yavin", leader: "04010012", baseAspects: "Command", archetype: "t003-75e861" } },
  { a: { raw: "Cad Bane | Still Faster Than You", leader: "08010011", baseAspects: "Vigilance", archetype: "t002-6d0fc3" }, b: { raw: "Ahsoka Tano | Trust in the Force", leader: "08010009", baseAspects: "Vigilance", archetype: "t006-beda5a" } },
] as const;

describe.skipIf(!hasData)("calibration orientation against the pinned tournament data (#171)", () => {
  let rec: GateRecord;
  let raw: RawRow[];
  let pairs: NonNullable<ReturnType<typeof winRatesFileSchema.parse>["matchups"]>["pairs"];

  beforeAll(() => {
    rec = gateRecordSchema.parse(JSON.parse(readFileSync(RECORD, "utf8")));
    raw = (JSON.parse(readFileSync(RAW, "utf8")) as { matchups: RawRow[] }).matchups;
    const bytes = readFileSync(META);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(rec.inputs.winratesSha256);
    pairs = winRatesFileSchema.parse(JSON.parse(bytes.toString("utf8"))).matchups?.pairs ?? [];
  });

  it("the traced matchups are the pinned record's three rows with the most tournament evidence", () => {
    const top = [...rec.gates.external.rows].sort((x, y) => y.tournament.n - x.tournament.n).slice(0, 3);
    expect(top.map((r) => [r.a, r.b])).toEqual(TRACED.map((t) => [t.a.archetype, t.b.archetype]));
  });

  it.each(TRACED.map((t) => [`${t.a.raw} vs ${t.b.raw}`, t] as const))("%s: the tournament favourite and the sim subject are the same archetype on the same side", (_, t) => {
    const sum = (rows: RawRow[]) => rows.reduce((s, r) => ({ wins: s.wins + r.wins, losses: s.losses + r.losses }), { wins: 0, losses: 0 });
    const fwd = sum(raw.filter((r) => r.leader === t.a.raw && r.aspect === t.a.baseAspects && r.opponentLeader === t.b.raw && r.opponentAspect === t.b.baseAspects));
    const rev = sum(raw.filter((r) => r.leader === t.b.raw && r.aspect === t.b.baseAspects && r.opponentLeader === t.a.raw && r.opponentAspect === t.a.baseAspects));
    // swumetastats lists every match once from each side.
    expect(fwd).toEqual({ wins: rev.losses, losses: rev.wins });

    const A = { leader: t.a.leader, baseAspects: t.a.baseAspects };
    const B = { leader: t.b.leader, baseAspects: t.b.baseAspects };
    const ab = tournamentRecord(pairs, A, B, 10);
    const ba = tournamentRecord(pairs, B, A, 10);
    expect(ab).not.toBeNull();
    expect(ba).toMatchObject({ wins: ab?.losses, losses: ab?.wins });
    // Base names resolve to aspects in the fold; the raw aspect word differs on a handful of rows only.
    expect(Math.abs((ab?.share as number) - fwd.wins / (fwd.wins + fwd.losses))).toBeLessThan(0.01);
    expect((ab?.share as number) > 0.5).toBe(fwd.wins > fwd.losses);

    const row = rec.gates.external.rows.find((r) => r.a === t.a.archetype && r.b === t.b.archetype);
    expect(row?.tournament).toEqual(ab);
    const pa = rec.panel.find((p) => p.archetype === row?.a);
    const pb = rec.panel.find((p) => p.archetype === row?.b);
    expect([pa?.leader, pa?.baseAspects, pb?.leader, pb?.baseAspects]).toEqual([t.a.leader, t.a.baseAspects, t.b.leader, t.b.baseAspects]);
    expect(rec.panel.indexOf(pa as GateRecord["panel"][number])).toBeLessThan(rec.panel.indexOf(pb as GateRecord["panel"][number]));
  });

  it("every panel list is a member of its archetype: the list's own leader and base aspects, not only the archetype's", () => {
    const keyOf = mapCardKeyOf(loadCardMap(RUN, ORIGINALS).setNumber.byId);
    const aspectsOf = storeAspectsOf(loadStore(RUN));
    const seen = rec.panel.map((p) => {
      const list = JSON.parse(readFileSync(path.join(REPO_ROOT, p.list.replace(/^file:/, "")), "utf8")) as { leader: { id: string }; base: { id: string } };
      const base = keyOf(list.base.id, "base");
      return [keyOf(list.leader.id, "leader"), base === null ? null : aspectsOf(base)];
    });
    expect(seen).toEqual(rec.panel.map((p) => [p.leader, p.baseAspects]));
  });

  it("swumetastats' wins column is the row leader's: it ranks leaders as the decklists' own match records do", () => {
    const table = new Map<string, { w: number; l: number }>();
    for (const r of raw) {
      if (r.leader === r.opponentLeader) continue;
      const c = table.get(r.leader) ?? { w: 0, l: 0 };
      c.w += r.wins;
      c.l += r.losses;
      table.set(r.leader, c);
    }
    const lists = new Map<string, { w: number; l: number }>();
    for (const f of readdirSync(DECKS)) {
      if (!f.startsWith("melee-")) continue;
      const d = JSON.parse(readFileSync(path.join(DECKS, f), "utf8")) as { leader?: { _name?: string }; metadata?: { matchRecord?: string } };
      const m = /^(\d+)-(\d+)-(\d+)$/.exec(d.metadata?.matchRecord ?? "");
      const name = d.leader?._name;
      if (m === null || name === undefined) continue;
      const c = lists.get(name) ?? { w: 0, l: 0 };
      c.w += Number(m[1]);
      c.l += Number(m[2]);
      lists.set(name, c);
    }
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [name, t] of table) {
      const d = lists.get(name);
      if (d === undefined || t.w + t.l < 300 || d.w + d.l < 300) continue;
      xs.push(t.w / (t.w + t.l));
      ys.push(d.w / (d.w + d.l));
    }
    expect(xs.length).toBeGreaterThanOrEqual(15);
    expect(spearman(xs, ys)).toBeGreaterThan(0.8);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

const hasEngine = hasData && existsSync(path.join(DEFAULT_FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(RUN, "replay.json"));

describe.skipIf(!hasEngine)("[engine] calibration seat and winner mapping on the pinned forceteki (#171)", () => {
  let engine: Engine;
  let bridge: CardBridge;
  let rec: GateRecord;

  beforeAll(() => {
    engine = loadEngine(DEFAULT_FORCETEKI);
    installSelectableCardsMemo(DEFAULT_FORCETEKI);
    bridge = loadCardBridge(RUN, ORIGINALS, DEFAULT_FORCETEKI);
    rec = gateRecordSchema.parse(JSON.parse(readFileSync(RECORD, "utf8")));
  }, 60_000);

  it("the winner is the seat whose opponent's base is destroyed, and the win counts for the archetype in that seat", { timeout: 60_000 }, async () => {
    const i = rec.panel.findIndex((p) => p.archetype === TRACED[0].a.archetype);
    const j = rec.panel.findIndex((p) => p.archetype === TRACED[0].b.archetype);
    const decks: DeckInput[] = rec.panel.map((p, k) => (k === i || k === j ? prepareDeck(bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, p.list.replace(/^file:/, "")), "utf8")), p.list) : (null as unknown as DeckInput)));
    const { pairs, jobs } = calibrationJobs(rec.panel.length, rec.seeds.gamesPerPair);
    const p = pairs.findIndex(([x, y]) => x === i && y === j);
    const checked = new Set<boolean>();
    for (const jb of jobs.filter((x: CalibrationJob) => x.pair === p)) {
      if (checked.has(jb.iFirst)) continue;
      const order = seats(jb);
      const { record, session } = await playMatch(engine, { seed: String(jb.seed), decks: [decks[order[0].archetype], decks[order[1].archetype]], policies: ["rung0", "rung0"], recordMode: "none", undo: false, codeCommit: "test" }, bridge.engineCardKeys);
      expect(record.header.decks.map((d) => d.leader)).toEqual(order.map((s) => rec.panel[s.archetype].leader));
      const w = record.footer.result.winner;
      if (!isDecisive(record.footer) || w === null || session === null) continue;
      const hp = session.players.map((pl) => (pl.base as unknown as { getHp(): number }).getHp());
      expect(record.footer.baseDamage[2 - w]).toBeGreaterThanOrEqual(hp[2 - w]);
      expect(record.footer.baseDamage[w - 1]).toBeLessThan(hp[w - 1]);
      expect(simRecordOf([jb], [record.footer], p)).toMatchObject({ wins: order[w - 1].archetype === i ? 1 : 0, n: 1 });
      checked.add(jb.iFirst);
      if (checked.size === 2) break;
    }
    expect([...checked].sort()).toEqual([false, true]);
  });
});
