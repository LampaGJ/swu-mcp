/**
 * @displayName Warrior deck export (SWUDB JSON)
 * @strategicPurpose #204: hand the owner the best-performing Warrior decks as SWUDB interchange JSON, each tier
 * labelled and never pooled (D21), with the rank basis and input hashes beside every deck.
 * @tacticalObjective Tier 1 scans the tournament deck snapshot for Warrior decks that carry a placement; tier 2
 * applies each sim-ladder tuning's swaps to the pinned fixture deck and ranks them per ladder file by bot win share.
 * Deterministic: no clock, no randomness, code-point sorting; the same pinned inputs give byte-identical files.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareCodePoints } from "../src/swu/canonical.js";
import { swudbDeckSchema, type SwudbDeck } from "../src/tools/swudb.js";
import { progress } from "./lib/progress.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "tests/fixtures/decks/warrior-chewie-raid.swudb.json";
const LADDER_DIR = "data/pinned/sim-ladder-v1";
const LADDER_FILES = ["warrior-deck-rung1.json", "warrior-deck-rung3.json", "warrior-deck-rung3v.json"];
const OUT_DIR = "data/pinned/warrior-decks-v1";

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

const wilsonSchema = z.strictObject({ wins: z.number().int(), n: z.number().int(), share: z.number(), low: z.number(), high: z.number() });
const variantSchema = z.looseObject({
  name: z.string().min(1),
  file: z.string().min(1),
  swaps: z.array(z.string().regex(/^[A-Z0-9]{2,5}_\d{3}>[A-Z0-9]{2,5}_\d{3}$/)),
  share: wilsonSchema,
});
const ladderSchema = z.looseObject({
  step: z.string().min(1),
  label: z.string().min(1),
  policy: z.looseObject({ spec: z.string().min(1) }),
  results: z.array(variantSchema).min(1),
});
type Variant = z.infer<typeof variantSchema>;

const tournamentDeckSchema = z.looseObject({
  metadata: z.looseObject({ source: z.string().optional(), placement: z.number().int().nullish() }),
  leader: z.looseObject({ id: z.string() }),
});

/** Replace one copy of `from` with `to` for each swap, in order; a swap whose source is absent is an error. */
export function applySwaps(deck: SwudbDeck, swaps: readonly string[]): SwudbDeck {
  const counts = new Map<string, number>();
  for (const e of deck.deck) counts.set(e.id, (counts.get(e.id) ?? 0) + e.count);
  for (const s of swaps) {
    const [from, to] = s.split(">") as [string, string];
    const have = counts.get(from) ?? 0;
    if (have < 1) throw new Error(`swap ${s}: ${from} is not in the deck`);
    if (have === 1) counts.delete(from);
    else counts.set(from, have - 1);
    counts.set(to, (counts.get(to) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => compareCodePoints(a[0], b[0])).map(([id, count]) => ({ id, count }));
  return swudbDeckSchema.parse({ ...deck, deck: entries });
}

/** Tunings only: a "control" row is a deliberately weakened measurement probe, never a candidate. Highest share first. */
export function rankVariants(variants: readonly Variant[]): Variant[] {
  return variants
    .filter((v) => !v.name.includes("control"))
    .sort((a, b) => b.share.share - a.share.share || compareCodePoints(a.name, b.name));
}

function exportSim(): { decks: Record<string, unknown>[]; files: Map<string, string> } {
  const fixtureText = readFileSync(path.join(REPO_ROOT, FIXTURE), "utf8");
  const fixture = swudbDeckSchema.parse(JSON.parse(fixtureText));
  const files = new Map<string, string>();
  const byHash = new Map<string, { id: string; swaps: string[]; deckHash: string; results: Record<string, unknown>[] }>();
  for (const f of LADDER_FILES) {
    const text = readFileSync(path.join(REPO_ROOT, LADDER_DIR, f), "utf8");
    const ladder = ladderSchema.parse(JSON.parse(text));
    const inputHash = sha256(text);
    const ranked = rankVariants(ladder.results);
    ranked.forEach((v, i) => {
      if (v.file !== FIXTURE) throw new Error(`${f}: ${v.name} runs ${v.file}, not the pinned fixture`);
      const swaps = [...v.swaps].sort(compareCodePoints);
      const doc = applySwaps(fixture, swaps);
      const body = json({ ...doc, metadata: { name: `Warrior (The Warrior, Deft Duelist) sim ${swaps.length === 0 ? "base" : swaps.join(" ")}` } });
      const deckHash = sha256(body);
      const entry = byHash.get(deckHash) ?? { id: `warrior-${deckHash.slice(0, 12)}`, swaps, deckHash, results: [] };
      entry.results.push({
        ladderFile: `${LADDER_DIR}/${f}`,
        ladderFileSha256: inputHash,
        botPolicy: ladder.policy.spec,
        label: ladder.label,
        variant: v.name,
        rankInFile: i + 1,
        of: ranked.length,
        wins: v.share.wins,
        games: v.share.n,
        winShare: v.share.share,
        wilson95: [v.share.low, v.share.high],
      });
      byHash.set(deckHash, entry);
      files.set(`sim/${entry.id}.swudb.json`, body);
    });
  }
  const decks = [...byHash.values()]
    .sort((a, b) => compareCodePoints(a.id, b.id))
    .map((d) => ({
      file: `sim/${d.id}.swudb.json`,
      deckSha256: d.deckHash,
      source: "sim-ladder (forceteki bot play, not human results)",
      population: "6 tournament archetypes of the panel, 300 games each per ladder file (1800 games), bot vs bot",
      baseDeckInput: { file: FIXTURE, sha256: sha256(fixtureText) },
      swapsFromBase: d.swaps,
      resultsByLadderFile: d.results,
    }));
  return { decks, files };
}

function exportTournament(dir: string): Record<string, unknown> {
  const manifestText = readFileSync(path.join(dir, "manifest.json"), "utf8");
  const warriorLeader = swudbDeckSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, FIXTURE), "utf8"))).leader.id;
  const names = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "manifest.json" && n !== "rejects.json").sort(compareCodePoints);
  const p = progress("export-warrior-decks", { total: names.length, everyN: 2000 });
  const warrior: { name: string; sha256: string; source: string; placed: boolean }[] = [];
  let placed = 0;
  let unparsed = 0;
  names.forEach((n, i) => {
    const text = readFileSync(path.join(dir, n), "utf8");
    const parsed = tournamentDeckSchema.safeParse(JSON.parse(text));
    if (!parsed.success) unparsed += 1;
    else {
      const hasPlacement = parsed.data.metadata.placement !== undefined && parsed.data.metadata.placement !== null;
      if (hasPlacement) placed += 1;
      if (parsed.data.leader.id === warriorLeader) warrior.push({ name: n, sha256: sha256(text), source: parsed.data.metadata.source ?? "unknown", placed: hasPlacement });
    }
    p.tick(i + 1, { warrior: warrior.length });
  });
  p.done({ warrior: warrior.length });
  const bySource: Record<string, number> = {};
  for (const w of warrior) bySource[w.source] = (bySource[w.source] ?? 0) + 1;
  return {
    source: "swumetastats tournament decklists (melee.gg) joined to placements, snapshot " + path.basename(dir),
    definition: `Warrior = leader ${warriorLeader} (The Warrior, Deft Duelist), the leader of the pinned Warrior fixture ${FIXTURE}`,
    snapshotManifestSha256: sha256(manifestText),
    snapshotDecksScanned: names.length,
    snapshotDecksUnparsed: unparsed,
    snapshotDecksWithPlacement: placed,
    warriorDecksTotal: warrior.length,
    warriorDecksBySource: Object.fromEntries(Object.entries(bySource).sort((a, b) => compareCodePoints(a[0], b[0]))),
    warriorDecksWithPlacement: warrior.filter((w) => w.placed).length,
    warriorListingSha256: sha256(warrior.map((w) => `${w.name} ${w.sha256}`).join("\n")),
    decks: [],
    rankBasis: "none: no Warrior deck in the snapshot carries a placement, so nothing can be ranked by results",
    note: "Community decks (SWUDB, no placement) are a lower tier under the play-data precedence and are not exported here; never pooled with tournament results.",
  };
}

function main(): void {
  const dirArg = process.argv.indexOf("--originals");
  const dir = path.resolve(REPO_ROOT, dirArg === -1 ? "data/originals/decks/2026-10-17" : (process.argv[dirArg + 1] ?? ""));
  const outRoot = path.join(REPO_ROOT, OUT_DIR);
  const sim = exportSim();
  const tournament = exportTournament(dir);
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(path.join(outRoot, "sim"), { recursive: true });
  for (const [rel, body] of sim.files) writeFileSync(path.join(outRoot, rel), body);
  const manifest = {
    schemaVersion: 1,
    issue: "#204",
    format: "SWUDB JSON interchange, validated by swudbDeckSchema (src/tools/swudb.ts)",
    tiers: "tournament and sim are separate populations and are never pooled (D21)",
    tournament,
    sim: {
      rankBasis:
        "Within one ladder file: win share of the deck against the 6 panel archetypes (1800 games), highest first; control rows (deliberately weakened probes) excluded. Ranks are per ladder file because each file is a different bot policy; no cross-file ranking.",
      decks: sim.decks,
    },
  };
  writeFileSync(path.join(outRoot, "manifest.json"), json(manifest));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
