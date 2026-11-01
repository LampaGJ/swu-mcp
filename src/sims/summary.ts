import path from "node:path";
import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import type { LiveStatsPayload } from "./live-stats.js";
import { RECENT_S, selectVisible, type JobState, type JobView } from "./watch.js";

/**
 * @displayName Simulation summary for widgets
 * @strategicPurpose Condenses every running or just-finished simulation job into one small, versioned document that a
 * schickso in-pull plugin and a TerminalWidget provider read, without either reaching into heartbeat files or into this
 * repo's types (#179 of #104, D100). The contract is fixed for schemaVersion 1; a change is a new version.
 * @tacticalObjective Pure over the JobView list that src/sims/watch.ts discovers and classifies (the clock and the repo
 * name are arguments): picks the visible jobs, orders them, caps them at 8, derives kind, phase, result, health, verdict
 * and a one-line headline, and parses the result with simsSummarySchema (Zod v4 strict, the emitter gate) before it
 * returns. Also renders the --text form (at most 5 lines of 60 characters) and exports the JSON Schema consumers in other
 * repos validate against (docs/schemas/sims-summary.v1.schema.json, written by scripts/sims/export-summary-schema.ts).
 * The CLI is scripts/sims/summary.ts.
 */

export const SUMMARY_SCHEMA_VERSION = 1;
export const MAX_JOBS = 8;
export const MAX_HEADLINE = 72;
export const MAX_PHASE = 80;
export const MAX_TEXT_LINES = 5;
export const MAX_TEXT_WIDTH = 60;

export const SUMMARY_KINDS = ["ladder", "field", "h2h", "tune", "cost", "calibration", "branches", "matchup", "other"] as const;
export type SummaryKind = (typeof SUMMARY_KINDS)[number];

// No absolute path, drive path or machine hostname may leave this module (the widgets show the text on screen).
const ABS_PATH = String.raw`(?:[A-Za-z]:\\|/(?:Users|Volumes|private|home|var|tmp|opt|etc|mnt|srv|root)/)\S*`;
const HOST = String.raw`\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|internal|localdomain|home\.arpa|ts\.net)\b`;
const LEAK = new RegExp(`${ABS_PATH}|${HOST}`, "i");
const scrub = (s: string): string =>
  s.replace(new RegExp(ABS_PATH, "gi"), (m) => m.split(/[\\/]/).filter((x) => x !== "").pop() ?? "path").replace(new RegExp(HOST, "gi"), "host");

const text = (max: number) => z.string().max(max).refine((s) => !LEAK.test(s), { error: "absolute path or hostname" });
const count = z.int().nonnegative();

const resultSchema = z.strictObject({
  subject: text(40).describe("Whose share this is (the policy or deck whose win share is measured)."),
  share: z.number().min(0).max(1).describe("Subject's share of decisive games so far."),
  low: z.number().min(0).max(1).describe("Lower end of the Wilson 95% interval."),
  high: z.number().min(0).max(1).describe("Upper end of the Wilson 95% interval."),
  p: z.number().min(0).max(1).nullable().describe("Running exact two-sided sign test on duplicate pairs; a progress reading, not a verdict. Null without pairs."),
  n: count.describe("Decisive games the share rests on."),
});

export const simsSummarySchema = z
  .strictObject({
    schemaVersion: z.literal(SUMMARY_SCHEMA_VERSION),
    generatedAt: z.iso.datetime().describe("When this summary was computed (UTC)."),
    repo: text(80).refine((s) => s !== "" && !/[\\/]/.test(s), { error: "basename only" }).describe("Repository directory name, never a path."),
    totals: z
      .strictObject({
        running: count,
        stalled: count,
        dead: count,
        doneLastHour: count,
      })
      .describe("Counts over every visible job, before the cap on jobs."),
    jobs: z
      .array(
        z.strictObject({
          id: text(120).describe("Job name (the heartbeat's job field)."),
          worktree: text(80).describe('Checkout the heartbeat lives in; "main" for the main checkout.'),
          kind: z.enum(SUMMARY_KINDS),
          state: z.enum(["running", "stalled", "dead", "done"]),
          phase: text(MAX_PHASE).describe('The phase running now; "done" when finished.'),
          done: z.number().nonnegative(),
          total: z.number().nonnegative().nullable(),
          pct: z.number().nullable(),
          etaS: z.number().nonnegative().nullable().describe("Null when finished or unknown."),
          gamesPerS: z.number().nonnegative().nullable(),
          updatedAgeS: count.describe("Seconds since the heartbeat file was last written."),
          result: resultSchema.nullable(),
          health: z.strictObject({ errors: count, draws: count, timeouts: count }).describe("Whole-run totals; all zero when the heartbeat carries no stats."),
          verdict: z
            .strictObject({ pass: z.boolean(), failedGates: z.array(text(40)).max(10) })
            .nullable()
            .describe("Only for finished calibration and ladder jobs whose heartbeat carries pass."),
          headline: text(MAX_HEADLINE).describe("One line for a widget."),
        }),
      )
      .max(MAX_JOBS)
      .describe("Stalled, dead and running jobs first (in that order), then finished jobs from the last hour, newest first."),
  })
  .meta({ title: "swu-mcp sims summary, schemaVersion 1", description: "Condensed state of the simulation jobs in a swu-mcp checkout and its linked worktrees (pnpm sims:summary --json)." });

export type SimsSummary = z.infer<typeof simsSummarySchema>;
export type SummaryJob = SimsSummary["jobs"][number];

/** The JSON Schema consumers in other repos validate against; docs/schemas/sims-summary.v1.schema.json is this, serialised. */
export const simsSummaryJsonSchema = (): Record<string, unknown> => z.toJSONSchema(simsSummarySchema, { target: "draft-2020-12" }) as Record<string, unknown>;

const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 3))}...`);

function fmtShort(s: number): string {
  const t = Math.round(s);
  if (t < 60) return `${t}s`;
  if (t < 3600) return `${Math.floor(t / 60)}m`;
  return `${Math.floor(t / 3600)}h${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}`;
}

const fmtP = (p: number): string => (p < 0.01 ? "<.01" : p >= 0.995 ? "1.00" : p.toFixed(2).slice(1));
const fmtPct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

const NAME_KINDS: [RegExp, SummaryKind][] = [
  [/^sims-calibration-/, "calibration"],
  [/^(?:sample-)?branch/, "branches"],
  [/^matchup-/, "matchup"],
];

/** The writer's own kind when the heartbeat carries stats; a heartbeat from before #178 has none, so its name decides. */
export function kindOf(job: string, stats: LiveStatsPayload | null): SummaryKind {
  if (stats !== null) return stats.kind === "grid" ? "other" : stats.kind;
  const ladder = /^sims-ladder-(ladder|field|h2h|tune|cost)-/.exec(job);
  if (ladder !== null) return ladder[1] as SummaryKind;
  return NAME_KINDS.find(([re]) => re.test(job))?.[1] ?? "other";
}

const verdictShape = z.looseObject({ pass: z.boolean(), failedGates: z.array(z.string()).optional() });

function verdictOf(v: JobView, kind: SummaryKind): SummaryJob["verdict"] {
  if (v.state !== "done" || (kind !== "calibration" && kind !== "ladder")) return null;
  const r = verdictShape.safeParse(v.hb);
  return r.success ? { pass: r.data.pass, failedGates: (r.data.failedGates ?? []).map((g) => truncate(scrub(g), 40)).slice(0, 10) } : null;
}

function resultOf(v: JobView): { result: SummaryJob["result"]; sides: string | null } {
  const stats = v.stats;
  if (stats === null) return { result: null, sides: null };
  let share = stats.result;
  let paired = stats.paired;
  let sides = stats.sides;
  if (share === null && v.state === "done") {
    const last = [...stats.completed].reverse().find((c) => c.result !== null);
    if (last !== undefined) ({ result: share, paired, sides } = last);
  }
  const sidesText = sides === null ? null : sides.other === null ? sides.subject : `${sides.subject} vs ${sides.other}`;
  if (share === null || share.share === null || share.low === null || share.high === null) return { result: null, sides: sidesText };
  return {
    result: { subject: truncate(scrub(sides?.subject ?? "subject"), 40), share: share.share, low: share.low, high: share.high, p: paired !== null && paired.pairs > 0 ? paired.pValue : null, n: share.n },
    sides: sidesText,
  };
}

const FLAG: Partial<Record<JobState, string>> = { stalled: "STALLED", dead: "DEAD" };

/** "sims-ladder-h2h-warrior-h2h-rung3v" with kind h2h is "warrior-h2h-rung3v": the name without what the line already says. */
function shortId(id: string, kind: SummaryKind): string {
  const s = id.replace(/^sims-/, "").replace(/^(?:ladder|calibration)-/, "");
  return s.startsWith(`${kind}-`) ? s.slice(kind.length + 1) : s;
}

/** One line for a widget. `sides` (full headline only) names the contenders; without it the shortened job name does. */
function composeLine(j: Omit<SummaryJob, "headline">, max: number, full: boolean, sides: string | null): string {
  const tail: string[] = [];
  const total = j.total === null ? "" : `/${j.total}`;
  if (j.state === "done") {
    if (full) tail.push(`done ${j.done}${total}`);
    else tail.push("done");
    if (j.verdict !== null) tail.push(j.verdict.pass ? "PASS" : full && j.verdict.failedGates.length > 0 ? `FAIL ${j.verdict.failedGates.join(",")}` : "FAIL");
  } else {
    if (j.pct !== null) tail.push(`${Math.round(j.pct)}%`);
    if (full) tail.push(`${j.done}${total}`);
    if (j.state === "running" && j.etaS !== null) tail.push(`ETA ${fmtShort(j.etaS)}`);
    if (j.state !== "running") tail.push(`quiet ${fmtShort(j.updatedAgeS)}`);
  }
  if (j.result !== null) tail.push(`${j.result.subject} ${full ? fmtPct1(j.result.share) : `${(j.result.share * 100).toFixed(0)}%`}${full ? ` [${(j.result.low * 100).toFixed(1)},${(j.result.high * 100).toFixed(1)}]` : ""}${j.result.p === null ? "" : ` p ${fmtP(j.result.p)}`}`);
  const head = [FLAG[j.state], j.kind].filter((x): x is string => x !== undefined).join(" ");
  const fixed = [head, ...tail].join(" ");
  const room = max - fixed.length - 1;
  const lead = truncate(sides !== null && full ? sides : shortId(j.id, j.kind), room);
  return truncate(room >= 6 && lead !== "" ? [head, lead, ...tail].join(" ") : fixed, max);
}

const ORDER: Record<JobState, number> = { stalled: 0, dead: 1, running: 2, done: 3 };

export function summarize(o: { jobs: readonly JobView[]; repo: string; nowMs: number }): SimsSummary {
  const visible = selectVisible(o.jobs, false).sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.ageS - b.ageS || compareCodePoints(a.job, b.job));
  const totals = {
    running: visible.filter((v) => v.state === "running").length,
    stalled: visible.filter((v) => v.state === "stalled").length,
    dead: visible.filter((v) => v.state === "dead").length,
    doneLastHour: visible.filter((v) => v.state === "done" && v.ageS <= RECENT_S).length,
  };
  const jobs = visible
    .filter((v) => v.state !== "done" || v.ageS <= RECENT_S)
    .slice(0, MAX_JOBS)
    .map((v): SummaryJob => {
      const kind = kindOf(v.job, v.stats);
      const { result, sides } = resultOf(v);
      const base: Omit<SummaryJob, "headline"> = {
        id: truncate(scrub(v.job), 120),
        worktree: truncate(v.source.main === true ? "main" : scrub(path.basename(v.source.root)), 80),
        kind,
        state: v.state,
        phase: truncate(scrub(v.state === "done" ? "done" : (v.stats?.phase ?? v.hb.phase ?? "starting")), MAX_PHASE),
        done: v.hb.done,
        total: v.hb.total,
        pct: v.hb.pct,
        etaS: v.state === "done" ? null : v.hb.eta_s,
        gamesPerS: v.hb.games_per_s ?? null,
        updatedAgeS: v.ageS,
        result,
        health: v.stats === null ? { errors: 0, draws: 0, timeouts: 0 } : { errors: v.stats.runTotals.errors, draws: v.stats.runTotals.draws, timeouts: v.stats.runTotals.timeouts },
        verdict: verdictOf(v, kind),
      };
      return { ...base, headline: composeLine(base, MAX_HEADLINE, true, sides === null ? null : scrub(sides)) };
    });
  return simsSummarySchema.parse({ schemaVersion: SUMMARY_SCHEMA_VERSION, generatedAt: new Date(o.nowMs).toISOString(), repo: scrub(path.basename(o.repo)), totals, jobs });
}

/** At most 5 lines of 60 characters: totals, then one line per job, most urgent first (3 jobs and "+n more" when there are over 4). */
export function renderSummaryText(s: SimsSummary): string[] {
  const { running, stalled, dead, doneLastHour } = s.totals;
  const head = `SWU sims ${running} running, ${stalled} ${stalled > 0 ? "STALLED" : "stalled"}${dead > 0 ? `, ${dead} DEAD` : ""}, ${doneLastHour} done/1h`;
  const room = MAX_TEXT_LINES - 1;
  const shown = s.jobs.length > room ? s.jobs.slice(0, room - 1) : s.jobs;
  const lines = [head, ...shown.map((j) => composeLine(j, MAX_TEXT_WIDTH, false, null))];
  if (s.jobs.length > shown.length) lines.push(`+${s.jobs.length - shown.length} more jobs`);
  return lines.map((l) => truncate(l, MAX_TEXT_WIDTH));
}
