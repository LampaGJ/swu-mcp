/**
 * @displayName Tournament-winner panel step
 * @strategicPurpose Manipulation node (reduces), the opponent side of the deck gauntlet (#198): ideas are measured against
 * lists that won real events, not hand-picked ones. Tournament results joined to decklists and placements are the top
 * tier of the owner's play-data order, so the panel is built from the pinned swumetastats capture alone (melee.gg Premier
 * events); no Karabast data and no player name, player id or deck id reaches the output.
 * @tacticalObjective Verifies every raw capture page against its manifest, maps leader, base and card names to cardKeys
 * with the resolver the sleeper and deck-index steps use, keeps the lists dated inside the window (default: the newest meta
 * period in the capture's meta-boundaries.json holding at least --min-lists resolved lists), and hands them to buildTournamentPanel (src/sims/gauntlet.ts): the
 * best-placed complete list the pinned engine can build for each of the top K archetypes (leader plus base aspects), each
 * naming its event, placement, record and date, plus the best list per named leader as gauntlet references. Writes the panel
 * and a replay record (input hashes, code commit, output hash) under data/pinned/sim-panels/. Same inputs, same bytes.
 *
 *   node --import tsx scripts/sims/tournament-panel.ts [--capture <dir>] [--run <dir>] [--top 8] [--min-lists 200] [--from <date> --to <date>] [--leaders k1,k2] [--out <dir>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore, readJson } from "../../src/data.js";
import { cardFacts } from "../../src/meta/build.js";
import { boundariesSchema, decklistManifestSchema, decklistRowsPageSchema, statOf, tournamentPageSchema } from "../../src/meta/decklist-capture.js";
import { parseMatchRecord } from "../../src/meta/outcomes.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { buildTournamentPanel, PANEL_VERSION, panelFileSchema, type PanelCandidate } from "../../src/sims/gauntlet.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../bench/card-map.js";
import { codeCommit } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";
import { resolverOf } from "../meta/decklist-resolver.js";
import { loadCardBridge } from "./card-bridge.js";

export const PANEL_POPULATION = "tournament decklists with placement and whole-event match record (melee.gg Premier events via swumetastats.com)";
export const PANEL_TIER = "tournament results joined to decklists and placements (the top tier of the owner's play-data order)";

const replaySchema = z.strictObject({
  inputHash: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  codeCommit: z.string().min(7),
  outputHash: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});

function main(): void {
  const { values } = parseArgs({
    options: {
      capture: { type: "string", default: path.join(REPO_ROOT, "data/originals/decklists/2026-11-01") },
      run: { type: "string", default: path.join(REPO_ROOT, "data/runs/2026-10-31") },
      originals: { type: "string", default: path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16") },
      forceteki: { type: "string", default: DEFAULT_FORCETEKI },
      top: { type: "string", default: "8" },
      "min-lists": { type: "string", default: "200" },
      from: { type: "string" },
      to: { type: "string" },
      leaders: { type: "string", default: "" },
      out: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-panels") },
    },
  });
  const captureDir = path.resolve(values.capture);
  const runDir = path.resolve(values.run);
  const top = z.coerce.number().int().min(1).max(20).parse(values.top);
  const minLists = z.coerce.number().int().min(1).parse(values["min-lists"]);
  const leaders = values.leaders
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const l of leaders) if (!/^[0-9]{6,9}$/.test(l)) throw new Error(`--leaders takes cardKeys; ${l} is not one`);
  const p = progress("tournament-panel", { total: null, everyN: 1 });
  // The widget shows this as the job name (#200).
  const label = "Tournament panel";

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
  p.log({ label, phase: "verified", files: listing.length });

  const sizes = new Map<number, number | null>();
  const rows = new Map<string, z.infer<typeof decklistRowsPageSchema>["decklists"][number]>();
  for (const file of Object.keys(manifest.files).sort(compareCodePoints)) {
    if (file.startsWith("tournaments/")) for (const t of tournamentPageSchema.parse(JSON.parse(readFileSync(path.join(rawDir, file), "utf8"))).tournaments) sizes.set(t.id, t.playerCount ?? null);
    if (file.startsWith("decklists/")) for (const row of decklistRowsPageSchema.parse(JSON.parse(readFileSync(path.join(rawDir, file), "utf8"))).decklists) if (!rows.has(row.guid)) rows.set(row.guid, row);
  }

  const map = loadCardMap(runDir, path.resolve(values.originals));
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
  const drops = { leaderOrBaseNotMapped: 0 };
  const candidates: PanelCandidate[] = [];
  // The guid orders the walk only; it is dropped with the row.
  for (const row of [...rows.values()].sort((a, b) => compareCodePoints(a.guid, b.guid))) {
    const date = row.tournament.startDate.slice(0, 10);
    const leader = resolve.leader(row.leaderCard?.name ?? row.leaderName, row.leaderCard?.set);
    const baseName = row.baseCard?.name ?? row.baseName;
    const baseAspects = resolve.baseAspects(baseName, row.baseCard?.aspect);
    if (leader === null || baseAspects === null) {
      drops.leaderOrBaseNotMapped++;
      continue;
    }
    const copies = new Map<string, number>();
    let unmappedLines = 0;
    for (const line of row.cards) {
      if (line.section !== "MainDeck" || line.count === 0) continue;
      const key = resolve.card(line.cardName, { cost: statOf(line.card?.cost), power: statOf(line.card?.power), hp: statOf(line.card?.hp) });
      if (key === null) unmappedLines++;
      else copies.set(key, (copies.get(key) ?? 0) + line.count);
    }
    const record = parseMatchRecord(row.matchRecord);
    candidates.push({
      leader,
      base: resolve.base(baseName),
      baseAspects,
      event: `swumetastats:${row.tournamentId}`,
      eventSize: sizes.get(row.tournamentId) ?? null,
      date,
      placement: row.standing != null && row.standing > 0 ? row.standing : null,
      record: record === null ? null : { wins: record.wins, losses: record.losses, draws: record.draws },
      cards: [...copies].sort((a, b) => compareCodePoints(a[0], b[0])),
      unmappedLines,
    });
  }
  p.log({ label, phase: "resolved", lists: candidates.length, ...drops });

  // A new set's period can hold no captured event yet, so the default is the newest period with enough lists to rank.
  const boundaries = boundariesSchema.parse(JSON.parse(readFileSync(path.join(rawDir, "meta-boundaries.json"), "utf8")));
  const inside = (d: string, from: string, to: string): boolean => compareCodePoints(d, from) >= 0 && compareCodePoints(d, to) <= 0;
  let window: { from: string; to: string; label: string };
  if (values.from !== undefined || values.to !== undefined) window = { from: z.iso.date().parse(values.from), to: z.iso.date().parse(values.to), label: "window given on the command line" };
  else {
    const passed: string[] = [];
    const periods = [...boundaries].sort((a, b) => compareCodePoints(b.start, a.start));
    const hit = periods.find((b) => {
      const n = candidates.filter((c) => inside(c.date, b.start, b.end ?? manifest.window.to)).length;
      if (n < minLists) passed.push(`${b.label} (${n} lists)`);
      return n >= minLists;
    });
    if (hit === undefined) throw new Error(`no meta period holds ${minLists} resolved lists; pass --from and --to`);
    window = { from: hit.start, to: hit.end ?? manifest.window.to, label: `${hit.label}, the newest meta period with at least ${minLists} captured lists${passed.length > 0 ? `; newer: ${passed.join(", ")}` : ""}` };
  }

  const bridge = loadCardBridge(runDir, path.resolve(values.originals), values.forceteki);
  const panel = buildTournamentPanel(candidates, {
    top,
    window,
    referenceLeaders: leaders,
    unbuildable: (deck) => [deck.leader, deck.base, ...deck.cards.map((c) => c.cardKey)].filter((k) => bridge.toEngine(k) === null),
  });
  const store = loadStore(runDir);
  const titleOf = (k: string): string => {
    const row = store.byKey.get(k);
    return row === undefined ? k : [row.title, row.subtitle].filter((s) => typeof s === "string" && s !== "").join(", ");
  };
  const file = panelFileSchema.parse({
    kind: "sim-tournament-panel",
    version: PANEL_VERSION,
    source: "swumetastats.com",
    population: PANEL_POPULATION,
    tier: PANEL_TIER,
    capture: `pinned swumetastats capture ${manifest.snapshot}`,
    ...panel,
    entries: panel.entries.map((e) => ({ ...e, archetype: { ...e.archetype, leaderTitle: titleOf(e.archetype.leader) } })),
    references: panel.references.map((r) => ({ ...r, leaderTitle: titleOf(r.leader) })),
  });
  const name = `tournament-winners-${manifest.snapshot}-${window.from}-top${top}`;
  const outDir = path.resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const text = `${JSON.stringify(file, null, 1)}\n`;
  writeFileSync(path.join(outDir, `${name}.json`), text);
  const setCodeMap = path.join(values.forceteki, "test/json/_setCodeMap.json");
  const replay = replaySchema.parse({
    inputHash: {
      captureManifest: sha256Hex(manifestBytes),
      rawPages: rawPagesHash,
      "features.json": sha256Hex(readFileSync(featuresFile)),
      rawManifest: map.rawManifestSha256,
      engineSetCodeMap: existsSync(setCodeMap) ? sha256Hex(readFileSync(setCodeMap)) : sha256Hex("absent"),
      options: sha256Hex(canonicalJson({ top, minLists, window, leaders: [...leaders].sort(compareCodePoints) })),
    },
    codeCommit: codeCommit(),
    outputHash: { [`${name}.json`]: sha256Hex(text) },
  });
  writeFileSync(path.join(outDir, `${name}.replay.json`), `${JSON.stringify(replay, null, 1)}\n`);
  p.done({ label, entries: file.entries.length });
  console.log(
    JSON.stringify(
      {
        out: path.relative(REPO_ROOT, path.join(outDir, `${name}.json`)),
        sha256: sha256Hex(text),
        window,
        listsInWindow: file.listsInWindow,
        drops,
        entries: file.entries.map((e) => `${e.id} ${e.archetype.leaderTitle} [${e.archetype.baseAspects.join("+")}] ${e.archetype.lists} lists, ${e.event} place ${e.placement} record ${e.record}`),
        references: file.references.map((r) => `${r.leaderTitle}: ${r.entry === null ? "none" : `${r.entry.event} place ${r.entry.placement} record ${r.entry.record}`} (${r.lists} lists)`),
        skippedArchetypes: file.skippedArchetypes,
      },
      null,
      1,
    ),
  );
}

main();
