import { decode } from "@toon-format/toon";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { buildMentions, type TranscriptVideo } from "./mentions.js";
import { manifestSchema, mentionsSchema, replaySchema, type Mentions, type Replay } from "./schema.js";
import { parseVtt } from "./vtt.js";

/** The slice of llm/cards.toon the index reads; every other column is ignored. */
const cardsSchema = z.object({
  cards: z.array(z.looseObject({ cardKey: z.string(), title: z.string(), subtitle: z.string().nullable(), type: z.string() })),
});

export interface RunIndexOptions {
  capturesDir: string;
  cardsPath: string;
  asOf: string;
  halfLifeDays: number;
  codeCommit: string;
}

export interface RunIndexResult {
  mentions: Mentions;
  mentionsBytes: string;
  replay: Replay;
}

function readVerified(root: string, ref: { path: string; sha256: string }): string {
  const bytes = readFileSync(path.join(root, ref.path));
  const actual = sha256Hex(bytes);
  if (actual !== ref.sha256) throw new Error(`${ref.path} hashes to ${actual}, the manifest pins ${ref.sha256}`);
  return bytes.toString("utf8");
}

/** Reads a pinned capture and a cards.toon, and returns the mention index with its replay record. Writes nothing. */
export function runIndex(options: RunIndexOptions): RunIndexResult {
  z.iso.date().parse(options.asOf);
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(options.capturesDir, "manifest.json"), "utf8")));
  const cardsBytes = readFileSync(options.cardsPath);
  const cards = cardsSchema.parse(decode(cardsBytes.toString("utf8"))).cards;

  const videos: TranscriptVideo[] = [];
  const excludedVideos: Array<{ videoId: string; reason: string }> = [];
  const kinds = { manual: 0, auto: 0, none: 0 };
  const files: Array<{ path: string; sha256: string }> = [];
  for (const channel of manifest.channels) {
    for (const video of channel.videos) {
      for (const ref of [video.files.infoJson, video.files.vtt, ...video.files.otherVtt])
        if (ref !== null) files.push({ path: ref.path, sha256: ref.sha256 });
      kinds[video.files.vtt?.kind ?? "none"] += 1;
      if (video.files.vtt === null || video.publishedAt === null) {
        excludedVideos.push({ videoId: video.id, reason: video.error ?? "no transcript" });
        continue;
      }
      videos.push({
        videoId: video.id,
        channel: channel.name,
        title: video.title,
        publishedAt: video.publishedAt,
        cues: parseVtt(readVerified(options.capturesDir, video.files.vtt)),
      });
    }
  }

  const leaders = cards.filter((c) => c.type === "Leader").map((c) => ({ cardKey: c.cardKey, title: c.title, subtitle: c.subtitle }));
  if (leaders.length === 0) throw new Error(`${options.cardsPath} holds no Leader cards; refusing to index against an empty set`);
  const nonLeaderTitles = cards.filter((c) => c.type !== "Leader").map((c) => c.title);

  const mentions = mentionsSchema.parse(
    buildMentions({
      videos,
      leaders,
      nonLeaderTitles,
      asOf: options.asOf,
      halfLifeDays: options.halfLifeDays,
      capturedAt: manifest.capturedAt,
      transcriptKinds: kinds,
      excludedVideos,
    }),
  );
  const mentionsBytes = `${JSON.stringify(mentions, null, 1)}\n`;
  const inputHash = sha256Hex(
    canonicalJson({
      files: files.sort((a, b) => compareCodePoints(a.path, b.path)),
      cardsSha256: sha256Hex(cardsBytes),
      asOf: options.asOf,
      halfLifeDays: options.halfLifeDays,
    }),
  );
  const replay = replaySchema.parse({ inputHash, codeCommit: options.codeCommit, outputHash: sha256Hex(mentionsBytes) });
  return { mentions, mentionsBytes, replay };
}
