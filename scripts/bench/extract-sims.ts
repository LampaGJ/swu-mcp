/**
 * @displayName Engine-simulation extract
 * @strategicPurpose Manipulation node (reduces): forceteki bot-vs-bot game records (12.9 GB) in, one compact
 * deck-vs-deck result per game out, joined to the decklist extract.
 * @tacticalObjective Streams every game_records_*.jsonl line by line, parses only each header, joins both decks
 * with scripts/bench/sims.ts (a name shared by several lists is settled by the opening hand), and writes data/originals/sims/sims-<sha12>.jsonl.gz sorted by hashed game key plus a
 * manifest with input hashes and join/winner counts. Per-game action logs carry no card ids for plays (only hand
 * indices), so only deck-level results are kept.
 *
 * Usage: pnpm bench:extract-sims [--run <dir>] [--originals <dir>] [--input <dir>] [--decks <file>] [--out <dir>]
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_ORIGINALS_ROOT, engineSlug, loadCardMap } from "./card-map.js";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "./code-commit.js";
import { sha } from "./games.js";
import { buildSimDeckIndex, disambiguateByHand, matchSimDeck, openingHands, parseSimHeader, type SimJoin } from "./sims.js";

const DEFAULT_INPUT = "/Volumes/Models/swu-data/data/simulations";

export const simDecksFileSchema = z.looseObject({
  decks: z.array(
    z.looseObject({
      key: z.string(),
      leader: z.string().nullable(),
      base: z.string().nullable(),
      names: z.array(z.string()),
      cards: z.array(z.tuple([z.string(), z.number()])),
    }),
  ),
});

export function newestFile(dir: string, pattern: RegExp): string {
  const name = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort((a, b) => statSync(path.join(dir, a)).mtimeMs - statSync(path.join(dir, b)).mtimeMs || compareCodePoints(a, b))
    .at(-1);
  if (name === undefined) throw new Error(`no ${pattern} under ${dir}`);
  return path.join(dir, name);
}

export interface SimRecord {
  game: string;
  file: number;
  /** Candidate decklists per seat: one when joined, several when only the opening hand narrowed a shared name, none when unknown. */
  decks: [string[], string[]];
  leaders: [string | null, string | null];
  winner: 1 | 2 | null;
  winReason: string | null;
  turns: number | null;
  mirror: boolean;
  cardsPlayed: [number | null, number | null];
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      originals: { type: "string" },
      input: { type: "string" },
      decks: { type: "string" },
      out: { type: "string" },
    },
  });
  const runDir = path.resolve(values.run ?? defaultRun());
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const inputDir = path.resolve(values.input ?? DEFAULT_INPUT);
  const decksFile = path.resolve(values.decks ?? newestFile(path.join(REPO_ROOT, "data/originals/decks"), /^decks-[0-9a-f]{12}\.json$/));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/sims"));

  const map = loadCardMap(runDir, originals);
  const decksBytes = readFileSync(decksFile);
  const deckList = simDecksFileSchema.parse(JSON.parse(decksBytes.toString("utf8"))).decks;
  const index = buildSimDeckIndex(deckList);
  const deckCards = new Map(deckList.map((d) => [d.key, new Set(d.cards.map(([k]) => k))]));
  const slugs = new Map<string, string[]>();
  for (const p of map.printings) {
    if (p.type.includes("Token")) continue;
    const slug = engineSlug(p.title, p.subtitle);
    const keys = slugs.get(slug) ?? [];
    if (!keys.includes(p.cardKey)) slugs.set(slug, [...keys, p.cardKey]);
  }
  const handSlugs = { seen: 0, resolved: 0 };

  const files = readdirSync(inputDir)
    .filter((f) => /^game_records_.*\.jsonl$/.test(f))
    .sort(compareCodePoints);
  const totalBytes = files.reduce((n, f) => n + statSync(path.join(inputDir, f)).size, 0);
  const p = progress("bench-extract-sims", { total: totalBytes, everyMs: 5000 });
  let bytesDone = 0;
  const records = new Map<string, SimRecord>();
  const inputs: Record<string, unknown>[] = [];
  const joins = { deck: 0, byOpeningHand: 0, ambiguous: 0, handFitsNone: 0, unknown: 0 };
  const winners: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  let duplicates = 0;
  let invalid = 0;
  let zeroCardsPlayed = 0;

  const deckOf = (j: SimJoin, hand: () => string[]): string[] => {
    if ("deck" in j) {
      joins.deck += 1;
      return [j.deck];
    }
    if ("unknown" in j) {
      joins.unknown += 1;
      return [];
    }
    const slugsInHand = hand();
    handSlugs.seen += slugsInHand.length;
    handSlugs.resolved += slugsInHand.filter((x) => slugs.has(x)).length;
    const fits = disambiguateByHand(j.ambiguous, slugsInHand, slugs, deckCards);
    if (fits.length === 1) joins.byOpeningHand += 1;
    else if (fits.length === 0) joins.handFitsNone += 1;
    else joins.ambiguous += 1;
    return fits;
  };

  for (const [fileIndex, file] of files.entries()) {
    const full = path.join(inputDir, file);
    const hash = createHash("sha256");
    const stream = createReadStream(full, { highWaterMark: 1 << 20 });
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesDone += chunk.length;
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let rows = 0;
    for await (const line of rl) {
      if (line.trim() === "") continue;
      rows += 1;
      const h = parseSimHeader(line);
      if (h === null) {
        invalid += 1;
        continue;
      }
      const key = sha(`${h.gameId}\u0000${h.timestamp}`);
      if (records.has(key)) {
        duplicates += 1;
        continue;
      }
      const winner =
        h.winner === 1 || h.winner === "1" || h.winner === "player1"
          ? 1
          : h.winner === 2 || h.winner === "2" || h.winner === "player2"
            ? 2
            : null;
      winners[String(winner)] = (winners[String(winner)] ?? 0) + 1;
      reasons[h.winReason ?? "none"] = (reasons[h.winReason ?? "none"] ?? 0) + 1;
      let hands: Map<number, string[]> | undefined;
      const handOf = (player: number) => (): string[] => (hands ??= openingHands(line)).get(player) ?? [];
      if ((h.player1.cardsPlayed ?? 0) === 0 && (h.player2.cardsPlayed ?? 0) === 0) zeroCardsPlayed += 1;
      records.set(key, {
        game: key,
        file: fileIndex,
        decks: [
          deckOf(matchSimDeck(index, map.setNumber.byId, h.player1), handOf(1)),
          deckOf(matchSimDeck(index, map.setNumber.byId, h.player2), handOf(2)),
        ],
        leaders: [map.setNumber.byId.get(h.player1.leaderId) ?? null, map.setNumber.byId.get(h.player2.leaderId) ?? null],
        winner,
        winReason: h.winReason ?? null,
        turns: h.turnCount ?? null,
        mirror: h.player1.deckId === h.player2.deckId,
        cardsPlayed: [h.player1.cardsPlayed ?? null, h.player2.cardsPlayed ?? null],
      });
      if (rows % 2000 === 0) p.tick(bytesDone, { file, rows, games: records.size });
    }
    inputs.push({ file, bytes: statSync(full).size, sha256: hash.digest("hex"), rows });
  }

  const sorted = [...records.values()].sort((a, b) => compareCodePoints(a.game, b.game));
  const body = sorted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const bodySha = sha256Hex(body);
  mkdirSync(outDir, { recursive: true });
  const outFile = `sims-${bodySha.slice(0, 12)}.jsonl.gz`;
  writeFileSync(path.join(outDir, outFile), gzipSync(Buffer.from(body, "utf8"), { level: 9 }));
  const manifest = {
    kind: "forceteki-sim-games",
    output: { file: outFile, sha256Uncompressed: bodySha, games: sorted.length },
    inputs,
    decksFile: { file: path.basename(decksFile), sha256: createHash("sha256").update(decksBytes).digest("hex") },
    counts: {
      invalid,
      duplicates,
      mirror: sorted.filter((r) => r.mirror).length,
      bothDecksJoined: sorted.filter((r) => r.decks[0].length === 1 && r.decks[1].length === 1).length,
      bothSeatsWithCandidates: sorted.filter((r) => r.decks[0].length > 0 && r.decks[1].length > 0).length,
      joins,
      openingHandSlugs: handSlugs,
      winners,
      winReasons: reasons,
      zeroCardsPlayedBothSides: zeroCardsPlayed,
    },
    notes: [
      "Bot-vs-bot games on the Karabast engine (forceteki); not human play.",
      "Action logs identify played cards only by hand index, so per-card play facts are not recoverable; only deck-level results are kept.",
      "Tournament report JSONs (testDeck/matchups/aggregate) carry per-matchup win counts with empty gameResults and are not used.",
    ],
    runDir: path.basename(runDir),
    codeCommit: codeCommit(),
  };
  writeFileSync(path.join(outDir, `sims-${bodySha.slice(0, 12)}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ games: sorted.length, outFile });
  console.log(JSON.stringify({ outFile, games: sorted.length, counts: manifest.counts }, null, 1));
}

if (isMain(import.meta.url)) await main();
