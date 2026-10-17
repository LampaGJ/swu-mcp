/**
 * @displayName Decklist extract
 * @strategicPurpose Manipulation node (reduces): one or more community decklist snapshots in, one deduplicated
 * list of logical-card decks out, so co-inclusion runs on the run's card identities.
 * @tacticalObjective Reads every *.json in each snapshot directory (names starting "_" are indexes), normalises
 * with scripts/bench/decks.ts, dedupes across snapshots, and writes data/originals/decks/decks-<sha12>.json with
 * per-snapshot input hashes, date ranges, set usage and mapping counts.
 *
 * Usage: pnpm bench:extract-decks [--run <dir>] [--originals <dir>] [--snapshot <dir> ...] [--out <dir>]
 *   --snapshot  repeatable; default: /Volumes/Models/swu-data/decks/validated-deduplicated plus every
 *               <swu-mcp>/data/originals/decks/<YYYY-MM-DD>/ that holds deck files
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "./card-map.js";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "./code-commit.js";
import { dedupeDecks, normalizeDeck, type Deck } from "./decks.js";

const LEGACY_SNAPSHOT = "/Volumes/Models/swu-data/decks/validated-deduplicated";
const MAIN_CHECKOUT_DECKS = "/Volumes/Local Files/Projects/swu-mcp/data/originals/decks";

const deckFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("_") && statSync(path.join(dir, f)).isFile())
        .sort(compareCodePoints)
    : [];

export function defaultSnapshots(): string[] {
  const dated = [MAIN_CHECKOUT_DECKS, path.join(REPO_ROOT, "data/originals/decks")]
    .filter((root) => existsSync(root))
    .flatMap((root) =>
      readdirSync(root)
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .map((name) => path.join(root, name)),
    )
    .filter((dir) => deckFiles(dir).length > 0);
  const unique = [...new Map(dated.map((dir) => [path.basename(dir), dir])).values()];
  return [LEGACY_SNAPSHOT, ...unique.sort(compareCodePoints)];
}

function main(): void {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      originals: { type: "string" },
      snapshot: { type: "string", multiple: true },
      out: { type: "string" },
    },
  });
  const runDir = path.resolve(values.run ?? defaultRun());
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const snapshots = (values.snapshot ?? defaultSnapshots()).map((dir) => path.resolve(dir));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/decks"));

  const map = loadCardMap(runDir, originals);
  const iconsByKey = new Map(map.printings.filter((p) => p.serialCode === p.cardKey).map((p) => [p.cardKey, p.aspectIcons]));
  const entries: { snapshot: string; deck: Deck }[] = [];
  const snapshotStats: Record<string, unknown>[] = [];
  const unmappedIds = new Map<string, number>();

  for (const dir of snapshots) {
    const label = path.basename(dir);
    const files = deckFiles(dir);
    const listing = createHash("sha256");
    let invalid = 0;
    let decks = 0;
    let minCreated: string | null = null;
    let maxCreated: string | null = null;
    const setUses = new Map<string, number>();
    for (const file of files) {
      const bytes = readFileSync(path.join(dir, file));
      listing.update(`${file}\u0000${createHash("sha256").update(bytes).digest("hex")}\n`);
      let deck: Deck;
      try {
        deck = normalizeDeck(JSON.parse(bytes.toString("utf8")), map.setNumber.byId, iconsByKey);
      } catch {
        invalid += 1;
        continue;
      }
      decks += 1;
      for (const id of deck.unmapped) unmappedIds.set(id, (unmappedIds.get(id) ?? 0) + 1);
      const raw = JSON.parse(bytes.toString("utf8")) as { deck: { id: string }[] };
      for (const e of raw.deck) {
        const set = e.id.split("_")[0];
        setUses.set(set, (setUses.get(set) ?? 0) + 1);
      }
      if (deck.createdAt !== null) {
        if (minCreated === null || deck.createdAt < minCreated) minCreated = deck.createdAt;
        if (maxCreated === null || deck.createdAt > maxCreated) maxCreated = deck.createdAt;
      }
      entries.push({ snapshot: label, deck });
    }
    snapshotStats.push({
      label,
      dir,
      files: files.length,
      listingSha256: listing.digest("hex"),
      decks,
      invalid,
      createdAt: { min: minCreated, max: maxCreated },
      setUses: Object.fromEntries([...setUses].sort((a, b) => compareCodePoints(a[0], b[0]))),
    });
  }

  const { decks, duplicatesWithinSnapshot, duplicatesAcrossSnapshots } = dedupeDecks(entries);
  const decksText = canonicalJson(decks);
  const sha = sha256Hex(decksText);
  const totalCards = decks.reduce((n, d) => n + d.cards.length, 0);
  const out = {
    kind: "decklists",
    sha256Decks: sha,
    snapshots: snapshotStats,
    dedupe: { inputDecks: entries.length, uniqueDecks: decks.length, duplicatesWithinSnapshot, duplicatesAcrossSnapshots },
    mapping: {
      distinctCardSlots: totalCards,
      decksWithUnmapped: decks.filter((d) => d.unmapped.length > 0).length,
      leaderUnmapped: decks.filter((d) => d.leader === null).length,
      baseUnmapped: decks.filter((d) => d.base === null).length,
      topUnmappedIds: [...unmappedIds].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0])).slice(0, 30),
    },
    runDir: path.basename(runDir),
    rawManifestSha256: map.rawManifestSha256,
    codeCommit: codeCommit(),
    decks,
  };
  mkdirSync(outDir, { recursive: true });
  const outFile = `decks-${sha.slice(0, 12)}.json`;
  writeFileSync(path.join(outDir, outFile), `${JSON.stringify(out)}\n`);
  console.log(
    JSON.stringify(
      {
        outFile,
        snapshots: snapshotStats.map((s) => ({
          label: s.label,
          files: s.files,
          decks: s.decks,
          invalid: s.invalid,
          createdAt: s.createdAt,
        })),
        dedupe: out.dedupe,
        mapping: out.mapping,
      },
      null,
      1,
    ),
  );
}

if (isMain(import.meta.url)) main();
