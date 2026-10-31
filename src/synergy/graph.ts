import { STAT_WANT } from "../ability-grammar/tags.js";
import { compareCodePoints } from "../swu/canonical.js";
import { cmp, r3 } from "./order.js";
import { nameReferences } from "./names.js";
import { boardTraits, conflictBetween, offerTraitNeeds, qualifierOf, type TagQualifier } from "./qualifiers.js";
import type { ComplementarityRow, ComplementarityTable, NonObviousness, PairEdge, PairRowHit, SynergyCard, TraitsMode } from "./schema.js";

/**
 * @displayName SWU offers-to-wants pair graph
 * @strategicPurpose Turns per-card offers/wants tags and the reviewed complementarity table into
 * directed pair edges A -> B ("A supplies what B needs"), ranked by link strength times
 * non-obviousness (ported from the mault-train prototype pairs.mjs, LampaGJ/mault#325).
 * @tacticalObjective Pure function of (cards, table): no clock, no randomness, every sort is a
 * code-unit order, so the same inputs give byte-identical edges.
 */

export interface ExpandedRow extends ComplementarityRow {
  baseId: string;
  wants: Record<string, number>;
}

export interface ExampleCheck {
  row: string;
  example: [string, string];
  matches: boolean;
}

export interface PairGraph {
  cards: readonly SynergyCard[];
  byKey: ReadonlyMap<string, SynergyCard>;
  rows: readonly ExpandedRow[];
  edges: readonly PairEdge[];
  edgeByKey: ReadonlyMap<string, PairEdge>;
  /** Links that fire only when a third card supplies the traits in `needs` (#108); never pairs, only trio links. */
  conditional: readonly PairEdge[];
  conditionalByKey: ReadonlyMap<string, PairEdge>;
  /** The traits a card puts on the board: its own as a unit, and those of the tokens it creates. */
  boardTraits(cardKey: string): readonly string[];
  /** The qualifiers of one tag on one card, from the same cache the pair matcher uses; undefined for an unknown card. */
  qualifier(cardKey: string, side: "offers" | "wants", tag: string): TagQualifier | undefined;
  rowCounts: Readonly<Record<string, number>>;
  exampleChecks: readonly ExampleCheck[];
  /** Want tags the table marks fed by every deck that plays cards at all (`genericallyFed`, D62). */
  genericallyFed: ReadonlySet<string>;
}

export const TRAIT_ROW = "trait-reference";

/**
 * A shared trait on a pair that already has a mechanical link multiplies that link by 1 + TRAIT_BONUS; it is never
 * added as a link of its own, because tribal links are obvious and would otherwise outrank real combos (#24).
 */
export const TRAIT_BONUS = 0.1;

export const isTraitRow = (r: Pick<PairRowHit, "baseId">): boolean => r.baseId === TRAIT_ROW;

/** The rows that make a pair mechanical; empty on a trait-only pair. */
export const mechanicalRows = (e: PairEdge): PairRowHit[] => e.rows.filter((r) => !isTraitRow(r));

/** The rows that carry a pair's reason: all rows on a trait-only pair, otherwise the mechanical ones. */
export const primaryRows = (e: PairEdge): PairRowHit[] => (e.traitOnly ? e.rows : mechanicalRows(e));

/** The pair score under a traits mode; "bonus" is the stored score, "exclude" gives a trait-only pair 0. */
export function edgeScore(e: PairEdge, mode: TraitsMode): number {
  if (mode === "bonus") return e.score;
  const link = mode === "exclude" ? e.mechanicalLink : e.mechanicalLink + e.traitLink;
  return r3(link * e.nonObvious.factor);
}

const COLOUR_FREE = (aspects: readonly string[]): string[] => aspects.filter((x) => x !== "Heroism" && x !== "Villainy");

/** Every row, with the trait family expanded to one row per trait found on the cards and the stat family to one row per stat-count want. */
export function expandRows(cards: readonly SynergyCard[], table: ComplementarityTable): ExpandedRow[] {
  const traitNames = [...new Set(cards.flatMap((c) => c.structured.traits))].sort(compareCodePoints);
  const statWants = [...new Set(cards.flatMap((c) => c.tags.wants.map((w) => w.tag)).filter((t) => STAT_WANT.test(t)))].sort(compareCodePoints);
  const rows: ExpandedRow[] = [];
  for (const row of table.rows) {
    if (row.family === "trait") {
      for (const t of traitNames) {
        rows.push({
          ...row,
          id: `trait-reference:${t}`,
          offers: { [`offers:is-trait-${t}`]: 1 },
          wants: { [`wants:trait-${t}`]: 1 },
          baseId: row.id,
        });
      }
    } else if (row.family === "stat") {
      for (const want of statWants) {
        const stat = (STAT_WANT.exec(want) as RegExpExecArray)[1];
        rows.push({ ...row, id: `stat-count:${want.slice("wants:unit-".length)}`, offers: { [`offers:printed-${stat}`]: 1 }, wants: { [want]: 1 }, baseId: row.id });
      }
    } else if (!Array.isArray(row.wants)) {
      rows.push({ ...row, wants: row.wants, baseId: row.id });
    } else {
      throw new Error(`complementarity row ${row.id}: array wants are only valid on the trait and stat families`);
    }
  }
  return rows;
}

// Quirk kept from the prototype for parity: the match includes the `"text":"` prefix, so the word "text" is in every set.
const wordSet = (c: SynergyCard): Set<string> => {
  const joined = Object.values(c.faces)
    .flatMap(
      (nodes) =>
        JSON.stringify(nodes)
          .toLowerCase()
          .match(/"text":"([^"]*)"/g) ?? [],
    )
    .join(" ");
  return new Set(joined.match(/[a-z]{4,}/g) ?? []);
};

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
};

const disjoint = (a: readonly string[], b: readonly string[]): boolean => !a.some((x) => b.includes(x));

export function buildPairGraph(cards: readonly SynergyCard[], table: ComplementarityTable): PairGraph {
  const byKey = new Map(cards.map((c) => [c.cardKey, c]));
  const offersOf = new Map(cards.map((c) => [c.cardKey, new Set(c.tags.offers.map((o) => o.tag))]));
  const wantsOf = new Map(cards.map((c) => [c.cardKey, new Set(c.tags.wants.map((w) => w.tag))]));
  const words = new Map(cards.map((c) => [c.cardKey, wordSet(c)]));
  const rows = expandRows(cards, table);
  const tokenTraits = new Map<string, string[]>();
  const tokenAspects = new Map<string, string[]>();
  for (const c of cards) {
    if (c.type !== "Token Unit") continue;
    tokenTraits.set(c.title, [...new Set([...(tokenTraits.get(c.title) ?? []), ...c.structured.traits])].sort(cmp));
    tokenAspects.set(c.title, [...new Set([...(tokenAspects.get(c.title) ?? []), ...c.structured.aspects])].sort(cmp));
  }
  const qualifiers = new Map<string, TagQualifier>();
  const qualifier = (c: SynergyCard, side: "offers" | "wants", tag: string): TagQualifier => {
    const key = `${c.cardKey}|${side}|${tag}`;
    let q = qualifiers.get(key);
    if (q === undefined) {
      const why = c.tags[side].find((t) => t.tag === tag)?.why ?? "";
      q = qualifierOf(c, side, tag, why, tokenTraits, tokenAspects);
      qualifiers.set(key, q);
    }
    return q;
  };

  /**
   * The offer and want tags of A and B that no stated qualifier contradicts. When every such pair needs a trait
   * B does not carry, they are returned with those traits as `needs`: a trio link, not a pair.
   */
  const linkable = (a: SynergyCard, offerHits: readonly string[], b: SynergyCard, wantHits: readonly string[]) => {
    const okPairs = offerHits.flatMap((o) =>
      wantHits
        .filter((w) => conflictBetween(a, o, qualifier(a, "offers", o), b, w, qualifier(b, "wants", w)) === null)
        .map((w) => ({ o, w, needs: offerTraitNeeds(qualifier(a, "offers", o), b, w, qualifier(b, "wants", w), tokenTraits) })),
    );
    const free = okPairs.filter((p) => p.needs.length === 0);
    const used = free.length > 0 ? free : okPairs;
    return {
      offers: offerHits.filter((o) => used.some((p) => p.o === o)),
      wants: wantHits.filter((w) => used.some((p) => p.w === w)),
      needs: free.length > 0 ? [] : [...new Set(okPairs.flatMap((p) => p.needs))].sort(cmp),
    };
  };
  const boardTraitCache = new Map<string, string[]>();
  const boardTraitsOf = (cardKey: string): string[] => {
    let t = boardTraitCache.get(cardKey);
    if (t === undefined) {
      const c = byKey.get(cardKey);
      t = c === undefined ? [] : boardTraits(c, tokenTraits);
      boardTraitCache.set(cardKey, t);
    }
    return t;
  };

  const nonObvious = (a: SynergyCard, b: SynergyCard): NonObviousness => {
    const aspects = disjoint(COLOUR_FREE(a.structured.aspects), COLOUR_FREE(b.structured.aspects)) ? 1 : 0;
    const traits = disjoint(a.structured.traits, b.structured.traits) ? 1 : 0;
    const wording = 1 - jaccard(words.get(a.cardKey) as Set<string>, words.get(b.cardKey) as Set<string>);
    return { aspects, traits, wording: r3(wording), factor: r3(1 + 0.5 * aspects + 0.25 * traits + 0.5 * wording) };
  };

  const edges = new Map<string, PairEdge>();
  const conditional = new Map<string, PairEdge>();
  const rowCounts: Record<string, number> = {};
  const edgeFor = (target: Map<string, PairEdge>, a: string, b: string): PairEdge =>
    target.get(`${a}>${b}`) ?? {
      a,
      b,
      rows: [],
      link: 0,
      mechanicalLink: 0,
      traitLink: 0,
      linkKind: "mechanical",
      nonObvious: { aspects: 0, traits: 0, wording: 0, factor: 0 },
      traitOnly: false,
      score: 0,
    };
  for (const row of rows) {
    const offerTags = Object.keys(row.offers);
    const wantTags = Object.keys(row.wants);
    if (row.family === "name") {
      const [offer, want] = [offerTags.sort(cmp)[0], wantTags.sort(cmp)[0]];
      const weight = r3(row.strength * row.offers[offer] * row.wants[want]);
      let named = 0;
      for (const ref of nameReferences(cards)) {
        const e = edgeFor(edges, ref.a, ref.b);
        e.rows.push({ row: row.id, baseId: row.baseId, offer, want, weight, reason: row.reason, offerWhy: ref.why, wantWhy: `title: ${ref.title}` });
        e.mechanicalLink = r3(e.mechanicalLink + weight);
        edges.set(`${ref.a}>${ref.b}`, e);
        named++;
      }
      rowCounts[row.baseId] = (rowCounts[row.baseId] ?? 0) + named;
      continue;
    }
    if (row.family === "stat") {
      // D72: a count of units by printed stat is fed by every Unit whose printed stat meets it; no offer tag carries the stat.
      const want = wantTags[0];
      const [, stat, bound, dir] = STAT_WANT.exec(want) as RegExpExecArray;
      const limit = Number(bound);
      const meets = (v: number): boolean => (dir === "less" ? v <= limit : dir === "more" ? v >= limit : v === limit);
      const printed = (c: SynergyCard): number | null => {
        const v = (c.structured as Record<string, unknown>)[stat];
        return typeof v === "number" ? v : null;
      };
      const weight = r3(row.strength * row.offers[offerTags[0]] * row.wants[want]);
      const wanters = cards.filter((c) => wantsOf.get(c.cardKey)?.has(want));
      let linked = 0;
      for (const a of cards) {
        const v = printed(a);
        if (a.type !== "Unit" || v === null || !meets(v)) continue;
        for (const b of wanters) {
          if (a.cardKey === b.cardKey || a.title === b.title) continue;
          const e = edgeFor(edges, a.cardKey, b.cardKey);
          e.rows.push({ row: row.id, baseId: row.baseId, offer: `offers:printed-${stat}-${v}`, want, weight, reason: row.reason, offerWhy: `printed ${stat} ${v}` });
          e.mechanicalLink = r3(e.mechanicalLink + weight);
          edges.set(`${a.cardKey}>${b.cardKey}`, e);
          linked++;
        }
      }
      rowCounts[row.baseId] = (rowCounts[row.baseId] ?? 0) + linked;
      continue;
    }
    const offerers = cards.filter((c) => offerTags.some((t) => offersOf.get(c.cardKey)?.has(t)));
    const wanters = cards.filter((c) => wantTags.some((t) => wantsOf.get(c.cardKey)?.has(t)));
    let n = 0;
    for (const a of offerers) {
      const hitOffers = offerTags.filter((t) => offersOf.get(a.cardKey)?.has(t));
      for (const b of wanters) {
        if (a.cardKey === b.cardKey || a.title === b.title) continue;
        const allWants = wantTags.filter((t) => wantsOf.get(b.cardKey)?.has(t)).sort(cmp);
        const { offers: usableOffers, wants: hitWants, needs } = row.family === "trait" ? { offers: hitOffers, wants: allWants, needs: [] } : linkable(a, hitOffers, b, allWants);
        if (usableOffers.length === 0 || hitWants.length === 0) continue;
        const w = Math.max(...usableOffers.map((t) => row.offers[t]));
        const viaOffer = [...usableOffers].sort(cmp)[0];
        const target = needs.length === 0 ? edges : conditional;
        if (needs.length === 0) n++;
        const k = `${a.cardKey}>${b.cardKey}`;
        const ww = Math.max(...hitWants.map((t) => row.wants[t]));
        const e = edgeFor(target, a.cardKey, b.cardKey);
        e.rows.push({
          row: row.id,
          baseId: row.baseId,
          offer: viaOffer,
          want: hitWants[0],
          weight: r3(row.strength * w * ww),
          reason: row.reason,
        });
        if (row.family === "trait") e.traitLink = r3(e.traitLink + row.strength * w * ww);
        else e.mechanicalLink = r3(e.mechanicalLink + row.strength * w * ww);
        if (needs.length > 0) e.needs = [...new Set([...(e.needs ?? []), ...needs])].sort(cmp);
        target.set(k, e);
      }
    }
    rowCounts[row.baseId] = (rowCounts[row.baseId] ?? 0) + n;
  }

  // A pair that already links without a supplier keeps that link; its supplier-bound rows add nothing to a trio.
  for (const k of edges.keys()) conditional.delete(k);
  const byPair = (x: PairEdge, y: PairEdge): number => cmp(x.a, y.a) || cmp(x.b, y.b);
  const edgeList = [...edges.values()].sort(byPair);
  const conditionalList = [...conditional.values()].sort(byPair);
  for (const e of [...edgeList, ...conditionalList]) {
    e.nonObvious = nonObvious(byKey.get(e.a) as SynergyCard, byKey.get(e.b) as SynergyCard);
    const hasTrait = e.rows.some(isTraitRow);
    e.linkKind = e.rows.every(isTraitRow) ? "trait-only" : hasTrait ? "trait+mechanical" : "mechanical";
    e.traitOnly = e.linkKind === "trait-only";
    e.link = e.traitOnly ? e.traitLink : hasTrait ? r3(e.mechanicalLink * (1 + TRAIT_BONUS)) : e.mechanicalLink;
    e.score = r3(e.link * e.nonObvious.factor);
  }

  const exampleChecks = table.rows.flatMap((r): ExampleCheck[] => {
    if (r.example === null) return [];
    const a = cards.find((c) => c.title === r.example?.[0]);
    const b = cards.find((c) => c.title === r.example?.[1]);
    const e = a && b ? edges.get(`${a.cardKey}>${b.cardKey}`) : undefined;
    return [{ row: r.id, example: r.example, matches: e !== undefined && e.rows.some((x) => x.baseId === r.id) }];
  });

  return {
    cards,
    byKey,
    rows,
    edges: edgeList,
    edgeByKey: edges,
    conditional: conditionalList,
    conditionalByKey: conditional,
    boardTraits: boardTraitsOf,
    qualifier: (cardKey, side, tag) => {
      const c = byKey.get(cardKey);
      return c === undefined ? undefined : qualifier(c, side, tag);
    },
    exampleChecks,
    genericallyFed: new Set((table.genericallyFed ?? []).map((g) => g.tag)),
    rowCounts: Object.fromEntries(
      Object.keys(rowCounts)
        .sort(cmp)
        .map((k) => [k, rowCounts[k]]),
    ),
  };
}

export const edgeOrder = (x: PairEdge, y: PairEdge): number => y.score - x.score || cmp(x.a, y.a) || cmp(x.b, y.b);
