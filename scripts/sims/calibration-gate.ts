/**
 * @displayName Simulation calibration gate
 * @strategicPurpose Decides whether one bot rung may report win shares through simulate_matchup (#115): it replays,
 * it is healthy, it beats the rungs below it, and its matchup win shares rank tournament matchups the way
 * swumetastats' tournament results do. Bot play and tournament results sit side by side, never pooled (D21); no
 * Karabast data is read (D22).
 * @tacticalObjective Takes the top archetypes by share with distinct leader and base aspects (one highest-placing
 * buildable melee list each, the sampler's deckPanel; or, with --lists k, the first k distinct lists of the sampler's
 * seeded placement-weighted draw per archetype, #171), plays every archetype pair on seeded seat-swapped game pairs
 * with the rung on both seats on the warm worker pool, reads the tournament matchup of each pair from
 * meta/winrates.json, replays a spread sample of the matches in this thread (worker equals thread, replay to the
 * same trace, undo on equals off for rungs 0 to 2), checks health from the same games and the ladder from the pinned
 * ladder records, and writes one deterministic gate record (src/sims/calibration.ts gateRecordSchema) per rung.
 * Emits pollable progress to reports/.progress/sims-calibration-<rung>.json.
 *
 * Seeds: the calibration range 4,000,000+, disjoint from the ladder's (scripts/sims/ladder.ts); the layout is
 * calibrationJobs (src/sims/calibration.ts).
 *
 *   node --import tsx --import ./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung1 [--games 40] [--top 12]
 *   ... --policy rung3:k=8 --ladder rung3-vs-rung0.json:random-spike,rung3-vs-rung1.json:rung1
 *   ... --policy rung1 --lists 3 --games 72 --out data/pinned/sim-calibration-v1/lists3
 *   ... --policy rung3v:k=8,ev=v1,horizon=round,noPass=1 --ladder rung3v-vs-rung0-final.json:random-spike,rung3v-vs-rung3-k8-final.json:rung3:k=8 --out data/pinned/sim-calibration-v1/e9
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadStore } from "../../src/data.js";
import { winRatesFileSchema } from "../../src/meta/schema.js";
import { REPO_ROOT } from "../../src/paths.js";
import {
  CALIBRATION_SEED0,
  CALIBRATION_THRESHOLDS,
  CALIBRATION_VERSION,
  calibrationJobs,
  externalGate,
  externalIntervals,
  gateRecordSchema,
  healthGate,
  isDecisive,
  ladderStep,
  seats,
  simRecordOf,
  tournamentRecord,
  type CalibrationJob,
  type CalibrationRow,
} from "../../src/sims/calibration.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { playMatch, replayMatch, type DeckInput, type MatchSpec } from "../../src/sims/match.js";
import { deckPanel, engineSetCodes, engineUnmappedCards, loadOpponentPool, mapCardKeyOf, sampleStratified, storeAspectsOf, type OpponentList } from "../../src/sims/opponents.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";
import { shareOf } from "../../src/sims/policies/ladder-stats.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { driverName, registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchFooter } from "../../src/sims/schemas.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../bench/card-map.js";
import { LiveStats } from "../../src/sims/live-stats.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_ORIGINALS, loadContext } from "./context.js";
import { prepareDeck } from "./decks.js";
import { KEEP_ALIVE_MS, provenanceOf } from "./live.js";
import { prepareLearned, registerLearned } from "./policy/learned.js";

/** The sampler seed of the --lists draw; fixed, so the same pool gives the same lists. */
const LIST_SEED = "calibration-lists-v1";
/** Draws per archetype from which the first k distinct lists are kept. */
const LIST_DRAWS = 200;
/** The pinned rollback-fidelity record a search rung cites in place of the undo comparison. */
const fidelityRecordOf = (kind: string, rung: number): string => `data/pinned/sim-ladder-v1/${kind === "learned" ? (rung === 4 ? "rung4" : "rung3v") : "rung3"}-fidelity.json`;
/** Default ladder steps per rung: against rung 0, and against its promoted predecessor (D79: rung 2 is not promoted). */
const DEFAULT_LADDER: Record<string, string> = {
  rung1: "rung1-vs-rung0.json:random-spike",
  "rung3:k=8": "rung3-vs-rung0.json:random-spike,rung3-vs-rung1.json:rung1",
  "rung3mc:playout=rung1,n=2": "rung3mc-vs-rung0.json:random-spike,rung3mc-vs-rung1.json:rung1",
};

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const rel = (p: string): string => path.relative(REPO_ROOT, p).split(path.sep).join("/");
const recordFileName = (spec: string): string => `calibration-${spec.replace(/[^A-Za-z0-9]+/g, "-")}.json`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowNegative: true,
    options: {
      policy: { type: "string" },
      top: { type: "string", default: "12" },
      games: { type: "string", default: "40" },
      lists: { type: "string", default: "1" },
      replay: { type: "string", default: String(CALIBRATION_THRESHOLDS.replayMatches) },
      workers: { type: "string", default: "12" },
      /** Games per worker per pool batch; progress ticks once a batch, so a slow rung needs a small one. */
      chunk: { type: "string", default: "40" },
      heap: { type: "string" },
      run: { type: "string", default: path.join(REPO_ROOT, "data/runs/2026-10-31") },
      meta: { type: "string", default: path.join(REPO_ROOT, "data/runs/2026-11-01") },
      decks: { type: "string", default: path.join(REPO_ROOT, "data/originals/decks/2026-10-17") },
      "ladder-dir": { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-ladder-v1") },
      ladder: { type: "string" },
      out: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-calibration-v1") },
      write: { type: "boolean", default: true },
    },
  });
  if (values.policy === undefined) throw new Error("--policy is required");
  if (!process.execArgv.some((a) => a.includes("ladder-preload"))) throw new Error("run with --import ./scripts/sims/ladder-preload.ts so the workers know the rungs");
  const spec = values.policy;
  const name = driverName(spec);
  const parsed = parsePolicySpec(spec);
  const searches = ["lookahead", "montecarlo", "learned", "human"].includes(parsed.kind);
  const fidelityRecord = fidelityRecordOf(parsed.kind, parsed.kind === "learned" ? parsed.rung : 3);
  const gamesPerPair = Number(values.games);
  const listsPer = Number(values.lists);
  if (!Number.isInteger(listsPer) || listsPer < 1) throw new Error("--lists must be a positive integer");
  const pilotRun = path.resolve(values.run);
  const metaRun = path.resolve(values.meta);
  const decksDir = path.resolve(values.decks);

  const tables = loadTables({ runDir: pilotRun, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
  const ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: pilotRun, originals: DEFAULT_ORIGINALS, "no-memo": false });
  const keys = ctx.bridge.engineCardKeys;
  const pin = ctx.engine.pin;

  const winratesFile = path.join(metaRun, "meta/winrates.json");
  const archetypesFile = path.join(metaRun, "meta/archetypes.json");
  const winrates = winRatesFileSchema.parse(JSON.parse(readFileSync(winratesFile, "utf8")));
  if (winrates.matchups === null || winrates.matchups === undefined) throw new Error(`${winratesFile} has no tournament matchups`);
  const cardMap = loadCardMap(pilotRun, path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const pool = loadOpponentPool({
    archetypesFile,
    decksDir,
    cardKeyOf: mapCardKeyOf(cardMap.setNumber.byId),
    baseAspectsOf: storeAspectsOf(loadStore(pilotRun)),
    unmappedCards: engineUnmappedCards(engineSetCodes(DEFAULT_FORCETEKI)),
  });
  const info = new Map(pool.archetypes.map((a) => [a.id, a]));
  const seen = new Set<string>();
  /** The first k distinct buildable lists of the sampler's seeded placement-weighted draw of one archetype. */
  const drawnLists = (archetypeId: string, archetypeName: string): OpponentList[] => {
    const out: OpponentList[] = [];
    const draws = sampleStratified(pool, [{ id: archetypeId, name: archetypeName, weight: 1, n: LIST_DRAWS, archetypeIds: [archetypeId] }], { seed: LIST_SEED }).draws;
    for (const d of draws) if (!out.some((l) => l.key === d.list.key) && out.length < listsPer) out.push(d.list);
    if (out.length < listsPer) throw new Error(`${archetypeId}: only ${out.length} distinct buildable lists in ${LIST_DRAWS} draws, fewer than --lists ${listsPer}`);
    return out;
  };
  const panel: { archetype: string; name: string; leader: string; baseAspects: string; share: number; lists: { list: string; sha256: string; deck: DeckInput }[] }[] = [];
  for (const e of deckPanel(pool, { top: pool.archetypes.length })) {
    const a = info.get(e.archetypeId);
    if (a === undefined || e.list === null) continue;
    const k = `${a.leaderKey}|${a.baseAspects}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const chosen = listsPer === 1 ? [e.list] : drawnLists(a.id, a.name);
    const lists = chosen.map((l) => {
      const file = path.join(decksDir, `${l.key}.json`);
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      return { list: `file:${rel(file)}`, sha256: sha256(JSON.stringify(raw)), deck: prepareDeck(ctx.bridge, raw, `file:${rel(file)}`) };
    });
    panel.push({ archetype: a.id, name: a.name, leader: a.leaderKey, baseAspects: a.baseAspects, share: a.share, lists });
    if (panel.length === Number(values.top)) break;
  }

  const { pairs, jobs } = calibrationJobs(panel.length, gamesPerPair, listsPer);
  const toSpec = (jb: CalibrationJob, recordMode: MatchSpec["recordMode"] = "none", undo = searches): MatchSpec => ({
    seed: String(jb.seed),
    decks: ((o) => [panel[o[0].archetype].lists[o[0].list].deck, panel[o[1].archetype].lists[o[1].list].deck] as const)(seats(jb)),
    policies: [name, name],
    recordMode,
    undo,
    codeCommit: ctx.codeCommit,
  });

  const nReplay = Math.min(Number(values.replay), jobs.length);
  const replayIdx = Array.from({ length: nReplay }, (_, k) => Math.floor((k * jobs.length) / nReplay));
  const job = `sims-calibration-${name.replace(/[^A-Za-z0-9]+/g, "-")}`;
  const p = progress(job, { total: jobs.length + nReplay * (searches ? 2 : 3), everyN: 25, keepAliveMs: KEEP_ALIVE_MS });
  // The live payload goes to the heartbeat only; the gate record below is built from footers and gates alone.
  const live = new LiveStats({ kind: "calibration", provenance: provenanceOf({ specs: [spec], seeds: { from: CALIBRATION_SEED0, to: Math.max(...jobs.map((jb) => jb.seed)) }, enginePin: pin.commit, codeCommit: ctx.codeCommit, run: path.basename(pilotRun) }) });
  live.beginPhase("games", jobs.length, null);
  process.env.SIMS_POLICY_SPECS = name;
  process.env.SIMS_RUN = pilotRun;
  const viewKeys = prepareLearned({ names: [name], engineCardKeys: keys });
  const workers = Number(values.workers);
  const resourceLimits = values.heap === undefined ? undefined : { maxOldGenerationSizeMb: Number(values.heap), maxYoungGenerationSizeMb: 24 };
  p.log(() => ({ phase: "starting workers", pairs: pairs.length, archetypes: panel.length, stats: live.snapshot() }));
  const sim = await createPool({ workers, pin, resourceLimits });
  const footers: MatchFooter[] = [];
  try {
    const parts: CalibrationJob[][] = [];
    const chunk = Number(values.chunk) * workers;
    for (let k = 0; k < jobs.length; k += chunk) parts.push(jobs.slice(k, k + chunk));
    const start = (part: CalibrationJob[]) => sim.run({ specs: part.map((jb) => toSpec(jb)), cardKeys: keys });
    let next = parts.length > 0 ? start(parts[0]) : null;
    for (let c = 0; c < parts.length; c++) {
      const current = next as ReturnType<typeof start>;
      next = c + 1 < parts.length ? start(parts[c + 1]) : null;
      for (const r of await current) {
        const jb = jobs[footers.length];
        const f = r.footer;
        const decisive = isDecisive(f);
        const [d0, d1] = f.coverage.decisions;
        const [a0, a1] = f.coverage.answered;
        // Archetype i of the pair is the subject: a row per archetype pair, not pooled (the headline stays empty).
        live.add({
          seed: jb.seed,
          winnerSeat: f.result.winner,
          endCondition: f.result.endCondition,
          error: f.error,
          rounds: f.result.rounds,
          decisions: f.result.decisions,
          won: decisive ? (f.result.winner === 1) === jb.iFirst : null,
          stratum: `${panel[jb.i].archetype} vs ${panel[jb.j].archetype}`,
          headline: false,
          fallback: { decisions: d0 + d1, fallback: d0 + d1 - (a0 + a1) },
        });
        footers.push(f);
      }
      p.tick(footers.length, () => ({ phase: "games", stats: live.snapshot() }));
    }
  } finally {
    await sim.close();
  }

  // Replay gate, in this thread.
  registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), [name], tables);
  if (viewKeys !== null) registerLearned(POLICIES, (ps) => new PolicyChain(ps as never), [name], tables, { viewKeys });
  let done = jobs.length;
  let workerEqualsThread = 0;
  let replayed = 0;
  let undoIdentical = searches ? null : 0;
  const failures: string[] = [];
  live.setCounter("replayChecksTotal", nReplay * (searches ? 2 : 3));
  const tickCheck = (phase: string): void => {
    done++;
    live.setCounter("replayChecksDone", done - jobs.length);
    live.setCounter("workerEqualsThread", workerEqualsThread);
    live.setCounter("replayed", replayed);
    if (undoIdentical !== null) live.setCounter("undoIdentical", undoIdentical);
    live.setCounter("replayFailures", failures.length);
    p.tick(done, () => ({ phase, stats: live.snapshot() }));
  };
  for (const idx of replayIdx) {
    const jb = jobs[idx];
    const rec = (await playMatch(ctx.engine, toSpec(jb, "compact"), keys)).record;
    if (rec.footer.traceSha256 === footers[idx].traceSha256) workerEqualsThread++;
    else failures.push(`seed ${jb.seed} pair ${jb.pair}: thread trace differs from the worker's`);
    tickCheck("replay");
    const out = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(rec)), keys, { byDescriptor: searches });
    if (out.ok && out.traceSha256 === rec.footer.traceSha256) replayed++;
    else failures.push(`seed ${jb.seed} pair ${jb.pair}: replay ${JSON.stringify(out.mismatch)}`);
    tickCheck("replay");
    if (!searches) {
      const undo = (await playMatch(ctx.engine, toSpec(jb, "none", true), keys)).record;
      if (undo.footer.traceSha256 === rec.footer.traceSha256) undoIdentical = (undoIdentical ?? 0) + 1;
      else failures.push(`seed ${jb.seed} pair ${jb.pair}: undo on changes the trace`);
      tickCheck("undo");
    }
  }
  const evidence = searches && existsSync(path.join(REPO_ROOT, fidelityRecord)) ? [{ file: fidelityRecord, sha256: sha256(readFileSync(path.join(REPO_ROOT, fidelityRecord))) }] : [];
  const replayGate = {
    pass: failures.length === 0 && workerEqualsThread === nReplay && replayed === nReplay && (searches ? evidence.length === 1 : undoIdentical === nReplay),
    matches: nReplay,
    workerEqualsThread,
    replayed,
    undoIdentical,
    evidence,
    note: searches
      ? `a search rung needs undo, so undo on and off are not compared here; rollback fidelity (every rollback restores the full state fingerprint, records replay by descriptor) is the ${parsed.kind === "learned" ? "rung's pinned" : "pinned rung 3"} fidelity record; replay here is by descriptor (the oracle)`
      : "replay re-runs the policies on the compact record; undo on is compared with undo off trace for trace",
    failures: failures.slice(0, 10),
  };

  // Health gate, from the calibration games.
  const ends: Record<string, number> = {};
  let decisions = 0;
  let answered = 0;
  for (const f of footers) {
    const e = f.result.endCondition === "base_destroyed" && f.result.winner === null ? "draw" : f.result.endCondition;
    ends[e] = (ends[e] ?? 0) + 1;
    decisions += f.coverage.decisions[0] + f.coverage.decisions[1];
    answered += f.coverage.answered[0] + f.coverage.answered[1];
  }
  const health = {
    ...healthGate({ games: footers.length, nonDecisive: footers.filter((f) => !isDecisive(f)).length, decisions, fallback: decisions - answered }, CALIBRATION_THRESHOLDS),
    endConditions: Object.fromEntries(Object.entries(ends).sort(([a], [b]) => compareCodePoints(a, b))),
  };

  // Ladder gate, from the pinned ladder records.
  const want = { candidate: spec, engineCommit: pin.commit, inputs: { scoresSha256: tables.pins.scoresSha256, coefficientsSha256: tables.pins.coefficientsSha256, featuresSha256: tables.pins.featuresSha256 } };
  const ladderSpec = values.ladder ?? DEFAULT_LADDER[spec];
  if (ladderSpec === undefined) throw new Error(`no default ladder steps for ${spec}; pass --ladder <file>:<baseline>,...`);
  const steps = ladderSpec.split(",").map((s) => {
    // A baseline name can hold a colon (rung3:k=8), so only the first one separates it from the file.
    const cut = s.indexOf(":");
    if (cut < 0) throw new Error(`--ladder step ${s} needs <file>:<baseline>`);
    const [file, baseline] = [s.slice(0, cut), s.slice(cut + 1)];
    const full = path.join(values["ladder-dir"], file);
    const bytes = existsSync(full) ? readFileSync(full) : null;
    return ladderStep(rel(full), bytes === null ? null : JSON.parse(bytes.toString("utf8")), bytes === null ? null : sha256(bytes), { ...want, baseline });
  });
  const ladder = { pass: steps.length > 0 && steps.every((s) => s.pass), steps };

  // External calibration gate.
  const rows: CalibrationRow[] = [];
  pairs.forEach(([i, j], pIdx) => {
    const t = tournamentRecord(winrates.matchups?.pairs ?? [], { leader: panel[i].leader, baseAspects: panel[i].baseAspects }, { leader: panel[j].leader, baseAspects: panel[j].baseAspects }, CALIBRATION_THRESHOLDS.minN);
    if (t === null) return;
    const { wins, n, nonDecisive } = simRecordOf(jobs, footers, pIdx);
    const s = shareOf(wins, n);
    rows.push({ a: panel[i].archetype, b: panel[j].archetype, aName: panel[i].name, bName: panel[j].name, tournament: t, sim: { wins, n, share: s.share, low: s.low, high: s.high, nonDecisive } });
  });
  const ext = externalGate(rows, CALIBRATION_THRESHOLDS);
  const m = winrates.matchups;
  const external = {
    ...ext,
    simLabel: `bot play (forceteki ${spec}), not human results: ${gamesPerPair} games per archetype pair, ${listsPer === 1 ? "one highest-placing buildable melee list per archetype" : `${listsPer} placement-weighted buildable melee lists per archetype (sampler seed ${LIST_SEED}), every list pairing on the same number of seeds`}, the rung on both seats`,
    tournamentLabel: `${m?.label ?? "tournament matchups"}, ${m?.period.from} to ${m?.period.to}, minN ${CALIBRATION_THRESHOLDS.minN}`,
    rows,
  };

  const gates = { replay: replayGate, health, ladder, external };
  const failedGates = (["replay", "health", "ladder", "external"] as const).filter((g) => !gates[g].pass);
  const header = policyHeader(parsePolicySpec(spec));
  const record = gateRecordSchema.parse({
    schemaVersion: 1,
    step: `calibration-${name}`,
    calibrationVersion: CALIBRATION_VERSION,
    label: `bot play (forceteki ${spec}), not human results`,
    policy: { ...header, driverPolicy: name },
    engine: { repo: pin.repo, commit: pin.commit, cardDataVersion: pin.cardDataVersion, cardDataSha256: pin.cardDataSha256 },
    inputs: {
      scoresSha256: tables.pins.scoresSha256,
      coefficientsSha256: tables.pins.coefficientsSha256,
      featuresSha256: tables.pins.featuresSha256,
      leaderCardsSha256: tables.pins.leaderCardsSha256,
      winratesSha256: sha256(readFileSync(winratesFile)),
      archetypesSha256: sha256(readFileSync(archetypesFile)),
    },
    pilotRun: path.basename(pilotRun),
    metaRun: path.basename(metaRun),
    decks: rel(decksDir),
    codeCommit: ctx.codeCommit,
    thresholds: { ...CALIBRATION_THRESHOLDS },
    seeds: {
      from: CALIBRATION_SEED0,
      to: Math.max(...jobs.map((jb) => jb.seed)),
      gamesPerPair,
      scheme: `engine seed <seed>; pair p (archetypes i < j in panel order) plays seeds 4000000 + 1000p + q, q < gamesPerPair / 2, each seed twice with the seats swapped${listsPer === 1 ? "" : `; seed q plays list pairing c = q mod ${listsPer * listsPer}, list floor(c / ${listsPer}) of i against list c mod ${listsPer} of j (panel entries of an archetype in list order)`}`,
      ...(listsPer === 1 ? {} : { listsPerArchetype: listsPer }),
    },
    panel: panel.flatMap((e) => e.lists.map((l) => ({ archetype: e.archetype, name: e.name, leader: e.leader, baseAspects: e.baseAspects, share: e.share, list: l.list, sha256: l.sha256 }))),
    gates,
    pass: failedGates.length === 0,
    servesWinShare: failedGates.length === 0,
    failedGates,
  });
  if (values.write) {
    mkdirSync(values.out, { recursive: true });
    writeFileSync(path.join(values.out, recordFileName(spec)), `${JSON.stringify(record, null, 1)}\n`);
  }
  p.done({ pass: record.pass, failedGates, stats: live.snapshot() });
  const brief = { policy: spec, pass: record.pass, failedGates, replay: { ...replayGate }, health, ladder: steps.map((s) => ({ record: s.record, pass: s.pass, stale: s.stale })), external: { spearman: ext.spearman, favourite: ext.favourite, pairs: ext.pairs, failed: ext.failed, intervals: externalIntervals(ext) } };
  process.stdout.write(`${JSON.stringify(brief, null, 1)}\n`);
}

await main();
