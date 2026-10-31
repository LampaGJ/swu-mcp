/**
 * @displayName Bot ladder harness
 * @strategicPurpose Decides, on a test fixed in advance, whether bot rung n beats rung n-1 (#114), tunes rung 2's
 * pairing weights on seeds the verdict never sees, and checks that swapping cards in a deck moves its bot win share.
 * @tacticalObjective Takes the six-deck tournament panel from the opponent sampler (src/sims/opponents.ts deckPanel, #112), plays seeded seat-swapped duplicate game pairs over every
 * ordered deck pair on the typed driver's warm worker pool (src/sims/pool.ts), and reports the sign test, Wilson game
 * shares, per-deck shares, non-decisive and fallback shares and games per second; writes a deterministic gate record
 * (no wall-clock field) and emits pollable progress to reports/.progress/<job>.json.
 *
 * Seed ranges are disjoint by mode and recorded: tuning 1,000,000+, evaluation 2,000,000+, deck checks 3,000,000+.
 * A win share here is bot play (D21's last tier), named with its rung, engine pin and seeds.
 *
 * The driver's workers resolve policies by name, so the run needs the preload that registers the rungs:
 *   node --import tsx --import ./scripts/sims/ladder-preload.ts scripts/sims/ladder.ts --mode ladder --candidate rung1 --baseline rung0 [--pairs 200] [--escalate]
 *   ... --mode grid --grid "mu=0,1;lambda=0,0.5" [--pairs 144]
 *   ... --mode field --policy rung1 --subject base=<deck.json> --subject v1=<deck.json>:HMW_212>LAW_232 [--per 150]
 *   ... --mode cost --specs "rung0|rung1|rung2:mu=1,lambda=1" [--games 72]
 *   ... --mode panel
 * Policy names: rung0 (the driver's random rung), greedy-hash (the spike's name-hash baseline), rung1, rung2:mu=..,lambda=...
 * SIMS_DRIVER_ROOT points at another checkout's driver (default: this repo).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { REPO_ROOT } from "../../src/paths.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";
import { LADDER_ALPHA, pairedDeckTest, shareOf, summarizeLadder, type LadderPair } from "../../src/sims/policies/ladder-stats.js";
import { swapCards, type DeckFile } from "../../src/sims/policies/deck-swap.js";
import { driverName, registerRungs, type DriverPolicy } from "../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { codeCommit } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";

const SEEDS = { tuning: 1_000_000, evaluation: 2_000_000, deckCheck: 3_000_000 } as const;
const DEFAULT_RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");
const DEFAULT_DECKS = path.join(REPO_ROOT, "data/originals/decks/2026-10-17");
const DEFAULT_OUT = path.join(REPO_ROOT, "data/pinned/sim-ladder-v1");
const COMPLEMENTARITY = path.join(REPO_ROOT, "data/complementarity.json");
const DRIVER_ROOT = process.env.SIMS_DRIVER_ROOT ?? REPO_ROOT;
const CHUNK = 96;

/* eslint-disable @typescript-eslint/no-explicit-any -- the driver is imported by path (SIMS_DRIVER_ROOT), so its types are restated where used */
interface Footer {
  result: { winner: 1 | 2 | null; endCondition: string; rounds: number; decisions: number };
  error: string | null;
  coverage: { decisions: [number, number]; answered: [number, number] };
  traceSha256: string;
}
interface Driver {
  policy: { POLICIES: Record<string, () => unknown>; PolicyChain: new (ps: unknown[]) => any };
  match: { playMatch(engine: any, spec: unknown, cardKeys: Record<string, string>): Promise<{ record: { footer: Footer } }> };
  pool: { createPool(opts: { workers: number; forceteki?: string; pin: unknown }): Promise<{ run(req: { specs: unknown[]; cardKeys: Record<string, string> }): Promise<{ footer: Footer }[]>; close(): Promise<void> }> };
  engine: { topCoreClassSize(): number };
  context: { DEFAULT_ORIGINALS: string; loadContext(v: { forceteki: string; run: string; originals: string; "no-memo": boolean }): { engine: any; bridge: { engineCardKeys: Record<string, string> }; codeCommit: string } };
  decks: { prepareDeck(bridge: unknown, raw: unknown, source: string): unknown };
  enginePin: { DEFAULT_FORCETEKI: string };
  opponents: {
    loadOpponentPool(o: { archetypesFile: string; decksDir: string; cardKeyOf: unknown; baseAspectsOf: unknown; unmappedCards?: unknown }): unknown;
    deckPanel(pool: unknown, o: { top: number }): { archetypeId: string; archetypeName: string; share: number; list: { key: string; placement: number; field: number; date: string } | null }[];
    mapCardKeyOf(byId: unknown): unknown;
    storeAspectsOf(store: unknown): unknown;
    engineUnmappedCards(codes: unknown): unknown;
    engineSetCodes(dir: string): unknown;
  };
  data: { loadStore(dir: string): unknown };
  cardMap: { DEFAULT_ORIGINALS_ROOT: string; loadCardMap(run: string, originals: string): { setNumber: { byId: unknown } } };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function loadDriver(): Promise<Driver> {
  const imp = async (rel: string): Promise<unknown> => import(pathToFileURL(path.join(DRIVER_ROOT, rel)).href);
  return {
    policy: (await imp("src/sims/policy.ts")) as Driver["policy"],
    match: (await imp("src/sims/match.ts")) as Driver["match"],
    pool: (await imp("src/sims/pool.ts")) as Driver["pool"],
    engine: (await imp("src/sims/engine.ts")) as Driver["engine"],
    context: (await imp("scripts/sims/context.ts")) as Driver["context"],
    decks: (await imp("scripts/sims/decks.ts")) as Driver["decks"],
    enginePin: (await imp("src/sims/engine-pin.ts")) as Driver["enginePin"],
    opponents: (await imp("src/sims/opponents.ts")) as Driver["opponents"],
    data: (await imp("src/data.ts")) as Driver["data"],
    cardMap: (await imp("scripts/bench/card-map.ts")) as Driver["cardMap"],
  };
}

interface Job {
  deck1: number;
  deck2: number;
  seed: number;
  specs: [string, string];
}

interface GameResult {
  seed: number;
  winner: 1 | 2 | null;
  endCondition: string;
  error: string | null;
  rounds: number;
  decisions: number;
  traceSha256: string;
  /** Per seat: decisions, and how many the seat's top policy answered (the rest fell back to rung 0). */
  coverage: { decisions: [number, number]; answered: [number, number] };
}

const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

interface PanelDeck {
  archetype: string;
  archetypeName: string;
  share: number;
  file: string;
  placement: number;
  field: number;
  date: string;
}

/** The sampler's panel: the highest-placing buildable melee list of each of the six largest-share archetypes. */
function loadPanel(driver: Driver, runDir: string, decksDir: string, forceteki: string): { panel: PanelDeck[]; decks: DeckFile[] } {
  const o = driver.opponents;
  const cardMap = driver.cardMap.loadCardMap(runDir, path.join(driver.cardMap.DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const pool = o.loadOpponentPool({
    archetypesFile: path.join(runDir, "meta/archetypes.json"),
    decksDir,
    cardKeyOf: o.mapCardKeyOf(cardMap.setNumber.byId),
    baseAspectsOf: o.storeAspectsOf(driver.data.loadStore(runDir)),
    unmappedCards: o.engineUnmappedCards(o.engineSetCodes(forceteki)),
  });
  const panel = o.deckPanel(pool, { top: 6 }).map((e) => {
    if (e.list === null) throw new Error(`no buildable list for archetype ${e.archetypeId}`);
    return { archetype: e.archetypeId, archetypeName: e.archetypeName, share: e.share, file: `${e.list.key}.json`, placement: e.list.placement, field: e.list.field, date: e.list.date };
  });
  const decks = panel.map((p) => JSON.parse(readFileSync(path.join(decksDir, p.file), "utf8")) as DeckFile);
  return { panel, decks };
}

/** Fallback share of the given seats: decisions their top policy did not answer. */
function coverageOf(games: readonly GameResult[], seatOf: (g: GameResult, i: number) => 0 | 1): { decisions: number; fallback: number; fallbackShare: number | null } {
  let decisions = 0;
  let answered = 0;
  games.forEach((g, i) => {
    const s = seatOf(g, i);
    decisions += g.coverage.decisions[s];
    answered += g.coverage.answered[s];
  });
  return { decisions, fallback: decisions - answered, fallbackShare: decisions === 0 ? null : r4((decisions - answered) / decisions) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowNegative: true,
    options: {
      mode: { type: "string", default: "ladder" },
      candidate: { type: "string" },
      baseline: { type: "string" },
      pairs: { type: "string", default: "200" },
      seed0: { type: "string" },
      escalate: { type: "boolean", default: false },
      step: { type: "string" },
      grid: { type: "string", default: "mu=0,0.5,1,2;lambda=0,0.25,0.5,1" },
      policy: { type: "string", default: "rung1" },
      subject: { type: "string", multiple: true },
      per: { type: "string", default: "40" },
      specs: { type: "string", default: "rung0|rung1" },
      games: { type: "string", default: "72" },
      workers: { type: "string", default: "auto" },
      run: { type: "string", default: DEFAULT_RUN },
      decks: { type: "string", default: DEFAULT_DECKS },
      out: { type: "string", default: DEFAULT_OUT },
      write: { type: "boolean", default: true },
    },
  });
  const runDir = path.resolve(values.run as string);
  const gridPoints = (): { mu: number; lambda: number }[] => {
    const axes = Object.fromEntries(
      (values.grid as string).split(";").map((part) => {
        const [k, v] = part.split("=");
        return [k, v.split(",").map(Number)];
      }),
    ) as Record<string, number[]>;
    return axes.mu.flatMap((mu) => axes.lambda.map((lambda) => ({ mu, lambda }))).filter((pt) => pt.mu !== 0 || pt.lambda !== 0);
  };
  const wanted = values.mode === "grid" ? ["rung1", ...gridPoints().map((pt) => `rung2:mu=${pt.mu},lambda=${pt.lambda}`)] : [values.candidate, values.baseline, values.policy, ...(values.specs as string).split("|")];
  const names = [...new Set(wanted.filter((s): s is string => typeof s === "string" && s !== "").map(driverName))].sort(compareCodePoints);
  const needPairs = names.some((n) => n.startsWith("rung2"));
  const tables = loadTables({ runDir, complementarity: COMPLEMENTARITY, pairs: needPairs });
  const decksDir = path.resolve(values.decks as string);
  const driver = await loadDriver();
  const forceteki = driver.enginePin.DEFAULT_FORCETEKI;
  const { panel, decks: panelDecks } = loadPanel(driver, runDir, decksDir, forceteki);
  if (values.mode === "panel") {
    process.stdout.write(`${JSON.stringify({ panel }, null, 1)}\n`);
    return;
  }
  if (!process.execArgv.some((a) => a.includes("ladder-preload"))) throw new Error("run with --import ./scripts/sims/ladder-preload.ts so the driver's workers know the rungs (see the usage in this file)");

  const ctx = driver.context.loadContext({ forceteki, run: runDir, originals: driver.context.DEFAULT_ORIGINALS, "no-memo": false });
  const deckNames = panel.map((p) => p.archetype);
  const deckInputs: unknown[] = panel.map((p, i) => driver.decks.prepareDeck(ctx.bridge, panelDecks[i], `file:${path.relative(REPO_ROOT, path.join(decksDir, p.file))}`));
  const subjects: { name: string; file: string; swaps: string[]; index: number; deck: DeckFile }[] = [];
  for (const s of values.subject ?? []) {
    const [name, rest] = s.split("=");
    const [file, swapText] = rest.split(":");
    const swaps = swapText ? swapText.split(",") : [];
    const deck = swapCards(JSON.parse(readFileSync(path.resolve(file), "utf8")) as DeckFile, swaps);
    const rel = path.relative(REPO_ROOT, path.resolve(file));
    subjects.push({ name, file: rel, swaps, index: deckInputs.length, deck });
    deckInputs.push(driver.decks.prepareDeck(ctx.bridge, deck, `file:${rel}${swaps.length > 0 ? ` swaps ${swaps.join(",")}` : ""}`));
  }

  // The preload in each worker reads these when the pool starts it.
  process.env.SIMS_POLICY_SPECS = names.join(";");
  process.env.SIMS_RUN = runDir;
  process.env.SIMS_DRIVER_ROOT = DRIVER_ROOT;
  if (tables.pairTable !== null) {
    const file = path.join(REPO_ROOT, "tmp", `sims-pair-table-${tables.pins.pairsSha256}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(tables.pairTable));
    process.env.SIMS_PAIR_TABLE = file;
  }
  const myCommit = codeCommit();
  const pin = ctx.engine.pin as { repo: string; commit: string; cardDataVersion: string; cardDataSha256: string };
  const header = {
    driver: { name: "typed (src/sims)", codeCommit: ctx.codeCommit, botScheme: "sha256-counter-v1", recordMode: "none" },
    engine: { repo: pin.repo, commit: pin.commit, cardDataVersion: pin.cardDataVersion, cardDataSha256: pin.cardDataSha256 },
    inputs: tables.pins,
    run: path.basename(runDir),
    panel: panel.map((p, i) => ({ ...p, sha256: sha256(JSON.stringify(panelDecks[i])) })),
    codeCommit: myCommit,
  };
  const job = `sims-ladder-${values.mode}-${values.step ?? process.pid}`;
  const workers = values.workers === "auto" ? driver.engine.topCoreClassSize() : Number(values.workers);
  const t0 = performance.now();
  let played = 0;

  const toSpec = (j: Job) => ({ seed: String(j.seed), decks: [deckInputs[j.deck1], deckInputs[j.deck2]], policies: j.specs.map(driverName), recordMode: "none", undo: false, codeCommit: myCommit });
  const toResult = (j: Job, f: Footer): GameResult => ({
    seed: j.seed,
    winner: f.result.endCondition === "base_destroyed" ? f.result.winner : null,
    endCondition: f.result.endCondition === "base_destroyed" && f.result.winner === null ? "draw" : f.result.endCondition,
    error: f.error,
    rounds: f.result.rounds,
    decisions: f.result.decisions,
    traceSha256: f.traceSha256,
    coverage: f.coverage,
  });

  const pool = values.mode === "cost" ? null : await driver.pool.createPool({ workers, forceteki, pin: ctx.engine.pin });
  const runJobs = async (jobs: readonly Job[], p: ReturnType<typeof progress>, phase: string): Promise<GameResult[]> => {
    if (pool === null) throw new Error("no pool");
    const out: GameResult[] = [];
    for (let i = 0; i < jobs.length; i += CHUNK) {
      const part = jobs.slice(i, i + CHUNK);
      const records = await pool.run({ specs: part.map(toSpec), cardKeys: ctx.bridge.engineCardKeys });
      records.forEach((r, k) => out.push(toResult(part[k], r.footer)));
      played += part.length;
      p.tick(played, { phase });
    }
    return out;
  };

  const ordered: [number, number][] = [];
  for (let i = 0; i < panel.length; i++) for (let j = 0; j < panel.length; j++) ordered.push([i, j]);

  const ladder = async (cand: string, base: string, seed0: number, from: number, to: number, p: ReturnType<typeof progress>): Promise<{ pairs: LadderPair[]; games: GameResult[] }> => {
    const jobs: Job[] = [];
    for (let q = from; q < to; q++) {
      const [i, j] = ordered[q % ordered.length];
      jobs.push({ deck1: i, deck2: j, seed: seed0 + q, specs: [cand, base] });
      jobs.push({ deck1: i, deck2: j, seed: seed0 + q, specs: [base, cand] });
    }
    const games = await runJobs(jobs, p, `${driverName(cand)} vs ${driverName(base)}`);
    const pairs: LadderPair[] = [];
    for (let k = 0; k < games.length; k += 2) {
      const [i, j] = ordered[(from + k / 2) % ordered.length];
      pairs.push({ seed: games[k].seed, deck1: deckNames[i], deck2: deckNames[j], a: { winner: games[k].winner, endCondition: games[k].endCondition }, b: { winner: games[k + 1].winner, endCondition: games[k + 1].endCondition } });
    }
    return { pairs, games };
  };

  /** Ladder games alternate: the candidate in seat 1, then in seat 2. */
  const ladderSeat = (_g: GameResult, i: number): 0 | 1 => (i % 2) as 0 | 1;
  const health = (games: readonly GameResult[], seatOf: (g: GameResult, i: number) => 0 | 1) => {
    const ends: Record<string, number> = {};
    for (const g of games) ends[g.endCondition] = (ends[g.endCondition] ?? 0) + 1;
    return {
      candidateCoverage: coverageOf(games, seatOf),
      opponentCoverage: coverageOf(games, (g, i) => (1 - seatOf(g, i)) as 0 | 1),
      endConditions: Object.fromEntries(Object.entries(ends).sort(([a], [b]) => compareCodePoints(a, b))),
      errors: [...new Set(games.filter((g) => g.error).map((g) => g.error as string))].slice(0, 5),
      meanRounds: Math.round((games.reduce((s, g) => s + g.rounds, 0) / Math.max(1, games.length)) * 100) / 100,
      meanDecisions: Math.round((games.reduce((s, g) => s + g.decisions, 0) / Math.max(1, games.length)) * 10) / 10,
      tracesSha256: sha256(games.map((g) => g.traceSha256).join("\n")),
    };
  };

  const write = (name: string, record: unknown): void => {
    if (!values.write) return;
    mkdirSync(values.out as string, { recursive: true });
    writeFileSync(path.join(values.out as string, `${name}.json`), `${JSON.stringify(record, null, 1)}\n`);
  };
  /** Wall-clock figures go to stdout only: a gate record holds nothing that differs between two runs of the same seeds. */
  const wall = (games: number) => {
    const s = (performance.now() - t0) / 1000;
    return { wallSeconds: Math.round(s * 10) / 10, gamesPerSecond: Math.round((games / s) * 10) / 10, workers };
  };
  const label = "bot play (forceteki, typed driver), not human results";

  try {
    if (values.mode === "ladder") {
      if (!values.candidate || !values.baseline) throw new Error("--candidate and --baseline are required");
      const seed0 = Number(values.seed0 ?? SEEDS.evaluation);
      let n = Number(values.pairs);
      // With --escalate the total is the 800-pair ceiling; a step that passes early ends below it.
      const p = progress(job, { total: (values.escalate ? Math.max(n, 800) : n) * 2, everyN: 50 });
      let { pairs, games } = await ladder(values.candidate, values.baseline, seed0, 0, n, p);
      let summary = summarizeLadder(pairs, deckNames);
      if (values.escalate && !summary.pass && summary.discordant.pValue >= LADDER_ALPHA && n < 800) {
        p.log({ phase: "escalating to 800 pairs" });
        const more = await ladder(values.candidate, values.baseline, seed0, n, 800, p);
        pairs = [...pairs, ...more.pairs];
        games = [...games, ...more.games];
        n = 800;
        summary = summarizeLadder(pairs, deckNames);
      }
      const record = {
        schemaVersion: 1,
        step: values.step ?? `${driverName(values.candidate)}-vs-${driverName(values.baseline)}`,
        label,
        candidate: { ...policyHeader(parsePolicySpec(values.candidate)), driverPolicy: driverName(values.candidate) },
        baseline: { ...policyHeader(parsePolicySpec(values.baseline)), driverPolicy: driverName(values.baseline) },
        ...header,
        seeds: { range: "evaluation", from: seed0, to: seed0 + n - 1, scheme: "engine seed engine:<seed>; bot draws sha256-counter-v1 bot|<seed>|<seat>|<k>|<j>; both games of a pair share the seed" },
        design: { orderedDeckPairs: ordered.length, mirrorsIncluded: true, alpha: LADDER_ALPHA, plannedPairs: Number(values.pairs), escalated: n > Number(values.pairs) },
        summary,
        health: health(games, ladderSeat),
      };
      write(record.step, record);
      p.done({ pass: summary.pass });
      process.stdout.write(`${JSON.stringify({ ...record, speed: wall(games.length) }, null, 1)}\n`);
    } else if (values.mode === "grid") {
      const seed0 = Number(values.seed0 ?? SEEDS.tuning);
      const n = Number(values.pairs);
      const points = gridPoints();
      const p = progress(job, { total: points.length * n * 2, everyN: 50 });
      const rows = [];
      for (const pt of points) {
        const { pairs, games } = await ladder(`rung2:mu=${pt.mu},lambda=${pt.lambda}`, "rung1", seed0, 0, n, p);
        const s = summarizeLadder(pairs, deckNames);
        rows.push({ ...pt, pooled: s.pooled, discordant: s.discordant, nonDecisiveShare: s.nonDecisiveShare, decksAbove: s.passDetail.decksAbove, fallbackShare: health(games, ladderSeat).candidateCoverage.fallbackShare });
      }
      const best = [...rows].sort((a, b) => (b.pooled.share ?? 0) - (a.pooled.share ?? 0) || a.mu + a.lambda - (b.mu + b.lambda) || a.mu - b.mu)[0];
      const record = { schemaVersion: 1, step: "rung2-tuning", label, baseline: policyHeader(parsePolicySpec("rung1")), ...header, seeds: { range: "tuning", from: seed0, to: seed0 + n - 1 }, grid: values.grid, rows, best };
      write("rung2-tuning", record);
      p.done({ best });
      process.stdout.write(`${JSON.stringify({ ...record, speed: wall(played) }, null, 1)}\n`);
    } else if (values.mode === "field") {
      if (subjects.length === 0) throw new Error("--subject is required");
      const seed0 = Number(values.seed0 ?? SEEDS.deckCheck);
      const per = Number(values.per);
      const spec = values.policy as string;
      const slots: { opp: number; seat: 1 | 2; seed: number }[] = [];
      for (let k = 0; k < per; k++) for (let o = 0; o < panel.length; o++) for (const seat of [1, 2] as const) slots.push({ opp: o, seat, seed: seed0 + k * panel.length * 2 + o * 2 + (seat - 1) });
      const p = progress(job, { total: slots.length * subjects.length, everyN: 50 });
      const jobs: Job[] = subjects.flatMap((s) => slots.map((slot): Job => ({ deck1: slot.seat === 1 ? s.index : slot.opp, deck2: slot.seat === 1 ? slot.opp : s.index, seed: slot.seed, specs: [spec, spec] })));
      const games = await runJobs(jobs, p, "field");
      const won = subjects.map((_, si) =>
        slots.map((slot, k) => {
          const g = games[si * slots.length + k];
          return g.winner === null ? null : g.winner === slot.seat;
        }),
      );
      const results = subjects.map((s, si) => {
        const ws = won[si];
        const byOpponent = Object.fromEntries(
          panel.map((pd, o) => {
            const xs = ws.filter((_, k) => slots[k].opp === o).filter((x) => x !== null) as boolean[];
            return [pd.archetype, shareOf(xs.filter(Boolean).length, xs.length)];
          }),
        );
        const dec = ws.filter((x) => x !== null) as boolean[];
        return { name: s.name, file: s.file, swaps: s.swaps, sha256: sha256(JSON.stringify(s.deck)), share: shareOf(dec.filter(Boolean).length, dec.length), nonDecisive: ws.length - dec.length, byOpponent, vsFirst: si === 0 ? null : pairedDeckTest(won[0], ws) };
      });
      const subjectSeat = (_g: GameResult, i: number): 0 | 1 => (slots[i % slots.length].seat === 1 ? 0 : 1);
      const record = { schemaVersion: 1, step: values.step ?? "deck-field", label, policy: { ...policyHeader(parsePolicySpec(spec)), driverPolicy: driverName(spec) }, ...header, seeds: { range: "deckCheck", from: seed0, to: seed0 + slots.length - 1, perOpponentPerSeat: per }, results, health: health(games, subjectSeat) };
      write(record.step, record);
      p.done({});
      process.stdout.write(`${JSON.stringify({ ...record, speed: wall(games.length) }, null, 1)}\n`);
    } else if (values.mode === "cost") {
      // One thread, so the time inside each policy can be measured beside the engine's.
      const specs = (values.specs as string).split("|");
      const n = Number(values.games);
      const p = progress(job, { total: specs.length * n, everyN: 10 });
      const timing = { ms: 0, calls: 0 };
      const timed = (pol: DriverPolicy): DriverPolicy => ({
        ...pol,
        choose(actions, view, random) {
          const t = performance.now();
          const c = pol.choose(actions, view, random);
          timing.ms += performance.now() - t;
          timing.calls++;
          return c;
        },
      });
      const registry: Record<string, () => unknown> = {};
      registerRungs(registry, (ps) => new driver.policy.PolicyChain(ps.map(timed)), names, tables);
      for (const [k, make] of Object.entries(registry)) driver.policy.POLICIES[k] = make;
      const rows = [];
      for (const spec of specs) {
        timing.ms = 0;
        timing.calls = 0;
        const t = performance.now();
        let decisions = 0;
        const results: GameResult[] = [];
        for (let g = 0; g < n; g++) {
          const j: Job = { deck1: ordered[g % ordered.length][0], deck2: ordered[g % ordered.length][1], seed: SEEDS.evaluation + 500_000 + g, specs: [spec, spec] };
          const f = (await driver.match.playMatch(ctx.engine, toSpec(j), ctx.bridge.engineCardKeys)).record.footer;
          results.push(toResult(j, f));
          decisions += f.result.decisions;
          p.tick(++played, { phase: spec });
        }
        const ms = performance.now() - t;
        rows.push({
          spec: driverName(spec),
          games: n,
          meanDecisions: Math.round((decisions / n) * 10) / 10,
          msPerDecision: Math.round((ms / decisions) * 1000) / 1000,
          policyMsPerDecision: timing.calls === 0 ? null : Math.round((timing.ms / timing.calls) * 1e4) / 1e4,
          gamesPerSecondOneThread: Math.round((n / (ms / 1000)) * 10) / 10,
          endConditions: health(results, () => 0).endConditions,
        });
      }
      p.done({});
      process.stdout.write(`${JSON.stringify({ rows }, null, 1)}\n`);
    } else throw new Error(`unknown mode ${values.mode}`);
  } finally {
    await pool?.close();
  }
}

await main();
