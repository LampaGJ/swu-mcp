import { encode } from "@toon-format/toon";
import { z } from "zod";
import { packageDirOf, type CardStore } from "../data.js";
import { CANDIDATE_STATUS, clip, evidenceOf, tagEvidence } from "../synergy/evidence.js";
import { comboLabel, coverPenalty, rankCovers, type CoverCombo } from "../synergy/cover.js";
import { loadSynergyContext, type SynergyContext } from "../synergy/context.js";
import {
  aspectGroup,
  commonMembers,
  roleOf,
  substitutesFor,
  type SubstituteGroup,
  type SubstituteOptions,
} from "../synergy/fungibility.js";
import { edgeOrder } from "../synergy/graph.js";
import { cardLabel, cmp } from "../synergy/order.js";
import { TRIO_SHAPES, type PairEdge, type SynergyCard, type TrioRecord } from "../synergy/schema.js";
import { slotRoles, trioLinks } from "../synergy/slots.js";
import { trioOrder } from "../synergy/trios.js";
import type { ToolResult } from "../tools.js";

/**
 * @displayName SWU synergy MCP tools
 * @strategicPurpose Serves the pairing, trio, fungibility and aspect-cover analysis to assistants
 * (LampaGJ/swu-mcp#3). Every answer comes from the same pure functions as `pnpm synergy`, so a tool
 * result and a run output cannot disagree, and no model sits in the path.
 * @tacticalObjective Handlers take a SynergyContext so tests can run them on in-code fixtures; the
 * registered tools build the context lazily from `<packageDir>/features/features.json`.
 */

const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: encode(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const evidenceFlag = z
  .boolean()
  .default(true)
  .describe("Include the clause text (clipped to 160 characters) of each card that produced the offer and the want; false drops it");

const aspectList = z.array(z.string().min(1)).max(3);
const cardKey = z.string().min(1);

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
  includeTraitOnly: z.boolean().default(false).describe("Include pairs linked only by a shared trait (the obvious kind)"),
  withAlternatives: z.boolean().default(true).describe("List fungible alternatives for the partner slot, by aspect"),
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
  withAlternatives: z.boolean().default(true).describe("List fungible alternatives for each slot, by aspect"),
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

export function fungibleSubstitutes(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(fungibleSubstitutesShape).parse(input);
  const resolved = resolve(ctx, [args.cardKey]);
  if (typeof resolved === "string") return fail(resolved);
  const slot = resolved[0];
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
  };
  const roles = tags.flatMap((tag) => {
    const cls = roleOf(ctx.fungibility, slot.cardKey, tag);
    if (cls === undefined) return [];
    const groups = substitutesFor(ctx.fungibility, cls.members, slot.cardKey, options);
    const withText = (c: SubstituteGroup["cards"][number]) =>
      args.evidence ? { ...c, text: tagEvidence(ctx.graph.byKey.get(c.cardKey) as SynergyCard, tag) } : c;
    return [
      {
        classId: cls.id,
        tag,
        classSize: cls.members.length,
        aspectSets: new Set(cls.members.map((k) => aspectGroup(ctx.graph.byKey.get(k) as SynergyCard))).size,
        ...(args.evidence ? { slotText: tagEvidence(slot, tag) } : {}),
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
  return ok({ status: CANDIDATE_STATUS, card: brief(slot), roles });
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

export function findPairings(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(findPairingsShape).parse(input);
  const resolved = resolve(ctx, [args.cardKey]);
  if (typeof resolved === "string") return fail(resolved);
  const card = resolved[0];
  const edges = ctx.graph.edges.filter((e) => {
    if (e.traitOnly && !args.includeTraitOnly) return false;
    const partner = e.a === card.cardKey ? e.b : e.b === card.cardKey ? e.a : undefined;
    if (partner === undefined) return false;
    if (e.a === card.cardKey && args.direction === "enablers") return false;
    if (e.b === card.cardKey && args.direction === "payoffs") return false;
    const cost = (ctx.graph.byKey.get(partner) as SynergyCard).structured.cost;
    return args.maxCost === undefined || (cost !== null && cost <= args.maxCost);
  });
  const rows = edges.map((e: PairEdge) => {
    const partner = ctx.graph.byKey.get(e.a === card.cardKey ? e.b : e.a) as SynergyCard;
    const cover = penaltyFor(ctx, [card, partner], args.aspects);
    const rank = args.aspects === undefined ? e.score : Math.round((e.score / (1 + cover.penalty / 2)) * 1000) / 1000;
    return { e, partner, cover, rank };
  });
  rows.sort((x, y) => y.rank - x.rank || edgeOrder(x.e, y.e));
  const shown = rows.slice(0, args.limit).map(({ e, partner, cover, rank }) => {
    const out: Record<string, unknown> = {
      ...brief(partner),
      status: CANDIDATE_STATUS,
      partnerIs: e.a === card.cardKey ? "payoff" : "enabler",
      link: e.rows.map((r) => `${r.offer} -> ${r.want}`).join("; "),
      reason: e.rows[0].reason,
      score: e.score,
      aspectPair: cover.aspectPair,
      penalty: cover.penalty,
      rank,
    };
    if (args.evidence) out.evidence = evidenceOf(e, ctx.graph.byKey);
    if (args.withAlternatives) {
      const tags = slotRoles([partner.cardKey], [e])[0];
      const common = commonMembers(ctx.fungibility, partner.cardKey, [...tags.offers, ...tags.wants]);
      out.alternatives = groupText(
        substitutesFor(ctx.fungibility, common.members, partner.cardKey, {
          preferAspects: args.aspects,
          perGroup: 2,
          maxCost: args.maxCost,
        }),
        4,
      );
    }
    return out;
  });
  return ok({ card: brief(card), source: args.source, total: rows.length, shown: shown.length, pairings: shown });
}

export function findTrios(ctx: SynergyContext, input: unknown): ToolResult {
  const args = z.object(findTriosShape).parse(input);
  if (args.cardKey !== undefined) {
    const resolved = resolve(ctx, [args.cardKey]);
    if (typeof resolved === "string") return fail(resolved);
  }
  const fixed = args.leaderAspects !== undefined || args.baseAspects !== undefined;
  const search = ctx.trios({
    combos: fixed ? fixedCombo(args.leaderAspects, args.baseAspects) : undefined,
    accept: (keys, cost) => cost <= args.maxTotalCost && (args.cardKey === undefined || keys.includes(args.cardKey)),
  });
  const shapes = args.shape === undefined ? TRIO_SHAPES : [args.shape];
  const merged: TrioRecord[] = shapes
    .flatMap((s) => search.trios[s])
    .sort(trioOrder)
    .slice(0, args.limit);
  const prefer = fixed ? [...(args.leaderAspects ?? []), ...(args.baseAspects ?? [])] : undefined;
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
    };
    if (args.evidence) {
      out.evidence = trioLinks(ctx.graph, t).flatMap((e) =>
        evidenceOf(e, ctx.graph.byKey, e.rows.slice(0, 1)).map((ev) => ({
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
          substitutes: groupText(substitutesFor(ctx.fungibility, common.members, r.cardKey, { preferAspects: prefer, perGroup: 2 }), 4),
        };
      });
    }
    return out;
  });
  return ok({
    counts: { chain: search.counts.chain, convergent: search.counts.convergent, loop: search.counts.loop },
    maxTotalCost: args.maxTotalCost,
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
      "Cards that fill the same role as a card (same offers/wants tag, timing, magnitude band, cost band and type), grouped by aspect. A deck picks the substitute its leader and base already cover. Roles come from the card's feature tags; trait tags are not roles. Each substitute carries the clause text behind its role; they are candidates, so check that clause says the same thing as the slot card's (evidence: false turns it off).",
    shape: fungibleSubstitutesShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => fungibleSubstitutes(ctx, input)),
  },
  find_pairings: {
    title: "Find pairings",
    description:
      "Partners for a card from the offers-to-wants pair graph: enablers that feed it and payoffs it feeds, each with the reason, a score (link strength times non-obviousness), the aspect penalty, fungible alternatives by aspect and the clause text of each card that produced the offer and the want (status: candidate). Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it.",
    shape: findPairingsShape,
    handler: (store: CardStore, input: unknown): ToolResult => withContext(store, (ctx) => findPairings(ctx, input)),
  },
  find_trios: {
    title: "Find trios",
    description:
      "Three-card combos built from the pair graph: chains A->B->C, two enablers into one payoff, and loops. Ranked with a bonus for low total cost (default cap 9) and aspect cover; reports total cost, the cheapest leader+base aspect pair, its penalty (+2 resources per uncovered icon) and fungible alternatives per slot, with the clause text behind each link (status: candidate). Every result is a candidate, not a fact: confirm each link against the clause text in the evidence (evidence: false turns it off) before relying on it.",
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
