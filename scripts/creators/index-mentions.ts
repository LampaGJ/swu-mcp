/**
 * @displayName Creator mention index (CLI)
 * @strategicPurpose Turns the pinned creator transcripts into a recency-weighted "what creators are talking about"
 * index of Leader cards, replayable to identical bytes (D2).
 * @tacticalObjective Reads <captures>/manifest.json and the pinned VTT files (hash-checked) plus cards.toon, calls
 * runIndex, and writes mentions.json and replay.json {inputHash, codeCommit, outputHash} to the output directory.
 *
 * Usage: tsx scripts/creators/index-mentions.ts --captures <dir> --as-of <YYYY-MM-DD> [--cards <cards.toon>] [--out <dir>] [--half-life-days 30]
 *   --as-of     required; the recency weight 0.5^(ageDays/halfLife) counts days from this date, never from the clock.
 *   --cards     default: the newest data/runs/<date>/llm/cards.toon under the repo root (by date name); an error if none exists.
 *   --out       default: data/runs/<as-of>/creators
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "../../src/paths.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { codeCommit } from "../lib/code-commit.js";
import { runIndex } from "./run-index.js";

function newestCards(): string {
  const runs = path.join(REPO_ROOT, "data/runs");
  const dates = existsSync(runs) ? readdirSync(runs).sort(compareCodePoints).reverse() : [];
  for (const date of dates) {
    const candidate = path.join(runs, date, "llm/cards.toon");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no data/runs/<date>/llm/cards.toon under ${REPO_ROOT}; pass --cards <path>`);
}

const { values } = parseArgs({
  options: {
    captures: { type: "string" },
    cards: { type: "string" },
    out: { type: "string" },
    "as-of": { type: "string" },
    "half-life-days": { type: "string" },
  },
});
const asOf = z.iso.date().parse(values["as-of"]);
const halfLifeDays = z.coerce
  .number()
  .positive()
  .parse(values["half-life-days"] ?? "30");
const capturesDir = path.resolve(z.string().min(1).parse(values.captures));
const cardsPath = path.resolve(values.cards ?? newestCards());
const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/runs", asOf, "creators"));

const result = runIndex({ capturesDir, cardsPath, asOf, halfLifeDays, codeCommit: codeCommit(["src", "scripts"]) });
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "mentions.json"), result.mentionsBytes);
writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(result.replay, null, 1)}\n`);
console.log(
  JSON.stringify(
    { outDir, cardsPath, videos: result.mentions.videos.length, leadersMentioned: result.mentions.leaders.length, replay: result.replay },
    null,
    1,
  ),
);
