/**
 * @displayName forceteki batch runner
 * @strategicPurpose Play N seeded matches of one matchup with the pinned engine, in this thread or on worker
 * threads with identical per-seed records, and report a summary that counts every errored game (#110, #142).
 * @tacticalObjective Builds one MatchSpec per seed, plays them (workers claim seeds from a shared counter), prints one
 * line per game in seed order, optionally writes the records as JSONL for `pnpm sims:replay`, and prints the summary
 * (decided games, wins, draws, errors with their seeds, win shares over decided games, coverage, games per second).
 *
 * Usage: tsx scripts/sims/run-batch.ts --deck1 <json> --deck2 <json> [--games N] [--seed S] [--workers auto|N|0]
 *   [--policy1 rung0] [--policy2 rung0] [--record compact|full] [--out <records.jsonl>] [--undo] [--no-memo] [--quiet]
 *   [--evaluator <manifest>|v1|synthetic:64,32 [--evaluator-load per-prompt|per-action] [--vocab <file>]]
 * --evaluator scores every main-action state with the evaluator before the policy chooses (#127): values never steer,
 * the footer gains recordSha256 and valueSha256. It and the learned rungs (rung3v, rung4, #128) need the policy preload
 * on worker threads: node --import tsx --import ./scripts/sims/ladder-preload.ts scripts/sims/run-batch.ts ...
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { progress } from "../lib/progress.mjs";
import { topCoreClassSize } from "../../src/sims/engine.js";
import { playMatch, summarize, type MatchSpec } from "../../src/sims/match.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchRecord } from "../../src/sims/schemas.js";
import { isMain } from "../bench/code-commit.js";
import { contextOptions, DEFAULT_RUN, loadContext } from "./context.js";
import { OBSERVERS, POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { REPO_ROOT } from "../../src/paths.js";
import { OBSERVER_NAMES } from "./evaluator-hook.js";
import { prepareLearned, registerLearned, registerObservers } from "./policy/learned.js";
import { loadDeck } from "./decks.js";

export async function main(argv: string[] = process.argv.slice(2), defaults: { workers?: string; record?: string; games?: string } = {}): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...contextOptions,
      deck1: { type: "string" },
      deck2: { type: "string" },
      games: { type: "string", default: defaults.games ?? "100" },
      seed: { type: "string", default: "1" },
      workers: { type: "string", default: defaults.workers ?? "auto" },
      policy1: { type: "string", default: "rung0" },
      policy2: { type: "string", default: "rung0" },
      record: { type: "string", default: defaults.record ?? "compact" },
      out: { type: "string" },
      undo: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      "max-decisions": { type: "string" },
      trace: { type: "boolean", default: false },
      evaluator: { type: "string" },
      "evaluator-load": { type: "string", default: "per-prompt" },
      vocab: { type: "string" },
    },
  });
  const load = values["evaluator-load"];
  if (load !== "per-prompt" && load !== "per-action") throw new Error("--evaluator-load is per-prompt or per-action");
  if (values.deck1 === undefined || values.deck2 === undefined) throw new Error("--deck1 and --deck2 are required");
  if (values.record !== "compact" && values.record !== "full" && values.record !== "none") throw new Error("--record is compact, full or none");
  if (values.record === "none" && values.out !== undefined) throw new Error("--record none keeps no decisions, so there is nothing replayable to --out");
  const tLoad = performance.now();
  const ctx = loadContext(values);
  const decks = [loadDeck(ctx.bridge, values.deck1), loadDeck(ctx.bridge, values.deck2)] as const;
  const names = [values.policy1, values.policy2].filter((n) => n !== "rung0");
  // The parent loads (and so verifies) every rung and the evaluator before a game starts; workers repeat it in the preload.
  const viewKeys = prepareLearned({ names, engineCardKeys: ctx.bridge.engineCardKeys, evaluator: values.evaluator, vocab: values.vocab });
  if (names.length > 0) {
    const tables = loadTables({ runDir: values.run ?? DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: names.some((n) => n.startsWith("rung2")) });
    registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), names, tables);
    if (viewKeys !== null) registerLearned(POLICIES, (ps) => new PolicyChain(ps as never), names, tables, { viewKeys, vocab: values.vocab });
    process.env.SIMS_POLICY_SPECS = names.join(";");
    process.env.SIMS_RUN = values.run;
  }
  if (values.evaluator !== undefined && viewKeys !== null) {
    registerObservers(OBSERVERS, { evaluator: values.evaluator, vocab: values.vocab, viewKeys });
    if (names.length === 0) process.env.SIMS_POLICY_SPECS = "rung0";
  }
  const observer = values.evaluator === undefined ? undefined : OBSERVER_NAMES[load];
  const games = Number(values.games);
  const seed0 = Number(values.seed);
  const maxDecisions = values["max-decisions"] === undefined ? undefined : Number(values["max-decisions"]);
  const specs: MatchSpec[] = Array.from({ length: games }, (_, g) => ({
    seed: String(seed0 + g),
    decks,
    policies: [values.policy1, values.policy2],
    recordMode: values.record as MatchSpec["recordMode"],
    undo: values.undo,
    codeCommit: ctx.codeCommit,
    ...(observer === undefined ? {} : { observer }),
  }));
  const workers = values.workers === "auto" ? Math.min(topCoreClassSize(), games) : Number(values.workers);
  const loadMs = Math.round(performance.now() - tLoad);

  const p = progress("sims-batch", { total: games, everyN: 1 });
  const t0 = performance.now();
  const records: MatchRecord[] = [];
  if (workers === 0) {
    for (const spec of specs) {
      const played = await playMatch(ctx.engine, spec, ctx.bridge.engineCardKeys, { maxDecisions });
      if (values.trace && played.session?.errorStack) console.error(`seed ${spec.seed} k=${played.session.k}: ${played.session.errorStack}`);
      records.push(played.record);
      p.tick(records.length);
    }
  } else {
    if ((names.length > 0 || observer !== undefined) && !process.execArgv.some((a) => a.includes("ladder-preload"))) throw new Error("worker threads need --import ./scripts/sims/ladder-preload.ts to know the rungs and the evaluator (see the usage in this file)");
    const pool = await createPool({ workers, forceteki: values.forceteki, pin: ctx.engine.pin, memo: !values["no-memo"] });
    // Every batch waits for its slowest game (measured x1.14 wall time at 4 per worker); 40 per worker keeps ticks pollable.
    const chunk = Math.max(workers * 40, 48);
    try {
      for (let i = 0; i < specs.length; i += chunk) {
        records.push(...(await pool.run({ specs: specs.slice(i, i + chunk), cardKeys: ctx.bridge.engineCardKeys, maxDecisions })));
        p.tick(records.length);
      }
    } finally {
      await pool.close();
    }
  }
  const wallMs = Math.round(performance.now() - t0);
  p.done({ games });

  if (values.out !== undefined) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(values.out, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
  if (!values.quiet)
    for (const r of records) {
      const f = r.footer;
      console.log(JSON.stringify({ seed: r.header.seed, winner: f.result.winner, endCondition: f.result.endCondition, error: f.error, rounds: f.result.rounds, decisions: f.result.decisions, traceSha256: f.traceSha256, ...(f.observer === undefined ? {} : { observer: f.observer }), ...(f.search === undefined ? {} : { search: f.search }) }));
    }
  const summary = summarize(records.map((r) => ({ seed: r.header.seed, footer: r.footer })));
  console.error(
    JSON.stringify({
      ...summary,
      policies: [values.policy1, values.policy2],
      label: `bot play (forceteki, ${values.policy1} vs ${values.policy2}), not human results`,
      workers,
      loadMs,
      wallMs,
      gamesPerSecond: Math.round((games / wallMs) * 10000) / 10,
      out: values.out ?? null,
    }),
  );
}

if (isMain(import.meta.url)) await main();
