import { compareCodePoints } from "../swu/canonical.js";
import { cmp, r3 } from "./order.js";
import type { ComplementarityRow, ComplementarityTable, NonObviousness, PairEdge, SynergyCard } from "./schema.js";

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
  rowCounts: Readonly<Record<string, number>>;
  exampleChecks: readonly ExampleCheck[];
}

const COLOUR_FREE = (aspects: readonly string[]): string[] => aspects.filter((x) => x !== "Heroism" && x !== "Villainy");

/** Every row, with the trait family expanded to one row per trait found on the cards. */
export function expandRows(cards: readonly SynergyCard[], table: ComplementarityTable): ExpandedRow[] {
  const traitNames = [...new Set(cards.flatMap((c) => c.structured.traits))].sort(compareCodePoints);
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
    } else if (!Array.isArray(row.wants)) {
      rows.push({ ...row, wants: row.wants, baseId: row.id });
    } else {
      throw new Error(`complementarity row ${row.id}: array wants are only valid on the trait family`);
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

  const nonObvious = (a: SynergyCard, b: SynergyCard): NonObviousness => {
    const aspects = disjoint(COLOUR_FREE(a.structured.aspects), COLOUR_FREE(b.structured.aspects)) ? 1 : 0;
    const traits = disjoint(a.structured.traits, b.structured.traits) ? 1 : 0;
    const wording = 1 - jaccard(words.get(a.cardKey) as Set<string>, words.get(b.cardKey) as Set<string>);
    return { aspects, traits, wording: r3(wording), factor: r3(1 + 0.5 * aspects + 0.25 * traits + 0.5 * wording) };
  };

  const edges = new Map<string, PairEdge>();
  const rowCounts: Record<string, number> = {};
  for (const row of rows) {
    const offerTags = Object.keys(row.offers);
    const wantTags = Object.keys(row.wants);
    const offerers = cards.filter((c) => offerTags.some((t) => offersOf.get(c.cardKey)?.has(t)));
    const wanters = cards.filter((c) => wantTags.some((t) => wantsOf.get(c.cardKey)?.has(t)));
    let n = 0;
    for (const a of offerers) {
      const hitOffers = offerTags.filter((t) => offersOf.get(a.cardKey)?.has(t));
      const w = Math.max(...hitOffers.map((t) => row.offers[t]));
      const viaOffer = [...hitOffers].sort(cmp)[0];
      for (const b of wanters) {
        if (a.cardKey === b.cardKey || a.title === b.title) continue;
        n++;
        const k = `${a.cardKey}>${b.cardKey}`;
        const hitWants = wantTags.filter((t) => wantsOf.get(b.cardKey)?.has(t)).sort(cmp);
        const ww = Math.max(...hitWants.map((t) => row.wants[t]));
        const e: PairEdge = edges.get(k) ?? {
          a: a.cardKey,
          b: b.cardKey,
          rows: [],
          link: 0,
          nonObvious: { aspects: 0, traits: 0, wording: 0, factor: 0 },
          traitOnly: false,
          score: 0,
        };
        e.rows.push({
          row: row.id,
          baseId: row.baseId,
          offer: viaOffer,
          want: hitWants[0],
          weight: r3(row.strength * w * ww),
          reason: row.reason,
        });
        e.link = r3(e.link + row.strength * w * ww);
        edges.set(k, e);
      }
    }
    rowCounts[row.baseId] = (rowCounts[row.baseId] ?? 0) + n;
  }

  const edgeList = [...edges.values()].sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b));
  for (const e of edgeList) {
    e.nonObvious = nonObvious(byKey.get(e.a) as SynergyCard, byKey.get(e.b) as SynergyCard);
    e.traitOnly = e.rows.every((r) => r.baseId === "trait-reference");
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
    exampleChecks,
    rowCounts: Object.fromEntries(
      Object.keys(rowCounts)
        .sort(cmp)
        .map((k) => [k, rowCounts[k]]),
    ),
  };
}

export const edgeOrder = (x: PairEdge, y: PairEdge): number => y.score - x.score || cmp(x.a, y.a) || cmp(x.b, y.b);
