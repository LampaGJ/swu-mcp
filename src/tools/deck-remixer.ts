import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageDirOf, readJson, type CardRow, type CardStore } from "../data.js";
import { deckIndexFileSchema, expandTier, INDEX_TIERS, type DeckIndexFile, type IndexDeck, type IndexTier } from "../meta/deck-index.js";
import {
  nearestDecks,
  popularCards,
  type Level,
  type NeighbourSet,
  type PopularRow,
  type RecordTally,
  type Target,
} from "../meta/remix.js";
import type { SleeperRow, SleepersFile } from "../meta/sleepers-schema.js";
import { compareCodePoints } from "../swu/canonical.js";
import { clauseLock, isLocked, lockSupply } from "../synergy/clause-lock.js";
import { baseEnabledOf } from "../synergy/locks.js";
import { cardLabel } from "../synergy/order.js";
import type { SynergyCard } from "../synergy/schema.js";
import type { ToolResult } from "../tools.js";
import {
  auditOutput,
  BASE_ENABLED_BONUS,
  decoded,
  ENGINE_WEIGHT,
  legalityOutput,
  LINK_WEIGHT,
  MEASURED_WEIGHT,
  pairingsOutput,
  PLAYED_WEIGHT,
  SCORE_WEIGHT,
} from "./build-deck.js";
import { fail, ok, round } from "./common.js";
import {
  LEADER_INCLUSION_FLOOR,
  MAIN_TYPES,
  baseField,
  cardScope,
  deckAudit,
  deckEnvOf,
  deckLegalityCheck,
  inPremierPool,
  leaderDataFor,
  leaderField,
  pairEvidence,
  resolveList,
  resolvePair,
  resolveRef,
  sameSlotShape,
  singlePenalty,
  slotMembers,
  suppliedBy,
  type DeckEnv,
} from "./deck.js";
import { cardList } from "./decklist-field.js";
import { findPairings } from "./synergy.js";
import { flaggedRows, holdsForSamePlayers, scopeOf, sleepersOf } from "./sleepers.js";
import { swudbDeckSchema, swudbIdOf } from "./swudb.js";

/**
 * @displayName Deck remixer
 * @strategicPurpose Owner, 2026-11-01 (#193): "deck_remixer should find cards to replace a given deck by referencing similar
 * decks for popular or sleeper cards to try for inclusion". build_deck reads all of a leader's lists; this tool reads the real
 * decks nearest the given list, so a suggestion comes from players who built something close to it.
 * @tacticalObjective Finds the decks nearest the given list in each tier of deck-index/decks.json (tournament, community; never
 * pooled, D21), lists the cards those decks run that the deck does not, adds the sleeper_cards rows that are legal for the deck's
 * aspects, matches each card to try with the deck cards it would replace, and returns the remixed 50-card list as a SWUDB document
 * with the legality check. No model, no clock, no randomness; ties break by cardKey code points.
 */

const SLEEPER_COPIES = 2;
const SLEEPER_MIN_DECKS = 20;
const SLEEPER_ROWS = 10;
const POPULAR_ROWS = 15;
const NEIGHBOUR_ROWS = 8;
const POPULAR_MIN_DECKS = 3;
/** On the same scale as build_deck's PLAYED_WEIGHT: a card every nearest deck runs weighs like a card in every list of the leader. */
const NEIGHBOUR_WEIGHT = PLAYED_WEIGHT;
const PENALTY_WEIGHT = 0.5;
/** Added to a cut candidate's keep score per step away from a like-for-like card, so a close match breaks a near tie between two weak cards but never saves a card the evidence rates well. */
const MISMATCH_WEIGHT = 0.25;
const REACH_RANK: Record<Level, number> = { "leader+base": 0, leader: 1, aspects: 2 };

export const deckRemixerShape = {
  leader: leaderField.optional().describe("The deck's leader: a cardKey, a SET_NNN id or an exact title. Required unless swudb is given"),
  base: baseField.optional().describe("The deck's base. Required unless swudb is given"),
  decklist: cardList("The deck's 50 main-deck cards as {card, count}").optional(),
  swudb: swudbDeckSchema
    .optional()
    .describe("The deck as the SWUDB JSON interchange document; its leader, base and sideboard are used unless given beside it"),
  sideboard: cardList("The sideboard, kept exactly as given and checked with the deck (at most 10 cards)").optional(),
  neighbours: z.number().int().min(5).max(100).default(20).describe("How many of the nearest decks to read in each tier"),
  swaps: z.number().int().min(1).max(15).default(5).describe("Most cards to bring in from the popular list of the chosen tier"),
  sleepers: z
    .number()
    .int()
    .min(0)
    .max(10)
    .default(2)
    .describe("Most sleeper cards to bring in (0 to leave sleepers out of the remixed list)"),
  minShare: z
    .number()
    .min(0.05)
    .max(1)
    .default(0.3)
    .describe("A card is popular when at least this share of the nearest decks, weighted by how close they are, runs it"),
  minSimilarity: z.number().min(0).max(1).default(0.1).describe("A deck sharing less of the list than this is not a neighbour"),
  tier: z
    .enum(["auto", "tournament", "community"])
    .default("auto")
    .describe(
      "Which tier's popular cards go into the remixed list: auto takes the tier whose decks are closest to the leader and base (tournament on a tie). Both tiers are always listed, apart",
    ),
  keep: z.array(z.string().min(1)).max(100).optional().describe("Cards of the deck never to cut (cardKeys, SET_NNN ids or exact titles)"),
  exclude: z.array(z.string().min(1)).max(100).optional().describe("Cards never to bring in (cardKeys, SET_NNN ids or exact titles)"),
  name: z.string().min(1).max(80).optional().describe("Deck name written to metadata.name"),
};
const deckRemixerInput = z.strictObject(deckRemixerShape);

const deckIndexes = new WeakMap<CardStore, DeckIndexFile | null>();
const expansions = new WeakMap<DeckIndexFile, Map<IndexTier, ReturnType<typeof expandTier>>>();

export function deckIndexOf(store: CardStore): DeckIndexFile | null {
  if (deckIndexes.has(store)) return deckIndexes.get(store) ?? null;
  const file = path.join(packageDirOf(store), "deck-index", "decks.json");
  const parsed = existsSync(file) ? deckIndexFileSchema.parse(readJson(file)) : null;
  deckIndexes.set(store, parsed);
  return parsed;
}

function tierOf(file: DeckIndexFile, tier: IndexTier): ReturnType<typeof expandTier> {
  const cache = expansions.get(file) ?? new Map<IndexTier, ReturnType<typeof expandTier>>();
  expansions.set(file, cache);
  if (!cache.has(tier)) cache.set(tier, expandTier(file, tier));
  return cache.get(tier) ?? null;
}

const pct = (x: number): number => Math.round(x * 100);
const per100 = (t: RecordTally): number | null => (t.wins + t.losses === 0 ? null : round((100 * t.wins) / (t.wins + t.losses), 1));
const points = (x: number): string => `${x >= 0 ? "+" : ""}${round(x * 100, 1)} points`;

interface Skips {
  notLegal: number;
  locked: number;
  penalised: number;
  negative: number;
  excluded: number;
}
const noSkips = (): Skips => ({ notLegal: 0, locked: 0, penalised: 0, negative: 0, excluded: 0 });

interface Held {
  syn: SynergyCard;
  row: CardRow;
  id: string;
  count: number;
  cost: number | null;
  share: number | null;
  decksWith: number;
  inclusion: number | null;
  evidenceClass: string | null;
  evidenceGap: number | null;
  play: number | null;
  engine: { link: string; rank: number; leaderEngine: boolean } | null;
  enabled: string | null;
  penalty: number;
  keep: number;
  kept: boolean;
}

interface Cut {
  cardKey: string;
  id: string;
  title: string;
  count: number;
  match: string;
  why: string;
}

const MATCH_LABEL = [
  "the same job and shape",
  "the same shape (type, arena, cost within one)",
  "the same type",
  "no like-for-like card; the weakest card left",
] as const;

export function deckRemixer(env: DeckEnv, input: unknown): ToolResult {
  const parsed = deckRemixerInput.safeParse(input);
  if (!parsed.success) return fail(`deck_remixer input: ${z.prettifyError(parsed.error)}`);
  const args = parsed.data;
  if (args.swudb !== undefined && args.decklist !== undefined) return fail("give either swudb or decklist as the deck, not both");
  const startEntries = args.decklist ?? args.swudb?.deck.map((e) => ({ card: e.id, count: e.count }));
  if (startEntries === undefined) return fail("give the deck as decklist (with leader and base) or as swudb");
  const sideboardEntries = args.sideboard ?? args.swudb?.sideboard?.map((e) => ({ card: e.id, count: e.count }));
  const leaderRef = args.leader ?? args.swudb?.leader.id;
  const baseRef = args.base ?? args.swudb?.base.id;
  if (leaderRef === undefined || baseRef === undefined) return fail("give leader and base, or a swudb document that names them");
  const pair = resolvePair(env, leaderRef, baseRef);
  if (typeof pair === "string") return fail(pair);
  const leaderKey = pair.leader.row.cardKey;
  const baseKey = pair.base.row.cardKey;
  const leaderId = swudbIdOf(pair.leader.row);
  const baseId = swudbIdOf(pair.base.row);
  if (leaderId === null || baseId === null) return fail("the leader or base has no SET_NNN printing in the card table");

  const deck = resolveList(env, startEntries, "main");
  if (deck.unresolved.length > 0)
    return fail(
      `the deck holds cards that did not resolve: ${deck.unresolved.map((u) => `"${u.card}" ${u.reason}, ${u.detail}`).join("; ")}`,
    );
  const refs = (list: readonly string[] | undefined, what: string): Set<string> | string => {
    const keys = new Set<string>();
    for (const ref of list ?? []) {
      const hit = resolveRef(env.store, ref, "main");
      if (!hit.ok) return `${what} "${ref}": ${hit.reason}, ${hit.detail}`;
      keys.add(hit.row.cardKey);
    }
    return keys;
  };
  const keepKeys = refs(args.keep, "keep");
  if (typeof keepKeys === "string") return fail(keepKeys);
  const excluded = refs(args.exclude, "exclude");
  if (typeof excluded === "string") return fail(excluded);

  const index = deckIndexOf(env.store);
  if (index === null)
    return fail(
      'no deck-index/decks.json in this data package; it predates the deck index step (run "pnpm meta:deck-index" or "pnpm build:data")',
    );

  const supplied = suppliedBy(pair);
  const heldCount = new Map(deck.lines.map((l) => [l.syn.cardKey, l.count]));
  const target: Target = { leader: leaderKey, base: baseKey, aspects: [...supplied].sort(compareCodePoints).join("+"), cards: heldCount };
  const locks = lockSupply(
    pair.leader.syn,
    pair.base.syn,
    deck.lines.map((l) => l.syn),
  );
  const { evidenceFields } = pairEvidence(env, pair);
  const leaderData = leaderDataFor(env, pair);
  const pairings = decoded(
    pairingsOutput,
    findPairings(
      env.ctx,
      { cardKey: leaderKey, leader: leaderKey, base: baseKey, perLink: 100, limit: 100, evidence: false },
      inPremierPool(env.store),
      undefined,
      { scores: env.scores },
    ),
    "find_pairings",
  );
  const engineOf = new Map<string, { link: string; rank: number; leaderEngine: boolean }>();
  for (const row of typeof pairings === "string" ? [] : pairings.pairings) {
    if (!engineOf.has(row.cardKey))
      engineOf.set(row.cardKey, { link: row.link, rank: round(row.rank ?? row.score, 3), leaderEngine: row.linkKind === "leader-engine" });
  }

  /** Why a card cannot be brought in; null when it can. Counts the refusal in the tier's tally. */
  const refusal = (cardKey: string): keyof Skips | null => {
    const row = env.store.byKey.get(cardKey);
    const syn = env.ctx.graph.byKey.get(cardKey);
    if (
      row === undefined ||
      syn === undefined ||
      !MAIN_TYPES.has(syn.type) ||
      cardScope(env.store, row) !== "legal" ||
      swudbIdOf(row) === null
    )
      return "notLegal";
    if (excluded.has(cardKey)) return "excluded";
    if (singlePenalty(syn, supplied) > 0) return "penalised";
    if (isLocked(clauseLock(syn, locks))) return "locked";
    if (evidenceFields(cardKey).evidenceClass === "negative") return "negative";
    return null;
  };

  interface TierRun {
    tier: IndexTier;
    meta: NonNullable<ReturnType<typeof expandTier>>["meta"] | null;
    decks: IndexDeck[];
    set: NeighbourSet | null;
    popular: PopularRow[];
    skips: Skips;
  }
  const runs: TierRun[] = INDEX_TIERS.map((tier) => {
    const expanded = tierOf(index, tier);
    const skips = noSkips();
    if (expanded === null) return { tier, meta: null, decks: [], set: null, popular: [], skips };
    const set = nearestDecks(expanded.decks, target, args.neighbours, args.minSimilarity);
    const popular = popularCards(
      set,
      heldCount,
      (cardKey) => {
        const why = refusal(cardKey);
        if (why !== null) skips[why] += 1;
        return why === null;
      },
      { minShare: args.minShare, minDecks: POPULAR_MIN_DECKS },
    );
    return { tier, meta: expanded.meta, decks: expanded.decks, set, popular, skips };
  });

  const usable = runs.filter((r) => r.set !== null && r.set.neighbours.length > 0);
  const reachRank = (r: TierRun): number => REACH_RANK[(r.set as NeighbourSet).reach as Level];
  const applied: TierRun | null =
    args.tier === "auto"
      ? ([...usable].sort((a, b) => reachRank(a) - reachRank(b) || INDEX_TIERS.indexOf(a.tier) - INDEX_TIERS.indexOf(b.tier))[0] ?? null)
      : (usable.find((r) => r.tier === args.tier) ?? null);
  const appliedWhy =
    applied === null
      ? args.tier === "auto"
        ? "no tier holds a deck with this leader, base or aspects, so no popular card is applied"
        : `the ${args.tier} tier has no neighbour deck for this leader, base or aspects, so no popular card is applied`
      : args.tier === "auto"
        ? `the ${applied.tier} tier's nearest decks come from ${applied.set?.reach === "leader+base" ? "the same leader and base" : applied.set?.reach === "leader" ? "the same leader" : "decks with the same aspects"}${usable.length > 1 ? ", the closest of the tiers with neighbours" : ""}`
        : `asked for the ${applied.tier} tier`;

  // Weakest-first ranking of the deck's own cards: how many nearest decks run each, the leader's lists, the measured gap, the rubric score.
  const appliedSet = applied?.set ?? null;
  const total = appliedSet === null ? 0 : appliedSet.neighbours.reduce((s, n) => s + n.similarity, 0);
  const held: Held[] = deck.lines
    .map((l): Held => {
      const key = l.syn.cardKey;
      const withCard = appliedSet?.neighbours.filter((n) => n.deck.cards.has(key)) ?? [];
      const share = total === 0 ? null : withCard.reduce((s, n) => s + n.similarity, 0) / total;
      const lead = leaderData?.byCard.get(key);
      const inclusion = lead?.inclusion ?? null;
      const ev = evidenceFields(key);
      const gap = ev.evidenceGap ?? null;
      const play = env.scores.get(key)?.playCalibrated ?? null;
      const penalty = singlePenalty(l.syn, supplied);
      const engine = engineOf.get(key) ?? null;
      const enabled = baseEnabledOf(l.syn, pair.base.syn);
      const keep =
        NEIGHBOUR_WEIGHT * (share ?? 0) +
        (inclusion !== null && inclusion >= LEADER_INCLUSION_FLOOR ? PLAYED_WEIGHT * inclusion : 0) +
        (gap !== null && (ev.evidenceClass === "ok" || ev.evidenceClass === "negative") ? MEASURED_WEIGHT * gap : 0) +
        (engine === null ? 0 : (engine.leaderEngine ? ENGINE_WEIGHT : LINK_WEIGHT) * Math.max(0, engine.rank - 0.5)) +
        (enabled === null ? 0 : BASE_ENABLED_BONUS) +
        SCORE_WEIGHT * Math.max(0, play ?? 0) -
        PENALTY_WEIGHT * penalty;
      return {
        syn: l.syn,
        row: l.row,
        id: swudbIdOf(l.row) ?? l.row.cardKey,
        count: l.count,
        cost: l.syn.structured.cost,
        share,
        decksWith: withCard.length,
        inclusion,
        evidenceClass: ev.evidenceClass ?? null,
        evidenceGap: gap,
        play,
        engine,
        enabled: enabled === null ? null : enabled.location,
        penalty,
        keep: round(keep, 4),
        kept: keepKeys.has(key) || engine?.leaderEngine === true,
      };
    })
    .sort((a, b) => compareCodePoints(a.syn.cardKey, b.syn.cardKey));

  const cutWhy = (h: Held): string => {
    const parts: string[] = [];
    if (h.share !== null && appliedSet !== null)
      parts.push(
        `${h.decksWith} of the ${appliedSet.neighbours.length} nearest ${applied?.tier} decks run it (${pct(h.share)}% weighted by closeness)`,
      );
    else parts.push("no neighbour deck to compare with");
    if (h.inclusion !== null && h.inclusion >= LEADER_INCLUSION_FLOOR) parts.push(`in ${pct(h.inclusion)}% of the leader's decklists`);
    if ((h.evidenceClass === "ok" || h.evidenceClass === "negative") && h.evidenceGap !== null)
      parts.push(`measured ${points(h.evidenceGap)} in comparable tournament decks`);
    if (h.engine !== null) parts.push(`${h.engine.leaderEngine ? "the leader's engine" : "linked to the leader"}: ${h.engine.link}`);
    if (h.enabled !== null) parts.push(`the base enables it: ${h.enabled}`);
    if (h.penalty > 0) parts.push(`pays an aspect penalty of ${h.penalty} per copy`);
    return parts.join("; ");
  };

  const remaining = new Map(held.map((h) => [h.syn.cardKey, h.count]));
  const slots = new Map<string, ReturnType<typeof slotMembers>>();
  const slotOf = (h: Held): ReturnType<typeof slotMembers> => {
    if (!slots.has(h.syn.cardKey)) slots.set(h.syn.cardKey, slotMembers(env, h.syn.cardKey));
    return slots.get(h.syn.cardKey) ?? null;
  };
  /** The deck cards a new card would replace, one copy at a time: the lowest keep score among the best-matching cards. */
  const cutsFor = (incoming: SynergyCard, copies: number): Cut[] | null => {
    const left = new Map(remaining);
    const cuts = new Map<string, Cut>();
    for (let n = 0; n < copies; n += 1) {
      const open = held.filter((h) => !h.kept && (left.get(h.syn.cardKey) ?? 0) > 0);
      const levelOf = (h: Held): number =>
        sameSlotShape(h.syn, incoming) ? (slotOf(h)?.fills.has(incoming.cardKey) === true ? 0 : 1) : h.syn.type === incoming.type ? 2 : 3;
      const costOf = (h: Held): number => h.keep + MISMATCH_WEIGHT * levelOf(h);
      const best = open.sort((a, b) => costOf(a) - costOf(b) || compareCodePoints(a.syn.cardKey, b.syn.cardKey))[0];
      if (best === undefined) return null;
      left.set(best.syn.cardKey, (left.get(best.syn.cardKey) ?? 0) - 1);
      const had = cuts.get(best.syn.cardKey);
      cuts.set(best.syn.cardKey, {
        cardKey: best.syn.cardKey,
        id: best.id,
        title: cardLabel(best.row),
        count: (had?.count ?? 0) + 1,
        match: MATCH_LABEL[levelOf(best)],
        why: cutWhy(best),
      });
    }
    for (const [k, v] of left) remaining.set(k, v);
    return [...cuts.values()];
  };

  interface Swap {
    source: "popular" | "sleeper" | "popular and sleeper";
    tier: IndexTier | null;
    cardKey: string;
    copies: number;
    syn: SynergyCard;
    row: CardRow;
    why: string;
    cuts: Cut[];
  }
  const swaps: Swap[] = [];
  const unplaced: string[] = [];
  const recordText = (r: PopularRow): string => {
    const withRate = per100(r.withRecord);
    if (withRate === null) return "";
    const withoutRate = per100(r.withoutRecord);
    return ` Those decks won ${withRate} of every 100 matches with it (${r.withRecord.decks} decks)${withoutRate === null ? "" : ` and ${withoutRate} without it (${r.withoutRecord.decks} decks)`}; other cards differ too, so this is a hint, not proof.`;
  };

  // Sleepers: the sleeper_cards rows legal for the deck, from the narrowest scope that has a usable one.
  const sleeperFile: SleepersFile | null = sleepersOf(env.store);
  const sleeperWidening: string[] = [];
  interface ScopeView {
    kind: string;
    label: string;
    rows: SleeperRow[];
    decks: number;
  }
  let sleeperScope = null as ScopeView | null;
  let sleeperRows: SleeperRow[] = [];
  let sleeperSkips = { ...noSkips(), alreadyInDeck: 0 };
  if (sleeperFile !== null) {
    const attempts: { what: string; args: { leader?: string; base?: string; aspects?: string[] } }[] = [
      { what: "this leader and base", args: { leader: leaderKey, base: baseKey } },
      { what: "these aspects", args: { aspects: supplied } },
      { what: "the whole field", args: {} },
    ];
    let firstScope = null as ScopeView | null;
    for (const attempt of attempts) {
      const scope = scopeOf(env.store, sleeperFile, attempt.args);
      if (typeof scope === "string") {
        sleeperWidening.push(`no sleeper measurement for ${attempt.what}: ${scope}`);
        continue;
      }
      firstScope ??= scope;
      const skips = { ...noSkips(), alreadyInDeck: 0 };
      const rows: SleeperRow[] = [];
      for (const r of flaggedRows(scope.rows.filter((x) => x.decksWith >= SLEEPER_MIN_DECKS && !x.rotated))) {
        if (heldCount.has(r.cardKey)) {
          skips.alreadyInDeck += 1;
          continue;
        }
        const why = refusal(r.cardKey);
        if (why !== null) skips[why] += 1;
        else rows.push(r);
      }
      sleeperSkips = skips;
      if (rows.length > 0) {
        sleeperScope = scope;
        sleeperRows = rows;
        break;
      }
      sleeperWidening.push(
        `no flagged sleeper among ${scope.label} is legal for this deck and missing from it (left out: ${
          Object.entries(skips)
            .filter(([, v]) => v > 0)
            .map(([k, v]) => `${k} ${v}`)
            .join(", ") || "none flagged"
        })`,
      );
    }
    sleeperScope ??= firstScope;
  }

  const popularApplied = applied === null ? [] : applied.popular.slice(0, args.swaps);
  const place = (cardKey: string, copies: number, source: Swap["source"], tier: IndexTier | null, why: string): void => {
    const syn = env.ctx.graph.byKey.get(cardKey) as SynergyCard;
    const row = env.store.byKey.get(cardKey) as CardRow;
    const cuts = cutsFor(syn, copies);
    if (cuts === null) {
      unplaced.push(`${cardLabel(row)}: every card that could be cut is kept`);
      return;
    }
    swaps.push({ source, tier, cardKey, copies, syn, row, why, cuts });
  };
  const sleeperKeys = new Set(sleeperRows.map((r) => r.cardKey));
  for (const r of popularApplied) {
    const also = sleeperKeys.has(r.cardKey);
    place(
      r.cardKey,
      r.copies,
      also ? "popular and sleeper" : "popular",
      applied?.tier ?? null,
      `${r.decksWith} of the ${r.of} ${applied?.tier} decks nearest yours run it (${pct(r.share)}% weighted by closeness), ${r.copies} cop${r.copies === 1 ? "y" : "ies"} on average.${recordText(r)}${also ? " It is also a sleeper card (see sleepers)." : ""}`,
    );
  }
  const appliedKeys = new Set(swaps.map((s) => s.cardKey));
  let sleeperTaken = 0;
  for (const r of sleeperRows) {
    if (sleeperTaken >= args.sleepers) break;
    if (appliedKeys.has(r.cardKey)) {
      sleeperTaken += 1;
      continue;
    }
    const neighbourCopies = applied?.popular.find((p) => p.cardKey === r.cardKey)?.copies;
    place(
      r.cardKey,
      neighbourCopies ?? SLEEPER_COPIES,
      "sleeper",
      "tournament",
      `Sleeper card: decks with it won ${round(r.gap.value * 100, 1)} more of every 100 matches than comparable decks without it (95% range ${round(r.gap.low * 100, 1)}..${round(r.gap.high * 100, 1)}); played in ${pct(r.playRate)}% of comparable decks. ${
        r.withinPlayer === null
          ? "Not measured inside the same players' own decks."
          : holdsForSamePlayers(r)
            ? "The gap holds inside the same players' own decks."
            : "The same players' own decks do not show it clearly."
      } A hint from tournament results, not proof.`,
    );
    sleeperTaken += 1;
  }

  // The remixed list.
  const counts = new Map(held.map((h) => [h.syn.cardKey, h.count]));
  for (const s of swaps) {
    counts.set(s.cardKey, (counts.get(s.cardKey) ?? 0) + s.copies);
    for (const c of s.cuts) counts.set(c.cardKey, (counts.get(c.cardKey) ?? 0) - c.count);
  }
  const lines = [...counts].filter(([, n]) => n > 0).map(([card, count]) => ({ card, count }));
  const costOf = (key: string): number => env.ctx.graph.byKey.get(key)?.structured.cost ?? 0;
  const idOf = (key: string): string => swudbIdOf(env.store.byKey.get(key) as CardRow) ?? key;
  const sideboard = sideboardEntries === undefined ? undefined : resolveList(env, sideboardEntries, "any");
  const sideIds = sideboard?.lines.map((l) => ({ id: swudbIdOf(l.row) ?? l.row.cardKey, count: l.count }));
  const swudb = {
    metadata: { name: args.name ?? `${cardLabel(pair.leader.row)} on ${cardLabel(pair.base.row)} (deck_remixer)` },
    leader: { id: leaderId, count: 1 },
    base: { id: baseId, count: 1 },
    deck: lines
      .map((l) => ({ id: idOf(l.card), count: l.count, cost: costOf(l.card) }))
      .sort((a, b) => a.cost - b.cost || compareCodePoints(a.id, b.id))
      .map(({ id, count }) => ({ id, count })),
    ...(sideIds === undefined ? {} : { sideboard: sideIds }),
  };
  const side = sideboardEntries === undefined ? {} : { sideboard: sideboardEntries };
  const legality = decoded(
    legalityOutput,
    deckLegalityCheck(env, { decklist: lines, leader: leaderKey, base: baseKey, format: "premier", ...side }),
    "deck_legality_check",
  );
  if (typeof legality === "string") return fail(legality);
  const headline = (list: readonly { card: string; count: number }[]) => {
    const audit = decoded(auditOutput, deckAudit(env, { decklist: list, leader: leaderKey, base: baseKey, ...side }), "deck_audit");
    return typeof audit === "string"
      ? audit
      : {
          aspectPenalty: audit.aspect.penalty,
          uncoveredIcons: audit.aspect.uncovered.length,
          meanPlayCalibrated: audit.score?.meanPlayCalibrated ?? null,
        };
  };

  const view = (key: string) => {
    const row = env.store.byKey.get(key) as CardRow;
    return { cardKey: key, id: swudbIdOf(row) ?? key, title: cardLabel(row), type: row.type, cost: row.cost };
  };
  const similarity = (set: NeighbourSet) => {
    const sims = set.neighbours.map((n) => n.similarity).sort((a, b) => b - a);
    return sims.length === 0
      ? null
      : { best: round(sims[0], 3), median: round(sims[Math.floor((sims.length - 1) / 2)], 3), lowest: round(sims[sims.length - 1], 3) };
  };
  const tierView = (r: TierRun) => {
    if (r.set === null || r.meta === null)
      return {
        tier: r.tier,
        note: `the package holds no ${r.tier} decks in its deck index`,
        decksInTier: 0,
        neighbours: { used: 0, requested: args.neighbours, reach: null, widening: [] },
        popular: [],
      };
    const set = r.set;
    const leaderDecks = r.decks.filter((d) => d.leader === leaderKey).length;
    const hasRecords = set.neighbours.some((n) => n.deck.record !== null);
    const recordView = (t: RecordTally) => ({ decks: t.decks, wins: t.wins, losses: t.losses, winsPer100: per100(t) });
    return {
      tier: r.tier,
      source: r.meta.source,
      population: `${r.meta.population}; ${r.meta.decks} decks${r.meta.events > 0 ? ` from ${r.meta.events} events` : ""}, ${r.meta.window.from}..${r.meta.window.to}${r.meta.windowDays === null ? "" : ` (the last ${r.meta.windowDays} days of the capture)`}; ${r.meta.capture}`,
      decksInTier: r.meta.decks,
      leaderDecksInTier: leaderDecks,
      ...(set.neighbours.length === 0
        ? { note: `no ${r.tier} deck to compare with (${r.meta.window.from}..${r.meta.window.to}): ${set.widening[0]}` }
        : leaderDecks === 0
          ? {
              note: `no ${r.tier} deck runs this leader in this window, so the neighbours are decks of other leaders with the same aspects; they share only ${pct(similarity(set)?.best ?? 0)}% of your cards at best`,
            }
          : {}),
      neighbours: {
        requested: set.requested,
        used: set.neighbours.length,
        ...(set.identical === 0 ? {} : { identicalDecksSkipped: set.identical }),
        reach: set.reach,
        widening: set.widening,
        similarity: similarity(set),
        decks: set.neighbours.slice(0, NEIGHBOUR_ROWS).map((n) => ({
          similarity: round(n.similarity, 3),
          from: n.level,
          date: n.deck.date,
          ...(n.deck.event === null ? {} : { event: n.deck.event }),
          ...(n.deck.placement === null ? {} : { placement: n.deck.placement }),
          ...(n.deck.record === null ? {} : { record: `${n.deck.record.wins}-${n.deck.record.losses}-${n.deck.record.draws}` }),
        })),
      },
      skipped: r.skips,
      popular: r.popular.slice(0, POPULAR_ROWS).map((p) => ({
        ...view(p.cardKey),
        decksWith: p.decksWith,
        of: p.of,
        share: round(p.share, 3),
        copies: p.copies,
        ...(hasRecords ? { record: { with: recordView(p.withRecord), without: recordView(p.withoutRecord) } } : {}),
      })),
    };
  };

  const sleeperView = (r: SleeperRow) => ({
    ...view(r.cardKey),
    verdict: r.verdict,
    playRate: r.playRate,
    winAdvantagePts: round(r.gap.value * 100, 1),
    rangePts: `${round(r.gap.low * 100, 1)}..${round(r.gap.high * 100, 1)}`,
    decksWith: r.decksWith,
    decksWithout: r.decksWithout,
    skilledEdge: r.skilledEdge,
    samePlayer:
      r.withinPlayer === null ? "not measured" : holdsForSamePlayers(r) ? "held for the same players" : "not shown by the same players",
    ...(r.withinPlayer === null
      ? {}
      : {
          samePlayerPts: round(r.withinPlayer.value * 100, 1),
          samePlayerRangePts: `${round(r.withinPlayer.low * 100, 1)}..${round(r.withinPlayer.high * 100, 1)}`,
        }),
    ...(r.selectionWarning
      ? { warning: "the same players' own decks show no clear difference: the gap may come from who plays the card" }
      : {}),
    status: "candidate",
  });

  const inCopies = swaps.reduce((s, w) => s + w.copies, 0);
  return ok({
    status: "candidate",
    dataVersion: env.dataVersion,
    leader: { cardKey: leaderKey, id: leaderId, title: cardLabel(pair.leader.row) },
    base: { cardKey: baseKey, id: baseId, title: cardLabel(pair.base.row) },
    deck: { cards: deck.copies, aspects: target.aspects },
    applied: { tier: applied?.tier ?? null, reason: appliedWhy },
    tiers: runs.map(tierView),
    sleepers:
      sleeperFile === null
        ? { note: 'no sleepers/sleepers.json in this data package (run "pnpm meta:sleepers" or "pnpm build:data")', cards: [] }
        : {
            scope: sleeperScope === null ? null : { kind: sleeperScope.kind, label: sleeperScope.label, decks: sleeperScope.decks },
            widening: sleeperWidening,
            source: sleeperFile.source,
            population: sleeperFile.population,
            precedence: sleeperFile.precedence,
            window: `${sleeperFile.window.from}..${sleeperFile.window.to}`,
            skipped: sleeperSkips,
            cards: sleeperRows.slice(0, SLEEPER_ROWS).map(sleeperView),
          },
    swaps: swaps.map((s, i) => ({
      rank: i + 1,
      source: s.source,
      tier: s.tier,
      in: { ...view(s.cardKey), count: s.copies },
      out: s.cuts,
      why: s.why,
    })),
    ...(unplaced.length === 0 ? {} : { unplaced }),
    ...(typeof pairings === "string" ? { warnings: [pairings] } : {}),
    swudb,
    ...(sideboard === undefined || sideboard.unresolved.length === 0 ? {} : { sideboardUnresolved: sideboard.unresolved }),
    legality,
    audit: { before: headline(deck.lines.map((l) => ({ card: l.syn.cardKey, count: l.count }))), after: headline(lines) },
    changed: {
      copiesIn: inCopies,
      copiesOut: swaps.reduce((s, w) => s + w.cuts.reduce((a, c) => a + c.count, 0), 0),
      mainDeck: lines.reduce((s, l) => s + l.count, 0),
    },
    note: `Each tier keeps its own line (D21): tournament decks (with their whole-event match record) and community lists are never pooled, and bot simulations are not used. Neighbours are the decks sharing most of your cards (the sum of the smaller copy counts over the sum of the larger, per card), taken from the same leader and base first, then the same leader, then the same aspects; every widening is listed. A card is popular when at least ${pct(args.minShare)}% of the nearest decks, weighted by closeness, run it and your deck does not; records are wins per 100 matches over whole events against unknown opponents and the other cards differ, so they are hints. Cards that are not legal now, pay an aspect penalty, are locked by their clause, are measured negative or are excluded are left out and counted under skipped. A card the leader's own clause reads (a leader-engine partner in find_pairings), and any card named in keep, is never cut. Each cut is the deck card with the lowest keep score (${NEIGHBOUR_WEIGHT} x share of nearest decks that run it + ${PLAYED_WEIGHT} x share of the leader's decklists at or above ${pct(LEADER_INCLUSION_FLOOR)}% + ${MEASURED_WEIGHT} x measured gap + ${ENGINE_WEIGHT} x (find_pairings rank - 0.5) on a leader-engine partner (${LINK_WEIGHT} x on another leader link) + ${BASE_ENABLED_BONUS} when the base enables the card + ${SCORE_WEIGHT} x play-calibrated score - ${PENALTY_WEIGHT} x aspect penalty), plus ${MISMATCH_WEIGHT} per step away from a like-for-like card (the same job and shape, the same shape, the same type, any card), so the weakest card that fits the slot goes first. Status candidate: confirm each swap against the card text.`,
  });
}

function withEnv(store: CardStore, input: unknown): ToolResult {
  try {
    return deckRemixer(deckEnvOf(store), input);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export const DECK_REMIXER_TOOLS = {
  deck_remixer: {
    title: "Remix a deck",
    description:
      "Finds cards to try in a given 50-card Premier deck by reading the real decks nearest it, and the deck cards they would replace. Give the deck (swudb, or decklist with leader and base). In each tier on its own (tournament decklists with their match record, then community lists; never pooled) it finds the nearest decks by shared card copies, from the same leader and base first, then the same leader, then the same aspects, and states every widening; it lists the cards those decks run that yours does not (popular with similar decks: how many of them, how many copies, and in the tournament tier the neighbours' wins per 100 matches with and without the card). It adds the sleeper_cards rows that are legal for the deck's aspects (with their same-player check and warnings). For each card to try it names the deck cards it would replace: the rarest among the nearest decks and weakest on the leader's lists, measured gaps and score, matched by job, shape and cost. Returns the swaps with a plain why, the remixed list as a SWUDB document (still 50 cards, at most 3 copies), the deck_legality_check result and the aspect-penalty headline before and after. Leaders with no tournament list (a new set) say so and fall back to community lists or aspects. Deterministic, no model; status candidate.",
    shape: deckRemixerShape,
    handler: withEnv,
  },
} as const;
