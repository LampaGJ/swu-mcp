/**
 * @displayName Meta archetype step
 * @strategicPurpose Manipulation node (reduces), pipeline step of build:data (LampaGJ/swu-mcp#25): recent decklist
 * snapshots, the pinned tournament matchup capture and the optional human-game and tournament-result extracts in;
 * data/runs/<date>/meta/{archetypes,winrates}.json and a replay record out. The meta tools read only these files.
 * @tacticalObjective Maps each snapshot deck's SET_NNN ids to the run's cardKeys, labels it tournament (event and
 * placement known) or community, and hands the decks to src/meta/build.ts. Win rates are folded by
 * src/meta/outcomes.ts into aggregates only: tournament matchups first, card-level rates from tournament results
 * (when an extract exists) then human games. Bot simulations are never read. Deck authors and player ids are never read.
 *
 * Usage: pnpm meta [--data <run dir>] [--originals <dir>] [--decks <snapshot dir> ...] [--matchups <capture dir>]
 *                  [--games <games-*.jsonl.gz>] [--results <tournament-results.json>] [--out <dir>]
 *   --decks     default: the newest data/originals/decks/<YYYY-MM-DD>/ of this checkout or the main checkout
 *   --matchups  default: the newest data/originals/tournaments/<YYYY-MM-DD>/ holding matchups.json
 *   --games     default: the newest data/originals/karabast/games-*.jsonl.gz
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { buildMeta, cardFacts, type MetaDeck } from "../src/meta/build.js";
import {
  foldCardOutcomes,
  foldMatchups,
  matchupCaptureSchema,
  matchupResponseSchema,
  tournamentGames,
  type NameResolver,
  type OutcomeGame,
} from "../src/meta/outcomes.js";
import {
  humanGameSchema,
  metaFileSchema,
  metaReplaySchema,
  snapshotDeckSchema,
  tournamentResultsSchema,
  winRatesFileSchema,
  type CardOutcomes,
  type WinRatesFile,
} from "../src/meta/schema.js";
import { compareCodePoints, sha256Hex } from "../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap, normalizeName, type CardMap } from "./bench/card-map.js";
import { codeCommit, REPO_ROOT } from "./bench/code-commit.js";
import { progress } from "./lib/progress.mjs";

const MAIN_CHECKOUT = "/Volumes/Local Files/Projects/swu-mcp";
const ROOTS = [REPO_ROOT, MAIN_CHECKOUT];
const DATED = /^\d{4}-\d{2}-\d{2}$/;
export const MIN_N = 10;
const HUMAN_CAPTURED_THROUGH = "2026-02-10";

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function newestDated(sub: string, holds: (dir: string) => boolean): string | undefined {
  const found = ROOTS.map((root) => path.join(root, "data/originals", sub))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((n) => DATED.test(n))
        .map((n) => path.join(dir, n)),
    )
    .filter(holds);
  return found.sort((a, b) => compareCodePoints(path.basename(a), path.basename(b)) || compareCodePoints(a, b)).at(-1);
}

function newestGames(): string | undefined {
  const files = ROOTS.map((root) => path.join(root, "data/originals/karabast"))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((n) => /^games-[0-9a-f]{12}\.jsonl\.gz$/.test(n))
        .map((n) => path.join(dir, n)),
    );
  return files.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs || compareCodePoints(a, b)).at(-1);
}

const deckFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".json") && !f.startsWith("_") && f !== "manifest.json" && f !== "rejects.json" && statSync(path.join(dir, f)).isFile(),
    )
    .sort(compareCodePoints);

interface ReadDecks {
  decks: MetaDeck[];
  listing: string;
  stats: { files: number; invalid: number; undated: number; unmappedLeaderOrBase: number; unmappedCards: number };
}

function readSnapshot(dir: string, map: CardMap, onFile: (i: number) => void): ReadDecks {
  const files = deckFiles(dir);
  const listing = createHash("sha256");
  const stats = { files: files.length, invalid: 0, undated: 0, unmappedLeaderOrBase: 0, unmappedCards: 0 };
  const decks: MetaDeck[] = [];
  files.forEach((file, i) => {
    if (i % 2000 === 0) onFile(i);
    const bytes = readFileSync(path.join(dir, file));
    listing.update(`${file}\u0000${createHash("sha256").update(bytes).digest("hex")}\n`);
    const parsed = snapshotDeckSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success) {
      stats.invalid += 1;
      return;
    }
    const d = parsed.data;
    const createdAt = d.metadata?.createdAt;
    if (createdAt === undefined || !DATED.test(createdAt.slice(0, 10))) {
      stats.undated += 1;
      return;
    }
    const leader = map.setNumber.byId.get(d.leader.id);
    const base = map.setNumber.byId.get(d.base.id);
    if (leader === undefined || base === undefined) {
      stats.unmappedLeaderOrBase += 1;
      return;
    }
    const counts = new Map<string, number>();
    for (const e of d.deck) {
      const key = map.setNumber.byId.get(e.id);
      if (key === undefined) {
        stats.unmappedCards += 1;
        continue;
      }
      if (e.count !== 0) counts.set(key, (counts.get(key) ?? 0) + (e.count ?? 1));
    }
    const event = d.metadata?.event;
    const placement = d.metadata?.placement ?? null;
    const eventKey =
      event === undefined || event === null
        ? null
        : event.id !== undefined
          ? String(event.id)
          : event.name !== undefined
            ? `${event.name}|${event.date ?? ""}`
            : null;
    const tournament = eventKey !== null && placement !== null;
    decks.push({
      key: sha256Hex(`${path.basename(dir)}/${file}`).slice(0, 16),
      population: tournament ? "tournament" : "community",
      source: d.metadata?.source ?? "unknown",
      leader,
      base,
      cards: [...counts].sort((a, b) => compareCodePoints(a[0], b[0])),
      createdAt: createdAt.slice(0, 10),
      event: tournament ? `${d.metadata?.via ?? d.metadata?.source ?? "?"}:${eventKey}` : null,
      field: tournament ? (event?.players ?? null) : null,
      placement: tournament ? placement : null,
    });
  });
  return { decks, listing: listing.digest("hex"), stats };
}

function nameResolver(map: CardMap, facts: ReturnType<typeof cardFacts>): NameResolver {
  const types = new Map<string, Set<string>>();
  const sets = new Map<string, Set<string>>();
  for (const p of map.printings) {
    types.set(p.cardKey, (types.get(p.cardKey) ?? new Set()).add(p.type));
    sets.set(p.cardKey, (sets.get(p.cardKey) ?? new Set()).add(p.expansion.toLowerCase()));
  }
  const typed = (name: string, type: string): string[] =>
    (map.names.get(normalizeName(name)) ?? []).filter((key) => types.get(key)?.has(type) === true);
  const leaderMemo = new Map<string, string | null>();
  return {
    leader(name, set) {
      const memoKey = `${name}\u0000${set ?? ""}`;
      if (!leaderMemo.has(memoKey)) {
        let hits = typed(name, "Leader");
        if (hits.length > 1 && set !== undefined) {
          const inSet = hits.filter((key) => sets.get(key)?.has(set.toLowerCase()) === true);
          if (inSet.length > 0) hits = inSet;
        }
        leaderMemo.set(memoKey, hits.length === 1 ? hits[0] : null);
      }
      return leaderMemo.get(memoKey) as string | null;
    },
    baseAspects(name) {
      const hits = typed(name, "Base");
      const aspects = [...new Set(hits.map((key) => (facts.get(key)?.aspectIcons ?? []).join("+")))];
      return hits.length > 0 && aspects.length === 1 ? (aspects[0] === "" ? [] : aspects[0].split("+")) : null;
    },
  };
}

function* humanGames(file: string): Generator<OutcomeGame> {
  const body = gunzipSync(readFileSync(file)).toString("utf8");
  for (const line of body.split("\n")) {
    if (line.trim() === "") continue;
    const game = humanGameSchema.parse(JSON.parse(line));
    if (game.sides.length !== 2) continue;
    const side = (i: number) => ({ leader: game.sides[i].leader, won: game.sides[i].won, cards: game.sides[i].cards.map(([c]) => c) });
    yield [side(0), side(1)];
  }
}

function main(): void {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      originals: { type: "string" },
      decks: { type: "string", multiple: true },
      matchups: { type: "string" },
      games: { type: "string" },
      results: { type: "string" },
      out: { type: "string" },
    },
  });
  const runDir = path.resolve(
    values.data ??
      path.join(
        REPO_ROOT,
        "data/runs",
        readdirSync(path.join(REPO_ROOT, "data/runs"))
          .filter((n) => DATED.test(n))
          .sort(compareCodePoints)
          .at(-1) ?? "",
      ),
  );
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const snapshotDirs = (
    values.decks ?? [newestDated("decks", (dir) => deckFiles(dir).length > 0)].filter((d): d is string => d !== undefined)
  ).map((d) => path.resolve(d));
  if (snapshotDirs.length === 0) throw new Error("no deck snapshot under data/originals/decks/<date>/; pass --decks");
  const matchupsDir = values.matchups ?? newestDated("tournaments", (dir) => existsSync(path.join(dir, "matchups.json")));
  const gamesFile = values.games ?? newestGames();
  const outDir = path.resolve(values.out ?? path.join(runDir, "meta"));

  const map = loadCardMap(runDir, originals);
  const featuresFile = path.join(runDir, "features/features.json");
  const facts = cardFacts(JSON.parse(readFileSync(featuresFile, "utf8")));
  const p = progress("meta", { total: null, everyN: 1 });

  const decks: MetaDeck[] = [];
  const listings: Record<string, string> = {};
  const deckStats: Record<string, unknown> = {};
  for (const dir of snapshotDirs) {
    const read = readSnapshot(dir, map, (i) => p.log({ phase: "decks", snapshot: path.basename(dir), files: i }));
    decks.push(...read.decks);
    listings[path.basename(dir)] = read.listing;
    deckStats[path.basename(dir)] = read.stats;
  }
  p.log({ phase: "cluster", decks: decks.length });
  const meta = buildMeta(decks, facts);
  const leaders = new Set(meta.archetypes.map((a) => a.leader.cardKey));

  const outcomeHashes: Record<string, string> = {};
  let matchups: WinRatesFile["matchups"] = null;
  if (matchupsDir !== undefined) {
    const raw = path.join(matchupsDir, "matchups.json");
    const capture = matchupCaptureSchema.parse(JSON.parse(readFileSync(path.join(matchupsDir, "capture.json"), "utf8")));
    const hash = sha256File(raw);
    if (hash !== capture.sha256) throw new Error(`${raw} sha256 ${hash} differs from its capture.json pin ${capture.sha256}`);
    outcomeHashes["tournament-matchups"] = hash;
    matchups = foldMatchups(matchupResponseSchema.parse(JSON.parse(readFileSync(raw, "utf8"))), nameResolver(map, facts), capture.window);
  }
  const cards: CardOutcomes[] = [];
  if (values.results !== undefined) {
    outcomeHashes["tournament-results"] = sha256File(values.results);
    const results = tournamentResultsSchema.parse(JSON.parse(readFileSync(values.results, "utf8")));
    const dates = results.matches
      .map((m) => m.date ?? "")
      .filter((d) => d !== "")
      .sort(compareCodePoints);
    cards.push(
      foldCardOutcomes(
        tournamentGames(results),
        {
          source: "tournament-results",
          rank: 1,
          label: `tournament match results (${results.source})`,
          basis: "card in the side's decklist",
          period: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
        },
        leaders,
        MIN_N,
      ),
    );
  }
  if (gamesFile !== undefined) {
    p.log({ phase: "human games" });
    outcomeHashes["karabast-human"] = sha256File(gamesFile);
    cards.push(
      foldCardOutcomes(
        humanGames(gamesFile),
        {
          source: "karabast-human",
          rank: 2,
          label: "human Karabast online games (secondary, casual play; not tournament)",
          basis: "card seen in play for the side (played, on the board or in the discard)",
          period: { from: null, to: HUMAN_CAPTURED_THROUGH },
        },
        leaders,
        MIN_N,
      ),
    );
  }
  const winrates = winRatesFileSchema.parse({ schemaVersion: 1, minN: MIN_N, matchups, cards });

  mkdirSync(outDir, { recursive: true });
  const outputs: Record<string, string> = {
    "archetypes.json": `${JSON.stringify(metaFileSchema.parse(meta))}\n`,
    "winrates.json": `${JSON.stringify(winrates)}\n`,
  };
  for (const [name, text] of Object.entries(outputs)) writeFileSync(path.join(outDir, name), text);
  const replay = metaReplaySchema.parse({
    inputHash: { decks: listings, "features.json": sha256File(featuresFile), rawManifest: map.rawManifestSha256, outcomes: outcomeHashes },
    codeCommit: codeCommit(),
    outputHash: Object.fromEntries(Object.entries(outputs).map(([name, text]) => [name, sha256Hex(text)])),
  });
  writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(replay, null, 1)}\n`);
  p.done({ archetypes: meta.archetypes.length });
  console.log(
    JSON.stringify(
      {
        outDir,
        window: meta.window,
        primary: meta.primary,
        fallback: meta.fallback,
        populations: meta.populations,
        deckStats,
        matchups:
          matchups === null
            ? null
            : { rows: matchups.rows, unresolvedRows: matchups.unresolvedRows, matches: matchups.matches, pairs: matchups.pairs.length },
        cardSources: cards.map((c) => ({ source: c.source, sides: c.sides, leaders: c.byLeader.length })),
      },
      null,
      1,
    ),
  );
}

main();
