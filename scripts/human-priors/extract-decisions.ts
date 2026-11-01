/**
 * @displayName Human-game decision extract
 * @strategicPurpose Manipulation node (reduces): the private Karabast spectator JSONL in (read in place, never
 * copied), one actor-relative decision record per unique row out, so the human-prior models (#181, D102) train on
 * decisions with the board they were made on and never see a player name or id.
 * @tacticalObjective Streams every training-*.jsonl line by line through the strict boundary in decisions.ts,
 * groups rows by hashed game, builds each game's records, and writes a gzipped JSONL sorted by game key plus a
 * manifest {inputHash, codeCommit, outputHash} with counts and card-mapping coverage. Two passes over the in-memory
 * games (hash, then write) name the output by its own hash without a rename.
 *
 * Usage: node --max-old-space-size=16384 node_modules/tsx/dist/cli.mjs scripts/human-priors/extract-decisions.ts [--input <dir>] [--out <dir>] [--run <dir>] [--originals <dir>]
 *   --input  default /Volumes/Models/swu/human-games (read-only)
 *   --out    default data/originals/karabast/decisions (git-ignored; private player data under D22)
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { finished } from "node:stream/promises";
import { parseArgs } from "node:util";
import { createGzip } from "node:zlib";
import { z } from "zod";
import { loadStore } from "../../src/data.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";
import { cardFirstOrder, releaseDatesFromDefinitions, sourceWindow, UNKNOWN_ORDER } from "../bench/availability.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap, normalizeName, setNumberId, type CardMap } from "../bench/card-map.js";
import { codeCommit as headCommit, defaultRun, isMain, REPO_ROOT } from "../bench/code-commit.js";
import { HUMAN_CAPTURED_THROUGH } from "../bench/extract-games.js";
import { ACTION_KINDS, boundaryRow, decisionsForGame, serializeRecords, type CardResolver, type DecisionRecord, type ParsedRow } from "./decisions.js";

export const DEFAULT_HUMAN_INPUT = "/Volumes/Models/swu/human-games";
export const DEFAULT_DECISIONS_DIR = path.join(REPO_ROOT, "data/originals/karabast/decisions");

const count = z.int().min(0);
const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const manifestSchema = z.strictObject({
  kind: z.literal("karabast-human-decisions"),
  schemaVersion: z.literal(1),
  inputHash: hex64,
  codeCommit: z.string().min(1),
  outputHash: hex64,
  output: z.strictObject({ file: z.string(), records: count, games: count }),
  inputs: z.array(z.strictObject({ file: z.string(), bytes: count, sha256: hex64, rows: count, invalidRows: count, duplicateRows: count })),
  totals: z.strictObject({ rows: count, invalidRows: count, duplicateRows: count, uniqueRows: count, games: count, records: count }),
  kinds: z.record(z.string(), count),
  seat: z.strictObject({ gamesVoted: count, gamesUnvoted: count }),
  flags: z.strictObject({ undone: count, revert: count, repeat: count }),
  attacks: z.strictObject({ rows: count, withBefore: count, chosenMatched: count, meanOptions: z.number() }),
  mapping: z.strictObject({
    cardRefs: count,
    cardResolved: count,
    unitTargets: count,
    unitTargetsResolved: count,
    boardUnits: count,
    boardUnitsResolved: count,
    leaders: count,
    leadersResolved: count,
  }),
});
export type DecisionsManifest = z.infer<typeof manifestSchema>;

export interface ExtractOptions {
  inputDir: string;
  outDir: string;
  resolver: CardResolver;
  codeCommit: string;
  progressJob?: string;
}

/** Streams the inputs, builds every game's records and writes them; returns the manifest it wrote. */
export async function extractDecisions(o: ExtractOptions): Promise<DecisionsManifest> {
  const files = readdirSync(o.inputDir)
    .filter((f) => /^training-.*\.jsonl$/.test(f))
    .sort(compareCodePoints);
  const totalBytes = files.reduce((n, f) => n + statSync(path.join(o.inputDir, f)).size, 0);
  const p = progress(o.progressJob ?? "human-priors-extract", { total: totalBytes, everyMs: 5000 });
  const games = new Map<string, ParsedRow[]>();
  const seen = new Set<string>();
  const inputs: DecisionsManifest["inputs"] = [];
  let bytesDone = 0;

  for (const [fileIndex, file] of files.entries()) {
    const full = path.join(o.inputDir, file);
    const hash = createHash("sha256");
    const stream = createReadStream(full);
    stream.on("data", (chunk) => {
      hash.update(chunk);
      bytesDone += chunk.length;
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const stats = { rows: 0, invalid: 0, duplicate: 0 };
    let line = -1;
    for await (const text of rl) {
      line++;
      if (text.trim() === "") continue;
      stats.rows++;
      // The 500-float feature vector comes first and is never read; parsing from "label" skips it.
      const at = text.indexOf('"label":');
      let raw: unknown;
      try {
        raw = JSON.parse(at < 0 ? text : "{" + text.slice(at));
      } catch {
        stats.invalid++;
        continue;
      }
      const row = boundaryRow(raw, { file: fileIndex, line });
      if (row === null) {
        stats.invalid++;
        continue;
      }
      if (seen.has(row.key)) {
        stats.duplicate++;
        continue;
      }
      seen.add(row.key);
      let g = games.get(row.game);
      if (g === undefined) {
        g = [];
        games.set(row.game, g);
      }
      g.push(row);
      if (stats.rows % 20000 === 0) p.tick(bytesDone, { phase: "read", file, rows: stats.rows, games: games.size });
    }
    inputs.push({ file, bytes: statSync(full).size, sha256: hash.digest("hex"), rows: stats.rows, invalidRows: stats.invalid, duplicateRows: stats.duplicate });
  }

  const keys = [...games.keys()].sort(compareCodePoints);
  const recordsOf = (g: string): DecisionRecord[] => decisionsForGame(games.get(g) as ParsedRow[], o.resolver);

  const body = createHash("sha256");
  const kinds: Record<string, number> = Object.fromEntries(ACTION_KINDS.map((k) => [k, 0]));
  const seat = { gamesVoted: 0, gamesUnvoted: 0 };
  const flags = { undone: 0, revert: 0, repeat: 0 };
  const attacks = { rows: 0, withBefore: 0, chosenMatched: 0, options: 0 };
  const mapping = { cardRefs: 0, cardResolved: 0, unitTargets: 0, unitTargetsResolved: 0, boardUnits: 0, boardUnitsResolved: 0, leaders: 0, leadersResolved: 0 };
  let records = 0;
  for (const [n, g] of keys.entries()) {
    const recs = recordsOf(g);
    body.update(serializeRecords(recs), "utf8");
    records += recs.length;
    if (recs.some((r) => r.seat !== null)) seat.gamesVoted++;
    else seat.gamesUnvoted++;
    for (const r of recs) {
      kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
      if (r.flags.undone) flags.undone++;
      if (r.flags.revert) flags.revert++;
      if (r.flags.repeat) flags.repeat++;
      if (r.cardRef) {
        mapping.cardRefs++;
        if (r.card !== null) mapping.cardResolved++;
      }
      if (r.targetRef && r.target !== "base") {
        mapping.unitTargets++;
        if (r.target !== null) mapping.unitTargetsResolved++;
      }
      for (const u of r.before === null ? [] : [...r.before.me, ...r.before.opp]) {
        mapping.boardUnits++;
        if (u.card !== null) mapping.boardUnitsResolved++;
      }
      mapping.leaders += 1;
      if (r.me.leader !== null) mapping.leadersResolved++;
      if (r.attacks !== undefined) {
        attacks.rows++;
        if (r.before !== null) attacks.withBefore++;
        if (r.attacks.chosen !== null) attacks.chosenMatched++;
        attacks.options += r.attacks.options.length;
      }
    }
    if (n % 2000 === 0) p.tick(totalBytes, { phase: "hash", games: n, of: keys.length });
  }
  const outputHash = body.digest("hex");
  const outFile = "decisions-" + outputHash.slice(0, 12) + ".jsonl.gz";
  mkdirSync(o.outDir, { recursive: true });
  const gz = createGzip({ level: 6 });
  const sink = createWriteStream(path.join(o.outDir, outFile));
  gz.pipe(sink);
  const check = createHash("sha256");
  for (const [n, g] of keys.entries()) {
    const text = serializeRecords(recordsOf(g));
    check.update(text, "utf8");
    if (!gz.write(text, "utf8")) await new Promise((r) => gz.once("drain", r));
    if (n % 2000 === 0) p.tick(totalBytes, { phase: "write", games: n, of: keys.length });
  }
  gz.end();
  await finished(sink);
  if (check.digest("hex") !== outputHash) throw new Error("decision records differ between the hash pass and the write pass: the build is not deterministic");

  const manifest: DecisionsManifest = manifestSchema.parse({
    kind: "karabast-human-decisions",
    schemaVersion: 1,
    inputHash: sha256Hex(canonicalJson(inputs.map((i) => ({ file: i.file, sha256: i.sha256 })))),
    codeCommit: o.codeCommit,
    outputHash,
    output: { file: outFile, records, games: keys.length },
    inputs,
    totals: {
      rows: inputs.reduce((n, i) => n + i.rows, 0),
      invalidRows: inputs.reduce((n, i) => n + i.invalidRows, 0),
      duplicateRows: inputs.reduce((n, i) => n + i.duplicateRows, 0),
      uniqueRows: seen.size,
      games: keys.length,
      records,
    },
    kinds,
    seat,
    flags,
    attacks: { rows: attacks.rows, withBefore: attacks.withBefore, chosenMatched: attacks.chosenMatched, meanOptions: Math.round((attacks.options / Math.max(1, attacks.withBefore)) * 1e4) / 1e4 },
    mapping,
  });
  writeFileSync(path.join(o.outDir, "decisions-" + outputHash.slice(0, 12) + ".manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  p.done({ records, games: keys.length, outFile });
  return manifest;
}

/**
 * Resolves card references against the run's printings: printed set numbers first, then unique normalised names,
 * narrowed to cards released by the end of the capture when a name has several printings' cards.
 */
export function cardMapResolver(map: CardMap, releaseDates: ReadonlyMap<string, string>, storeCards: readonly { cardKey: string; type?: unknown; title?: unknown }[] = []): CardResolver {
  // Token titles resolve as the vocabulary aliases them: the first key of the (type, title) group by code point (src/sims/vocab.ts ALIAS_RULE).
  const tokenUnits = new Map<string, string>();
  const tokenUpgrades = new Set<string>();
  for (const c of [...storeCards].sort((x, y) => compareCodePoints(x.cardKey, y.cardKey))) {
    const type = String(c.type ?? "");
    const norm = normalizeName(String(c.title ?? ""));
    if (type === "Token Unit" && !tokenUnits.has(norm)) tokenUnits.set(norm, c.cardKey);
    if (type === "Token Upgrade") tokenUpgrades.add(norm);
  }
  const firstOrder = cardFirstOrder(map.printings);
  const reaches = sourceWindow("karabast-human", HUMAN_CAPTURED_THROUGH, releaseDates, new Map()).reachesOrder;
  const narrow = (hits: readonly string[] | undefined): string | null => {
    if (hits === undefined || hits.length === 0) return null;
    if (hits.length === 1) return hits[0];
    const live = hits.filter((k) => (firstOrder.get(k) ?? UNKNOWN_ORDER) <= reaches);
    return live.length === 1 ? live[0] : null;
  };
  /** One full "Title, Subtitle" printed under several keys (starter-deck reprints) is one card: the earliest printing's key. */
  const earliest = (hits: readonly string[] | undefined): string | null => {
    const live = (hits ?? []).filter((k) => (firstOrder.get(k) ?? UNKNOWN_ORDER) <= reaches);
    return live.length === 0 ? null : [...live].sort((x, y) => (firstOrder.get(x) ?? UNKNOWN_ORDER) - (firstOrder.get(y) ?? UNKNOWN_ORDER) || compareCodePoints(x, y))[0];
  };
  const aspectsOf = new Map<string, string[]>();
  const typeOf = new Map<string, string>();
  for (const pr of map.printings) {
    if (!aspectsOf.has(pr.cardKey)) aspectsOf.set(pr.cardKey, pr.aspectIcons.map((x) => x.toLowerCase()));
    typeOf.set(pr.cardKey, pr.type);
  }
  /** Title (or "Title, Subtitle") of one type; several such cards narrow to the release window, then to those whose icons the side shows. */
  const typed = (type: string, title: string, aspects: readonly string[]): string | null => {
    const norm = normalizeName(title);
    const hits = [...new Set([...(map.names.get(type.toLowerCase() + "::" + norm) ?? []), ...(map.names.get(norm) ?? []).filter((k) => typeOf.get(k) === type)])].sort(compareCodePoints);
    const one = narrow(hits);
    if (one !== null || hits.length < 2) return one;
    const live = hits.filter((k) => (firstOrder.get(k) ?? UNKNOWN_ORDER) <= reaches);
    const shown = new Set(aspects.map((x) => x.toLowerCase()));
    const fit = (live.length > 0 ? live : hits).filter((k) => (aspectsOf.get(k) ?? []).every((x) => shown.has(x)));
    return fit.length === 1 ? fit[0] : null;
  };
  const cache = new Map<string, string | null>();
  const memo = (key: string, f: () => string | null): string | null => {
    if (!cache.has(key)) cache.set(key, f());
    return cache.get(key) as string | null;
  };
  return {
    setId: (set, number) => map.setNumber.byId.get(setNumberId(set, number)) ?? null,
    name: (name) =>
      memo("n\u0001" + name, () => {
        const norm = normalizeName(name);
        return narrow(map.names.get(norm)) ?? narrow(map.names.get("title::" + norm)) ?? tokenUnits.get(norm) ?? (norm.includes(", ") ? earliest(map.names.get(norm)) : null);
      }),
    upgradeToken: (name) => tokenUpgrades.has(normalizeName(name)),
    leader: (title, aspects) => memo("l\u0001" + title + "\u0001" + aspects.join(","), () => typed("Leader", title, aspects)),
    base: (title, aspects) => memo("b\u0001" + title + "\u0001" + aspects.join(","), () => typed("Base", title, aspects)),
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { input: { type: "string" }, out: { type: "string" }, run: { type: "string" }, originals: { type: "string" } } });
  const runDir = path.resolve(values.run ?? defaultRun());
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const map = loadCardMap(runDir, originals);
  const store = loadStore(runDir);
  const releaseDates = releaseDatesFromDefinitions(store.facets.get("expansion") ?? []);
  const manifest = await extractDecisions({
    inputDir: path.resolve(values.input ?? DEFAULT_HUMAN_INPUT),
    outDir: path.resolve(values.out ?? DEFAULT_DECISIONS_DIR),
    resolver: cardMapResolver(map, releaseDates, store.cards),
    codeCommit: headCommit(),
  });
  console.log(JSON.stringify({ output: manifest.output, outputHash: manifest.outputHash, inputHash: manifest.inputHash, codeCommit: manifest.codeCommit, totals: manifest.totals }, null, 1));
}

if (isMain(import.meta.url)) await main();
