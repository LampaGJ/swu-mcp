/**
 * @displayName Human-game extract
 * @strategicPurpose Manipulation node (reduces): the 3.2 GB Karabast spectator JSONL in, one compact record per
 * game side out, so real-play benchmarks never touch raw rows or player identities.
 * @tacticalObjective Streams every file line by line, drops duplicate rows across files, folds (file, game) chunks
 * with scripts/bench/games.ts, resolves card names with the run's release window, and writes a gzipped JSONL
 * sorted by hashed game id plus a manifest of input hashes, counts, winner checks and mapping coverage.
 *
 * Usage: pnpm bench:extract-games [--run <dir>] [--originals <dir>] [--input <dir>] [--out <dir>]
 *   --input  default: /Volumes/Models/swu/human-games (every training-*.jsonl)
 *   --out    default: data/originals/karabast (git-ignored; holds private player data)
 */
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { loadStore } from "../../src/data.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { setReleaseOrder } from "../../src/swu/llm-flatten.js";
import { progress } from "../lib/progress.mjs";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "./code-commit.js";
import { cardFirstOrder, releaseDatesFromDefinitions, sourceWindow, UNKNOWN_ORDER } from "./availability.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap, normalizeName, setNumberId, type CardMap } from "./card-map.js";
import {
  CO_SEP,
  foldChunk,
  humanRowSchema,
  newGame,
  resolveWinner,
  rowKey,
  sha,
  type CardToken,
  type GameState,
  type HumanRow,
} from "./games.js";

const DEFAULT_INPUT = "/Volumes/Models/swu/human-games";
export const HUMAN_CAPTURED_THROUGH = "2026-02-10";

export interface GameSideRecord {
  leader: string | null;
  leaderName: string | null;
  base: string | null;
  baseName: string | null;
  won: 0 | 1 | null;
  cards: [string, number][];
  played: string[];
  co: [string, string][];
  unmapped: number;
  tokens: number;
}

export interface GameRecord {
  game: string;
  files: number[];
  rows: number;
  maxTurn: number;
  winner: string;
  forfeit: boolean;
  sides: GameSideRecord[];
}

function tokenResolver(map: CardMap, tokenNames: ReadonlySet<string>, setUses: Map<string, number>) {
  return {
    setId(set: string, number: number): CardToken {
      setUses.set(set, (setUses.get(set) ?? 0) + 1);
      const key = map.setNumber.byId.get(setNumberId(set, number));
      return key === undefined ? `x:${setNumberId(set, number)}` : `k:${key}`;
    },
    name(name: string): CardToken {
      const norm = normalizeName(name);
      if (tokenNames.has(norm)) return `t:${norm}`;
      const key = map.names.has(norm) ? norm : map.names.has(`title::${norm}`) ? `title::${norm}` : norm;
      const hits = map.names.get(key);
      return hits !== undefined && hits.length === 1 ? `k:${hits[0]}` : `n:${key}`;
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { run: { type: "string" }, originals: { type: "string" }, input: { type: "string" }, out: { type: "string" } },
  });
  const runDir = path.resolve(values.run ?? defaultRun());
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const inputDir = path.resolve(values.input ?? DEFAULT_INPUT);
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/karabast"));

  const map = loadCardMap(runDir, originals);
  const store = loadStore(runDir);
  const inScope = new Set(store.cards.map((c) => c.cardKey));
  const tokenNames = new Set(map.printings.filter((p) => p.type.includes("Token")).map((p) => normalizeName(p.title)));
  const firstOrder = cardFirstOrder(map.printings);
  const typeOf = new Map(map.printings.map((p) => [p.cardKey, p.type]));
  const releaseDates = releaseDatesFromDefinitions(store.facets.get("expansion") ?? []);

  const files = readdirSync(inputDir)
    .filter((f) => /^training-.*\.jsonl$/.test(f))
    .sort(compareCodePoints);
  const totalBytes = files.reduce((n, f) => n + statSync(path.join(inputDir, f)).size, 0);
  const p = progress("bench-extract-games", { total: totalBytes, everyMs: 5000 });

  const setUses = new Map<string, number>();
  const resolve = tokenResolver(map, tokenNames, setUses);
  const seenRows = new Set<string>();
  const games = new Map<string, GameState>();
  const inputs: Record<string, unknown>[] = [];
  let bytesDone = 0;

  for (const [fileIndex, file] of files.entries()) {
    const full = path.join(inputDir, file);
    const hash = createHash("sha256");
    const stream = createReadStream(full);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesDone += chunk.length;
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const stats = { rows: 0, invalid: 0, duplicate: 0, games: new Set<string>() };
    let chunkGame: string | null = null;
    let chunk: HumanRow[] = [];
    const flush = (): void => {
      if (chunkGame === null) return;
      let game = games.get(chunkGame);
      if (game === undefined) {
        game = newGame();
        games.set(chunkGame, game);
      }
      foldChunk(game, fileIndex, chunk, resolve);
      chunk = [];
    };
    for await (const line of rl) {
      if (line.trim() === "") continue;
      stats.rows += 1;
      const at = line.indexOf('"label":');
      const parsed = at < 0 ? null : humanRowSchema.safeParse(JSON.parse(`{${line.slice(at)}`));
      if (parsed === null || !parsed.success) {
        stats.invalid += 1;
        continue;
      }
      const row = parsed.data;
      const key = rowKey(row.metadata);
      if (seenRows.has(key)) {
        stats.duplicate += 1;
        continue;
      }
      seenRows.add(key);
      const gameKey = sha(row.metadata.gameId);
      stats.games.add(gameKey);
      if (gameKey !== chunkGame) {
        flush();
        chunkGame = gameKey;
      }
      chunk.push(row);
      if (stats.rows % 20000 === 0) p.tick(bytesDone, { file, rows: stats.rows, games: games.size });
    }
    flush();
    inputs.push({
      file,
      bytes: statSync(full).size,
      sha256: hash.digest("hex"),
      rows: stats.rows,
      invalidRows: stats.invalid,
      duplicateRows: stats.duplicate,
      games: stats.games.size,
    });
  }

  const window = sourceWindow("karabast-human", HUMAN_CAPTURED_THROUGH, releaseDates, setUses);
  const nameResolution = new Map<string, string | null>();
  const resolveToken = (token: CardToken): string | null => {
    if (token.startsWith("k:")) return token.slice(2);
    if (!token.startsWith("n:")) return null;
    const norm = token.slice(2);
    if (!nameResolution.has(norm)) {
      const hits = (map.names.get(norm) ?? []).filter((key) => (firstOrder.get(key) ?? UNKNOWN_ORDER) <= window.reachesOrder);
      nameResolution.set(norm, hits.length === 1 ? hits[0] : null);
    }
    return nameResolution.get(norm) as string | null;
  };
  const typed = (tokens: Iterable<CardToken>, type: string, name: string | null): string | null => {
    const keys = [...new Set([...tokens].map(resolveToken).filter((k): k is string => k !== null && typeOf.get(k) === type))].sort(
      compareCodePoints,
    );
    if (keys.length === 1) return keys[0];
    if (name === null) return null;
    const hits = (map.names.get(`${type.toLowerCase()}::${normalizeName(name)}`) ?? []).filter(
      (key) => (firstOrder.get(key) ?? UNKNOWN_ORDER) <= window.reachesOrder,
    );
    const narrowed = keys.length > 1 ? hits.filter((h) => keys.includes(h)) : hits;
    return narrowed.length === 1 ? narrowed[0] : null;
  };

  const mapping = { observations: 0, inScope: 0, outOfScope: 0, unmapped: 0, tokens: 0 };
  const unmappedNames = new Map<string, number>();
  const winnerCounts: Record<string, number> = {};
  const forfeit = { games: 0, forfeiterLost: 0, forfeiterWon: 0 };
  const seat = { agree: 0, disagree: 0, chunksWithoutSeat: 0 };
  const leaders = { resolved: 0, unresolved: 0 };
  const records: GameRecord[] = [];

  for (const [gameKey, game] of games) {
    const { status, won } = resolveWinner(game);
    winnerCounts[status] = (winnerCounts[status] ?? 0) + 1;
    seat.agree += game.seatVotes.agree;
    seat.disagree += game.seatVotes.disagree;
    seat.chunksWithoutSeat += game.chunksWithoutSeat;
    if (game.forfeitLabels.length > 0) {
      forfeit.games += 1;
      if (game.forfeitLabels.every((l) => l === 0)) forfeit.forfeiterLost += 1;
      else forfeit.forfeiterWon += 1;
    }
    const sides: GameSideRecord[] = [];
    for (const [id, s] of game.sides) {
      const cards = new Map<string, number>();
      let unmapped = 0;
      let tokens = 0;
      for (const [token, turn] of s.cards) {
        mapping.observations += 1;
        if (token.startsWith("t:")) {
          tokens += 1;
          mapping.tokens += 1;
          continue;
        }
        const key = resolveToken(token);
        if (key === null) {
          unmapped += 1;
          mapping.unmapped += 1;
          const label = token.slice(2);
          unmappedNames.set(label, (unmappedNames.get(label) ?? 0) + 1);
          continue;
        }
        if (inScope.has(key)) mapping.inScope += 1;
        else mapping.outOfScope += 1;
        cards.set(key, Math.min(cards.get(key) ?? Number.MAX_SAFE_INTEGER, turn));
      }
      const co = new Set<string>();
      for (const pair of s.co) {
        const [a, b] = pair.split(CO_SEP).map(resolveToken);
        if (a !== null && b !== null && a !== b) co.add(`${a}${CO_SEP}${b}`);
      }
      const leader = typed(s.leaderTokens, "Leader", s.leaderName);
      const base = typed(s.baseTokens, "Base", s.baseName);
      if (leader === null) leaders.unresolved += 1;
      else leaders.resolved += 1;
      sides.push({
        leader,
        leaderName: s.leaderName,
        base,
        baseName: s.baseName,
        won: won.get(id) ?? null,
        cards: [...cards].sort((a, b) => compareCodePoints(a[0], b[0])),
        played: [...new Set([...s.played].map(resolveToken).filter((k): k is string => k !== null))].sort(compareCodePoints),
        co: [...co].sort(compareCodePoints).map((x) => x.split(CO_SEP) as [string, string]),
        unmapped,
        tokens,
      });
    }
    sides.sort((a, b) => compareCodePoints(JSON.stringify(a), JSON.stringify(b)));
    records.push({
      game: gameKey,
      files: [...game.files].sort((a, b) => a - b),
      rows: game.rows,
      maxTurn: game.maxTurn,
      winner: status,
      forfeit: game.forfeitLabels.length > 0,
      sides,
    });
  }
  records.sort((a, b) => compareCodePoints(a.game, b.game));

  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const bodySha = sha256Hex(body);
  mkdirSync(outDir, { recursive: true });
  const outFile = `games-${bodySha.slice(0, 12)}.jsonl.gz`;
  writeFileSync(path.join(outDir, outFile), gzipSync(Buffer.from(body, "utf8"), { level: 9 }));

  const multiFile = records.filter((r) => r.files.length > 1).length;
  const manifest = {
    kind: "karabast-human-games",
    output: { file: outFile, sha256Uncompressed: bodySha, games: records.length, sides: records.reduce((n, r) => n + r.sides.length, 0) },
    inputs,
    totals: {
      rows: inputs.reduce((n, i) => n + (i.rows as number), 0),
      invalidRows: inputs.reduce((n, i) => n + (i.invalidRows as number), 0),
      duplicateRows: inputs.reduce((n, i) => n + (i.duplicateRows as number), 0),
      uniqueRows: seenRows.size,
      gamesPerFileSum: inputs.reduce((n, i) => n + (i.games as number), 0),
      uniqueGames: records.length,
      gamesInMultipleFiles: multiFile,
    },
    winner: {
      status: winnerCounts,
      forfeit,
      note: "resolved: both sides labelled and complementary; one-sided: only one side acted, the other side's result is its complement; conflict/no-label: won is null.",
    },
    seatOne: {
      ...seat,
      note: "activePlayerUnits/Discard list a fixed seat, not the acting player (KarabastToDigestConverter p1 = first player key); seat 1 is voted per (file, game) chunk from where played units land.",
    },
    leaders,
    mapping: {
      ...mapping,
      mappedShare: Math.round(((mapping.inScope + mapping.outOfScope) / Math.max(1, mapping.observations - mapping.tokens)) * 1e4) / 1e4,
      topUnmapped: [...unmappedNames].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0])).slice(0, 30),
      note: "Observations are distinct (side, card) pairs. inScope = card is in the run's card list; outOfScope = a known printing of a rotated/non-run card.",
    },
    window: {
      ...window,
      setUses: Object.fromEntries(
        [...setUses].sort((a, b) => setReleaseOrder(a[0]) - setReleaseOrder(b[0]) || compareCodePoints(a[0], b[0])),
      ),
      releaseDates: Object.fromEntries(releaseDates),
    },
    runDir: path.basename(runDir),
    rawManifestSha256: map.rawManifestSha256,
    codeCommit: codeCommit(),
  };
  writeFileSync(path.join(outDir, `games-${bodySha.slice(0, 12)}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  p.done({ games: records.length, outFile });
  console.log(
    JSON.stringify(
      {
        outFile,
        totals: manifest.totals,
        winner: manifest.winner,
        mapping: { ...manifest.mapping, topUnmapped: manifest.mapping.topUnmapped.slice(0, 10) },
        window,
      },
      null,
      1,
    ),
  );
}

if (isMain(import.meta.url)) await main();
