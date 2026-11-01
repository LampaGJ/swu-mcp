/**
 * @displayName Sleeper-card step
 * @strategicPurpose Manipulation node (reduces), pipeline step of build:data (LampaGJ/swu-mcp#184): the pinned
 * swumetastats decklist capture, the run's card map and the pinned simulator swap records in;
 * data/runs/<date>/sleepers/sleepers.json and a replay record out, read by the sleeper_cards tool. Public tournament
 * aggregates only: player names are read to link a player's events and never leave memory.
 * @tacticalObjective Verifies every raw page against the capture manifest, maps card names to the run's cardKeys,
 * keeps decks with a whole-event match record, assigns each to its meta period, clusters build styles with the
 * meta step's clustering, and hands the decks to src/meta/sleepers.ts; adds the simulator view from
 * src/meta/sleepers-sim.ts.
 *
 * Usage: pnpm meta:sleepers [--data <run dir>] [--originals <dir>] [--capture <dir>] [--out <dir>] [--replicates <n>]
 *   --capture  default: the newest data/originals/decklists/<YYYY-MM-DD>/ holding manifest.json
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DATED_DIR, readJson } from "../../src/data.js";
import { cardFacts, DEFAULT_META_OPTIONS } from "../../src/meta/build.js";
import { clusterDecks } from "../../src/meta/cluster.js";
import {
  boundariesSchema,
  decklistManifestSchema,
  decklistRowsPageSchema,
  nameVariants,
  statOf,
  type DecklistRow,
} from "../../src/meta/decklist-capture.js";
import { parseMatchRecord } from "../../src/meta/outcomes.js";
import { SWUMETASTATS_SOURCE } from "../../src/meta/schema.js";
import { analyseSleepers, DEFAULT_SLEEPER_OPTIONS, type SleeperDeck } from "../../src/meta/sleepers.js";
import { simRecordSchema, simulatorView } from "../../src/meta/sleepers-sim.js";
import { sleepersFileSchema, sleepersReplaySchema } from "../../src/meta/sleepers-schema.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, displayName, loadCardMap, normalizeName, variantRank, type CardMap } from "../bench/card-map.js";
import { codeCommit, defaultRun, REPO_ROOT } from "../bench/code-commit.js";
import { progress } from "../lib/progress.mjs";

const MAIN_CHECKOUT = "/Volumes/Local Files/Projects/swu-mcp";
const SIM_DIR = path.join(REPO_ROOT, "data/pinned/sim-ladder-v1");
const SIM_RECORDS = ["warrior-deck-rung1.json", "warrior-deck-rung1-controls.json", "warrior-deck-rung3.json", "warrior-deck-rung3v.json"];
const SIM_DECK = "the owner's deck: The Warrior, Deft Duelist with Origin Tree (tests/fixtures/decks/warrior-chewie-raid.swudb.json)";
const SIM_OPPONENTS =
  "the first-place lists of the six largest tournament archetypes, 300 games each with seats alternated (docs/verification/2026-10-31-bot-ladder.md)";
export const POPULATION = "tournament decklists with their whole-event match record (melee.gg Premier events via swumetastats.com)";
export const PRECEDENCE =
  "D21 tier 1: tournament results joined to decklists and placements; never pooled with community lists or computer play";

function newestCapture(): string | undefined {
  const found = [REPO_ROOT, MAIN_CHECKOUT]
    .map((root) => path.join(root, "data/originals/decklists"))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((n) => DATED_DIR.test(n))
        .map((n) => path.join(dir, n)),
    )
    .filter((dir) => existsSync(path.join(dir, "manifest.json")));
  return found.sort((a, b) => compareCodePoints(path.basename(a), path.basename(b)) || compareCodePoints(a, b)).at(-1);
}

interface Resolver {
  leader(name: string, set: string | null | undefined): string | null;
  /** The base's aspect icons (all the analysis needs); a name two printings share resolves when their aspects agree. */
  baseAspects(name: string, aspectText: string | null | undefined): string[] | null;
  card(name: string, stats: { cost: number | null; power: number | null; hp: number | null }): string | null;
}

const ASPECT_WORDS = new Set(["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"]);

function resolverOf(
  map: CardMap,
  aspectsOf: (cardKey: string) => readonly string[] | undefined,
  statsOf: (cardKey: string) => { cost: number | null; power: number | null; hp: number | null; aspects: string } | undefined,
): Resolver {
  const types = new Map<string, Set<string>>();
  const sets = new Map<string, Set<string>>();
  for (const p of map.printings) {
    types.set(p.cardKey, (types.get(p.cardKey) ?? new Set()).add(p.type));
    sets.set(p.cardKey, (sets.get(p.cardKey) ?? new Set()).add(p.expansion.toLowerCase()));
  }
  const memo = new Map<string, string | null>();
  const cached = (key: string, compute: () => string | null): string | null => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key) as string | null;
  };
  const named = (name: string): string[] => map.names.get(normalizeName(name)) ?? [];
  return {
    leader: (name, set) =>
      cached(`L\u0000${name}\u0000${set ?? ""}`, () => {
        for (const variant of nameVariants(name)) {
          let hits = named(variant).filter((k) => types.get(k)?.has("Leader") === true);
          if (hits.length > 1 && set) {
            const inSet = hits.filter((k) => sets.get(k)?.has(set.toLowerCase()) === true);
            if (inSet.length > 0) hits = inSet;
          }
          if (hits.length === 1) return hits[0];
        }
        return null;
      }),
    baseAspects: (name, aspectText) => {
      const hits = named(name).filter((k) => types.get(k)?.has("Base") === true);
      const options = [...new Set(hits.map((k) => [...(aspectsOf(k) ?? [])].sort(compareCodePoints).join("+")))];
      if (hits.length > 0 && options.length === 1) return options[0] === "" ? [] : options[0].split("+");
      const words = (aspectText ?? "")
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w !== "");
      if (hits.length > 0 && words.every((w) => ASPECT_WORDS.has(w))) return words.sort(compareCodePoints);
      return null;
    },
    card: (name, stats) =>
      cached(`C\u0000${name}\u0000${stats.cost}\u0000${stats.power}\u0000${stats.hp}`, () => {
        for (const variant of nameVariants(name)) {
          const hits = named(variant).filter((k) => types.get(k)?.has("Leader") !== true && types.get(k)?.has("Base") !== true);
          if (hits.length === 1) return hits[0];
          if (hits.length < 2) continue;
          // Two cards share the name (Grassroots Resistance in SEC and ASH): the line's own printed numbers pick one;
          // when every candidate prints the same numbers it is one card in two products, and the first key stands for it.
          const fits = hits.filter((k) => {
            const f = statsOf(k);
            return f !== undefined && f.cost === stats.cost && f.power === stats.power && f.hp === stats.hp;
          });
          if (fits.length === 1) return fits[0];
          const shapes = new Set(hits.map((k) => JSON.stringify(statsOf(k) ?? null)));
          if (fits.length > 1 && shapes.size === 1) return [...fits].sort(compareCodePoints)[0];
          return null;
        }
        return null;
      }),
  };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      originals: { type: "string" },
      capture: { type: "string" },
      out: { type: "string" },
      replicates: { type: "string" },
    },
  });
  const runDir = path.resolve(values.data ?? defaultRun());
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const captureDir = values.capture ?? newestCapture();
  if (captureDir === undefined)
    throw new Error("no data/originals/decklists/<date>/manifest.json; run pnpm meta:capture-decklists or pass --capture");
  const outDir = path.resolve(values.out ?? path.join(runDir, "sleepers"));
  const replicates = z.coerce
    .number()
    .int()
    .min(50)
    .parse(values.replicates ?? String(DEFAULT_SLEEPER_OPTIONS.replicates));
  const p = progress("sleepers", { total: null, everyN: 1 });

  const manifestFile = path.join(captureDir, "manifest.json");
  const manifestBytes = readFileSync(manifestFile);
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

  const boundaries = boundariesSchema.parse(JSON.parse(readFileSync(path.join(rawDir, "meta-boundaries.json"), "utf8")));
  const periodOf = (day: string): { label: string; from: string; to: string } => {
    const hit = boundaries.find((b) => compareCodePoints(day, b.start) >= 0 && (b.end === null || compareCodePoints(day, b.end) <= 0));
    return hit === undefined
      ? { label: "outside known periods", from: day, to: day }
      : { label: hit.label, from: hit.start, to: hit.end ?? manifest.window.to };
  };

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

  const rows = new Map<string, DecklistRow>();
  for (const file of Object.keys(manifest.files)
    .filter((f) => f.startsWith("decklists/"))
    .sort(compareCodePoints)) {
    const page = decklistRowsPageSchema.parse(JSON.parse(readFileSync(path.join(rawDir, file), "utf8")));
    for (const row of page.decklists) if (!rows.has(row.guid)) rows.set(row.guid, row);
  }
  const drops = { noMatchRecord: 0, noDecisiveMatch: 0, unmappedLeaderOrBase: 0, unmappedCardLines: 0 };
  const sorted = [...rows.values()].sort(
    (a, b) =>
      compareCodePoints(a.tournament.startDate, b.tournament.startDate) ||
      a.tournamentId - b.tournamentId ||
      compareCodePoints(a.guid, b.guid),
  );
  interface Pending extends Omit<SleeperDeck, "style"> {
    guid: string;
    from: string;
    to: string;
  }
  const pending: Pending[] = [];
  for (const row of sorted) {
    const record = parseMatchRecord(row.matchRecord);
    if (record === null) {
      drops.noMatchRecord += 1;
      continue;
    }
    if (record.wins + record.losses === 0) {
      drops.noDecisiveMatch += 1;
      continue;
    }
    const leader = resolve.leader(row.leaderCard?.name ?? row.leaderName, row.leaderCard?.set);
    const baseAspects = resolve.baseAspects(row.baseCard?.name ?? row.baseName, row.baseCard?.aspect);
    if (leader === null || baseAspects === null) {
      drops.unmappedLeaderOrBase += 1;
      continue;
    }
    const cards = new Set<string>();
    for (const line of row.cards) {
      if (line.section !== "MainDeck" || line.count === 0) continue;
      const key = resolve.card(line.cardName, {
        cost: statOf(line.card?.cost),
        power: statOf(line.card?.power),
        hp: statOf(line.card?.hp),
      });
      if (key === null) drops.unmappedCardLines += 1;
      else cards.add(key);
    }
    const day = row.tournament.startDate.slice(0, 10);
    const period = periodOf(day);
    const name = row.player?.name?.trim() ?? "";
    pending.push({
      guid: row.guid,
      event: `swumetastats:${row.tournamentId}`,
      period: period.label,
      from: period.from,
      to: period.to,
      leader,
      baseAspects,
      aspects: [...(facts.get(leader)?.aspectIcons ?? []), ...baseAspects].sort(compareCodePoints),
      player: name === "" ? null : normalizeName(name),
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      cards: [...cards].sort(compareCodePoints),
    });
  }
  p.log({ phase: "decks", decks: pending.length, ...drops });

  const byStratum = new Map<string, number[]>();
  pending.forEach((d, i) => {
    const key = `${d.period}\u0000${d.leader}\u0000${d.baseAspects.join("+")}`;
    const list = byStratum.get(key) ?? [];
    list.push(i);
    byStratum.set(key, list);
  });
  const style = new Array<string | null>(pending.length).fill(null);
  for (const key of [...byStratum.keys()].sort(compareCodePoints)) {
    const members = byStratum.get(key) as number[];
    const clusters = clusterDecks(
      members.map((i) => ({ key: pending[i].guid, cards: pending[i].cards, weight: 1 })),
      DEFAULT_META_OPTIONS,
    );
    clusters.forEach((c, n) => {
      for (const m of c.members) style[members[m]] = `s${n}`;
    });
  }
  const decks: SleeperDeck[] = pending.map((d, i) => ({
    event: d.event,
    period: d.period,
    leader: d.leader,
    baseAspects: d.baseAspects,
    aspects: d.aspects,
    player: d.player,
    wins: d.wins,
    losses: d.losses,
    draws: d.draws,
    cards: d.cards,
    style: style[i],
  }));
  p.log({ phase: "styles" });

  const titles = new Map<string, { title: string; rank: number }>();
  for (const pr of map.printings) {
    const rank = variantRank(pr.variantTypes);
    const cur = titles.get(pr.cardKey);
    if (cur === undefined || rank < cur.rank) titles.set(pr.cardKey, { title: displayName(pr.title, pr.subtitle), rank });
  }
  const analysis = analyseSleepers(decks, {
    ...DEFAULT_SLEEPER_OPTIONS,
    replicates,
    // features.json covers the package's card list, which holds only the sets Premier allows now.
    cardInfo: (key) => ({ title: titles.get(key)?.title ?? key, rotated: !facts.has(key) }),
    onProgress: (phase, done, total) => {
      if (done % 10 === 0 || done === total) p.log({ phase, done, total });
    },
  });

  const simRecords = SIM_RECORDS.map((name) => {
    const bytes = readFileSync(path.join(SIM_DIR, name));
    return { name, sha256: sha256Hex(bytes), record: simRecordSchema.parse(JSON.parse(bytes.toString("utf8"))) };
  });
  const simulator = simulatorView(simRecords, (id) => map.setNumber.byId.get(id), SIM_DECK, SIM_OPPONENTS);

  const periods = new Map<string, { label: string; from: string; to: string; decks: number; events: Set<string> }>();
  for (const d of pending) {
    const cur = periods.get(d.period) ?? { label: d.period, from: d.from, to: d.to, decks: 0, events: new Set<string>() };
    cur.decks += 1;
    cur.events.add(d.event);
    periods.set(d.period, cur);
  }
  const days = sorted.filter((r) => parseMatchRecord(r.matchRecord) !== null).map((r) => r.tournament.startDate.slice(0, 10));
  const file = sleepersFileSchema.parse({
    schemaVersion: 1,
    source: SWUMETASTATS_SOURCE,
    population: POPULATION,
    precedence: PRECEDENCE,
    window: { from: days[0] ?? manifest.window.from, to: days.at(-1) ?? manifest.window.to },
    periods: [...periods.values()]
      .sort((a, b) => compareCodePoints(a.from, b.from))
      .map((x) => ({ label: x.label, from: x.from, to: x.to, decks: x.decks, events: x.events.size })),
    counts: analysis.counts,
    method: {
      unit: "one decklist at one event (its whole-event record); a player's decks at several events count once per event",
      outcome: "match win rate: wins / (wins + losses), draws left out, as swumetastats does",
      comparison:
        "decks with the card against decks without it in the same meta period, leader and base aspects, pooled over those groups with weights n_with x n_without / (n_with + n_without) in decisive matches",
      interval:
        "estimate +- 1.96 x bootstrap standard error; the bootstrap resamples whole events (seeded), so decks of one event move together",
      coverage: 0.95,
      test: "null model: no difference between decks with and without the card (gap = 0); two-sided normal p from the event-clustered bootstrap standard error",
      fdr: "per family (all cards; each aspect set; each leader and base aspects): Benjamini-Hochberg q (valid under positive dependence) and Benjamini-Yekutieli q (valid under any dependence); a verdict needs BY q <= q",
      q: DEFAULT_SLEEPER_OPTIONS.q,
      replicates,
      seed: DEFAULT_SLEEPER_OPTIONS.seed,
      minDecks: DEFAULT_SLEEPER_OPTIONS.minDecks,
      minEvents: DEFAULT_SLEEPER_OPTIONS.minEvents,
      minTierDecks: DEFAULT_SLEEPER_OPTIONS.minTierDecks,
      minPlayers: DEFAULT_SLEEPER_OPTIONS.minPlayers,
      skill: {
        definition:
          "leave-one-event-out: the player's wins above their leader-and-base group's average in their other events, per decisive match, shrunk toward 0 by priorMatches pseudo-matches (method of moments); strong = top third, weak = bottom third of decks with an estimate; players are linked by the name the event lists",
        priorMatches: analysis.skill.priorMatches,
        betweenPlayerSd: analysis.skill.betweenPlayerSd,
        tierCuts: analysis.skill.tierCuts,
      },
      nullCheck: analysis.nullCheck,
      verdicts:
        "sleeper: BY q <= q, interval above 0, played in under half of comparable decks; proven-winner: the same, played in half or more; loses-ground: BY q <= q, interval below 0; no-clear-effect otherwise. skilledEdge: the skill interaction passes BY q <= q with its interval above 0. selectionWarning: a verdict whose within-player interval includes 0",
    },
    global: analysis.global,
    aspects: analysis.aspects,
    archetypes: analysis.archetypes,
    simulator,
  });

  mkdirSync(outDir, { recursive: true });
  const text = `${JSON.stringify(file)}\n`;
  writeFileSync(path.join(outDir, "sleepers.json"), text);
  const replay = sleepersReplaySchema.parse({
    inputHash: {
      captureManifest: sha256Hex(manifestBytes),
      rawPages: rawPagesHash,
      "features.json": sha256Hex(readFileSync(featuresFile)),
      rawManifest: map.rawManifestSha256,
      simRecords: Object.fromEntries(simRecords.map((r) => [r.name, r.sha256])),
    },
    codeCommit: codeCommit(),
    outputHash: { "sleepers.json": sha256Hex(text) },
  });
  writeFileSync(path.join(outDir, "replay.json"), `${JSON.stringify(replay, null, 1)}\n`);
  const verdicts: Record<string, number> = {};
  for (const r of file.global) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
  p.done({ decks: file.counts.decks, rows: file.global.length });
  console.log(
    JSON.stringify(
      {
        outDir,
        capture: captureDir,
        rawDecklists: rows.size,
        drops,
        counts: file.counts,
        window: file.window,
        periods: file.periods,
        globalRows: file.global.length,
        verdicts,
        skilledEdge: file.global.filter((r) => r.skilledEdge).length,
        rotatedRows: file.global.filter((r) => r.rotated).length,
        aspectScopes: file.aspects.length,
        archetypeScopes: file.archetypes.length,
        archetypeRows: file.archetypes.reduce((n, a) => n + a.rows.length, 0),
        nullCheck: file.method.nullCheck,
        skill: file.method.skill,
        bytes: text.length,
      },
      null,
      1,
    ),
  );
}

main();
