import { z } from "zod";
import { packageDirOf, type CardStore } from "../data.js";
import type { LeaderCardsEntry, LeaderCardRow } from "../meta/schema.js";
import { CANDIDATE_STATUS, clip, evidenceOf, tagEvidence } from "../synergy/evidence.js";
import { comboLabel, coverPenalty, rankCovers, type CoverCombo } from "../synergy/cover.js";
import { loadSynergyContext, type SynergyContext } from "../synergy/context.js";
import {
  aspectGroup,
  commonMembers,
  roleOf,
  substitutesFor,
  widenedSubstitutes,
  type Substitute,
  type SubstituteGroup,
  type SubstituteOptions,
} from "../synergy/fungibility.js";
import { edgeOrder, edgeScore, mechanicalRows, primaryRows, TRAIT_BONUS } from "../synergy/graph.js";
import { cardLabel, cmp, r3 } from "../synergy/order.js";
import { TRAITS_MODES, TRIO_SHAPES, type PairEdge, type SynergyCard, type TraitsMode, type TrioRecord } from "../synergy/schema.js";
import { slotRoles, trioLinks } from "../synergy/slots.js";
import { DEFAULT_TRIO_KEEP, TRIO_MEMBER_TYPES, trioOrder } from "../synergy/trios.js";
import type { ToolResult } from "../tools.js";
import { ok, fail } from "./common.js";
import { leaderSourceText } from "./deck.js";
import { valueData } from "./value.js";

/**
 * @displayName SWU synergy MCP tools
 * @strategicPurpose Serves the pairing, trio, fungibility and aspect-cover analysis to assistants
 * (LampaGJ/swu-mcp#3). Every answer comes from the same pure functions as `pnpm synergy`, so a tool
 * result and a run output cannot disagree, and no model sits in the path.
 * @tacticalObjective Handlers take a SynergyContext so tests can run them on in-code fixtures; the
 * registered tools build the context lazily from `<packageDir>/features/features.json`.
 */

const evidenceFlag = z
  .boolean()
  .default(true)
  .describe("Include the clause text (clipped to 160 characters) of each card that produced the offer and the want; false drops it");

const aspectList = z.array(z.string().min(1)).max(3);

const traitsMode = z
  .enum(TRAITS_MODES)
  .default("bonus")
  .describe(
    `How a shared trait counts. bonus (default): mechanical links rank, a trait shared on a mechanical pair multiplies its link by ${1 + TRAIT_BONUS}, trait-only pairs are listed apart as tribal. exclude: traits ignored. include: a trait counts as a link of its own and trait-only pairs rank with the rest`,
  );

const cardKey = z.string().min(1);

const includeLeaders = z
  .boolean()
  .default(false)
  .describe("List Leader and Base cards as partners too. They never sit in a deck's 50 cards, so the default leaves them out");

const leaderArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The deck's leader, by cardKey or exact title (\"Cad Bane, Still Faster than You\", or \"Cad Bane\" when only one leader has it). Cards the leader's tournament decklists play rank higher: rank x (0.5 + leaderInclusion), unplayed cards x 0.5, so non-obvious ideas stay listed. Aspects default to the leader's icons",
  );

/** Types that can sit in a deck's 50 cards; a Leader or Base partner is only listed on request. */
const DECK_CARD_TYPES: ReadonlySet<string> = TRIO_MEMBER_TYPES;
const partnerFilterNote = (included: boolean): string =>
  included
    ? "includeLeaders: Leader and Base partners are included; they cannot be one of a deck's 50 cards"
    : "Leader and Base cards are left out as partners because they cannot be one of a deck's 50 cards; includeLeaders: true lists them";

export const fungibleSubstitutesShape = {
  cardKey: cardKey.describe("The card whose slot to fill, for example 0101033"),
  tag: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict to one role, for example offers:draw or wants:self-defeated; omit for every role of the card"),
  preferAspects: aspectList.optional().describe("Aspects the deck's leader and base supply; substitutes they cover sort first"),
  crossAspectOnly: z.boolean().default(false).describe("Only list substitutes whose aspects differ from the card's"),
  maxCost: z.number().int().min(0).optional().describe("Highest substitute cost, inclusive"),
  limit: z.number().int().min(1).max(50).default(5).describe("Substitutes listed per aspect group"),
  leader: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The deck's leader, by cardKey or exact title. Each substitute carries leaderInclusion (null when the leader's tournament decklists do not play it) and, inside an aspect group, substitutes the leader's decks play sort first. Without it they sort by play-calibrated score",
    ),
  evidence: evidenceFlag,
};

export const findPairingsShape = {
  cardKey,
  direction: z
    .enum(["enablers", "payoffs", "both"])
    .default("both")
    .describe("enablers: partners that feed this card; payoffs: partners this card feeds"),
  maxCost: z.number().int().min(0).optional().describe("Highest partner cost, inclusive"),
  aspects: aspectList
    .optional()
    .describe("Aspect icons the leader and base supply; the penalty is measured against them and ranking favours covered partners"),
  source: z.enum(["rule"]).default("rule").describe("Where the pair comes from; only the reviewed complementarity table exists today"),
  traits: traitsMode,
  tribalLimit: z.number().int().min(0).max(50).default(5).describe("Most trait-only (tribal) pairs listed in the separate tribal section when traits is bonus"),
  withAlternatives: z.boolean().default(true).describe("List fungible alternatives for the partner slot, by aspect"),
  includeLeaders,
  leader: leaderArg,
  perLink: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(3)
    .describe("Most rows listed per distinct link before further rows with the same link are deferred; 100 turns the cap off"),
  evidence: evidenceFlag,
  limit: z.number().int().min(1).max(100).default(15),
};

export const findTriosShape = {
  cardKey: cardKey.optional().describe("Only trios that contain this card"),
  shape: z.enum(TRIO_SHAPES).optional(),
  maxTotalCost: z.number().int().min(0).default(9),
  leaderAspects: z
    .array(z.string().min(1))
    .max(2)
    .optional()
    .describe("Fix the leader's aspect icons instead of choosing the cheapest cover"),
  baseAspects: z.array(z.string().min(1)).max(1).optional().describe("Fix the base's aspect icon; give [] for a neutral base"),
  traits: traitsMode,
  withAlternatives: z.boolean().default(true).describe("List fungible alternatives for each slot, by aspect"),
  includeLeaders,
  leader: leaderArg,
  evidence: evidenceFlag,
  limit: z.number().int().min(1).max(50).default(10),
};

export const explainSynergyShape = {
  cardKeys: z.array(cardKey).min(2).max(3),
  evidence: evidenceFlag,
};

export const aspectCoverShape = {
  cardKeys: z.array(cardKey).min(1).max(60),
  leaderAspects: z.array(z.string().min(1)).max(2).optional().describe("Test one leader aspect set instead of listing combinations"),
  baseAspects: z.array(z.string().min(1)).max(1).optional(),
  limit: z.number().int().min(1).max(100).default(10),
};

function resolve(ctx: SynergyContext, keys: readonly string[]): SynergyCard[] | string {
  const cards: SynergyCard[] = [];
  for (const k of keys) {
    const c = ctx.graph.byKey.get(k);
    if (c === undefined) return `no card with cardKey ${k} in the feature file`;
    cards.push(c);
  }
  return cards;
}

interface LeaderWeight {
  card: SynergyCard;
  data: { entry: LeaderCardsEntry; byCard: ReadonlyMap<string, LeaderCardRow> } | null;
}

function resolveLeader(ctx: SynergyContext, ref: string): LeaderWeight | string {
  const leaders = ctx.cards.filter((c) => c.type === "Leader");
  const byKey = leaders.find((c) => c.cardKey === ref);
  const hits = byKey !== undefined ? [byKey] : leaders.filter((c) => cardLabel(c) === ref || c.title === ref);
  if (hits.length === 0) return `no Leader card with cardKey or exact title ${ref}`;
  if (hits.length > 1) return `${ref} names ${hits.length} leaders; give one cardKey: ${hits.map((c) => `${c.cardKey} (${cardLabel(c)})`).join(", ")}`;
  return { card: hits[0], data: ctx.leaderCards?.get(hits[0].cardKey) ?? null };
}

/** Share of the leader's decklists that play the card; null when the card is unplayed in them. */
const inclusionOf = (w: LeaderWeight, cardKey: string): number | null => w.data?.byCard.get(cardKey)?.inclusion ?? null;
const leaderFactor = (w: LeaderWeight, cardKey: string): number => {
  const inc = inclusionOf(w, cardKey);
  return inc !== null && inc > 0 ? 0.5 + inc : 0.5;
};

function leaderBlock(w: LeaderWeight, unit: "partner" | "trio" | "substitute"): Record<string, unknown> {
  const head = { cardKey: w.card.cardKey, title: cardLabel(w.card), aspects: w.card.structured.aspectIcons.join("+") || "none" };
  if (w.data === null) return { ...head, note: "no decklist data for this leader in the package; ranking is not leader-weighted, aspects still default to its icons" };
  const { entry } = w.data;
  const how =
    unit === "substitute"
      ? "inside an aspect group, substitutes sort by leaderInclusion (unplayed last), then play-calibrated score"
      : unit === "partner"
      ? "rank = the unweighted rank x (0.5 + leaderInclusion) when the leader's decks play the partner, x 0.5 when they do not"
      : "rank = score x, for each member, (0.5 + leaderInclusion) when the leader's decks play it, 0.5 when they do not";
  return {
    ...head,
    population: entry.population,
    decks: entry.decks,
    window: `${entry.window.from}..${entry.window.to}`,
    note: `leaderInclusion = placement-weighted share of this leader's decklists that play the card (${leaderSourceText(entry)}); null = unplayed in them. ${how}.`,
  };
}

const brief = (c: SynergyCard) => ({
  cardKey: c.cardKey,
  title: cardLabel(c),
  type: c.type,
  cost: c.structured.cost,
  aspects: aspectGroup(c),
});

function fixedCombo(leader: readonly string[] | undefined, base: readonly string[] | undefined): CoverCombo[] {
  return [{ leader: [...(leader ?? [])], base: [...(base ?? [])], label: comboLabel(leader ?? [], base ?? []) }];
}

function groupText(groups: readonly SubstituteGroup[], maxGroups: number): string[] {
  return groups
    .slice(0, maxGroups)
    .map(
      (g) =>
        `${g.aspects}${g.covered === true ? " (covered)" : ""}: ${g.cards.map((c) => `${cardLabel(c)} (${c.cost ?? "-"})`).join("; ")}`,
    );
}

/** The text behind a role: the tag's clause, or the printed keyword for a keyword role (it has no clause). */
const roleText = (card: SynergyCard, tag: string): string =>
  tag.startsWith("keyword:") ? `printed keyword ${tag.slice("keyword:".length)}` : tagEvidence(card, tag);

/** Higher first, a missing value last. */
const descNullLast = (a: number | null | undefined, b: number | null | undefined): number =>
  a == null ? (b == null ? 0 : 1) : b == null ? -1 : b - a;

/**
 * Order inside an aspect group: leaderInclusion desc when a leader is given, then play-calibrated
 * score desc, then cost and cardKey so ties stay deterministic (D44).
 */
function substituteOrder(
  weight: LeaderWeight | undefined,
  scores: ReadonlyMap<string, { playCalibrated: number | null }>,
): (a: Substitute, b: Substitute) => number {
  const inclusion = (k: string): number | null => (weight === undefined ? null : inclusionOf(weight, k));
  return (a, b) =>
    descNullLast(inclusion(a.cardKey), inclusion(b.cardKey)) ||
    descNullLast(scores.get(a.cardKey)?.playCalibrated, scores.get(b.cardKey)?.playCalibrated) ||
    (a.cost ?? 99) - (b.cost ?? 99) ||
    cmp(a.cardKey, b.cardKey);
}

export function fungibleSubstitutes(
  ctx: SynergyContext,
  input: unknown,
  scores: ReadonlyMap<string, { playCalibrated: number | null }> = new Map(),
): ToolResult {
  const args = z.object(fungibleSubstitutesShape).parse(input);
  const resolved = resolve(ctx, [args.cardKey]);
  if (typeof resolved === "string") return fail(resolved);
  const slot = resolved[0];
  const leader = args.leader === undefined ? undefined : resolveLeader(ctx, args.leader);
  if (typeof leader === "string") return fail(leader);
  const tags =
    args.tag !== undefined
      ? [args.tag]
      : [
          ...new Set(
            (ctx.fungibility.rolesByCard.get(slot.cardKey) ?? []).map((id) => (ctx.fungibility.classById.get(id) as { tag: string }).tag),
          ),
        ];
  if (tags.length === 0)
    return ok({ status: CANDIDATE_STATUS, card: brief(slot), roles: [], note: "the card carries no offers/wants role (trait tags are not roles)" });
  const options: SubstituteOptions = {
    preferAspects: args.preferAspects,
    crossAspectOnly: args.crossAspectOnly,
    maxCost: args.maxCost,
    perGroup: args.limit,
    order: substituteOrder(leader, scores),
  };
  const roles = tags.flatMap((tag) => {
    const cls = roleOf(ctx.fungibility, slot.cardKey, tag);
    if (cls === undefined) return [];
    const exact = substitutesFor(ctx.fungibility, cls.members, slot.cardKey, options);
    const widenedResult = cls.members.length === 1 ? widenedSubstitutes(ctx.fungibility, cls, slot.cardKey, options) : null;
    const groups = widenedResult?.groups ?? exact;
    const withText = (c: SubstituteGroup["cards"][number]) => {
      const widenedMark = widenedResult === null ? c : { ...c, match: "widened" };
      const marked = leader === undefined ? widenedMark : { ...widenedMark, leaderInclusion: inclusionOf(leader, c.cardKey) };
      return args.evidence ? { ...marked, text: roleText(ctx.graph.byKey.get(c.cardKey) as SynergyCard, tag) } : marked;
    };
    return [
      {
        classId: cls.id,
        tag,
        classSize: cls.members.length,
        widened: widenedResult?.widened ?? null,
        aspectSets: new Set(cls.members.map((k) => aspectGroup(ctx.graph.byKey.get(k) as SynergyCard))).size,
        ...(args.evidence ? { slotText: roleText(slot, tag) } : {}),
        substitutes: groups.map((g) => ({
          aspects: g.aspects,
          differsFromSlot: g.differsFromSlot,
          covered: g.covered,
          cards: g.cards.map(withText),
        })),
      },
    ];
  });
  if (roles.length === 0) return fail(`${slot.cardKey} has no role for tag ${args.tag}`);
  return ok({ status: CANDIDATE_STATUS, card: brief(slot), ...(leader === undefined ? {} : { leader: leaderBlock(leader, "substitute") }), roles });
}

function deckMembers(ctx: SynergyContext, members: readonly string[], includeLeaders: boolean): readonly string[] {
  return includeLeaders ? members : members.filter((k) => DECK_CARD_TYPES.has((ctx.graph.byKey.get(k) as SynergyCard).type));
}

function penaltyFor(
  ctx: SynergyContext,
  members: SynergyCard[],
  aspects: readonly string[] | undefined,
): { aspectPair: string; penalty: number } {
  if (aspects !== undefined) {
    const r = coverPenalty(members, aspects, []);
    return { aspectPair: `icons ${aspects.join("+") || "none"}`, penalty: r.penalty };
  }
  const best = rankCovers(members, ctx.combos)[0];
  return { aspectPair: best.label, penalty: best.penalty };
}

/** Stable partition: the first `perLink` rows of each link keep their place, later rows of that link follow them, both runs in input order. */
/** How many times the default per-shape trio pool the leader-weighted ranking reads. */
const LEADER_TRIO_POOL = 5;

export function deferRepeatedLinks<T>(
  rows: readonly T[],
  linkOf: (row: T) => string,
  perLink: number,
): { ordered: T[]; deferred: number } {
  const seen = new Map<string, number>();
  const kept: T[] = [];
  const later: T[] = [];
  for (const r of rows) {
    const link = linkOf(r);
    const n = seen.get(link) ?? 0;
    seen.set(link, n + 1);
    (n < perLink ? kept : later).push(r);
  }
  return { ordered: [...kept, ...later], deferred: later.length };
}

export function findPairings(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(findPairingsShape).parse(input);
  const resolved = resolve(ctx, [args.cardKey]);
  if (typeof resolved === "string") return fail(resolved);
  const card = resolved[0];
  const leader = args.leader === undefined ? undefined : resolveLeader(ctx, args.leader);
  if (typeof leader === "string") return fail(leader);
  const aspects = args.aspects ?? leader?.card.structured.aspectIcons;
  const weight = leader?.data != null ? leader : undefined;
  const touching = ctx.graph.edges.filter((e) => {
    const partner = e.a === card.cardKey ? e.b : e.b === card.cardKey ? e.a : undefined;
    if (partner === undefined) return false;
    if (e.a === card.cardKey && args.direction === "enablers") return false;
    if (e.b === card.cardKey && args.direction === "payoffs") return false;
    const partnerCard = ctx.graph.byKey.get(partner) as SynergyCard;
    if (!args.includeLeaders && !DECK_CARD_TYPES.has(partnerCard.type)) return false;
    const cost = partnerCard.structured.cost;
    return args.maxCost === undefined || (cost !== null && cost <= args.maxCost);
  });
  const ranked = (edges: readonly PairEdge[], mode: TraitsMode) => {
    const rows = edges.map((e: PairEdge) => {
      const partner = ctx.graph.byKey.get(e.a === card.cardKey ? e.b : e.a) as SynergyCard;
      const cover = penaltyFor(ctx, [card, partner], aspects);
      const score = edgeScore(e, mode);
      const unweighted = aspects === undefined ? score : Math.round((score / (1 + cover.penalty / 2)) * 1000) / 1000;
      const rank = weight === undefined ? unweighted : r3(unweighted * leaderFactor(weight, partner.cardKey));
      return { e, partner, cover, score, rank };
    });
    return rows.sort((x, y) => y.rank - x.rank || edgeOrder(x.e, y.e));
  };
  const linkRowsOf = (e: PairEdge, mode: TraitsMode) => (mode === "exclude" ? mechanicalRows(e) : e.rows);
  const row = ({ e, partner, cover, score, rank }: ReturnType<typeof ranked>[number], mode: TraitsMode): Record<string, unknown> => {
    const linkRows = linkRowsOf(e, mode);
    const out: Record<string, unknown> = {
      ...brief(partner),
      status: CANDIDATE_STATUS,
      partnerIs: e.a === card.cardKey ? "payoff" : "enabler",
      linkKind: e.linkKind,
      link: linkRows.map((r) => `${r.offer} -> ${r.want}`).join("; "),
      reason: primaryRows(e)[0].reason,
      score,
      aspectPair: cover.aspectPair,
      penalty: cover.penalty,
      rank,
      ...(weight === undefined ? {} : { leaderInclusion: inclusionOf(weight, partner.cardKey) }),
    };
    if (args.evidence) out.evidence = evidenceOf(e, ctx.graph.byKey, linkRows);
    return out;
  };
  const rows = ranked(
    touching.filter((e) => args.traits === "include" || !e.traitOnly),
    args.traits,
  );
  const { ordered, deferred } = deferRepeatedLinks(
    rows,
    (r) => linkRowsOf(r.e, args.traits).map((x) => `${x.offer} -> ${x.want}`).join("; "),
    args.perLink,
  );
  const tribal = args.traits === "bonus" ? ranked(touching.filter((e) => e.traitOnly), "bonus") : [];
  const shown = ordered.slice(0, args.limit).map((r) => {
    const { e, partner } = r;
    const out = row(r, args.traits);
    if (args.withAlternatives) {
      const tags = slotRoles([partner.cardKey], [e])[0];
      const common = commonMembers(ctx.fungibility, partner.cardKey, [...tags.offers, ...tags.wants]);
      out.alternatives = groupText(
        substitutesFor(ctx.fungibility, deckMembers(ctx, common.members, args.includeLeaders), partner.cardKey, {
          preferAspects: aspects,
          perGroup: 2,
          maxCost: args.maxCost,
        }),
        4,
      );
    }
    return out;
  });
  return ok({
    card: brief(card),
    ...(leader === undefined ? {} : { leader: leaderBlock(leader, "partner") }),
    source: args.source,
    traits: args.traits,
    partnerFilter: partnerFilterNote(args.includeLeaders),
    total: rows.length,
    shown: shown.length,
    capped: deferred,
    ...(deferred > 0
      ? {
          note: `perLink ${args.perLink}: at most ${args.perLink} rows per distinct link are ranked first; ${deferred} further rows that repeat an already-listed link follow in rank order; set perLink 100 to turn the cap off.`,
        }
      : {}),
    pairings: shown,
    ...(tribal.length > 0
      ? {
          tribal: {
            note: "pairs linked only by a shared trait (obvious tribal links), ranked apart and capped by tribalLimit",
            total: tribal.length,
            pairings: tribal.slice(0, args.tribalLimit).map((r) => row(r, "bonus")),
          },
        }
      : {}),
  });
}

export function findTrios(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(findTriosShape).parse(input);
  if (args.cardKey !== undefined) {
    const resolved = resolve(ctx, [args.cardKey]);
    if (typeof resolved === "string") return fail(resolved);
  }
  const leader = args.leader === undefined ? undefined : resolveLeader(ctx, args.leader);
  if (typeof leader === "string") return fail(leader);
  const weight = leader?.data != null ? leader : undefined;
  const leaderAspects = args.leaderAspects ?? leader?.card.structured.aspectIcons;
  const fixed = leaderAspects !== undefined || args.baseAspects !== undefined;
  const search = ctx.trios({
    combos: fixed ? fixedCombo(leaderAspects, args.baseAspects) : undefined,
    // The leader weight can lift a trio from below the unweighted cut, so the weighted ranking draws from a deeper pool.
    ...(weight === undefined ? {} : { keep: DEFAULT_TRIO_KEEP * LEADER_TRIO_POOL }),
    traits: args.traits,
    ...(args.includeLeaders ? { memberTypes: new Set([...DECK_CARD_TYPES, "Leader", "Base"]) } : {}),
    accept: (keys, cost) => cost <= args.maxTotalCost && (args.cardKey === undefined || keys.includes(args.cardKey)),
  });
  const shapes = args.shape === undefined ? TRIO_SHAPES : [args.shape];
  const rankOf = (t: TrioRecord): number => (weight === undefined ? t.score : r3(t.score * [t.cardA, t.cardB, t.cardC].reduce((f, k) => f * leaderFactor(weight, k), 1)));
  const merged: TrioRecord[] = shapes
    .flatMap((s) => search.trios[s])
    .sort(weight === undefined ? trioOrder : (x, y) => rankOf(y) - rankOf(x) || trioOrder(x, y))
    .slice(0, args.limit);
  const prefer = fixed ? [...(leaderAspects ?? []), ...(args.baseAspects ?? [])] : undefined;
  const trios = merged.map((t) => {
    const keys = [t.cardA, t.cardB, t.cardC];
    const out: Record<string, unknown> = {
      cards: keys.map((k) => cardLabel(ctx.graph.byKey.get(k) as SynergyCard)).join(" + "),
      cardKeys: keys.join("|"),
      status: CANDIDATE_STATUS,
      shape: t.shape,
      totalCost: t.totalCost,
      aspectPair: t.aspectPair,
      penalty: t.penalty,
      reasons: t.reasons,
      score: t.score,
      ...(weight === undefined ? {} : { rank: rankOf(t), leaderInclusion: keys.map((k) => inclusionOf(weight, k)) }),
    };
    if (args.evidence) {
      out.evidence = trioLinks(ctx.graph, t).flatMap((e) =>
        evidenceOf(e, ctx.graph.byKey, primaryRows(e).slice(0, 1)).map((ev) => ({
          link: `${cardLabel(ctx.graph.byKey.get(e.a) as SynergyCard)} > ${cardLabel(ctx.graph.byKey.get(e.b) as SynergyCard)}`,
          ...ev,
        })),
      );
    }
    if (args.withAlternatives) {
      const roles = slotRoles(keys, trioLinks(ctx.graph, t));
      out.alternatives = roles.map((r, i) => {
        const common = commonMembers(ctx.fungibility, r.cardKey, [...r.offers, ...r.wants]);
        return {
          slot: "ABC"[i],
          roles: [...r.offers, ...r.wants].join(", "),
          substitutes: groupText(substitutesFor(ctx.fungibility, deckMembers(ctx, common.members, args.includeLeaders), r.cardKey, { preferAspects: prefer, perGroup: 2 }), 4),
        };
      });
    }
    return out;
  });
  return ok({
    counts: { chain: search.counts.chain, convergent: search.counts.convergent, loop: search.counts.loop },
    maxTotalCost: args.maxTotalCost,
    ...(leader === undefined ? {} : { leader: leaderBlock(leader, "trio") }),
    traits: args.traits,
    partnerFilter: partnerFilterNote(args.includeLeaders),
    shown: trios.length,
    trios,
  });
}

export function explainSynergy(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(explainSynergyShape).parse(input);
  if (new Set(args.cardKeys).size !== args.cardKeys.length) return fail("give distinct cardKeys");
  const resolved = resolve(ctx, args.cardKeys);
  if (typeof resolved === "string") return fail(resolved);
  const links: PairEdge[] = [];
  const noLink: string[] = [];
  for (let i = 0; i < resolved.length; i++) {
    for (let j = i + 1; j < resolved.length; j++) {
      const forward = ctx.graph.edgeByKey.get(`${resolved[i].cardKey}>${resolved[j].cardKey}`);
      const backward = ctx.graph.edgeByKey.get(`${resolved[j].cardKey}>${resolved[i].cardKey}`);
      for (const e of [forward, backward]) if (e !== undefined) links.push(e);
      if (forward === undefined && backward === undefined) noLink.push(`${cardLabel(resolved[i])} / ${cardLabel(resolved[j])}`);
    }
  }
  const evidence = resolved.flatMap((c) => {
    const wanted = new Set(
      links.flatMap((e) => e.rows.flatMap((r) => (e.a === c.cardKey ? [r.offer] : e.b === c.cardKey ? [r.want] : []))),
    );
    return [...c.tags.offers, ...c.tags.wants]
      .filter((t) => wanted.has(t.tag))
      .map((t) => ({ card: cardLabel(c), tag: t.tag, why: clip(t.why) }));
  });
  const cover = rankCovers(resolved, ctx.combos)[0];
  const label = (k: string): string => cardLabel(ctx.graph.byKey.get(k) as SynergyCard);
  return ok({
    status: CANDIDATE_STATUS,
    cards: resolved.map(brief),
    links: links.map((e) => ({
      from: label(e.a),
      to: label(e.b),
      link: e.link,
      score: e.score,
      nonObvious: e.nonObvious.factor,
      differentAspects: e.nonObvious.aspects === 1,
      differentTraits: e.nonObvious.traits === 1,
      wording: e.nonObvious.wording,
      linkKind: e.linkKind,
      traitOnly: e.traitOnly,
      rows: e.rows.map((r) => ({ row: r.row, offer: r.offer, want: r.want, weight: r.weight, reason: r.reason })),
    })),
    noLink,
    ...(args.evidence ? { evidence } : {}),
    totalCost: resolved.reduce((s, c) => s + (c.structured.cost ?? 0), 0),
    aspectPair: cover.label,
    penalty: cover.penalty,
  });
}

export function aspectCover(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(aspectCoverShape).parse(input);
  const resolved = resolve(ctx, args.cardKeys);
  if (typeof resolved === "string") return fail(resolved);
  const fixed = args.leaderAspects !== undefined || args.baseAspects !== undefined;
  const ranked = fixed ? [coverPenalty(resolved, args.leaderAspects ?? [], args.baseAspects ?? [])] : rankCovers(resolved, ctx.combos);
  const holders = (type: string, icons: readonly string[]): { count: number; examples: string } => {
    const key = icons.join("+") || "neutral";
    const hit = ctx.cards.filter((c) => c.type === type && aspectGroup(c) === key);
    return { count: hit.length, examples: hit.slice(0, 3).map(cardLabel).sort(cmp).join("; ") };
  };
  const rows = ranked.slice(0, args.limit).map((r) => {
    const leaders = holders("Leader", r.leader);
    return {
      leader: r.leader.join("+") || "none",
      base: r.base.join("+") || "neutral",
      penalty: r.penalty,
      leaders: leaders.count,
      leaderExamples: leaders.examples,
      bases: holders("Base", r.base).count,
    };
  });
  const best = ranked[0];
  return ok({
    cards: resolved.map(brief),
    combinations: ranked.length,
    penaltyFree: ranked.filter((r) => r.penalty === 0).length,
    best: {
      combo: best.label,
      penalty: best.penalty,
      uncovered: best.uncovered.map((u) => ({
        card: cardLabel(ctx.graph.byKey.get(u.cardKey) as SynergyCard),
        icons: u.icons.join("+"),
        penalty: u.penalty,
      })),
    },
    shown: rows.length,
    combos: rows,
  });
}

const contexts = new WeakMap<CardStore, SynergyContext>();

export function synergyContextOf(store: CardStore): SynergyContext {
  let ctx = contexts.get(store);
  if (ctx === undefined) {
    ctx = loadSynergyContext(packageDirOf(store));
    contexts.set(store, ctx);
  }
  return ctx;
}

/** The play-calibrated scores, or none when the package has no scores (substitutes then sort by cost). */
function scoresOf(store: CardStore): ReadonlyMap<string, { playCalibrated: number | null }> {
  try {
    return valueData(store).rows;
  } catch {
    return new Map();
  }
}

function withContext(store: CardStore, run: (ctx: SynergyContext) => ToolResult): ToolResult {
  try {
    return run(synergyContextOf(store));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export const SYNERGY_TOOLS = {
  fungible_substitutes: {
    title: "Fungible substitutes",
    description:
      "Cards that fill the same role as a card (same offers/wants tag, timing, magnitude band, cost band and type), grouped by aspect. A deck picks the substitute its leader and base already cover. Roles come from the card's feature tags; trait tags are not roles. When the card's class has no other member, each role entry retries with the cost band relaxed to the adjacent bands, then with magnitude ignored as well (same tag, type, timing, target and arena kept), and reports it as widened (\"cost band\" or \"cost band + magnitude\", else null); those substitutes carry match: widened. A unit also holds one keyword:<Keyword> role per printed keyword (same arena, cost band and power-plus-HP band), listed first when the unit has no offers/wants tag or only a constant \"while ...\" condition, so a 3-cost Ground Sentinel finds other Ground Sentinels; its widening drops the stats band in the second step (\"cost band + stats band\"). Inside an aspect group substitutes sort by play-calibrated score; give leader (cardKey or exact title) to sort the ones that leader's tournament decklists play first, with leaderInclusion (null when unplayed) on each. Each substitute carries the clause text behind its role; they are candidates, so check that clause says the same thing as the slot card's (evidence: false turns it off).",
    shape: fungibleSubstitutesShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => fungibleSubstitutes(ctx, input, scoresOf(store))),
  },
  find_pairings: {
    title: "Find pairings",
    description:
      "Partners for a card from the offers-to-wants pair graph: enablers that feed it and payoffs it feeds, each with the reason, its linkKind (mechanical, trait+mechanical or trait-only), a score (link strength times non-obviousness), the aspect penalty, fungible alternatives by aspect and the clause text of each card that produced the offer and the want (status: candidate). By default (traits: bonus) only mechanical links rank; a trait the pair also shares is a small bonus, and pairs that only share a trait (obvious tribal links) come in a separate tribal list capped by tribalLimit (default 5). traits: exclude ignores traits; traits: include ranks trait-only pairs with the rest. Rows list at most perLink (default 3) per distinct link before rows that repeat a link, so the first page shows varied reasons; the deferred rows follow in rank order (capped counts them; perLink 100 turns the cap off). Leader and Base partners are left out because they cannot be one of a deck's 50 cards (includeLeaders: true lists them; partnerFilter states which applied). Give leader (cardKey or exact title) to weight the rank by the leader's tournament decklists: each partner carries leaderInclusion (null when unplayed), played partners rise, unplayed ones stay listed, aspects default to the leader's icons, and the leader block names the population and window. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it.",
    shape: findPairingsShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => findPairings(ctx, input)),
  },
  find_trios: {
    title: "Find trios",
    description:
      "Three-card combos built from the pair graph: chains A->B->C, two enablers into one payoff, and loops. Built from mechanical links by default; a trait the linked cards share is a small bonus, and traits: include admits trait-only links but every trio keeps at least one mechanical link. Ranked with a bonus for low total cost (default cap 9) and aspect cover; reports total cost, the cheapest leader+base aspect pair, its penalty (+2 resources per uncovered icon) and fungible alternatives per slot, with the clause text behind each link (status: candidate). Trios hold only cards a deck's 50 can hold; includeLeaders: true admits Leader and Base cards (partnerFilter states which applied). Give leader (cardKey or exact title) to weight each trio by the leader's tournament decklists: every member carries leaderInclusion (null when unplayed), rank multiplies the member factors, leaderAspects default to the leader's icons, and the leader block names the population and window. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it.",
    shape: findTriosShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => findTrios(ctx, input)),
  },
  explain_synergy: {
    title: "Explain synergy",
    description:
      "Link-by-link reasons why two or three cards pair: each directed link with its table rows, offers and wants tags, the card text that produced each tag, non-obviousness terms, total cost and aspect cover. Pairs with no link are listed. Status: candidate. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it.",
    shape: explainSynergyShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => explainSynergy(ctx, input)),
  },
  aspect_cover: {
    title: "Aspect cover",
    description:
      "Leader and base aspect combinations present in the card data, ranked cheapest first by the penalty for the given cards (+2 resources per aspect icon the leader and base do not supply), with the uncovered icons per card for the best combination.",
    shape: aspectCoverShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => aspectCover(ctx, input)),
  },
} as const;
