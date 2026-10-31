import { z } from "zod";
import { compareCodePoints, sha256Hex, canonicalJson } from "../swu/canonical.js";
import { clusterDecks, type ClusterDeck, type ClusterOptions } from "./cluster.js";
import {
  LEADER_CARDS_MAX,
  LEADER_SPLIT_MIN_DECKS,
  leaderCardsFileSchema,
  metaFileSchema,
  type Archetype,
  type KeyUnit,
  type LeaderCardsFile,
  type LeaderSplit,
  type MetaFile,
  type Population,
  type ThreatProfile,
} from "./schema.js";

/**
 * @displayName Meta archetype builder
 * @strategicPurpose Manipulation node (reduces): recent decklists in, a ranked list of archetypes with their share,
 * top-8 share, core cards and threat profile out (LampaGJ/swu-mcp#25). Tournament decks are the primary population
 * (owner direction 2026-10-17); community lists are a secondary, labelled view and the fallback when a window holds
 * too few tournament decks.
 * @tacticalObjective Window = the last `days` days up to the newest createdAt. Weight = 1 for a community list and
 * 1 + (1 - (placement - 1) / field) for a tournament deck, so a winner counts about twice a last place. Decks group by
 * leader and base aspect, then split by seeded Jaccard clustering; every number is rounded before it is emitted.
 */

export interface MetaDeck {
  key: string;
  population: Population;
  source: string;
  leader: string;
  base: string;
  cards: [string, number][];
  createdAt: string;
  event: string | null;
  placement: number | null;
  /** Players in the event when the source states it. */
  field: number | null;
  /** The deck's whole-event match record when the source states it (tournament decks from swumetastats). */
  record?: { wins: number; losses: number; draws: number } | null;
}

const featureCardSchema = z.looseObject({
  cardKey: z.string().min(1),
  title: z.string(),
  subtitle: z.string().nullable(),
  type: z.string(),
  structured: z.looseObject({
    cost: z.number().nullable(),
    power: z.number().nullable(),
    hp: z.number().nullable(),
    arenas: z.array(z.string()),
    aspectIcons: z.array(z.string()),
    traits: z.array(z.string()),
  }),
  keywords: z.array(z.looseObject({ keyword: z.string(), granted: z.boolean() })),
  tags: z.looseObject({ offers: z.array(z.looseObject({ tag: z.string() })) }),
});

export interface CardFact {
  cardKey: string;
  title: string;
  type: string;
  cost: number | null;
  power: number | null;
  hp: number | null;
  arenas: string[];
  aspectIcons: string[];
  traits: string[];
  keywords: string[];
  offers: string[];
}

export const cardLabelOf = (title: string, subtitle: string | null): string =>
  subtitle === null || subtitle === "" ? title : `${title}, ${subtitle}`;

export function cardFacts(features: unknown): Map<string, CardFact> {
  const rows = z.array(featureCardSchema).parse(features);
  return new Map(
    rows.map((r) => [
      r.cardKey,
      {
        cardKey: r.cardKey,
        title: cardLabelOf(r.title, r.subtitle),
        type: r.type,
        cost: r.structured.cost,
        power: r.structured.power,
        hp: r.structured.hp,
        arenas: r.structured.arenas,
        aspectIcons: r.structured.aspectIcons,
        traits: r.structured.traits,
        keywords: [...new Set(r.keywords.filter((k) => !k.granted).map((k) => k.keyword))].sort(compareCodePoints),
        offers: [...new Set(r.tags.offers.map((t) => t.tag).filter((t) => !t.startsWith("offers:is-trait-")))].sort(compareCodePoints),
      },
    ]),
  );
}

export interface MetaOptions extends ClusterOptions {
  days: number;
  minTournamentDecks: number;
  coreListed: number;
  keyUnits: number;
}

export const DEFAULT_META_OPTIONS: MetaOptions = {
  seed: "meta-archetypes-v1",
  joinJaccard: 0.4,
  coreInclusion: 0.5,
  minDecks: 5,
  rounds: 8,
  days: 90,
  minTournamentDecks: 200,
  coreListed: 20,
  keyUnits: 8,
};

export const WEIGHTING =
  "community list 1; tournament deck 1 + (1 - (placement - 1) / field), field = the stated player count, else the most decks or the worst placement seen for the event";

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const r2 = (x: number): number => Math.round(x * 100) / 100 || 0;

const dayNumber = (isoDate: string): number =>
  Math.round(Date.UTC(+isoDate.slice(0, 4), +isoDate.slice(5, 7) - 1, +isoDate.slice(8, 10)) / 864e5);
const isoOf = (day: number): string => new Date(day * 864e5).toISOString().slice(0, 10);

export function windowOf(decks: readonly MetaDeck[], days: number): { from: string; to: string; days: number } {
  const newest = decks
    .map((d) => d.createdAt.slice(0, 10))
    .sort(compareCodePoints)
    .at(-1);
  if (newest === undefined) throw new Error("no dated decks to take a window from");
  return { from: isoOf(dayNumber(newest) - (days - 1)), to: newest, days };
}

/** Placement weight per deck key; field size is estimated from the decks seen for the event. */
export function deckWeights(decks: readonly MetaDeck[]): Map<string, number> {
  const field = new Map<string, number>();
  for (const d of decks) if (d.event !== null) field.set(d.event, Math.max(field.get(d.event) ?? 0, d.placement ?? 0, d.field ?? 0));
  const counts = new Map<string, number>();
  for (const d of decks) if (d.event !== null) counts.set(d.event, (counts.get(d.event) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const d of decks) {
    if (d.population !== "tournament" || d.placement === null || d.event === null) {
      out.set(d.key, 1);
      continue;
    }
    const size = Math.max(field.get(d.event) ?? 1, counts.get(d.event) ?? 1, 1);
    out.set(d.key, 1 + (size <= 1 ? 1 : 1 - (d.placement - 1) / size));
  }
  return out;
}

const KEYWORDS_TRACKED = [
  "Ambush",
  "Bounty",
  "Coordinate",
  "Exploit",
  "Grit",
  "Hidden",
  "Overwhelm",
  "Piloting",
  "Raid",
  "Restore",
  "Saboteur",
  "Sentinel",
  "Shielded",
  "Smuggle",
];
const costBucket = (cost: number | null): string => (cost === null ? "-" : cost >= 7 ? "7+" : String(cost));

interface Weighted {
  deck: MetaDeck;
  weight: number;
}

function meanCopies(members: readonly Weighted[]): { copies: Map<string, number>; inclusion: Map<string, number>; total: number } {
  const total = members.reduce((s, m) => s + m.weight, 0);
  const copies = new Map<string, number>();
  const inclusion = new Map<string, number>();
  for (const m of members) {
    for (const [card, count] of m.deck.cards) {
      copies.set(card, (copies.get(card) ?? 0) + (m.weight * count) / total);
      inclusion.set(card, (inclusion.get(card) ?? 0) + m.weight / total);
    }
  }
  return { copies, inclusion, total };
}

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export function threatProfile(
  members: readonly Weighted[],
  leader: CardFact | undefined,
  facts: ReadonlyMap<string, CardFact>,
  keyUnitCount: number,
): ThreatProfile {
  const { copies, inclusion } = meanCopies(members);
  let known = 0;
  let units = 0;
  let events = 0;
  let upgrades = 0;
  let ground = 0;
  let space = 0;
  let costSum = 0;
  let costed = 0;
  let cheap = 0;
  const cheapHp: number[] = [];
  const curve = new Map<string, number>();
  const keywords = new Map<string, number>();
  const offers = new Map<string, number>();
  const ordered = [...copies].sort((a, b) => compareCodePoints(a[0], b[0]));
  for (const [card, mean] of ordered) {
    const f = facts.get(card);
    if (f === undefined) continue;
    known += mean;
    if (f.type === "Unit") units += mean;
    if (f.type === "Event") events += mean;
    if (f.type === "Upgrade" || f.keywords.includes("Piloting")) upgrades += mean;
    if (f.type === "Unit") {
      if (f.arenas.includes("Space")) space += mean;
      else ground += mean;
      if (f.cost !== null && f.cost <= 2) {
        cheap += mean;
        if (f.hp !== null && (inclusion.get(card) ?? 0) >= 0.25) cheapHp.push(f.hp);
      }
    }
    if (f.cost !== null) {
      costSum += f.cost * mean;
      costed += mean;
    }
    curve.set(costBucket(f.cost), (curve.get(costBucket(f.cost)) ?? 0) + mean);
    for (const k of f.keywords) if (KEYWORDS_TRACKED.includes(k)) keywords.set(k, (keywords.get(k) ?? 0) + mean);
    for (const o of f.offers) offers.set(o, (offers.get(o) ?? 0) + mean);
  }
  const keyUnits: KeyUnit[] = ordered
    .filter(([card]) => facts.get(card)?.type === "Unit" && (inclusion.get(card) ?? 0) >= 0.5)
    .map(([card, mean]) => ({ f: facts.get(card) as CardFact, mean, inc: inclusion.get(card) as number }))
    .sort((a, b) => b.mean - a.mean || (b.f.cost ?? 0) - (a.f.cost ?? 0) || compareCodePoints(a.f.cardKey, b.f.cardKey))
    .slice(0, keyUnitCount)
    .map(({ f, mean, inc }) => ({
      cardKey: f.cardKey,
      title: f.title,
      cost: f.cost,
      power: f.power,
      hp: f.hp,
      arenas: f.arenas,
      keywords: f.keywords,
      traits: f.traits,
      meanCopies: r2(mean),
      inclusion: r4(inc),
    }));
  const record = (m: Map<string, number>): Record<string, number> =>
    Object.fromEntries([...m].sort((a, b) => compareCodePoints(a[0], b[0])).map(([k, v]) => [k, r2(v)]));
  const curveOrder = ["0", "1", "2", "3", "4", "5", "6", "7+", "-"];
  return {
    cardsKnown: r2(known),
    units: r2(units),
    events: r2(events),
    upgrades: r2(upgrades),
    arena: { ground: r2(ground), space: r2(space), spaceShare: ground + space === 0 ? 0 : r4(space / (ground + space)) },
    curve: Object.fromEntries(curveOrder.filter((b) => curve.has(b)).map((b) => [b, r2(curve.get(b) as number)])),
    meanCost: costed === 0 ? null : r2(costSum / costed),
    keywords: record(keywords),
    offers: record(offers),
    cheapUnits: r2(cheap),
    cheapUnitMedianHp: median(cheapHp),
    leader: { power: leader?.power ?? null, hp: leader?.hp ?? null, arenas: leader?.arenas ?? [] },
    keyUnits,
  };
}

function archetypesOf(
  population: Population,
  decks: readonly MetaDeck[],
  weights: ReadonlyMap<string, number>,
  facts: ReadonlyMap<string, CardFact>,
  window: { from: string; to: string },
  options: MetaOptions,
): { archetypes: Omit<Archetype, "id">[]; clustered: number } {
  const groups = new Map<string, MetaDeck[]>();
  const baseAspectsOf = (d: MetaDeck): string[] => facts.get(d.base)?.aspectIcons ?? [];
  for (const d of decks) {
    const key = `${d.leader}|${baseAspectsOf(d).join("+")}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const totalWeight = decks.reduce((s, d) => s + (weights.get(d.key) ?? 1), 0);
  const top8Total = decks.filter((d) => d.placement !== null && d.placement <= 8).length;
  const out: Omit<Archetype, "id">[] = [];
  let clustered = 0;
  for (const groupKey of [...groups.keys()].sort(compareCodePoints)) {
    const members = (groups.get(groupKey) as MetaDeck[]).slice().sort((a, b) => compareCodePoints(a.key, b.key));
    const clusterInput: ClusterDeck[] = members.map((d) => ({
      key: d.key,
      cards: d.cards.map(([c]) => c),
      weight: weights.get(d.key) ?? 1,
    }));
    const clusters = clusterDecks(clusterInput, { ...options, seed: `${options.seed}|${population}|${groupKey}` });
    const coreSets = clusters.map((c) => new Set(c.core));
    clusters.forEach((cluster, index) => {
      const ms = cluster.members.map((i) => members[i]);
      clustered += ms.length;
      const weighted = ms.map((deck) => ({ deck, weight: weights.get(deck.key) ?? 1 }));
      const { copies, inclusion } = meanCopies(weighted);
      const leader = facts.get(ms[0].leader);
      const baseAspects = baseAspectsOf(ms[0]);
      const weight = weighted.reduce((s, m) => s + m.weight, 0);
      const top8 = ms.filter((d) => d.placement !== null && d.placement <= 8).length;
      const baseCounts = new Map<string, number>();
      for (const d of ms) baseCounts.set(d.base, (baseCounts.get(d.base) ?? 0) + 1);
      const core = [...inclusion]
        .filter(([card]) => facts.has(card))
        .sort((a, b) => b[1] - a[1] || (copies.get(b[0]) ?? 0) - (copies.get(a[0]) ?? 0) || compareCodePoints(a[0], b[0]))
        .slice(0, options.coreListed)
        .map(([card, inc]) => ({
          cardKey: card,
          title: (facts.get(card) as CardFact).title,
          inclusion: r4(inc),
          meanCopies: r2(copies.get(card) ?? 0),
        }));
      let label = "";
      if (clusters.length > 1) {
        const others = coreSets.filter((_, j) => j !== index);
        const distinctive = cluster.core.filter((c) => facts.get(c) !== undefined && others.every((o) => !o.has(c)));
        const pick = distinctive.sort((a, b) => (inclusion.get(b) ?? 0) - (inclusion.get(a) ?? 0) || compareCodePoints(a, b))[0];
        label = pick === undefined ? ` (variant ${index + 1})` : `, signature ${(facts.get(pick) as CardFact).title}`;
      }
      out.push({
        name: `${leader?.title ?? ms[0].leader} / ${baseAspects.join("+") || "neutral"} base${label}`,
        population,
        leader: { cardKey: ms[0].leader, title: leader?.title ?? ms[0].leader, aspects: leader?.aspectIcons ?? [] },
        baseAspects,
        bases: [...baseCounts]
          .sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]))
          .slice(0, 3)
          .map(([cardKey, n]) => ({ cardKey, title: facts.get(cardKey)?.title ?? cardKey, decks: n })),
        decks: ms.length,
        weight: r2(weight),
        share: r4(weight / totalWeight),
        top8,
        top8Share: top8Total === 0 ? null : r4(top8 / top8Total),
        window: { from: window.from, to: window.to },
        cohesion: r4(cluster.cohesion),
        core,
        profile: threatProfile(weighted, leader, facts, options.keyUnits),
      });
    });
  }
  return { archetypes: out, clustered };
}

function inWindowOf(allDecks: readonly MetaDeck[], window: { from: string; to: string }): MetaDeck[] {
  return allDecks.filter((d) => {
    const day = d.createdAt.slice(0, 10);
    return compareCodePoints(day, window.from) >= 0 && compareCodePoints(day, window.to) <= 0;
  });
}

export function buildMeta(
  allDecks: readonly MetaDeck[],
  facts: ReadonlyMap<string, CardFact>,
  options: MetaOptions = DEFAULT_META_OPTIONS,
): MetaFile {
  const window = windowOf(allDecks, options.days);
  const inWindow = inWindowOf(allDecks, window);
  const weights = deckWeights(inWindow);
  const byPopulation = (p: Population): MetaDeck[] => inWindow.filter((d) => d.population === p);
  const tournament = byPopulation("tournament");
  const fallback = tournament.length < options.minTournamentDecks;
  const primary: Population = fallback ? "community" : "tournament";

  const populations: MetaFile["populations"] = [];
  const archetypes: Archetype[] = [];
  for (const population of [primary, primary === "tournament" ? "community" : "tournament"] as Population[]) {
    const decks = byPopulation(population);
    if (decks.length === 0) continue;
    const built = archetypesOf(population, decks, weights, facts, window, options);
    const ranked = built.archetypes.sort((a, b) => b.share - a.share || b.decks - a.decks || compareCodePoints(a.name, b.name));
    ranked.forEach((a, i) => {
      const id = `${population === "tournament" ? "t" : "c"}${String(i + 1).padStart(3, "0")}-${sha256Hex(canonicalJson([population, a.leader.cardKey, a.baseAspects, a.core.map((c) => c.cardKey)])).slice(0, 6)}`;
      archetypes.push({ id, ...a });
    });
    const sources = new Map<string, number>();
    for (const d of decks) sources.set(d.source, (sources.get(d.source) ?? 0) + 1);
    populations.push({
      population,
      decks: decks.length,
      weight: r2(decks.reduce((s, d) => s + (weights.get(d.key) ?? 1), 0)),
      top8: decks.filter((d) => d.placement !== null && d.placement <= 8).length,
      events: new Set(decks.filter((d) => d.event !== null).map((d) => d.event)).size,
      sources: Object.fromEntries([...sources].sort((a, b) => compareCodePoints(a[0], b[0]))),
      archetypes: ranked.length,
      clustered: built.clustered,
    });
  }

  return metaFileSchema.parse({
    schemaVersion: 1,
    window,
    primary,
    fallback,
    method: {
      seed: options.seed,
      joinJaccard: options.joinJaccard,
      coreInclusion: options.coreInclusion,
      minDecks: options.minDecks,
      rounds: options.rounds,
      weighting: WEIGHTING,
    },
    populations,
    archetypes,
  });
}

export const LEADER_CARDS_BASELINE =
  "baselineInclusion = placement-weighted inclusion of the card across every deck of the same population in the window whose leader and base aspect icons cover the card's aspect icons (decks that could play it without an aspect penalty); lift = inclusion - baselineInclusion";

const iconCounts = (icons: readonly string[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const icon of icons) out.set(icon, (out.get(icon) ?? 0) + 1);
  return out;
};

interface IconGroup {
  supplied: Map<string, number>;
  weight: number;
  inclusion: Map<string, number>;
}

/** Baseline inclusion of a card: weighted share among the decks whose leader and base icons cover the card's icons. */
function baselineOf(decks: readonly MetaDeck[], weights: ReadonlyMap<string, number>, facts: ReadonlyMap<string, CardFact>) {
  const groups = new Map<string, IconGroup>();
  for (const d of [...decks].sort((a, b) => compareCodePoints(a.key, b.key))) {
    const icons = [...(facts.get(d.leader)?.aspectIcons ?? []), ...(facts.get(d.base)?.aspectIcons ?? [])].sort(compareCodePoints);
    const key = icons.join("+");
    const group = groups.get(key) ?? { supplied: iconCounts(icons), weight: 0, inclusion: new Map<string, number>() };
    const w = weights.get(d.key) ?? 1;
    group.weight += w;
    for (const [card] of d.cards) group.inclusion.set(card, (group.inclusion.get(card) ?? 0) + w);
    groups.set(key, group);
  }
  const ordered = [...groups].sort((a, b) => compareCodePoints(a[0], b[0])).map(([, g]) => g);
  const covering = new Map<string, IconGroup[]>();
  return (card: CardFact): number => {
    const needKey = [...card.aspectIcons].sort(compareCodePoints).join("+");
    let hit = covering.get(needKey);
    if (hit === undefined) {
      const need = iconCounts(card.aspectIcons);
      hit = ordered.filter((g) => [...need].every(([icon, n]) => (g.supplied.get(icon) ?? 0) >= n));
      covering.set(needKey, hit);
    }
    const weight = hit.reduce((s, g) => s + g.weight, 0);
    return weight === 0 ? 0 : hit.reduce((s, g) => s + (g.inclusion.get(card.cardKey) ?? 0), 0) / weight;
  };
}

/**
 * Manipulation node (reduces), #19: per leader, the placement-weighted inclusion and mean copies of every card over all
 * of the leader's decks in the meta window, against the card's baseline among aspect-eligible decks of the same
 * population. Tournament decks only, unless the leader has none in the window (then community, flagged fallback).
 */
export function buildLeaderCards(
  allDecks: readonly MetaDeck[],
  facts: ReadonlyMap<string, CardFact>,
  options: MetaOptions = DEFAULT_META_OPTIONS,
): LeaderCardsFile {
  const window = windowOf(allDecks, options.days);
  const inWindow = inWindowOf(allDecks, window);
  const weights = deckWeights(inWindow);
  const byPopulation = new Map(
    (["tournament", "community"] as Population[]).map((p) => {
      const decks = inWindow.filter((d) => d.population === p);
      return [p, { decks, baseline: baselineOf(decks, weights, facts) }] as const;
    }),
  );
  const leaders = [...new Set(inWindow.map((d) => d.leader))].sort(compareCodePoints);
  const entries = leaders.map((leaderKey) => {
    const tournament = (byPopulation.get("tournament") as { decks: MetaDeck[] }).decks.filter((d) => d.leader === leaderKey);
    const population: Population = tournament.length > 0 ? "tournament" : "community";
    const pop = byPopulation.get(population) as { decks: MetaDeck[]; baseline: (card: CardFact) => number };
    const members = (population === "tournament" ? tournament : pop.decks.filter((d) => d.leader === leaderKey))
      .slice()
      .sort((a, b) => compareCodePoints(a.key, b.key));
    const rowsOf = (group: readonly MetaDeck[]) => {
      const weighted = group.map((deck) => ({ deck, weight: weights.get(deck.key) ?? 1 }));
      const { copies, inclusion, total } = meanCopies(weighted);
      const cards = [...inclusion]
        .filter(([card]) => facts.has(card))
        .map(([card, inc]) => {
          const f = facts.get(card) as CardFact;
          const included = r4(inc);
          const baselineInclusion = r4(pop.baseline(f));
          return {
            cardKey: card,
            title: f.title,
            inclusion: included,
            meanCopies: r2(copies.get(card) ?? 0),
            baselineInclusion,
            lift: r4(included - baselineInclusion),
          };
        })
        .sort((a, b) => b.inclusion - a.inclusion || compareCodePoints(a.cardKey, b.cardKey))
        .slice(0, LEADER_CARDS_MAX);
      return { cards, total };
    };
    const { cards, total } = rowsOf(members);
    const baseCounts = new Map<string, number>();
    for (const d of members) baseCounts.set(d.base, (baseCounts.get(d.base) ?? 0) + 1);
    const ranked = [...baseCounts].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]));
    const top = ranked[0];
    const leader = facts.get(leaderKey);
    const aspectsOf = (baseKey: string): string[] => facts.get(baseKey)?.aspectIcons ?? [];
    const baseDecks = ranked.map(([baseKey, decks]) => ({ cardKey: baseKey, title: facts.get(baseKey)?.title ?? baseKey, aspects: aspectsOf(baseKey), decks }));
    // #148: a split is emitted only at the decks floor, and an aspect split only when it spans more than one base (else it repeats the base split).
    const splits: LeaderSplit[] = [];
    const addSplit = (kind: "base" | "aspect", key: string, label: string, group: readonly MetaDeck[]): void => {
      if (group.length < LEADER_SPLIT_MIN_DECKS || group.length === members.length) return;
      const { cards: splitCards, total: splitTotal } = rowsOf(group);
      splits.push({ kind, key, label, decks: group.length, weight: r2(splitTotal), cards: splitCards });
    };
    for (const b of baseDecks) addSplit("base", b.cardKey, b.title, members.filter((d) => d.base === b.cardKey));
    const aspectKey = (aspects: readonly string[]): string => [...aspects].sort(compareCodePoints).join("+");
    for (const key of [...new Set(baseDecks.map((b) => aspectKey(b.aspects)))].sort(compareCodePoints)) {
      const bases = baseDecks.filter((b) => aspectKey(b.aspects) === key);
      if (key !== "" && bases.length > 1) addSplit("aspect", key, key, members.filter((d) => bases.some((b) => b.cardKey === d.base)));
    }
    return {
      leader: { cardKey: leaderKey, title: leader?.title ?? leaderKey, aspects: leader?.aspectIcons ?? [] },
      population,
      fallback: population !== "tournament",
      decks: members.length,
      weight: r2(total),
      window: { from: window.from, to: window.to },
      topBase: top === undefined ? null : { cardKey: top[0], title: facts.get(top[0])?.title ?? top[0], decks: top[1] },
      cards,
      baseDecks,
      splits,
    };
  });
  return leaderCardsFileSchema.parse({
    schemaVersion: 1,
    window,
    weighting: WEIGHTING,
    baseline: LEADER_CARDS_BASELINE,
    maxCards: LEADER_CARDS_MAX,
    leaders: entries,
  });
}
