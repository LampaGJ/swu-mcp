/**
 * @displayName Creator leader-mention index
 * @strategicPurpose Answers "which leaders are the top SWU creators talking about, weighted toward what they said
 * lately" from pinned transcripts, with the quotes to back each number (D26: every suggestion shows its evidence and
 * its data source). A creator-attention signal, not a win rate (D21).
 * @tacticalObjective Pure function from parsed transcripts, Leader rows, an as-of date and a half-life to a Mentions
 * object. No clock, no randomness, no locale-sensitive sort: the same inputs give the same bytes (D2).
 */
import { compareCodePoints } from "../../src/swu/canonical.js";
import type { Mentions } from "./schema.js";
import type { Cue } from "./vtt.js";

export interface LeaderRow {
  cardKey: string;
  title: string;
  subtitle: string | null;
}

export interface TranscriptVideo {
  videoId: string;
  channel: string;
  title: string;
  publishedAt: string;
  cues: Cue[];
}

export interface BuildInput {
  videos: readonly TranscriptVideo[];
  leaders: readonly LeaderRow[];
  /** Titles of every non-Leader card, to flag leader titles that are also unit titles. */
  nonLeaderTitles: readonly string[];
  asOf: string;
  halfLifeDays: number;
  capturedAt: string;
  transcriptKinds: Record<"manual" | "auto" | "none", number>;
  excludedVideos: ReadonlyArray<{ videoId: string; reason: string }>;
}

const SUBTITLE_STOPWORDS = new Set([
  "the",
  "of",
  "a",
  "an",
  "and",
  "in",
  "on",
  "to",
  "for",
  "with",
  "from",
  "is",
  "it",
  "my",
  "no",
  "not",
  "all",
  "you",
  "your",
]);
const WINDOW_CUES = 1;
const QUOTE_CUES = 2;
const MAX_QUOTES = 5;
const MS_PER_DAY = 86_400_000;

/** Lowercase, strip diacritics, drop possessive 's and apostrophes, turn every other non-alphanumeric run into one space. */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['‘’`]s\b/g, "")
    .replace(/['‘’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const tokenize = (text: string): string[] => {
  const normal = normalizeText(text);
  return normal === "" ? [] : normal.split(" ");
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export const ageInDays = (asOf: string, publishedAt: string): number =>
  Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${publishedAt}T00:00:00Z`)) / MS_PER_DAY);

interface SpecificLeader {
  cardKey: string;
  subtitle: string | null;
  subTokens: string[];
  distinctive: Set<string>;
}

interface TitleGroup {
  title: string;
  tokens: string[];
  leaders: SpecificLeader[];
  sharedWithNonLeader: boolean;
}

function groupLeaders(leaders: readonly LeaderRow[], nonLeaderTitles: readonly string[]): TitleGroup[] {
  const nonLeader = new Set(nonLeaderTitles.map(normalizeText));
  const byNormal = new Map<string, LeaderRow[]>();
  for (const leader of leaders) {
    const key = normalizeText(leader.title);
    byNormal.set(key, [...(byNormal.get(key) ?? []), leader]);
  }
  const groups: TitleGroup[] = [];
  for (const [normal, rows] of [...byNormal.entries()].sort((a, b) => compareCodePoints(a[0], b[0]))) {
    const titleTokens = new Set(normal.split(" "));
    const sorted = [...rows].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
    const subTokenLists = sorted.map((row) => (row.subtitle === null ? [] : tokenize(row.subtitle)));
    const specific = sorted.map((row, i) => {
      const others = new Set(subTokenLists.filter((_, j) => j !== i).flat());
      const distinctive = new Set(
        subTokenLists[i].filter((t) => t.length > 3 && !SUBTITLE_STOPWORDS.has(t) && !titleTokens.has(t) && !others.has(t)),
      );
      return { cardKey: row.cardKey, subtitle: row.subtitle, subTokens: subTokenLists[i], distinctive };
    });
    groups.push({ title: sorted[0].title, tokens: normal.split(" "), leaders: specific, sharedWithNonLeader: nonLeader.has(normal) });
  }
  return groups;
}

interface Mention {
  group: TitleGroup;
  cue: number;
  attributedTo: SpecificLeader | null;
  viaSubtitle: boolean;
}

function findMentions(video: TranscriptVideo, groups: readonly TitleGroup[], byFirstToken: Map<string, TitleGroup[]>): Mention[] {
  const tokens: string[] = [];
  const cueOf: number[] = [];
  video.cues.forEach((cue, index) => {
    for (const token of tokenize(cue.text)) {
      tokens.push(token);
      cueOf.push(index);
    }
  });

  const found: Array<{ start: number; end: number; group: TitleGroup }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    for (const group of byFirstToken.get(tokens[i]) ?? []) {
      if (group.tokens.every((t, k) => tokens[i + k] === t)) found.push({ start: i, end: i + group.tokens.length, group });
    }
  }
  // "Grand Admiral Thrawn" also contains "Thrawn": a match strictly inside a longer match is not a second mention.
  const kept = found.filter(
    (m) => !found.some((o) => o !== m && o.start <= m.start && o.end >= m.end && o.end - o.start > m.end - m.start),
  );

  return kept.map(({ start, end, group }) => {
    const cue = cueOf[start];
    if (group.leaders.length === 1) return { group, cue, attributedTo: group.leaders[0], viaSubtitle: false };
    const window = new Set<string>();
    for (let k = 0; k < tokens.length; k += 1) if (Math.abs(cueOf[k] - cue) <= WINDOW_CUES) window.add(tokens[k]);
    const strong = group.leaders.filter((l) => l.subTokens.length > 0 && l.subTokens.every((t, k) => tokens[end + k] === t));
    if (strong.length === 1) return { group, cue, attributedTo: strong[0], viaSubtitle: true };
    const weak = group.leaders.filter((l) => [...l.distinctive].some((t) => window.has(t)));
    return { group, cue, attributedTo: weak.length === 1 ? weak[0] : null, viaSubtitle: false };
  });
}

interface Quote {
  channel: string;
  videoTitle: string;
  publishedAt: string;
  timestampSec: number;
  videoId: string;
  text: string;
  weight: number;
}

interface Acc {
  weighted: number;
  raw: number;
  weightedVideos: number;
  videos: Set<string>;
  channels: Set<string>;
  specific: Map<string, { weighted: number; raw: number; subtitle: number }>;
  unattributed: { weighted: number; raw: number };
  quotes: Quote[];
}

export function buildMentions(input: BuildInput): Mentions {
  const groups = groupLeaders(input.leaders, input.nonLeaderTitles);
  const byFirstToken = new Map<string, TitleGroup[]>();
  for (const group of groups) byFirstToken.set(group.tokens[0], [...(byFirstToken.get(group.tokens[0]) ?? []), group]);

  const acc = new Map<string, Acc>();
  const videosOut: Mentions["videos"] = [];
  const excluded = [...input.excludedVideos];

  const ordered = [...input.videos].sort((a, b) => compareCodePoints(a.videoId, b.videoId));
  for (const video of ordered) {
    const ageDays = ageInDays(input.asOf, video.publishedAt);
    if (ageDays < 0) {
      excluded.push({ videoId: video.videoId, reason: `published ${video.publishedAt}, after the as-of date ${input.asOf}` });
      continue;
    }
    const weight = 0.5 ** (ageDays / input.halfLifeDays);
    const mentions = findMentions(video, groups, byFirstToken);
    videosOut.push({
      videoId: video.videoId,
      channel: video.channel,
      title: video.title,
      publishedAt: video.publishedAt,
      ageDays,
      weight: round6(weight),
      cues: video.cues.length,
      leaderMentions: mentions.length,
    });

    const seenInVideo = new Set<string>();
    for (const mention of mentions) {
      const key = mention.group.title;
      const a: Acc = acc.get(key) ?? {
        weighted: 0,
        raw: 0,
        weightedVideos: 0,
        videos: new Set(),
        channels: new Set(),
        specific: new Map(),
        unattributed: { weighted: 0, raw: 0 },
        quotes: [],
      };
      acc.set(key, a);
      a.weighted += weight;
      a.raw += 1;
      if (!seenInVideo.has(key)) {
        seenInVideo.add(key);
        a.weightedVideos += weight;
        a.videos.add(video.videoId);
        a.channels.add(video.channel);
        const from = Math.max(0, mention.cue - QUOTE_CUES);
        const text = video.cues
          .slice(from, mention.cue + QUOTE_CUES + 1)
          .map((c) => c.text)
          .join(" ");
        a.quotes.push({
          channel: video.channel,
          videoTitle: video.title,
          publishedAt: video.publishedAt,
          timestampSec: Math.floor(video.cues[mention.cue].start),
          videoId: video.videoId,
          text,
          weight,
        });
      }
      if (mention.attributedTo === null) {
        a.unattributed.weighted += weight;
        a.unattributed.raw += 1;
      } else {
        const s = a.specific.get(mention.attributedTo.cardKey) ?? { weighted: 0, raw: 0, subtitle: 0 };
        s.weighted += weight;
        s.raw += 1;
        if (mention.viaSubtitle) s.subtitle += 1;
        a.specific.set(mention.attributedTo.cardKey, s);
      }
    }
  }

  const groupByTitle = new Map(groups.map((g) => [g.title, g]));
  const leaders: Mentions["leaders"] = [...acc.entries()]
    .map(([title, a]) => {
      const group = groupByTitle.get(title) as TitleGroup;
      return {
        title,
        weightedMentions: round6(a.weighted),
        rawMentions: a.raw,
        weightedVideos: round6(a.weightedVideos),
        videos: a.videos.size,
        channels: a.channels.size,
        sharedWithNonLeader: group.sharedWithNonLeader,
        leaders: group.leaders
          .filter((l) => a.specific.has(l.cardKey))
          .map((l) => {
            const s = a.specific.get(l.cardKey) as { weighted: number; raw: number; subtitle: number };
            return {
              cardKey: l.cardKey,
              subtitle: l.subtitle,
              weightedMentions: round6(s.weighted),
              rawMentions: s.raw,
              subtitleMentions: s.subtitle,
            };
          })
          .sort((x, y) => y.weightedMentions - x.weightedMentions || compareCodePoints(x.cardKey, y.cardKey)),
        unattributed: { weightedMentions: round6(a.unattributed.weighted), rawMentions: a.unattributed.raw },
        quotes: a.quotes
          .sort((x, y) => y.weight - x.weight || compareCodePoints(x.videoId, y.videoId))
          .slice(0, MAX_QUOTES)
          .map((q) => ({
            channel: q.channel,
            videoTitle: q.videoTitle,
            publishedAt: q.publishedAt,
            timestampSec: q.timestampSec,
            videoId: q.videoId,
            text: q.text,
          })),
      };
    })
    .sort((x, y) => y.weightedMentions - x.weightedMentions || compareCodePoints(x.title, y.title));

  return {
    asOf: input.asOf,
    halfLifeDays: input.halfLifeDays,
    source: {
      kind: "youtube-creator-transcripts",
      population:
        "Auto-generated and creator-uploaded English captions of recent videos from a hand-picked list of Star Wars: Unlimited YouTube creators; creator attention, not play results",
      capturedAt: input.capturedAt,
      transcriptKinds: input.transcriptKinds,
    },
    videos: videosOut.sort((x, y) => compareCodePoints(x.videoId, y.videoId)),
    excludedVideos: excluded.sort((x, y) => compareCodePoints(x.videoId, y.videoId)),
    leaders,
  };
}
