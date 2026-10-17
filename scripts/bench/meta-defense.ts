/**
 * @displayName Meta defense benchmark
 * @strategicPurpose Checks meta_answers against real outcomes (LampaGJ/swu-mcp#25): do the cards the counter table
 * says answer an archetype show up more in sides that beat that archetype's leader than in sides that lose to it?
 * Tournament match results are the primary outcome source once an extract exists (#26); human Karabast games are a
 * secondary, casual signal and are labelled so. Bot simulations are not used.
 * @tacticalObjective For each large tournament archetype's leader, every side that faced it and has a known result is
 * a unit. A card is eligible on a side whose leader and base cover its aspect icons and when the source shows the card
 * at all. Per (leader, card) the log ratio of the card's rate in winning sides over losing sides is
 * ln((a + 0.5) / (nW + 1)) - ln((b + 0.5) / (nL + 1)). Answer cards are compared with the other eligible cards
 * (controls); intervals are seeded card-clustered bootstraps. Writes <run>/verify/meta-defense.json and the aggregate
 * summary <run>/verify/meta-defense.md, both git-ignored.
 *
 * LOCAL ONLY (decision D22, owner ruling 2026-10-17): this benchmark reads the private Karabast extract in
 * data/originals/karabast/ directly. Its numbers, aggregates included, never ship in the data release, in tool output
 * or in a committed doc; the meta step (scripts/meta.ts) never reads Karabast data.
 *
 * Usage: pnpm bench:meta-defense [--run <dir>] [--games <file>] [--results <file>] [--archetypes <n>] [--iterations <n>] [--md-out <file>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { readJson } from "../../src/data.js";
import {
  answerOffers,
  counterCardSchema,
  detectThreats,
  loadCounterTable,
  relationHit,
  type AnswerOffer,
  type CounterCard,
} from "../../src/meta/counters.js";
import { metaFileSchema, tournamentResultsSchema, type Archetype, type CounterTable } from "../../src/meta/schema.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { round } from "../../src/tools/common.js";
import { MAIN_TYPES } from "../../src/tools/deck.js";
import { progress } from "../lib/progress.mjs";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "./code-commit.js";
import { newestFile } from "./extract-sims.js";
import { seededRandom } from "./stats.js";

const SEED = "meta-defense-v1";
const MIN_SIDES = 20;
const MIN_SEEN = 5;

export interface BenchSide {
  leader: string | null;
  base: string | null;
  won: 0 | 1 | null;
  cards: readonly string[];
}
export type BenchGame = readonly [BenchSide, BenchSide];

export interface CardValue {
  leader: string;
  card: string;
  answer: boolean;
  threats: string[];
  logRatio: number;
  winners: number;
  losers: number;
}

const count = (icons: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const x of icons) out.set(x, (out.get(x) ?? 0) + 1);
  return out;
};

export function covers(supplied: readonly string[], needed: readonly string[]): boolean {
  const have = count(supplied);
  for (const [icon, n] of count(needed)) if ((have.get(icon) ?? 0) < n) return false;
  return true;
}

/** Threats each card answers for one archetype, from the counter table. */
export function answersFor(
  archetype: Archetype,
  table: CounterTable,
  cards: ReadonlyMap<string, { card: CounterCard; offers: AnswerOffer[] }>,
): Map<string, string[]> {
  const live = new Set(detectThreats(archetype.profile, table).map((t) => t.threat.id));
  const out = new Map<string, string[]>();
  for (const [key, { card, offers }] of cards) {
    if (!MAIN_TYPES.has(card.type)) continue;
    const threats = new Set<string>();
    for (const relation of table.relations) {
      if (!live.has(relation.threat)) continue;
      if (relationHit(card, offers, relation, archetype.profile) !== null) threats.add(relation.threat);
    }
    if (threats.size > 0) out.set(key, [...threats].sort(compareCodePoints));
  }
  return out;
}

/** Per (leader, eligible card) log ratio of the card's rate among sides that beat the leader over sides that lost to it. */
export function measure(
  games: Iterable<BenchGame>,
  targets: ReadonlyMap<string, Map<string, string[]>>,
  iconsOf: (cardKey: string) => readonly string[] | undefined,
  candidates: readonly string[],
): CardValue[] {
  const seen = new Set<string>();
  const sidesVs = new Map<string, BenchSide[]>();
  for (const game of games) {
    for (const [self, other] of [
      [game[0], game[1]],
      [game[1], game[0]],
    ] as const) {
      for (const c of self.cards) seen.add(c);
      if (self.won === null || self.leader === null || self.base === null || other.leader === null || !targets.has(other.leader)) continue;
      const list = sidesVs.get(other.leader) ?? [];
      list.push(self);
      sidesVs.set(other.leader, list);
    }
  }
  const out: CardValue[] = [];
  for (const leader of [...sidesVs.keys()].sort(compareCodePoints)) {
    const sides = (sidesVs.get(leader) as BenchSide[]).map((s) => ({
      side: s,
      icons: [...(iconsOf(s.leader as string) ?? []), ...(iconsOf(s.base as string) ?? [])],
      cards: new Set(s.cards),
    }));
    const answers = targets.get(leader) as Map<string, string[]>;
    for (const card of candidates) {
      if (!seen.has(card)) continue;
      const need = iconsOf(card) ?? [];
      let nW = 0;
      let nL = 0;
      let a = 0;
      let b = 0;
      for (const s of sides) {
        if (!covers(s.icons, need)) continue;
        if (s.side.won === 1) {
          nW += 1;
          if (s.cards.has(card)) a += 1;
        } else {
          nL += 1;
          if (s.cards.has(card)) b += 1;
        }
      }
      if (nW < MIN_SIDES || nL < MIN_SIDES || a + b < MIN_SEEN) continue;
      out.push({
        leader,
        card,
        answer: answers.has(card),
        threats: answers.get(card) ?? [],
        logRatio: Math.log((a + 0.5) / (nW + 1)) - Math.log((b + 0.5) / (nL + 1)),
        winners: nW,
        losers: nL,
      });
    }
  }
  return out;
}

export interface Interval {
  value: number | null;
  low: number | null;
  high: number | null;
  n: number;
  cards: number;
}

const r4 = (x: number): number => round(x, 4);

/** Card-clustered percentile bootstrap of mean(answers) - mean(controls) and of each mean: one draw resamples distinct cards. */
export function clusteredContrast(
  values: readonly CardValue[],
  options: { iterations: number; seed: string },
): { answers: Interval; controls: Interval; difference: Interval } {
  const ids = [...new Set(values.map((v) => v.card))].sort(compareCodePoints);
  const index = new Map(ids.map((id, i) => [id, i]));
  const random = seededRandom(options.seed);
  const times = new Float64Array(ids.length);
  const draws = { answers: [] as number[], controls: [] as number[], difference: [] as number[] };
  const meanOf = (answer: boolean, weight: (v: CardValue) => number): number | null => {
    let s = 0;
    let w = 0;
    for (const v of values) {
      if (v.answer !== answer) continue;
      const k = weight(v);
      s += k * v.logRatio;
      w += k;
    }
    return w === 0 ? null : s / w;
  };
  for (let i = 0; i < options.iterations; i++) {
    times.fill(0);
    for (let j = 0; j < ids.length; j++) times[Math.floor(random() * ids.length)] += 1;
    const weight = (v: CardValue): number => times[index.get(v.card) as number];
    const a = meanOf(true, weight);
    const c = meanOf(false, weight);
    if (a !== null) draws.answers.push(a);
    if (c !== null) draws.controls.push(c);
    if (a !== null && c !== null) draws.difference.push(a - c);
  }
  const interval = (xs: number[], value: number | null, n: number, cards: number): Interval => {
    xs.sort((x, y) => x - y);
    const at = (q: number): number | null =>
      xs.length === 0 ? null : r4(xs[Math.min(xs.length - 1, Math.max(0, Math.round(q * (xs.length - 1))))]);
    return { value: value === null ? null : r4(value), low: at(0.025), high: at(0.975), n, cards };
  };
  const answers = values.filter((v) => v.answer);
  const controls = values.filter((v) => !v.answer);
  const a = meanOf(true, () => 1);
  const c = meanOf(false, () => 1);
  return {
    answers: interval(draws.answers, a, answers.length, new Set(answers.map((v) => v.card)).size),
    controls: interval(draws.controls, c, controls.length, new Set(controls.map((v) => v.card)).size),
    difference: interval(draws.difference, a === null || c === null ? null : a - c, values.length, ids.length),
  };
}

/** One line of the private human-game extract (scripts/bench/extract-games.ts); only the fields the benchmark reads. */
const humanGameSchema = z.looseObject({
  sides: z.array(z.looseObject({})),
});

const sideSchema = z.looseObject({
  leader: z.string().nullable(),
  base: z.string().nullable(),
  won: z.union([z.literal(0), z.literal(1), z.null()]),
  cards: z.array(z.tuple([z.string(), z.number()])),
});

function* humanGames(file: string): Generator<BenchGame> {
  for (const line of gunzipSync(readFileSync(file)).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const game = humanGameSchema.parse(JSON.parse(line));
    if (game.sides.length !== 2) continue;
    const side = (i: number): BenchSide => {
      const s = sideSchema.parse(game.sides[i]);
      return { leader: s.leader, base: s.base, won: s.won, cards: s.cards.map(([c]) => c) };
    };
    yield [side(0), side(1)];
  }
}

const fmt = (i: Interval): string =>
  i.value === null
    ? "not measurable"
    : `${i.value.toFixed(3)} (card-clustered 95% CI ${i.low?.toFixed(3)} to ${i.high?.toFixed(3)}; ${i.n} card-leader values over ${i.cards} cards)`;

function main(): void {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      games: { type: "string" },
      results: { type: "string" },
      archetypes: { type: "string" },
      iterations: { type: "string" },
      "md-out": { type: "string" },
    },
  });
  const runDir = path.resolve(values.run ?? defaultRun());
  const iterations = z.coerce
    .number()
    .int()
    .min(100)
    .parse(values.iterations ?? "2000");
  const topN = z.coerce
    .number()
    .int()
    .min(1)
    .parse(values.archetypes ?? "20");
  const p = progress("bench-meta-defense", { total: null, everyN: 1 });

  const meta = metaFileSchema.parse(readJson(path.join(runDir, "meta/archetypes.json")));
  const table = loadCounterTable();
  const features = z.array(z.unknown()).parse(readJson(path.join(runDir, "features/features.json")));
  const cards = new Map<string, { card: CounterCard; offers: AnswerOffer[] }>();
  for (const raw of features) {
    const card = counterCardSchema.parse(raw);
    cards.set(card.cardKey, { card, offers: answerOffers(card) });
  }
  const iconsOf = (key: string): readonly string[] | undefined => cards.get(key)?.card.structured.aspectIcons;
  const candidates = [...cards.values()]
    .filter((c) => MAIN_TYPES.has(c.card.type))
    .map((c) => c.card.cardKey)
    .sort(compareCodePoints);

  const archetypes = meta.archetypes.filter((a) => a.population === "tournament").slice(0, topN);
  const targets = new Map<string, Map<string, string[]>>();
  for (const a of archetypes) {
    const merged = targets.get(a.leader.cardKey) ?? new Map<string, string[]>();
    for (const [card, threats] of answersFor(a, table, cards))
      merged.set(card, [...new Set([...(merged.get(card) ?? []), ...threats])].sort(compareCodePoints));
    targets.set(a.leader.cardKey, merged);
  }

  const sources: { source: string; label: string; file: string; games: () => Iterable<BenchGame> }[] = [];
  if (values.results !== undefined) {
    const file = values.results;
    sources.push({
      source: "tournament-results",
      label: "tournament match results (primary)",
      file,
      games: () =>
        tournamentResultsSchema.parse(readJson(file)).matches.map((m) => {
          const side = (i: 0 | 1): BenchSide => ({
            leader: m.sides[i].leader,
            base: m.sides[i].base,
            won: m.winner === null ? null : m.winner === i ? 1 : 0,
            cards: m.sides[i].cards.map(([c]) => c),
          });
          return [side(0), side(1)] as const;
        }),
    });
  }
  const gamesFile = values.games ?? newestFile(path.join(REPO_ROOT, "data/originals/karabast"), /^games-[0-9a-f]{12}\.jsonl\.gz$/);
  sources.push({
    source: "karabast-human",
    label: "human Karabast online games (secondary, casual play; captured through 2026-02-10)",
    file: gamesFile,
    games: () => humanGames(gamesFile),
  });

  const results = sources.map((s) => {
    p.log({ phase: s.source });
    const measured = measure(s.games(), targets, iconsOf, candidates);
    const contrast = clusteredContrast(measured, { iterations, seed: `${SEED}|${s.source}` });
    const byLeader = [...new Set(measured.map((v) => v.leader))].sort(compareCodePoints).map((leader) => {
      const rows = measured.filter((v) => v.leader === leader);
      const a = rows.filter((v) => v.answer);
      const c = rows.filter((v) => !v.answer);
      const mean = (xs: CardValue[]): number | null => (xs.length === 0 ? null : r4(xs.reduce((s, v) => s + v.logRatio, 0) / xs.length));
      const arch = archetypes.find((x) => x.leader.cardKey === leader) as Archetype;
      return {
        leader,
        title: arch.leader.title,
        sides: Math.max(...rows.map((v) => v.winners + v.losers)),
        answers: a.length,
        controls: c.length,
        answerMean: mean(a),
        controlMean: mean(c),
      };
    });
    const threats = [...new Set(measured.flatMap((v) => v.threats))].sort(compareCodePoints).map((threat) => {
      const subset = measured.filter((v) => !v.answer || v.threats.includes(threat));
      return { threat, ...clusteredContrast(subset, { iterations, seed: `${SEED}|${s.source}|${threat}` }) };
    });
    return {
      source: s.source,
      label: s.label,
      inputSha256: sha256Hex(readFileSync(s.file)),
      measured: measured.length,
      contrast,
      byLeader,
      threats,
    };
  });

  const leadersAbsent = archetypes
    .filter((a) => !results.some((r) => r.byLeader.some((b) => b.leader === a.leader.cardKey)))
    .map((a) => a.leader.title);
  const out = {
    kind: "meta-defense-benchmark",
    seed: SEED,
    iterations,
    archetypes: archetypes.length,
    window: meta.window,
    minSides: MIN_SIDES,
    minSeen: MIN_SEEN,
    counterTableVersion: table.tableVersion,
    codeCommit: codeCommit(),
    results,
    leadersWithoutOutcomes: [...new Set(leadersAbsent)].sort(compareCodePoints),
  };
  mkdirSync(path.join(runDir, "verify"), { recursive: true });
  writeFileSync(path.join(runDir, "verify/meta-defense.json"), `${JSON.stringify(out, null, 1)}\n`);
  const mdOut = path.resolve(values["md-out"] ?? path.join(runDir, "verify/meta-defense.md"));
  writeFileSync(mdOut, renderMarkdown(out, path.basename(runDir)));
  p.done({ measured: results.map((r) => r.measured) });
  console.log(
    JSON.stringify(
      results.map((r) => ({ source: r.source, measured: r.measured, contrast: r.contrast })),
      null,
      1,
    ),
  );
}

type Out = {
  iterations: number;
  archetypes: number;
  window: { from: string; to: string };
  minSides: number;
  minSeen: number;
  counterTableVersion: number;
  results: {
    source: string;
    label: string;
    measured: number;
    contrast: ReturnType<typeof clusteredContrast>;
    byLeader: { title: string; sides: number; answers: number; controls: number; answerMean: number | null; controlMean: number | null }[];
    threats: ({ threat: string } & ReturnType<typeof clusteredContrast>)[];
  }[];
  leadersWithoutOutcomes: string[];
};

const cap = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export function renderMarkdown(out: Out, runDate: string): string {
  const lines: string[] = [
    "---",
    "type: report",
    "status: final",
    'related: ["#25", "#26"]',
    "review_by: 2027-01-17",
    "---",
    "",
    `# Meta defense benchmark: do suggested answers show up in sides that beat an archetype? (run ${runDate})`,
    "",
    "Generated by `pnpm bench:meta-defense`; do not edit by hand. Aggregates only: no per-game, per-player or per-deck rows.",
    "",
    "LOCAL ONLY (decision D22): this report rests partly on private Karabast games. Do not commit it, publish it or copy its numbers into tool output.",
    "",
    "## TL;DR",
    "",
  ];
  const tournament = out.results.find((r) => r.source === "tournament-results");
  if (tournament === undefined) {
    lines.push(
      "- Tournament match results with decklists, the primary outcome source, are not captured yet (#26): the swumetastats matchups give wins per leader and base pair but no card lists, so they cannot show which cards a winning side played. The figures below rest on the secondary source only.",
    );
  }
  for (const r of out.results) {
    lines.push(
      `- ${cap(r.label)}: answer cards have a mean log ratio (rate in sides that beat the archetype's leader over rate in sides that lost to it) of ${fmt(r.contrast.answers)}; other eligible cards ${fmt(r.contrast.controls)}. Difference, answers minus controls: ${fmt(r.contrast.difference)}${r.contrast.difference.value === null ? "" : `, a lift of x${Math.exp(r.contrast.difference.value).toFixed(2)} in how much more often an answer shows in winning sides than a control does`}.`,
    );
  }
  lines.push(
    `- Leaders of the ${out.archetypes} largest tournament archetypes with no outcome data (newer than the capture or never faced): ${out.leadersWithoutOutcomes.join("; ") || "none"}.`,
    "- Read it as association, not effect: a winning side has more turns to show its cards, and players who include answers may simply be stronger players.",
    "",
    "## Method",
    "",
    `- Archetypes: the ${out.archetypes} largest tournament archetypes of ${out.window.from}..${out.window.to} (meta/archetypes.json); the answers to a leader are the union of the counter-table answers (data/counters.json v${out.counterTableVersion}) to that leader's archetypes among them.`,
    "- Units: every side that faced one of those leaders and has a known result. A card is eligible on a side whose leader and base cover its aspect icons, and only if the source shows the card at all.",
    `- Per (leader, card): log ratio = ln((a + 0.5) / (winners + 1)) - ln((b + 0.5) / (losers + 1)), a and b the winning and losing sides showing the card; kept when both groups hold at least ${out.minSides} eligible sides and the card shows at least ${out.minSeen} times.`,
    `- Controls: every other eligible card against the same leader. Intervals: seeded percentile bootstrap, ${out.iterations} draws, resampling distinct cards (a card's values against every leader move together).`,
    "",
  );
  for (const r of out.results) {
    lines.push(
      `## ${cap(r.label)}`,
      "",
      `Measured card-leader values: ${r.measured}.`,
      "",
      "By threat answered (answers to that threat against all controls):",
      "",
    );
    for (const t of r.threats) lines.push(`- ${t.threat}: answers ${fmt(t.answers)}; difference ${fmt(t.difference)}.`);
    lines.push("", "By archetype leader:", "");
    for (const b of r.byLeader)
      lines.push(
        `- ${b.title}: up to ${b.sides} eligible sides, ${b.answers} answer cards (mean ${b.answerMean ?? "n/a"}), ${b.controls} controls (mean ${b.controlMean ?? "n/a"}).`,
      );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

if (isMain(import.meta.url)) main();
