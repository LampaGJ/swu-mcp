import { LEADER_SPLIT_MIN_DECKS, type LeaderCardRow, type LeaderCardsEntry } from "./schema.js";

export { LEADER_SPLIT_MIN_DECKS };

/**
 * @displayName Leader population by base
 * @strategicPurpose Decision D60 (#148): a leader's decklists mostly run one base (50 of The Warrior's 67 community
 * lists run Jundland Wastes), so a builder on another base (Origin Tree) must not be told that build's staples.
 * @tacticalObjective Pure selection over a meta/leader-cards.json entry: the lists with the given base when at least
 * LEADER_SPLIT_MIN_DECKS remain, else the lists whose base has the same aspects at that floor, else all lists with one
 * line naming the counts and the dominant base. No data is read or written here.
 */

export interface LeaderData {
  entry: LeaderCardsEntry;
  byCard: ReadonlyMap<string, LeaderCardRow>;
}

export interface LeaderBaseQuery {
  /** The deck's base. */
  base?: { cardKey: string; title: string; aspects: readonly string[] };
  /** The base's aspect icons alone, when only the aspect set is known (find_pairings with aspects). */
  baseAspects?: readonly string[];
}

export type LeaderScope = "all" | "base" | "aspect";

export interface LeaderSelection {
  scope: LeaderScope;
  /** The base title or the aspect set the lists were narrowed to; "all lists" when not narrowed. */
  label: string;
  decks: number;
  allDecks: number;
  /** One line when the query asked for a base: what was used and, on a fallback, why. Null when no base was asked for. */
  line: string | null;
}

export interface SelectedLeaderData extends LeaderData {
  selection: LeaderSelection;
}

const aspectKey = (aspects: readonly string[]): string => [...aspects].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join("+");

const all = (data: LeaderData, line: string | null): SelectedLeaderData => ({
  ...data,
  selection: { scope: "all", label: "all lists", decks: data.entry.decks, allDecks: data.entry.decks, line },
});

function narrowed(data: LeaderData, kind: "base" | "aspect", key: string, line: string): SelectedLeaderData | null {
  const split = data.entry.splits?.find((s) => s.kind === kind && s.key === key);
  if (split === undefined) return null;
  const entry: LeaderCardsEntry = { ...data.entry, decks: split.decks, weight: split.weight, cards: split.cards };
  return {
    entry,
    byCard: new Map(split.cards.map((c) => [c.cardKey, c])),
    selection: { scope: kind, label: split.label, decks: split.decks, allDecks: data.entry.decks, line },
  };
}

/**
 * The part of a leader's population that plays the given base. Without a base or an aspect set the whole population
 * is returned with no line. The result keeps the entry's shape, so a tool reads it as it read the whole entry.
 */
export function selectLeaderPopulation(data: LeaderData, query: LeaderBaseQuery): SelectedLeaderData {
  const { entry } = data;
  const leaderTitle = entry.leader.title;
  const aspects = query.base?.aspects ?? query.baseAspects;
  if (query.base === undefined && (aspects === undefined || aspects.length === 0)) return all(data, null);
  // A package built before #148 has no per-base counts; it answers as it always did, with the whole population and no line.
  if (entry.baseDecks === undefined) return all(data, null);

  const label = query.base?.title ?? aspectKey(aspects ?? []);
  if (query.base !== undefined) {
    const own = entry.baseDecks.find((b) => b.cardKey === query.base?.cardKey)?.decks ?? 0;
    if (own === entry.decks) return all(data, `all ${entry.decks} ${leaderTitle} lists run ${label}`);
    const hit = narrowed(data, "base", query.base.cardKey, `${own} ${label} lists of ${entry.decks} ${entry.population} ${leaderTitle} lists`);
    if (hit !== null) return hit;
    return widen(data, aspects ?? [], `${own} ${label} lists is under the ${LEADER_SPLIT_MIN_DECKS}-deck floor`);
  }
  return widen(data, aspects ?? [], `no ${label}-base lists reach the ${LEADER_SPLIT_MIN_DECKS}-deck floor on their own`);
}

function widen(data: LeaderData, aspects: readonly string[], reason: string): SelectedLeaderData {
  const { entry } = data;
  const key = aspectKey(aspects);
  const withAspect = (entry.baseDecks ?? []).filter((b) => aspectKey(b.aspects) === key);
  // The builder emits no aspect split when one base carries the aspect (it would repeat that base's split), so that base's split answers.
  const kind = entry.splits?.some((s) => s.kind === "aspect" && s.key === key) ? "aspect" : "base";
  const splitKey = kind === "aspect" ? key : withAspect.length === 1 ? withAspect[0].cardKey : "";
  const hit =
    key === "" || splitKey === ""
      ? null
      : narrowed(data, kind, splitKey, `${reason}; using the ${entry.splits?.find((s) => s.kind === kind && s.key === splitKey)?.decks ?? 0} ${entry.leader.title} lists whose base is ${key}`);
  if (hit !== null) return { ...hit, selection: { ...hit.selection, scope: "aspect", label: key } };
  const dominant = entry.baseDecks?.[0];
  const tail = dominant === undefined ? "" : `, ${dominant.decks} of which run ${dominant.title} (${aspectKey(dominant.aspects) || "neutral"})`;
  return all(data, `${reason}; using all ${entry.decks} ${entry.leader.title} lists${tail}`);
}
