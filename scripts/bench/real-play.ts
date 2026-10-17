/**
 * @displayName Real-play synergy benchmark
 * @strategicPurpose Checks the run's synergy output against what players actually do: which cards share
 * decklists, which share a human game side and get played into each other, and (separately) which decks win
 * engine simulations. Model judges say whether a pairing reads right; this says whether players use it.
 * @tacticalObjective Deterministic and seeded: loads the run's pairs, trios and fungible classes, the decklist,
 * human-game and simulation extracts, measures every pair with scripts/bench/measures.ts, and writes
 * <run>/verify/real-play.json plus the aggregate summary docs/verification/real-play-<run date>.md. Pairs whose
 * cards were not released (or not seen in use) by a source's capture date are reported as not observable there.
 *
 * Usage: pnpm bench:real-play [--run <dir>] [--originals <dir>] [--games <file>] [--decks <file>] [--sims <file>]
 *                             [--fixture <file>] [--json-out <file>] [--md-out <file>] [--iterations <n>]
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { loadStore } from "../../src/data.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";
import { FixtureSchema } from "../verify/pair-fixture-pin.js";
import { rowIdsOf } from "../verify/pair-fixture.js";
import { wilson, type Interval } from "../verify/pair-precision.js";
import { cardFirstOrder, isObservable, releaseDatesFromDefinitions, sourceWindow, type SourceWindow } from "./availability.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "./card-map.js";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "./code-commit.js";
import { newestFile } from "./extract-sims.js";
import {
  Bits,
  CO_SEP,
  groupOE,
  inPlayEvents,
  matchedPartners,
  pairLift,
  pairWin,
  Population,
  trioOE,
  type Lift,
  type Unit,
} from "./measures.js";
import { renderMarkdown } from "./real-play-md.js";
import { bootstrapCI, clusterBootstrapMean, mannWhitney, mean, median, type CI, type ClusterCI } from "./stats.js";

const SEED = "real-play-v1";
const TRAIT_ROW = "trait-reference";
/** The headline stratum: trait-only pairs are obvious tribal links and are reported apart (#24). */
export const HEADLINE = "excluding-trait-only";
const TOP_GROUPS = 3;
const MIN_DECKS_PER_LEADER = 20;

const deckRecordSchema = z.looseObject({
  key: z.string(),
  leader: z.string().nullable(),
  base: z.string().nullable(),
  aspects: z.array(z.string()),
  cards: z.array(z.tuple([z.string(), z.number()])),
  snapshots: z.array(z.string()),
  createdAt: z.string().nullable(),
});
const decksFileSchema = z.looseObject({
  sha256Decks: z.string(),
  snapshots: z.array(
    z.looseObject({
      label: z.string(),
      createdAt: z.looseObject({ min: z.string().nullable(), max: z.string().nullable() }),
      setUses: z.record(z.string(), z.number()),
    }),
  ),
  decks: z.array(deckRecordSchema),
});
const sideSchema = z.looseObject({
  leader: z.string().nullable(),
  base: z.string().nullable(),
  won: z.union([z.literal(0), z.literal(1), z.null()]),
  cards: z.array(z.tuple([z.string(), z.number()])),
  played: z.array(z.string()),
  co: z.array(z.tuple([z.string(), z.string()])),
});
const gameSchema = z.looseObject({ game: z.string(), winner: z.string(), sides: z.array(sideSchema) });
const gamesManifestSchema = z.looseObject({
  output: z.looseObject({ sha256Uncompressed: z.string(), games: z.number() }),
  window: z.looseObject({ capturedThrough: z.string(), setUses: z.record(z.string(), z.number()) }),
});
const simSchema = z.looseObject({
  decks: z.tuple([z.array(z.string()), z.array(z.string())]),
  leaders: z.tuple([z.string().nullable(), z.string().nullable()]),
  winner: z.union([z.literal(1), z.literal(2), z.null()]),
  mirror: z.boolean(),
});
const simManifestSchema = z.looseObject({
  output: z.looseObject({ sha256Uncompressed: z.string(), games: z.number() }),
  inputs: z.array(z.looseObject({ file: z.string() })),
});
const pairRowSchema = z.looseObject({
  cardA: z.string(),
  cardB: z.string(),
  rows: z.string(),
  linkKind: z.enum(["mechanical", "trait+mechanical", "trait-only"]).optional(),
  score: z.number(),
});
const trioRowSchema = z.looseObject({ cardA: z.string(), cardB: z.string(), cardC: z.string(), shape: z.string(), score: z.number() });
const fungibilitySchema = z.looseObject({
  classes: z.array(z.looseObject({ id: z.string(), members: z.array(z.string()), typeGroup: z.string().optional() })),
});
const similarSchema = z.looseObject({ cards: z.record(z.string(), z.array(z.tuple([z.string(), z.number()]))) });

export interface Pair {
  id: string;
  a: string;
  b: string;
  rows: string[];
  traitOnly: boolean;
  score: number;
}

const round = (x: number | null, digits = 4): number | null => (x === null ? null : Math.round(x * 10 ** digits) / 10 ** digits);

export function costBand(cost: number | null): string {
  if (cost === null) return "n";
  if (cost <= 1) return "0-1";
  if (cost <= 3) return "2-3";
  if (cost <= 5) return "4-5";
  return "6+";
}

interface PairMeasure {
  status: "not-observable" | "unplayed" | "measured";
  lift: Lift | null;
}

interface LiftSummary {
  pairs: number;
  notObservable: number;
  unplayed: number;
  measured: number;
  meanLogLift: CI;
  /** The same mean with a card-clustered bootstrap (resampling cards, not pairs); top-level groups only. */
  meanLogLiftByCard: ClusterCI | null;
  medianLogLift: CI | null;
  shareLiftAboveOne: Interval;
  scoreAuc: number | null;
}

function summarizeLifts(
  pairs: readonly Pair[],
  measures: ReadonlyMap<string, PairMeasure>,
  seed: string,
  iterations: number,
  withMedian: boolean,
): LiftSummary {
  const rows = pairs.map((p) => measures.get(p.id) as PairMeasure);
  const measured = pairs.filter((p) => measures.get(p.id)?.status === "measured");
  const logs = measured.map((p) => (measures.get(p.id)?.lift as Lift).logLift as number);
  const above = measured.filter((p) => ((measures.get(p.id)?.lift as Lift).lift as number) > 1);
  const below = measured.filter((p) => ((measures.get(p.id)?.lift as Lift).lift as number) <= 1);
  return {
    pairs: pairs.length,
    notObservable: rows.filter((m) => m.status === "not-observable").length,
    unplayed: rows.filter((m) => m.status === "unplayed").length,
    measured: measured.length,
    meanLogLift: bootstrapCI(logs, mean, { iterations, seed: `${seed}|mean` }),
    meanLogLiftByCard: withMedian
      ? clusterBootstrapMean(
          logs,
          measured.map((p) => [p.a, p.b] as const),
          { iterations, seed: `${seed}|mean-by-card` },
        )
      : null,
    medianLogLift: withMedian ? bootstrapCI(logs, median, { iterations, seed: `${seed}|median` }) : null,
    shareLiftAboveOne: wilson(above.length, measured.length),
    scoreAuc:
      above.length > 0 && below.length > 0
        ? round(
            mannWhitney(
              above.map((p) => p.score),
              below.map((p) => p.score),
            ).auc,
          )
        : null,
  };
}

function pairedDifference(
  pairs: readonly Pair[],
  measures: ReadonlyMap<string, PairMeasure>,
  baseline: ReadonlyMap<string, PairMeasure>,
  seed: string,
  iterations: number,
  byCard: boolean,
): { pairs: CI; byCard: ClusterCI | null } {
  const diffs: number[] = [];
  const cards: (readonly [string, string])[] = [];
  for (const p of pairs) {
    const m = measures.get(p.id);
    const b = baseline.get(p.id);
    if (m?.status === "measured" && b?.status === "measured") {
      diffs.push((m.lift?.logLift as number) - (b.lift?.logLift as number));
      cards.push([p.a, p.b]);
    }
  }
  return {
    pairs: bootstrapCI(diffs, mean, { iterations, seed: `${seed}|paired` }),
    byCard: byCard ? clusterBootstrapMean(diffs, cards, { iterations, seed: `${seed}|paired-by-card` }) : null,
  };
}

interface Groups {
  name: string;
  pairs: Pair[];
}

function groupsOf(pairs: readonly Pair[]): Groups[] {
  const rows = [...new Set(pairs.flatMap((p) => p.rows))].sort(compareCodePoints);
  return [
    { name: "all", pairs: [...pairs] },
    { name: HEADLINE, pairs: pairs.filter((p) => !p.traitOnly) },
    { name: "trait-only", pairs: pairs.filter((p) => p.traitOnly) },
    ...rows.map((row) => ({ name: `row:${row}`, pairs: pairs.filter((p) => p.rows.includes(row)) })),
  ];
}

/** Status and lift of (a, b) in one population, given which units may hold the pair. */
function measurePair(pop: Population, a: string, b: string, scope: Bits | null, conditioned: boolean): PairMeasure {
  if (scope === null) return { status: "not-observable", lift: null };
  const lift = pairLift(pop, a, b, { conditioned, within: scope });
  return { status: lift.logLift === null ? "unplayed" : "measured", lift };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      originals: { type: "string" },
      games: { type: "string" },
      decks: { type: "string" },
      sims: { type: "string" },
      fixture: { type: "string" },
      "json-out": { type: "string" },
      "md-out": { type: "string" },
      iterations: { type: "string" },
    },
  });
  const runDir = path.resolve(values.run ?? defaultRun());
  const runDate = path.basename(runDir);
  const originals = path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"));
  const gamesFile = path.resolve(
    values.games ?? newestFile(path.join(REPO_ROOT, "data/originals/karabast"), /^games-[0-9a-f]{12}\.jsonl\.gz$/),
  );
  const decksFile = path.resolve(values.decks ?? newestFile(path.join(REPO_ROOT, "data/originals/decks"), /^decks-[0-9a-f]{12}\.json$/));
  const simsFile = path.resolve(values.sims ?? newestFile(path.join(REPO_ROOT, "data/originals/sims"), /^sims-[0-9a-f]{12}\.jsonl\.gz$/));
  const fixtureFile = path.resolve(values.fixture ?? path.join(REPO_ROOT, "data/fixtures/pairs-v1.json"));
  const jsonOut = path.resolve(values["json-out"] ?? path.join(runDir, "verify/real-play.json"));
  const mdOut = path.resolve(values["md-out"] ?? path.join(REPO_ROOT, `docs/verification/real-play-${runDate}.md`));
  const iterations = Number(values.iterations ?? "1000");

  const p = progress("bench-real-play", { total: 12, everyMs: 5000 });
  let step = 0;
  const tick = (phase: string): void => p.tick(++step, { phase });

  const map = loadCardMap(runDir, originals);
  const store = loadStore(runDir);
  const firstOrder = cardFirstOrder(map.printings);
  const iconsByKey = new Map(map.printings.filter((x) => x.serialCode === x.cardKey).map((x) => [x.cardKey, x.aspectIcons]));
  const iconsOf = (k: string): readonly string[] => iconsByKey.get(k) ?? [];
  const releaseDates = releaseDatesFromDefinitions(store.facets.get("expansion") ?? []);

  const stratumOf = new Map<string, string>();
  for (const c of store.cards) stratumOf.set(c.cardKey, `${c.type}|${costBand(c.cost)}|${iconsOf(c.cardKey).join("+")}`);
  const pool = new Map<string, string[]>();
  for (const [k, s] of [...stratumOf].sort((x, y) => compareCodePoints(x[0], y[0]))) pool.set(s, [...(pool.get(s) ?? []), k]);

  const pairTable = decode(readFileSync(path.join(runDir, "synergy/pairs.toon"), "utf8")) as Record<string, unknown>;
  const pairs: Pair[] = z
    .array(pairRowSchema)
    .parse(pairTable.pairings)
    .map((r) => {
      const rows = [...new Set(rowIdsOf(r.rows))].sort(compareCodePoints);
      const traitOnly = rows.every((x) => x === TRAIT_ROW);
      if (r.linkKind !== undefined && (r.linkKind === "trait-only") !== traitOnly)
        throw new Error(`pairing ${r.cardA}>${r.cardB}: linkKind ${r.linkKind} disagrees with rows ${r.rows}`);
      return { id: `${r.cardA}>${r.cardB}`, a: r.cardA, b: r.cardB, rows, traitOnly, score: r.score };
    });
  const pairIds = new Set<string>();
  for (const x of pairs) {
    if (pairIds.has(x.id)) throw new Error(`duplicate pairing ${x.id}`);
    pairIds.add(x.id);
  }
  const emitted = new Set(pairs.flatMap((x) => [`${x.a}${CO_SEP}${x.b}`, `${x.b}${CO_SEP}${x.a}`]));
  const trioTable = decode(readFileSync(path.join(runDir, "synergy/trios.toon"), "utf8")) as Record<string, unknown>;
  const trios = z.array(trioRowSchema).parse(trioTable.trios);
  const classes = fungibilitySchema.parse(JSON.parse(readFileSync(path.join(runDir, "synergy/fungibility.json"), "utf8"))).classes;
  const similar = similarSchema.parse(JSON.parse(readFileSync(path.join(runDir, "similarity/similar.json"), "utf8"))).cards;
  const fixture = FixtureSchema.parse(JSON.parse(readFileSync(fixtureFile, "utf8")));

  const randomPartner = matchedPartners(pairs, stratumOf, pool, emitted, `${SEED}|random`);
  const randomPairs: Pair[] = pairs.flatMap((x) => {
    const b = randomPartner.get(x.id);
    return b === undefined ? [] : [{ ...x, b }];
  });
  const pairCards = [...new Set(pairs.flatMap((x) => [x.a, x.b]))].sort(compareCodePoints);
  const similarPairs: Pair[] = [];
  const seenSimilar = new Set<string>();
  for (const a of pairCards) {
    const top = (similar[a] ?? []).find(([b]) => stratumOf.has(b));
    if (top === undefined) continue;
    const key = [a, top[0]].sort(compareCodePoints).join(CO_SEP);
    if (seenSimilar.has(key)) continue;
    seenSimilar.add(key);
    similarPairs.push({ id: `${a}~${top[0]}`, a, b: top[0], rows: ["similar"], traitOnly: false, score: top[1] });
  }
  tick("loaded");

  // Decks: one population, one bit mask per snapshot.
  const decksBytes = readFileSync(decksFile);
  const decksDoc = decksFileSchema.parse(JSON.parse(decksBytes.toString("utf8")));
  const deckUnits: Unit[] = decksDoc.decks.map((d) => ({
    cards: new Set(d.cards.map(([k]) => k)),
    icons: d.aspects,
    leader: d.leader,
    base: d.base,
    won: null,
  }));
  const decks = new Population(deckUnits, iconsOf);
  const snapshotLabels = decksDoc.snapshots.map((s) => s.label);
  const snapshotBits = new Map(
    snapshotLabels.map((label) => [
      label,
      Bits.from(
        decks.n,
        decksDoc.decks.flatMap((d, i) => (d.snapshots.includes(label) ? [i] : [])),
      ),
    ]),
  );
  const snapshotWindows = new Map<string, SourceWindow>(
    decksDoc.snapshots.map((s) => [
      s.label,
      sourceWindow(`decks:${s.label}`, (s.createdAt.max ?? "9999").slice(0, 10), releaseDates, new Map(Object.entries(s.setUses))),
    ]),
  );
  const observableMemo = new Map<string, boolean>();
  const observableIn = (k: string, window: SourceWindow, pop: Population, within: Bits): boolean => {
    const key = `${window.source}\u0001${k}`;
    let ok = observableMemo.get(key);
    if (ok === undefined) {
      ok = isObservable(k, window, firstOrder, pop.has(k).andCount(within) > 0 ? new Set([k]) : new Set());
      observableMemo.set(key, ok);
    }
    return ok;
  };

  const deckScopeMemo = new Map<string, Bits | null>();
  /** Pooled decks: only snapshots in which every card is observable. */
  const deckScope = (cards: readonly string[], snapshot?: string): Bits | null => {
    const labels = snapshot === undefined ? snapshotLabels : [snapshot];
    const ok = labels.filter((l) =>
      cards.every((k) => observableIn(k, snapshotWindows.get(l) as SourceWindow, decks, snapshotBits.get(l) as Bits)),
    );
    if (ok.length === 0) return null;
    const key = ok.join("\u0001");
    if (!deckScopeMemo.has(key))
      deckScopeMemo.set(
        key,
        ok.map((l) => snapshotBits.get(l) as Bits).reduce((x, y) => x.or(y)),
      );
    return deckScopeMemo.get(key) as Bits;
  };

  const measureAll = (
    list: readonly Pair[],
    pop: Population,
    scopeOf: (x: Pair) => Bits | null,
    conditioned: boolean,
  ): Map<string, PairMeasure> => new Map(list.map((x) => [x.id, measurePair(pop, x.a, x.b, scopeOf(x), conditioned)]));

  const coInclusionReport = (
    label: string,
    pop: Population,
    scopeOf: (x: Pair) => Bits | null,
    conditioned: boolean,
    rowsDetail: boolean,
  ): Record<string, unknown> => {
    const m = measureAll(pairs, pop, scopeOf, conditioned);
    const mr = measureAll(randomPairs, pop, scopeOf, conditioned);
    const ms = measureAll(similarPairs, pop, scopeOf, conditioned);
    const groups = groupsOf(pairs);
    const out: Record<string, unknown> = {};
    for (const g of rowsDetail ? groups : groups.slice(0, TOP_GROUPS)) {
      const seed = `${SEED}|${label}|${g.name}`;
      const top = groups.indexOf(g) < TOP_GROUPS;
      const ids = new Set(g.pairs.map((y) => y.id));
      const rand = randomPairs.filter((x) => ids.has(x.id));
      const diff = pairedDifference(g.pairs, m, mr, seed, iterations, top);
      out[g.name] = {
        pairs: summarizeLifts(g.pairs, m, seed, iterations, top),
        randomMatched: summarizeLifts(rand, mr, `${seed}|random`, iterations, top),
        pairedDiffVsRandom: diff.pairs,
        ...(diff.byCard === null ? {} : { pairedDiffVsRandomByCard: diff.byCard }),
      };
    }
    out.similarBaseline = summarizeLifts(similarPairs, ms, `${SEED}|${label}|similar`, iterations, true);
    return out;
  };

  const deckReports: Record<string, unknown> = {};
  for (const conditioned of [true, false]) {
    deckReports[conditioned ? "pooled-conditioned" : "pooled-unconditioned"] = coInclusionReport(
      `decks-pooled-${conditioned}`,
      decks,
      (x) => deckScope([x.a, x.b]),
      conditioned,
      conditioned,
    );
    tick(`decks-pooled-${conditioned}`);
  }
  if (snapshotLabels.length > 1) {
    for (const label of snapshotLabels)
      deckReports[`snapshot:${label}`] = coInclusionReport(`decks-${label}`, decks, (x) => deckScope([x.a, x.b], label), true, false);
  }
  tick("decks-snapshots");

  // Human games: one unit per game side.
  const gamesText = gunzipSync(readFileSync(gamesFile)).toString("utf8");
  const gamesManifest = gamesManifestSchema.parse(JSON.parse(readFileSync(gamesFile.replace(/\.jsonl\.gz$/, ".manifest.json"), "utf8")));
  if (sha256Hex(gamesText) !== gamesManifest.output.sha256Uncompressed) throw new Error(`${gamesFile} does not match its manifest`);
  const sideUnits: Unit[] = [];
  for (const line of gamesText.split("\n")) {
    if (line === "") continue;
    const g = gameSchema.parse(JSON.parse(line));
    for (const s of g.sides) {
      sideUnits.push({
        cards: new Set(s.cards.map(([k]) => k)),
        icons: [...(s.leader === null ? [] : iconsOf(s.leader)), ...(s.base === null ? [] : iconsOf(s.base))],
        leader: s.leader,
        base: s.base,
        won: s.won,
        played: new Set(s.played),
        co: new Set(s.co.map(([x, y]) => `${x}${CO_SEP}${y}`)),
      });
    }
  }
  const sides = new Population(sideUnits, iconsOf);
  const humanWindow = sourceWindow(
    "karabast-human",
    gamesManifest.window.capturedThrough,
    releaseDates,
    new Map(Object.entries(gamesManifest.window.setUses)),
  );
  const sideScope = (cards: readonly string[]): Bits | null =>
    cards.every((k) => observableIn(k, humanWindow, sides, sides.all)) ? sides.all : null;

  const gameReports: Record<string, unknown> = {};
  for (const conditioned of [true, false]) {
    gameReports[conditioned ? "coOccurrence-conditioned" : "coOccurrence-unconditioned"] = coInclusionReport(
      `games-${conditioned}`,
      sides,
      (x) => sideScope([x.a, x.b]),
      conditioned,
      conditioned,
    );
  }
  tick("games-cooccurrence");

  const interactionAndWins = (list: readonly Pair[], seed: string): Record<string, unknown> => {
    let co = 0;
    let ab = 0;
    let ba = 0;
    const both = { wins: 0, n: 0 };
    const one = { wins: 0, n: 0 };
    const mh: { num: number; den: number }[] = [];
    let observable = 0;
    for (const x of list) {
      if (sideScope([x.a, x.b]) === null) continue;
      observable += 1;
      const e = inPlayEvents(sides, x.a, x.b);
      co += e.coSides;
      ab += e.aInPlayWhenBPlayed;
      ba += e.bInPlayWhenAPlayed;
      const w = pairWin(sides, x.a, x.b);
      both.wins += w.both.wins;
      both.n += w.both.n;
      one.wins += w.one.wins;
      one.n += w.one.n;
      if (w.mh.den > 0) mh.push(w.mh);
    }
    return {
      pairs: list.length,
      observable,
      coOccurringSides: co,
      offerInPlayWhenWantPlayed: wilson(ab, co),
      wantInPlayWhenOfferPlayed: wilson(ba, co),
      eitherDirectionUpperBound: wilson(Math.min(co, ab + ba), co),
      winRateBoth: wilson(both.wins, both.n),
      winRateOnlyOne: wilson(one.wins, one.n),
      mhRiskDifferenceByLeader: ratioCI(mh, `${seed}|mh`, iterations),
    };
  };

  const groups = groupsOf(pairs);
  const interaction: Record<string, unknown> = {};
  for (const g of groups) {
    const ids = new Set(g.pairs.map((y) => y.id));
    const rand = randomPairs.filter((x) => ids.has(x.id));
    interaction[g.name] = {
      pairs: interactionAndWins(g.pairs, `${SEED}|games|${g.name}`),
      randomMatched: interactionAndWins(rand, `${SEED}|games|${g.name}|random`),
    };
  }
  interaction.similarBaseline = interactionAndWins(similarPairs, `${SEED}|games|similar`);
  tick("games-interaction");

  // (c) pairs-v1 agreement.
  const fixtureItems = fixture.items.filter((i) => i.label !== "unsure");
  const fixtureMeasure = (pop: Population, scopeOf: (a: string, b: string) => Bits | null) =>
    fixtureItems.map((i) => ({ label: i.label, row: i.row, m: measurePair(pop, i.offer, i.want, scopeOf(i.offer, i.want), true) }));
  const agreement = (rows: { label: string; m: PairMeasure }[]): Record<string, unknown> => {
    const correct = rows.filter((r) => r.label === "correct" && r.m.status === "measured").map((r) => r.m.lift?.logLift as number);
    const wrong = rows.filter((r) => r.label === "wrong" && r.m.status === "measured").map((r) => r.m.lift?.logLift as number);
    const mw = correct.length > 0 && wrong.length > 0 ? mannWhitney(correct, wrong) : null;
    return {
      correct: {
        items: rows.filter((r) => r.label === "correct").length,
        measured: correct.length,
        medianLogLift: correct.length ? round(median(correct)) : null,
        meanLogLift: correct.length ? round(mean(correct)) : null,
      },
      wrong: {
        items: rows.filter((r) => r.label === "wrong").length,
        measured: wrong.length,
        medianLogLift: wrong.length ? round(median(wrong)) : null,
        meanLogLift: wrong.length ? round(mean(wrong)) : null,
      },
      notObservable: rows.filter((r) => r.m.status === "not-observable").length,
      unplayed: rows.filter((r) => r.m.status === "unplayed").length,
      mannWhitney:
        mw === null ? null : { u: mw.u, auc: round(mw.auc), rankBiserial: round(mw.rankBiserial), z: round(mw.z), p: round(mw.p, 6) },
    };
  };
  const fixtureReport = {
    items: fixtureItems.length,
    decksPooledConditioned: agreement(fixtureMeasure(decks, (a, b) => deckScope([a, b]))),
    humanGamesConditioned: agreement(fixtureMeasure(sides, (a, b) => sideScope([a, b]))),
  };
  tick("fixture");

  // (d) fungible classes.
  const pooledDeckScope = decks.all;
  const usableClass = (members: readonly string[]): string[] => members.filter((k) => deckScope([k]) !== null && stratumOf.has(k));
  const cvOfRates = (members: readonly string[]): number | null => {
    const rates = members.flatMap((k) => {
      const e = decks.eligible(k).and(pooledDeckScope);
      const n = e.count();
      return n === 0 ? [] : [decks.has(k).andCount(e) / n];
    });
    if (rates.length < 2) return null;
    const mu = mean(rates);
    if (mu === 0) return null;
    return Math.sqrt(rates.reduce((s, r) => s + (r - mu) ** 2, 0) / (rates.length - 1)) / mu;
  };
  const classRows: {
    id: string;
    size: number;
    logOE: number | null;
    cv: number | null;
    baseLogOE: number | null;
    baseCv: number | null;
    observed: number;
    expected: number;
    baseObserved: number;
    baseExpected: number;
  }[] = [];
  for (const c of [...classes].sort((x, y) => compareCodePoints(x.id, y.id))) {
    const members = usableClass(c.members);
    if (members.length < 2) continue;
    const memberSet = new Set(members);
    const baseline = members.flatMap((k, i) => {
      const options = (pool.get(stratumOf.get(k) as string) ?? []).filter((x) => !memberSet.has(x) && deckScope([x]) !== null);
      return options.length === 0 ? [] : [options[Math.floor(seededUnit(`${SEED}|class|${c.id}|${i}`) * options.length)]];
    });
    const oe = groupOE(decks, members, MIN_DECKS_PER_LEADER);
    const be = baseline.length >= 2 ? groupOE(decks, [...new Set(baseline)], MIN_DECKS_PER_LEADER) : null;
    classRows.push({
      id: c.id,
      size: members.length,
      observed: oe.observed,
      expected: round(oe.expected) as number,
      logOE: oe.expected >= 1 ? Math.log((oe.observed + 0.5) / (oe.expected + 0.5)) : null,
      cv: cvOfRates(members),
      baseObserved: be?.observed ?? 0,
      baseExpected: round(be?.expected ?? 0) as number,
      baseLogOE: be !== null && be.expected >= 1 ? Math.log((be.observed + 0.5) / (be.expected + 0.5)) : null,
      baseCv: baseline.length >= 2 ? cvOfRates([...new Set(baseline)]) : null,
    });
  }
  const measuredClasses = classRows.filter((r) => r.logOE !== null);
  const baseClasses = classRows.filter((r) => r.baseLogOE !== null);
  const cvs = classRows.filter((r) => r.cv !== null).map((r) => r.cv as number);
  const baseCvs = classRows.filter((r) => r.baseCv !== null).map((r) => r.baseCv as number);
  const cvTest = cvs.length && baseCvs.length ? mannWhitney(cvs, baseCvs) : null;
  const oeTest =
    measuredClasses.length && baseClasses.length
      ? mannWhitney(
          measuredClasses.map((r) => r.logOE as number),
          baseClasses.map((r) => r.baseLogOE as number),
        )
      : null;
  const fungibleReport = {
    classesWithTwoOrMoreObservableMembers: classRows.length,
    minDecksPerLeader: MIN_DECKS_PER_LEADER,
    classes: {
      measured: measuredClasses.length,
      meanLogOE: bootstrapCI(
        measuredClasses.map((r) => r.logOE as number),
        mean,
        { iterations, seed: `${SEED}|fungible|mean` },
      ),
      shareBelowChance: wilson(measuredClasses.filter((r) => (r.logOE as number) < 0).length, measuredClasses.length),
      pooledOE: round(
        measuredClasses.reduce((s, r) => s + r.observed, 0) /
          Math.max(
            1e-9,
            measuredClasses.reduce((s, r) => s + r.expected, 0),
          ),
      ),
      medianRateCV: cvs.length ? round(median(cvs)) : null,
    },
    randomMatchedGroups: {
      measured: baseClasses.length,
      meanLogOE: bootstrapCI(
        baseClasses.map((r) => r.baseLogOE as number),
        mean,
        { iterations, seed: `${SEED}|fungible|base-mean` },
      ),
      shareBelowChance: wilson(baseClasses.filter((r) => (r.baseLogOE as number) < 0).length, baseClasses.length),
      pooledOE: round(
        baseClasses.reduce((s, r) => s + r.baseObserved, 0) /
          Math.max(
            1e-9,
            baseClasses.reduce((s, r) => s + r.baseExpected, 0),
          ),
      ),
      medianRateCV: baseCvs.length ? round(median(baseCvs)) : null,
    },
    logOEClassesVsRandom:
      oeTest === null ? null : { auc: round(oeTest.auc), rankBiserial: round(oeTest.rankBiserial), p: round(oeTest.p, 6) },
    rateCVClassesVsRandom:
      cvTest === null ? null : { auc: round(cvTest.auc), rankBiserial: round(cvTest.rankBiserial), p: round(cvTest.p, 6) },
    perClass: classRows.map((r) => ({
      ...r,
      logOE: round(r.logOE),
      cv: round(r.cv),
      baseLogOE: round(r.baseLogOE),
      baseCv: round(r.baseCv),
    })),
  };
  tick("fungible");

  // (e) trios.
  const trioLog = (a: string, b: string, c: string): { status: string; logOE: number | null; observed: number; expected: number } => {
    const scope = deckScope([a, b, c]);
    if (scope === null) return { status: "not-observable", logOE: null, observed: 0, expected: 0 };
    const t = trioOE(decks, a, b, c, scope);
    if (t.nA === 0 || t.nB === 0 || t.nC === 0) return { status: "unplayed", logOE: null, observed: t.observed, expected: t.expected };
    return { status: "measured", logOE: Math.log((t.observed + 0.5) / (t.expected + 0.5)), observed: t.observed, expected: t.expected };
  };
  const trioRows = trios.map((t, i) => {
    const m = trioLog(t.cardA, t.cardB, t.cardC);
    const pick = (k: string, slot: string): string | null => {
      const options = (pool.get(stratumOf.get(k) ?? "") ?? []).filter((x) => x !== t.cardA && x !== t.cardB && x !== t.cardC);
      return options.length === 0 ? null : options[Math.floor(seededUnit(`${SEED}|trio|${i}|${slot}`) * options.length)];
    };
    const ra = pick(t.cardA, "a");
    const rb = pick(t.cardB, "b");
    const rc = pick(t.cardC, "c");
    const base =
      ra && rb && rc && new Set([ra, rb, rc]).size === 3
        ? trioLog(ra, rb, rc)
        : { status: "no-baseline", logOE: null, observed: 0, expected: 0 };
    return { shape: t.shape, m, base };
  });
  const trioSummary = (
    rows: { status: string; logOE: number | null; observed: number; expected: number }[],
    seed: string,
  ): Record<string, unknown> => {
    const measured = rows.filter((r) => r.status === "measured");
    return {
      trios: rows.length,
      notObservable: rows.filter((r) => r.status === "not-observable").length,
      unplayed: rows.filter((r) => r.status === "unplayed").length,
      measured: measured.length,
      withAllThreeTogether: measured.filter((r) => r.observed > 0).length,
      meanLogOE: bootstrapCI(
        measured.map((r) => r.logOE as number),
        mean,
        { iterations, seed: `${seed}|mean` },
      ),
      medianLogOE: bootstrapCI(
        measured.map((r) => r.logOE as number),
        median,
        { iterations, seed: `${seed}|median` },
      ),
      shareAboveChance: wilson(measured.filter((r) => r.observed > r.expected).length, measured.length),
    };
  };
  const shapes = [...new Set(trios.map((t) => t.shape))].sort(compareCodePoints);
  const trioReport = {
    all: {
      trios: trioSummary(
        trioRows.map((r) => r.m),
        `${SEED}|trios`,
      ),
      randomMatched: trioSummary(
        trioRows.map((r) => r.base),
        `${SEED}|trios|random`,
      ),
    },
    ...Object.fromEntries(
      shapes.map((s) => [
        `shape:${s}`,
        trioSummary(
          trioRows.filter((r) => r.shape === s).map((r) => r.m),
          `${SEED}|trios|${s}`,
        ),
      ]),
    ),
  };
  tick("trios");

  // Engine simulations: a separate source, never pooled with human play.
  const simsText = gunzipSync(readFileSync(simsFile)).toString("utf8");
  const simManifest = simManifestSchema.parse(JSON.parse(readFileSync(simsFile.replace(/\.jsonl\.gz$/, ".manifest.json"), "utf8")));
  if (sha256Hex(simsText) !== simManifest.output.sha256Uncompressed) throw new Error(`${simsFile} does not match its manifest`);
  const deckByKey = new Map(decksDoc.decks.map((d) => [d.key, d]));
  const seatTotals = new Map<string, { candidates: string[]; leader: string | null; wins: number; n: number }>();
  let simGamesUsed = 0;
  let simGamesSkipped = 0;
  for (const line of simsText.split("\n")) {
    if (line === "") continue;
    const s = simSchema.parse(JSON.parse(line));
    if (s.mirror || s.winner === null) {
      simGamesSkipped += 1;
      continue;
    }
    simGamesUsed += 1;
    s.decks.forEach((candidates, seat) => {
      if (candidates.length === 0) return;
      const key = [...candidates].sort(compareCodePoints).join("|");
      const t = seatTotals.get(key) ?? { candidates, leader: s.leaders[seat], wins: 0, n: 0 };
      t.n += 1;
      t.wins += s.winner === seat + 1 ? 1 : 0;
      seatTotals.set(key, t);
    });
  }
  const simUnits: Unit[] = [];
  for (const [, t] of [...seatTotals].sort((x, y) => compareCodePoints(x[0], y[0]))) {
    const lists = t.candidates.map((k) => new Set((deckByKey.get(k)?.cards ?? []).map(([c]) => c)));
    const all = new Set(lists.flatMap((l) => [...l]));
    const sure = new Set([...all].filter((c) => lists.every((l) => l.has(c))));
    const d = deckByKey.get(t.candidates[0]);
    simUnits.push({
      cards: sure,
      uncertain: new Set([...all].filter((c) => !sure.has(c))),
      icons: d?.aspects ?? [],
      leader: t.leader,
      base: d?.base ?? null,
      won: null,
      results: { wins: t.wins, n: t.n },
    });
  }
  const sims = new Population(simUnits, iconsOf);
  const simLabels = [...new Set([...seatTotals.values()].flatMap((t) => t.candidates.flatMap((k) => deckByKey.get(k)?.snapshots ?? [])))];
  const simWindow = (k: string): boolean =>
    simLabels.some((l) => observableIn(k, snapshotWindows.get(l) as SourceWindow, decks, snapshotBits.get(l) as Bits));
  const simWins = (list: readonly Pair[], seed: string): Record<string, unknown> => {
    const both = { wins: 0, n: 0 };
    const one = { wins: 0, n: 0 };
    const mh: { num: number; den: number }[] = [];
    let observable = 0;
    for (const x of list) {
      if (!simWindow(x.a) || !simWindow(x.b)) continue;
      observable += 1;
      const w = pairWin(sims, x.a, x.b);
      both.wins += w.both.wins;
      both.n += w.both.n;
      one.wins += w.one.wins;
      one.n += w.one.n;
      if (w.mh.den > 0) mh.push(w.mh);
    }
    return {
      pairs: list.length,
      observable,
      winRateBoth: wilson(both.wins, both.n),
      winRateOnlyOne: wilson(one.wins, one.n),
      mhRiskDifferenceByLeader: ratioCI(mh, `${seed}|mh`, iterations),
    };
  };
  const simReport: Record<string, unknown> = {
    source: "forceteki engine bot-vs-bot (not human play)",
    gamesUsed: simGamesUsed,
    gamesSkippedMirrorOrNoWinner: simGamesSkipped,
    seats: [...seatTotals.values()].reduce((n, t) => n + t.n, 0),
    distinctDeckSeats: sims.n,
    note: "Win rates count seats (two per game) and fold every game a decklist played; the same list recurs across many games, so intervals are narrower than independent samples would give.",
  };
  for (const g of groups) {
    const ids = new Set(g.pairs.map((y) => y.id));
    const rand = randomPairs.filter((x) => ids.has(x.id));
    simReport[g.name] = {
      pairs: simWins(g.pairs, `${SEED}|sims|${g.name}`),
      randomMatched: simWins(rand, `${SEED}|sims|${g.name}|random`),
    };
  }
  tick("sims");

  const report = {
    version: 1,
    seed: SEED,
    run: runDate,
    bootstrapIterations: iterations,
    inputs: {
      pairs: pairs.length,
      trios: trios.length,
      fungibleClasses: classes.length,
      randomMatchedPairs: randomPairs.length,
      similarPairs: similarPairs.length,
      decks: {
        file: path.basename(decksFile),
        sha256Decks: decksDoc.sha256Decks,
        decks: decks.n,
        snapshots: decksDoc.snapshots.map((s) => ({ label: s.label, createdAt: s.createdAt })),
      },
      humanGames: {
        file: path.basename(gamesFile),
        sha256: gamesManifest.output.sha256Uncompressed,
        games: gamesManifest.output.games,
        sides: sides.n,
      },
      sims: { file: path.basename(simsFile), sha256: simManifest.output.sha256Uncompressed, games: simManifest.output.games },
      fixture: { file: path.relative(REPO_ROOT, fixtureFile), inputsSha256: fixture.inputsSha256 },
      rawManifestSha256: map.rawManifestSha256,
    },
    windows: { decks: Object.fromEntries(snapshotWindows), humanGames: humanWindow, releaseDatesFromRun: Object.fromEntries(releaseDates) },
    deckCoInclusion: deckReports,
    humanGames: { coOccurrence: gameReports, interactionAndWins: interaction },
    pairsV1Agreement: fixtureReport,
    fungible: fungibleReport,
    trios: trioReport,
    simulations: simReport,
    codeCommit: codeCommit(),
  };
  mkdirSync(path.dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, `${JSON.stringify(report, null, 1)}\n`);
  mkdirSync(path.dirname(mdOut), { recursive: true });
  writeFileSync(mdOut, renderMarkdown(report));
  p.done({ jsonOut, mdOut });
  console.log(JSON.stringify({ jsonOut, mdOut }));
}

function seededUnit(seed: string): number {
  return parseInt(sha256Hex(seed).slice(0, 8), 16) / 0x100000000;
}

/** sum(num) / sum(den) over pairs, with a seeded bootstrap over pairs. */
export function ratioCI(parts: readonly { num: number; den: number }[], seed: string, iterations: number): CI {
  const ratio = (xs: readonly { num: number; den: number }[]): number => {
    const den = xs.reduce((s, x) => s + x.den, 0);
    return den === 0 ? 0 : xs.reduce((s, x) => s + x.num, 0) / den;
  };
  if (parts.length === 0) return { value: null, low: null, high: null, n: 0 };
  const idx = parts.map((_, i) => i);
  const ci = bootstrapCI(idx, (sample) => ratio(sample.map((i) => parts[i])), { iterations, seed });
  return { ...ci, value: round(ratio(parts)) };
}

if (isMain(import.meta.url)) await main();
