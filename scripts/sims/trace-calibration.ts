/**
 * @displayName Calibration game tracer
 * @strategicPurpose Reads the games behind a calibration figure at decision level (#174): which archetype lost, and
 * what its pilot did at each decision, so a pilot misplay is named with a decision index instead of guessed from a
 * win share.
 * @tacticalObjective Takes the panel and seed layout of a pinned calibration record (src/sims/calibration.ts
 * calibrationJobs), plays the chosen archetype's calibration games in this thread with full decision records, keeps
 * the ones it lost (or all with --all), replays each record to its trace, and writes per game a JSONL record and a
 * text log: every decision with round, phase, prompt, the chosen answer and the number of answers, plus the actor's
 * hand, resources, both boards and both bases at every main-action prompt. Bot play only (D21's last tier); reads no
 * Karabast data (D22). Emits pollable progress to reports/.progress/sims-trace-<policy>.json.
 *
 *   node --import tsx scripts/sims/trace-calibration.ts --policy rung1 --archetype t001 [--vs t002,t003] [--seeds 5] [--max 3] [--all]
 *   ... --policy rung3:k=8 --record data/pinned/sim-calibration-v1/calibration-rung3-k-8.json --archetype t008
 *
 * Every game runs in this thread, so no worker preload is needed. --seeds caps q (the seed index within a pair),
 * --max caps kept games per opponent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { calibrationJobs, gateRecordSchema, seats, type CalibrationJob } from "../../src/sims/calibration.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { startGame } from "../../src/sims/engine.js";
import { buildHeader, chainForHeader, replayMatch, type DeckInput, type MatchSpec } from "../../src/sims/match.js";
import { parsePolicySpec } from "../../src/sims/policies/index.js";
import { ViewBuilder, type TypedAction } from "../../src/sims/policies/engine-view.js";
import { loadTables, type CardTables } from "../../src/sims/policies/tables.js";
import type { CardView, GameView } from "../../src/sims/policies/types.js";
import { driverName, registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import type { MatchRecord } from "../../src/sims/schemas.js";
import { Session } from "../../src/sims/session.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_ORIGINALS, loadContext } from "./context.js";
import { prepareDeck } from "./decks.js";

const unit = (u: CardView): string => `${u.title}${u.leader ? "*" : ""} ${u.power}/${u.remainingHp}${u.shield ? "s" : ""}${u.exhausted ? " ex" : ""}`;
const handCard = (c: CardView): string => `${c.title}(${c.cost}${c.kind === "event" ? "e" : c.kind === "upgrade" ? "u" : ""}${c.effects.removal ? "R" : ""})`;

export function stateLine(v: GameView): string {
  const me = v.me;
  const opp = v.opp;
  return [
    `  hand: ${me.hand.map(handCard).join(", ") || "-"}`,
    `  res ${me.resources.ready}/${me.resources.total} | opp res ${opp.resources.ready}/${opp.resources.total}, hand ${opp.handSize} | init ${me.hasInitiative ? "me" : "opp"} | leader ${me.leaderDeployed ? "deployed" : "ready"}`,
    `  me base ${me.base.remainingHp}: ${me.units.map(unit).join(", ") || "-"}`,
    `  opp base ${opp.base.remainingHp}: ${opp.units.map(unit).join(", ") || "-"}`,
  ].join("\n");
}

interface Traced {
  record: MatchRecord;
  log: string[];
}

async function traceGame(ctx: ReturnType<typeof loadContext>, spec: MatchSpec, tables: CardTables, focusSeat: 1 | 2): Promise<Traced> {
  const keys = ctx.bridge.engineCardKeys;
  const header = buildHeader(ctx.engine, spec, keys);
  const started = await startGame(ctx.engine, [header.decks[0].engineList, header.decks[1].engineList], { engineSeed: header.rng.engineSeed, undo: spec.undo });
  const session = new Session(started, {
    seed: header.seed,
    cardKeys: keys,
    chains: [chainForHeader(header.policies[0]), chainForHeader(header.policies[1])],
    recordMode: "full",
    playedMetric: ctx.engine.playedMetric,
    manualSnapshotType: ctx.engine.SnapshotType.Manual,
  });
  const builders = [new ViewBuilder(started.game, 1, tables), new ViewBuilder(started.game, 2, tables)] as const;
  const log: string[] = [];
  session.run({
    check: (pending, choice) => {
      const acts = pending.actions.map((a) => a.action) as unknown as TypedAction[];
      const { view } = builders[pending.seat - 1].build(acts, () => 0);
      const chosen = pending.actions[choice.index].action;
      const who = pending.seat === focusSeat ? "ME " : "opp";
      const head = `k=${pending.k} r${view.round} ${view.phase} ${who} ${pending.promptKind}${view.prompt.title ? ` "${view.prompt.title}"` : ""} -> ${chosen.label || chosen.descriptor} (of ${pending.actions.length})${choice.fallback ? ` [${choice.fallback}]` : ""}`;
      log.push(head);
      if (pending.promptKind === "mainAction" && pending.seat === focusSeat) log.push(stateLine(view));
      return false;
    },
  });
  const record: MatchRecord = { header, decisions: session.decisions, footer: session.footer() };
  return { record, log };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      policy: { type: "string" },
      archetype: { type: "string" },
      vs: { type: "string" },
      record: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-calibration-v1/calibration-rung1.json") },
      seeds: { type: "string", default: "20" },
      max: { type: "string", default: "3" },
      all: { type: "boolean", default: false },
      run: { type: "string", default: path.join(REPO_ROOT, "data/runs/2026-10-31") },
      out: { type: "string", default: path.join(REPO_ROOT, "tmp/sims-trace") },
    },
  });
  if (values.policy === undefined || values.archetype === undefined) throw new Error("--policy and --archetype are required");
  const spec = values.policy;
  const name = driverName(spec);
  const searches = ["lookahead", "montecarlo"].includes(parsePolicySpec(spec).kind);
  const rec = gateRecordSchema.parse(JSON.parse(readFileSync(values.record, "utf8")));
  if (rec.seeds.listsPerArchetype !== undefined) throw new Error("trace reads one-list records only");
  const tables = loadTables({ runDir: values.run, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
  const ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: values.run, originals: DEFAULT_ORIGINALS, "no-memo": false });
  registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), [name], tables);
  const panel: { archetype: string; name: string; deck: DeckInput }[] = rec.panel.map((p) => {
    const file = path.join(REPO_ROOT, p.list.replace(/^file:/, ""));
    return { archetype: p.archetype, name: p.name, deck: prepareDeck(ctx.bridge, JSON.parse(readFileSync(file, "utf8")), p.list) };
  });
  const focus = panel.findIndex((p) => p.archetype.startsWith(values.archetype as string));
  if (focus < 0) throw new Error(`no panel archetype starts with ${values.archetype}`);
  const vs = values.vs?.split(",").map((v) => panel.findIndex((p) => p.archetype.startsWith(v)));
  const { jobs } = calibrationJobs(panel.length, rec.seeds.gamesPerPair);
  const q = (jb: CalibrationJob): number => jb.seed - 4_000_000 - 1000 * jb.pair;
  const picked = jobs.filter((jb) => (jb.i === focus || jb.j === focus) && q(jb) < Number(values.seeds) && (vs === undefined || vs.includes(jb.i === focus ? jb.j : jb.i)));
  const dir = path.join(values.out, name.replace(/[^A-Za-z0-9]+/g, "-"), panel[focus].archetype);
  mkdirSync(dir, { recursive: true });
  const p = progress(`sims-trace-${name.replace(/[^A-Za-z0-9]+/g, "-")}`, { total: picked.length, everyN: 1 });
  const keptPerOpp = new Map<number, number>();
  let done = 0;
  for (const jb of picked) {
    const s = seats(jb);
    const focusSeat: 1 | 2 = s[0].archetype === focus ? 1 : 2;
    const opp = s[focusSeat === 1 ? 1 : 0].archetype;
    if (!values.all && (keptPerOpp.get(opp) ?? 0) >= Number(values.max)) {
      p.tick(++done);
      continue;
    }
    const mspec: MatchSpec = { seed: String(jb.seed), decks: [panel[s[0].archetype].deck, panel[s[1].archetype].deck], policies: [name, name], recordMode: "full", undo: searches, codeCommit: ctx.codeCommit };
    const t = await traceGame(ctx, mspec, tables, focusSeat);
    const winner = t.record.footer.result.winner;
    const lost = winner !== null && winner !== focusSeat;
    const summary = { seed: jb.seed, focusSeat, opponent: panel[opp].archetype, winner, rounds: t.record.footer.result.rounds, decisions: t.record.footer.result.decisions, lost, trace: t.record.footer.traceSha256 };
    if (lost || values.all) {
      keptPerOpp.set(opp, (keptPerOpp.get(opp) ?? 0) + 1);
      const replay = await replayMatch(ctx.engine, JSON.parse(JSON.stringify(t.record)), ctx.bridge.engineCardKeys, { byDescriptor: searches });
      const stem = `${panel[opp].archetype}-seed${jb.seed}-seat${focusSeat}`;
      writeFileSync(path.join(dir, `${stem}.jsonl`), `${JSON.stringify(t.record)}\n`);
      writeFileSync(path.join(dir, `${stem}.log`), `${panel[focus].name} (seat ${focusSeat}) vs ${panel[opp].name}; ${spec} both seats; seed ${jb.seed}; winner seat ${winner}; replay ${replay.ok && replay.traceSha256 === t.record.footer.traceSha256 ? "identical" : "MISMATCH"}\n${t.log.join("\n")}\n`);
      process.stdout.write(`${JSON.stringify({ ...summary, replay: replay.ok && replay.traceSha256 === t.record.footer.traceSha256, file: path.relative(REPO_ROOT, path.join(dir, `${stem}.log`)) })}\n`);
    } else process.stdout.write(`${JSON.stringify(summary)}\n`);
    p.tick(++done);
  }
  p.done({ games: picked.length });
}

await main();
