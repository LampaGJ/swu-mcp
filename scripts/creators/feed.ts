import * as cheerio from "cheerio";
import { feedSchema, type Feed } from "./schema.js";

/**
 * Parses a YouTube Atom feed. The XML is read with cheerio's xmlMode (already a dependency); the extracted values go
 * through feedSchema, so a changed element name fails here instead of producing an empty video list.
 */
export function parseFeedXml(xml: string): Feed {
  const $ = cheerio.load(xml, { xmlMode: true });
  return feedSchema.parse({
    feedChannelId: $("feed > yt\\:channelId").first().text().trim(),
    entries: $("feed > entry")
      .toArray()
      .map((entry) => ({
        videoId: $(entry).children("yt\\:videoId").first().text().trim(),
        title: $(entry).children("title").first().text(),
        published: $(entry).children("published").first().text().trim(),
      })),
  });
}
