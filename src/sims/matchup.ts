import { z } from "zod";
import { wilson } from "../meta/stats.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../swu/canonical.js";
import { stratifiedEstimate } from "./field-stats.js";
import { shareOf, summarizeLadder, type LadderPair, type Share } from "./policies/ladder-stats.js";

/**
 * @displayName simulate_matchup job model
 * @strategicPurpose The owner's offline battle-test (#116): a deck against real tournament decklists, against its own
 * variant on paired seeds, or against another deck, with an honest interval and the bot-play label (D21). Everything
 * here is deterministic, so the same input on the same code and engine is the same job and the same answer.
 * @tacticalObjective Parses the tool input (Zod v4 strict), checks the deck against the card table, canonicalises the
 * input and keys the job by its hash plus code commit, engine pin and gate record, applies OUT>IN swaps, lays out the
 * seeds (paired seat-swapped head-to-head with a mirror on the same seeds; one seed and seat per opponent draw shared
 * by both decks of a variant comparison), summarises games (Wilson per opponent, share-weighted field with a
 * stratified bootstrap, the sign test for a head-to-head) and renders the labelled, hashed result.
 */

export const MATCHUP_LIMITS = {
  /** Games per opponent (per stratum for the field), and seeds for a head-to-head. */
  gamesDefault: 100,
  gamesMax: 400,
  /** Every game a job plays; at the measured 1.2 rung 3 games per second on 12 workers, about 42 minutes. */
  jobGamesMax: 3000,
  deckMin: 50,
  deckMax: 60,
  copiesMax: 3,
  swapsMax: 10,
  /** Field strata: the top six archetypes plus rest-of-field (src/sims/opponents.ts stratifiedPlan). */
  fieldStrata: 7,
} as const;

const cardKey = z.string().regex(/^[0-9]{6,9}$/, { error: "a cardKey is 6 to 9 digits, for example 09010018" });
export const matchupDeckSchema = z.strictObject({
  leader: cardKey.describe("Leader cardKey"),
  base: cardKey.describe("Base cardKey"),
  cards: z
    .array(z.strictObject({ cardKey, count: z.int().min(1, { error: "count is at least 1" }) }))
    .min(1, { error: "cards is empty" })
    .describe("Main deck as { cardKey, count } rows"),
});
export type MatchupDeck = z.infer<typeof matchupDeckSchema>;

const swap = z.string().regex(/^[0-9]{6,9}>[0-9]{6,9}$/, { error: "a swap is OUT>IN: the cardKey taken out, >, the cardKey put in" });

export const simulateMatchupShape = {
  deck: matchupDeckSchema.optional().describe("The deck to battle-test: leader and base cardKeys and the main deck (or give swudb)"),
  opponent: z
    .string()
    .min(1)
    .optional()
    .describe('An archetype id from meta_archetypes (for example t001-a98697), a tournament deck key (melee-<uuid>), or "field" for the stratified tournament field'),
  opponentDeck: matchupDeckSchema.optional().describe("A second deck for a head-to-head (my deck against my deck), on paired seeds with the seats swapped"),
  variant: z
    .array(swap)
    .min(1)
    .max(MATCHUP_LIMITS.swapsMax)
    .optional()
    .describe("OUT>IN cardKey swaps, one copy each. Alone: the deck head-to-head against this variant with a mirror control. With opponent: both decks against the same opponents and seeds, paired"),
  games: z
    .int()
    .min(2)
    .max(MATCHUP_LIMITS.gamesMax)
    .optional()
    .describe(`Games per opponent (per stratum for the field) or seeds for a head-to-head; default ${MATCHUP_LIMITS.gamesDefault}, at most ${MATCHUP_LIMITS.gamesMax}`),
  seed: z.union([z.int().nonnegative(), z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, { error: "seed is a number or up to 32 letters, digits, _ or -" })]).optional().describe("Seed for draws and games; default 1"),
  policy: z.string().min(1).optional().describe("Bot rung on both seats; default the highest rung whose calibration gate passed. Only a rung with a passing gate record may report a win share"),
  dryRun: z.boolean().optional().describe("Return the plan (pilot rung, games, estimated time, job key) without starting a job"),
};

export const simulateMatchupInputSchema = z.strictObject(simulateMatchupShape);

export type MatchupMode = "opponent" | "h2h" | "variant-vs-opponent";

export interface MatchupInput {
  mode: MatchupMode;
  deck: MatchupDeck;
  opponent: string | null;
  opponentDeck: MatchupDeck | null;
  variant: string[];
  games: number;
  seed: string;
  policy: string | null;
  dryRun: boolean;
}

/** Games a job plays, before any is played: the cap check. */
export function plannedGames(x: Pick<MatchupInput, "mode" | "opponent" | "games">): number {
  const perOpponent = x.opponent === "field" ? MATCHUP_LIMITS.fieldStrata * x.games : x.games;
  if (x.mode === "h2h") return 3 * x.games;
  return x.mode === "variant-vs-opponent" ? 2 * perOpponent : perOpponent;
}

export function parseMatchupInput(raw: unknown): { ok: true; input: MatchupInput } | { ok: false; error: string } {
  const r = simulateMatchupInputSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: `simulate_matchup input: ${z.prettifyError(r.error)}` };
  const a = r.data;
  if (a.deck === undefined) return { ok: false, error: "give deck (leader, base and cards by cardKey) or swudb" };
  const deck = a.deck;
  if (a.opponentDeck !== undefined && (a.opponent !== undefined || a.variant !== undefined)) return { ok: false, error: "give opponentDeck alone: it is a head-to-head, which takes no opponent and no variant" };
  if (a.opponent === undefined && a.opponentDeck === undefined && a.variant === undefined) return { ok: false, error: 'give opponent (an archetype id, a tournament deck key or "field"), opponentDeck, or variant' };
  const mode: MatchupMode = a.opponentDeck !== undefined || a.opponent === undefined ? "h2h" : a.variant !== undefined ? "variant-vs-opponent" : "opponent";
  const input: MatchupInput = {
    mode,
    deck,
    opponent: a.opponent ?? null,
    opponentDeck: a.opponentDeck ?? null,
    variant: a.variant ?? [],
    games: a.games ?? MATCHUP_LIMITS.gamesDefault,
    seed: String(a.seed ?? 1),
    policy: a.policy ?? null,
    dryRun: a.dryRun ?? false,
  };
  const planned = plannedGames(input);
  if (planned > MATCHUP_LIMITS.jobGamesMax) return { ok: false, error: `this request plays ${planned} games; a job plays at most ${MATCHUP_LIMITS.jobGamesMax} games, so lower games (the field plays it once per each of ${MATCHUP_LIMITS.fieldStrata} strata)` };
  return { ok: true, input };
}

export type CardLookup = (cardKey: string) => { type: string; title: string } | undefined;

/** Premier checks the engine does not make (forceteki's Deck builds any list): 50 to 60 cards, at most 3 copies, a Leader and a Base in their slots. */
export function validateDeck(deck: MatchupDeck, lookup: CardLookup, label = "deck"): string | null {
  const leader = lookup(deck.leader);
  if (leader === undefined) return `${label}: no card with cardKey ${deck.leader}`;
  if (leader.type !== "Leader") return `${label}: leader ${deck.leader} is a ${leader.type}, not a Leader`;
  const base = lookup(deck.base);
  if (base === undefined) return `${label}: no card with cardKey ${deck.base}`;
  if (base.type !== "Base") return `${label}: base ${deck.base} is a ${base.type}, not a Base`;
  const counts = mergeCards(deck.cards);
  for (const c of counts) {
    const card = lookup(c.cardKey);
    if (card === undefined) return `${label}: no card with cardKey ${c.cardKey}`;
    if (card.type === "Leader" || card.type === "Base") return `${label}: ${c.cardKey} (${card.title}) is a ${card.type} and cannot be in the main deck`;
    if (c.count > MATCHUP_LIMITS.copiesMax) return `${label}: ${c.count} copies of ${c.cardKey} (${card.title}); Premier allows ${MATCHUP_LIMITS.copiesMax}`;
  }
  const total = counts.reduce((s, c) => s + c.count, 0);
  if (total < MATCHUP_LIMITS.deckMin || total > MATCHUP_LIMITS.deckMax)
    return `${label}: ${total} cards in the main deck; simulate_matchup plays Premier decks of ${MATCHUP_LIMITS.deckMin} to ${MATCHUP_LIMITS.deckMax} cards (the range the engine was tested on)`;
  return null;
}

function mergeCards(cards: readonly { cardKey: string; count: number }[]): { cardKey: string; count: number }[] {
  const m = new Map<string, number>();
  for (const c of cards) m.set(c.cardKey, (m.get(c.cardKey) ?? 0) + c.count);
  return [...m].map(([k, count]) => ({ cardKey: k, count })).sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
}

const canonicalDeck = (d: MatchupDeck): MatchupDeck => ({ leader: d.leader, base: d.base, cards: mergeCards(d.cards) });

/** OUT>IN swaps, one copy each, in order; the same transform as src/sims/policies/deck-swap.ts on cardKeys. */
export function applySwaps(deck: MatchupDeck, swaps: readonly string[]): MatchupDeck {
  const cards = mergeCards(deck.cards);
  for (const s of swaps) {
    const [out, inn] = s.split(">");
    const o = cards.find((c) => c.cardKey === out);
    if (o === undefined || o.count < 1) throw new Error(`swap ${s}: ${out} is not in the deck`);
    o.count--;
    const i = cards.find((c) => c.cardKey === inn);
    if (i !== undefined) i.count++;
    else cards.push({ cardKey: inn, count: 1 });
  }
  return { ...deck, cards: mergeCards(cards.filter((c) => c.count > 0)) };
}

export interface CanonicalInput {
  mode: MatchupMode;
  deck: MatchupDeck;
  opponent: string | null;
  opponentDeck: MatchupDeck | null;
  variant: string[];
  games: number;
  seed: string;
  policy: string;
}

export function canonicalInput(x: MatchupInput, policy: string): CanonicalInput {
  return { mode: x.mode, deck: canonicalDeck(x.deck), opponent: x.opponent, opponentDeck: x.opponentDeck === null ? null : canonicalDeck(x.opponentDeck), variant: [...x.variant], games: x.games, seed: x.seed, policy };
}

export interface JobPins {
  codeCommit: string;
  engineCommit: string;
  cardDataSha256: string;
  gateRecordSha256: string;
}

export const inputHash = (c: CanonicalInput): string => sha256Hex(canonicalJson(c));
export const jobKey = (c: CanonicalInput, pins: JobPins): string => sha256Hex(canonicalJson({ input: c, pins }));

export function h2hPlan(seed: string, games: number): { pairs: { seed: string }[]; mirror: string[] } {
  const seeds = Array.from({ length: games }, (_, q) => `${seed}|h2h|${q}`);
  return { pairs: seeds.map((s) => ({ seed: s })), mirror: seeds };
}

/** One engine seed and our seat per opponent draw; a variant comparison plays both decks on this same plan. */
export function opponentPlan(seed: string, draws: readonly { stratum: string; index: number }[]): { stratum: string; index: number; seed: string; subjectSeat: 1 | 2 }[] {
  return draws.map((d) => ({ stratum: d.stratum, index: d.index, seed: `${seed}|${d.stratum}|${d.index}`, subjectSeat: d.index % 2 === 0 ? 1 : 2 }));
}

export interface SubjectGame {
  stratum: string;
  /** Null when not decisive. */
  won: boolean | null;
  endCondition: string;
  rounds: number;
  /** Our end board (cardKeys, or ~internal names the bridge lacks). */
  endBoard: readonly string[];
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;

export function endBoardTop(games: readonly SubjectGame[], k = 8): { cardKey: string; games: number }[] {
  const m = new Map<string, number>();
  for (const g of games) for (const c of new Set(g.endBoard)) m.set(c, (m.get(c) ?? 0) + 1);
  return [...m]
    .map(([c, n]) => ({ cardKey: c, games: n }))
    .sort((a, b) => b.games - a.games || compareCodePoints(a.cardKey, b.cardKey))
    .slice(0, k);
}

export interface StratumInfo {
  id: string;
  name: string;
  weight: number;
}

export function summarizeVsOpponent(games: readonly SubjectGame[], strata: readonly StratumInfo[], opts: { field: boolean; seed: string }) {
  const decided = games.filter((g) => g.won !== null);
  const wins = decided.filter((g) => g.won === true).length;
  const raw = wilson(wins, decided.length);
  const perArchetype = strata.map((s) => {
    const gs = games.filter((g) => g.stratum === s.id);
    const d = gs.filter((g) => g.won !== null);
    const w = d.filter((g) => g.won === true).length;
    return { id: s.id, name: s.name, weight: r4(s.weight), games: gs.length, n: d.length, wins: w, winShare: d.length === 0 ? null : r4(w / d.length), wilson95: wilson(w, d.length) };
  });
  const base = {
    games: games.length,
    n: decided.length,
    wins,
    drawRate: games.length === 0 ? 0 : r4(games.filter((g) => g.won === null && g.endCondition !== "error").length / games.length),
    errorRate: games.length === 0 ? 0 : r4(games.filter((g) => g.endCondition === "error").length / games.length),
    meanRounds: games.length === 0 ? 0 : Math.round((games.reduce((s, g) => s + g.rounds, 0) / games.length) * 100) / 100,
    endBoardTopCards: endBoardTop(games),
    perArchetype,
  };
  if (!opts.field) return { ...base, winShare: decided.length === 0 ? null : r4(wins / decided.length), wilson95: raw, rawShare: null, interval95: null };
  const est = stratifiedEstimate(
    strata.map((s) => {
      const gs = games.filter((g) => g.stratum === s.id);
      return { id: s.id, weight: s.weight, wins: gs.filter((g) => g.won === true).length, losses: gs.filter((g) => g.won === false).length, draws: gs.filter((g) => g.won === null && g.endCondition !== "error").length, errors: gs.filter((g) => g.endCondition === "error").length };
    }),
    { seed: `simulate_matchup|${opts.seed}` },
  );
  return {
    ...base,
    winShare: est.winShare,
    interval95: { low: est.ci95.low, high: est.ci95.high, method: `share-weighted strata, stratified percentile bootstrap (${est.bootstrap.iterations} resamples); Wilson does not apply to a weighted mean` },
    fieldCoverage: est.coverage,
    rawShare: decided.length === 0 ? null : r4(wins / decided.length),
    wilson95: raw,
  };
}

export interface H2HPairInput {
  seed: string;
  /** Winner seat of the game with our deck in seat 1. */
  a: 1 | 2 | null;
  /** Winner seat of the game with our deck in seat 2. */
  b: 1 | 2 | null;
}

export function summarizeH2H(pairs: readonly H2HPairInput[], mirrorWinners: readonly (1 | 2 | null)[]) {
  const lp: LadderPair[] = pairs.map((p) => ({ seed: 0, deck1: "deck", deck2: "deck", a: { winner: p.a, endCondition: p.a === null ? "draw" : "base_destroyed" }, b: { winner: p.b, endCondition: p.b === null ? "draw" : "base_destroyed" } }));
  const s = summarizeLadder(lp, ["deck"]);
  const decided = mirrorWinners.filter((w) => w !== null);
  return {
    pairs: pairs.length,
    games: s.games,
    nonDecisive: s.nonDecisive,
    deckShare: s.pooled as Share,
    discordant: { deckWonBoth: s.discordant.candidate2to0, otherWonBoth: s.discordant.baseline2to0, pValue: s.discordant.pValue },
    mirror: { games: mirrorWinners.length, nonDecisive: mirrorWinners.length - decided.length, seat1Share: shareOf(decided.filter((w) => w === 1).length, decided.length) },
  };
}

export const matchupLabel = (policy: string): string => `bot play (forceteki ${policy}), not human results`;

export interface RenderArgs {
  body: Record<string, unknown>;
  policy: string;
  policyVersion: string;
  inputHash: string;
  codeCommit: string;
  engine: { commit: string; cardDataVersion: string };
  seed: string;
}

/** The finished result: body, fixed label, candidate status and the replay record; outputHash covers everything else. */
export function renderResult(a: RenderArgs) {
  const replay = { inputHash: a.inputHash, codeCommit: a.codeCommit, engineCommit: a.engine.commit, cardDataVersion: a.engine.cardDataVersion, seed: a.seed, policy: a.policy, policyVersion: a.policyVersion, rungs: [a.policy, a.policy] as [string, string] };
  const unhashed = { label: matchupLabel(a.policy), status: "candidate" as const, ...a.body, replay };
  return { ...unhashed, replay: { ...replay, outputHash: sha256Hex(canonicalJson(unhashed)) } };
}

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, { error: "expected a sha256 hex digest" });

/** Job state lives under the repo's git-ignored tmp/, one directory per job key. */
export const SIMS_JOBS_DIR = "tmp/sims-jobs";

export const canonicalInputSchema = z.strictObject({
  mode: z.enum(["opponent", "h2h", "variant-vs-opponent"]),
  deck: matchupDeckSchema,
  opponent: z.string().min(1).nullable(),
  opponentDeck: matchupDeckSchema.nullable(),
  variant: z.array(swap),
  games: z.int().min(2).max(MATCHUP_LIMITS.gamesMax),
  seed: z.string().min(1),
  policy: z.string().min(1),
});

/** What the tool hands the detached job runner; both sides parse it. */
export const jobFileSchema = z.strictObject({
  key: hex64,
  inputHash: hex64,
  input: canonicalInputSchema,
  gateRecord: z.string().min(1),
  pins: z.strictObject({ codeCommit: z.string().min(7), engineCommit: z.string().min(7), cardDataSha256: hex64, gateRecordSha256: hex64 }),
  workers: z.int().positive(),
  plannedGames: z.int().positive(),
});
export type JobFile = z.infer<typeof jobFileSchema>;

export const jobStatusSchema = z.strictObject({
  state: z.enum(["running", "done", "failed"]),
  key: hex64,
  pid: z.int().positive(),
  plannedGames: z.int().nonnegative(),
  error: z.string().nullable(),
});
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobLockSchema = z.strictObject({ key: hex64, pid: z.int().positive() });

export const jobProgressSchema = z.looseObject({ done: z.number(), total: z.number().nullable(), pct: z.number().nullable(), eta_s: z.number().nullable(), phase: z.string().optional(), games_per_s: z.number().optional(), stats: z.unknown().optional() });

export const jobResultSchema = z.looseObject({ label: z.string().min(1), status: z.literal("candidate"), replay: z.looseObject({ inputHash: hex64, outputHash: hex64 }) });
