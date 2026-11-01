/**
 * @displayName Deck index step
 * @strategicPurpose Manipulation node (reduces), pipeline step of build:data (LampaGJ/swu-mcp#193, owner 2026-11-01: "deck_remixer
 * should find cards to replace a given deck by referencing similar decks"): the pinned swumetastats decklist capture, the pinned
 * community (SWUDB) deck snapshot and the run's card map in; data/runs/<date>/deck-index/decks.json and a replay record out, read by
 * the deck_remixer tool. Public deck data only: player names, authors and deck ids are read to be dropped and never leave memory.
 * @tacticalObjective Verifies every raw capture page against its manifest, maps names and SET_NNN ids to the run's cardKeys with the
 * resolver the sleeper step uses, keeps one row per deck (leader, base, aspects, card copies, event, date, whole-event match record and
 * placement where stated) and hands the rows to src/meta/deck-index.ts. The tournament tier is the swumetastats capture alone
 * (the snapshot's own tournament-labelled decks are the same events and are not added); the community tier is the snapshot's lists
 * without an event and placement. The tiers stay apart in the file (D21).
 *
 * Usage: pnpm meta:deck-index [--data <run dir>] [--originals <dir>] [--capture <dir>] [--decks <snapshot dir>] [--out <dir>] [--tournament-days <n>]
 *   --capture          default: the newest data/originals/decklists/<YYYY-MM-DD>/ holding manifest.json
 *   --decks            default: the newest data/originals/decks/<YYYY-MM-DD>/ holding deck files
 *   --tournament-days  keep tournament decks dated within this many days of the newest one (default 180)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DATED_DIR, readJson } from "../../src/data.js";
import { cardFacts } from "../../src/meta/build.js";
import { decklistManifestSchema, decklistRowsPageSchema, statOf } from "../../src/meta/decklist-capture.js";
import { buildDeckIndex, deckIndexReplaySchema, type RawIndexDeck } from "../../src/meta/deck-index.js";
import { FormatRejects, premierVerdict, snapshotDeclaresPremier } from "../../src/meta/format.js";
import { parseMatchRecord } from "../../src/meta/outcomes.js";
import { snapshotDeckSchema } from "../../src/meta/schema.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../bench/card-map.js";
import { codeCommit, defaultRun, REPO_ROOT } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { resolverOf } from "./decklist-resolver.js";

const MAIN_CHECKOUT = "/Volumes/Local Files/Projects/swu-mcp";
const DEFAULT_TOURNAMENT_DAYS = 180;
export const TOURNAMENT_POPULATION =
  "tournament decklists with their whole-event match record (melee.gg Premier events via swumetastats.com)";
export const COMMUNITY_POPULATION = "community decklists without an event or placement (SWUDB, Premier)";

function newestDated(sub: string, holds: (dir: string) => boolean): string | undefined {
  const found = [REPO_ROOT, MAIN_CHECKOUT]
    .map((root) => path.join(root, "data/originals", sub))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((n) => DATED_DIR.test(n))
        .map((n) => path.join(dir, n)),
    )
    .filter(holds);
  return found.sort((a, b) => compareCodePoints(path.basename(a), path.basename(b)) || compareCodePoints(a, b)).at(-1);
}

const deckFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(".json") && !f.startsWith("_") && f !== "manifest.json" && f !== "rejects.json" && statSync(path.join(dir, f)).isFile(),
    )
    .sort(compareCodePoints);

function main(): void {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      originals: { type: "string" },
      capture: { type: "string" },
      decks: { type: "string" },
      out: { type: "string" },
      "tournament-days": { type: "string" },
    },
  });
  const runDir = path.resolve(values.data ?? defaultRun());
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const captureDir = values.capture ?? newestDated("decklists", (dir) => existsSync(path.join(dir, "manifest.json")));
  if (captureDir === undefined)
    throw new Error("no data/originals/decklists/<date>/manifest.json; run pnpm meta:capture-decklists or pass --capture");
  const snapshotDir = values.decks ?? newestDated("decks", (dir) => deckFiles(dir).length > 0);
  if (snapshotDir === undefined) throw new Error("no deck snapshot under data/originals/decks/<date>/; pass --decks");
  const outDir = path.resolve(values.out ?? path.join(runDir, "deck-index"));
  const windowDays = z.coerce
    .number()
    .int()
    .positive()
    .parse(values["tournament-days"] ?? String(DEFAULT_TOURNAMENT_DAYS));
  const p = progress("deck-index", { total: null, everyN: 1 });

  const manifestBytes = readFileSync(path.join(captureDir, "manifest.json"));
  const manifest = decklistManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const rawDir = path.join(captureDir, "raw");
  const listing: string[] = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    const got = sha256Hex(readFileSync(path.join(rawDir, file)));
    if (got !== hash) throw new Error(`${file} sha256 ${got} differs from the capture manifest's ${hash}`);
    listing.push(`${file}\u0000${hash}\n`);
  }
  const rawPagesHash = sha256Hex(listing.sort(compareCodePoints).join(""));
  p.log({ phase: "verified", files: listing.length });

  const map = loadCardMap(runDir, originals);
  const featuresFile = path.join(runDir, "features/features.json");
  const facts = cardFacts(readJson(featuresFile));
  const resolve = resolverOf(
    map,
    (k) => facts.get(k)?.aspectIcons,
    (k) => {
      const f = facts.get(k);
      return f === undefined ? undefined : { cost: f.cost, power: f.power, hp: f.hp, aspects: f.aspectIcons.join("+") };
    },
  );

  // Tournament tier: the swumetastats capture.
  const rows = new Map<string, z.infer<typeof decklistRowsPageSchema>["decklists"][number]>();
  for (const file of Object.keys(manifest.files)
    .filter((f) => f.startsWith("decklists/"))
    .sort(compareCodePoints)) {
    const page = decklistRowsPageSchema.parse(JSON.parse(readFileSync(path.join(rawDir, file), "utf8")));
    for (const row of page.decklists) if (!rows.has(row.guid)) rows.set(row.guid, row);
  }
  const tournamentDrops = { leaderOrBaseNotMapped: 0, leaderNotInPool: 0, noCards: 0, unmappedCardLines: 0 };
  const tournament: RawIndexDeck[] = [];
  let n = 0;
  for (const row of [...rows.values()].sort((a, b) => compareCodePoints(a.guid, b.guid))) {
    n += 1;
    if (n % 5000 === 0) p.log({ phase: "tournament decks", done: n, of: rows.size });
    const leader = resolve.leader(row.leaderCard?.name ?? row.leaderName, row.leaderCard?.set);
    const baseName = row.baseCard?.name ?? row.baseName;
    const baseAspects = resolve.baseAspects(baseName, row.baseCard?.aspect);
    if (leader === null || baseAspects === null) {
      tournamentDrops.leaderOrBaseNotMapped += 1;
      continue;
    }
    const leaderIcons = facts.get(leader)?.aspectIcons;
    if (leaderIcons === undefined) {
      tournamentDrops.leaderNotInPool += 1;
      continue;
    }
    const copies = new Map<string, number>();
    for (const line of row.cards) {
      if (line.section !== "MainDeck" || line.count === 0) continue;
      const key = resolve.card(line.cardName, {
        cost: statOf(line.card?.cost),
        power: statOf(line.card?.power),
        hp: statOf(line.card?.hp),
      });
      if (key === null) tournamentDrops.unmappedCardLines += 1;
      else copies.set(key, (copies.get(key) ?? 0) + line.count);
    }
    if (copies.size === 0) {
      tournamentDrops.noCards += 1;
      continue;
    }
    const record = parseMatchRecord(row.matchRecord);
    tournament.push({
      leader,
      base: resolve.base(baseName),
      aspects: [...leaderIcons, ...baseAspects],
      event: `swumetastats:${row.tournamentId}`,
      date: row.tournament.startDate.slice(0, 10),
      record: record === null ? null : `${record.wins}-${record.losses}-${record.draws}`,
      placement: row.standing != null && row.standing > 0 ? row.standing : null,
      cards: [...copies],
    });
  }
  p.log({ phase: "tournament decks", decks: tournament.length, ...tournamentDrops });

  // Community tier: the snapshot's lists that name no event and placement.
  const files = deckFiles(snapshotDir);
  const snapshotListing: string[] = [];
  const premierSnapshot = snapshotDeclaresPremier(snapshotDir);
  const formatRejects = new FormatRejects();
  const communityDrops = {
    tournamentLabelled: 0,
    invalid: 0,
    undated: 0,
    leaderOrBaseNotMapped: 0,
    leaderNotInPool: 0,
    noCards: 0,
    unmappedCards: 0,
  };
  const sources = new Set<string>();
  const community: RawIndexDeck[] = [];
  files.forEach((file, i) => {
    if (i % 5000 === 0) p.log({ phase: "snapshot", done: i, of: files.length });
    const bytes = readFileSync(path.join(snapshotDir, file));
    snapshotListing.push(`${file}\u0000${sha256Hex(bytes)}\n`);
    const raw: unknown = JSON.parse(bytes.toString("utf8"));
    const verdict = premierVerdict(raw, premierSnapshot);
    if (!verdict.keep) {
      formatRejects.add(verdict.reason);
      return;
    }
    const parsed = snapshotDeckSchema.safeParse(raw);
    if (!parsed.success) {
      communityDrops.invalid += 1;
      return;
    }
    const d = parsed.data;
    const event = d.metadata?.event;
    const hasEvent = event !== undefined && event !== null && (event.id !== undefined || event.name !== undefined);
    if (hasEvent && (d.metadata?.placement ?? null) !== null) {
      communityDrops.tournamentLabelled += 1;
      return;
    }
    const createdAt = d.metadata?.createdAt;
    if (createdAt === undefined || !DATED_DIR.test(createdAt.slice(0, 10))) {
      communityDrops.undated += 1;
      return;
    }
    const leader = map.setNumber.byId.get(d.leader.id);
    const base = map.setNumber.byId.get(d.base.id);
    if (leader === undefined || base === undefined) {
      communityDrops.leaderOrBaseNotMapped += 1;
      return;
    }
    const leaderIcons = facts.get(leader)?.aspectIcons;
    const baseIcons = facts.get(base)?.aspectIcons;
    if (leaderIcons === undefined || baseIcons === undefined) {
      communityDrops.leaderNotInPool += 1;
      return;
    }
    const copies = new Map<string, number>();
    for (const e of d.deck) {
      const key = map.setNumber.byId.get(e.id);
      if (key === undefined) {
        communityDrops.unmappedCards += 1;
        continue;
      }
      if (e.count !== 0) copies.set(key, (copies.get(key) ?? 0) + (e.count ?? 1));
    }
    if (copies.size === 0) {
      communityDrops.noCards += 1;
      return;
    }
    sources.add(d.metadata?.source ?? "unknown");
    community.push({
      leader,
      base,
      aspects: [...leaderIcons, ...baseIcons],
      event: null,
      date: createdAt.slice(0, 10),
      record: null,
      placement: null,
      cards: [...copies],
    });
  });
  p.log({ phase: "snapshot", decks: community.length, ...communityDrops });

  const file = buildDeckIndex([
    {
      tier: "tournament",
      source: "swumetastats.com",
      population: TOURNAMENT_POPULATION,
      capture: `pinned swumetastats capture ${manifest.snapshot}`,
      windowDays,
      decks: tournament,
    },
    {
      tier: "community",
      source: [...sources].sort(compareCodePoints).join(", ") || "none",
      population: COMMUNITY_POPULATION,
      capture: `pinned deck snapshot ${path.basename(snapshotDir)}`,
      decks: community,
    },
  ]);
  mkdirSync(outDir, { recursive: true });
  const text = `${JSON.stringify(file)}\n`;
  writeFileSync(path.join(outDir, "decks.json"), text);
  const replay = deckIndexReplaySchema.parse({
    inputHash: {
      captureManifest: sha256Hex(manifestBytes),
      rawPages: rawPagesHash,
      deckSnapshot: sha256Hex(snapshotListing.join("")),
      "features.json": sha256Hex(readFileSync(featuresFile)),
      rawManifest: map.rawManifestSha256,
    },
    codeCommit: codeCommit(),
    outputHash: { "decks.json": sha256Hex(text) },
  });
  writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(replay, null, 1)}\n`);
  p.done({ tournament: file.tiers[0].decks, community: file.tiers[1].decks });
  console.log(
    JSON.stringify(
      {
        outDir,
        capture: captureDir,
        snapshot: snapshotDir,
        rawDecklists: rows.size,
        tournamentDrops,
        communityDrops,
        formatRejects: formatRejects.toJSON(),
        tiers: file.tiers.map((t) => ({ tier: t.tier, decks: t.decks, events: t.events, withRecord: t.withRecord, window: t.window })),
        cardKeys: file.cardKeys.length,
        bytes: text.length,
      },
      null,
      1,
    ),
  );
}

main();
