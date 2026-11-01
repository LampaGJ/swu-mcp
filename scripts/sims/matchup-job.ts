/**
 * @displayName simulate_matchup job runner
 * @strategicPurpose Plays one simulate_matchup job off the MCP server's thread (#116): a stdio call must not block for
 * minutes, so the tool starts this process detached and reads its progress and result files.
 * @tacticalObjective Reads the job file the tool wrote (src/sims/matchup.ts jobFileSchema), checks the engine pin and
 * card tables against the calibration gate record it names, builds the decks through the cardKey bridge, draws
 * opponents with the sampler (src/sims/opponents.ts: stratified field, one archetype, or a named tournament list;
 * melee lists only, D22), plays the games on the warm worker pool with the calibrated rung on both seats, summarises
 * them (src/sims/matchup.ts) and writes result.json (deterministic: no clock field) and status.json; progress goes to
 * <job dir>/progress.json through scripts/lib/progress.mjs. Releases the one-job lock on exit.
 *
 *   node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/matchup-job.ts <job dir>/job.json
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { gateRecordSchema } from "../../src/sims/calibration.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import type { DeckInput, MatchSpec } from "../../src/sims/match.js";
import {
  SIMS_JOBS_DIR,
  applySwaps,
  endBoardTop,
  h2hPlan,
  jobFileSchema,
  jobLockSchema,
  opponentPlan,
  renderResult,
  summarizeH2H,
  summarizeVsOpponent,
  type MatchupDeck,
  type StratumInfo,
  type SubjectGame,
} from "../../src/sims/matchup.js";
import { engineSetCodes, engineUnmappedCards, loadOpponentPool, mapCardKeyOf, namedDraw, sampleStratified, stratifiedPlan, storeAspectsOf, type Draw, type OpponentPool } from "../../src/sims/opponents.js";
import { parsePolicySpec, policyHeader } from "../../src/sims/policies/index.js";
import { pairedDeckTest } from "../../src/sims/policies/ladder-stats.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { driverName } from "../../src/sims/policies/typed-adapter.js";
import { createPool } from "../../src/sims/pool.js";
import type { MatchFooter } from "../../src/sims/schemas.js";
import { canonicalJson, compareCodePoints } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../bench/card-map.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_ORIGINALS, loadContext } from "./context.js";
import { prepareDeck } from "./decks.js";
import type { CardBridge } from "./card-bridge.js";

/** The ladder's 40 games per worker per batch is the throughput best (D81); a job takes about a tenth of its games per batch, at least 4 per worker, so the tool's progress moves. */
const MAX_PER_WORKER = 40;
const MIN_PER_WORKER = 4;
const sha12 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

function engineDeck(bridge: CardBridge, deck: MatchupDeck, source: string): DeckInput {
  const id = (cardKey: string): string => {
    const ref = bridge.toEngine(cardKey);
    if (ref === null) throw new Error(`the engine has no card for cardKey ${cardKey}`);
    return ref.setCode;
  };
  const cards = [...deck.cards].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
  return { list: { leader: { id: id(deck.leader), count: 1 }, base: { id: id(deck.base), count: 1 }, deck: cards.map((c) => ({ id: id(c.cardKey), count: c.count })), sideboard: [] }, leader: deck.leader, base: deck.base, cards, source };
}

/** An archetype id, or a prefix of exactly one (meta_threats accepts "t001"). */
function archetypeOf(pool: OpponentPool, ref: string) {
  const exact = pool.archetypes.find((a) => a.id === ref);
  if (exact !== undefined) return exact;
  const hits = pool.archetypes.filter((a) => a.id.startsWith(`${ref}-`));
  return hits.length === 1 ? hits[0] : undefined;
}

async function main(): Promise<void> {
  const jobPath = path.resolve(process.argv[2] ?? "");
  const dir = path.dirname(jobPath);
  const statusFile = path.join(dir, "status.json");
  // A job file that does not parse still gets a failed status, so the tool reports it instead of waiting on it.
  const dirKey = /^[0-9a-f]{64}$/.test(path.basename(dir)) ? path.basename(dir) : "0".repeat(64);
  const parsed = jobFileSchema.safeParse(existsSync(jobPath) ? JSON.parse(readFileSync(jobPath, "utf8")) : null);
  if (!parsed.success) {
    writeFileSync(statusFile, `${JSON.stringify({ state: "failed", key: dirKey, pid: process.pid, plannedGames: 0, error: `the job file ${jobPath} does not parse: ${parsed.error.message}` })}\n`);
    process.exitCode = 1;
    return;
  }
  const job = parsed.data;
  const writeStatus = (state: "running" | "done" | "failed", error: string | null): void =>
    writeFileSync(statusFile, `${JSON.stringify({ state, key: job.key, pid: process.pid, plannedGames: job.plannedGames, error })}\n`);
  const lockFile = path.join(REPO_ROOT, SIMS_JOBS_DIR, ".lock");
  const release = (): void => {
    if (!existsSync(lockFile)) return;
    const lock = jobLockSchema.safeParse(JSON.parse(readFileSync(lockFile, "utf8")));
    if (lock.success && lock.data.key === job.key) rmSync(lockFile, { force: true });
  };
  writeStatus("running", null);
  try {
    const input = job.input;
    const record = gateRecordSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, job.gateRecord), "utf8")));
    if (record.policy.spec !== input.policy) throw new Error(`gate record ${job.gateRecord} is for ${record.policy.spec}, not ${input.policy}`);
    const pilotRun = path.join(REPO_ROOT, "data/runs", record.pilotRun);
    const metaRun = path.join(REPO_ROOT, "data/runs", record.metaRun);
    const decksDir = path.join(REPO_ROOT, record.decks);
    const tables = loadTables({ runDir: pilotRun, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    for (const k of ["scoresSha256", "coefficientsSha256", "featuresSha256"] as const)
      if (tables.pins[k] !== record.inputs[k]) throw new Error(`the card tables in data/runs/${record.pilotRun} changed since ${input.policy} was calibrated (${k}); re-run the calibration gate`);
    const ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: pilotRun, originals: DEFAULT_ORIGINALS, "no-memo": false });
    if (ctx.engine.pin.commit !== record.engine.commit) throw new Error(`the engine pin ${ctx.engine.pin.commit} is not the calibrated ${record.engine.commit}`);
    const keys = ctx.bridge.engineCardKeys;
    const name = driverName(input.policy);
    const searches = ["lookahead", "montecarlo"].includes(parsePolicySpec(input.policy).kind);

    const subject = engineDeck(ctx.bridge, input.deck, `simulate_matchup deck ${sha12(canonicalJson(input.deck))}`);
    const otherDeck = input.opponentDeck ?? (input.variant.length > 0 ? applySwaps(input.deck, input.variant) : null);
    const other = otherDeck === null ? null : engineDeck(ctx.bridge, otherDeck, input.opponentDeck !== null ? `simulate_matchup opponent deck ${sha12(canonicalJson(otherDeck))}` : `simulate_matchup variant ${input.variant.join(",")}`);

    // Opponents from melee tournament lists only (the sampler refuses Karabast, D22).
    let draws: Draw[] = [];
    let strata: StratumInfo[] = [];
    let population: Record<string, unknown> = {};
    if (input.mode !== "h2h") {
      const cardMap = loadCardMap(pilotRun, path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
      const pool = loadOpponentPool({
        archetypesFile: path.join(metaRun, "meta/archetypes.json"),
        decksDir,
        cardKeyOf: mapCardKeyOf(cardMap.setNumber.byId),
        baseAspectsOf: storeAspectsOf(loadStore(pilotRun)),
        unmappedCards: engineUnmappedCards(engineSetCodes(DEFAULT_FORCETEKI)),
      });
      const ref = input.opponent as string;
      let sample: { draws: Draw[]; population: { text: string; lists: number }; unplayableArchetypes: string[]; skippedUnmapped: unknown[] };
      let description: string;
      if (ref === "field") {
        const plan = stratifiedPlan(pool, { top: 6, perStratum: input.games, restOfField: input.games });
        sample = sampleStratified(pool, plan, { seed: input.seed });
        strata = plan.map((s) => ({ id: s.id, name: s.name, weight: s.weight }));
        description = "the tournament field: the six largest archetypes by share, each its own stratum, plus one rest-of-field stratum, weighted by share";
      } else {
        const arch = archetypeOf(pool, ref);
        if (arch !== undefined) {
          const plan = [{ id: arch.id, name: arch.name, weight: 1, n: input.games, archetypeIds: [arch.id] }];
          sample = sampleStratified(pool, plan, { seed: input.seed });
          strata = [{ id: arch.id, name: arch.name, weight: 1 }];
          description = `archetype ${arch.id} (${arch.name})`;
        } else if (pool.lists.some((l) => l.key === ref)) {
          const d = namedDraw(pool, ref, input.seed);
          if (d.unmapped.length > 0) throw new Error(`the engine cannot build tournament list ${ref}: no card for ${d.unmapped.join(", ")}`);
          sample = { draws: Array.from({ length: input.games }, (_, i) => ({ ...d, index: i, stratum: d.archetypeId })), population: { text: `the tournament list ${ref} (${d.archetypeName})`, lists: 1 }, unplayableArchetypes: [], skippedUnmapped: [] };
          strata = [{ id: d.archetypeId, name: d.archetypeName, weight: 1 }];
          description = `tournament list ${ref} (${d.list.name ?? d.archetypeName}, placed ${d.list.placement} of ${d.list.field})`;
        } else {
          throw new Error(`opponent ${ref} is not an archetype id from meta_archetypes, a melee tournament list key in ${record.decks} (window ${pool.window.from} to ${pool.window.to}), or "field"`);
        }
      }
      draws = sample.draws;
      population = {
        opponent: description,
        source: sample.population.text,
        lists: new Set(draws.map((d) => d.list.key)).size,
        window: pool.window,
        unplayableArchetypes: sample.unplayableArchetypes,
        listsSetAsideUnbuildable: sample.skippedUnmapped.length,
      };
    } else {
      population = { opponent: input.opponentDeck !== null ? "the second deck given (opponentDeck)" : `the deck's own variant (${input.variant.join(", ")})`, source: "the decks given, no tournament data", lists: 2 };
    }

    // Opponent decks, one per distinct list.
    const oppDecks = new Map<string, DeckInput>();
    for (const d of draws) if (!oppDecks.has(d.list.key)) oppDecks.set(d.list.key, prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(decksDir, `${d.list.key}.json`), "utf8")), d.source));

    const spec = (seed: string, a: DeckInput, b: DeckInput): MatchSpec => ({ seed, decks: [a, b], policies: [name, name], recordMode: "none", undo: searches, codeCommit: ctx.codeCommit });
    interface Slot {
      spec: MatchSpec;
      /** Seat (0 or 1) of the deck being scored, or null for a mirror game. */
      ourSeat: 0 | 1 | null;
      stratum: string;
      group: "deck" | "variant" | "h2h" | "mirror";
    }
    const slots: Slot[] = [];
    if (input.mode === "h2h") {
      const o = other as DeckInput;
      const plan = h2hPlan(input.seed, input.games);
      for (const pr of plan.pairs) {
        slots.push({ spec: spec(pr.seed, subject, o), ourSeat: 0, stratum: "h2h", group: "h2h" });
        slots.push({ spec: spec(pr.seed, o, subject), ourSeat: 1, stratum: "h2h", group: "h2h" });
      }
      for (const s of plan.mirror) slots.push({ spec: spec(s, subject, subject), ourSeat: null, stratum: "mirror", group: "mirror" });
    } else {
      const plan = opponentPlan(input.seed, draws.map((d) => ({ stratum: d.stratum, index: d.index })));
      const subjects: ["deck" | "variant", DeckInput][] = input.mode === "variant-vs-opponent" ? [["deck", subject], ["variant", other as DeckInput]] : [["deck", subject]];
      for (const [group, deck] of subjects)
        plan.forEach((pl, k) => {
          const opp = oppDecks.get(draws[k].list.key) as DeckInput;
          slots.push({ spec: pl.subjectSeat === 1 ? spec(pl.seed, deck, opp) : spec(pl.seed, opp, deck), ourSeat: pl.subjectSeat === 1 ? 0 : 1, stratum: pl.stratum, group });
        });
    }

    process.env.SIMS_POLICY_SPECS = name;
    process.env.SIMS_RUN = pilotRun;
    const p = progress("progress", { dir, total: slots.length, everyN: 10, everyMs: 3000 });
    p.log({ phase: "starting workers" });
    const sim = await createPool({ workers: job.workers, pin: ctx.engine.pin });
    const footers: MatchFooter[] = [];
    try {
      const parts: Slot[][] = [];
      const chunk = Math.max(MIN_PER_WORKER * job.workers, Math.min(MAX_PER_WORKER * job.workers, Math.ceil(slots.length / 10)));
      for (let k = 0; k < slots.length; k += chunk) parts.push(slots.slice(k, k + chunk));
      const start = (part: Slot[]) => sim.run({ specs: part.map((s) => s.spec), cardKeys: keys });
      let next = parts.length > 0 ? start(parts[0]) : null;
      for (let c = 0; c < parts.length; c++) {
        const current = next as ReturnType<typeof start>;
        next = c + 1 < parts.length ? start(parts[c + 1]) : null;
        for (const r of await current) footers.push(r.footer);
        p.tick(footers.length, { phase: "games" });
      }
    } finally {
      await sim.close();
    }

    const decisive = (f: MatchFooter): boolean => f.result.endCondition === "base_destroyed" && f.result.winner !== null;
    const subjectGame = (s: Slot, f: MatchFooter): SubjectGame => ({
      stratum: s.stratum,
      won: decisive(f) ? f.result.winner === (s.ourSeat as number) + 1 : null,
      endCondition: f.result.endCondition === "base_destroyed" && f.result.winner === null ? "draw" : f.result.endCondition,
      rounds: f.result.rounds,
      endBoard: f.endBoard[s.ourSeat ?? 0],
    });
    let decisions = 0;
    let answered = 0;
    for (const f of footers) {
      decisions += f.coverage.decisions[0] + f.coverage.decisions[1];
      answered += f.coverage.answered[0] + f.coverage.answered[1];
    }
    const errors = [...new Set(footers.filter((f) => f.error !== null).map((f) => f.error as string))].slice(0, 3);
    const health = { games: footers.length, decisions, fallbackShare: decisions === 0 ? null : Math.round(((decisions - answered) / decisions) * 1e4) / 1e4, errors };

    let body: Record<string, unknown>;
    const field = input.opponent === "field";
    if (input.mode === "opponent") {
      const games = slots.map((s, k) => subjectGame(s, footers[k]));
      body = { mode: input.mode, population, ...summarizeVsOpponent(games, strata, { field, seed: input.seed }), health };
    } else if (input.mode === "variant-vs-opponent") {
      const half = slots.length / 2;
      const base = slots.slice(0, half).map((s, k) => subjectGame(s, footers[k]));
      const variant = slots.slice(half).map((s, k) => subjectGame(s, footers[half + k]));
      const paired = pairedDeckTest(
        base.map((g) => g.won),
        variant.map((g) => g.won),
      );
      body = {
        mode: input.mode,
        population,
        variant: input.variant,
        deck: summarizeVsOpponent(base, strata, { field, seed: input.seed }),
        variantDeck: summarizeVsOpponent(variant, strata, { field, seed: input.seed }),
        paired: { design: "both decks played the same opponent list, engine seed and seat in every game; exact sign test on the games only one of them won", deckOnlyWon: paired.baseOnly, variantOnlyWon: paired.variantOnly, pValue: paired.pValue },
        health,
      };
    } else {
      const h2h = slots.map((s, k) => ({ s, f: footers[k] })).filter((x) => x.s.group === "h2h");
      const pairs = [];
      for (let k = 0; k < h2h.length; k += 2) {
        const w = (f: MatchFooter): 1 | 2 | null => (decisive(f) ? (f.result.winner as 1 | 2) : null);
        pairs.push({ seed: h2h[k].s.spec.seed, a: w(h2h[k].f), b: w(h2h[k + 1].f) });
      }
      const mirror = slots.map((s, k) => ({ s, f: footers[k] })).filter((x) => x.s.group === "mirror").map((x) => (decisive(x.f) ? (x.f.result.winner as 1 | 2) : null));
      const ours = h2h.map((x) => subjectGame(x.s, x.f));
      const sum = summarizeH2H(pairs, mirror);
      body = {
        mode: input.mode,
        population,
        variant: input.variant.length > 0 ? input.variant : null,
        design: "each seed played twice with the same engine seed and the decks' seats swapped; deckShare is the share of decisive games the first deck won (Wilson 95%); the sign test counts seeds one deck won both; the mirror is the first deck against itself on the same seeds, seat 1's share",
        n: sum.deckShare.n,
        wins: sum.deckShare.wins,
        winShare: sum.deckShare.share,
        wilson95: sum.deckShare.low === null ? null : { low: sum.deckShare.low, high: sum.deckShare.high },
        discordant: sum.discordant,
        mirror: sum.mirror,
        drawRate: ours.length === 0 ? 0 : Math.round((ours.filter((g) => g.won === null && g.endCondition !== "error").length / ours.length) * 1e4) / 1e4,
        errorRate: ours.length === 0 ? 0 : Math.round((ours.filter((g) => g.endCondition === "error").length / ours.length) * 1e4) / 1e4,
        meanRounds: ours.length === 0 ? 0 : Math.round((ours.reduce((s, g) => s + g.rounds, 0) / ours.length) * 100) / 100,
        endBoardTopCards: endBoardTop(ours),
        health,
      };
    }
    const header = policyHeader(parsePolicySpec(input.policy));
    const result = renderResult({ body, policy: input.policy, policyVersion: `${header.id} v${header.version} params ${header.paramsSha256.slice(0, 12)}`, inputHash: job.inputHash, codeCommit: ctx.codeCommit, engine: { commit: ctx.engine.pin.commit, cardDataVersion: ctx.engine.pin.cardDataVersion }, seed: input.seed });
    writeFileSync(path.join(dir, "result.json"), `${JSON.stringify(result)}\n`);
    p.done({});
    writeStatus("done", null);
  } catch (e) {
    writeStatus("failed", String((e as Error)?.message ?? e));
    process.exitCode = 1;
  } finally {
    release();
  }
}

await main();
