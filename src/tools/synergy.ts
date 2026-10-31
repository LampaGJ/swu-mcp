import { z } from "zod";
import { packageDirOf, type CardStore } from "../data.js";
import { selectLeaderPopulation, type LeaderSelection } from "../meta/leader-split.js";
import type { LeaderCardsEntry, LeaderCardRow } from "../meta/schema.js";
import { CANDIDATE_STATUS, clip, evidenceSpan, sourcedEvidenceOf, tagEvidence } from "../synergy/evidence.js";
import { comboLabel, coverPenalty, rankCovers, type CoverCombo } from "../synergy/cover.js";
import { engineHitOf, leaderActionOf, leaderEngineOf, roleKeepOf, suppliedKeywords, type EngineHit } from "../synergy/leader-engine.js";
import { loadSynergyContext, type SynergyContext } from "../synergy/context.js";
import { clauseLock, isLocked, lockFields, lockSupply, NO_LOCK, type ClauseLock } from "../synergy/clause-lock.js";
import {
  aspectGroup,
  commonMembers,
  jobFamilyOf,
  jobShare,
  KEEP_RULE,
  recommendKeep,
  roleOf,
  roleTagsOf,
  substitutesFor,
  textGrantTags,
  keywordJobMembers,
  widenedSubstitutes,
  type KeepCut,
  type KeepEntry,
  type Substitute,
  type SubstituteGroup,
  type SubstituteOptions,
} from "../synergy/fungibility.js";
import { edgeOrder, edgeScore, mechanicalRows, primaryRows, TRAIT_BONUS } from "../synergy/graph.js";
import { cardLabel, cmp, r3 } from "../synergy/order.js";
import { hostNeedOfCards, nameLockOfCards, resourceLockOfCards } from "../synergy/clause-lock.js";
import { baseEnabledOf, baseLockOfAll, enabledFields } from "../synergy/locks.js";
import { reasonOfHit } from "../synergy/reasons.js";
import { TRAITS_MODES, TRIO_SHAPES, type PairEdge, type PairRowHit, type SynergyCard, type TraitsMode, type TrioRecord, type TrioShape } from "../synergy/schema.js";
import { hasWeakClosingLink, slotRoles, trioLinks } from "../synergy/slots.js";
import { DEFAULT_TRIO_KEEP, TRIO_MEMBER_TYPES, trioOrder } from "../synergy/trios.js";
import type { ToolResult } from "../tools.js";
import { ok, fail } from "./common.js";
import { decklistField } from "./decklist-field.js";
import { inPremierPool, resolveRef, LEADER_INCLUSION_FLOOR, LEADER_STAPLE_INCLUSION, leaderSourceText, selectionFields, singlePenalty } from "./deck.js";
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

const WEIGHTINGS = ["leader", "none"] as const;
const weightingArg = z
  .enum(WEIGHTINGS)
  .default("leader")
  .describe(
    "leader (default): a Leader cardKey with no leader argument stands in as the leader (and its most-played base from tournament decklists as the base), the leader block says defaulted: true, and the rank is weighted by the leader's decklists. none: no inclusion weighting and no leader defaulting, the plain unweighted ranking; an explicit leader then still sets the aspects",
  );

const baseArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "The deck's base (Base type only), by cardKey or exact title; needs leader. With both, aspects default to the leader's and the base's icons together, so the penalty matches the deck; with a leader alone it is measured against the leader's icons only",
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
  base: baseArg,
  candidates: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Cards to weigh whatever the cost band: cardKeys or SET_NNN ids (like the deck tools). Each is always evaluated and listed under candidates with its score and the aspect penalty it pays under the leader and base (or preferAspects), outsideBand: true when no role lists it among the substitutes",
    ),
  decklist: decklistField
    .optional()
    .describe("The deck as {card, count}: cards already in it are left out of the substitutes, and the keywords its cards print count as the deck's supply when the card's job is judged"),
  maxClasses: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8)
    .describe("Role classes listed, the ones that cover most of the card's job first; the note says how many were cut"),
  exclude: z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .optional()
    .describe("Cards the builder has rejected: cardKeys, SET_NNN ids or exact titles (like the deck tools). They are never listed as substitutes"),
  maxPartners: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Partners listed besides the named candidates, locked ones last; partnersCut says how many were left out"),
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
  base: baseArg,
  weighting: weightingArg,
  perLink: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(3)
    .describe("Most rows listed per distinct link before further rows with the same link are deferred; 100 turns the cap off"),
  decklist: decklistField
    .optional()
    .describe(
      "The deck as {card, count}. With a leader, a partner's clause that needs the Force or a unit of a trait is checked against these cards instead of the leader's played lists (needsForce, needsTrait); their titles also meet a named-card clause",
    ),
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
  base: baseArg,
  weighting: weightingArg,
  minPlayed: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe(
      "Fewest members the leader's tournament decklists play (leaderInclusion of 0.02 or more). Default 2 when the rank is leader-weighted, 0 otherwise; above 0 it needs a leader with decklist data and weighting: leader",
    ),
  decklist: decklistField
    .optional()
    .describe(
      "The deck as {card, count}. With a leader, a member's clause that needs the Force or a unit of a trait is checked against these cards and the other members instead of the leader's played lists (needsForce, needsTrait); their titles also meet a named-card clause",
    ),
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
  /** How the leader's lists were narrowed to the deck's base (D60); absent when no base or aspect set was given. */
  selection?: LeaderSelection;
}

function resolveLeader(ctx: SynergyContext, ref: string): LeaderWeight | string {
  const leaders = ctx.cards.filter((c) => c.type === "Leader");
  const byKey = leaders.find((c) => c.cardKey === ref);
  const hits = byKey !== undefined ? [byKey] : leaders.filter((c) => cardLabel(c) === ref || c.title === ref);
  if (hits.length === 0) return `no Leader card with cardKey or exact title ${ref}`;
  if (hits.length > 1) return `${ref} names ${hits.length} leaders; give one cardKey: ${hits.map((c) => `${c.cardKey} (${cardLabel(c)})`).join(", ")}`;
  return { card: hits[0], data: ctx.leaderCards?.get(hits[0].cardKey) ?? null };
}

/** Decision D45: the deck's base, a Base card by cardKey or exact title; a base needs the leader whose icons it adds to. */
function resolveBase(ctx: SynergyContext, ref: string): SynergyCard | string {
  const bases = ctx.cards.filter((c) => c.type === "Base");
  const byKey = bases.find((c) => c.cardKey === ref);
  const hits = byKey !== undefined ? [byKey] : bases.filter((c) => cardLabel(c) === ref || c.title === ref);
  if (hits.length === 0) return `no Base card with cardKey or exact title ${ref}`;
  if (hits.length > 1) return `${ref} names ${hits.length} bases; give one cardKey: ${hits.map((c) => `${c.cardKey} (${cardLabel(c)})`).join(", ")}`;
  return hits[0];
}

interface Picked {
  leader?: LeaderWeight;
  base?: SynergyCard;
  /** The leader came from a Leader cardKey, not from the leader argument. */
  leaderDefaulted?: boolean;
  /** The base came from the leader's most-played base in meta, not from the base argument. */
  baseDefaulted?: boolean;
}

/**
 * D47: a Leader cardKey with no leader argument is the deck's leader, and its most-played base (meta topBase) the
 * base unless one is given; weighting "none" turns that off and restores the answer without a leader.
 */
function leaderAndBase(
  ctx: SynergyContext,
  args: { leader?: string; base?: string; weighting: (typeof WEIGHTINGS)[number]; aspects?: readonly string[]; baseAspects?: readonly string[] },
  subject?: SynergyCard,
): Picked | string {
  const leaderDefaulted = args.leader === undefined && args.weighting === "leader" && subject?.type === "Leader";
  if (args.leader === undefined && !leaderDefaulted)
    return args.base === undefined ? {} : "base needs a leader: give leader too, because the base only adds its icons to the leader's";
  const leader = resolveLeader(ctx, leaderDefaulted ? (subject as SynergyCard).cardKey : (args.leader as string));
  if (typeof leader === "string") return leader;
  const flags = leaderDefaulted ? { leaderDefaulted } : {};
  if (args.base !== undefined) {
    const base = resolveBase(ctx, args.base);
    if (typeof base === "string") return base;
    return { leader: narrowed(leader, { base: { cardKey: base.cardKey, title: cardLabel(base), aspects: base.structured.aspectIcons } }), base, ...flags };
  }
  // D60: a supplied aspect set is the deck's colours; the leader's most-played base never replaces it, and its extra icon names the base's aspect.
  if (args.aspects !== undefined || args.baseAspects !== undefined) {
    const given = args.baseAspects ?? withoutOnce(args.aspects ?? [], leader.card.structured.aspectIcons);
    return { leader: given.length === 1 ? narrowed(leader, { baseAspects: given }) : leader, ...flags };
  }
  const top = leaderDefaulted ? leader.data?.entry.topBase : null;
  const topBase = top == null ? undefined : ctx.cards.find((c) => c.type === "Base" && c.cardKey === top.cardKey);
  return topBase === undefined ? { leader, ...flags } : { leader, base: topBase, baseDefaulted: true, ...flags };
}

/** The leader's lists narrowed to the given base or base aspect (D60); the weight keeps its shape. */
/** The leader block already names the base in its own `base` object, so the selection's `base` label is dropped there. */
const omitBase = (fields: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(fields).filter(([key]) => key !== "base"));

function narrowed(leader: LeaderWeight, query: Parameters<typeof selectLeaderPopulation>[1]): LeaderWeight {
  if (leader.data === null) return leader;
  const picked = selectLeaderPopulation(leader.data, query);
  return { ...leader, data: picked, selection: picked.selection };
}

/** The aspects left after one copy of each leader icon is taken out: with the leader's icons that is the base's aspect. */
function withoutOnce(aspects: readonly string[], leaderIcons: readonly string[]): string[] {
  const rest = [...aspects];
  for (const icon of leaderIcons) {
    const at = rest.indexOf(icon);
    if (at >= 0) rest.splice(at, 1);
  }
  return rest;
}

/** The link strength of a leader-engine row: the leader's own clause is exact text, so it takes a strong mechanical link's score (D60). */
const ENGINE_LINK_SCORE = 1.5;
/** Decision D73: the rank factor of a partner whose own clause names a base location that the given base meets. */
export const BASE_ENABLED_FACTOR = 1.5;
/** A partner the leader's lists play (D51 floor) and that meets the leader's clause ranks as one they play at the staple share (D60), unless they play it more; an unplayed one takes the plain 0.5 (D65). */
const engineFactor = (): number => 0.5 + LEADER_STAPLE_INCLUSION;

/** Decision D74: the table rows that say only "a unit put into play still counts as played" (data/complementarity.json). */
const GENERIC_PLAY_ROWS: ReadonlySet<string> = new Set(["play-trigger-payoff", "paid-play-trigger"]);
const isGenericPlay = (e: PairEdge): boolean => {
  const rows = mechanicalRows(e);
  return rows.length > 0 && rows.every((r) => GENERIC_PLAY_ROWS.has(r.row));
};

const NO_BASE_NOTE = "base not given: penalties measured against the leader's icons only";

/** Share of the leader's decklists that play the card; null when the card is unplayed in them. */
const inclusionOf = (w: LeaderWeight, cardKey: string): number | null => w.data?.byCard.get(cardKey)?.inclusion ?? null;
/** Decision D51: a card is played when the leader's lists hold it at LEADER_INCLUSION_FLOOR or more; the share shown stays the raw one. */
const isPlayed = (inclusion: number | null | undefined): inclusion is number => inclusion != null && inclusion >= LEADER_INCLUSION_FLOOR;
const playedInclusion = (w: LeaderWeight, cardKey: string): number | null => {
  const inc = inclusionOf(w, cardKey);
  return isPlayed(inc) ? inc : null;
};
const leaderFactor = (w: LeaderWeight, cardKey: string): number => {
  const inc = playedInclusion(w, cardKey);
  return inc === null ? 0.5 : 0.5 + inc;
};

function leaderBlock(
  w: LeaderWeight,
  unit: "partner" | "trio" | "substitute",
  base?: SynergyCard,
  noBaseNote = false,
  picked: Pick<Picked, "leaderDefaulted" | "baseDefaulted"> & { weighted?: boolean } = {},
): Record<string, unknown> {
  const head = {
    cardKey: w.card.cardKey,
    title: cardLabel(w.card),
    aspects: w.card.structured.aspectIcons.join("+") || "none",
    ...(picked.leaderDefaulted === true ? { defaulted: true } : {}),
    ...(base === undefined
      ? {}
      : {
          base: {
            cardKey: base.cardKey,
            title: cardLabel(base),
            aspects: base.structured.aspectIcons.join("+") || "none",
            ...(picked.baseDefaulted === true ? { defaulted: true } : {}),
          },
        }),
    ...(base === undefined && noBaseNote ? { baseNote: NO_BASE_NOTE } : {}),
  };
  if (picked.weighted === false) return { ...head, note: "weighting: none; ranking is not leader-weighted, aspects still default to its icons" };
  if (w.data === null) return { ...head, note: "no decklist data for this leader in the package; ranking is not leader-weighted, aspects still default to its icons" };
  const { entry } = w.data;
  const how =
    unit === "substitute"
      ? "inside an aspect group, substitutes sort by leaderInclusion (unplayed last), then play-calibrated score"
      : unit === "partner"
      ? "rank = the unweighted rank x (0.5 + leaderInclusion) when the leader's decks play the partner, x 0.5 when they do not"
      : "rank = score x the cube root of the product of the member factors (their geometric mean), each (0.5 + leaderInclusion) when the leader's decks play the member and 0.5 when they do not";
  return {
    ...head,
    population: entry.population,
    decks: entry.decks,
    window: `${entry.window.from}..${entry.window.to}`,
    ...(w.selection === undefined ? {} : omitBase(selectionFields(w.selection))),
    note: `leaderInclusion = placement-weighted share of this leader's decklists that play the card (${leaderSourceText(entry, w.selection)}); null = unplayed in them; under ${LEADER_INCLUSION_FLOOR * 100}% counts as unplayed in the rank. ${how}.`,
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

/** The text behind a role: the tag's clause, the granting clause of a grant the tag step cannot name (D70), or the printed keyword for a keyword role (it has no clause). */
const roleText = (card: SynergyCard, tag: string): string => {
  if (tag.startsWith("keyword:")) return `printed keyword ${tag.slice("keyword:".length)}`;
  const grant = textGrantTags(card).find((t) => t.tag === tag);
  return grant === undefined ? tagEvidence(card, tag) : clip(evidenceSpan(card, grant.why));
};

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
  const inclusion = (k: string): number | null => (weight === undefined ? null : playedInclusion(weight, k));
  return (a, b) =>
    descNullLast(inclusion(a.cardKey), inclusion(b.cardKey)) ||
    descNullLast(scores.get(a.cardKey)?.playCalibrated, scores.get(b.cardKey)?.playCalibrated) ||
    (a.cost ?? 99) - (b.cost ?? 99) ||
    cmp(a.cardKey, b.cardKey);
}

/** What the registered tool resolves from names before the handler runs: the deck's cards and the named candidates. */
export interface FungibleResolved {
  deckKeys: ReadonlySet<string>;
  deckCards: readonly SynergyCard[];
  /** The named candidates as cardKeys; when absent the input's candidates are read as cardKeys. */
  candidates?: readonly string[];
  unresolvedCandidates?: readonly { card: string; reason: string; detail: string }[];
  /** The rejected cards as cardKeys (D67); when absent the input's exclude is read as cardKeys. */
  exclude?: readonly string[];
  unresolvedExclude?: readonly { card: string; reason: string; detail: string }[];
}

interface PartnerMark {
  feedsOriginal?: true;
  feedsRow?: string;
  fedByOriginal?: true;
  fedByRow?: string;
}

export function fungibleSubstitutes(
  ctx: SynergyContext,
  input: unknown,
  scores: ReadonlyMap<string, { playCalibrated: number | null }> = new Map(),
  inPool?: (cardKey: string) => boolean,
  resolved: FungibleResolved = { deckKeys: new Set(), deckCards: [] },
): ToolResult {
  const args = z.object(fungibleSubstitutesShape).parse(input);
  const cards = resolve(ctx, [args.cardKey]);
  if (typeof cards === "string") return fail(cards);
  const slot = cards[0];
  const leader = args.leader === undefined ? undefined : resolveLeader(ctx, args.leader);
  if (typeof leader === "string") return fail(leader);
  if (args.base !== undefined && leader === undefined) return fail("base needs a leader: give leader too, because the base only adds its icons to the leader's");
  const base = args.base === undefined ? undefined : resolveBase(ctx, args.base);
  if (typeof base === "string") return fail(base);
  const named = resolved.candidates ?? args.candidates ?? [];
  const unresolvedCandidates = [
    ...(resolved.unresolvedCandidates ?? []),
    ...(resolved.candidates === undefined ? named.filter((k) => !ctx.graph.byKey.has(k)).map((k) => ({ card: k, reason: "unknown", detail: "no card with this cardKey in the feature file" })) : []),
  ];
  const candidateKeys = [...new Set(named.filter((k) => ctx.graph.byKey.has(k)))];
  const rejected = resolved.exclude ?? args.exclude ?? [];
  const unresolvedExclude = [
    ...(resolved.unresolvedExclude ?? []),
    ...(resolved.exclude === undefined ? rejected.filter((k) => !ctx.graph.byKey.has(k)).map((k) => ({ card: k, reason: "unknown", detail: "no card with this cardKey in the feature file" })) : []),
  ];
  const excluded = new Set(rejected.filter((k) => ctx.graph.byKey.has(k)));
  const supplied: readonly string[] | undefined =
    leader !== undefined && base !== undefined ? [...leader.card.structured.aspectIcons, ...base.structured.aspectIcons] : args.preferAspects;
  const showPenalty = supplied !== undefined && (base !== undefined || candidateKeys.length > 0);
  const penaltyOf = (c: SynergyCard): number | undefined => (showPenalty ? singlePenalty(c, supplied as readonly string[]) : undefined);
  const inDeck = resolved.deckKeys;
  // D59 needs the leader and the base to judge a lock: with either missing the lock stays silent rather than guess the base.
  const supply = leader !== undefined && base !== undefined ? lockSupply(leader.card, base, resolved.deckCards) : undefined;
  const lockOf = (c: SynergyCard): ClauseLock => (supply === undefined ? NO_LOCK : clauseLock(c, supply));
  const partnerCache = new Map<string, PartnerMark>();
  const partnerOf = (cardKey: string): PartnerMark => {
    const known = partnerCache.get(cardKey);
    if (known !== undefined) return known;
    const rowOf = (edge: PairEdge | undefined): string | undefined => {
      const row = edge === undefined ? undefined : mechanicalRows(edge)[0];
      return row === undefined ? undefined : `${row.row}: ${row.offer} -> ${row.want}`;
    };
    const feeds = cardKey === slot.cardKey ? undefined : rowOf(ctx.graph.edgeByKey.get(`${cardKey}>${slot.cardKey}`));
    const fedBy = cardKey === slot.cardKey ? undefined : rowOf(ctx.graph.edgeByKey.get(`${slot.cardKey}>${cardKey}`));
    const mark: PartnerMark = {
      ...(feeds === undefined ? {} : { feedsOriginal: true as const, feedsRow: feeds }),
      ...(fedBy === undefined ? {} : { fedByOriginal: true as const, fedByRow: fedBy }),
    };
    partnerCache.set(cardKey, mark);
    return mark;
  };
  const isPartner = (cardKey: string): boolean => partnerOf(cardKey).feedsOriginal === true || partnerOf(cardKey).fedByOriginal === true;
  /** Rank inside an aspect group: plain stand-ins, then partners of the original, then locked cards (D67). */
  const rankOf = (cardKey: string): number => Number(isLocked(lockOf(ctx.graph.byKey.get(cardKey) as SynergyCard))) * 2 + Number(isPartner(cardKey));
  const engine = leader === undefined ? null : leaderEngineOf(leader.card);
  const roleKeep = roleKeepOf(slot, suppliedKeywords(engine, resolved.deckCards));
  const tags =
    args.tag !== undefined
      ? [args.tag]
      : [
          ...new Set(
            (ctx.fungibility.rolesByCard.get(slot.cardKey) ?? []).map((id) => (ctx.fungibility.classById.get(id) as { tag: string }).tag),
          ),
        ].filter((tag) => roleKeep === null || roleKeep.tags.has(tag));
  if (tags.length === 0)
    return ok({ status: CANDIDATE_STATUS, card: brief(slot), partners: [], standIns: [], roles: [], note: "the card carries no offers/wants role (trait tags are not roles)" });
  const keep = (cardKey: string): boolean =>
    (inPool === undefined || inPool(cardKey)) &&
    !inDeck.has(cardKey) &&
    !excluded.has(cardKey) &&
    (roleKeep === null || roleKeep.keptBy(ctx.graph.byKey.get(cardKey) as SynergyCard).length > 0);
  // D69: a card with a pair edge to the original is a partner and never a stand-in; the two lists are built from separate filters.
  const options: SubstituteOptions = {
    preferAspects: args.preferAspects ?? (base === undefined ? undefined : supplied),
    crossAspectOnly: args.crossAspectOnly,
    maxCost: args.maxCost,
    perGroup: args.limit,
    order: ((leaderOrder) => (a: Substitute, b: Substitute) => rankOf(a.cardKey) - rankOf(b.cardKey) || leaderOrder(a, b))(substituteOrder(leader, scores)),
    keep: (cardKey) => keep(cardKey) && !isPartner(cardKey),
  };
  const partnerOptions: SubstituteOptions = { ...options, perGroup: 50, keep: (cardKey) => keep(cardKey) && isPartner(cardKey) };
  const partnerPool = new Set<string>();
  const roles = tags.flatMap((tag) => {
    const cls = roleOf(ctx.fungibility, slot.cardKey, tag);
    if (cls === undefined) return [];
    // D74: a keyword-job class also matches printers and unconditional self-gainers of the same keyword.
    const joined = keywordJobMembers(ctx.fungibility, cls, slot.cardKey);
    const exact = substitutesFor(ctx.fungibility, joined.members, slot.cardKey, options);
    const widenedResult = joined.members.length === 1 ? widenedSubstitutes(ctx.fungibility, cls, slot.cardKey, options) : null;
    const groups = widenedResult?.groups ?? exact;
    const partnerExact = substitutesFor(ctx.fungibility, joined.members, slot.cardKey, partnerOptions);
    const partnerGroups = (joined.members.length === 1 ? widenedSubstitutes(ctx.fungibility, cls, slot.cardKey, partnerOptions)?.groups : undefined) ?? partnerExact;
    for (const g of partnerGroups) for (const c of g.cards) partnerPool.add(c.cardKey);
    const withText = (c: SubstituteGroup["cards"][number]) => {
      const widenedMark = widenedResult === null ? c : { ...c, match: "widened" };
      const syn = ctx.graph.byKey.get(c.cardKey) as SynergyCard;
      const penalty = penaltyOf(syn);
      const kept = roleKeep === null ? [] : roleKeep.keptBy(syn);
      const marked = {
        ...widenedMark,
        coverage: jobShare(ctx.fungibility, slot.cardKey, c.cardKey),
        ...lockFields(lockOf(syn)),
        ...partnerOf(c.cardKey),
        ...(leader === undefined ? {} : { leaderInclusion: inclusionOf(leader, c.cardKey) }),
        ...(penalty === undefined ? {} : { penalty }),
        ...(roleKeep === null ? {} : { keepsRole: kept.join(", ") }),
        ...(joined.via.has(c.cardKey) ? { keywordJob: joined.via.get(c.cardKey) } : {}),
      };
      return args.evidence ? { ...marked, text: roleText(syn, joined.via.get(c.cardKey) ?? tag) } : marked;
    };
    const shownGroups = groups
      // A group with nothing but locked cards follows the groups that hold a usable one.
      .map((g) => ({ g, allLocked: g.cards.every((c) => rankOf(c.cardKey) >= 2) }))
      .sort((x, y) => Number(x.allLocked) - Number(y.allLocked))
      .map(({ g }) => ({ aspects: g.aspects, differsFromSlot: g.differsFromSlot, covered: g.covered, cards: g.cards.map(withText) }));
    // A locked card cannot fill the slot in this deck, so only unlocked cards count toward the class's coverage.
    const usable = groups.flatMap((g) => g.cards).filter((c) => rankOf(c.cardKey) < 2);
    return [
      {
        classId: cls.id,
        tag,
        coverage: Math.max(0, ...usable.map((c) => jobShare(ctx.fungibility, slot.cardKey, c.cardKey))),
        classSize: cls.members.length,
        ...(joined.via.size === 0 ? {} : { keywordJobAdded: joined.via.size }),
        widened: widenedResult?.widened ?? null,
        aspectSets: new Set(cls.members.map((k) => aspectGroup(ctx.graph.byKey.get(k) as SynergyCard))).size,
        ...(args.evidence ? { slotText: roleText(slot, tag) } : {}),
        substitutes: shownGroups,
      },
    ];
  });
  if (roles.length === 0) return fail(`${slot.cardKey} has no role for tag ${args.tag}`);
  const everyListedKey = new Set(roles.flatMap((r) => r.substitutes.flatMap((g) => g.cards.map((c) => c.cardKey))));
  // D67: the classes that cover most of the card's job come first (a class with no substitute last, ties in the order the card carries its roles), and maxClasses cuts the rest.
  const ordered = roles
    .map((role, index) => ({ role, index }))
    .sort((x, y) => y.role.coverage - x.role.coverage || Number(y.role.substitutes.length > 0) - Number(x.role.substitutes.length > 0) || x.index - y.index)
    .map(({ role }) => role);
  const shownRoles = ordered.slice(0, args.maxClasses);
  const classesCut = ordered.length - shownRoles.length;
  const listedKeys = new Set([...shownRoles.flatMap((r) => r.substitutes.flatMap((g) => g.cards.map((c) => c.cardKey))), ...partnerPool]);
  const candidates = candidateKeys.map((key) => {
    const syn = ctx.graph.byKey.get(key) as SynergyCard;
    const penalty = penaltyOf(syn);
    const carried = new Set([...syn.tags.offers, ...syn.tags.wants].map((t) => t.tag));
    const shares = tags.filter((tag) => carried.has(tag));
    return {
      cardKey: key,
      title: cardLabel(syn),
      type: syn.type,
      cost: syn.structured.cost,
      aspects: aspectGroup(syn),
      ...(penalty === undefined ? {} : { penalty }),
      playCalibrated: scores.get(key)?.playCalibrated ?? null,
      ...(leader === undefined ? {} : { leaderInclusion: inclusionOf(leader, key) }),
      outsideBand: !listedKeys.has(key),
      sharesRoles: shares.join(", ") || "none",
      coverage: jobShare(ctx.fungibility, slot.cardKey, key),
      ...lockFields(lockOf(syn)),
      ...partnerOf(key),
      ...(excluded.has(key) ? { excluded: true } : {}),
      ...(roleKeep === null ? {} : { keepsRole: roleKeep.keptBy(syn).join(", ") || "none" }),
      ...(inDeck.has(key) ? { inDeck: true } : {}),
      ...(inPool === undefined ? {} : { premierPool: inPool(key) }),
    };
  });
  const slotPenalty = penaltyOf(slot);
  const rowOf = (key: string, named: boolean) => {
    const syn = ctx.graph.byKey.get(key) as SynergyCard;
    const penalty = penaltyOf(syn);
    const held = roleTagsOf(ctx.fungibility, key);
    const shared = tags.filter((t) => held.has(t));
    return {
      cardKey: key,
      title: cardLabel(syn),
      type: syn.type,
      cost: syn.structured.cost,
      aspects: aspectGroup(syn),
      roles: shared.join(", ") || "none",
      coverage: jobShare(ctx.fungibility, slot.cardKey, key),
      ...lockFields(lockOf(syn)),
      ...partnerOf(key),
      ...(leader === undefined ? {} : { leaderInclusion: inclusionOf(leader, key) }),
      ...(penalty === undefined ? {} : { penalty }),
      ...(named ? { candidate: true } : {}),
      ...(args.evidence && shared[0] !== undefined ? { text: roleText(syn, shared[0]) } : {}),
    };
  };
  const byPlay = (a: string, b: string): number =>
    rankOf(a) - rankOf(b) ||
    descNullLast(leader === undefined ? null : playedInclusion(leader, a), leader === undefined ? null : playedInclusion(leader, b)) ||
    descNullLast(scores.get(a)?.playCalibrated, scores.get(b)?.playCalibrated) ||
    cmp(a, b);
  const namedPartnerKeys = candidateKeys.filter(isPartner);
  const otherPartnerKeys = [...partnerPool].filter((k) => !namedPartnerKeys.includes(k)).sort(byPlay);
  const shownPartnerKeys = [...namedPartnerKeys, ...otherPartnerKeys.slice(0, args.maxPartners)];
  const partnersCut = otherPartnerKeys.length - Math.min(otherPartnerKeys.length, args.maxPartners);
  const partners = shownPartnerKeys.map((k) => rowOf(k, candidateKeys.includes(k)));
  const standInKeys = [
    ...new Set(
      shownRoles.flatMap((r) => r.substitutes.flatMap((g) => g.cards.map((c) => c.cardKey))),
    ),
  ].sort(
    (a, b) => rankOf(a) - rankOf(b) || jobShare(ctx.fungibility, slot.cardKey, b) - jobShare(ctx.fungibility, slot.cardKey, a) || byPlay(a, b),
  );
  const standIns = standInKeys.map((k) => rowOf(k, candidateKeys.includes(k)));
  const recommendation = ((): Record<string, unknown> | undefined => {
    if (candidateKeys.length === 0 || resolved.deckCards.length === 0) return undefined;
    const deckKeysUnique = [...new Set(resolved.deckCards.map((c) => c.cardKey))];
    // D71: the job compared is the wants of the original that a candidate feeds (for Oppo Rancisis, fed by Anakin through wants:keyword-hidden and -shielded: the keyword-holder family); a deck card feeds a card only through a row of that job.
    const jobFamilies = new Set(
      candidateKeys
        .filter((k) => k !== slot.cardKey)
        .flatMap((k) => {
          const edge = ctx.graph.edgeByKey.get(`${k}>${slot.cardKey}`);
          return edge === undefined ? [] : mechanicalRows(edge).map((r) => jobFamilyOf(r.want));
        }),
    );
    const feedsJob = (edge: PairEdge | undefined): boolean =>
      edge !== undefined && mechanicalRows(edge).some((r) => jobFamilies.size === 0 || jobFamilies.has(jobFamilyOf(r.want)));
    const entryOf = (key: string, role: "original" | "candidate") => {
      const syn = ctx.graph.byKey.get(key) as SynergyCard;
      // The original leaves the deck when a candidate replaces it, so it never counts as feeding its own replacement.
      const feeders = deckKeysUnique
        .filter((d) => d !== key && d !== slot.cardKey)
        .filter((d) => feedsJob(ctx.graph.edgeByKey.get(`${d}>${key}`)))
        .map((d) => cardLabel(ctx.graph.byKey.get(d) as SynergyCard))
        .sort(cmp);
      const share = leader === undefined ? null : playedInclusion(leader, key);
      const relation = key === slot.cardKey ? undefined : partnerOf(key);
      const entry: KeepEntry = {
        cardKey: key,
        label: cardLabel(syn),
        penalty: penaltyOf(syn) ?? null,
        playShare: share,
        fedBy: feeders.length,
        ...(relation?.feedsOriginal === true ? { relationToFirst: "feeds" as const } : relation?.fedByOriginal === true ? { relationToFirst: "fedBy" as const } : {}),
      };
      return {
        entry,
        row: {
          cardKey: key,
          title: entry.label,
          role,
          penalty: entry.penalty,
          playShare: share ?? (leader !== undefined && leader.data !== null ? "unplayed" : null),
          fedByDeck: entry.fedBy,
          fedByCards: feeders.join("; ") || "none",
        },
      };
    };
    const rows = [entryOf(slot.cardKey, "original"), ...candidateKeys.filter((k) => k !== slot.cardKey).map((k) => entryOf(k, "candidate"))];
    const cuts: KeepCut[] = deckKeysUnique.flatMap((k) => {
      const syn = ctx.graph.byKey.get(k) as SynergyCard;
      const linked = (a: string, b: string): boolean => {
        const edge = ctx.graph.edgeByKey.get(`${a}>${b}`);
        return edge !== undefined && mechanicalRows(edge).length > 0;
      };
      const deckLinks = deckKeysUnique.filter((o) => o !== k && (linked(k, o) || linked(o, k))).length;
      return syn.type === "Leader" || syn.type === "Base"
        ? []
        : [{ cardKey: k, label: cardLabel(syn), penalty: penaltyOf(syn) ?? null, playShare: leader === undefined ? null : playedInclusion(leader, k), deckLinks, feeds: [slot.cardKey, ...candidateKeys].filter((c) => c !== k && linked(k, c)) }];
    });
    const verdict = recommendKeep(rows.map((r) => r.entry), cuts);
    return {
      rule: KEEP_RULE,
      ...(jobFamilies.size === 0 ? {} : { feederJob: [...jobFamilies].sort(cmp).join(", ") }),
      cards: rows.map((r) => r.row),
      keep: verdict.keep,
      keepTitle: cardLabel(ctx.graph.byKey.get(verdict.keep) as SynergyCard),
      decidedBy: verdict.decidedBy,
      verdict: verdict.sentence,
      ...(verdict.cutForCandidate === undefined
        ? {}
        : {
            cutForCandidate: {
              cardKey: verdict.cutForCandidate.cardKey,
              title: verdict.cutForCandidate.label,
              aspects: aspectGroup(ctx.graph.byKey.get(verdict.cutForCandidate.cardKey) as SynergyCard),
              penalty: verdict.cutForCandidate.penalty,
              playShare: verdict.cutForCandidate.playShare ?? (leader !== undefined && leader.data !== null ? "unplayed" : null),
              deckLinks: verdict.cutForCandidate.deckLinks,
            },
          }),
    };
  })();
  // The note names the candidates first, then at most PARTNERS_NAMED others; every row carries its own mark.
  const PARTNERS_NAMED = 3;
  const partnerKeys = shownPartnerKeys;
  const namedPartners = partnerKeys.slice(0, Math.max(namedPartnerKeys.length, PARTNERS_NAMED));
  const lockedKeys = [...new Set([...standInKeys, ...partnerKeys, ...candidateKeys])].filter((k) => isLocked(lockOf(ctx.graph.byKey.get(k) as SynergyCard)));
  const note = [
    classesCut > 0
      ? `${shownRoles.length} of ${ordered.length} role classes are listed (maxClasses ${args.maxClasses}; ${classesCut} cut). Classes come in order of coverage, the share of this card's offers and wants that a class's best unlocked card also holds; each card row carries its own coverage.`
      : undefined,
    partnerKeys.length === 0
      ? undefined
      : `Partners, not replacements: ${namedPartners
          .map((k) => {
            const mark = partnerOf(k);
            const how = mark.feedsOriginal === true && mark.fedByOriginal === true ? "feeds and is fed by" : mark.feedsOriginal === true ? "feeds" : "is fed by";
            return `${cardLabel(ctx.graph.byKey.get(k) as SynergyCard)} ${how} ${cardLabel(slot)}`;
          })
          .join("; ")}${partnerKeys.length > namedPartners.length ? `; ${partnerKeys.length - namedPartners.length} more` : ""}. A card with a pair edge to the original works beside it: partners lists it with the edge's row (feedsOriginal or fedByOriginal), and standIns, the cards that do the original's job, never does.${partnersCut > 0 ? ` ${partnersCut} more partners cut (maxPartners ${args.maxPartners}).` : ""}`,
    standIns.length === 0
      ? `No stand-in exists for ${cardLabel(slot)}: no card in its role classes does its job without a pair edge to it (cards in the deck or excluded are left out) (D70).`
      : undefined,
    recommendation === undefined ? undefined : `recommendation (D69): ${KEEP_RULE}.`,
    lockedKeys.length === 0
      ? undefined
      : "baseLocked or needsUnitAspect: a clause of the card needs a base location or a unit aspect that this leader, base and decklist do not supply (D59); locked cards rank after the unlocked ones.",
  ].filter((x): x is string => x !== undefined);
  return ok({
    status: CANDIDATE_STATUS,
    card: { ...brief(slot), ...lockFields(lockOf(slot)), ...(slotPenalty === undefined ? {} : { penalty: slotPenalty }) },
    ...(leader === undefined ? {} : { leader: leaderBlock(leader, "substitute", base) }),
    ...(showPenalty ? { suppliedIcons: (supplied as readonly string[]).join("+") || "none" } : {}),
    ...(roleKeep === null
      ? {}
      : {
          roleKept: {
            families: roleKeep.families,
            note: roleKeep.note,
            ...(everyListedKey.size === 0 && partnerPool.size === 0 ? { none: `no card in the pool ${roleKeep.jobs.join(" or ")}` } : {}),
          },
        }),
    ...(candidates.length === 0 ? {} : { candidates }),
    ...(unresolvedCandidates.length === 0 ? {} : { unresolvedCandidates }),
    ...(excluded.size === 0 ? {} : { excluded: [...excluded].sort(cmp).join(", ") }),
    ...(unresolvedExclude.length === 0 ? {} : { unresolvedExclude }),
    classesTotal: ordered.length,
    classesCut,
    partnersTotal: namedPartnerKeys.length + otherPartnerKeys.length,
    partnersCut,
    ...(note.length === 0 ? {} : { note: note.join(" ") }),
    partners,
    standIns,
    ...(recommendation === undefined ? {} : { recommendation }),
    roles: shownRoles,
  });
}

/** The link e with `from` swapped for `to`, when the graph holds it through one of e's own rows; a conditional link needs one of `others` to supply its traits. */
function keepsLink(ctx: SynergyContext, e: PairEdge, from: string, to: string, others: readonly string[]): boolean {
  const key = e.a === from ? `${to}>${e.b}` : `${e.a}>${to}`;
  const rows = new Set(primaryRows(e).map((r) => r.row));
  const sameRow = (x: PairEdge | undefined): boolean => x !== undefined && x.rows.some((r) => rows.has(r.row));
  const direct = ctx.graph.edgeByKey.get(key);
  if (sameRow(direct)) return true;
  const conditional = ctx.graph.conditionalByKey.get(key);
  if (!sameRow(conditional)) return false;
  const ends = new Set([e.a === from ? to : e.a, e.b === from ? to : e.b]);
  return others.some((k) => !ends.has(k) && (conditional?.needs ?? []).every((t) => ctx.graph.boardTraits(k).includes(t)));
}

/**
 * Decision D46: an alternative for a slot is in the Premier pool and keeps every link the slot card holds in the
 * combo, so a substitute cannot bypass a trait binding (D42, D43) that the slot card satisfied.
 */
function slotKeep(ctx: SynergyContext, slot: string, links: readonly PairEdge[], members: readonly string[], inPool: ((cardKey: string) => boolean) | undefined): (cardKey: string) => boolean {
  const touching = links.filter((e) => e.a === slot || e.b === slot);
  return (k) => {
    if (inPool !== undefined && !inPool(k)) return false;
    const others = members.map((m) => (m === slot ? k : m));
    return touching.every((e) => keepsLink(ctx, e, slot, k, others));
  };
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
const DEFAULT_MIN_PLAYED = 2;
/** Third members listed under one kept trio; the rest of a popular pair's partners add length, not choice. */
const MAX_TRIO_VARIANTS = 5;
const NO_CURATED: ReadonlyMap<string, string> = new Map();

/** D63 (#154): a pairing's evidence quotes a curated tag's clause, as a trio's does (D49); `source` appears only when a side is curated. */
function pairEvidence(ctx: SynergyContext, e: PairEdge, rows: readonly PairRowHit[]): Record<string, string>[] {
  return sourcedEvidenceOf(e, ctx.graph.byKey, rows, ctx.curated ?? NO_CURATED).map(({ source, ...text }) => (source === "grammar" ? text : { ...text, source }));
}

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

/**
 * D68: the cards the Force and trait locks read: the decklist when given, else the cards the leader's lists play at the
 * D51 floor; undefined (no lock read) without a leader, or without a decklist when the leader has no list data.
 */
function lockPool(ctx: SynergyContext, leader: LeaderWeight | undefined, deck: readonly SynergyCard[]): readonly SynergyCard[] | undefined {
  if (leader === undefined) return undefined;
  if (deck.length > 0) return deck;
  if (leader.data == null) return undefined;
  return [...leader.data.byCard.keys()].flatMap((k) => (isPlayed(inclusionOf(leader, k)) ? [ctx.graph.byKey.get(k) ?? []].flat() : []));
}

/** Decklist lines as cards: resolved names from the tool boundary, else the lines read as cardKeys (in-code callers). */
const deckOf = (ctx: SynergyContext, lines: readonly { card: string }[] | undefined, resolved: readonly SynergyCard[] | undefined): readonly SynergyCard[] =>
  resolved ?? (lines ?? []).flatMap((l) => [ctx.graph.byKey.get(l.card) ?? []].flat());

const NO_RESOURCE_LOCK = { needsForce: [], needsTrait: [] };


/** The D68 output fields, present only while they hold. */
const resourceFields = (r: { needsForce: string[]; needsTrait: string[] }): Record<string, string> => ({
  ...(r.needsForce.length === 0 ? {} : { needsForce: r.needsForce.join(", ") }),
  ...(r.needsTrait.length === 0 ? {} : { needsTrait: r.needsTrait.join(", ") }),
});

export function findPairings(ctx: SynergyContext, input: unknown, inPool?: (cardKey: string) => boolean, deckCards?: readonly SynergyCard[]): ToolResult {
  const args = z.object(findPairingsShape).parse(input);
  const resolved = resolve(ctx, [args.cardKey]);
  if (typeof resolved === "string") return fail(resolved);
  const card = resolved[0];
  const picked = leaderAndBase(ctx, args, card);
  if (typeof picked === "string") return fail(picked);
  const { leader, base } = picked;
  const deck = deckOf(ctx, args.decklist, deckCards);
  const pool = lockPool(ctx, leader, deck);
  // D51: a Leader cardKey keeps its own icons in every weighting mode, so the cover search never picks another leader.
  const ownIcons = card.type === "Leader" ? card.structured.aspectIcons : undefined;
  const aspects = args.aspects ?? (leader === undefined ? ownIcons : [...leader.card.structured.aspectIcons, ...(base?.structured.aspectIcons ?? [])]);
  const weight = args.weighting === "leader" && leader?.data != null ? leader : undefined;
  // D60 (#149): the leader's own clause is a want source for the deck, so partners that meet it rank with the leader factor.
  // D63 (#154): the clause is read whenever a leader is given, so weighting none still lists the engine rows and only drops the play-share factor.
  const engine = leader === undefined ? null : leaderEngineOf(leader.card);
  // D65 (#156): the leader's own Action is read too, so a card that readies a leader is an engine partner of a leader that has one.
  const action = leader === undefined ? null : leaderActionOf(leader.card);
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
  const engineClause = (hit: EngineHit): string => hit.clause ?? (engine?.clause as string);
  const engineReason = (hit: EngineHit): string =>
    `Leader engine: ${cardLabel((leader as LeaderWeight).card)}'s own clause "${engineClause(hit)}" meets this card: ${hit.how}${hit.partnerText === null ? "" : ` ("${hit.partnerText}")`}.`;
  const ranked = (edges: readonly (PairEdge | null)[], mode: TraitsMode, engineOnly: readonly SynergyCard[] = []) => {
    const rows = [...edges, ...engineOnly.map(() => null)].map((e, i) => {
      const partner = e === null ? engineOnly[i - edges.length] : (ctx.graph.byKey.get(e.a === card.cardKey ? e.b : e.a) as SynergyCard);
      const cover = penaltyFor(ctx, [card, partner], aspects);
      const score = e === null ? ENGINE_LINK_SCORE : edgeScore(e, mode);
      const unweighted = aspects === undefined ? score : Math.round((score / (1 + cover.penalty / 2)) * 1000) / 1000;
      const hit = engineHitOf(engine, partner, action);
      // D65: the staple-share lift is for a partner the leader's lists play; an unplayed one keeps the 0.5 every other row takes.
      const factor =
        weight === undefined ? 1 : hit === null || playedInclusion(weight, partner.cardKey) === null ? leaderFactor(weight, partner.cardKey) : Math.max(leaderFactor(weight, partner.cardKey), engineFactor());
      // D73: the play-share factor can carry a penalty-2 partner over a penalty-0 one of similar score, so a leader-weighted rank divides by 1 + penalty (3 at +2) where the score divides by 1 + penalty / 2 (2 at +2).
      const penalised = weight === undefined || aspects === undefined ? unweighted : r3(score / (1 + cover.penalty));
      // D73: a base that meets the partner's own base-name clause is a positive, so the rank rises by BASE_ENABLED_FACTOR.
      const enabled = baseEnabledOf(partner, base);
      const lifted = weight === undefined ? unweighted : r3(penalised * factor);
      const rank = enabled === null ? lifted : r3(lifted * BASE_ENABLED_FACTOR);
      const lock = baseLockOfAll([partner], base);
      // D66: a partner whose clause needs a named card the subject, leader, base and deck do not supply is locked like a base lock.
      const named = nameLockOfCards([partner], [card, leader?.card, base, ...deck]);
      // D68: a partner that needs the Force or a unit of a trait the subject, leader, base and pool do not supply is locked too.
      const resource = pool === undefined ? NO_RESOURCE_LOCK : resourceLockOfCards([partner], leader?.card, base, [card, ...pool]);
      const locked = lock.unmet || named.length > 0 || resource.needsForce.length > 0 || resource.needsTrait.length > 0;
      // D74: a row whose only link is a generic play trigger, with no engine hit beyond "the leader can play it", ranks after every specific link.
      const generic = e !== null && isGenericPlay(e) && (hit === null || hit.kind === "plays");
      return { e, partner, cover, score, rank, lock, named, resource, locked, hit, enabled, generic };
    });
    return rows.sort((x, y) => Number(x.locked) - Number(y.locked) || Number(x.generic) - Number(y.generic) || y.rank - x.rank || (x.e !== null && y.e !== null ? edgeOrder(x.e, y.e) : cmp(x.partner.cardKey, y.partner.cardKey)));
  };
  const linkRowsOf = (e: PairEdge, mode: TraitsMode) => (mode === "exclude" ? mechanicalRows(e) : e.rows);
  const linkOf = (r: ReturnType<typeof ranked>[number], mode: TraitsMode): string =>
    r.e === null ? `leader-engine: ${(r.hit as EngineHit).kind} ${(r.hit as EngineHit).keyword ?? ""}` : linkRowsOf(r.e, mode).map((x) => `${x.offer} -> ${x.want}`).join("; ");
  const row = ({ e, partner, cover, score, rank, lock, named, resource, hit, enabled }: ReturnType<typeof ranked>[number], mode: TraitsMode): Record<string, unknown> => {
    if (e === null) {
      const found = hit as EngineHit;
      const keyword = (found.keyword ?? "").toLowerCase();
      const out: Record<string, unknown> = {
        ...brief(partner),
        status: CANDIDATE_STATUS,
        partnerIs: found.kind === "repeats-action" ? "enabler" : "payoff",
        linkKind: "leader-engine",
        link:
          found.kind === "repeats-action"
            ? "offers:ready-leader -> leader:action"
            : found.kind === "attack-payoff"
              ? `leader:grant-${keyword} -> wants:extra-attacks`
              : found.kind === "readies-played"
                ? `leader:grant-${keyword} -> offers:ready-played-unit`
              : found.kind === "grants-held-keyword"
                ? `leader:grant-${keyword} -> wants:keyword-${keyword}`
                : `leader:grant-${keyword} -> wants:friendly-unit-with-${keyword}`,
        reason: engineReason(found),
        score,
        aspectPair: cover.aspectPair,
        penalty: cover.penalty,
        rank,
        ...(weight === undefined ? {} : { leaderInclusion: inclusionOf(weight, partner.cardKey) }),
        ...(lock.names.length === 0 ? {} : { baseLocked: lock.names.join(", ") }),
        ...(named.length === 0 ? {} : { nameLocked: named.join(", ") }),
        ...resourceFields(resource),
        ...enabledFields(enabled),
      };
      // D68: the partner's side quotes its clause with the cost and gate it hangs on.
      const partnerSpan = (text: string | null): string | null => (text === null ? null : clip(evidenceSpan(partner, text)));
      if (args.evidence)
        out.evidence = [
          found.kind === "repeats-action"
            ? { offer: partnerSpan(`text: ${found.partnerText}`), want: engineClause(found) }
            : { offer: `text: ${engineClause(found)}`, want: partnerSpan(found.partnerText) },
        ];
      if (args.withAlternatives) out.alternatives = [];
      return out;
    }
    const linkRows = linkRowsOf(e, mode);
    const out: Record<string, unknown> = {
      ...brief(partner),
      status: CANDIDATE_STATUS,
      partnerIs: e.a === card.cardKey ? "payoff" : "enabler",
      linkKind: e.linkKind,
      link: linkRows.map((r) => `${r.offer} -> ${r.want}`).join("; "),
      reason: `${reasonOfHit(ctx.graph, e, primaryRows(e)[0])}${hit === null ? "" : ` ${engineReason(hit)}`}`,
      score,
      aspectPair: cover.aspectPair,
      penalty: cover.penalty,
      rank,
      ...(weight === undefined ? {} : { leaderInclusion: inclusionOf(weight, partner.cardKey) }),
      ...(lock.names.length === 0 ? {} : { baseLocked: lock.names.join(", ") }),
      ...(named.length === 0 ? {} : { nameLocked: named.join(", ") }),
      ...resourceFields(resource),
      ...enabledFields(enabled),
    };
    if (args.evidence) out.evidence = pairEvidence(ctx, e, linkRows);
    return out;
  };
  // A partner the leader's clause pays off but the graph does not link to the leader is added as a leader-engine row, for a leader subject only.
  // A kind that is a payoff (the partner uses what the leader gives) is left out of the enablers direction, and the repeated-Action kind (the partner feeds the leader) out of payoffs.
  // D67: since #155 the leader's own grant is also a mechanical edge (offers:grant-ambush -> wants:keyword-ambush). When that edge is all that
  // links the partner and the engine reads the same partner, the partner is one leader-engine row that quotes both clauses, not a graph row.
  const duplicatesEngine = (e: PairEdge): boolean => {
    if (engine === null || leader === undefined || card.cardKey !== leader.card.cardKey || e.a !== card.cardKey) return false;
    const rows = mechanicalRows(e);
    const kind = engineHitOf(engine, ctx.graph.byKey.get(e.b) as SynergyCard, action)?.kind;
    // D74: the leader's paid play into a card that readies the played unit is the engine itself, so the generic play-trigger row gives way to it.
    if (kind === "readies-played") return rows.length > 0 && rows.every((r) => GENERIC_PLAY_ROWS.has(r.row));
    if (rows.length === 0 || !rows.every((r) => engine.grantsKeywords.some((k) => r.offer === `offers:grant-${k.toLowerCase()}`))) return false;
    return kind === "pays-off" || kind === "grants-held-keyword";
  };
  const mainEdges = touching.filter((e) => (args.traits === "include" || !e.traitOnly) && !duplicatesEngine(e));
  const edgePartners = new Set(mainEdges.map((e) => (e.a === card.cardKey ? e.b : e.a)));
  const engineOnly =
    (engine === null && action === null) || leader === undefined || card.cardKey !== leader.card.cardKey
      ? []
      : ctx.cards.filter((c) => {
          if (edgePartners.has(c.cardKey) || c.cardKey === card.cardKey) return false;
          if (!args.includeLeaders && !DECK_CARD_TYPES.has(c.type)) return false;
          if (args.maxCost !== undefined && (c.structured.cost === null || c.structured.cost > args.maxCost)) return false;
          const kind = engineHitOf(engine, c, action)?.kind;
          if (kind === undefined || kind === "plays") return false;
          return kind === "repeats-action" ? args.direction !== "payoffs" : args.direction !== "enablers";
        });
  const engineKeys = new Set(engineOnly.map((c) => c.cardKey));
  const rows = ranked(mainEdges, args.traits, engineOnly);
  const capped = deferRepeatedLinks(rows, (r) => linkOf(r, args.traits), args.perLink);
  const { deferred } = capped;
  // D63 (#154): the perLink cap moves repeated links behind first ones, so the lock demotion of the sort is applied again after it (every lock since D68).
  const ordered = [
    ...capped.ordered.filter((r) => !r.locked && !r.generic),
    ...capped.ordered.filter((r) => !r.locked && r.generic),
    ...capped.ordered.filter((r) => r.locked),
  ];
  const tribal = args.traits === "bonus" ? ranked(touching.filter((e) => e.traitOnly && !engineKeys.has(e.a === card.cardKey ? e.b : e.a)), "bonus") : [];
  // D73: the rank note states the penalty divisor and the base-enabled factor whenever they apply.
  const rankParts = [
    ...(weight === undefined || aspects === undefined ? [] : ["leader-weighted rank = score / (1 + penalty) x (0.5 + leaderInclusion, 0.5 when unplayed), so a penalty-2 partner is divided by 3 where the plain score divides by 2"]),
    ...(rows.some((r) => r.enabled !== null) ? [`a partner marked baseEnabled (its own clause names a base location the given base meets) has its rank multiplied by ${BASE_ENABLED_FACTOR}`] : []),
  ];
  const shown = ordered.slice(0, args.limit).map((r) => {
    const { e, partner } = r;
    const out = row(r, args.traits);
    if (e !== null && args.withAlternatives) {
      const tags = slotRoles([partner.cardKey], [e])[0];
      const common = commonMembers(ctx.fungibility, partner.cardKey, [...tags.offers, ...tags.wants]);
      out.alternatives = groupText(
        substitutesFor(ctx.fungibility, deckMembers(ctx, common.members, args.includeLeaders), partner.cardKey, {
          preferAspects: aspects,
          perGroup: 2,
          maxCost: args.maxCost,
          keep: slotKeep(ctx, partner.cardKey, [e], [card.cardKey, partner.cardKey], inPool),
        }),
        4,
      );
    }
    return out;
  });
  return ok({
    card: brief(card),
    ...(leader === undefined
      ? {}
      : { leader: { ...leaderBlock(leader, "partner", base, args.aspects === undefined, { ...picked, weighted: args.weighting === "leader" }), ...(engine === null && action === null ? {} : { engine: { ...(engine === null ? {} : { clause: engine.clause, playsUnitMaxPower: engine.playsUnitMaxPower, grantsKeywords: engine.grantsKeywords.join(", ") }), ...(action === null ? {} : { action }) } }) } }),
    source: args.source,
    traits: args.traits,
    partnerFilter: partnerFilterNote(args.includeLeaders),
    total: rows.length,
    shown: shown.length,
    capped: deferred,
    ...(rankParts.length === 0 ? {} : { rankNote: `${rankParts.join("; ")} (D73).` }),
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

/** A card's play-calibrated percentile within its type (0..100), the standing a mixed trio's new card takes when no leader weights it (D74). */
export type StandingScores = ReadonlyMap<string, { percentile?: { playCalibrated: number | null } }>;

export function findTrios(
  ctx: SynergyContext,
  input: unknown,
  inPool?: (cardKey: string) => boolean,
  deckCards?: readonly SynergyCard[],
  scores: StandingScores = new Map(),
): ToolResult {
  const args = z.object(findTriosShape).parse(input);
  let subject: SynergyCard | undefined;
  if (args.cardKey !== undefined) {
    const resolved = resolve(ctx, [args.cardKey]);
    if (typeof resolved === "string") return fail(resolved);
    subject = resolved[0];
  }
  const picked = leaderAndBase(ctx, { ...args, aspects: undefined }, subject);
  if (typeof picked === "string") return fail(picked);
  const { leader, base } = picked;
  const deck = deckOf(ctx, args.decklist, deckCards);
  // D71: a decklist alone (no leader) is the pool the trait lock reads, so the trio search can tell what the deck lacks.
  const pool = lockPool(ctx, leader, deck) ?? (deck.length > 0 ? deck : undefined);
  const deckKeys = new Set(deck.map((c) => c.cardKey));
  const weight = args.weighting === "leader" && leader?.data != null ? leader : undefined;
  const leaderAspects = args.leaderAspects ?? leader?.card.structured.aspectIcons ?? (subject?.type === "Leader" ? subject.structured.aspectIcons : undefined);
  const baseAspects = args.baseAspects ?? base?.structured.aspectIcons;
  const fixed = leaderAspects !== undefined || baseAspects !== undefined;
  const minPlayed = args.minPlayed ?? (weight === undefined ? 0 : DEFAULT_MIN_PLAYED);
  if (minPlayed > 0 && weight === undefined) {
    return fail("minPlayed counts members the leader's tournament decklists play: give a leader with decklist data and weighting: leader, or minPlayed: 0");
  }
  const played = (keys: readonly string[]): number => (weight === undefined ? 0 : keys.filter((k) => playedInclusion(weight, k) !== null).length);
  const searchWith = (onlyDeck: boolean) =>
    ctx.trios({
      combos: fixed ? fixedCombo(leaderAspects, baseAspects) : undefined,
      // The leader weight can lift a trio from below the unweighted cut, so the weighted ranking draws from a deeper pool.
      ...(weight === undefined ? {} : { keep: DEFAULT_TRIO_KEEP * LEADER_TRIO_POOL }),
      traits: args.traits,
      ...(args.includeLeaders ? { memberTypes: new Set([...DECK_CARD_TYPES, "Leader", "Base"]) } : {}),
      accept: (keys, cost) =>
        cost <= args.maxTotalCost &&
        (args.cardKey === undefined || keys.includes(args.cardKey)) &&
        (minPlayed === 0 || played(keys) >= minPlayed) &&
        (!onlyDeck || keys.some((k) => deckKeys.has(k))),
    });
  const search = searchWith(false);
  // D71: the unrestricted pool keeps the best trios of the whole graph, none of which need hold a deck card, so a decklist adds a second pool of trios that hold one.
  const anchored = deckKeys.size === 0 ? undefined : searchWith(true);
  const shapes = args.shape === undefined ? TRIO_SHAPES : [args.shape];
  const poolOf = (shape: TrioShape): TrioRecord[] => {
    const seen = new Set<string>();
    return [...search.trios[shape], ...(anchored?.trios[shape] ?? [])].filter((t) => {
      const id = `${t.cardA}|${t.cardB}|${t.cardC}`;
      return seen.has(id) ? false : (seen.add(id), true);
    });
  };
  // The geometric mean of the member factors, so one played card cannot carry two unplayed ones (D46).
  const rankOf = (t: TrioRecord): number =>
    weight === undefined ? t.score : r3(t.score * Math.cbrt([t.cardA, t.cardB, t.cardC].reduce((f, k) => f * leaderFactor(weight, k), 1)));
  const trioLock = (t: TrioRecord) => {
    const members = [t.cardA, t.cardB, t.cardC].map((k) => ctx.graph.byKey.get(k) as SynergyCard);
    const lock = baseLockOfAll(members, base);
    // D66: a member's clause that needs a named card no member, the leader, the base or the deck supplies locks the trio.
    const named = nameLockOfCards(members, [leader?.card, base, ...deck]);
    // D68: so does a member that needs the Force or a unit of a trait no member, the leader, the base or the pool supplies.
    const resource = pool === undefined ? NO_RESOURCE_LOCK : resourceLockOfCards(members, leader?.card, base, pool);
    // D71: a Pilot member needs a Vehicle host; judged only against a decklist.
    const host = deckKeys.size === 0 ? [] : hostNeedOfCards(members, leader?.card, deck);
    return { ...lock, named, resource, host, unmet: lock.unmet || named.length > 0 || resource.needsForce.length > 0 || resource.needsTrait.length > 0 || host.length > 0 };
  };
  const byRank = weight === undefined ? trioOrder : (x: TrioRecord, y: TrioRecord) => rankOf(y) - rankOf(x) || trioOrder(x, y);
  // D51: a trio holding a card that needs a base the deck does not have follows the trios that do not.
  const lockOfTrio = new Map<TrioRecord, ReturnType<typeof trioLock>>();
  const lockFor = (t: TrioRecord): ReturnType<typeof trioLock> => {
    if (!lockOfTrio.has(t)) lockOfTrio.set(t, trioLock(t));
    return lockOfTrio.get(t) as ReturnType<typeof trioLock>;
  };
  const unmet = (t: TrioRecord): number => Number(lockFor(t).unmet);
  const inDeckCount = (t: TrioRecord): number => [t.cardA, t.cardB, t.cardC].filter((k) => deckKeys.has(k)).length;
  // D73 (extends D71): with a decklist, among the trios no lock demotes, a trio that holds a deck card and a card outside the deck (the idea) comes
  // first, then a trio of three deck cards (the build restated), then one with no deck card; inside a tier a weak closing link follows the mechanical ones.
  const tierOf = (t: TrioRecord): number => (deckKeys.size === 0 ? 0 : inDeckCount(t) === 3 ? 1 : inDeckCount(t) === 0 ? 2 : 0);
  const weakOf = new Map<TrioRecord, number>();
  const weakClose = (t: TrioRecord): number => {
    if (deckKeys.size === 0) return 0;
    if (!weakOf.has(t)) weakOf.set(t, Number(hasWeakClosingLink(ctx.graph, t)));
    return weakOf.get(t) as number;
  };
  // D74: inside the idea tier the card from outside the deck is what the trio proposes, so its own standing weighs the rank, as in
  // find_pairings: (0.5 + its play share in the leader's lists, 0.5 under the 2% floor) / (1 + its aspect penalty). With no leader the
  // share is replaced by its play-calibrated percentile within its type / 100 (0.5 + 0 when unscored), the only standing left.
  const penaltyAspects = fixed ? [...(leaderAspects ?? []), ...(baseAspects ?? [])] : undefined;
  const standingOf = (k: string): number => {
    const share = weight === undefined ? (scores.get(k)?.percentile?.playCalibrated ?? 0) / 100 : (playedInclusion(weight, k) ?? 0);
    const penalty = penaltyAspects === undefined ? 0 : coverPenalty([ctx.graph.byKey.get(k) as SynergyCard], penaltyAspects, []).penalty;
    return (0.5 + share) / (1 + penalty);
  };
  const newCardWeight = (t: TrioRecord): number | null => {
    if (tierOf(t) !== 0 || deckKeys.size === 0) return null;
    const outside = [t.cardA, t.cardB, t.cardC].filter((k) => !deckKeys.has(k));
    return r3(Math.pow(outside.reduce((f, k) => f * standingOf(k), 1), 1 / outside.length));
  };
  const weightOf = new Map<TrioRecord, number | null>();
  const weightFor = (t: TrioRecord): number | null => {
    if (!weightOf.has(t)) weightOf.set(t, newCardWeight(t));
    return weightOf.get(t) as number | null;
  };
  const ideaRank = (t: TrioRecord): number => (weight === undefined ? t.score : rankOf(t)) * (weightFor(t) ?? 1);
  const inIdeaTier = (x: TrioRecord, y: TrioRecord): number => (weightFor(x) === null || weightFor(y) === null ? 0 : ideaRank(y) - ideaRank(x));
  // D76 (#162): a substitutes trio (score 0, D64) follows every scored trio whatever its tier or locks.
  const zero = (t: TrioRecord): number => Number(t.score === 0);
  const ranked: TrioRecord[] = shapes
    .flatMap(poolOf)
    .sort((x, y) => zero(x) - zero(y) || unmet(x) - unmet(y) || tierOf(x) - tierOf(y) || weakClose(x) - weakClose(y) || inDeckCount(y) - inDeckCount(x) || inIdeaTier(x, y) || byRank(x, y));
  // D49: a trio sharing two members with a better-ranked one is that trio with another third card, listed as its variant.
  const kept: { t: TrioRecord; keys: string[]; variants: string[] }[] = [];
  for (const t of ranked) {
    const keys = [t.cardA, t.cardB, t.cardC];
    const host = kept.find((k) => k.keys.filter((x) => keys.includes(x)).length >= 2);
    if (host === undefined) {
      kept.push({ t, keys, variants: [] });
      continue;
    }
    const third = keys.find((x) => !host.keys.includes(x));
    // A substitutes trio's third card does not do the host's job, so it is no variant.
    if (t.score === 0) continue;
    if (third !== undefined && !host.variants.includes(third) && host.variants.length < MAX_TRIO_VARIANTS) host.variants.push(third);
  }
  const shown = kept.slice(0, args.limit);
  const variantOf = (k: string, hostKeys: readonly string[]): Record<string, unknown> => {
    const c = ctx.graph.byKey.get(k) as SynergyCard;
    const lock = baseLockOfAll([c], base).names;
    const hosts = hostKeys.map((h) => ctx.graph.byKey.get(h) as SynergyCard);
    const named = nameLockOfCards([c], [...hosts, leader?.card, base, ...deck]);
    const resource = pool === undefined ? NO_RESOURCE_LOCK : resourceLockOfCards([c], leader?.card, base, [...hosts, ...pool]);
    return {
      title: cardLabel(c),
      cost: c.structured.cost,
      ...(weight === undefined ? {} : { leaderInclusion: inclusionOf(weight, k) }),
      ...(lock.length === 0 ? {} : { baseLocked: lock.join(", ") }),
      ...(named.length === 0 ? {} : { nameLocked: named.join(", ") }),
      ...resourceFields(resource),
    };
  };
  const prefer = fixed ? [...(leaderAspects ?? []), ...(baseAspects ?? [])] : undefined;
  const trios = shown.map(({ t, keys, variants }) => {
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
      ...(lockFor(t).names.length === 0 ? {} : { baseLocked: lockFor(t).names.join(", ") }),
      ...(lockFor(t).named.length === 0 ? {} : { nameLocked: lockFor(t).named.join(", ") }),
      ...resourceFields(lockFor(t).resource),
      ...(deckKeys.size === 0 ? {} : { deckMembers: inDeckCount(t) }),
      ...(weightFor(t) === null ? {} : { newCardWeight: weightFor(t) }),
      ...(lockFor(t).host.length === 0 ? {} : { needsHost: lockFor(t).host.join(", ") }),
      ...(variants.length === 0 ? {} : { variants: variants.map((v) => variantOf(v, keys)) }),
    };
    if (args.evidence) {
      out.evidence = trioLinks(ctx.graph, t).flatMap((e) =>
        sourcedEvidenceOf(e, ctx.graph.byKey, primaryRows(e).slice(0, 1), ctx.curated ?? NO_CURATED).map((ev) => ({
          link: `${cardLabel(ctx.graph.byKey.get(e.a) as SynergyCard)} > ${cardLabel(ctx.graph.byKey.get(e.b) as SynergyCard)}`,
          ...ev,
        })),
      );
    }
    if (args.withAlternatives) {
      const links = trioLinks(ctx.graph, t);
      const roles = slotRoles(keys, links);
      out.alternatives = roles.map((r, i) => {
        const common = commonMembers(ctx.fungibility, r.cardKey, [...r.offers, ...r.wants]);
        return {
          slot: "ABC"[i],
          roles: [...r.offers, ...r.wants].join(", "),
          substitutes: groupText(
            substitutesFor(ctx.fungibility, deckMembers(ctx, common.members, args.includeLeaders), r.cardKey, {
              preferAspects: prefer,
              perGroup: 2,
              keep: slotKeep(ctx, r.cardKey, links, keys, inPool),
            }),
            4,
          ),
        };
      });
    }
    return out;
  });
  return ok({
    counts: { chain: search.counts.chain, convergent: search.counts.convergent, loop: search.counts.loop },
    maxTotalCost: args.maxTotalCost,
    ...(leader === undefined ? {} : { leader: playedNote(leaderBlock(leader, "trio", base, args.leaderAspects === undefined && args.baseAspects === undefined, { ...picked, weighted: args.weighting === "leader" }), weight === undefined ? undefined : minPlayed) }),
    traits: args.traits,
    partnerFilter: partnerFilterNote(args.includeLeaders),
    shown: trios.length,
    trios,
  });
}

/** The leader block of a weighted trio search names minPlayed and states it in the note. */
function playedNote(block: Record<string, unknown>, minPlayed: number | undefined): Record<string, unknown> {
  if (minPlayed === undefined) return block;
  const rule =
    minPlayed === 0
      ? "minPlayed 0: a trio may hold members the leader's decks do not play."
      : `minPlayed ${minPlayed}: every trio has at least ${minPlayed} member${minPlayed === 1 ? "" : "s"} with leaderInclusion of ${LEADER_INCLUSION_FLOOR} or more.`;
  return { ...block, minPlayed, note: `${String(block.note)} ${rule}` };
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
      .map((t) => ({ card: cardLabel(c), tag: t.tag, why: clip(evidenceSpan(c, t.why)) }));
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
      rows: e.rows.map((r) => ({ row: r.row, offer: r.offer, want: r.want, weight: r.weight, reason: reasonOfHit(ctx.graph, e, r) })),
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
function scoresOf(store: CardStore): ReadonlyMap<string, { playCalibrated: number | null; percentile: { playCalibrated: number | null } }> {
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

/** Names to cards at the tool boundary (D55, #143): candidates and decklist lines are cardKeys, SET_NNN ids or exact titles. */
function resolveNames(store: CardStore, ctx: SynergyContext, input: unknown): FungibleResolved {
  const names = z
    .looseObject({ candidates: fungibleSubstitutesShape.candidates, exclude: fungibleSubstitutesShape.exclude, decklist: fungibleSubstitutesShape.decklist })
    .parse(input);
  const candidates: string[] = [];
  const unresolvedCandidates: { card: string; reason: string; detail: string }[] = [];
  for (const ref of names.candidates ?? []) {
    const hit = resolveRef(store, ref, "main");
    if (hit.ok) candidates.push(hit.row.cardKey);
    else unresolvedCandidates.push({ card: ref, reason: hit.reason, detail: hit.detail });
  }
  const exclude: string[] = [];
  const unresolvedExclude: { card: string; reason: string; detail: string }[] = [];
  for (const ref of names.exclude ?? []) {
    const hit = resolveRef(store, ref, "main");
    if (hit.ok) exclude.push(hit.row.cardKey);
    else unresolvedExclude.push({ card: ref, reason: hit.reason, detail: hit.detail });
  }
  const deckCards: SynergyCard[] = [];
  for (const line of names.decklist ?? []) {
    const hit = resolveRef(store, line.card, "main");
    const syn = hit.ok ? ctx.graph.byKey.get(hit.row.cardKey) : undefined;
    if (syn !== undefined) deckCards.push(syn);
  }
  return { deckKeys: new Set(deckCards.map((c) => c.cardKey)), deckCards, candidates, unresolvedCandidates, exclude, unresolvedExclude };
}

export const SYNERGY_TOOLS = {
  fungible_substitutes: {
    title: "Fungible substitutes",
    description:
      "Cards that fill the same role as a card (same offers/wants tag, timing, magnitude band, cost band and type), grouped by aspect. A deck picks the substitute its leader and base already cover. Roles come from the card's feature tags; trait tags are not roles. When the card's class has no other member, each role entry retries with the cost band relaxed to the adjacent bands, then with magnitude ignored as well (same tag, type, timing, target and arena kept), and reports it as widened (\"cost band\" or \"cost band + magnitude\", else null); those substitutes carry match: widened. A unit also holds one keyword:<Keyword> role per printed keyword (same arena, cost band and power-plus-HP band), listed first when the unit has no offers/wants tag or only a constant \"while ...\" condition, so a 3-cost Ground Sentinel finds other Ground Sentinels; its widening drops the stats band in the second step (\"cost band + stats band\"). Substitutes are Premier-pool cards only (a Premier-legal printing). Inside an aspect group substitutes sort by play-calibrated score; give leader (cardKey or exact title) to sort the ones that leader's tournament decklists play first, with leaderInclusion (null when unplayed) on each. Each substitute carries the clause text behind its role; they are candidates, so check that clause says the same thing as the slot card's (evidence: false turns it off). Give decklist to leave out cards already in the deck. Give candidates (cardKeys or SET_NNN ids) to weigh named cards whatever the cost band: each is listed under candidates with its score, the aspect penalty it pays and outsideBand: true when no role lists it; give base with leader (or preferAspects) and the card's own penalty and each substitute's penalty are shown. A card whose job the deck needs (readying a leader; giving a keyword the leader or the deck supplies, such as Ambush or Raid) keeps that job: only roles in that family are listed, each substitute names the family it keeps in keepsRole, and roleKept.none says so when no card in the pool does it. Role classes come in order of how much of the card's job they cover (coverage: the share of the card's offers and wants that the class's best unlocked card also holds) and maxClasses (default 8) caps them; classesCut and the note say how many were left out. With leader and base, a card whose clause needs a base location or a unit aspect that they and the decklist do not supply carries baseLocked or needsUnitAspect (D59) and ranks after the unlocked cards of its aspect group. The answer has two lists (D69). partners holds the cards with a pair edge to the original (it feeds the original, or the original feeds it), each with feedsOriginal or fedByOriginal and the edge's row; they work beside the original and are not replacements, a named candidate that is a partner is always listed, and maxPartners (default 10) caps the rest (partnersTotal, partnersCut). standIns holds the cards that do the original's job without a pair edge to it, never a partner; the role classes (roles) and their coverage count stand-ins only. With candidates and a decklist the answer adds recommendation: for the original and each candidate its aspect penalty under the base, its playShare in the leader's lists (leaderInclusion, or the word unplayed under the 2% floor) and fedByDeck, how many cards already in the deck have a pair edge into it, plus one sentence (verdict) naming which to keep, by the rule it quotes: a card that at least 4 more deck cards feed than the other (a payoff the deck feeds many times over earns a 2-resource penalty, a small gap does not), then lower penalty, then higher play share, then the card already in the deck. A deck card counts as feeding a card only through the job compared (D71): when a candidate feeds the original's wants, only rows into the same wants count (every wants:keyword-<k> row is one job; feederJob names it), so a card that readies a unit no longer feeds a keyword payoff; with no partner candidate every mechanical edge counts as before. When the rule keeps the original over a candidate that is its partner, cutForCandidate names the deck card to cut for it, with its penalty, playShare and deckLinks: the highest aspect penalty under the base, then the lowest play share in the leader's lists, then the fewest pair edges to the rest of the deck, never a card with a pair edge into the original or the candidate, and the verdict says so. exclude (cardKeys, SET_NNN ids or exact titles) drops cards the builder has rejected. A keyword class (a printed keyword, a keyword holder, a keyword the card gives itself) also lists the cards of the same keyword, type, arena and cost band that print it or give it to themselves with no condition (D74): a self-gainer's class takes both, a printer's class takes the unconditional self-gainers; each such card carries keywordJob (the role it holds, for example keyword:Saboteur) and the class keywordJobAdded; a card that copies the keyword from another unit (Oppo Rancisis) is not joined.",
    shape: fungibleSubstitutesShape,
    handler: (store: CardStore, input: unknown): ToolResult =>
      withContext(store, (ctx) => fungibleSubstitutes(ctx, input, scoresOf(store), inPremierPool(store), resolveNames(store, ctx, input))),
  },
  find_pairings: {
    title: "Find pairings",
    description:
      "Partners for a card from the offers-to-wants pair graph: enablers that feed it and payoffs it feeds, each with the reason, its linkKind (mechanical, trait+mechanical or trait-only), a score (link strength times non-obviousness), the aspect penalty, fungible alternatives by aspect (only Premier-pool cards that still link with the card through the same row) and the clause text of each card that produced the offer and the want (status: candidate). By default (traits: bonus) only mechanical links rank; a trait the pair also shares is a small bonus, and pairs that only share a trait (obvious tribal links) come in a separate tribal list capped by tribalLimit (default 5). traits: exclude ignores traits; traits: include ranks trait-only pairs with the rest. Rows list at most perLink (default 3) per distinct link before rows that repeat a link, so the first page shows varied reasons; the deferred rows follow in rank order (capped counts them; perLink 100 turns the cap off). Leader and Base partners are left out because they cannot be one of a deck's 50 cards (includeLeaders: true lists them; partnerFilter states which applied). Give leader (cardKey or exact title) to weight the rank by the leader's tournament decklists: each partner carries leaderInclusion (null when unplayed), played partners rise, unplayed ones stay listed, aspects default to the leader's icons, and the leader block names the population and window. Give base too (a Base card, cardKey or exact title) and aspects default to the leader's and the base's icons together and the leader block names the base; with a leader alone the penalty is measured against the leader's icons only and the leader block says so. A Leader cardKey with no leader argument stands in as the leader, and its most-played tournament base as the base unless base or aspects is given (a supplied aspect set is never replaced by the leader's top base); the leader block says defaulted: true, and weighting: none restores the unweighted answer. The reason names the side the offer lands on (enemy unit, your own, either) where the rule reads differently by side. With a leader (D60), the leader's own clause is a want source: when it plays a unit of limited power or gives a keyword (The Warrior: a unit with 3 or less power, with Ambush), partners that meet it and that the leader's decks play (2% or more) rank at least as if those decks played them 60% of the time, an unplayed one takes the plain x 0.5 (D65), and the reason quotes the leader clause; for a leader subject, a card whose text keys on a friendly unit with the granted keyword (Boba Fett, Family Found), a unit of power within the limit that gives itself an attack keyword while Ambush gives it an attack on entry (Chewbacca, Resourceful Wookiee; The Chieftain), and a card that readies a leader when the leader has an Action that exhausts it (Darth Traya) are listed as leader-engine rows (D65), each quoting the leader clause it rests on. Given a base, or aspects that add one base icon, the leader's decklists are narrowed to the lists with that base when at least 10 remain, else all are used and the leader block says so (populationNote). A partner whose clause names a base the given base does not meet (baseLocked) ranks after every unlocked partner, also past the perLink cap. The leader-engine rows appear whenever a leader is given, in every weighting mode; weighting: none only drops the play-share factor. Evidence for a curated tag quotes the curated clause, and source names the curated side. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it. With a leader, a partner whose clause or cost needs the Force (use the Force, while the Force is with you) carries needsForce unless the subject, leader, base or deck makes the Force, and one whose clause needs a unit of a trait (another Official unit) carries needsTrait unless the subject, leader or a deck unit has it; the deck is decklist when given, else the cards the leader's lists play (2% or more); both rank after every unlocked partner (D68). Evidence quotes the cited clause with the trigger, cost and the clauses it hangs on (use the Force, If you do), clipped to 160 characters. In a leader-weighted rank the aspect penalty divides the score by 1 + penalty (3 at +2) before the play-share factor, so a penalty-2 partner does not outrank a penalty-0 one of similar score (D73). A partner whose own clause names a base location that the given base meets carries baseEnabled: <Location> and baseEnabledClause (the clause quoted), and its rank is multiplied by 1.5 (D73). A card that readies the unit you play (\"When you play a unit with 3 or less power: ... ready that unit\") is a leader-engine row of a leader that plays such a unit with Ambush, quoting both clauses: the unit attacks on entry, then attacks again; a pairing whose offer readies a unit as it is played says so instead of the Action-reuse reason; a row whose only link is a generic play trigger (a unit put into play still counts as played) and that meets the leader's clause only by being playable ranks after every specific link, in every weighting mode; evidence quotes a granted ability inside the clause that grants it (D74).",
    shape: findPairingsShape,
    handler: (store: CardStore, input: unknown): ToolResult =>
      withContext(store, (ctx) => findPairings(ctx, input, inPremierPool(store), resolveNames(store, ctx, input).deckCards)),
  },
  find_trios: {
    title: "Find trios",
    description:
      "Three-card combos built from the pair graph: chains A->B->C, two enablers into one payoff, and loops. Built from mechanical links by default; a trait the linked cards share is a small bonus, and traits: include admits trait-only links but every trio keeps at least one mechanical link. Ranked with a bonus for low total cost (default cap 9) and aspect cover; reports total cost, the cheapest leader+base aspect pair, its penalty (+2 resources per uncovered icon) and fungible alternatives per slot (only Premier-pool cards that keep the slot's links with the other members, so a substitute never bypasses a trait restriction the slot card met), with the clause text behind each link (status: candidate). Trios hold only cards a deck's 50 can hold; includeLeaders: true admits Leader and Base cards (partnerFilter states which applied). Give leader (cardKey or exact title) to weight each trio by the leader's tournament decklists: every member carries leaderInclusion (null when unplayed), rank is the score times the geometric mean (cube root of the product) of the member factors so one played card cannot carry two unplayed ones, leaderAspects default to the leader's icons, and the leader block names the population and window. Give base too (a Base card, cardKey or exact title) and baseAspects default to its icons and the leader block names the base; with a leader alone the base is not fixed and the leader block says so. A Leader cardKey with no leader argument defaults the leader (and its most-played tournament base) the same way, with defaulted: true in the leader block; weighting: none turns that off. With a leader-weighted rank, minPlayed (default 2) keeps only trios with at least that many members the leader's decks play. A trio sharing two members with a better-ranked one is folded into it, and its third card is listed under variants. A loop whose single-target outlet would have to defeat both the token it is fed and the unit an upgrade sits on is not listed as a loop. A trio never spends a single-target \"defeat a unit\" on its own unit as a sacrifice outlet (a sweep or \"any number of\" still counts), a chain whose single-target outlet would defeat both the token it is fed and the unit it pays off is not listed, a token made only after a friendly unit was defeated (Koska Reeves) needs another member that defeats one first, and a substitutes trio (score 0) follows every scored trio and is never another trio's variant (D76). Evidence for a curated tag quotes the curated clause, and source names the curated side. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it. With a leader, a trio whose member needs the Force or a unit of a trait that no member, the leader, the base or the deck supplies carries needsForce or needsTrait and follows the unlocked trios; the deck is decklist when given, else the cards the leader's lists play (2% or more) (D68). With a decklist (D71) the search adds a second pool of trios that hold a deck card, so the plain pool's cut cannot drop them; among trios no lock demotes (D73), a trio that holds a deck card and a card outside the deck (the idea) comes first, then a trio of three deck cards (the build restated), then one with no deck card, and inside a tier a trio whose link into the payoff (every link of a loop) rests on ramp-threshold or bounce-replay rows alone follows the ones with a mechanical payoff, then more deck members (deckMembers) before fewer; a decklist alone, with no leader, is the deck the Force and trait locks read; and a trio with a Pilot (printed Piloting, offering offers:upgrade-to-attach) and no Vehicle unit among the leader, the deck and the other members carries needsHost: Vehicle and follows the unlocked trios. Inside the idea tier the card from outside the deck weighs the order by its own standing (D74): (0.5 + its play share in the leader's lists, 0.5 under the 2% floor) / (1 + its aspect penalty), or with no leader (0.5 + its play-calibrated percentile within its type / 100) / (1 + penalty); newCardWeight shows the weight (the geometric mean when two cards are new). Members joined by an attach link share one unit, so a trio is not built when no single legal host meets every attach restriction in it (Piloting a Vehicle, \"Attach to a Force unit\", a Fortify upgrade) or when an upgrade that removes its host's abilities sits on the member whose upgrade want is one of them.",
    shape: findTriosShape,
    handler: (store: CardStore, input: unknown): ToolResult =>
      withContext(store, (ctx) => findTrios(ctx, input, inPremierPool(store), resolveNames(store, ctx, input).deckCards, scoresOf(store))),
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
