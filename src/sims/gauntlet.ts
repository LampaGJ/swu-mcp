import { z } from "zod";
import { canonicalJson, compareCodePoints } from "../swu/canonical.js";
import { applySwaps, h2hPlan, matchupDeckSchema, opponentPlan, relativeLabel, summarizeRelative, type MatchupDeck, type SubjectGame } from "./matchup.js";

/**
 * @displayName Deck gauntlet model
 * @strategicPurpose The owner's deck gauntlet (#198, 2026-11-01: "once we have deck ideas i want to build them and simulate
 * them against known tournament-winning decks and other tests we have established"): many built ideas, each compared with
 * a reference list on identical shuffles against a panel of tournament-winning lists, cheap screen first, fair confirm
 * second. Bot play, the last data tier (D21): a relative comparison, never a tournament win rate (D108).
 * @tacticalObjective Builds the tournament-winner panel (manipulation node, reduces: the best-placed buildable list of
 * each of the top archetypes in a window, weighted by share; the best list per named leader as references), lays out the
 * games (D108's relative design per idea, with the reference's field games played once and shared), summarises each idea
 * with summarizeRelative, ranks by the low end of the paired field difference, builds the dead-card control (D98) and says
 * whether a run detected it. Pure and deterministic: no clock, no Math.random, code-point order everywhere.
 */

export const GAUNTLET_VERSION = "gauntlet-v1";
export const PANEL_VERSION = "tournament-panel-v1";
/** The fair lookahead pilot of #183 (D109): re-deals hidden cards before every trial. */
export const FAIR_RUNG = "rung3:k=8,det=4,belief=known";
/** Coastal Catamaran, the dead card of the D98 control. */
export const DEAD_CARD_ID = "HMW_093";

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;

// ---------------------------------------------------------------------------------------------------------------------
// Tournament-winner panel

export interface PanelCandidate {
  leader: string;
  /** Null when no single base card bears the list's base name. */
  base: string | null;
  baseAspects: string[];
  /** `swumetastats:<tournament id>`. */
  event: string;
  eventSize: number | null;
  date: string;
  placement: number | null;
  record: { wins: number; losses: number; draws: number } | null;
  cards: [string, number][];
  /** Main-deck lines the resolver could not place; a list with any is never a panel deck. */
  unmappedLines: number;
}

export interface PanelOptions {
  top: number;
  window: { from: string; to: string; label: string };
  /** Cards of the deck the engine cannot build. */
  unbuildable: (deck: MatchupDeck) => string[];
  referenceLeaders: readonly string[];
  deckMin?: number;
  deckMax?: number;
  copiesMax?: number;
}

const archetypeKey = (c: Pick<PanelCandidate, "leader" | "baseAspects">): string => `${c.leader}|${[...c.baseAspects].sort(compareCodePoints).join("+")}`;

const deckOf = (c: PanelCandidate): MatchupDeck => ({
  leader: c.leader,
  base: c.base as string,
  cards: c.cards.map(([cardKey, count]) => ({ cardKey, count })).sort((a, b) => compareCodePoints(a.cardKey, b.cardKey)),
});

/** 1st place first, then the best record, then the larger event, then newer; the event and the list itself break a tie. */
function placingOrder(a: PanelCandidate, b: PanelCandidate): number {
  const place = (c: PanelCandidate): number => c.placement ?? Number.POSITIVE_INFINITY;
  return (
    place(a) - place(b) ||
    (b.record?.wins ?? -1) - (a.record?.wins ?? -1) ||
    (a.record?.losses ?? Number.POSITIVE_INFINITY) - (b.record?.losses ?? Number.POSITIVE_INFINITY) ||
    (b.eventSize ?? 0) - (a.eventSize ?? 0) ||
    compareCodePoints(b.date, a.date) ||
    compareCodePoints(a.event, b.event) ||
    compareCodePoints(canonicalJson(a.cards), canonicalJson(b.cards))
  );
}

interface ListFacts {
  event: string;
  eventSize: number | null;
  date: string;
  placement: number | null;
  record: string | null;
  deck: MatchupDeck;
}

const factsOf = (c: PanelCandidate): ListFacts => ({
  event: c.event,
  eventSize: c.eventSize,
  date: c.date,
  placement: c.placement,
  record: c.record === null ? null : `${c.record.wins}-${c.record.losses}-${c.record.draws}`,
  deck: deckOf(c),
});

export function buildTournamentPanel(candidates: readonly PanelCandidate[], o: PanelOptions) {
  const deckMin = o.deckMin ?? 50;
  const deckMax = o.deckMax ?? 60;
  const copiesMax = o.copiesMax ?? 3;
  const inWindow = candidates.filter((c) => compareCodePoints(c.date, o.window.from) >= 0 && compareCodePoints(c.date, o.window.to) <= 0);
  const complete = (c: PanelCandidate): boolean => {
    if (c.base === null || c.unmappedLines > 0) return false;
    const total = c.cards.reduce((s, [, n]) => s + n, 0);
    return total >= deckMin && total <= deckMax && c.cards.every(([, n]) => n <= copiesMax);
  };
  /** The best complete, buildable list, and how many complete lists placed above it the engine could not build. */
  const best = (lists: readonly PanelCandidate[]): { pick: PanelCandidate | null; setAside: number } => {
    let setAside = 0;
    for (const c of [...lists].sort(placingOrder)) {
      if (!complete(c)) continue;
      if (o.unbuildable(deckOf(c)).length === 0) return { pick: c, setAside };
      setAside++;
    }
    return { pick: null, setAside };
  };

  const byArchetype = new Map<string, PanelCandidate[]>();
  for (const c of inWindow) byArchetype.set(archetypeKey(c), [...(byArchetype.get(archetypeKey(c)) ?? []), c]);
  const ranked = [...byArchetype].sort((a, b) => b[1].length - a[1].length || compareCodePoints(a[0], b[0]));
  const picked: { key: string; lists: PanelCandidate[]; pick: PanelCandidate; setAside: number }[] = [];
  const skippedArchetypes: { key: string; lists: number; reason: string }[] = [];
  for (const [key, lists] of ranked) {
    if (picked.length >= o.top) break;
    const b = best(lists);
    if (b.pick === null) skippedArchetypes.push({ key, lists: lists.length, reason: `no complete list the engine can build (${b.setAside} set aside as unbuildable)` });
    else picked.push({ key, lists, pick: b.pick, setAside: b.setAside });
  }
  const keptLists = picked.reduce((s, p) => s + p.lists.length, 0);
  const entries = picked.map((p, k) => {
    const f = factsOf(p.pick);
    return {
      id: `p${String(k + 1).padStart(2, "0")}`,
      archetype: { key: p.key, leader: p.pick.leader, baseAspects: [...p.pick.baseAspects].sort(compareCodePoints), lists: p.lists.length, share: r4(p.lists.length / inWindow.length) },
      weight: p.lists.length / keptLists,
      event: f.event,
      eventSize: f.eventSize,
      date: f.date,
      placement: f.placement,
      record: f.record,
      deck: f.deck,
      setAsideUnbuildable: p.setAside,
    };
  });
  const references = [...new Set(o.referenceLeaders)].sort(compareCodePoints).map((leader) => {
    const lists = inWindow.filter((c) => c.leader === leader);
    const b = best(lists);
    return { leader, lists: lists.length, entry: b.pick === null ? null : { ...factsOf(b.pick), baseAspects: [...b.pick.baseAspects].sort(compareCodePoints) }, setAsideUnbuildable: b.setAside };
  });
  return {
    window: o.window,
    top: o.top,
    listsInWindow: inWindow.length,
    archetypesInWindow: byArchetype.size,
    incompleteInWindow: inWindow.filter((c) => !complete(c)).length,
    entries,
    skippedArchetypes,
    references,
  };
}

export type TournamentPanel = ReturnType<typeof buildTournamentPanel>;

const isoDate = z.iso.date();
const listFacts = {
  event: z.string().regex(/^swumetastats:[0-9]+$/, { error: "event is swumetastats:<tournament id>" }),
  eventSize: z.int().nonnegative().nullable(),
  date: isoDate,
  placement: z.int().positive().nullable(),
  record: z.string().regex(/^[0-9]+-[0-9]+-[0-9]+$/, { error: "record is wins-losses-draws" }).nullable(),
  deck: matchupDeckSchema,
};

/** The pinned panel file under data/pinned/sim-panels/: the gauntlet parses it at the boundary. */
export const panelFileSchema = z.strictObject({
  kind: z.literal("sim-tournament-panel"),
  version: z.literal(PANEL_VERSION),
  source: z.literal("swumetastats.com"),
  population: z.string().min(1),
  tier: z.string().min(1),
  capture: z.string().min(1),
  window: z.strictObject({ from: isoDate, to: isoDate, label: z.string() }),
  top: z.int().positive(),
  listsInWindow: z.int().nonnegative(),
  archetypesInWindow: z.int().nonnegative(),
  incompleteInWindow: z.int().nonnegative(),
  entries: z.array(
    z.strictObject({
      id: z.string().regex(/^p[0-9]{2}$/),
      archetype: z.strictObject({ key: z.string(), leader: z.string(), leaderTitle: z.string(), baseAspects: z.array(z.string()), lists: z.int().positive(), share: z.number() }),
      weight: z.number().positive(),
      ...listFacts,
      setAsideUnbuildable: z.int().nonnegative(),
    }),
  ),
  skippedArchetypes: z.array(z.strictObject({ key: z.string(), lists: z.int(), reason: z.string() })),
  references: z.array(
    z.strictObject({
      leader: z.string(),
      leaderTitle: z.string(),
      lists: z.int().nonnegative(),
      entry: z.strictObject({ ...listFacts, baseAspects: z.array(z.string()) }).nullable(),
      setAsideUnbuildable: z.int().nonnegative(),
    }),
  ),
});
export type PanelFile = z.infer<typeof panelFileSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Dead-card control (D98)

const NUMBER_WORDS = ["no", "one", "two", "three", "four"];

/** The reference with `want` copies of the dead card swapped in, fewer when the copy limit refuses; copies come out of the most-played, then costliest cards. */
export function deadCardControl(reference: MatchupDeck, o: { deadCard: string; want: number; copiesMax: number; costOf: (cardKey: string) => number | null }) {
  const have = reference.cards.filter((c) => c.cardKey === o.deadCard).reduce((s, c) => s + c.count, 0);
  const n = Math.max(0, Math.min(o.want, o.copiesMax - have));
  const order = reference.cards
    .filter((c) => c.cardKey !== o.deadCard)
    .sort((a, b) => b.count - a.count || (o.costOf(b.cardKey) ?? -1) - (o.costOf(a.cardKey) ?? -1) || compareCodePoints(a.cardKey, b.cardKey));
  const left = new Map(order.map((c) => [c.cardKey, c.count]));
  const swaps: string[] = [];
  for (let k = 0; swaps.length < n && order.length > 0; k = (k + 1) % order.length) {
    const key = order[k].cardKey;
    if ((left.get(key) ?? 0) === 0) continue;
    left.set(key, (left.get(key) as number) - 1);
    swaps.push(`${key}>${o.deadCard}`);
  }
  const note =
    n === o.want
      ? `${NUMBER_WORDS[n] ?? n} copies of the dead card in for the reference's most-played cards`
      : `the ${NUMBER_WORDS[n] ?? n}-card version: Premier allows ${o.copiesMax} copies of a card, so ${NUMBER_WORDS[o.want] ?? o.want} cannot go in`;
  return { swaps, deck: applySwaps(reference, swaps), note };
}

// ---------------------------------------------------------------------------------------------------------------------
// Planning

export interface PlanDeck {
  id: string;
  deck: MatchupDeck;
}

export interface PlanInput {
  seed: string;
  /** Seeds of the head to head, each played in both seat orders, plus the idea's mirror on the same seeds. */
  h2hPairs: number;
  /** Games per panel list for the idea and, on the same seeds and seats, for its reference. */
  fieldGames: number;
  ideas: readonly (PlanDeck & { reference: string })[];
  references: readonly PlanDeck[];
  panel: readonly (PlanDeck & { name: string; weight: number })[];
}

export interface PlannedGame {
  key: string;
  seed: string;
  /** Deck ids in seat 1 and seat 2. */
  seats: [string, string];
  /** The seed's index within its head to head or panel list. */
  index: number;
}

export interface IdeaPlan {
  id: string;
  reference: string;
  h2h: { seed: string; a: number; b: number }[];
  mirror: number[];
  field: { stratum: string; index: number; idea: number; reference: number }[];
}

export function planGauntlet(x: PlanInput): { games: PlannedGame[]; ideas: IdeaPlan[] } {
  const ids = [...x.ideas.map((d) => d.id), ...x.references.map((d) => d.id), ...x.panel.map((d) => d.id)];
  const dup = ids.find((id, k) => ids.indexOf(id) !== k);
  if (dup !== undefined) throw new Error(`deck id ${dup} is used twice`);
  const refIds = new Set(x.references.map((r) => r.id));
  const games: PlannedGame[] = [];
  const at = new Map<string, number>();
  const game = (seed: string, seats: [string, string], index: number): number => {
    const key = `${seed}\u0000${seats[0]}\u0000${seats[1]}`;
    const known = at.get(key);
    if (known !== undefined) return known;
    games.push({ key, seed, seats, index });
    at.set(key, games.length - 1);
    return games.length - 1;
  };
  const h2h = h2hPlan(x.seed, x.h2hPairs);
  const field = opponentPlan(
    x.seed,
    x.panel.flatMap((p) => Array.from({ length: x.fieldGames }, (_, index) => ({ stratum: p.id, index }))),
  );
  const ideas = x.ideas.map((idea) => {
    if (!refIds.has(idea.reference)) throw new Error(`idea ${idea.id}: no reference ${idea.reference}`);
    const seats = (subject: string, opponent: string, subjectSeat: 1 | 2): [string, string] => (subjectSeat === 1 ? [subject, opponent] : [opponent, subject]);
    return {
      id: idea.id,
      reference: idea.reference,
      h2h: h2h.pairs.map((pr, q) => ({ seed: pr.seed, a: game(pr.seed, [idea.id, idea.reference], q), b: game(pr.seed, [idea.reference, idea.id], q) })),
      mirror: h2h.mirror.map((s, q) => game(s, [idea.id, idea.id], q)),
      field: field.map((f) => ({
        stratum: f.stratum,
        index: f.index,
        idea: game(f.seed, seats(idea.id, f.stratum, f.subjectSeat), f.index),
        reference: game(f.seed, seats(idea.reference, f.stratum, f.subjectSeat), f.index),
      })),
    };
  });
  return { games, ideas };
}

// ---------------------------------------------------------------------------------------------------------------------
// Summary and ranking

export interface GameOutcome {
  winner: 1 | 2 | null;
  endCondition: string;
  rounds: number;
}

const decisive = (o: GameOutcome): boolean => o.endCondition === "base_destroyed" && o.winner !== null;

function subjectGame(plan: { games: readonly PlannedGame[] }, outcomes: readonly GameOutcome[], index: number, subject: string, stratum: string): SubjectGame {
  const g = plan.games[index];
  const o = outcomes[index];
  const seat = g.seats[0] === subject ? 1 : 2;
  return { stratum, won: decisive(o) ? o.winner === seat : null, endCondition: o.endCondition === "base_destroyed" && o.winner === null ? "draw" : o.endCondition, rounds: o.rounds, endBoard: [] };
}

/** One idea's relative result (D108): head to head and mirror against its reference, and the paired difference on the panel. */
export function summarizeIdea(plan: { games: readonly PlannedGame[] }, ip: IdeaPlan, outcomes: readonly GameOutcome[], panel: readonly { id: string; name: string; weight: number }[], seed: string) {
  if (outcomes.length !== plan.games.length) throw new Error(`${outcomes.length} outcomes for ${plan.games.length} planned games`);
  const winner = (k: number): 1 | 2 | null => (decisive(outcomes[k]) ? outcomes[k].winner : null);
  return summarizeRelative({
    h2hPairs: ip.h2h.map((pr) => ({ seed: pr.seed, a: winner(pr.a), b: winner(pr.b) })),
    mirrorWinners: ip.mirror.map(winner),
    h2hGames: ip.h2h.flatMap((pr) => [subjectGame(plan, outcomes, pr.a, ip.id, "h2h"), subjectGame(plan, outcomes, pr.b, ip.id, "h2h")]),
    field: {
      deck: ip.field.map((f) => subjectGame(plan, outcomes, f.idea, ip.id, f.stratum)),
      variant: ip.field.map((f) => subjectGame(plan, outcomes, f.reference, ip.reference, f.stratum)),
      strata: panel.map((p) => ({ id: p.id, name: p.name, weight: p.weight })),
    },
    seed: `gauntlet|${seed}`,
  });
}

export type IdeaSummary = ReturnType<typeof summarizeIdea>;

export function rankIdeas(rows: readonly { id: string; result: IdeaSummary }[]) {
  const low = (r: IdeaSummary): number => r.field?.deckMinusVariant.ci95.low ?? Number.NEGATIVE_INFINITY;
  const diff = (r: IdeaSummary): number => r.field?.deckMinusVariant.difference ?? Number.NEGATIVE_INFINITY;
  return [...rows]
    .sort((a, b) => low(b.result) - low(a.result) || diff(b.result) - diff(a.result) || compareCodePoints(a.id, b.id))
    .map((r, k) => ({
      rank: k + 1,
      id: r.id,
      fieldDifference: r.result.field?.deckMinusVariant.difference ?? null,
      ci95: r.result.field?.deckMinusVariant.ci95 ?? { low: null, high: null },
      fieldPairs: r.result.field?.pairs ?? 0,
      headToHead: { winShare: r.result.headToHead.winShare, wilson95: r.result.headToHead.wilson95, n: r.result.headToHead.n },
    }));
}

export const selectForConfirm = (ranked: readonly { id: string }[], n: number): string[] => ranked.slice(0, n).map((r) => r.id);

/** The control is detected when its field interval sits wholly below zero: the ranking reads that interval, so the head to head is reported beside it but does not count. */
export function controlVerdict(r: IdeaSummary) {
  const high = r.field?.deckMinusVariant.ci95.high ?? null;
  const byField = high !== null && high < 0;
  const h2hHigh = r.headToHead.wilson95?.high ?? null;
  const byHeadToHead = h2hHigh !== null && h2hHigh < 0.5;
  return {
    detected: byField,
    byField,
    byHeadToHead,
    sentence: byField
      ? "The weakened copy of the reference scored clearly worse against the tournament panel, so this run is big enough to tell a dead-card swap apart."
      : "The weakened copy of the reference did not score clearly worse against the tournament panel, so these results are too small to rank: differences between ideas of this size are noise.",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Record and report

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, { error: "expected a sha256 hex digest" });
const resultSchema = z.looseObject({ headToHead: z.looseObject({ winShare: z.number().nullable() }), field: z.looseObject({ deckMinusVariant: z.looseObject({ difference: z.number().nullable() }) }).nullable() });
const rankRowSchema = z.strictObject({
  rank: z.int().positive(),
  id: z.string(),
  fieldDifference: z.number().nullable(),
  ci95: z.strictObject({ low: z.number().nullable(), high: z.number().nullable() }),
  fieldPairs: z.int().nonnegative(),
  headToHead: z.strictObject({ winShare: z.number().nullable(), wilson95: z.strictObject({ low: z.number(), high: z.number() }).nullable(), n: z.int().nonnegative() }),
});

/** The pinned gauntlet record under data/pinned/sim-gauntlet/<run>/<stage>.json: no clock and no commit, so a rerun is byte-identical. */
export const gauntletRecordSchema = z.strictObject({
  kind: z.literal("sim-gauntlet"),
  version: z.literal(GAUNTLET_VERSION),
  run: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  stage: z.enum(["screen", "confirm"]),
  label: z.string().min(1),
  calibration: z.string().min(1),
  status: z.literal("candidate"),
  pilot: z.strictObject({ policy: z.string(), policyVersion: z.string(), gateRecord: z.strictObject({ file: z.string(), sha256: hex64 }).nullable() }),
  population: z.strictObject({
    field: z.strictObject({
      file: z.string(),
      sha256: hex64,
      source: z.string(),
      population: z.string(),
      tier: z.string(),
      window: z.strictObject({ from: z.iso.date(), to: z.iso.date(), label: z.string() }),
      entries: z.array(z.strictObject({ id: z.string(), name: z.string(), weight: z.number(), event: z.string(), placement: z.int().nullable(), record: z.string().nullable(), date: z.iso.date() })),
    }),
    references: z.array(z.strictObject({ id: z.string(), leader: z.string(), leaderTitle: z.string(), source: z.string() })),
  }),
  design: z.string(),
  sizes: z.strictObject({ seed: z.string(), h2hPairs: z.int().positive(), fieldGames: z.int().positive(), games: z.int().positive(), ideas: z.int().nonnegative(), controls: z.int().nonnegative() }),
  confirmOf: z.strictObject({ screenSha256: hex64, top: z.int().positive() }).nullable(),
  decks: z.array(z.strictObject({ id: z.string(), role: z.enum(["idea", "control", "reference"]), name: z.string(), sha256: hex64, deck: matchupDeckSchema })),
  ideas: z.array(z.strictObject({ id: z.string(), reference: z.string(), result: resultSchema })),
  controls: z.array(
    z.strictObject({
      id: z.string(),
      reference: z.string(),
      swaps: z.array(z.string()),
      note: z.string(),
      result: resultSchema,
      verdict: z.strictObject({ detected: z.boolean(), byField: z.boolean(), byHeadToHead: z.boolean(), sentence: z.string() }),
    }),
  ),
  ranking: z.array(rankRowSchema),
  tooSmallToRank: z.boolean(),
  health: z.strictObject({ games: z.int(), decisive: z.int(), nonDecisive: z.int(), errors: z.int(), errorSamples: z.array(z.string()) }),
  engine: z.strictObject({ commit: z.string(), cardDataVersion: z.string() }),
});
export type GauntletRecord = z.infer<typeof gauntletRecordSchema>;

export interface ReportInput {
  run: string;
  stage: "screen" | "confirm";
  label: string;
  calibration: string;
  fieldText: string;
  pilot: string;
  sizes: { h2hPairs: number; fieldGames: number };
  /** Display names by deck id. */
  names: Record<string, string>;
  /** One line per reference id: who it is and where it came from. */
  referenceText: Record<string, string>;
  ranking: ReturnType<typeof rankIdeas>;
  results: Record<string, IdeaSummary>;
  references: Record<string, string>;
  controls: { id: string; reference: string; note: string; result: IdeaSummary; verdict: ReturnType<typeof controlVerdict> }[];
  judges: ReadonlyMap<string, { surprise: number; win: number; fits: number; covers: number; flags: string; risk: string; dots?: number }> | null;
  panelNames: Record<string, string>;
}

const per100 = (x: number | null): string => (x === null ? "no figure" : `${x > 0 ? "+" : ""}${(Math.round(x * 1000) / 10).toFixed(1)}`);
const share100 = (x: number | null | undefined): string => (x === null || x === undefined ? "?" : String(Math.round(x * 100)));

function fieldLine(r: IdeaSummary, refName: string): string {
  const d = r.field?.deckMinusVariant;
  if (d === undefined || d.difference === null) return "against the tournament decks: no paired games decided";
  return `against the tournament decks: ${per100(d.difference)} wins per 100 games compared with ${refName} (range ${per100(d.ci95.low)} to ${per100(d.ci95.high)})`;
}

function h2hLine(r: IdeaSummary, refName: string): string {
  const h = r.headToHead;
  if (h.winShare === null) return `head to head with ${refName}: no game decided`;
  return `head to head with ${refName}: won ${share100(h.winShare)} of every 100 games (range ${share100(h.wilson95?.low)} to ${share100(h.wilson95?.high)})`;
}

/** The plain-language report beside the record: what the owner reads. Built from the record's own figures, no clock. */
export function renderReport(x: ReportInput): string {
  const name = (id: string): string => x.names[id] ?? id;
  const out: string[] = [];
  out.push(`# Deck gauntlet ${x.run}: ${x.stage}`, "");
  out.push(`Label: ${x.label}.`, "");
  out.push(`Caveat: ${x.calibration}`, "");
  out.push("Status: candidate. This is not a VALUABLE claim: an advice-tool change needs the judged-sessions rerun first (docs/runbooks/judged-deck-sessions.md).", "");
  out.push("## What was compared", "");
  out.push(`- Each deck idea played a reference deck with the same leader, on the same shuffles, in both seat orders (${x.sizes.h2hPairs} shuffles), plus the idea against itself on those shuffles as a seat-fairness check.`);
  out.push(`- Both the idea and its reference then played ${x.fieldText}, ${x.sizes.fieldGames} games per tournament deck, on identical shuffles and seats. The key figure is how many more games out of 100 the idea won than its reference against those decks.`);
  out.push(`- Both seats were played by the computer player ${x.pilot}.`, "");
  out.push("## Control check", "");
  for (const c of x.controls) {
    const line = fieldLine(c.result, name(c.reference));
    out.push(`- ${c.id}: a copy of ${name(c.reference)} with ${c.note}. ${line.charAt(0).toUpperCase()}${line.slice(1)}; ${h2hLine(c.result, name(c.reference))}. ${c.verdict.detected ? "Detected." : "Not detected."}`);
  }
  const detected = x.controls.length > 0 && x.controls.every((c) => c.verdict.detected);
  out.push("", detected ? x.controls[0].verdict.sentence : controlVerdictText(x.controls), "");
  out.push("## Ranking", "");
  out.push("Ranked by the low end of the range of the tournament-deck figure, so an idea needs a figure that is both high and steady to rank high.", "");
  for (const r of x.ranking) {
    const res = x.results[r.id];
    const ref = name(x.references[r.id] ?? "");
    out.push(`${r.rank}. ${name(r.id)} (${r.id}): ${fieldLine(res, ref)}; ${h2hLine(res, ref)}.`);
    const j = x.judges?.get(r.id);
    out.push(j === undefined ? "   judges: no score" : `   judges: likely to win ${j.win}, fits ${j.fits}, surprise ${j.surprise}, covers ${j.covers}${j.dots === undefined ? "" : `, dots ${j.dots}`}${j.flags === "" ? "" : `; flags: ${j.flags}`}; risk: ${j.risk}`);
    const rows = (res.field?.perArchetype ?? []).map((a) => `${x.panelNames[a.id] ?? a.id} ${a.difference === null ? "no figure" : per100(a.difference)}`);
    if (rows.length > 0) out.push(`   by tournament deck (wins per 100 games compared with the reference): ${rows.join("; ")}`);
  }
  out.push("", "## Reference decks", "");
  for (const [id, text] of Object.entries(x.referenceText).sort((a, b) => compareCodePoints(a[0], b[0]))) out.push(`- ${id}: ${text}`);
  return `${out.join("\n")}\n`;
}

function controlVerdictText(controls: ReportInput["controls"]): string {
  if (controls.length === 0) return "No control ran, so these results are too small to rank.";
  const missed = controls.filter((c) => !c.verdict.detected).map((c) => c.id);
  return `Not every control was detected (${missed.join(", ")}), so these results are too small to rank: differences between ideas of this size are noise.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Labels

/** The exact label of #198 and D108. */
export const gauntletLabel = (policy: string): string => relativeLabel(policy);

/** The calibration caveat every gauntlet output carries; `measured` is whether the pilot has a pinned calibration record. */
export function calibrationLabel(policy: string, measured: boolean): string {
  const known =
    "Every measured computer player fails the outside check against real tournament results: Spearman about -0.2 against swumetastats (D88, #128). They overrate fast, aggressive decks and underrate careful ones, so these figures rank what computer players do well. Read them beside the judges' scores, never instead of them.";
  return measured ? `${policy}: ${known}` : `${policy}: calibration unmeasured (#183). ${known}`;
}
