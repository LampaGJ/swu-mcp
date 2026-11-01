/**
 * @displayName Tournament decklist capture
 * @strategicPurpose The one network read behind the sleeper-card analysis (LampaGJ/swu-mcp#184): every melee.gg
 * Premier decklist swumetastats.com tracks, with its event, placement and whole-event match record, captured once
 * and pinned by sha256 so the analysis replays from the same bytes. The 2026-10-17 deck snapshot was fetched by a
 * script that was never committed; this is its committed, resumable successor.
 * @tacticalObjective Pages /api/tournaments over a window, then /api/decklists?tournamentId=<id> for every event that
 * lists decklists, 100 rows a page, at least 1.1 s between requests, and writes each body unmodified under
 * data/originals/decklists/<to>/raw/ with an HTTP log line, then manifest.json (window, pacing, per-window counts,
 * sha256 of every raw file). A raw page already on disk is re-hashed and reused, so an interrupted run resumes;
 * a finished manifest is never overwritten. Player names stay in these git-ignored raw pages only.
 *
 * Usage: pnpm meta:capture-decklists --to <YYYY-MM-DD> [--from <YYYY-MM-DD>] [--out <dir>] [--min-interval-ms <n>]
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  boundariesSchema,
  decklistManifestSchema,
  decklistPageSchema,
  tournamentPageSchema,
  type DecklistManifest,
  type TournamentRow,
} from "../../src/meta/decklist-capture.js";
import { REPO_ROOT } from "../../src/paths.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";

const API = "https://swumetastats.com/api";
const USER_AGENT = "swu-mcp-research/0.1 (sleeper-cards analysis; tournament decklists)";
const PAGE = 100;
const MAX_ATTEMPTS = 4;

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class Fetcher {
  private last = 0;
  requests = 0;
  reused = 0;
  firstAt: string | null = null;
  lastAt: string | null = null;
  failures: DecklistManifest["fetch"]["failures"] = [];
  readonly files: Record<string, string> = {};
  constructor(
    private readonly rawDir: string,
    private readonly minIntervalMs: number,
  ) {}

  /** The body of url, from rawDir/<file> when already captured, else fetched politely and written there. */
  async get(url: string, file: string): Promise<Buffer | null> {
    const target = path.join(this.rawDir, file);
    if (existsSync(target)) {
      const body = readFileSync(target);
      this.files[file] = sha256(body);
      this.reused += 1;
      return body;
    }
    let status = 0;
    let note = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const wait = this.last + this.minIntervalMs * attempt - performance.now();
      if (wait > 0) await pause(wait);
      this.last = performance.now();
      this.requests += 1;
      status = 0;
      note = "";
      try {
        const response = await fetch(url, {
          headers: { "user-agent": USER_AGENT, accept: "application/json" },
          signal: AbortSignal.timeout(60_000),
        });
        status = response.status;
        if (response.ok) {
          const body = Buffer.from(await response.arrayBuffer());
          const at = new Date().toISOString();
          this.firstAt ??= at;
          this.lastAt = at;
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, body);
          const hash = sha256(body);
          this.files[file] = hash;
          appendFileSync(
            path.join(this.rawDir, "_http-log.jsonl"),
            `${JSON.stringify({ url, status, bytes: body.length, sha256: hash, file, fetchedAt: at, contentType: response.headers.get("content-type") })}\n`,
          );
          return body;
        }
        note = response.statusText;
        // A refusal that is not rate limiting or a server fault will not change on retry.
        if (status !== 429 && status < 500) break;
      } catch (error) {
        note = error instanceof Error ? error.message : String(error);
      }
    }
    this.failures.push({ url, status, note });
    return null;
  }
}

function periodOf(day: string, boundaries: z.infer<typeof boundariesSchema>): string {
  const hit = boundaries.find((b) => compareCodePoints(day, b.start) >= 0 && (b.end === null || compareCodePoints(day, b.end) <= 0));
  return hit?.label ?? "outside known periods";
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { from: { type: "string" }, to: { type: "string" }, out: { type: "string" }, "min-interval-ms": { type: "string" } },
  });
  const to = z.iso.date().parse(values.to);
  const from = z.iso.date().parse(values.from ?? "2024-03-01");
  const minIntervalMs = z.coerce
    .number()
    .int()
    .min(1000)
    .parse(values["min-interval-ms"] ?? "1100");
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/decklists", to));
  const manifestFile = path.join(outDir, "manifest.json");
  if (existsSync(manifestFile)) throw new Error(`${manifestFile} exists; a capture is pinned once and never overwritten`);
  const rawDir = path.join(outDir, "raw");
  mkdirSync(rawDir, { recursive: true });
  const f = new Fetcher(rawDir, minIntervalMs);
  const p = progress("capture-decklists", { total: null, everyN: 1 });

  const boundaryBody = await f.get(`${API}/meta-boundaries?format=Premier`, "meta-boundaries.json");
  const boundaries = boundaryBody === null ? [] : boundariesSchema.parse(JSON.parse(boundaryBody.toString("utf8")));

  const tournaments: TournamentRow[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const url = `${API}/tournaments?format=Premier&startDate=${from}&endDate=${to}&skip=${skip}&take=${PAGE}`;
    const body = await f.get(url, `tournaments/skip${String(skip).padStart(5, "0")}.json`);
    if (body === null) break;
    const page = tournamentPageSchema.parse(JSON.parse(body.toString("utf8")));
    tournaments.push(...page.tournaments);
    p.log({ phase: "tournaments", listed: tournaments.length, of: page.totalCount });
    if (page.tournaments.length < PAGE || tournaments.length >= page.totalCount) break;
  }
  const withDecks = tournaments.filter((t) => t._count.decklists > 0).sort((a, b) => a.id - b.id);
  const listed = withDecks.reduce((n, t) => n + t._count.decklists, 0);
  const pg = progress("capture-decklists", { total: listed, everyN: 1, keepAliveMs: 30_000 });

  const guids = new Set<string>();
  const byMonth: Record<string, number> = {};
  const byMetaPeriod: Record<string, number> = {};
  const shortEvents: DecklistManifest["counts"]["shortEvents"] = [];
  let done = 0;
  for (const t of withDecks) {
    let captured = 0;
    for (let skip = 0; skip < t._count.decklists; skip += PAGE) {
      const url = `${API}/decklists?format=Premier&tournamentId=${t.id}&skip=${skip}&take=${PAGE}`;
      const body = await f.get(url, `decklists/t${t.id}-skip${String(skip).padStart(5, "0")}.json`);
      if (body === null) break;
      const page = decklistPageSchema.parse(JSON.parse(body.toString("utf8")));
      for (const d of page.decklists) {
        if (guids.has(d.guid)) continue;
        guids.add(d.guid);
        captured += 1;
      }
      if (page.decklists.length < PAGE) break;
    }
    const day = t.startDate.slice(0, 10);
    byMonth[day.slice(0, 7)] = (byMonth[day.slice(0, 7)] ?? 0) + captured;
    const period = periodOf(day, boundaries);
    byMetaPeriod[period] = (byMetaPeriod[period] ?? 0) + captured;
    if (captured !== t._count.decklists) shortEvents.push({ tournamentId: t.id, listed: t._count.decklists, captured });
    done += t._count.decklists;
    pg.tick(done, {
      events: withDecks.indexOf(t) + 1,
      of: withDecks.length,
      captured: guids.size,
      requests: f.requests,
      reused: f.reused,
      failures: f.failures.length,
    });
  }

  const sortKeys = (r: Record<string, number>): Record<string, number> =>
    Object.fromEntries(Object.entries(r).sort((a, b) => compareCodePoints(a[0], b[0])));
  const manifest = decklistManifestSchema.parse({
    kind: "swumetastats-decklists",
    snapshot: to,
    window: { from, to },
    userAgent: USER_AGENT,
    fetch: { firstAt: f.firstAt, lastAt: f.lastAt, requests: f.requests, reused: f.reused, minIntervalMs, failures: f.failures },
    population: "tournament (melee.gg Premier events tracked by swumetastats.com)",
    counts: {
      tournaments: tournaments.length,
      tournamentsWithDecklists: withDecks.length,
      decklistsListed: listed,
      decklistsCaptured: guids.size,
      byMonth: sortKeys(byMonth),
      byMetaPeriod: sortKeys(byMetaPeriod),
      shortEvents,
    },
    files: Object.fromEntries(Object.entries(f.files).sort((a, b) => compareCodePoints(a[0], b[0]))),
  });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 1)}\n`);
  pg.done({ captured: guids.size, listed, requests: f.requests, failures: f.failures.length });
  console.log(JSON.stringify({ ...manifest, files: Object.keys(manifest.files).length }, null, 1));
}

await main();
