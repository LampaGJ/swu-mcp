/**
 * @displayName YouTube creator transcript capture
 * @strategicPurpose The one network read behind the creator-meta spike: pins each SWU creator's recent video
 * transcripts (subtitles only, no media) as sha256-hashed originals so the mention index replays from the same bytes.
 * @tacticalObjective Reads each resolved channel's RSS feed (falls back to a yt-dlp channel listing when the feed is
 * not served), then runs yt-dlp per video for info.json + English VTT, and writes manifest.json (Zod-parsed) into the
 * git-ignored data/originals/youtube/<today>/. Refuses to overwrite a manifest.
 *
 * Usage: tsx scripts/creators/capture-transcripts.ts [--out <dir>] [--since-days 120] [--per-channel 10] [--creators data/creators.json]
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "../../src/paths.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";
import { parseFeedXml } from "./feed.js";
import {
  creatorsFileSchema,
  flatPlaylistSchema,
  infoJsonSchema,
  manifestSchema,
  type Creator,
  type InfoJson,
  type Manifest,
} from "./schema.js";

const exec = promisify(execFile);
const USER_AGENT = "swu-mcp-research/0.1 (creator-meta spike; subtitles only)";
const PAUSE_BETWEEN_VIDEOS_MS = 2000;
const FLAT_LIST_CAP = 60;
const MAX_CONSECUTIVE_THROTTLES = 3;

type ChannelOut = Manifest["channels"][number];
type VideoOut = ChannelOut["videos"][number];
type Entry = { id: string; title: string; published: string | null };

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const isoDay = (upload: string): string => `${upload.slice(0, 4)}-${upload.slice(4, 6)}-${upload.slice(6, 8)}`;

async function ytDlp(args: readonly string[]): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await exec("yt-dlp", ["--no-update", ...args], { maxBuffer: 256 * 1024 * 1024, timeout: 180_000 });
    return { stdout, stderr, failed: false };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? e.message, failed: true };
  }
}

async function discover(
  creator: Creator,
  channelId: string,
  feedUrl: string,
): Promise<{ status: number; discovery: "rss" | "yt-dlp-flat"; entries: Entry[] }> {
  const response = await fetch(feedUrl, { headers: { "user-agent": USER_AGENT } });
  if (response.status === 200) {
    const feed = parseFeedXml(await response.text());
    if (`UC${feed.feedChannelId}` !== channelId) throw new Error(`${feedUrl} answered for ${feed.feedChannelId}`);
    return {
      status: 200,
      discovery: "rss",
      entries: feed.entries.map((e) => ({ id: e.videoId, title: e.title, published: e.published.slice(0, 10) })),
    };
  }
  await response.arrayBuffer();
  const listing = await ytDlp([
    "-J",
    "--flat-playlist",
    "--playlist-end",
    String(FLAT_LIST_CAP),
    "--sleep-requests",
    "1",
    "--no-warnings",
    `${creator.channelUrl}/videos`,
  ]);
  if (listing.failed) throw new Error(`channel listing failed for ${creator.name}: ${listing.stderr.slice(0, 300)}`);
  const parsed = flatPlaylistSchema.parse(JSON.parse(listing.stdout));
  return {
    status: response.status,
    discovery: "yt-dlp-flat",
    entries: parsed.entries.map((e) => ({ id: e.id, title: e.title, published: null })),
  };
}

const langOf = (file: string, id: string): string => file.slice(id.length + 1, -".vtt".length);

/** Manual subtitles beat auto ones; among auto, the original-language track (en-orig) beats the translated-to-English one. */
function chooseVtt(
  info: InfoJson,
  files: readonly string[],
): { chosen: string | null; others: string[]; kinds: Map<string, "manual" | "auto"> } {
  const manual = new Set(Object.keys(info.subtitles ?? {}));
  const kinds = new Map<string, "manual" | "auto">(files.map((f) => [f, manual.has(langOf(f, info.id)) ? "manual" : "auto"]));
  const rank = (file: string): number =>
    kinds.get(file) === "manual" ? 0 : langOf(file, info.id) === "en-orig" ? 1 : langOf(file, info.id) === "en" ? 2 : 3;
  const sorted = [...files].sort((a, b) => rank(a) - rank(b) || compareCodePoints(a, b));
  return { chosen: sorted[0] ?? null, others: sorted.slice(1), kinds };
}

async function captureVideo(
  entry: Entry,
  chanDir: string,
  outDir: string,
  expectedChannelId: string,
): Promise<{ video: VideoOut; throttled: boolean }> {
  const run = await ytDlp([
    "--skip-download",
    "--write-auto-subs",
    "--write-subs",
    "--sub-langs",
    "en.*,en",
    "--sub-format",
    "vtt",
    "--write-info-json",
    "--sleep-requests",
    "1",
    "--sleep-subtitles",
    "5",
    "--ignore-errors",
    "-o",
    path.join(chanDir, "%(id)s.%(ext)s"),
    `https://www.youtube.com/watch?v=${entry.id}`,
  ]);
  const sawThrottle = /HTTP Error 429|Too Many Requests/i.test(run.stderr);
  const infoPath = path.join(chanDir, `${entry.id}.info.json`);
  const fail = (error: string): { video: VideoOut; throttled: boolean } => ({
    video: {
      id: entry.id,
      title: entry.title,
      publishedAt: entry.published,
      durationSec: null,
      files: { infoJson: null, vtt: null, otherVtt: [] },
      error,
    },
    throttled: sawThrottle,
  });
  if (!existsSync(infoPath)) return fail(`no info.json: ${run.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`);
  const parsed = infoJsonSchema.safeParse(JSON.parse(readFileSync(infoPath, "utf8")));
  if (!parsed.success) return fail(`info.json failed its schema: ${parsed.error.message.slice(0, 300)}`);
  const info = parsed.data;
  const vttFiles = readdirSync(chanDir).filter((f) => f.startsWith(`${entry.id}.`) && f.endsWith(".vtt"));
  const { chosen, others, kinds } = chooseVtt(info, vttFiles);
  const ref = (file: string) => {
    const full = path.join(chanDir, file);
    return {
      path: path.relative(outDir, full),
      sha256: sha256File(full),
      lang: langOf(file, entry.id),
      kind: kinds.get(file) ?? ("auto" as const),
    };
  };
  const problems: string[] = [];
  if (info.channel_id !== expectedChannelId) problems.push(`info.json channel_id ${info.channel_id} differs from ${expectedChannelId}`);
  // A 429 on a secondary track is harmless; only a video left without any transcript counts as throttled.
  const throttled = sawThrottle && chosen === null;
  if (chosen === null)
    problems.push(throttled ? "no English subtitles: subtitle request throttled (429)" : "no English subtitles available");
  return {
    video: {
      id: info.id,
      title: info.title,
      publishedAt: isoDay(info.upload_date),
      durationSec: info.duration ?? null,
      files: {
        infoJson: { path: path.relative(outDir, infoPath), sha256: sha256File(infoPath) },
        vtt: chosen === null ? null : ref(chosen),
        otherVtt: others.map(ref),
      },
      ...(problems.length > 0 ? { error: problems.join("; ") } : {}),
    },
    throttled,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { out: { type: "string" }, "since-days": { type: "string" }, "per-channel": { type: "string" }, creators: { type: "string" } },
  });
  const capturedAt = new Date().toISOString();
  const sinceDays = z.coerce
    .number()
    .int()
    .positive()
    .parse(values["since-days"] ?? "120");
  const perChannel = z.coerce
    .number()
    .int()
    .positive()
    .parse(values["per-channel"] ?? "10");
  const creatorsPath = path.resolve(values.creators ?? path.join(REPO_ROOT, "data/creators.json"));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/youtube", capturedAt.slice(0, 10)));
  const manifestPath = path.join(outDir, "manifest.json");
  if (existsSync(manifestPath)) throw new Error(`${manifestPath} exists; a capture is pinned once and never overwritten`);

  const creators = creatorsFileSchema.parse(JSON.parse(readFileSync(creatorsPath, "utf8")));
  const resolved = creators.filter((c) => c.channelId !== null);
  const cutoff = new Date(Date.parse(capturedAt) - sinceDays * 86_400_000).toISOString().slice(0, 10);
  const version = (await ytDlp(["--version"])).stdout.trim();
  mkdirSync(outDir, { recursive: true });

  const p = progress("creators-capture", { total: resolved.length * perChannel, everyMs: 5000 });
  let done = 0;
  let abortedReason: string | null = null;
  let consecutiveThrottles = 0;
  const channels: ChannelOut[] = [];

  for (const creator of resolved) {
    if (abortedReason !== null) break;
    const channelId = creator.channelId as string;
    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    let found: Awaited<ReturnType<typeof discover>>;
    try {
      found = await discover(creator, channelId, feedUrl);
    } catch (error) {
      channels.push({
        name: creator.name,
        channelId,
        feedUrl,
        feedStatus: 0,
        discovery: "yt-dlp-flat",
        titleMatch: creator.titleMatch,
        error: (error as Error).message.slice(0, 400),
        videos: [],
      });
      continue;
    }
    const titleRe = creator.titleMatch === null ? null : new RegExp(creator.titleMatch, "i");
    const chanDir = path.join(outDir, slug(creator.name));
    mkdirSync(chanDir, { recursive: true });
    const videos: VideoOut[] = [];

    for (const entry of found.entries) {
      if (videos.length >= perChannel) break;
      if (titleRe !== null && !titleRe.test(entry.title)) continue;
      if (entry.published !== null && entry.published < cutoff) continue;
      const result = await captureVideo(entry, chanDir, outDir, channelId);
      done += 1;
      p.tick(done, { channel: creator.name, videoId: entry.id });
      consecutiveThrottles = result.throttled ? consecutiveThrottles + 1 : 0;
      if (result.video.files.infoJson !== null && result.video.publishedAt !== null && result.video.publishedAt < cutoff) {
        // The channel listing is newest-first and carries no dates, so the first video past the window ends the channel.
        for (const f of readdirSync(chanDir).filter((n) => n.startsWith(`${entry.id}.`))) rmSync(path.join(chanDir, f));
        break;
      }
      videos.push(result.video);
      if (consecutiveThrottles >= MAX_CONSECUTIVE_THROTTLES) {
        abortedReason = `${MAX_CONSECUTIVE_THROTTLES} consecutive HTTP 429 responses; stopped at ${creator.name} / ${entry.id}`;
        break;
      }
      await sleep(PAUSE_BETWEEN_VIDEOS_MS);
    }
    channels.push({
      name: creator.name,
      channelId,
      feedUrl,
      feedStatus: found.status,
      discovery: found.discovery,
      titleMatch: creator.titleMatch,
      videos,
    });
  }

  const manifest = manifestSchema.parse({ capturedAt, sinceDays, perChannel, ytDlpVersion: version, abortedReason, channels });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  p.done({ videos: done, abortedReason });
  console.log(
    JSON.stringify(
      {
        outDir,
        channels: manifest.channels.map((c) => ({ name: c.name, discovery: c.discovery, videos: c.videos.length })),
        abortedReason,
      },
      null,
      1,
    ),
  );
}

await main();
