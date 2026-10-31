import { encode } from "@toon-format/toon";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFeedXml } from "../../scripts/creators/feed.js";
import { ageInDays, normalizeText } from "../../scripts/creators/mentions.js";
import { runIndex } from "../../scripts/creators/run-index.js";
import { creatorsFileSchema, manifestSchema } from "../../scripts/creators/schema.js";
import { parseVtt } from "../../scripts/creators/vtt.js";
import { sha256Hex } from "../../src/swu/canonical.js";

/** Mimics YouTube's rolling auto-captions: each cue repeats the previous line, and a 10 ms cue repeats it again. A "~" line stands for the real files' whitespace-only line. */
const ROLLING_VTT = [
  "WEBVTT",
  "Kind: captions",
  "Language: en",
  "",
  "00:00:00.000 --> 00:00:03.000 align:start position:0%",
  "~",
  "today<00:00:00.500><c> we</c><00:00:00.900><c> talk</c><00:00:01.200><c> about</c><00:00:01.500><c> Cad</c><00:00:01.800><c> Bane</c>",
  "",
  "00:00:03.000 --> 00:00:03.010 align:start position:0%",
  "today we talk about Cad Bane",
  "~",
  "",
  "00:00:03.010 --> 00:00:06.000 align:start position:0%",
  "today we talk about Cad Bane",
  "he's<00:00:03.300><c> great</c><00:00:04.000><c> and</c><00:00:04.500><c> Luke</c><00:00:05.000><c> Skywalker</c><00:00:05.500><c> Jedi</c><00:00:05.800><c> Knight</c>",
  "",
  "00:00:06.000 --> 00:00:06.010 align:start position:0%",
  "he's great and Luke Skywalker Jedi Knight",
  "~",
  "",
  "00:00:06.010 --> 00:00:09.000 align:start position:0%",
  "he's great and Luke Skywalker Jedi Knight",
  "nothing<00:00:07.000><c> else</c><00:00:08.000><c> matters</c>",
  "",
]
  .join("\n")
  .replaceAll("~", " ");

const OLD_VTT = `WEBVTT

00:00:10.000 --> 00:00:12.000
I think Cad Bane is back.

00:00:12.000 --> 00:00:14.000
And the Hero of Yavin version of Luke Skywalker is fine.
`;

const CARDS = [
  { cardKey: "0101", title: "Cad Bane", subtitle: "Hostage Taker", type: "Leader" },
  { cardKey: "0102", title: "Luke Skywalker", subtitle: "Jedi Knight", type: "Leader" },
  { cardKey: "0103", title: "Luke Skywalker", subtitle: "Hero of Yavin", type: "Leader" },
  { cardKey: "0104", title: "Luke Skywalker", subtitle: null, type: "Unit" },
  { cardKey: "0105", title: "Darth Vader", subtitle: "Dark Lord", type: "Leader" },
];

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function capture(): { dir: string; cards: string } {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "creators-"));
  roots.push(dir);
  const write = (rel: string, body: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
    return { path: rel, sha256: sha256Hex(body) };
  };
  const video = (id: string, channel: string, publishedAt: string, vtt: string) => ({
    id,
    title: `${id} title`,
    publishedAt,
    durationSec: 600,
    files: {
      infoJson: write(`${channel}/${id}.info.json`, "{}"),
      vtt: { ...write(`${channel}/${id}.en-orig.vtt`, vtt), lang: "en-orig", kind: "auto" as const },
      otherVtt: [],
    },
  });
  const manifest = manifestSchema.parse({
    capturedAt: "2026-10-30T12:00:00.000Z",
    sinceDays: 120,
    perChannel: 10,
    ytDlpVersion: "test",
    abortedReason: null,
    channels: [
      {
        name: "Alpha",
        channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
        feedUrl: "https://example.test/a",
        feedStatus: 404,
        discovery: "yt-dlp-flat",
        titleMatch: null,
        videos: [video("vidAAAAAAAA", "alpha", "2026-10-30", ROLLING_VTT)],
      },
      {
        name: "Beta",
        channelId: "UCbbbbbbbbbbbbbbbbbbbbbb",
        feedUrl: "https://example.test/b",
        feedStatus: 404,
        discovery: "yt-dlp-flat",
        titleMatch: null,
        videos: [video("vidBBBBBBBB", "beta", "2026-09-30", OLD_VTT)],
      },
    ],
  });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const cards = path.join(dir, "cards.toon");
  writeFileSync(cards, encode({ cards: CARDS }));
  return { dir, cards };
}

describe("parseVtt", () => {
  it("drops the rolling auto-caption repeats and keeps first-appearance start times", () => {
    expect(parseVtt(ROLLING_VTT)).toEqual([
      { start: 0, text: "today we talk about Cad Bane" },
      { start: 3.01, text: "he's great and Luke Skywalker Jedi Knight" },
      { start: 6.01, text: "nothing else matters" },
    ]);
  });
});

describe("normalizeText", () => {
  it("lowercases, strips diacritics and possessives, and flattens punctuation", () => {
    expect(normalizeText("Padmé Amidala's “Plan”: ...How Unfortunate")).toBe("padme amidala plan how unfortunate");
  });
});

describe("runIndex", () => {
  const options = (c: { dir: string; cards: string }) => ({
    capturesDir: c.dir,
    cardsPath: c.cards,
    asOf: "2026-10-30",
    halfLifeDays: 30,
    codeCommit: "test-commit",
  });

  it("pins one weighted aggregate: 0.5^(age/halfLife), repeats counted once", () => {
    expect(ageInDays("2026-10-30", "2026-09-30")).toBe(30);
    const { mentions } = runIndex(options(capture()));
    const cad = mentions.leaders.find((l) => l.title === "Cad Bane");
    // Alpha (age 0, weight 1): one mention despite the rolled repeats. Beta (age 30, weight 0.5): one mention.
    expect(cad).toMatchObject({
      weightedMentions: 1.5,
      rawMentions: 2,
      weightedVideos: 1.5,
      videos: 2,
      channels: 2,
      sharedWithNonLeader: false,
    });
    expect(cad?.leaders).toEqual([
      { cardKey: "0101", subtitle: "Hostage Taker", weightedMentions: 1.5, rawMentions: 2, subtitleMentions: 0 },
    ]);
    expect(cad?.quotes.map((q) => q.videoId)).toEqual(["vidAAAAAAAA", "vidBBBBBBBB"]);
    expect(cad?.quotes[0]).toMatchObject({ channel: "Alpha", timestampSec: 0, publishedAt: "2026-10-30" });
    expect(mentions.leaders.find((l) => l.title === "Darth Vader")).toBeUndefined();
  });

  it("attributes a shared title to the leader whose subtitle follows or sits in the cue window", () => {
    const { mentions } = runIndex(options(capture()));
    const luke = mentions.leaders.find((l) => l.title === "Luke Skywalker");
    expect(luke).toMatchObject({ rawMentions: 2, sharedWithNonLeader: true });
    expect(luke?.leaders).toEqual([
      { cardKey: "0102", subtitle: "Jedi Knight", weightedMentions: 1, rawMentions: 1, subtitleMentions: 1 },
      { cardKey: "0103", subtitle: "Hero of Yavin", weightedMentions: 0.5, rawMentions: 1, subtitleMentions: 0 },
    ]);
    expect(luke?.unattributed).toEqual({ weightedMentions: 0, rawMentions: 0 });
  });

  it("gives byte-identical output for the same inputs and rejects a changed asOf only through the hash", () => {
    const c = capture();
    const first = runIndex(options(c));
    const second = runIndex(options(c));
    expect(second.mentionsBytes).toBe(first.mentionsBytes);
    expect(second.replay).toEqual(first.replay);
    expect(first.replay.outputHash).toBe(sha256Hex(first.mentionsBytes));
    const later = runIndex({ ...options(c), asOf: "2026-11-30" });
    expect(later.replay.inputHash).not.toBe(first.replay.inputHash);
  });

  it("refuses a transcript whose bytes no longer match the manifest hash", () => {
    const c = capture();
    writeFileSync(path.join(c.dir, "alpha/vidAAAAAAAA.en-orig.vtt"), "WEBVTT\n");
    expect(() => runIndex(options(c))).toThrow(/manifest pins/);
  });
});

describe("seams", () => {
  it("parses a YouTube Atom feed and fails loudly when the shape changes", () => {
    const xml = `<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
      <yt:channelId>aaaaaaaaaaaaaaaaaaaaaa</yt:channelId>
      <entry><yt:videoId>vidAAAAAAAA</yt:videoId><title>One &amp; two</title><published>2026-10-29T20:00:20+00:00</published></entry></feed>`;
    expect(parseFeedXml(xml)).toEqual({
      feedChannelId: "aaaaaaaaaaaaaaaaaaaaaa",
      entries: [{ videoId: "vidAAAAAAAA", title: "One & two", published: "2026-10-29T20:00:20+00:00" }],
    });
    expect(() => parseFeedXml(xml.replace(/yt:videoId/g, "yt:vid"))).toThrow();
  });

  it("validates the committed creators config", () => {
    const creators = creatorsFileSchema.parse(JSON.parse(readFileSync(path.join(import.meta.dirname, "../../data/creators.json"), "utf8")));
    expect(creators.filter((c) => c.channelId === null).map((c) => c.name)).toEqual(["Bobby Sapphire"]);
  });
});
