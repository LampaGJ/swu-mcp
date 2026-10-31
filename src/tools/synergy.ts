import { z } from "zod";
import { packageDirOf, type CardStore } from "../data.js";
import { selectLeaderPopulation, type LeaderSelection } from "../meta/leader-split.js";
import type { LeaderCardsEntry, LeaderCardRow } from "../meta/schema.js";
import { CANDIDATE_STATUS, clip, evidenceSpan, sourcedEvidenceOf, tagEvidence } from "../synergy/evidence.js";
import { comboLabel, coverPenalty, rankCovers, type CoverCombo } from "../synergy/cover.js";
import { engineHitOf, leaderActionOf, leaderEngineOf, roleKeepOf, suppliedKeywords, type EngineHit } from "../synergy/leader-engine.js";
import { loadSynergyContext, type SynergyContext } from "../synergy/context.js";
import { clauseLock, isLocked, lockFields, lockSupply, NO_LOCK, targetTraitOfClause, traitGateOfClause, type ClauseLock } from "../synergy/clause-lock.js";
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
import { hostNeedOfCards, lockedTagsOf, nameLockOfCards, resourceLockOfCards, resourceSupply, type LockSupply } from "../synergy/clause-lock.js";
import { baseEnabledOf, baseLockOfAll, baseMeets, clauseTextsOf, enabledFields, namedBaseOfClause } from "../synergy/locks.js";
import { compareCodePoints } from "../swu/canonical.js";
import { reasonOfHit } from "../synergy/reasons.js";
import { TRAITS_MODES, TRIO_SHAPES, type PairEdge, type PairRowHit, type SynergyCard, type TraitsMode, type TrioRecord, type TrioShape } from "../synergy/schema.js";
import { GENERIC_TRIGGER_WANTS, hasWeakClosingLink, slotRoles, trioLinks } from "../synergy/slots.js";
import { wantSaturates, wantScales } from "../synergy/qualifiers.js";
import { DEFAULT_TRIO_KEEP, TRIO_MEMBER_TYPES, trioOrder } from "../synergy/trios.js";
import type { ToolResult } from "../tools.js";
import { ok, fail } from "./common.js";
import { readPenaltyRemovers, type RemovalCard } from "./penalty-removal.js";
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

/** D85 (#167): a keyword link is redundant when this many cards of the deck (or the leader) already give the wanting card that keyword. */
const REDUNDANT_KEYWORD_SUPPLIERS = 3;
/** D85 (#167): the share of its weight a redundant keyword row keeps, in a pairing and in a trio. */
export const REDUNDANT_KEYWORD_FACTOR = 0.5;
const REDUNDANT_KEYWORD_NOTE = `redundantKeyword: a row of the link gives the wanting card a keyword that ${REDUNDANT_KEYWORD_SUPPLIERS} or more other cards of the deck or the leader already give it; each such row counts ${REDUNDANT_KEYWORD_FACTOR} of its share, so the link's score is multiplied by redundantFactor = 1 - ${1 - REDUNDANT_KEYWORD_FACTOR} x (redundant rows / mechanical rows) (D85). A want whose clause counts or doubles what feeds it ("for each", "doubled": Marchion Ro) is never redundant (D87).`;
interface Redundancy {
  /** The keywords the deck already supplies, with the fewest suppliers among them. */
  keywords: string[];
  suppliers: number;
  /** 1 - (1 - REDUNDANT_KEYWORD_FACTOR) x the share of the link's mechanical rows that are redundant. */
  factor: number;
}

/**
 * D85 (#167): the rows of a link that give the wanting card (e.b) a keyword (wants:keyword-<k>) at least REDUNDANT_KEYWORD_SUPPLIERS
 * other supplier cards already give it, each through a row into the same want of that card (Figure of Unity -> Oppo Rancisis: Raid
 * from 9 deck cards, Restore from 4, Overwhelm from 1, so two of its three rows are redundant). Null when no row is.
 */
function redundantKeywordsOf(ctx: SynergyContext, e: PairEdge, suppliers: ReadonlySet<string>, exclude: readonly string[]): Redundancy | null {
  if (suppliers.size === 0) return null;
  const rows = mechanicalRows(e);
  const supplies = (d: string, want: string): boolean => {
    const into = ctx.graph.edgeByKey.get(`${d}>${e.b}`);
    return into !== undefined && mechanicalRows(into).some((r) => r.want === want);
  };
  const countOf = new Map<string, number>();
  const redundant = rows.filter((r) => {
    if (!r.want.startsWith("wants:keyword-")) return false;
    // D87 (#169): a want that counts or doubles its feeders (Marchion Ro) takes every supplier, so none is redundant.
    if (wantScales(ctx.graph.byKey.get(e.b) as SynergyCard, r.want)) return false;
    if (!countOf.has(r.want)) countOf.set(r.want, [...suppliers].filter((d) => d !== e.a && d !== e.b && !exclude.includes(d) && supplies(d, r.want)).length);
    return (countOf.get(r.want) as number) >= REDUNDANT_KEYWORD_SUPPLIERS;
  });
  if (redundant.length === 0) return null;
  const wants = [...new Set(redundant.map((r) => r.want))];
  return {
    keywords: wants.map((w) => w.slice("wants:keyword-".length).replace(/^./, (c) => c.toUpperCase())).sort(compareCodePoints),
    suppliers: Math.min(...wants.map((w) => countOf.get(w) as number)),
    factor: r3(1 - (1 - REDUNDANT_KEYWORD_FACTOR) * (redundant.length / rows.length)),
  };
}
const redundantText = (ctx: SynergyContext, e: PairEdge, r: Redundancy): string =>
  `${r.keywords.join(", ")}: ${r.suppliers} or more other cards of the deck or the leader already give it to ${cardLabel(ctx.graph.byKey.get(e.b) as SynergyCard)}`;

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
  /** D82: copies per resolved cardKey, summed over the decklist lines. */
  deckCounts?: ReadonlyMap<string, number>;
  /** The named candidates as cardKeys; when absent the input's candidates are read as cardKeys. */
  candidates?: readonly string[];
  unresolvedCandidates?: readonly { card: string; reason: string; detail: string }[];
  /** The rejected cards as cardKeys (D67); when absent the input's exclude is read as cardKeys. */
  exclude?: readonly string[];
  unresolvedExclude?: readonly { card: string; reason: string; detail: string }[];
  /** D84 (#166): printed text and uniqueness by cardKey, which the icon-lender reading needs (The Darksaber's carrier rule). */
  cardFacts?: (cardKey: string) => { text: string | null; unique: boolean } | undefined;
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
    // D84 (#166): an icon lender (The Darksaber) ties the card it frees to each carrier it may sit on, and the lender to each carrier; that
    // relation is a deck link as much as a pair edge, so a carrier the audit names (Qimir) is not read as linked to nothing.
    const carrierPairs = new Map<string, Set<string>>();
    const facts = resolved.cardFacts;
    if (leader !== undefined && base !== undefined && supplied !== undefined && facts !== undefined) {
      const removalOf = (c: SynergyCard, count: number): RemovalCard => ({ syn: c, text: facts(c.cardKey)?.text ?? null, unique: facts(c.cardKey)?.unique === true, count });
      const counts = resolved.deckCounts ?? new Map<string, number>();
      const deckRemoval = deckKeysUnique.map((k) => removalOf(ctx.graph.byKey.get(k) as SynergyCard, counts.get(k) ?? 1));
      const removal = readPenaltyRemovers(removalOf(leader.card, 1), removalOf(base, 1), deckRemoval);
      const tie = (a: string, b: string): void => {
        if (a === b) return;
        for (const [x, y] of [[a, b], [b, a]]) carrierPairs.set(x, (carrierPairs.get(x) ?? new Set()).add(y));
      };
      for (const k of deckKeysUnique) {
        const lent = removal.lentFor(ctx.graph.byKey.get(k) as SynergyCard, supplied);
        for (const c of lent?.carriers ?? []) {
          tie(k, c);
          tie(lent?.lender as string, c);
        }
      }
    }
    const lenderTitle = (k: string): string | undefined =>
      [...(carrierPairs.get(k) ?? [])].map((x) => ctx.graph.byKey.get(x) as SynergyCard).find((c) => c.type === "Upgrade" && (carrierPairs.get(c.cardKey)?.size ?? 0) > 0)?.title;
    const cuts: KeepCut[] = deckKeysUnique.flatMap((k) => {
      const syn = ctx.graph.byKey.get(k) as SynergyCard;
      const linked = (a: string, b: string): boolean => {
        const edge = ctx.graph.edgeByKey.get(`${a}>${b}`);
        return edge !== undefined && mechanicalRows(edge).length > 0;
      };
      const paired = new Set(deckKeysUnique.filter((o) => o !== k && (linked(k, o) || linked(o, k))));
      const carried = [...(carrierPairs.get(k) ?? [])].filter((o) => !paired.has(o));
      const deckLinks = paired.size + carried.length;
      const carrier = carried.length === 0 ? undefined : { lender: lenderTitle(k) ?? "an icon lender", cards: carried.map((o) => cardLabel(ctx.graph.byKey.get(o) as SynergyCard)).sort(cmp) };
      return syn.type === "Leader" || syn.type === "Base"
        ? []
        : [{ cardKey: k, label: cardLabel(syn), penalty: penaltyOf(syn) ?? null, playShare: leader === undefined ? null : playedInclusion(leader, k), deckLinks, ...(carrier === undefined ? {} : { carrier }), feeds: [slot.cardKey, ...candidateKeys].filter((c) => c !== k && linked(k, c)) }];
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
              ...(verdict.cutForCandidate.carrier === undefined ? {} : { carrierLinks: verdict.cutForCandidate.carrier.cards.join("; ") }),
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
/**
 * D87 (#169): the base names that lock every clause giving the card this tag, those the given base does not meet (with no base, every
 * named one, as D51 reads a trio member); empty when one clause is open.
 */
function tagBaseLock(card: SynergyCard, side: "offers" | "wants", tag: string, base: SynergyCard | undefined): string[] {
  const names = card.tags[side].filter((t) => t.tag === tag).map((t) => namedBaseOfClause(t.why));
  return names.length === 0 || names.some((n) => n === null || baseMeets(base, n)) ? [] : [...new Set(names as string[])];
}

function keepsLink(ctx: SynergyContext, e: PairEdge, from: string, to: string, others: readonly string[], base?: SynergyCard): boolean {
  const key = e.a === from ? `${to}>${e.b}` : `${e.a}>${to}`;
  const rows = new Set(primaryRows(e).map((r) => r.row));
  // D87 (#169): the substitute keeps the row through a clause the base opens (Nightfall's attack needs an Endor base), unless the
  // member's own clause for the row is locked the same way.
  const side = e.a === from ? "offers" : "wants";
  const tagOf = (r: PairRowHit): string => (side === "offers" ? r.offer : r.want);
  const memberLock = new Set(primaryRows(e).flatMap((r) => tagBaseLock(ctx.graph.byKey.get(from) as SynergyCard, side, tagOf(r), base)));
  const open = (r: PairRowHit): boolean => tagBaseLock(ctx.graph.byKey.get(to) as SynergyCard, side, tagOf(r), base).every((n) => memberLock.has(n));
  const sameRow = (x: PairEdge | undefined): boolean => x !== undefined && x.rows.some((r) => rows.has(r.row) && open(r));
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
function slotKeep(
  ctx: SynergyContext,
  slot: string,
  links: readonly PairEdge[],
  members: readonly string[],
  inPool: ((cardKey: string) => boolean) | undefined,
  base?: SynergyCard,
): (cardKey: string) => boolean {
  const touching = links.filter((e) => e.a === slot || e.b === slot);
  return (k) => {
    if (inPool !== undefined && !inPool(k)) return false;
    const others = members.map((m) => (m === slot ? k : m));
    return touching.every((e) => keepsLink(ctx, e, slot, k, others, base));
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
const THIS_PHASE = /\bthis phase\b/i;
const SAME_PHASE_NOTE =
  "samePhaseCost: the link feeds a want that checks what happened this phase, so both cards must be played in one phase; the figure is their printed costs summed (aspect penalties not included) (D83).";
/** "You may exhaust a friendly (non-upgrade) leader", "exhaust your leader". */
const EXHAUSTS_LEADER = /\bexhaust (?:a |another |your )?(?:friendly )?(?:\(non-upgrade\) )?leader\b/i;
/** "If it shares a Trait with another friendly unit" (Familiar Strategem). */
const SHARES_TRAIT = /\bshares a trait with another friendly unit\b/i;
/** "another non-leader unit that shares a Trait with a friendly leader" (C-3PO, Translation Protocol). */
const SHARES_LEADER_TRAIT = /\bshares a trait with a friendly leader\b/i;
/** "If an upgrade on your base would be defeated, you may defeat this unit instead" (Vice Admiral Rampart, A New Era of Safety). */
const BASE_UPGRADE_GATE = /\bupgrade on your base\b/i;
/** "Take control of an enemy Credit token" (Lieutenant Gorn): the clause needs a token only the opponent holds. */
const ENEMY_TOKEN = /\benemy (Credit|Force|Experience|Shield|Advantage) tokens?\b/i;
const ATTACH_OFFER = "offers:upgrade-to-attach";
/** The why the tag builder gives an attach offer it reads from no clause (src/ability-grammar/tags.ts): the card is an upgrade or a Pilot. */
const BARE_UPGRADE_WHY = /^is an upgrade\b/;
/** "After completing this attack, if that unit damaged a base, defeat that unit" (Flash the Vents): the rider defeats the attacker. */
const DEFEATS_ATTACKER = /\bafter completing this attack\b[^.]*\bdefeat (?:that unit|it|the attacking unit)\b/i;
/** "An opponent creates a Credit token": a card of yours that hands the opponent such a token. */
const opponentGets = (token: string): RegExp => new RegExp(`\\b(?:an |that |each )?opponents? (?:creates?|gets?) (?:a|an|\\d+) ${token} tokens?\\b|\\bthey create (?:a|an|\\d+) ${token} tokens?\\b`, "i");
/** D83 (#165): the keys find_trios orders by, in the order it applies them. */
const TRIO_ORDER_NOTE =
  "Listed in this order: a scored trio before a substitutes trio (score 0); a trio with no lock (baseLocked, nameLocked, needsForce, needsTrait, needsHost, leaderClash, riderUnmet, drawback) before a locked one; a trio that adds something before one that only repeats what the leader's Action or On Attack already gives its payoff (leaderAlreadyFeeds, D86), whatever its tier (D87); with a decklist, the idea tier (a deck card and a card from outside the deck) before three deck cards before none; a mechanical closing link before a weak one; then a trio with a specific link before one resting only on generic trigger wants such as extra attacks or any When Played (genericLinksOnly, with a decklist), D86, D87; more deckMembers first; then, in the idea tier, orderRank = rank (score when no leader weights it) x newCardWeight, highest first; then rank. orderRank is printed on every idea-tier trio because it, not rank alone, sets the order there (D74, D83). score already holds the aspect penalty as the factor 1 / (1 + penalty / 2), printed as penaltyFactor on a trio with a penalty, the same factor find_pairings applies to an unweighted score (D84).";
const NO_CURATED: ReadonlyMap<string, string> = new Map();
/** Rows of the leader-anchored first tier of find_trios. */
const LEADER_TIER_SIZE = 5;
const LEADER_TRIGGERS: ReadonlySet<string> = new Set(["action", "on_attack"]);
const LEADER_TIER_NOTE =
  "leaderTier: the partners find_pairings gives with the leader as the card, kept when the leader feeds them: a leader-engine row (a card that pays off the keyword the leader grants, uses the attack it gives, readies the unit it plays or readies the leader), or a pair-graph link from the leader's own Action or On Attack; each card shows its most specific link and is ranked as find_pairings ranks it (score / (1 + penalty / 2), or with leader weighting score / (1 + penalty) x (0.5 + leaderInclusion), the staple share for a played engine partner); a locked card and a generic play link follow, a tie goes to the deck's own card. The leader is in play from the start, so each row is the first two cards of a package; the trios below never hold the leader and keep their own order (D84, D85).";

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

/** Copies per cardKey of decklist lines read as cardKeys (in-code callers; the tool boundary passes resolved counts). */
const countsOf = (lines: readonly { card: string; count?: number }[] | undefined): ReadonlyMap<string, number> => {
  const out = new Map<string, number>();
  for (const l of lines ?? []) out.set(l.card, (out.get(l.card) ?? 0) + (l.count ?? 1));
  return out;
};

const NO_RESOURCE_LOCK = { needsForce: [], needsTrait: [] };


/** The D68 output fields, present only while they hold. */
const resourceFields = (r: { needsForce: string[]; needsTrait: string[] }): Record<string, string> => ({
  ...(r.needsForce.length === 0 ? {} : { needsForce: r.needsForce.join(", ") }),
  ...(r.needsTrait.length === 0 ? {} : { needsTrait: r.needsTrait.join(", ") }),
});

/** D82: the play-calibrated score that breaks a rank tie in find_pairings, and the copies of each decklist line. */
export interface PairingExtras {
  scores?: ReadonlyMap<string, { playCalibrated?: number | null }>;
  deckCounts?: ReadonlyMap<string, number>;
}

/** "Title (copies)" of the other deck units that meet a trait gate of the partner's own clause ("While you control another Fighter unit"). */
function traitGateMetBy(partner: SynergyCard, deck: readonly SynergyCard[], counts: ReadonlyMap<string, number>, linked: readonly string[] = []): string[] {
  const out = new Set<string>();
  // D84 (#166): only the clauses the link quotes (Choose Your Path's Mandalorian mode, not its Force mode), when the link names any.
  const all = clauseTextsOf(partner);
  const quoted = all.filter((text) => linked.some((why) => why.includes(text)));
  for (const text of quoted.length > 0 ? quoted : all) {
    const gate = traitGateOfClause(text) ?? targetTraitOfClause(text);
    if (gate === null) continue;
    for (const c of deck) {
      if (c.type !== "Unit" || c.cardKey === partner.cardKey || !gate.traits.some((t) => c.structured.traits.includes(t))) continue;
      out.add(`${cardLabel(c)} (${counts.get(c.cardKey) ?? 1})`);
    }
  }
  return [...out].sort(compareCodePoints).slice(0, TRAIT_GATE_NAMES);
}
const TRAIT_GATE_NAMES = 3;

type PairingArgs = z.infer<z.ZodObject<typeof findPairingsShape>>;

export function findPairings(ctx: SynergyContext, input: unknown, inPool?: (cardKey: string) => boolean, deckCards?: readonly SynergyCard[], extras: PairingExtras = {}): ToolResult {
  const args = z.object(findPairingsShape).parse(input);
  const core = pairingCore(ctx, args, inPool, deckCards, extras);
  if (typeof core === "string") return fail(core);
  const { card, leader, base, picked, engine, action, rows, deferred, perPartner, tribal, rankParts, render, row } = core;
  const shown = perPartner.slice(0, args.limit).map(render);
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
    ...(shown.some((r) => r.samePhaseCost !== undefined) ? { samePhaseNote: SAME_PHASE_NOTE } : {}),
    ...(shown.some((r) => r.redundantKeyword !== undefined) ? { redundantNote: REDUNDANT_KEYWORD_NOTE } : {}),
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

/**
 * The ranked partner rows of find_pairings, before the page is cut. D85 (#167): find_trios builds its leaderTier from the same
 * rows with the leader as the subject, so the tier and find_pairings never give one card two different links.
 */
function pairingCore(ctx: SynergyContext, args: PairingArgs, inPool: ((cardKey: string) => boolean) | undefined, deckCards: readonly SynergyCard[] | undefined, extras: PairingExtras) {
  const resolved = resolve(ctx, [args.cardKey]);
  if (typeof resolved === "string") return resolved;
  const card = resolved[0];
  const picked = leaderAndBase(ctx, args, card);
  if (typeof picked === "string") return picked;
  const { leader, base } = picked;
  const deck = deckOf(ctx, args.decklist, deckCards);
  const pool = lockPool(ctx, leader, deck);
  const deckKeys = new Set(deck.map((c) => c.cardKey));
  // D85 (#167): the leader is in play from the start, so it supplies a keyword like a deck card; with no decklist nothing is redundant.
  const supplierKeys: ReadonlySet<string> = deck.length === 0 ? new Set() : new Set([...deckKeys, ...(leader === undefined ? [] : [leader.card.cardKey])]);
  const deckCounts = extras.deckCounts ?? countsOf(args.decklist);
  const playScore = (k: string): number => extras.scores?.get(k)?.playCalibrated ?? -Infinity;
  // D82 (#164): with a decklist each partner row says whether the deck holds it (and how many), and names the deck units that meet its own trait gate.
  const deckFields = (partner: SynergyCard, e: PairEdge | null = null): Record<string, unknown> => {
    if (deck.length === 0) return {};
    const linked = e === null ? [] : primaryRows(e).flatMap((r) => (e.a === partner.cardKey ? partner.tags.offers.filter((t) => t.tag === r.offer) : partner.tags.wants.filter((t) => t.tag === r.want)).map((t) => t.why));
    const met = traitGateMetBy(partner, deck, deckCounts, linked);
    return {
      inDeck: deckKeys.has(partner.cardKey),
      ...(deckKeys.has(partner.cardKey) ? { copies: deckCounts.get(partner.cardKey) ?? 1 } : {}),
      ...(met.length === 0 ? {} : { traitGateMetBy: met.join("; ") }),
    };
  };
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
      // D85 (#167): a keyword row the deck already gives the wanting card three or more times over counts at REDUNDANT_KEYWORD_FACTOR.
      const redundant = e === null ? null : redundantKeywordsOf(ctx, e, supplierKeys, [card.cardKey, partner.cardKey]);
      const score = e === null ? ENGINE_LINK_SCORE : redundant === null ? edgeScore(e, mode) : r3(edgeScore(e, mode) * redundant.factor);
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
      return { e, partner, cover, score, rank, lock, named, resource, locked, hit, enabled, generic, redundant };
    });
    // D82 (#164): a rank tie goes to the deck's own card, then the higher play-calibrated score, then the title, so a tie never hands the perLink slots to unplayed cards by cardKey.
    const tie = (x: (typeof rows)[number], y: (typeof rows)[number]): number =>
      Number(deckKeys.has(y.partner.cardKey)) - Number(deckKeys.has(x.partner.cardKey)) ||
      playScore(y.partner.cardKey) - playScore(x.partner.cardKey) ||
      compareCodePoints(cardLabel(x.partner), cardLabel(y.partner));
    return rows.sort(
      (x, y) =>
        Number(x.locked) - Number(y.locked) ||
        Number(x.generic) - Number(y.generic) ||
        y.rank - x.rank ||
        tie(x, y) ||
        (x.e !== null && y.e !== null ? edgeOrder(x.e, y.e) : cmp(x.partner.cardKey, y.partner.cardKey)),
    );
  };
  const linkRowsOf = (e: PairEdge, mode: TraitsMode) => (mode === "exclude" ? mechanicalRows(e) : e.rows);
  const linkOf = (r: ReturnType<typeof ranked>[number], mode: TraitsMode): string =>
    r.e === null ? `leader-engine: ${(r.hit as EngineHit).kind} ${(r.hit as EngineHit).keyword ?? ""}` : linkRowsOf(r.e, mode).map((x) => `${x.offer} -> ${x.want}`).join("; ");
  const row = ({ e, partner, cover, score, rank, lock, named, resource, hit, enabled, redundant }: ReturnType<typeof ranked>[number], mode: TraitsMode): Record<string, unknown> => {
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
        ...deckFields(partner),
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
      ...deckFields(partner, e),
      ...(redundant === null ? {} : { redundantKeyword: redundantText(ctx, e, redundant), redundantFactor: redundant.factor }),
    };
    if (args.evidence) out.evidence = pairEvidence(ctx, e, linkRows);
    return out;
  };
  /**
   * D83 (#165): a link into a want that checks "this phase" (Koska Reeves: "If a friendly unit was defeated this phase") needs both
   * cards played in one phase, so the row prints their summed printed cost.
   */
  const samePhaseCost = (rs: readonly { e: PairEdge | null; partner: SynergyCard }[]): number | null => {
    const hit = rs.some(({ e }) => {
      if (e === null) return false;
      const wanting = ctx.graph.byKey.get(e.b) as SynergyCard;
      return mechanicalRows(e).some((h) => THIS_PHASE.test(h.wantWhy ?? wanting.tags.wants.find((t) => t.tag === h.want)?.why ?? ""));
    });
    const partnerCost = rs[0].partner.structured.cost;
    return hit && typeof card.structured.cost === "number" && typeof partnerCost === "number" ? card.structured.cost + partnerCost : null;
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
  // D83 (#165): a partner that links both ways (Chimaera feeds Koska's defeat want and takes her token) is one row; the later links join the first.
  const merged = new Map<string, (typeof ordered)[number][]>();
  for (const r of ordered) merged.set(r.partner.cardKey, [...(merged.get(r.partner.cardKey) ?? []), r]);
  const perPartner = [...merged.values()];
  const render = ([r, ...more]: (typeof ordered)[number][]): Record<string, unknown> => {
    const { e, partner } = r;
    const out = row(r, args.traits);
    if (more.length > 0) {
      const extra = more.map((m) => row(m, args.traits));
      const sides = new Set([out.partnerIs, ...extra.map((x) => x.partnerIs)]);
      if (sides.size > 1) out.partnerIs = "enabler and payoff";
      out.link = [out.link, ...extra.map((x) => x.link)].join("; ");
      out.reason = [out.reason, ...extra.map((x) => x.reason).filter((x) => x !== out.reason)].join(" ");
      if (Array.isArray(out.evidence)) out.evidence = [...(out.evidence as unknown[]), ...extra.flatMap((x) => (Array.isArray(x.evidence) ? (x.evidence as unknown[]) : []))];
    }
    const phaseCost = samePhaseCost([r, ...more]);
    if (phaseCost !== null) out.samePhaseCost = phaseCost;
    if (e !== null && args.withAlternatives) {
      const tags = slotRoles([partner.cardKey], [e])[0];
      const common = commonMembers(ctx.fungibility, partner.cardKey, [...tags.offers, ...tags.wants]);
      out.alternatives = groupText(
        substitutesFor(ctx.fungibility, deckMembers(ctx, common.members, args.includeLeaders), partner.cardKey, {
          preferAspects: aspects,
          perGroup: 2,
          maxCost: args.maxCost,
          keep: slotKeep(ctx, partner.cardKey, [e], [card.cardKey, partner.cardKey], inPool, base),
        }),
        4,
      );
    }
    return out;
  };
  return { card, leader, base, picked, engine, action, rows, deferred, perPartner, tribal, rankParts, render, row, engineClause };
}

/** A card's play-calibrated percentile within its type (0..100), the standing a mixed trio's new card takes when no leader weights it (D74). */
export type StandingScores = ReadonlyMap<string, { percentile?: { playCalibrated: number | null } }>;

export function findTrios(
  ctx: SynergyContext,
  input: unknown,
  inPool?: (cardKey: string) => boolean,
  deckCards?: readonly SynergyCard[],
  scores: StandingScores = new Map(),
  deckCounts?: ReadonlyMap<string, number>,
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
      // The leader weight can lift a trio from below the unweighted cut, so the weighted ranking draws from a deeper pool; so does the
      // deck-anchored pool, because D82 drops the trios whose new card adds nothing and the page would otherwise run out of deck trios.
      ...(weight === undefined && !onlyDeck ? {} : { keep: DEFAULT_TRIO_KEEP * LEADER_TRIO_POOL }),
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
  // D85 (#167): a link's rows that give a member a keyword the deck (or the leader) already gives it three or more times over count
  // at REDUNDANT_KEYWORD_FACTOR, so the link keeps its redundantFactor of its share of the trio's link sum, the sum the score is built on.
  const supplierKeys: ReadonlySet<string> = deckKeys.size === 0 ? new Set() : new Set([...deckKeys, ...(leader === undefined ? [] : [leader.card.cardKey])]);
  const redundantOf = new Map<TrioRecord, string[]>();
  const linkWeight = (e: PairEdge): number => (args.traits === "bonus" ? e.link : args.traits === "exclude" ? e.mechanicalLink : e.mechanicalLink + e.traitLink);
  const discounted = (t: TrioRecord): TrioRecord => {
    if (supplierKeys.size === 0 || t.score === 0) return t;
    const keys = [t.cardA, t.cardB, t.cardC];
    const links = trioLinks(ctx.graph, t);
    const hits = links.map((e) => redundantKeywordsOf(ctx, e, supplierKeys, keys));
    if (hits.every((h) => h === null)) return t;
    const total = links.reduce((s, e) => s + linkWeight(e), 0);
    const kept = links.reduce((s, e, i) => s + linkWeight(e) * (hits[i]?.factor ?? 1), 0);
    const out = { ...t, score: total > 0 ? r3((t.score * kept) / total) : t.score };
    redundantOf.set(
      out,
      links.flatMap((e, i) => (hits[i] === null ? [] : [`${cardLabel(byKeyOf(e.a))} -> ${cardLabel(byKeyOf(e.b))} (${redundantText(ctx, e, hits[i] as Redundancy)})`])),
    );
    return out;
  };
  const poolOf = (shape: TrioShape): TrioRecord[] => {
    const seen = new Set<string>();
    return [...search.trios[shape], ...(anchored?.trios[shape] ?? [])]
      .filter((t) => {
        const id = `${t.cardA}|${t.cardB}|${t.cardC}`;
        return seen.has(id) ? false : (seen.add(id), true);
      })
      .map(discounted);
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
    const clash = leaderClashOf(members);
    const rider = riderUnmetOf(t, members);
    const drawback = selfDefeatOf(t, members);
    return {
      ...lock,
      named,
      resource,
      host,
      clash,
      rider,
      drawback,
      unmet:
        lock.unmet || named.length > 0 || resource.needsForce.length > 0 || resource.needsTrait.length > 0 || host.length > 0 || clash.length > 0 || rider.length > 0 || drawback.length > 0,
    };
  };
  // D85 (#167): an extra attack whose rider defeats the attacker ("After completing this attack, if that unit damaged a base, defeat
  // that unit", Flash the Vents) costs the member it feeds, so the trio carries a drawback and follows the unlocked trios.
  const selfDefeatOf = (t: TrioRecord, members: readonly SynergyCard[]): string[] => {
    const links = trioLinks(ctx.graph, t);
    return members.flatMap((m) => {
      const feeds = links.filter((e) => e.a === m.cardKey && primaryRows(e).some((r) => r.offer === "offers:extra-attack"));
      const clause = feeds.length === 0 ? undefined : clauseTextsOf(m).find((text) => DEFEATS_ATTACKER.test(text));
      return clause === undefined ? [] : [`${cardLabel(m)}: "${clause}" defeats ${feeds.map((e) => cardLabel(byKeyOf(e.b))).join(" or ")} after its attack`];
    });
  };
  // D83 (#165): a member that pays off by exhausting a friendly leader ("You may exhaust a friendly leader. If you do, ...") takes the
  // leader's Action [Exhaust] for that round, so with a leader whose engine is that Action it competes with the leader.
  const leaderAction = leader === undefined ? null : leaderActionOf(leader.card);
  const leaderClashOf = (members: readonly SynergyCard[]): string[] =>
    leaderAction === null
      ? []
      : members.flatMap((m) => {
          const clause = clauseTextsOf(m).find((text) => EXHAUSTS_LEADER.test(text));
          return clause === undefined ? [] : [`${cardLabel(m)}: "${clause}" competes with ${cardLabel(leader?.card as SynergyCard)}'s "${leaderAction}"`];
        });
  // D83 (#165): a rider that needs the unit it attacks with to share a trait with another friendly unit is read against the deck,
  // the leader and the other members; with no decklist it is not judged.
  const riderUnmetOf = (t: TrioRecord, members: readonly SynergyCard[]): string[] => {
    const links = trioLinks(ctx.graph, t);
    const fedBy = (m: SynergyCard): SynergyCard[] => links.filter((e) => e.a === m.cardKey).map((e) => byKeyOf(e.b)).filter((u) => u.type === "Unit");
    // D84 (#166): a gift to "a unit that shares a Trait with a friendly leader" (C-3PO, Translation Protocol) is read against the given leader.
    const leaderRider = (m: SynergyCard): string[] => {
      // D87 (#169): with a decklist and no leader the gift cannot be shown to fire, so it is not offered as a working link either.
      const unknown = leader === undefined && deckKeys.size > 0;
      const clause = leader === undefined && !unknown ? undefined : clauseTextsOf(m).find((text) => SHARES_LEADER_TRAIT.test(text));
      const fed = clause === undefined ? [] : fedBy(m);
      if (unknown && fed.length > 0) return [`${cardLabel(m)}: "${clause}" needs ${fed.map(cardLabel).join(" or ")} to share a trait with your leader, and no leader is given`];
      const own = leader?.card.structured.traits ?? [];
      if (fed.length === 0 || fed.some((u) => u.structured.traits.some((tr) => own.includes(tr)))) return [];
      return [`${cardLabel(m)}: "${clause}" never fires: ${fed.map(cardLabel).join(" or ")} shares no trait with ${cardLabel(leader?.card as SynergyCard)}`];
    };
    if (deckKeys.size === 0) return members.flatMap(leaderRider);
    const everyone = [leader?.card, base, ...deck, ...members].filter((c): c is SynergyCard => c !== undefined);
    const board = everyone.filter((c) => c.type === "Unit" || c.type === "Leader");
    const sharedRider = (m: SynergyCard): string[] => {
      const clause = clauseTextsOf(m).find((text) => SHARES_TRAIT.test(text));
      const fed = clause === undefined ? [] : fedBy(m);
      if (fed.length === 0) return [];
      const shares = (u: SynergyCard): boolean => board.some((x) => x.cardKey !== u.cardKey && x.structured.traits.some((tr) => u.structured.traits.includes(tr)));
      if (fed.some(shares)) return [];
      return [`${cardLabel(m)}: "${clause}" never fires: ${fed.map(cardLabel).join(" or ")} shares no trait with another unit of the leader, the deck or the trio`];
    };
    // D84 (#166): an offer that only replaces the defeat of an upgrade on your base needs a Fortify upgrade among the leader, base, deck and trio.
    const baseUpgradeGate = (m: SynergyCard): string[] => {
      const out = links.filter((e) => e.a === m.cardKey).flatMap((e) => primaryRows(e).map((r) => m.tags.offers.find((o) => o.tag === r.offer)?.why ?? ""));
      if (out.length === 0 || !out.every((why) => BASE_UPGRADE_GATE.test(why))) return [];
      const fortify = (c: SynergyCard): boolean => c.type === "Upgrade" && ((c.structured as { keywordsField?: unknown }).keywordsField as string[] | undefined)?.includes("Fortify") === true;
      if (everyone.some(fortify)) return [];
      return [`${cardLabel(m)}: "${out[0].replace(/^[\w]+: /, "")}" never fires: no Fortify upgrade of the deck or the trio sits on your base`];
    };
    // D84 (#166): a card whose every clause acts on an enemy token of a kind (Lieutenant Gorn: an enemy Credit token) fires only when the opponent
    // has one; it is filler unless a card of the leader, the deck or the trio hands the opponent that token.
    const enemyTokenOnly = (m: SynergyCard): string[] => {
      const texts = clauseTextsOf(m);
      const tokens = texts.map((text) => ENEMY_TOKEN.exec(text)?.[1]);
      if (texts.length === 0 || tokens.some((k) => k === undefined)) return [];
      const token = tokens[0] as string;
      if (everyone.some((c) => c.cardKey !== m.cardKey && clauseTextsOf(c).some((text) => opponentGets(token).test(text)))) return [];
      return [`${cardLabel(m)}: "${texts[0]}" never fires: it needs an enemy ${token} token, and no card of the leader, the deck or the trio gives the opponent one`];
    };
    return members.flatMap((m) => [...leaderRider(m), ...sharedRider(m), ...baseUpgradeGate(m), ...enemyTokenOnly(m)]);
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
  // D82 (#164): with a decklist, the card a mixed trio adds from outside the deck must bring something. It brings nothing when every
  // tag it links by sits in a clause the trait lock shuts (Babu Frik's Droid attack in a deck with no Droid), or when every row it
  // links by is already held: another deck card has the same row into (or from) the same member at the same or better standing
  // (Kage Elite's Raid and Saboteur beside Boba Fett). A leader-engine hit no deck card has is a job of its own (Insurgent Camp).
  const engine = leader === undefined ? null : leaderEngineOf(leader.card);
  const action = leader === undefined ? null : leaderActionOf(leader.card);
  const engineKind = (c: SynergyCard): string | null => {
    const kind = engineHitOf(engine, c, action)?.kind;
    return kind === undefined || kind === "plays" ? null : kind;
  };
  const deckEngineKinds = new Set(deck.flatMap((c) => engineKind(c) ?? []));
  const byKeyOf = (k: string): SynergyCard => ctx.graph.byKey.get(k) as SynergyCard;
  const shutLinks = (n: string, keys: readonly string[], links: readonly PairEdge[]): boolean => {
    if (pool === undefined) return false;
    const supply: LockSupply = { base, suppliers: new Map(), ...resourceSupply(leader?.card, base, [...pool, ...keys.map(byKeyOf)]) };
    const shut = lockedTagsOf(byKeyOf(n), supply);
    const tags = links.flatMap((e) => (e.a === n ? primaryRows(e).map((r) => r.offer) : e.b === n ? primaryRows(e).map((r) => r.want) : []));
    return tags.length > 0 && tags.every((tag) => shut.has(tag));
  };
  const jobHeld = (n: string, links: readonly PairEdge[]): boolean => {
    const kind = engineKind(byKeyOf(n));
    if (kind !== null && !deckEngineKinds.has(kind)) return false;
    const mine = standingOf(n);
    const rows = links.flatMap((e) => (e.a === n || e.b === n ? primaryRows(e).map((r) => ({ e, r })) : []));
    return (
      rows.length > 0 &&
      rows.every(({ e, r }) => {
        const enabler = e.a === n;
        const other = enabler ? e.b : e.a;
        return [...deckKeys].some((d) => {
          if (d === n || d === other) return false;
          const held = ctx.graph.edgeByKey.get(enabler ? `${d}>${other}` : `${other}>${d}`);
          return held !== undefined && primaryRows(held).some((h) => h.baseId === r.baseId && (enabler ? h.want === r.want : h.offer === r.offer)) && standingOf(d) >= mine;
        });
      })
    );
  };
  const proposesNothing = (t: TrioRecord): boolean => {
    if (tierOf(t) !== 0 || deckKeys.size === 0) return false;
    const keys = [t.cardA, t.cardB, t.cardC];
    const links = trioLinks(ctx.graph, t);
    return keys.filter((k) => !deckKeys.has(k)).some((n) => shutLinks(n, keys, links) || jobHeld(n, links));
  };
  // D84 (#166): an offer limited to one arena ("Attack with 2 space units") that feeds an upgrade feeds the unit the upgrade sits on, so a
  // trio that attaches that upgrade to a unit of the other arena never fires (Attack Run + Clandestine Connections on Marrok, a ground unit).
  const arenaOf = (c: SynergyCard): string | undefined => (c.structured.arenas?.length === 1 ? c.structured.arenas[0].toLowerCase() : undefined);
  const arenaClash = (t: TrioRecord): boolean => {
    const links = trioLinks(ctx.graph, t);
    return links.some((into) => {
      if (byKeyOf(into.b).type !== "Upgrade") return false;
      const arenas = primaryRows(into).map((r) => ctx.graph.qualifier(into.a, "offers", r.offer)?.subject.arena);
      if (arenas.some((a) => a === undefined)) return false;
      return links.some((attach) => {
        if (attach.a !== into.b || !primaryRows(attach).some((r) => r.offer === "offers:upgrade-to-attach")) return false;
        const host = arenaOf(byKeyOf(attach.b));
        return host !== undefined && arenas.every((a) => a !== host);
      });
    });
  };
  // D85 (#167): a member whose only links in the trio are its bare "is an upgrade" offer (Arcana Star Map onto Unfettered Ambition)
  // brings no clause of its own: any upgrade fills its slot, so the trio is a two-card line and is not listed.
  const bareUpgrade = (c: SynergyCard): boolean => BARE_UPGRADE_WHY.test(c.tags.offers.find((o) => o.tag === ATTACH_OFFER)?.why ?? "");
  const anyUpgradeTrio = (t: TrioRecord): boolean => {
    const links = trioLinks(ctx.graph, t);
    return [t.cardA, t.cardB, t.cardC].some((k) => {
      const touching = links.filter((e) => e.a === k || e.b === k);
      return touching.length > 0 && bareUpgrade(byKeyOf(k)) && touching.every((e) => e.a === k && primaryRows(e).every((r) => r.offer === ATTACH_OFFER));
    });
  };
  // D86 (#168): a trio whose every link into its payoff (every link of a loop) gives that member only a want the leader's own Action
  // or On Attack already fills for the round (a damaged gate, a once-each-round ability: Arvel Skeen's damage into Oggdo Bogdo beside
  // Cad Bane's ping) spends cards on what the leader does every round, so it follows the trios that add something; leaderAlreadyFeeds says so.
  const leaderFedOf = new Map<TrioRecord, string | null>();
  const leaderFeeds = (t: TrioRecord): string | null => {
    if (leader === undefined) return null;
    if (leaderFedOf.has(t)) return leaderFedOf.get(t) as string | null;
    const lk = leader.card.cardKey;
    const closing = trioLinks(ctx.graph, t).filter((e) => t.shape === "loop" || e.b === t.cardC);
    const fedBy = (member: string): Set<string> => {
      const own = ctx.graph.edgeByKey.get(`${lk}>${member}`) ?? ctx.graph.conditionalByKey.get(`${lk}>${member}`);
      const rows = own === undefined ? [] : primaryRows(own).filter((h) => (ctx.graph.qualifier(lk, "offers", h.offer)?.triggers ?? []).some((x) => LEADER_TRIGGERS.has(x)));
      return new Set(rows.map((h) => h.want));
    };
    const dup = closing.length > 0 && closing.every((e) => {
      const fed = fedBy(e.b);
      const wants = primaryRows(e).map((r) => r.want);
      return wants.length > 0 && wants.every((w) => fed.has(w) && wantSaturates(byKeyOf(e.b), w));
    });
    const text = dup
      ? closing.map((e) => `${cardLabel(leader.card)} already feeds ${cardLabel(byKeyOf(e.b))} (${[...new Set(primaryRows(e).map((r) => r.want))].join(", ")}) every round`).join("; ")
      : null;
    leaderFedOf.set(t, text);
    return text;
  };
  // D86 (#168): with a decklist, a trio whose every link rests only on generic trigger wants (two extra attacks into one unit's On
  // Attack: any attacker has the same edges) follows a trio with a specific link; genericLinksOnly names the wants.
  const genericOnly = (t: TrioRecord): string | null => {
    if (deckKeys.size === 0) return null;
    const wants = trioLinks(ctx.graph, t).flatMap((e) => primaryRows(e).map((r) => r.want));
    return wants.length > 0 && wants.every((w) => GENERIC_TRIGGER_WANTS.has(w)) ? [...new Set(wants)].join(", ") : null;
  };
  // D87 (#169): a trio repeating what the leader feeds every round follows every trio that adds something, whatever its deck-card tier.
  const leaderFed = (t: TrioRecord): number => Number(leaderFeeds(t) !== null);
  const generic = (t: TrioRecord): number => Number(genericOnly(t) !== null);
  const inIdeaTier = (x: TrioRecord, y: TrioRecord): number => (weightFor(x) === null || weightFor(y) === null ? 0 : ideaRank(y) - ideaRank(x));
  // D76 (#162): a substitutes trio (score 0, D64) follows every scored trio whatever its tier or locks.
  const zero = (t: TrioRecord): number => Number(t.score === 0);
  const ranked: TrioRecord[] = shapes
    .flatMap(poolOf)
    .filter((t) => !proposesNothing(t) && !arenaClash(t) && !anyUpgradeTrio(t))
    .sort(
      (x, y) =>
        zero(x) - zero(y) ||
        unmet(x) - unmet(y) ||
        leaderFed(x) - leaderFed(y) ||
        tierOf(x) - tierOf(y) ||
        weakClose(x) - weakClose(y) ||
        generic(x) - generic(y) ||
        inDeckCount(y) - inDeckCount(x) ||
        inIdeaTier(x, y) ||
        byRank(x, y),
    );
  // D49: a trio sharing two members with a better-ranked one is that trio with another third card, listed as its variant.
  const kept: { t: TrioRecord; keys: string[]; variants: { key: string; slot: number; unplayable: string | null }[] }[] = [];
  // D84 (#166): a member the leader plays (within its power limit) gets the leader's grant; a variant it cannot play loses that, so it says so and follows.
  const playsUnit = (c: SynergyCard): boolean => c.type === "Unit" && engine?.playsUnitMaxPower != null && typeof c.structured.power === "number" && c.structured.power <= engine.playsUnitMaxPower;
  const unplayableFor = (replaced: string, variant: string): string | null => {
    const [r, v] = [byKeyOf(replaced), byKeyOf(variant)];
    if (leader === undefined || !playsUnit(r) || playsUnit(v)) return null;
    return `${cardLabel(leader.card)} plays ${cardLabel(r)} (a unit with ${engine?.playsUnitMaxPower} or less power), not this card`;
  };
  const ownLock = (t: TrioRecord, k: string): boolean => {
    const label = `${cardLabel(byKeyOf(k))}:`;
    return [...lockFor(t).clash, ...lockFor(t).rider].some((x) => x.startsWith(label));
  };
  // D83 (#165): the role a member plays in a trio: each primary row of its links, by direction, other member and row.
  const roleOf = (t: TrioRecord, k: string): Set<string> =>
    new Set(trioLinks(ctx.graph, t).flatMap((e) => (e.a === k ? primaryRows(e).map((r) => `out|${e.b}|${r.baseId}`) : e.b === k ? primaryRows(e).map((r) => `in|${e.a}|${r.baseId}`) : [])));
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
    if (third === undefined || host.variants.some((v) => v.key === third) || host.variants.length >= MAX_TRIO_VARIANTS) continue;
    // D83 (#165): a variant fills the slot of the member it replaces: every row that member has with the two kept members.
    const slot = host.keys.findIndex((x) => !keys.includes(x));
    const needed = roleOf(host.t, host.keys[slot]);
    const has = roleOf(t, third);
    // D84 (#166): the variant passes the member checks too: no leader clash and no rider that never fires.
    if ([...needed].every((r) => has.has(r)) && !ownLock(t, third)) host.variants.push({ key: third, slot, unplayable: unplayableFor(host.keys[slot], third) });
    // D87 (#169): a third card that does not do the replaced member's job is another trio, not a variant, so it keeps its own row.
    else kept.push({ t, keys, variants: [] });
  }
  // D87 (#169): a variant that needs a base the member it replaces does not (baseLocked, Nightfall under Nevarro City) follows the others.
  const baseLockedFor = (replaced: string, variant: string): number => {
    const own = new Set(baseLockOfAll([byKeyOf(replaced)], base).names);
    return Number(baseLockOfAll([byKeyOf(variant)], base).names.some((n) => !own.has(n)));
  };
  for (const k of kept) {
    const lockOf = (v: { key: string; slot: number }): number => baseLockedFor(k.keys[v.slot], v.key);
    k.variants.sort((x, y) => lockOf(x) - lockOf(y) || Number(x.unplayable !== null) - Number(y.unplayable !== null));
  }
  const shown = kept.slice(0, args.limit);
  const variantOf = (k: string, slot: number, hostKeys: readonly string[], unplayable: string | null): Record<string, unknown> => {
    const c = ctx.graph.byKey.get(k) as SynergyCard;
    const lock = baseLockOfAll([c], base).names;
    const hosts = hostKeys.map((h) => ctx.graph.byKey.get(h) as SynergyCard);
    const named = nameLockOfCards([c], [...hosts, leader?.card, base, ...deck]);
    const resource = pool === undefined ? NO_RESOURCE_LOCK : resourceLockOfCards([c], leader?.card, base, [...hosts, ...pool]);
    return {
      title: cardLabel(c),
      slot: "ABC"[slot],
      cost: c.structured.cost,
      ...(penaltyAspects === undefined ? {} : { penalty: coverPenalty([c], penaltyAspects, []).penalty }),
      ...(weight === undefined ? {} : { leaderInclusion: inclusionOf(weight, k) }),
      ...(lock.length === 0 ? {} : { baseLocked: lock.join(", ") }),
      ...(named.length === 0 ? {} : { nameLocked: named.join(", ") }),
      ...resourceFields(resource),
      ...(unplayable === null ? {} : { leaderCannotPlay: unplayable }),
    };
  };
  // D84 (#166): the leader-anchored first tier: what the leader's own Action or On Attack feeds, ranked like a find_pairings partner.
  // D85 (#167): built from find_pairings' own rows with the leader as the subject, so a leader-engine row (Boba Fett, Family Found;
  // Insurgent Camp readying the played unit) is in the tier with the same link and rank, and a generic play link follows them all.
  const leaderTierOf = (lw: LeaderWeight): Record<string, unknown>[] => {
    const core = pairingCore(
      ctx,
      z.object(findPairingsShape).parse({
        cardKey: lw.card.cardKey,
        leader: lw.card.cardKey,
        ...(base === undefined ? {} : { base: base.cardKey }),
        ...(base === undefined && penaltyAspects !== undefined ? { aspects: penaltyAspects } : {}),
        ...(args.decklist === undefined ? {} : { decklist: args.decklist }),
        weighting: args.weighting,
        traits: args.traits,
        evidence: args.evidence,
        withAlternatives: false,
        perLink: 100,
        limit: 100,
      }),
      inPool,
      deckCards,
      // D86 (#168): the resolved copies, so a decklist given by name ("TIE Dagger Vanguard", 3) prints copies: 3, not 1.
      { scores: scores as PairingExtras["scores"], ...(deckCounts === undefined ? {} : { deckCounts }) },
    );
    if (typeof core === "string") return [];
    // A row the leader feeds: a leader-engine row, a graph row whose offer comes from the leader's Action or On Attack, or a graph row the engine reads.
    const fedByLeader = (r: (typeof core.perPartner)[number][number]): boolean =>
      r.e === null ||
      (r.hit !== null && r.hit.kind !== "plays") ||
      (r.e.a === lw.card.cardKey && primaryRows(r.e).some((h) => (ctx.graph.qualifier(lw.card.cardKey, "offers", h.offer)?.triggers ?? []).some((x) => LEADER_TRIGGERS.has(x))));
    const clauseOf = (r: (typeof core.perPartner)[number][number]): string => {
      if (r.e === null || (r.hit !== null && r.hit.kind !== "plays")) return core.engineClause(r.hit as EngineHit);
      const offer = primaryRows(r.e).find((h) => r.e?.a === lw.card.cardKey && lw.card.tags.offers.some((o) => o.tag === h.offer))?.offer;
      return (lw.card.tags.offers.find((o) => o.tag === offer)?.why ?? "").replace(/^\w+: /, "");
    };
    return core.perPartner
      .map((group) => group.filter(fedByLeader))
      .filter((group) => group.length > 0 && DECK_CARD_TYPES.has(group[0].partner.type))
      .slice(0, Math.min(args.limit, LEADER_TIER_SIZE))
      .map((group) => {
        const out = core.render(group);
        delete out.alternatives;
        return { ...out, leaderClause: clauseOf(group[0]) };
      });
  };
  const leaderTier = leader === undefined ? undefined : leaderTierOf(leader);
  // D85 (#167): with fixed aspects a slot substitute pays no more aspect penalty than the member it replaces, as budget_alternatives keeps.
  const penaltyOf = (k: string): number => (penaltyAspects === undefined ? 0 : coverPenalty([byKeyOf(k)], penaltyAspects, []).penalty);
  const noDearer = (member: string, k: string): boolean => penaltyAspects === undefined || penaltyOf(k) <= penaltyOf(member);
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
      ...(t.penalty > 0 ? { penaltyFactor: r3(1 / (1 + t.penalty / 2)) } : {}),
      reasons: t.reasons,
      score: t.score,
      ...(redundantOf.has(t) ? { redundantLinks: (redundantOf.get(t) as string[]).join("; ") } : {}),
      ...(weight === undefined ? {} : { rank: rankOf(t), leaderInclusion: keys.map((k) => inclusionOf(weight, k)) }),
      ...(lockFor(t).names.length === 0 ? {} : { baseLocked: lockFor(t).names.join(", ") }),
      ...(lockFor(t).named.length === 0 ? {} : { nameLocked: lockFor(t).named.join(", ") }),
      ...resourceFields(lockFor(t).resource),
      ...(deckKeys.size === 0 ? {} : { deckMembers: inDeckCount(t) }),
      ...(weightFor(t) === null ? {} : { newCardWeight: weightFor(t), orderRank: r3(ideaRank(t)) }),
      ...(lockFor(t).host.length === 0 ? {} : { needsHost: lockFor(t).host.join(", ") }),
      ...(lockFor(t).clash.length === 0 ? {} : { leaderClash: lockFor(t).clash.join("; ") }),
      ...(lockFor(t).rider.length === 0 ? {} : { riderUnmet: lockFor(t).rider.join("; ") }),
      ...(lockFor(t).drawback.length === 0 ? {} : { drawback: lockFor(t).drawback.join("; ") }),
      ...(leaderFeeds(t) === null ? {} : { leaderAlreadyFeeds: leaderFeeds(t) }),
      ...(genericOnly(t) === null ? {} : { genericLinksOnly: genericOnly(t) }),
      ...(variants.length === 0 ? {} : { variants: variants.map((v) => variantOf(v.key, v.slot, keys, v.unplayable)) }),
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
              keep: ((linked) => (k: string) => linked(k) && noDearer(r.cardKey, k))(slotKeep(ctx, r.cardKey, links, keys, inPool, base)),
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
    order: TRIO_ORDER_NOTE,
    ...(leaderTier === undefined ? {} : { leaderTierNote: LEADER_TIER_NOTE, leaderTier }),
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
  const deckCounts = new Map<string, number>();
  for (const line of names.decklist ?? []) {
    const hit = resolveRef(store, line.card, "main");
    const syn = hit.ok ? ctx.graph.byKey.get(hit.row.cardKey) : undefined;
    if (syn === undefined) continue;
    deckCards.push(syn);
    deckCounts.set(syn.cardKey, (deckCounts.get(syn.cardKey) ?? 0) + ((line as { count?: number }).count ?? 1));
  }
  const cardFacts = (cardKey: string): { text: string | null; unique: boolean } | undefined => {
    const row = store.byKey.get(cardKey);
    return row === undefined ? undefined : { text: row.text ?? null, unique: row.unique === true };
  };
  return { deckKeys: new Set(deckCards.map((c) => c.cardKey)), deckCards, deckCounts, candidates, unresolvedCandidates, exclude, unresolvedExclude, cardFacts };
}

export const SYNERGY_TOOLS = {
  fungible_substitutes: {
    title: "Fungible substitutes",
    description:
      "Cards that fill the same role as a card (same offers/wants tag, timing, magnitude band, cost band and type), grouped by aspect. A deck picks the substitute its leader and base already cover. Roles come from the card's feature tags; trait tags are not roles. When the card's class has no other member, each role entry retries with the cost band relaxed to the adjacent bands, then with magnitude ignored as well (same tag, type, timing, target and arena kept), and reports it as widened (\"cost band\" or \"cost band + magnitude\", else null); those substitutes carry match: widened. A unit also holds one keyword:<Keyword> role per printed keyword (same arena, cost band and power-plus-HP band), listed first when the unit has no offers/wants tag or only a constant \"while ...\" condition, so a 3-cost Ground Sentinel finds other Ground Sentinels; its widening drops the stats band in the second step (\"cost band + stats band\"). Substitutes are Premier-pool cards only (a Premier-legal printing). Inside an aspect group substitutes sort by play-calibrated score; give leader (cardKey or exact title) to sort the ones that leader's tournament decklists play first, with leaderInclusion (null when unplayed) on each. Each substitute carries the clause text behind its role; they are candidates, so check that clause says the same thing as the slot card's (evidence: false turns it off). Give decklist to leave out cards already in the deck. Give candidates (cardKeys or SET_NNN ids) to weigh named cards whatever the cost band: each is listed under candidates with its score, the aspect penalty it pays and outsideBand: true when no role lists it; give base with leader (or preferAspects) and the card's own penalty and each substitute's penalty are shown. A card whose job the deck needs (readying a leader; giving a keyword the leader or the deck supplies, such as Ambush or Raid) keeps that job: only roles in that family are listed, each substitute names the family it keeps in keepsRole, and roleKept.none says so when no card in the pool does it. Role classes come in order of how much of the card's job they cover (coverage: the share of the card's offers and wants that the class's best unlocked card also holds) and maxClasses (default 8) caps them; classesCut and the note say how many were left out. With leader and base, a card whose clause needs a base location or a unit aspect that they and the decklist do not supply carries baseLocked or needsUnitAspect (D59) and ranks after the unlocked cards of its aspect group. The answer has two lists (D69). partners holds the cards with a pair edge to the original (it feeds the original, or the original feeds it), each with feedsOriginal or fedByOriginal and the edge's row; they work beside the original and are not replacements, a named candidate that is a partner is always listed, and maxPartners (default 10) caps the rest (partnersTotal, partnersCut). standIns holds the cards that do the original's job without a pair edge to it, never a partner; the role classes (roles) and their coverage count stand-ins only. With candidates and a decklist the answer adds recommendation: for the original and each candidate its aspect penalty under the base, its playShare in the leader's lists (leaderInclusion, or the word unplayed under the 2% floor) and fedByDeck, how many cards already in the deck have a pair edge into it, plus one sentence (verdict) naming which to keep, by the rule it quotes: a card that at least 4 more deck cards feed than the other (a payoff the deck feeds many times over earns a 2-resource penalty, a small gap does not), then lower penalty, then higher play share, then the card already in the deck. A deck card counts as feeding a card only through the job compared (D71): when a candidate feeds the original's wants, only rows into the same wants count (every wants:keyword-<k> row is one job; feederJob names it), so a card that readies a unit no longer feeds a keyword payoff; with no partner candidate every mechanical edge counts as before. When the rule keeps the original over a candidate that is its partner, cutForCandidate names the deck card to cut for it, with its penalty, playShare and deckLinks: the highest aspect penalty under the base, then the lowest play share in the leader's lists, then the fewest pair edges to the rest of the deck, never a card with a pair edge into the original or the candidate, and the verdict says so. exclude (cardKeys, SET_NNN ids or exact titles) drops cards the builder has rejected. A keyword class (a printed keyword, a keyword holder, a keyword the card gives itself) also lists the cards of the same keyword, type, arena and cost band that print it or give it to themselves with no condition (D74): a self-gainer's class takes both, a printer's class takes the unconditional self-gainers; each such card carries keywordJob (the role it holds, for example keyword:Saboteur) and the class keywordJobAdded; a card that copies the keyword from another unit (Oppo Rancisis) is not joined. deckLinks also counts the deck cards tied to the card through an icon lender it carries or is carried by (The Darksaber: the carrier, the card it frees, the lender itself), named in carrierLinks and in the verdict (D84).",
    shape: fungibleSubstitutesShape,
    handler: (store: CardStore, input: unknown): ToolResult =>
      withContext(store, (ctx) => fungibleSubstitutes(ctx, input, scoresOf(store), inPremierPool(store), resolveNames(store, ctx, input))),
  },
  find_pairings: {
    title: "Find pairings",
    description:
      "Partners for a card from the offers-to-wants pair graph: enablers that feed it and payoffs it feeds, each with the reason, its linkKind (mechanical, trait+mechanical or trait-only), a score (link strength times non-obviousness), the aspect penalty, fungible alternatives by aspect (only Premier-pool cards that still link with the card through the same row) and the clause text of each card that produced the offer and the want (status: candidate). By default (traits: bonus) only mechanical links rank; a trait the pair also shares is a small bonus, and pairs that only share a trait (obvious tribal links) come in a separate tribal list capped by tribalLimit (default 5). traits: exclude ignores traits; traits: include ranks trait-only pairs with the rest. Rows list at most perLink (default 3) per distinct link before rows that repeat a link, so the first page shows varied reasons; the deferred rows follow in rank order (capped counts them; perLink 100 turns the cap off). Leader and Base partners are left out because they cannot be one of a deck's 50 cards (includeLeaders: true lists them; partnerFilter states which applied). Give leader (cardKey or exact title) to weight the rank by the leader's tournament decklists: each partner carries leaderInclusion (null when unplayed), played partners rise, unplayed ones stay listed, aspects default to the leader's icons, and the leader block names the population and window. Give base too (a Base card, cardKey or exact title) and aspects default to the leader's and the base's icons together and the leader block names the base; with a leader alone the penalty is measured against the leader's icons only and the leader block says so. A Leader cardKey with no leader argument stands in as the leader, and its most-played tournament base as the base unless base or aspects is given (a supplied aspect set is never replaced by the leader's top base); the leader block says defaulted: true, and weighting: none restores the unweighted answer. The reason names the side the offer lands on (enemy unit, your own, either) where the rule reads differently by side. With a leader (D60), the leader's own clause is a want source: when it plays a unit of limited power or gives a keyword (The Warrior: a unit with 3 or less power, with Ambush), partners that meet it and that the leader's decks play (2% or more) rank at least as if those decks played them 60% of the time, an unplayed one takes the plain x 0.5 (D65), and the reason quotes the leader clause; for a leader subject, a card whose text keys on a friendly unit with the granted keyword (Boba Fett, Family Found), a unit of power within the limit that gives itself an attack keyword while Ambush gives it an attack on entry (Chewbacca, Resourceful Wookiee; The Chieftain), and a card that readies a leader when the leader has an Action that exhausts it (Darth Traya) are listed as leader-engine rows (D65), each quoting the leader clause it rests on. Given a base, or aspects that add one base icon, the leader's decklists are narrowed to the lists with that base when at least 10 remain, else all are used and the leader block says so (populationNote). A partner whose clause names a base the given base does not meet (baseLocked) ranks after every unlocked partner, also past the perLink cap. The leader-engine rows appear whenever a leader is given, in every weighting mode; weighting: none only drops the play-share factor. Evidence for a curated tag quotes the curated clause, and source names the curated side. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it. With a leader, a partner whose clause or cost needs the Force (use the Force, while the Force is with you) carries needsForce unless the subject, leader, base or deck makes the Force, and one whose clause needs a unit of a trait (another Official unit) carries needsTrait unless the subject, leader or a deck unit has it; the deck is decklist when given, else the cards the leader's lists play (2% or more); both rank after every unlocked partner (D68). Evidence quotes the cited clause with the trigger, cost and the clauses it hangs on (use the Force, If you do), clipped to 160 characters. In a leader-weighted rank the aspect penalty divides the score by 1 + penalty (3 at +2) before the play-share factor, so a penalty-2 partner does not outrank a penalty-0 one of similar score (D73). A partner whose own clause names a base location that the given base meets carries baseEnabled: <Location> and baseEnabledClause (the clause quoted), and its rank is multiplied by 1.5 (D73). A card that readies the unit you play (\"When you play a unit with 3 or less power: ... ready that unit\") is a leader-engine row of a leader that plays such a unit with Ambush, quoting both clauses: the unit attacks on entry, then attacks again; a pairing whose offer readies a unit as it is played says so instead of the Action-reuse reason; a row whose only link is a generic play trigger (a unit put into play still counts as played) and that meets the leader's clause only by being playable ranks after every specific link, in every weighting mode; evidence quotes a granted ability inside the clause that grants it (D74). Partners of equal rank list a card of the decklist first, then the higher play-calibrated score, then the title; with a decklist every row carries inDeck (and copies when the deck holds it) and traitGateMetBy names the other deck units that meet a trait gate of the partner's own clause (Flanking Fang Fighter: Corona Squadron X-Wing (3)); a clause whose target is a friendly unit of a trait (\"attack with a friendly Droid unit\") needs a unit of that trait as needsTrait; a ready that is not tied to playing the unit, into a card that wants extra attacks, says that unit attacks again this round (D82). A partner linked both ways is one row (partnerIs: enabler and payoff, its links joined); a link into a want that checks \"this phase\" (Koska Reeves) carries samePhaseCost, the two printed costs summed; a row reason keeps only the example clauses of the two linked cards; a choose-one quote names its mode (\"Choose one (mode 2 of 2): ...\") and a cited clause keeps its conditional rider (\"If it ...\", \"For this attack ...\") (D83). traitGateMetBy reads only the partner clauses the link quotes, so a choose-one card names the units that meet the quoted mode's gate (D84). With a decklist, a link row that gives the wanting card a keyword 3 or more other cards of the deck or the leader already give it counts half, so the row's score is multiplied by redundantFactor = 1 - 0.5 x (redundant rows / mechanical rows) and redundantKeyword names the keywords (Figure of Unity -> Oppo Rancisis beside 9 deck cards with Raid) (D85). A want whose clause counts or doubles what feeds it (\"for each\", \"doubled\": Marchion Ro) is never redundant, and an alternative keeps the link only through a clause the base opens (a substitute whose linking clause needs an Endor base is not offered under Nevarro City) (D87).",
    shape: findPairingsShape,
    handler: (store: CardStore, input: unknown): ToolResult =>
      withContext(store, (ctx) => {
        const names = resolveNames(store, ctx, input);
        return findPairings(ctx, input, inPremierPool(store), names.deckCards, { scores: scoresOf(store), deckCounts: names.deckCounts });
      }),
  },
  find_trios: {
    title: "Find trios",
    description:
      "Three-card combos built from the pair graph: chains A->B->C, two enablers into one payoff, and loops. Built from mechanical links by default; a trait the linked cards share is a small bonus, and traits: include admits trait-only links but every trio keeps at least one mechanical link. Ranked with a bonus for low total cost (default cap 9) and aspect cover; reports total cost, the cheapest leader+base aspect pair, its penalty (+2 resources per uncovered icon) and fungible alternatives per slot (only Premier-pool cards that keep the slot's links with the other members, so a substitute never bypasses a trait restriction the slot card met), with the clause text behind each link (status: candidate). Trios hold only cards a deck's 50 can hold; includeLeaders: true admits Leader and Base cards (partnerFilter states which applied). Give leader (cardKey or exact title) to weight each trio by the leader's tournament decklists: every member carries leaderInclusion (null when unplayed), rank is the score times the geometric mean (cube root of the product) of the member factors so one played card cannot carry two unplayed ones, leaderAspects default to the leader's icons, and the leader block names the population and window. Give base too (a Base card, cardKey or exact title) and baseAspects default to its icons and the leader block names the base; with a leader alone the base is not fixed and the leader block says so. A Leader cardKey with no leader argument defaults the leader (and its most-played tournament base) the same way, with defaulted: true in the leader block; weighting: none turns that off. With a leader-weighted rank, minPlayed (default 2) keeps only trios with at least that many members the leader's decks play. A trio sharing two members with a better-ranked one is folded into it, and its third card is listed under variants. A loop whose single-target outlet would have to defeat both the token it is fed and the unit an upgrade sits on is not listed as a loop. A trio never spends a single-target \"defeat a unit\" on its own unit as a sacrifice outlet (a sweep or \"any number of\" still counts), a chain whose single-target outlet would defeat both the token it is fed and the unit it pays off is not listed, a token made only after a friendly unit was defeated (Koska Reeves) needs another member that defeats one first, and a substitutes trio (score 0) follows every scored trio and is never another trio's variant (D76). Evidence for a curated tag quotes the curated clause, and source names the curated side. Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it. With a leader, a trio whose member needs the Force or a unit of a trait that no member, the leader, the base or the deck supplies carries needsForce or needsTrait and follows the unlocked trios; the deck is decklist when given, else the cards the leader's lists play (2% or more) (D68). With a decklist (D71) the search adds a second pool of trios that hold a deck card, so the plain pool's cut cannot drop them; among trios no lock demotes (D73), a trio that holds a deck card and a card outside the deck (the idea) comes first, then a trio of three deck cards (the build restated), then one with no deck card, and inside a tier a trio whose link into the payoff (every link of a loop) rests on ramp-threshold or bounce-replay rows alone follows the ones with a mechanical payoff, then more deck members (deckMembers) before fewer; a decklist alone, with no leader, is the deck the Force and trait locks read; and a trio with a Pilot (printed Piloting, offering offers:upgrade-to-attach) and no Vehicle unit among the leader, the deck and the other members carries needsHost: Vehicle and follows the unlocked trios. Inside the idea tier the card from outside the deck weighs the order by its own standing (D74): (0.5 + its play share in the leader's lists, 0.5 under the 2% floor) / (1 + its aspect penalty), or with no leader (0.5 + its play-calibrated percentile within its type / 100) / (1 + penalty); newCardWeight shows the weight (the geometric mean when two cards are new). Members joined by an attach link share one unit, so a trio is not built when no single legal host meets every attach restriction in it (Piloting a Vehicle, \"Attach to a Force unit\", a Fortify upgrade) or when an upgrade that removes its host's abilities sits on the member whose upgrade want is one of them. With a decklist (D82) a trio whose card from outside the deck brings nothing is not listed: every tag it links by sits in a clause the trait lock shuts (a friendly-trait target, \"attack with a friendly Droid unit\", in a deck and trio with no Droid), or every row it links by is already held by another deck card with the same row into (or from) the same member at the same or better standing (newCardWeight's measure); a leader-engine hit no deck card has counts as a job of its own; the deck-anchored pool is drawn deeper to keep the page full. With a leader whose Action exhausts it, a member that exhausts a friendly leader (Mando's N-1 Starfighter) carries leaderClash; with a decklist, a member whose rider needs the unit it attacks with to share a trait with another friendly unit (Familiar Strategem), when no unit of the leader, the deck or the trio does, carries riderUnmet; both follow the unlocked trios. A variant fills the slot of the member it replaces (every row that member has with the other two) and names its slot and, with fixed aspects, its penalty. order names the sort keys, and each idea-tier trio prints orderRank = rank x newCardWeight, the key that orders that tier (D83). With a leader, leaderTier lists first the cards a deck can hold that the leader's own Action or On Attack feeds, ranked as find_pairings ranks a partner (the leader is the free first member of such a package; the trios below keep their own order). riderUnmet also covers a gift to a unit sharing a trait with a friendly leader that the fed member lacks (C-3PO, Translation Protocol), an offer that only replaces the defeat of an upgrade on your base with no Fortify upgrade among the leader, base, deck and trio (Vice Admiral Rampart, A New Era of Safety), and a card whose every clause acts on an enemy token nothing hands the opponent (Lieutenant Gorn). A variant passes the same checks (no leaderClash or riderUnmet of its own), and one the leader cannot play in place of a member it plays carries leaderCannotPlay and follows the others. A trio whose arena-limited offer (\"Attack with 2 space units\") feeds an upgrade attached to a unit of the other arena is not listed. A trio with a penalty prints penaltyFactor, the 1 / (1 + penalty / 2) already inside score (D84). D85: leaderTier is built from find_pairings' own rows with the leader as the card, so a leader-engine partner (Boba Fett, Family Found; Insurgent Camp readying the unit The Warrior plays) is listed with the link find_pairings gives it and a generic play link follows every engine row. With a decklist, a link row that gives a member a keyword 3 or more other cards of the deck or the leader already give it counts half its share of the trio's link sum, and redundantLinks names it (Figure of Unity -> Oppo Rancisis: Raid and Restore). With fixed aspects a slot substitute pays no more aspect penalty than the member it replaces. A mode an opponent chooses (\"An opponent chooses one\", Watto) is never a trio link; an extra attack whose rider defeats the attacker (Flash the Vents) carries drawback and follows the unlocked trios; a trio with a member whose only link is that it is an upgrade (Arcana Star Map) is a two-card line and is not listed. D86: a trio whose every link into its payoff gives that member only a want the leader's own Action or On Attack already fills for the round (a damaged gate, a once-each-round ability) carries leaderAlreadyFeeds and follows the trios that add something; with a decklist, a trio whose every link rests on a generic trigger want (extra attacks, a When Played replay, a self-defeat) carries genericLinksOnly and follows a trio with a specific link; a mode each opponent picks (Giant Gorax) never links a trio; leaderTier copies come from the resolved decklist. D87: a trio sharing two members with a better-ranked one whose third card does not fill the replaced member's slot (or fails its checks) keeps its own row instead of being dropped; a slot substitute needs no base the member it replaces does not already need (Nightfall's attack under Nevarro City), and a variant that does carries baseLocked and follows the other variants; with a decklist and no leader, a gift to a unit sharing a trait with a friendly leader carries riderUnmet (no leader is given) and is no variant; leaderAlreadyFeeds sorts before the deck-card tier; a want for any When Played ability (wants:when-played-cards) is a generic trigger want; a want that counts or doubles what feeds it (Marchion Ro) is never a redundantLinks row.",
    shape: findTriosShape,
    handler: (store: CardStore, input: unknown): ToolResult =>
      withContext(store, (ctx) => {
        const names = resolveNames(store, ctx, input);
        return findTrios(ctx, input, inPremierPool(store), names.deckCards, scoresOf(store), names.deckCounts);
      }),
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
