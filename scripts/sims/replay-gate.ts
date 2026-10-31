/**
 * @displayName Simulation replay gate
 * @strategicPurpose The evidence #110 asks for before any later step trusts a record: matches over the deck panel
 * replay to identical traceSha256, worker threads equal one thread, and rung-0 traces do not depend on undo mode.
 * @tacticalObjective Plays the panel matches in this thread (timed), replays every record, plays them again on a cold
 * and then a warm worker pool (timed) and once more with undo on, compares everything and prints one JSON report.
 * With --search N (#163) it also plays the first N matches with rung 1 and rung 2 on both seats with undo off and on
 * (traces must not move), and N matches of a rung 3 seat against rung 1 in fidelity mode: every trial's rollback must
 * restore the full state fingerprint, and each record must replay by descriptor with no trials (the replay oracle)
 * and with its own policies, to the same trace, and on worker pools of each --search-workers size to the same traces
 * (run with --import=./scripts/sims/ladder-preload.ts); --out writes that part as a deterministic gate record.
 * Exit 1 on any difference.
 *
 * Usage: tsx scripts/sims/replay-gate.ts [--matches 50] [--workers 8] [--seed0 1] [--search 20 --rung3 "rung3|rung3mc" --out <file>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { playMatch, replayMatch, type MatchSpec } from "../../src/sims/match.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchRecord } from "../../src/sims/schemas.js";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/swu/canonical.js";
import { isMain } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { contextOptions, loadContext } from "./context.js";
import { loadDeck } from "./decks.js";

const DECKS = path.join(REPO_ROOT, "data/originals/decks/2026-10-17");

/** The owner's reference deck and the spike's three tournament lists (Krennic, Cad Bane, Luke). */
export const DECK_PANEL = [
  path.join(REPO_ROOT, "tests/fixtures/decks/warrior-chewie-raid.swudb.json"),
  path.join(DECKS, "melee-0b373cb2-6dfb-425e-842d-b4a700e2d337.json"),
  path.join(DECKS, "melee-6563300e-ae56-49d6-b88c-b3ea0151a4da.json"),
  path.join(DECKS, "melee-1a7b3451-7300-4e19-b69b-b44200bbce01.json"),
];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      ...contextOptions,
      matches: { type: "string", default: "50" },
      workers: { type: "string", default: "8" },
      seed0: { type: "string", default: "1" },
      search: { type: "string", default: "0" },
      rung3: { type: "string", default: "rung3" },
      rung2: { type: "string", default: "rung2:mu=0,lambda=1" },
      out: { type: "string" },
      "search-workers": { type: "string", default: "3,12" },
    },
  });
  const ctx = loadContext(values);
  const keys = ctx.bridge.engineCardKeys;
  const panel = DECK_PANEL.map((f) => loadDeck(ctx.bridge, f));
  const pairs: [number, number][] = [];
  for (let a = 0; a < panel.length; a++) for (let b = a + 1; b < panel.length; b++) pairs.push([a, b]);
  const n = Number(values.matches);
  const specs: MatchSpec[] = Array.from({ length: n }, (_, i) => {
    const [a, b] = pairs[i % pairs.length];
    const swap = Math.floor(i / pairs.length) % 2 === 1;
    return { seed: String(Number(values.seed0) + i), decks: swap ? [panel[b], panel[a]] : [panel[a], panel[b]], policies: ["rung0", "rung0"], recordMode: "compact", undo: false, codeCommit: ctx.codeCommit };
  });
  const nSearch = Number(values.search);
  const p = progress("sims-replay-gate", { total: n * 5 + nSearch * (2 + (values.rung3 as string).split("|").filter(Boolean).length), everyN: 1 });
  let done = 0;
  const failures: string[] = [];

  const t1 = performance.now();
  const single: MatchRecord[] = [];
  for (const s of specs) {
    single.push((await playMatch(ctx.engine, s, keys)).record);
    p.tick(++done);
  }
  const singleMs = performance.now() - t1;

  let replayed = 0;
  for (const r of single) {
    const out = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(r)), keys);
    if (out.ok && out.traceSha256 === r.footer.traceSha256) replayed += 1;
    else failures.push(`replay seed ${r.header.seed}: ${JSON.stringify(out.mismatch)}`);
    p.tick(++done);
  }

  const workers = Number(values.workers);
  const tPool = performance.now();
  const pool = await createPool({ workers, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
  const poolStartMs = performance.now() - tPool;
  const tCold = performance.now();
  const cold = await pool.run({ specs, cardKeys: keys });
  const coldMs = performance.now() - tCold;
  done += n;
  p.tick(done);
  const tWarm = performance.now();
  const warm = await pool.run({ specs, cardKeys: keys });
  const warmMs = performance.now() - tWarm;
  await pool.close();
  done += n;
  p.tick(done);
  const sameAsSingle = (rs: MatchRecord[]): number => rs.filter((r, i) => canonicalJson(r) === canonicalJson(single[i])).length;
  const coldEqual = sameAsSingle(cold);
  const warmEqual = sameAsSingle(warm);
  if (coldEqual !== n) failures.push(`cold pool: ${n - coldEqual} records differ from single-thread`);
  if (warmEqual !== n) failures.push(`warm pool: ${n - warmEqual} records differ from single-thread`);

  let undoEqual = 0;
  for (const [i, s] of specs.entries()) {
    const r = (await playMatch(ctx.engine, { ...s, undo: true }, keys)).record;
    if (canonicalJson(r.footer) === canonicalJson(single[i].footer) && canonicalJson(r.decisions) === canonicalJson(single[i].decisions)) undoEqual += 1;
    else failures.push(`undo on: seed ${s.seed} differs`);
    p.tick(++done);
  }

  // #163: undo must not move rung 1 or rung 2 traces, and a rung 3 seat's rollbacks must leave no residue.
  let searchReport: Record<string, unknown> | null = null;
  if (nSearch > 0) {
    const tables = loadTables({ runDir: values.run, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: true });
    registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), ["rung1", values.rung2, ...values.rung3.split("|").filter(Boolean)], tables);
    const searchSpecs = specs.length >= nSearch ? specs.slice(0, nSearch) : Array.from({ length: nSearch }, (_, i) => {
      const [a, b] = pairs[i % pairs.length];
      return { ...specs[0], seed: String(Number(values.seed0) + i), decks: [panel[a], panel[b]] as const };
    });
    const undoSame: Record<string, number> = {};
    for (const pol of ["rung1", values.rung2]) {
      undoSame[pol] = 0;
      for (const sp of searchSpecs) {
        const mine: MatchSpec = { ...sp, policies: [pol, "rung1"] };
        const off = (await playMatch(ctx.engine, mine, keys)).record;
        const on = (await playMatch(ctx.engine, { ...mine, undo: true }, keys)).record;
        if (canonicalJson(on.footer) === canonicalJson(off.footer) && canonicalJson(on.decisions) === canonicalJson(off.decisions)) undoSame[pol] += 1;
        else failures.push(`undo on: ${pol} seed ${sp.seed} differs`);
        p.tick(++done);
      }
    }
    const rung3Specs = values.rung3.split("|").filter(Boolean);
    const fidelity = [];
    const searchMatchSpecs: MatchSpec[][] = [];
    const singleTraces: string[][] = [];
    for (const r3 of rung3Specs) {
      const fid = { spec: r3, matches: 0, decisions: 0, searches: 0, rollbacks: 0, verifiedRollbacks: 0, searchErrors: 0, oracleIdentical: 0, policyReplayIdentical: 0, endConditions: {} as Record<string, number>, tracesSha256: "" };
      const traces: string[] = [];
      searchMatchSpecs.push([]);
      for (const [i, sp] of searchSpecs.entries()) {
        const seat = i % 2;
        const mine: MatchSpec = { ...sp, policies: seat === 0 ? [r3, "rung1"] : ["rung1", r3], undo: true, recordMode: "compact" };
        searchMatchSpecs[searchMatchSpecs.length - 1].push(mine);
        const { record, session } = await playMatch(ctx.engine, mine, keys, { verifyRollback: true });
        p.tick(++done);
        fid.matches += 1;
        fid.decisions += record.footer.result.decisions;
        fid.endConditions[record.footer.result.endCondition] = (fid.endConditions[record.footer.result.endCondition] ?? 0) + 1;
        traces.push(record.footer.traceSha256);
        if (record.footer.error !== null) failures.push(`rung 3 fidelity ${r3} seed ${sp.seed}: ${record.footer.error}`);
        if (session !== null) {
          const c = (session.opts.chains[seat].top as unknown as { counters: Record<string, number> }).counters;
          fid.searches += c.searches;
          fid.searchErrors += (c.trialErrors ?? 0) + (c.playoutErrors ?? 0);
          fid.rollbacks += session.search.rollbacks;
          fid.verifiedRollbacks += session.search.verified;
          if (session.search.verified !== session.search.rollbacks) failures.push(`rung 3 fidelity ${r3} seed ${sp.seed}: ${session.search.verified} of ${session.search.rollbacks} rollbacks verified`);
        }
        const oracle = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys, { byDescriptor: true });
        if (oracle.ok && oracle.traceSha256 === record.footer.traceSha256) fid.oracleIdentical += 1;
        else failures.push(`rung 3 replay oracle ${r3} seed ${sp.seed}: ${JSON.stringify(oracle.mismatch)}`);
        const again = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(record)), keys);
        if (again.ok && again.traceSha256 === record.footer.traceSha256) fid.policyReplayIdentical += 1;
        else failures.push(`rung 3 policy replay ${r3} seed ${sp.seed}: ${JSON.stringify(again.mismatch)}`);
      }
      fid.tracesSha256 = createHash("sha256").update(traces.join("\n")).digest("hex");
      fidelity.push(fid);
      singleTraces.push(traces);
    }
    // The same rung 3 matches on worker pools of different sizes: every trace must equal the single-thread one.
    if (!process.execArgv.some((a) => a.includes("ladder-preload"))) throw new Error("--search needs --import=./scripts/sims/ladder-preload.ts so pool workers know the rung 3 policies");
    process.env.SIMS_POLICY_SPECS = ["rung1", ...rung3Specs].join(";");
    process.env.SIMS_RUN = values.run;
    process.env.SIMS_DRIVER_ROOT = REPO_ROOT;
    const workerCounts = values["search-workers"].split(",").map(Number);
    const acrossWorkers: { workers: number; spec: string; identical: number; of: number }[] = [];
    for (const w of workerCounts) {
      const wpool = await createPool({ workers: w, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
      try {
        for (const [si, r3] of rung3Specs.entries()) {
          const recs = await wpool.run({ specs: searchMatchSpecs[si], cardKeys: keys });
          const identical = recs.filter((r, i) => r.footer.traceSha256 === singleTraces[si][i]).length;
          acrossWorkers.push({ workers: w, spec: r3, identical, of: recs.length });
          if (identical !== recs.length) failures.push(`rung 3 ${r3} on ${w} workers: ${recs.length - identical} traces differ from one thread`);
        }
      } finally {
        await wpool.close();
      }
    }
    searchReport = { matches: searchSpecs.length, seeds: searchSpecs.map((x) => x.seed), undoOnIdentical: undoSame, rung3: fidelity, acrossWorkers };
    if (values.out) {
      mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
      const record = {
        schemaVersion: 1,
        step: "rung3-fidelity",
        label: "bot play (forceteki, typed driver), not human results",
        engine: { commit: ctx.engine.pin.commit, cardDataVersion: ctx.engine.pin.cardDataVersion, cardDataSha256: ctx.engine.pin.cardDataSha256 },
        codeCommit: ctx.codeCommit,
        panel: panel.map((d) => d.source),
        method: "each match: rung 3 seat in fidelity mode (every rollback compared with the full state fingerprint taken at its bookmark), then the record replayed by descriptor with no trials (the oracle: legal-action hash and engine RNG cursor at every decision, then result, cards played, base damage, end board and trace) and replayed with its own policies; rung 1 and rung 2 matches played with undo off and on and compared record for record; the rung 3 matches played again on worker pools of each size in acrossWorkers and compared trace for trace with one thread",
        ...searchReport,
        failures: failures.filter((x) => /rung 3|undo on: rung/.test(x)),
      };
      writeFileSync(path.resolve(values.out), `${JSON.stringify(record, null, 1)}\n`);
    }
  }
  p.done({ failures: failures.length });

  const gps = (games: number, ms: number): number => Math.round((games / ms) * 10000) / 10;
  const results = single.map((r) => r.footer.result);
  console.log(
    JSON.stringify(
      {
        matches: n,
        panel: panel.map((d) => d.source),
        pairs: pairs.length,
        endConditions: Object.fromEntries(["base_destroyed", "draw", "timeout", "stuck", "error"].map((e) => [e, results.filter((r) => r.endCondition === e).length])),
        replayedIdenticalTrace: replayed,
        workerThreads: { workers, coldEqual, warmEqual },
        undoOnEqual: undoEqual,
        distinctTraces: new Set(single.map((r) => r.footer.traceSha256)).size,
        throughput: {
          singleThreadGamesPerSecond: gps(n, singleMs),
          singleThreadMsPerGame: Math.round(singleMs / n),
          meanDecisionsPerGame: Math.round(results.reduce((a, r) => a + r.decisions, 0) / n),
          poolStartMs: Math.round(poolStartMs),
          coldPoolGamesPerSecond: gps(n, coldMs),
          warmPoolGamesPerSecond: gps(n, warmMs),
        },
        search: searchReport,
        failures,
      },
      null,
      1,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
}

if (isMain(import.meta.url)) await main();
