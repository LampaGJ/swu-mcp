/**
 * @displayName Deck gauntlet runner (`pnpm sims:gauntlet`)
 * @strategicPurpose The owner's deck gauntlet (#198): every built deck idea against its leader's reference list on identical
 * shuffles, and both against a pinned panel of tournament-winning lists, so many ideas can be screened cheaply and the best
 * confirmed with the fair pilot. Bot play, the last data tier (D21), labelled as a relative comparison (D108); no Karabast data
 * is read (the field is the swumetastats panel, the ideas are files the caller gives).
 * @tacticalObjective Parses the pinned panel (src/sims/gauntlet.ts panelFileSchema) and the idea files (SWUDB, through
 * deckFromSwudb and validateDeck), picks each idea's reference (the panel's best tournament list for the leader, else a
 * named --fallback file), adds the dead-card control of each reference (D98), lays out the games (planGauntlet), plays them
 * on one warm worker pool with the pilot on both seats, summarises each idea with summarizeRelative, ranks, checks the
 * controls, and writes <stage>.json (strict schema, no clock, no commit), <stage>.md (plain-language report beside the
 * judges' scores) and <stage>.replay.json under --out/<run>/. The screen stage takes any rung whose pinned gate record
 * passes replay, health and ladder; the confirm stage reads the screen record, takes its top --top ideas and may run the
 * fair rung, which has no record yet and is labelled "calibration unmeasured (#183)". Heartbeats go to
 * reports/.progress/gauntlet-<run>-<stage>.json.
 *
 *   node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/gauntlet.ts --ideas <dir> --panel <file> --run <name>
 *     [--stage screen|confirm] [--policy rung1] [--pairs 100] [--field-games 100] [--seed gauntlet-1] [--fallback <leader>=<file>]...
 *     [--extra <file>]... [--from-screen <screen.json> --top 8] [--judges <file> --anon-map <file>] [--out data/pinned/sim-gauntlet]
 *     [--workers 12] [--dry-run]
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { failedRelativeGateSentence, type GateRecord } from "../../src/sims/calibration.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import {
  DEAD_CARD_ID,
  FAIR_RUNG,
  GAUNTLET_VERSION,
  calibrationLabel,
  controlVerdict,
  deadCardControl,
  gauntletLabel,
  gauntletRecordSchema,
  panelFileSchema,
  planGauntlet,
  rankIdeas,
  renderReport,
  selectForConfirm,
  summarizeIdea,
  type GameOutcome,
} from "../../src/sims/gauntlet.js";
import { parseJudgeScores } from "../../src/sims/idea-pool.js";
import { LiveStats } from "../../src/sims/live-stats.js";
import type { DeckInput, MatchSpec } from "../../src/sims/match.js";
import { MATCHUP_LIMITS, validateDeck, type MatchupDeck } from "../../src/sims/matchup.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { driverName } from "../../src/sims/policies/typed-adapter.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchFooter } from "../../src/sims/schemas.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { deckFromSwudb, readRecords } from "../../src/tools/sims.js";
import { swudbCandidates } from "../../src/tools/swudb.js";
import { codeCommit } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_ORIGINALS, loadContext } from "./context.js";
import { engineDeck } from "./decks.js";
import { KEEP_ALIVE_MS, provenanceOf } from "./live.js";

/** Measured games per second on 12 workers: rung 1 47, rung 3 top-K 1.2 (src/tools/sims.ts); the fair rung costs about 2.5 times rung 3 per decision (D109 (4)). */
const GAMES_PER_SECOND: Record<string, number> = { rules: 47, lookahead: 1.2, fair: 0.5 };
const MAX_PER_WORKER = 40;
const MIN_PER_WORKER = 4;

const replaySchema = z.strictObject({ inputHash: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)), codeCommit: z.string().min(7), outputHash: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)) });

const deckSha = (d: MatchupDeck): string => sha256Hex(canonicalJson({ leader: d.leader, base: d.base, cards: [...d.cards].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey)) }));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      ideas: { type: "string" },
      panel: { type: "string" },
      run: { type: "string" },
      stage: { type: "string", default: "screen" },
      policy: { type: "string" },
      pairs: { type: "string", default: "100" },
      "field-games": { type: "string", default: "100" },
      seed: { type: "string", default: "gauntlet-1" },
      fallback: { type: "string", multiple: true, default: [] },
      extra: { type: "string", multiple: true, default: [] },
      "from-screen": { type: "string" },
      top: { type: "string", default: "8" },
      judges: { type: "string" },
      "anon-map": { type: "string" },
      out: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-gauntlet") },
      workers: { type: "string", default: "12" },
      "tables-from": { type: "string", default: "rung1" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (values.ideas === undefined || values.panel === undefined || values.run === undefined) throw new Error("give --ideas <dir>, --panel <file> and --run <name>");
  const stage = z.enum(["screen", "confirm"]).parse(values.stage);
  const run = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, { error: "--run is 1 to 64 letters, digits, _ . or -" }).parse(values.run);
  const policy = values.policy ?? (stage === "screen" ? "rung1" : FAIR_RUNG);
  const h2hPairs = z.coerce.number().int().min(2).max(MATCHUP_LIMITS.gamesMax).parse(values.pairs);
  const fieldGames = z.coerce.number().int().min(2).max(MATCHUP_LIMITS.gamesMax).parse(values["field-games"]);
  const top = z.coerce.number().int().min(1).parse(values.top);
  const workers = z.coerce.number().int().min(1).max(32).parse(values.workers);
  const seed = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).parse(values.seed);

  // The pilot: a rung with a pinned record must pass the three relative gates (D108); only the fair rung may run without one (#183).
  const records = readRecords(REPO_ROOT);
  if (typeof records === "string") throw new Error(records);
  const recordOf = (spec: string): GateRecord | undefined => records.records.find((r) => r.policy.spec === spec);
  const pilotRecord = recordOf(policy);
  if (pilotRecord !== undefined) {
    const why = failedRelativeGateSentence(pilotRecord);
    if (why !== null) throw new Error(why);
  } else if (policy !== FAIR_RUNG) throw new Error(`${policy} has no calibration gate record in data/pinned/sim-calibration-v1; the gauntlet runs a recorded rung that passes replay, health and ladder, or the fair rung ${FAIR_RUNG}`);
  const tablesRecord = pilotRecord ?? recordOf(values["tables-from"]);
  if (tablesRecord === undefined) throw new Error(`no gate record for ${values["tables-from"]} to take the card tables from`);
  const pilotRun = path.join(REPO_ROOT, "data/runs", tablesRecord.pilotRun);
  const store = loadStore(pilotRun);
  const lookup = (k: string) => {
    const row = store.byKey.get(k);
    return row === undefined ? undefined : { type: String(row.type), title: [row.title, row.subtitle].filter((s) => typeof s === "string" && s !== "").join(", ") };
  };

  // Panel and ideas, parsed at the boundary.
  const panelBytes = readFileSync(path.resolve(values.panel));
  const panel = panelFileSchema.parse(JSON.parse(panelBytes.toString("utf8")));
  const panelDecks = panel.entries.map((e) => ({ id: e.id, name: `${e.archetype.leaderTitle} [${e.archetype.baseAspects.join("+") || "no aspect"}]`, weight: e.weight, deck: e.deck }));
  const ideasDir = path.resolve(values.ideas);
  const ideaFiles = [
    ...readdirSync(ideasDir)
      .filter((f) => f.endsWith(".json") && f !== "manifest.json" && !f.startsWith("fallback-"))
      .map((f) => path.join(ideasDir, f)),
    ...values.extra.map((f) => path.resolve(f)),
  ].sort((a, b) => compareCodePoints(path.basename(a), path.basename(b)));
  const readDeck = (file: string): { deck: MatchupDeck; name: string } => {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    const deck = deckFromSwudb(store, raw);
    if (typeof deck === "string") throw new Error(`${path.basename(file)}: ${deck}`);
    const bad = validateDeck(deck, lookup, path.basename(file));
    if (bad !== null) throw new Error(bad);
    const meta = z.looseObject({ metadata: z.looseObject({ name: z.string().optional() }).optional() }).parse(raw);
    return { deck, name: meta.metadata?.name ?? path.basename(file, ".json") };
  };
  let ideas = ideaFiles.map((f) => ({ id: path.basename(f, ".json").replace(/\.karabast$/, ""), ...readDeck(f) }));
  let confirmOf: { screenSha256: string; top: number } | null = null;
  if (stage === "confirm") {
    if (values["from-screen"] === undefined) throw new Error("the confirm stage needs --from-screen <screen.json>");
    const screenBytes = readFileSync(path.resolve(values["from-screen"]));
    const screen = gauntletRecordSchema.parse(JSON.parse(screenBytes.toString("utf8")));
    const chosen = selectForConfirm(screen.ranking, top);
    for (const id of chosen) {
      const was = screen.decks.find((d) => d.id === id);
      const now = ideas.find((i) => i.id === id);
      if (was === undefined || now === undefined || was.sha256 !== deckSha(now.deck)) throw new Error(`idea ${id} is not the list the screen measured; rerun the screen`);
    }
    ideas = ideas.filter((i) => chosen.includes(i.id));
    confirmOf = { screenSha256: sha256Hex(screenBytes), top };
  }
  if (ideas.length === 0) throw new Error("no idea to run");
  // Every input is read before the first game, so a bad file cannot cost a finished run.
  if ((values.judges === undefined) !== (values["anon-map"] === undefined)) throw new Error("give --judges and --anon-map together");
  const judges = values.judges !== undefined && values["anon-map"] !== undefined ? parseJudgeScores(readFileSync(path.resolve(values.judges), "utf8"), readFileSync(path.resolve(values["anon-map"]), "utf8")) : null;

  // References: the panel's best list for the leader, else the named fallback.
  const fallbacks = new Map<string, string>();
  for (const f of values.fallback) {
    const m = /^([0-9]{6,9})=(.+)$/.exec(f);
    if (m === null) throw new Error(`--fallback takes <leader cardKey>=<file>, not ${f}`);
    fallbacks.set(m[1], path.resolve(m[2]));
  }
  const leaders = [...new Set(ideas.map((i) => i.deck.leader))].sort(compareCodePoints);
  const references = leaders.map((leader) => {
    const fromPanel = panel.references.find((r) => r.leader === leader);
    const title = lookup(leader)?.title ?? leader;
    if (fromPanel?.entry != null) {
      const e = fromPanel.entry;
      return { id: `ref-${leader}`, leader, leaderTitle: title, deck: e.deck, source: `best tournament list for the leader in ${panel.window.label}: ${e.event}, placed ${e.placement ?? "unplaced"} of ${e.eventSize ?? "?"}, record ${e.record ?? "unknown"}, ${e.date} (${fromPanel.lists} lists)` };
    }
    const file = fallbacks.get(leader);
    if (file === undefined) throw new Error(`no tournament list for leader ${leader} (${title}) in the panel window and no --fallback ${leader}=<file>`);
    return { id: `ref-${leader}`, leader, leaderTitle: title, deck: readDeck(file).deck, source: `named fallback, no tournament list for the leader in ${panel.window.label}: ${path.basename(file)}` };
  });
  const deadHits = [...new Set(swudbCandidates(store, DEAD_CARD_ID).map((c) => c.cardKey))];
  if (deadHits.length !== 1) throw new Error(`the dead card ${DEAD_CARD_ID} names ${deadHits.length} cards in data/runs/${tablesRecord.pilotRun}`);
  const deadCard = deadHits[0];
  const controls = references.map((r) => {
    const c = deadCardControl(r.deck, { deadCard, want: 4, copiesMax: MATCHUP_LIMITS.copiesMax, costOf: (k) => (typeof store.byKey.get(k)?.cost === "number" ? (store.byKey.get(k)?.cost as number) : null) });
    return { id: `control-${r.leader}`, reference: r.id, ...c };
  });

  const plan = planGauntlet({
    seed,
    h2hPairs,
    fieldGames,
    ideas: [...ideas.map((i) => ({ id: i.id, deck: i.deck, reference: `ref-${i.deck.leader}` })), ...controls.map((c) => ({ id: c.id, deck: c.deck, reference: c.reference }))],
    references: references.map((r) => ({ id: r.id, deck: r.deck })),
    panel: panelDecks,
  });
  const kind = parsePolicySpec(policy).kind;
  const rate = policy === FAIR_RUNG ? GAMES_PER_SECOND.fair : (GAMES_PER_SECOND[kind] ?? 1);
  const estimate = { games: plan.games.length, ideas: ideas.length, controls: controls.length, references: references.length, estimatedMinutes: Math.round(plan.games.length / rate / 6) / 10 };
  console.log(JSON.stringify({ stage, policy, ...estimate }));
  if (values["dry-run"]) return;

  const tables = loadTables({ runDir: pilotRun, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
  for (const k of ["scoresSha256", "coefficientsSha256", "featuresSha256"] as const)
    if (tables.pins[k] !== tablesRecord.inputs[k]) throw new Error(`the card tables in data/runs/${tablesRecord.pilotRun} changed since ${tablesRecord.policy.spec} was calibrated (${k})`);
  const ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: pilotRun, originals: DEFAULT_ORIGINALS, "no-memo": false });
  if (ctx.engine.pin.commit !== tablesRecord.engine.commit) throw new Error(`the engine pin ${ctx.engine.pin.commit} is not the calibrated ${tablesRecord.engine.commit}`);
  const allDecks = new Map<string, { deck: MatchupDeck; source: string }>();
  for (const i of ideas) allDecks.set(i.id, { deck: i.deck, source: `gauntlet idea ${i.id}` });
  for (const c of controls) allDecks.set(c.id, { deck: c.deck, source: `gauntlet control ${c.id}` });
  for (const r of references) allDecks.set(r.id, { deck: r.deck, source: `gauntlet reference ${r.id}` });
  for (const p of panelDecks) allDecks.set(p.id, { deck: p.deck, source: `gauntlet panel ${p.id}` });
  const engine = new Map<string, DeckInput>([...allDecks].map(([id, d]) => [id, engineDeck(ctx.bridge, d.deck, d.source)]));
  const name = driverName(policy);
  const searches = ["lookahead", "montecarlo"].includes(kind);
  const specs: MatchSpec[] = plan.games.map((g) => ({ seed: g.seed, decks: [engine.get(g.seats[0]) as DeckInput, engine.get(g.seats[1]) as DeckInput], policies: [name, name], recordMode: "none", undo: searches, codeCommit: ctx.codeCommit }));

  process.env.SIMS_POLICY_SPECS = name;
  process.env.SIMS_RUN = pilotRun;
  const job = `gauntlet-${run}-${stage}`;
  // The widget shows this as the job name (#200); a loose heartbeat schema lets older readers ignore it.
  const heartbeatLabel = stage === "screen" ? "Gauntlet screen" : "Gauntlet confirm";
  const p = progress(job, { total: specs.length, everyN: 10, everyMs: 3000, keepAliveMs: KEEP_ALIVE_MS });
  const live = new LiveStats({ kind: "matchup", provenance: provenanceOf({ specs: [policy], seeds: null, enginePin: ctx.engine.pin.commit, codeCommit: ctx.codeCommit, run: tablesRecord.pilotRun }) });
  live.beginPhase(stage, specs.length, { subject: "deck ideas", other: "their references and the tournament panel" });
  p.log(() => ({ label: heartbeatLabel, phase: "starting workers", stats: live.snapshot() }));
  const started = performance.now();
  const sim = await createPool({ workers, pin: ctx.engine.pin });
  const footers: MatchFooter[] = [];
  try {
    const chunk = Math.max(MIN_PER_WORKER * workers, Math.min(MAX_PER_WORKER * workers, Math.ceil(specs.length / 20)));
    const parts: MatchSpec[][] = [];
    for (let k = 0; k < specs.length; k += chunk) parts.push(specs.slice(k, k + chunk));
    const start = (part: MatchSpec[]) => sim.run({ specs: part, cardKeys: ctx.bridge.engineCardKeys });
    let next = parts.length > 0 ? start(parts[0]) : null;
    for (let c = 0; c < parts.length; c++) {
      const current = next as ReturnType<typeof start>;
      next = c + 1 < parts.length ? start(parts[c + 1]) : null;
      for (const r of await current) {
        const f = r.footer;
        const [d0, d1] = f.coverage.decisions;
        const [a0, a1] = f.coverage.answered;
        live.add({ seed: specs[footers.length].seed, winnerSeat: f.result.winner, endCondition: f.result.endCondition, error: f.error, rounds: f.result.rounds, decisions: f.result.decisions, won: null, fallback: { decisions: d0 + d1, fallback: d0 + d1 - (a0 + a1) } });
        footers.push(f);
      }
      p.tick(footers.length, () => ({ label: heartbeatLabel, phase: stage, stats: live.snapshot() }));
    }
  } finally {
    await sim.close();
  }
  const seconds = Math.round((performance.now() - started) / 100) / 10;

  const outcomes: GameOutcome[] = footers.map((f) => ({ winner: f.result.winner, endCondition: f.result.endCondition, rounds: f.result.rounds }));
  const summaries = new Map(plan.ideas.map((ip) => [ip.id, summarizeIdea(plan, ip, outcomes, panelDecks, seed)]));
  const ideaIds = new Set(ideas.map((i) => i.id));
  const ranking = rankIdeas(plan.ideas.filter((ip) => ideaIds.has(ip.id)).map((ip) => ({ id: ip.id, result: summaries.get(ip.id) as ReturnType<typeof summarizeIdea> })));
  const controlRows = controls.map((c) => {
    const result = summaries.get(c.id) as ReturnType<typeof summarizeIdea>;
    return { id: c.id, reference: c.reference, swaps: c.swaps, note: c.note, result, verdict: controlVerdict(result) };
  });
  const decisive = outcomes.filter((o) => o.endCondition === "base_destroyed" && o.winner !== null).length;
  const errors = footers.filter((f) => f.error !== null);
  const header = policyHeader(parsePolicySpec(policy));
  const label = gauntletLabel(policy);
  const calibration = calibrationLabel(policy, pilotRecord !== undefined);
  const record = gauntletRecordSchema.parse({
    kind: "sim-gauntlet",
    version: GAUNTLET_VERSION,
    run,
    stage,
    label,
    calibration,
    status: "candidate",
    pilot: { policy, policyVersion: `${header.id} v${header.version} params ${header.paramsSha256.slice(0, 12)}`, gateRecord: pilotRecord === undefined ? null : (records.files.get(pilotRecord) ?? null) },
    population: {
      field: {
        file: path.relative(REPO_ROOT, path.resolve(values.panel)).split(path.sep).join("/"),
        sha256: sha256Hex(panelBytes),
        source: panel.source,
        population: panel.population,
        tier: panel.tier,
        window: panel.window,
        entries: panel.entries.map((e, k) => ({ id: e.id, name: panelDecks[k].name, weight: e.weight, event: e.event, placement: e.placement, record: e.record, date: e.date })),
      },
      references: references.map((r) => ({ id: r.id, leader: r.leader, leaderTitle: r.leaderTitle, source: r.source })),
    },
    design:
      "D108's relative design per idea: the idea against its leader's reference on identical seeds in both seat orders, the idea against itself on the same seeds as a mirror, and the idea and the reference against every panel list on the same seed and seat, the paired difference weighted by the panel's tournament shares; ranked by the low end of that difference's 95% bootstrap interval; the dead-card control of each reference runs as one more idea",
    sizes: { seed, h2hPairs, fieldGames, games: plan.games.length, ideas: ideas.length, controls: controls.length },
    confirmOf,
    decks: [
      ...ideas.map((i) => ({ id: i.id, role: "idea" as const, name: i.name, sha256: deckSha(i.deck), deck: i.deck })),
      ...controls.map((c) => ({ id: c.id, role: "control" as const, name: `dead-card control of ${c.reference}`, sha256: deckSha(c.deck), deck: c.deck })),
      ...references.map((r) => ({ id: r.id, role: "reference" as const, name: `${r.leaderTitle} reference`, sha256: deckSha(r.deck), deck: r.deck })),
    ],
    ideas: ideas.map((i) => ({ id: i.id, reference: `ref-${i.deck.leader}`, result: summaries.get(i.id) })),
    controls: controlRows,
    ranking,
    tooSmallToRank: !controlRows.every((c) => c.verdict.detected),
    health: { games: outcomes.length, decisive, nonDecisive: outcomes.length - decisive, errors: errors.length, errorSamples: [...new Set(errors.map((f) => String(f.error)))].sort(compareCodePoints).slice(0, 3) },
    engine: { commit: ctx.engine.pin.commit, cardDataVersion: ctx.engine.pin.cardDataVersion },
  });

  const names: Record<string, string> = Object.fromEntries([...ideas.map((i) => [i.id, i.name]), ...references.map((r) => [r.id, `the ${r.leaderTitle} reference`])]);
  const report = renderReport({
    run,
    stage,
    label,
    calibration,
    fieldText: `${panel.entries.length} tournament-winning decks (the best-placed list of each of the ${panel.entries.length} most played leader and base-colour pairs in ${panel.window.label}, ${panel.window.from} to ${panel.window.to}; ${panel.population})`,
    pilot: policy,
    sizes: { h2hPairs, fieldGames },
    names,
    referenceText: Object.fromEntries(references.map((r) => [r.id, `${r.leaderTitle}: ${r.source}`])),
    ranking,
    results: Object.fromEntries(ideas.map((i) => [i.id, summaries.get(i.id) as ReturnType<typeof summarizeIdea>])),
    references: Object.fromEntries(ideas.map((i) => [i.id, `ref-${i.deck.leader}`])),
    controls: controlRows,
    judges,
    panelNames: Object.fromEntries(panelDecks.map((d) => [d.id, d.name])),
  });

  const outDir = path.join(path.resolve(values.out), run);
  mkdirSync(outDir, { recursive: true });
  const json = `${JSON.stringify(record, null, 1)}\n`;
  writeFileSync(path.join(outDir, `${stage}.json`), json);
  writeFileSync(path.join(outDir, `${stage}.md`), report);
  const replay = replaySchema.parse({
    inputHash: {
      panel: sha256Hex(panelBytes),
      decks: sha256Hex(canonicalJson(record.decks.map((d) => [d.id, d.sha256]))),
      options: sha256Hex(canonicalJson({ stage, policy, h2hPairs, fieldGames, seed, top: stage === "confirm" ? top : null })),
      ...(confirmOf === null ? {} : { screen: confirmOf.screenSha256 }),
      ...(judges === null ? {} : { judges: sha256Hex(readFileSync(path.resolve(values.judges as string))), anonMap: sha256Hex(readFileSync(path.resolve(values["anon-map"] as string))) }),
    },
    codeCommit: codeCommit(),
    outputHash: { [`${stage}.json`]: sha256Hex(json), [`${stage}.md`]: sha256Hex(report) },
  });
  writeFileSync(path.join(outDir, `${stage}.replay.json`), `${JSON.stringify(replay, null, 1)}\n`);
  p.done({ label: heartbeatLabel, stats: live.snapshot(), seconds });
  console.log(
    JSON.stringify(
      {
        out: path.relative(REPO_ROOT, outDir),
        games: outcomes.length,
        seconds,
        gamesPerSecond: Math.round((outcomes.length / seconds) * 100) / 100,
        errors: errors.length,
        tooSmallToRank: record.tooSmallToRank,
        controls: controlRows.map((c) => ({ id: c.id, detected: c.verdict.detected, byHeadToHead: c.verdict.byHeadToHead, difference: c.result.field?.deckMinusVariant.difference, ci95: c.result.field?.deckMinusVariant.ci95 })),
        top: ranking.slice(0, 10).map((r) => `${r.rank}. ${r.id} ${r.fieldDifference} [${r.ci95.low}, ${r.ci95.high}] h2h ${r.headToHead.winShare}`),
        sha256: sha256Hex(json),
      },
      null,
      1,
    ),
  );
}

await main();
