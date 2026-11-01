import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import { liveStatsSchema, type LiveStatsPayload, type PairedStat, type ShareStat } from "./live-stats.js";

/**
 * @displayName Simulation run watcher
 * @strategicPurpose Gives the owner one terminal view of every running or just-finished simulation job in the main
 * checkout and every linked worktree: x of y games, who is ahead, whether the games are healthy, and whether the
 * job still lives (#178 of #104, D99).
 * @tacticalObjective Parses heartbeats (reports/.progress/<job>.json and tmp/sims-jobs/<key>/progress.json),
 * classifies each as running, stalled (heartbeat older than five minutes), dead (process gone) or done, picks the
 * jobs the default view shows, and renders one plain-text block per job. Pure over its inputs apart from the file
 * reads in discoverJobs; the clock and the process check are arguments. The terminal loop is scripts/sims/watch.ts.
 */

export const STALLED_AFTER_S = 300;
/** The default view keeps a finished or dead job for an hour. */
export const RECENT_S = 3600;

export const heartbeatSchema = z.looseObject({
  // A Python writer stamps +00:00 with microseconds (train-evaluator-py), so offsets are accepted.
  ts: z.iso.datetime({ offset: true }),
  job: z.string(),
  done: z.number(),
  total: z.number().nullable(),
  pct: z.number().nullable(),
  rate_per_s: z.number().optional(),
  games_per_s: z.number().optional(),
  eta_s: z.number().nullable(),
  elapsed_s: z.number().optional(),
  phase: z.string().optional(),
  pid: z.int().positive().optional(),
  moved_ts: z.iso.datetime({ offset: true }).optional(),
  /** Parsed on its own by liveStatsSchema, so one bad payload does not hide the job. */
  stats: z.unknown().optional(),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export interface Worktree {
  path: string;
  branch: string | null;
  main: boolean;
}

/** `git worktree list --porcelain`: blocks separated by a blank line, the first block is the main checkout. */
export function parseWorktreeList(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l !== "");
    const head = lines.find((l) => l.startsWith("worktree "));
    if (head === undefined) continue;
    const branch = lines.find((l) => l.startsWith("branch "));
    out.push({ path: head.slice("worktree ".length), branch: branch === undefined ? null : branch.slice("branch ".length).replace(/^refs\/heads\//, ""), main: out.length === 0 });
  }
  return out;
}

export interface Source {
  root: string;
  label: string;
  branch: string | null;
  /** The main checkout, as git lists it first. Absent counts as a linked worktree. */
  main?: boolean;
}

export type JobState = "running" | "stalled" | "dead" | "done";

export interface JobView {
  hb: Heartbeat;
  job: string;
  state: JobState;
  /** Seconds since the heartbeat file was last written (the keepalive counts). */
  ageS: number;
  /** Seconds since a tick, log or done last wrote; the heartbeat age when the file predates moved_ts. */
  movedAgeS: number;
  /** Whether the writing process still exists; null when the heartbeat has no pid. */
  alive: boolean | null;
  source: Source;
  file: string;
  stats: LiveStatsPayload | null;
  statsError: string | null;
}

export function classify(hb: Heartbeat, nowMs: number, alive: boolean | null): Pick<JobView, "hb" | "state" | "ageS" | "movedAgeS" | "alive" | "job"> {
  const ageS = Math.max(0, Math.round((nowMs - Date.parse(hb.ts)) / 1000));
  const movedAgeS = Math.max(0, Math.round((nowMs - Date.parse(hb.moved_ts ?? hb.ts)) / 1000));
  const state: JobState = hb.phase === "done" ? "done" : alive === false ? "dead" : ageS > STALLED_AFTER_S ? "stalled" : "running";
  return { hb, job: hb.job, state, ageS, movedAgeS, alive };
}

const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0];
  return `${i.path.join(".") || "(root)"}: ${i.message}`;
};

function readHeartbeat(file: string): { hb: Heartbeat; stats: LiveStatsPayload | null; statsError: string | null } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { error: `not JSON: ${(e as Error).message}` };
  }
  const hb = heartbeatSchema.safeParse(raw);
  if (!hb.success) return { error: firstIssue(hb.error) };
  if (hb.data.stats === undefined) return { hb: hb.data, stats: null, statsError: null };
  const stats = liveStatsSchema.safeParse(hb.data.stats);
  return stats.success ? { hb: hb.data, stats: stats.data, statsError: null } : { hb: hb.data, stats: null, statsError: firstIssue(stats.error) };
}

const jsonFiles = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort(compareCodePoints) : []);

/** Heartbeats of every source. A file that does not parse is reported, never silently dropped. */
export function discoverJobs(sources: readonly Source[], nowMs: number, isAlive: (pid: number) => boolean): { jobs: JobView[]; skipped: { file: string; reason: string }[] } {
  const jobs: JobView[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const source of sources) {
    const files: { file: string; name?: string }[] = jsonFiles(path.join(source.root, "reports/.progress")).map((n) => ({ file: path.join(source.root, "reports/.progress", n) }));
    const jobsDir = path.join(source.root, "tmp/sims-jobs");
    if (existsSync(jobsDir)) {
      for (const key of readdirSync(jobsDir).sort(compareCodePoints)) {
        const file = path.join(jobsDir, key, "progress.json");
        if (existsSync(file)) files.push({ file, name: `matchup-${key.slice(0, 12)}` });
      }
    }
    for (const f of files) {
      const r = readHeartbeat(f.file);
      if ("error" in r) {
        skipped.push({ file: f.file, reason: r.error });
        continue;
      }
      const hb = f.name === undefined ? r.hb : { ...r.hb, job: f.name };
      jobs.push({ ...classify(hb, nowMs, hb.pid === undefined ? null : isAlive(hb.pid)), source, file: f.file, stats: r.stats, statsError: r.statsError });
    }
  }
  return { jobs, skipped };
}

const ORDER: Record<JobState, number> = { running: 0, stalled: 1, dead: 2, done: 3 };

/** Default: live jobs, a stalled job whose process still exists, and anything that ended or went quiet in the last hour. */
export function selectVisible(jobs: readonly JobView[], all: boolean): JobView[] {
  const keep = all ? [...jobs] : jobs.filter((j) => j.state === "running" || (j.state === "stalled" && j.alive === true) || j.ageS <= RECENT_S);
  return keep.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.ageS - b.ageS || compareCodePoints(a.job, b.job));
}

export type Paint = (format: "red" | "green" | "yellow" | "cyan" | "bold" | "dim", text: string) => string;
export const plain: Paint = (_f, t) => t;

const pct = (x: number | null, digits = 1): string => (x === null ? "n/a" : `${(x * 100).toFixed(digits)}%`);

export function fmtDuration(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "?";
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}m`;
}

export function bar(done: number, total: number | null, width = 24): string {
  const f = total === null || total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));
  const n = Math.round(f * width);
  return `[${"█".repeat(n)}${"░".repeat(width - n)}]`;
}

const shareText = (s: ShareStat): string => `${pct(s.share)} (${s.wins}/${s.n})`;
const intervalText = (s: ShareStat): string => (s.low === null || s.high === null ? "n/a" : `${pct(s.low)} to ${pct(s.high)}`);
const pairedText = (p: PairedStat, sides: { subject: string; other: string | null } | null): string =>
  `${sides?.subject ?? "subject"} won both seats in ${p.subjectBoth} pairs, ${sides?.other ?? "the other side"} in ${p.otherBoth}, of ${p.pairs} pairs; exact sign test p = ${p.pValue}`;

const BADGE: Record<JobState, [string, "green" | "yellow" | "red" | "dim"]> = {
  running: ["RUNNING", "green"],
  stalled: ["STALLED (no heartbeat for over 5 minutes)", "red"],
  dead: ["DEAD (process gone)", "red"],
  done: ["DONE", "dim"],
};

const MAX_ROWS = 10;

export function renderJob(v: JobView, paint: Paint = plain): string[] {
  const { hb, stats } = v;
  const [badge, colour] = BADGE[v.state];
  const out: string[] = [];
  out.push(`${paint("bold", v.job)}  [${v.source.label}${v.source.branch === null ? "" : ` ${v.source.branch}`}]  ${paint(colour, badge)}  heartbeat ${fmtDuration(v.ageS)} ago`);
  const unit = stats === null ? "" : stats.kind === "calibration" ? " steps, games then replay checks" : " games";
  const total = hb.total;
  const eta = v.state === "done" ? "" : `  ETA ${fmtDuration(hb.eta_s)}`;
  const speed = hb.games_per_s === undefined ? "" : `  ${hb.games_per_s.toFixed(2)}/s`;
  out.push(`  ${hb.done} of ${total ?? "?"}${unit}${hb.pct === null ? "" : ` (${hb.pct.toFixed(1)}%)`}  ${bar(hb.done, total)}${eta}${speed}  elapsed ${fmtDuration(hb.elapsed_s ?? null)}`);
  if (v.statsError !== null) out.push(`  ${paint("yellow", `live stats do not parse: ${v.statsError}`)}`);
  if (stats === null) {
    if (hb.phase !== undefined && hb.phase !== "done") out.push(`  phase: ${hb.phase}`);
    out.push(`  last progress ${fmtDuration(v.movedAgeS)} ago`);
    return out;
  }
  const g = stats.games;
  out.push(`  phase ${stats.phaseIndex}: ${stats.phase}  (${g.done} of ${g.total ?? "?"} games in this phase)`);
  if (stats.result !== null) out.push(`  ${paint("bold", `${stats.sides?.subject ?? "share"} ${shareText(stats.result)}`)} of decisive games, 95% interval ${intervalText(stats.result)}`);
  if (stats.paired !== null && stats.paired.pairs > 0) out.push(`  paired: ${pairedText(stats.paired, stats.sides)}`);
  const warn = g.errors > 0 ? "red" : g.timeouts + g.stuck > 0 ? "yellow" : "dim";
  out.push(
    `  health: ${g.decisive} decisive, ${g.draws} draws, ${g.timeouts} timeouts, ${g.stuck} stuck, ${paint(warn, `${g.errors} errors`)}; mean rounds ${stats.health.meanRounds ?? "n/a"}, mean decisions ${stats.health.meanDecisions ?? "n/a"}; fallback decisions ${pct(stats.health.fallbackShare)}`,
  );
  if (stats.health.errorSeeds.length > 0) out.push(`  ${paint("red", `error seeds: ${stats.health.errorSeeds.map((e) => `${e.seed} (${e.error})`).join("; ")}`)}`);
  if (stats.seat1 !== null) out.push(`  seat 1 won ${shareText(stats.seat1)} of decisive games (${stats.seat1.scope === "mirror" ? "mirror games only" : "all games"}), 95% interval ${intervalText(stats.seat1)}`);
  const groups = Object.entries(stats.groups);
  for (const [k, e] of groups.slice(0, MAX_ROWS)) out.push(`  ${k}: ${shareText(e.result)}${e.paired !== null && e.paired.pairs > 0 ? `, ${e.paired.subjectBoth} to ${e.paired.otherBoth} on ${e.paired.pairs} pairs, p = ${e.paired.pValue}` : ""}`);
  if (groups.length > MAX_ROWS) out.push(`  ... and ${groups.length - MAX_ROWS} more groups`);
  const rows = Object.entries(stats.rows);
  if (rows.length > 0) {
    out.push(`  rows: ${rows.slice(0, MAX_ROWS).map(([k, s]) => `${k} ${pct(s.share, 0)} (${s.wins}/${s.n})`).join("; ")}${rows.length > MAX_ROWS ? `; ... and ${rows.length - MAX_ROWS} more` : ""}`);
  }
  const counters = Object.entries(stats.counters);
  if (counters.length > 0) out.push(`  counters: ${counters.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (stats.completed.length > 0) {
    const last = stats.completed.slice(-3);
    out.push(`  finished phases (${stats.completed.length}): ${last.map((c) => `${c.phase}: ${c.games} games${c.result === null ? "" : `, ${shareText(c.result)}`}${c.paired !== null && c.paired.pairs > 0 ? `, p = ${c.paired.pValue}` : ""}`).join(" | ")}`);
  }
  const p = stats.provenance;
  const prov = [
    p.policies.length > 0 ? `policy ${p.policies.map((x) => `${x.name} (params ${x.paramsSha256.slice(0, 12)})`).join(", ")}` : null,
    p.seeds === null ? null : `seeds ${p.seeds.from} to ${p.seeds.to}`,
    p.enginePin === null ? null : `engine pin ${p.enginePin.slice(0, 9)}`,
    p.codeCommit === null ? null : `code ${p.codeCommit.includes("-dirty") ? `${p.codeCommit.slice(0, 7)} (uncommitted changes)` : p.codeCommit.slice(0, 12)}`,
    p.run === null ? null : `run ${p.run}`,
  ].filter((x): x is string => x !== null);
  out.push(`  provenance: ${prov.join("; ")}`);
  out.push(`  last progress ${fmtDuration(v.movedAgeS)} ago${stats.runTotals.games !== g.done ? `; ${stats.runTotals.games} games played in all phases` : ""}`);
  return out;
}

export function renderScreen(o: { jobs: readonly JobView[]; all: boolean; skipped: readonly { file: string; reason: string }[]; sources: readonly Source[]; nowMs: number; paint?: Paint }): string[] {
  const paint = o.paint ?? plain;
  const shown = selectVisible(o.jobs, o.all);
  const out: string[] = [];
  out.push(`${paint("bold", "sims:watch")}  ${new Date(o.nowMs).toISOString()}  ${shown.length} of ${o.jobs.length} jobs shown${o.all ? "" : " (live, plus anything finished or quiet in the last hour; --all shows every heartbeat)"}`);
  out.push(`sources: ${o.sources.map((s) => `${s.label}${s.branch === null ? "" : ` (${s.branch})`}`).join(", ")}   q or Ctrl-C quits`);
  out.push("");
  if (shown.length === 0) out.push("no live simulation jobs and none finished in the last hour");
  shown.forEach((j, i) => {
    if (i > 0) out.push("");
    out.push(...renderJob(j, paint));
  });
  if (o.skipped.length > 0) {
    out.push("");
    out.push(paint("yellow", `${o.skipped.length} heartbeat files could not be read: ${o.skipped.slice(0, 3).map((s) => `${path.basename(s.file)} (${s.reason})`).join("; ")}${o.skipped.length > 3 ? "; ..." : ""}`));
  }
  return out;
}
