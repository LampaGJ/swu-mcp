/**
 * @displayName Creator capture and mention-index schemas
 * @strategicPurpose Every foreign-data seam of the creator-meta spike (the creators config, YouTube's RSS feed, yt-dlp
 * info.json, the capture manifest, the mention index) parses through one of these Zod v4 schemas (D4), so a YouTube
 * rename or a yt-dlp change fails loudly instead of yielding an empty index that looks like a true zero.
 * @tacticalObjective Exports the schemas and their inferred types; no I/O.
 */
import { z } from "zod";

const channelId = z.string().regex(/^UC[\w-]{22}$/, { error: "YouTube channel ids are UC plus 22 URL-safe characters" });
const isoDate = z.iso.date();

/** data/creators.json entry. channelId, channelUrl and resolvedBy are all null together when a creator could not be resolved. */
export const creatorSchema = z
  .strictObject({
    name: z.string().min(1),
    channelId: channelId.nullable(),
    channelUrl: z.url().nullable(),
    resolvedBy: z.enum(["search", "feed", "manual"]).nullable(),
    /** Case-insensitive regex a video title must match to be captured; null keeps every video (for mixed-topic channels). */
    titleMatch: z
      .string()
      .refine(
        (source) => {
          try {
            new RegExp(source, "i");
            return true;
          } catch {
            return false;
          }
        },
        { error: "titleMatch must be a valid regular expression" },
      )
      .nullable(),
    note: z.string().min(1),
  })
  .refine((c) => (c.channelId === null) === (c.channelUrl === null) && (c.channelId === null) === (c.resolvedBy === null), {
    error: "channelId, channelUrl and resolvedBy are null together or set together",
  });
export const creatorsFileSchema = z.array(creatorSchema).min(1);
export type Creator = z.infer<typeof creatorSchema>;

/** Atom feed https://www.youtube.com/feeds/videos.xml?channel_id=<id>, reduced to the fields the capture reads. */
export const feedSchema = z.strictObject({
  /** The feed-level yt:channelId omits the UC prefix that channel URLs and entry-level ids carry. */
  feedChannelId: z.string().regex(/^[\w-]{22}$/),
  entries: z.array(
    z.strictObject({
      videoId: z.string().regex(/^[\w-]{11}$/),
      title: z.string(),
      published: z.iso.datetime({ offset: true }),
    }),
  ),
});
export type Feed = z.infer<typeof feedSchema>;

/** `yt-dlp -J --flat-playlist <channel>/videos`: only id and title are read; the rest is ignored. */
export const flatPlaylistSchema = z.looseObject({
  entries: z.array(z.looseObject({ id: z.string().regex(/^[\w-]{11}$/), title: z.string() })),
});

/** Fields the capture reads from <id>.info.json; yt-dlp writes hundreds more, which are ignored. */
export const infoJsonSchema = z.looseObject({
  id: z.string().regex(/^[\w-]{11}$/),
  title: z.string(),
  upload_date: z.string().regex(/^\d{8}$/),
  duration: z.number().nonnegative().nullable().optional(),
  channel_id: channelId,
  channel: z.string(),
  webpage_url: z.url(),
  subtitles: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type InfoJson = z.infer<typeof infoJsonSchema>;

const fileRef = z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const vttRef = fileRef.extend({ lang: z.string().min(1), kind: z.enum(["manual", "auto"]) });

export const manifestSchema = z.strictObject({
  capturedAt: z.iso.datetime(),
  sinceDays: z.number().int().positive(),
  perChannel: z.number().int().positive(),
  ytDlpVersion: z.string().min(1),
  abortedReason: z.string().nullable(),
  channels: z.array(
    z.strictObject({
      name: z.string(),
      channelId,
      feedUrl: z.url(),
      /** HTTP status of the RSS feed read; discovery falls back to yt-dlp's channel listing when it is not 200. */
      feedStatus: z.number().int(),
      discovery: z.enum(["rss", "yt-dlp-flat"]),
      titleMatch: z.string().nullable(),
      error: z.string().optional(),
      videos: z.array(
        z.strictObject({
          id: z.string(),
          title: z.string(),
          /** Null only when the video failed before yt-dlp wrote its info.json and the discovery path carries no date. */
          publishedAt: isoDate.nullable(),
          durationSec: z.number().nonnegative().nullable(),
          files: z.strictObject({
            infoJson: fileRef.nullable(),
            vtt: vttRef.nullable(),
            otherVtt: z.array(vttRef),
          }),
          error: z.string().optional(),
        }),
      ),
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

const quoteSchema = z.strictObject({
  channel: z.string(),
  videoTitle: z.string(),
  publishedAt: isoDate,
  timestampSec: z.number().int().nonnegative(),
  videoId: z.string(),
  text: z.string(),
});

export const mentionsSchema = z.strictObject({
  asOf: isoDate,
  halfLifeDays: z.number().positive(),
  source: z.strictObject({
    kind: z.literal("youtube-creator-transcripts"),
    population: z.string(),
    capturedAt: z.iso.datetime(),
    transcriptKinds: z.record(z.enum(["manual", "auto", "none"]), z.number().int()),
  }),
  videos: z.array(
    z.strictObject({
      videoId: z.string(),
      channel: z.string(),
      title: z.string(),
      publishedAt: isoDate,
      ageDays: z.number().int().nonnegative(),
      weight: z.number().positive(),
      cues: z.number().int().nonnegative(),
      leaderMentions: z.number().int().nonnegative(),
    }),
  ),
  excludedVideos: z.array(z.strictObject({ videoId: z.string(), reason: z.string() })),
  leaders: z.array(
    z.strictObject({
      title: z.string(),
      weightedMentions: z.number().nonnegative(),
      rawMentions: z.number().int().positive(),
      weightedVideos: z.number().nonnegative(),
      videos: z.number().int().positive(),
      channels: z.number().int().positive(),
      /** The title is also the title of a non-Leader card, so a mention may mean the unit rather than the leader. */
      sharedWithNonLeader: z.boolean(),
      leaders: z.array(
        z.strictObject({
          cardKey: z.string(),
          subtitle: z.string().nullable(),
          weightedMentions: z.number().nonnegative(),
          rawMentions: z.number().int().nonnegative(),
          /** Raw mentions where the whole subtitle followed the title, the strongest attribution. */
          subtitleMentions: z.number().int().nonnegative(),
        }),
      ),
      /** Title mentions where no subtitle word of a specific leader appeared in the cue window. */
      unattributed: z.strictObject({ weightedMentions: z.number().nonnegative(), rawMentions: z.number().int().nonnegative() }),
      quotes: z.array(quoteSchema).max(5),
    }),
  ),
});
export type Mentions = z.infer<typeof mentionsSchema>;

export const replaySchema = z.strictObject({
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  codeCommit: z.string().min(1),
  outputHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Replay = z.infer<typeof replaySchema>;
