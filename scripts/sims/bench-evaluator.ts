/**
 * @displayName Evaluator throughput, latency and identity gate
 * @strategicPurpose Proves the evaluator runs inside the game loop without losing batch throughput (#127), with a gate
 * that cannot pass vacuously: interleaved same-session A/B ratios, a calls check, and value hashes that see drift
 * below the recorded rounding.
 * @tacticalObjective On the three real-list pairs (Krennic, Cad Bane, Luke; scripts/sims/replay-gate.ts DECK_PANEL)
 * with the ranking pilot on both seats (rung 2 was never promoted, D79, so the ladder-passing `rung1:sacGuard=1,handCap=1`
 * stands in, D92, D95): R repetitions, each playing off, per-prompt and per-action on the same seeds and worker pool in
 * rotated order; per-stage latency (extract, encode plus flatten, forward) in this thread on real states, for the
 * adopted evaluator and a synthetic 64,32 network; recordSha256 and valueSha256 per seed across 1, 4, 8 and 12 workers,
 * traceSha256 against the evaluator-off run, and seed 105 in a fresh process. Writes data/runs/<date>/sims/evaluator-gate.json
 * or --out (timings are not replayable, so it carries inputsHash and codeCommit but no outputHash) and pollable progress.
 *
 * Usage: node --import tsx --import ./scripts/sims/ladder-preload.ts scripts/sims/bench-evaluator.ts --date <d>
 *   [--out <file>] [--games 240] [--reps 5] [--evaluator data/pinned/sim-evaluators/v1.json] [--workers auto]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { topCoreClassSize } from "../../src/sims/engine.js";
import { playMatch, type MatchSpec } from "../../src/sims/match.js";
import { OBSERVERS, POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchFooter } from "../../src/sims/schemas.js";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import { codeCommit, isMain } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { contextOptions, loadContext } from "./context.js";
import { loadDeck } from "./decks.js";
import { createScorer, evaluatorObserver, loadLearnedInputs, OBSERVER_NAMES } from "./evaluator-hook.js";
import { prepareLearned, registerLearned, registerObservers } from "./policy/learned.js";
import { DECK_PANEL } from "./replay-gate.js";

const PAIR_NAMES = ["krennic", "cad-bane", "luke"] as const;
const CONFIGS = ["off", "per-prompt", "per-action"] as const;
type Config = (typeof CONFIGS)[number];
export const GATE = { minRatio: 0.85, minGamesPerSecond: 15, minReps: 5, p50Us: 250, p99Us: 1000 } as const;

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (xs: readonly number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const spread = (xs: readonly number[]) => ({ median: r3(median(xs)), min: r3(Math.min(...xs)), max: r3(Math.max(...xs)), n: xs.length });

/** Rotation r of the configurations: ABC, BCA, CAB, ABC, ... */
export const rotation = (r: number): Config[] => CONFIGS.map((_, i) => CONFIGS[(i + r) % CONFIGS.length]);

/** The four-part pass rule for one pair (#127 "Throughput gate"). */
export function passRule(ratios: readonly number[], onGamesPerSecond: readonly number[], callsOk: boolean): { pass: boolean; ratio: boolean; absolute: boolean; calls: boolean; reps: boolean } {
  const ratio = median(ratios) >= GATE.minRatio;
  const absolute = median(onGamesPerSecond) >= GATE.minGamesPerSecond;
  const reps = ratios.length >= GATE.minReps;
  return { pass: ratio && absolute && callsOk && reps, ratio, absolute, calls: callsOk, reps };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      ...contextOptions,
      date: { type: "string" },
      out: { type: "string" },
      games: { type: "string", default: "240" },
      reps: { type: "string", default: "5" },
      policy: { type: "string", default: "rung1:sacGuard=1,handCap=1" },
      evaluator: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-evaluators/v1.json") },
      synthetic: { type: "string", default: "synthetic:64,32" },
      workers: { type: "string", default: "auto" },
      seed0: { type: "string", default: "100" },
      "identity-seeds": { type: "string", default: "30" },
      "identity-workers": { type: "string", default: "1,4,8,12" },
      "latency-games": { type: "string", default: "10" },
    },
  });
  if (values.date === undefined) throw new Error("--date is required");
  if (!process.execArgv.some((a) => a.includes("ladder-preload"))) throw new Error("run with --import ./scripts/sims/ladder-preload.ts so the workers know the pilot and the evaluator");
  const ctx = loadContext(values);
  const keys = ctx.bridge.engineCardKeys;
  const panel = DECK_PANEL.slice(1).map((f) => loadDeck(ctx.bridge, f));
  const pairs: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  const pairName = ([a, b]: [number, number]): string => `${PAIR_NAMES[a]}-vs-${PAIR_NAMES[b]}`;
  const games = Number(values.games);
  const reps = Number(values.reps);
  const seed0 = Number(values.seed0);
  const workers = values.workers === "auto" ? topCoreClassSize() : Number(values.workers);
  const policy = values.policy;
  const tables = loadTables({ runDir: values.run, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
  const viewKeys = prepareLearned({ names: [policy], engineCardKeys: keys, evaluator: values.evaluator });
  if (viewKeys === null) throw new Error("no evaluator inputs");
  registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), [policy], tables);
  registerLearned(POLICIES, (ps) => new PolicyChain(ps as never), [policy], tables, { viewKeys });
  registerObservers(OBSERVERS, { evaluator: values.evaluator, viewKeys });
  process.env.SIMS_POLICY_SPECS = policy;
  process.env.SIMS_RUN = values.run;
  const adopted = loadLearnedInputs({ evaluator: values.evaluator, viewKeys });

  const spec = (pair: [number, number], seed: number, config: Config): MatchSpec => ({
    seed: String(seed),
    decks: [panel[pair[0]], panel[pair[1]]],
    policies: [policy, policy],
    recordMode: "none",
    undo: false,
    codeCommit: ctx.codeCommit,
    ...(config === "off" ? {} : { observer: OBSERVER_NAMES[config] }),
  });
  const identitySeeds = Number(values["identity-seeds"]);
  const identityWorkers = values["identity-workers"].split(",").map(Number);
  const latencyGames = Number(values["latency-games"]);
  const p = progress("sims-bench-evaluator", { total: 2 * latencyGames * pairs.length + reps * CONFIGS.length * pairs.length * games + pairs.length * identitySeeds * (identityWorkers.length + 1), everyN: 1 });
  let done = 0;

  // Latency on real states in this thread: each stage timed separately (#127 must-fix 5).
  const latency: Record<string, unknown> = {};
  for (const ev of [values.synthetic, values.evaluator]) {
    const li = loadLearnedInputs({ evaluator: ev, viewKeys });
    const scorer = createScorer(li, { timed: true });
    OBSERVERS["evaluator-timed"] = () => evaluatorObserver(li, "per-prompt", scorer);
    for (const pair of pairs)
      for (let g = 0; g < latencyGames; g++) {
        await playMatch(ctx.engine, { ...spec(pair, seed0 + g, "off"), observer: "evaluator-timed" }, keys);
        p.tick(++done, { phase: `latency ${li.evaluator.version}` });
      }
    const t = scorer.timings;
    if (t === null) throw new Error("untimed scorer");
    const total = t.extract.map((x, i) => x + t.encode[i] + t.forward[i]);
    const stage = (xs: number[]) => ({ p50Us: r3(quantile(xs, 0.5)), p99Us: r3(quantile(xs, 0.99)) });
    latency[li.evaluator.version] = { calls: total.length, extract: stage(t.extract), encodeFlatten: stage(t.encode), forward: stage(t.forward), total: stage(total), pass: quantile(total, 0.5) <= GATE.p50Us && quantile(total, 0.99) <= GATE.p99Us };
    delete OBSERVERS["evaluator-timed"];
  }

  // Throughput: interleaved A/B/C on one pool, same seeds, rotated order per repetition.
  const pool = await createPool({ workers, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
  const repRows: { rep: number; order: Config[]; pair: string; config: Config; gamesPerSecond: number; mainDecisionsPerGame: number; callsPerGame: number; callsOk: boolean }[] = [];
  try {
    // Untimed warm-up of every configuration, so the first timed cell does not pay the workers' JIT warm-up.
    for (const config of CONFIGS) await pool.run({ specs: Array.from({ length: 2 * workers }, (_, g) => spec(pairs[0], seed0 + g, config)), cardKeys: keys });
    for (let r = 0; r < reps; r++) {
      const order = rotation(r);
      for (const config of order)
        for (const pair of pairs) {
          const specs = Array.from({ length: games }, (_, g) => spec(pair, seed0 + g, config));
          const t = performance.now();
          const recs = await pool.run({ specs, cardKeys: keys });
          const s = (performance.now() - t) / 1000;
          done += games;
          p.tick(done, { phase: `rep ${r} ${config} ${pairName(pair)}` });
          const obs = recs.map((x) => x.footer.observer);
          const mainDecisions = obs.reduce((a, o) => a + (o?.mainDecisions ?? 0), 0);
          const calls = obs.reduce((a, o) => a + (o?.calls ?? 0), 0);
          const callsOk =
            config === "off"
              ? obs.every((o) => o === undefined)
              : config === "per-prompt"
                ? obs.every((o) => o !== undefined && o.mainDecisions > 0 && o.calls === o.mainDecisions)
                : obs.every((o) => o !== undefined && o.mainDecisions > 0 && o.calls >= o.mainDecisions);
          repRows.push({ rep: r, order, pair: pairName(pair), config, gamesPerSecond: r3(games / s), mainDecisionsPerGame: r3(mainDecisions / games), callsPerGame: r3(calls / games), callsOk });
        }
    }
  } finally {
    await pool.close();
  }
  const perPair = pairs.map((pair) => {
    const name = pairName(pair);
    const rows = (c: Config) => repRows.filter((x) => x.pair === name && x.config === c).sort((a, b) => a.rep - b.rep);
    const off = rows("off");
    const out: Record<string, unknown> = { pair: name };
    for (const c of CONFIGS) out[c] = { gamesPerSecond: spread(rows(c).map((x) => x.gamesPerSecond)), mainDecisionsPerGame: rows(c)[0]?.mainDecisionsPerGame ?? null, callsPerGame: rows(c)[0]?.callsPerGame ?? null };
    for (const c of ["per-prompt", "per-action"] as const) {
      const on = rows(c);
      const ratios = on.map((x, i) => x.gamesPerSecond / off[i].gamesPerSecond);
      out[`${c}Ratio`] = spread(ratios);
      out[`${c}Pass`] = passRule(ratios, on.map((x) => x.gamesPerSecond), on.every((x) => x.callsOk) && off.every((x) => x.callsOk));
    }
    return out;
  });

  // Identity: per-prompt hashes per seed on every worker count, traces against the evaluator-off run, a fresh process.
  const identity: Record<string, unknown>[] = [];
  const failures: string[] = [];
  for (const pair of pairs) {
    const name = pairName(pair);
    const seeds = Array.from({ length: identitySeeds }, (_, i) => seed0 + i);
    const byWorkers: Record<number, MatchFooter[]> = {};
    for (const w of identityWorkers) {
      const wp = await createPool({ workers: w, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
      try {
        byWorkers[w] = (await wp.run({ specs: seeds.map((s) => spec(pair, s, "per-prompt")), cardKeys: keys })).map((x) => x.footer);
      } finally {
        await wp.close();
      }
      done += seeds.length;
      p.tick(done, { phase: `identity ${name} ${w} workers` });
    }
    const offPool = await createPool({ workers, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
    let off: MatchFooter[];
    try {
      off = (await offPool.run({ specs: seeds.map((s) => spec(pair, s, "off")), cardKeys: keys })).map((x) => x.footer);
    } finally {
      await offPool.close();
    }
    done += seeds.length;
    p.tick(done, { phase: `identity ${name} off` });
    const ref = byWorkers[identityWorkers[0]];
    const firstDiff = (f: (a: MatchFooter, b: MatchFooter) => boolean, other: MatchFooter[]): number | null => {
      const i = other.findIndex((x, j) => !f(ref[j], x));
      return i < 0 ? null : seeds[i];
    };
    const sameHashes = (a: MatchFooter, b: MatchFooter) => a.observer?.recordSha256 === b.observer?.recordSha256 && a.observer?.valueSha256 === b.observer?.valueSha256;
    const acrossWorkers = identityWorkers.map((w) => ({ workers: w, firstDifferingSeed: firstDiff(sameHashes, byWorkers[w]) }));
    const traceVsOff = firstDiff((a, b) => a.traceSha256 === b.traceSha256, off);
    const fresh = JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "scripts/sims/play.ts", "--deck1", DECK_PANEL[pair[0] + 1], "--deck2", DECK_PANEL[pair[1] + 1], "--seed", "105", "--record", "none", "--policy1", policy, "--policy2", policy, "--evaluator", values.evaluator],
        { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "ignore"] },
      )
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))[0],
    ) as { observer?: { recordSha256: string; valueSha256: string } };
    const inBatch = ref[seeds.indexOf(105)];
    const freshOk = inBatch !== undefined && fresh.observer?.recordSha256 === inBatch.observer?.recordSha256 && fresh.observer?.valueSha256 === inBatch.observer?.valueSha256;
    for (const a of acrossWorkers) if (a.firstDifferingSeed !== null) failures.push(`${name}: ${a.workers} workers differ first at seed ${a.firstDifferingSeed}`);
    if (traceVsOff !== null) failures.push(`${name}: traceSha256 with the evaluator differs from off first at seed ${traceVsOff}`);
    if (!freshOk) failures.push(`${name}: seed 105 in a fresh process differs from the batch`);
    identity.push({ pair: name, seeds: { from: seeds[0], to: seeds[seeds.length - 1] }, acrossWorkers, traceVsOffFirstDifferingSeed: traceVsOff, fresh105Identical: freshOk, recordsSha256: sha256Hex(ref.map((f) => `${f.observer?.recordSha256}|${f.observer?.valueSha256}`).join("\n")) });
  }

  const throughputPass = perPair.every((x) => (x["per-promptPass"] as { pass: boolean }).pass);
  const latencyPass = Object.values(latency).every((x) => (x as { pass: boolean }).pass);
  const pass = throughputPass && latencyPass && failures.length === 0;
  const inputs = { policy, evaluator: { version: adopted.evaluator.version, sha256: adopted.evaluator.sha256, featureLayoutSha256: adopted.layout.sha256 }, vocabSha256: adopted.vocab.contentSha256, decks: DECK_PANEL.slice(1).map((f) => path.relative(REPO_ROOT, f)), engine: { commit: ctx.engine.pin.commit, cardDataSha256: ctx.engine.pin.cardDataSha256 }, games, reps, seed0, workers, identitySeeds, identityWorkers };
  const report = {
    schemaVersion: 1,
    label: "bot play (forceteki, typed driver), not human results",
    proxy: `${policy} on both seats stands in for rung 2, which was never promoted (D79); the closing run is on the ladder-passing pilot (D92, D95)`,
    gate: GATE,
    inputs,
    inputsHash: sha256Hex(canonicalJson(inputs)),
    codeCommit: codeCommit(),
    latency,
    throughput: { repetitions: repRows, perPair },
    identity,
    failures,
    pass: { throughput: throughputPass, latency: latencyPass, identity: failures.length === 0, all: pass },
  };
  const file = path.resolve(values.out ?? path.join(REPO_ROOT, "data/runs", values.date, "sims", "evaluator-gate.json"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  p.done({ pass });
  console.log(JSON.stringify({ pass: report.pass, latency, perPair, failures }, null, 1));
  process.exitCode = pass ? 0 : 1;
}

if (isMain(import.meta.url)) await main();
