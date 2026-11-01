import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CardStore } from "../data.js";
import { REPO_ROOT } from "../paths.js";
import { choosePilot, gateRecordSchema, type GateRecord } from "../sims/calibration.js";
import { BUILT_MARKER, DEFAULT_FORCETEKI, readPin } from "../sims/engine-pin.js";
import {
  SIMS_JOBS_DIR,
  applySwaps,
  canonicalInput,
  inputHash,
  jobKey,
  jobLockSchema,
  jobProgressSchema,
  jobResultSchema,
  jobStatusSchema,
  matchupLabel,
  parseMatchupInput,
  plannedGames,
  simulateMatchupShape,
  validateDeck,
  type JobFile,
  type MatchupDeck,
} from "../sims/matchup.js";
import { parsePolicySpec, policyHeader } from "../sims/policies/index.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { ToolResult } from "../tools.js";
import { fail, ok } from "./common.js";
import { swudbCandidates, swudbDeckSchema, swudbField } from "./swudb.js";

/**
 * @displayName simulate_matchup tool
 * @strategicPurpose Lets an assistant battle-test a deck offline against real tournament decklists, against its own
 * variant, or against another deck, with the calibrated bot rung on both seats (#116). Bot play is the last tier of
 * D21 and is labelled so; Karabast data never enters it (D22); a rung without a passing calibration gate record
 * reports no win share (D9, #115).
 * @tacticalObjective Never blocks the stdio server: a call parses and checks the input, picks the pilot from the
 * pinned gate records, keys the job by the canonical input hash plus code commit, engine pin and gate record, and
 * then either returns the cached result, the running job's progress, a busy notice (one job at a time), or starts
 * scripts/sims/matchup-job.ts detached and returns at once. Registered only when SWU_MCP_SIMS=1 (src/tools.ts), so
 * the public endpoint, which runs without it, never exposes the engine.
 */

export const CALIBRATION_DIR = "data/pinned/sim-calibration-v1";

/** Measured games per second on 12 workers, both seats on the rung: rung 1 47 (the calibration run), rung 3 top-K 1.2 and flat Monte Carlo 0.24 (docs/verification/2026-10-31-bot-ladder.md:194, :196). */
const GAMES_PER_SECOND: Record<string, number> = { rules: 47, lookahead: 1.2, montecarlo: 0.24 };
const STARTUP_SECONDS = 20;

export interface SimsDeps {
  root: string;
  /** The verified engine pin when the local forceteki clone is built, else null. */
  engine(): { commit: string; cardDataSha256: string } | null;
  codeCommit(): string;
  /** Starts the job runner detached on the job file; returns its pid. */
  spawnJob(jobFile: string, logFile: string): number;
  isAlive(pid: number): boolean;
  workers: number;
}

function gitIn(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

export function defaultDeps(): SimsDeps {
  return {
    root: REPO_ROOT,
    engine: () => {
      if (!existsSync(path.join(DEFAULT_FORCETEKI, BUILT_MARKER))) return null;
      const pin = readPin();
      return { commit: pin.commit, cardDataSha256: pin.cardDataSha256 };
    },
    // A dirty tree is keyed by its diff too, so an edit never serves a result cached before it.
    codeCommit: () => {
      const scope = ["--", "src", "scripts", "package.json"];
      const head = gitIn(REPO_ROOT, ["rev-parse", "HEAD"]);
      const status = gitIn(REPO_ROOT, ["status", "--porcelain", ...scope]);
      if (status === "") return head;
      return `${head}-dirty+${createHash("sha256").update(status).update(gitIn(REPO_ROOT, ["diff", "HEAD", ...scope])).digest("hex").slice(0, 12)}`;
    },
    spawnJob: (jobFile, logFile) => {
      const log = openSync(logFile, "a");
      const child = spawn(process.execPath, ["--import", "tsx", "--import=./scripts/sims/ladder-preload.ts", "scripts/sims/matchup-job.ts", jobFile], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ["ignore", log, log],
        env: { ...process.env, TMPDIR: path.join(REPO_ROOT, "tmp") },
      });
      child.unref();
      if (child.pid === undefined) throw new Error("the job runner did not start");
      return child.pid;
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    workers: Number(process.env.SWU_MCP_SIMS_WORKERS ?? 12),
  };
}

const MAIN_TYPES_EXCLUDED = new Set(["Leader", "Base"]);

/** A SWUDB document to a cardKey deck; each id must name one card of the right kind. */
function deckFromSwudb(store: CardStore, raw: unknown): MatchupDeck | string {
  const parsed = swudbDeckSchema.safeParse(raw);
  if (!parsed.success) return `swudb is not a SWUDB interchange document: ${z.prettifyError(parsed.error)}`;
  const doc = parsed.data;
  const one = (id: string, want: (type: string) => boolean, kind: string): string | { error: string } => {
    const keys = [...new Set(swudbCandidates(store, id).filter((c) => want(String(c.type ?? ""))).map((c) => c.cardKey))];
    if (keys.length === 1) return keys[0];
    return { error: keys.length === 0 ? `swudb: no ${kind} card for ${id}` : `swudb: ${id} names ${keys.length} ${kind} cards (${keys.join(", ")}); give the deck by cardKey` };
  };
  const leader = one(doc.leader.id, (t) => t === "Leader", "Leader");
  if (typeof leader !== "string") return leader.error;
  const base = one(doc.base.id, (t) => t === "Base", "Base");
  if (typeof base !== "string") return base.error;
  const cards: MatchupDeck["cards"] = [];
  for (const e of doc.deck) {
    const k = one(e.id, (t) => !MAIN_TYPES_EXCLUDED.has(t) && !t.includes("Token"), "main-deck");
    if (typeof k !== "string") return k.error;
    cards.push({ cardKey: k, count: e.count });
  }
  return { leader, base, cards };
}

function readRecords(root: string): { records: GateRecord[]; files: Map<GateRecord, { file: string; sha256: string }> } | string {
  const dir = path.join(root, CALIBRATION_DIR);
  const records: GateRecord[] = [];
  const files = new Map<GateRecord, { file: string; sha256: string }>();
  if (!existsSync(dir)) return { records, files };
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort(compareCodePoints)) {
    const bytes = readFileSync(path.join(dir, name));
    const r = gateRecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!r.success) return `the calibration gate record ${CALIBRATION_DIR}/${name} does not parse: ${z.prettifyError(r.error)}`;
    records.push(r.data);
    files.set(r.data, { file: `${CALIBRATION_DIR}/${name}`, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { records, files };
}

const readJsonIf = (file: string): unknown => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);

function progressOf(dir: string): Record<string, unknown> | null {
  const p = jobProgressSchema.safeParse(readJsonIf(path.join(dir, "progress.json")));
  return p.success ? { done: p.data.done, total: p.data.total, pct: p.data.pct, etaSeconds: p.data.eta_s, phase: p.data.phase ?? null } : null;
}

export function simulateMatchup(store: CardStore, raw: unknown, deps: SimsDeps = defaultDeps()): ToolResult {
  let input = raw;
  if (typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).swudb !== undefined) {
    const { swudb, ...rest } = raw as Record<string, unknown>;
    if (rest.deck !== undefined) return fail("give either deck or swudb, not both");
    const deck = deckFromSwudb(store, swudb);
    if (typeof deck === "string") return fail(deck);
    input = { ...rest, deck };
  }
  const parsed = parseMatchupInput(input);
  if (!parsed.ok) return fail(parsed.error);
  const x = parsed.input;
  const lookup = (k: string) => {
    const c = store.byKey.get(k);
    return c === undefined ? undefined : { type: String(c.type ?? ""), title: String(c.title ?? k) };
  };
  const bad = validateDeck(x.deck, lookup) ?? (x.opponentDeck === null ? null : validateDeck(x.opponentDeck, lookup, "opponentDeck"));
  if (bad !== null) return fail(bad);
  if (x.variant.length > 0) {
    let variant: MatchupDeck;
    try {
      variant = applySwaps(x.deck, x.variant);
    } catch (e) {
      return fail((e as Error).message);
    }
    const badVariant = validateDeck(variant, lookup, "variant");
    if (badVariant !== null) return fail(badVariant);
  }

  const engine = deps.engine();
  if (engine === null) return fail(`simulate_matchup needs the local forceteki engine clone, built, at ${DEFAULT_FORCETEKI}; run pnpm sims:pin --setup. It is a local-only tool.`);
  const loaded = readRecords(deps.root);
  if (typeof loaded === "string") return fail(loaded);
  let requested: string | undefined;
  if (x.policy !== null) {
    try {
      requested = policyHeader(parsePolicySpec(x.policy)).spec;
    } catch (e) {
      return fail(`policy ${x.policy}: ${(e as Error).message}; known rungs are rung1, rung3:k=8 and rung3mc:playout=rung1,n=2`);
    }
  }
  const choice = choosePilot(loaded.records, requested, engine.commit);
  if ("error" in choice) return fail(choice.error);
  const rec = loaded.files.get(choice.record) as { file: string; sha256: string };

  const canon = canonicalInput(x, choice.spec);
  const pins = { codeCommit: deps.codeCommit(), engineCommit: engine.commit, cardDataSha256: engine.cardDataSha256, gateRecordSha256: rec.sha256 };
  const key = jobKey(canon, pins);
  const games = plannedGames(x);
  const kind = choice.spec.startsWith("rung3mc") ? "montecarlo" : choice.spec.startsWith("rung3") ? "lookahead" : "rules";
  const head = {
    job: key.slice(0, 16),
    mode: x.mode,
    policy: choice.spec,
    calibration: rec.file,
    plannedGames: games,
    estimatedSeconds: Math.round(STARTUP_SECONDS + (games / GAMES_PER_SECOND[kind]) * (12 / deps.workers)),
    label: matchupLabel(choice.spec),
  };
  if (x.dryRun) return ok({ jobState: "plan", ...head });

  const jobsRoot = path.join(deps.root, SIMS_JOBS_DIR);
  const dir = path.join(jobsRoot, key);
  const result = jobResultSchema.safeParse(readJsonIf(path.join(dir, "result.json")));
  if (result.success) return ok({ jobState: "done", job: head.job, ...result.data });
  const statusFile = path.join(dir, "status.json");
  const status = jobStatusSchema.safeParse(readJsonIf(statusFile));
  if (status.success && status.data.state === "failed" && !deps.isAlive(status.data.pid)) {
    rmSync(statusFile, { force: true });
    return fail(`the simulate_matchup job failed: ${status.data.error ?? "no error text"}. Call again with the same arguments to retry.`);
  }

  const lockFile = path.join(jobsRoot, ".lock");
  const lock = jobLockSchema.safeParse(readJsonIf(lockFile));
  if (lock.success && deps.isAlive(lock.data.pid)) {
    if (lock.data.key === key) return ok({ jobState: "running", ...head, progress: progressOf(dir), next: "call simulate_matchup again with the same arguments for progress and, when done, the result" });
    return ok({ jobState: "busy", ...head, runningJob: lock.data.key.slice(0, 16), runningProgress: progressOf(path.join(jobsRoot, lock.data.key)), next: "one simulation job runs at a time; call again when the running job is done" });
  }
  if (lock.success) rmSync(lockFile, { force: true });

  mkdirSync(dir, { recursive: true });
  const job: JobFile = { key, inputHash: inputHash(canon), input: canon, gateRecord: rec.file, pins, workers: deps.workers, plannedGames: games };
  const jobFile = path.join(dir, "job.json");
  writeFileSync(jobFile, `${JSON.stringify(job, null, 1)}\n`);
  rmSync(statusFile, { force: true });
  rmSync(path.join(dir, "progress.json"), { force: true });
  const pid = deps.spawnJob(jobFile, path.join(dir, "job.log"));
  writeFileSync(lockFile, `${JSON.stringify({ key, pid })}\n`);
  return ok({ jobState: "started", ...head, next: "the job runs in the background; call simulate_matchup again with the same arguments for progress and, when done, the result" });
}

export const SIMS_TOOLS = {
  simulate_matchup: {
    title: "Simulate a matchup (bot play)",
    description:
      'Battle-tests a deck offline on the forceteki rules engine with the same calibrated bot rung on both seats: against an archetype id, a melee tournament list key, or "field" (the six largest archetypes plus a rest-of-field stratum, weighted by share); against its own variant (OUT>IN swaps: head-to-head on paired seeds with both seat orders, a sign test and a mirror control, or, with opponent, both decks against the same opponents and seeds); or against opponentDeck (my deck against my deck). Returns win share, a Wilson 95% interval (a stratified bootstrap for the weighted field), per-archetype rows, draw and error rates and a replay record, labelled "bot play (forceteki <policy>), not human results", status candidate: it describes the deck as this bot plays it, never a tournament win rate. Games run as one background job keyed by the input: the first call starts it and returns at once, repeat the identical call for progress and the result. One job at a time. Local only; a rung reports a win share only with a passing calibration gate record.',
    shape: { ...simulateMatchupShape, swudb: swudbField },
    handler: (store: CardStore, input: unknown): ToolResult => simulateMatchup(store, input),
  },
};
