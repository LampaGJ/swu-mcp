import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import type { CardFact, MetaDeck } from "./build.js";
import { SWUMETASTATS_SOURCE, type DeckEvidence, type Matchups } from "./schema.js";

/**
 * @displayName Meta outcome aggregation
 * @strategicPurpose Win rates behind archetype strength and meta_answers, from swumetastats.com's melee.gg tournament
 * data only (decision D22, owner ruling 2026-10-17): leader+base matchups for archetype strength, and decklists with
 * their whole-event match record for answer-card evidence. Karabast games and bot simulations are never read here.
 * @tacticalObjective Parses the pinned matchup capture, resolves leader and base names to cardKeys and base aspects,
 * and folds tournament decks into W-L-D per comparable-deck group (same leader and base aspects; same aspect set)
 * and per card in that group; a card row needs minN matches both with and without the card.
 */

const matchupRowSchema = z.looseObject({
  leader: z.string(),
  base: z.string(),
  aspect: z.string().nullish(),
  opponentLeader: z.string(),
  opponentBase: z.string(),
  opponentAspect: z.string().nullish(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  draws: z.number().int().nonnegative(),
});

export const matchupResponseSchema = z.looseObject({
  matchups: z.array(matchupRowSchema),
  leaderSets: z.record(z.string(), z.string()).optional(),
});
export type MatchupResponse = z.infer<typeof matchupResponseSchema>;

export const matchupCaptureSchema = z.looseObject({
  kind: z.literal("swumetastats-matchups"),
  window: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export interface NameResolver {
  /** Leader cardKey for a display name ("Title" or "Title | Subtitle") and the set code swumetastats gives it. */
  leader(name: string, set: string | undefined): string | null;
  /** Aspect icons of a base by name; null when the name does not resolve. */
  baseAspects(name: string): string[] | null;
}

const ASPECTS = new Set(["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"]);

/** The row's own base-aspect word when the base name did not resolve; "Unknown" stays unresolved. */
const aspectWord = (word: string | null | undefined): string[] | null => {
  const w = (word ?? "").trim();
  if (/^neutral$/i.test(w)) return [];
  return ASPECTS.has(w) ? [w] : null;
};

export function foldMatchups(
  response: MatchupResponse,
  resolve: NameResolver,
  period: { from: string; to: string },
): Matchups {
  const sets = response.leaderSets ?? {};
  const pairs = new Map<
    string,
    { leader: string; baseAspects: string[]; oppLeader: string; oppBaseAspects: string[]; wins: number; losses: number; draws: number }
  >();
  let unresolved = 0;
  let matches = 0;
  for (const row of response.matchups) {
    const leader = resolve.leader(row.leader, sets[row.leader]);
    const oppLeader = resolve.leader(row.opponentLeader, sets[row.opponentLeader]);
    const baseAspects = resolve.baseAspects(row.base) ?? aspectWord(row.aspect);
    const oppBaseAspects = resolve.baseAspects(row.opponentBase) ?? aspectWord(row.opponentAspect);
    if (leader === null || oppLeader === null || baseAspects === null || oppBaseAspects === null) {
      unresolved += 1;
      continue;
    }
    const key = [leader, baseAspects.join("+"), oppLeader, oppBaseAspects.join("+")].join("|");
    const cur = pairs.get(key) ?? { leader, baseAspects, oppLeader, oppBaseAspects, wins: 0, losses: 0, draws: 0 };
    cur.wins += row.wins;
    cur.losses += row.losses;
    cur.draws += row.draws;
    pairs.set(key, cur);
    matches += row.wins + row.losses + row.draws;
  }
  return {
    source: SWUMETASTATS_SOURCE,
    label: "tournament matchups (melee.gg Premier events via swumetastats.com), aggregate per leader and base",
    period: { from: period.from, to: period.to },
    rows: response.matchups.length,
    unresolvedRows: unresolved,
    // Each match is listed once from each side.
    matches: Math.round(matches / 2),
    pairs: [...pairs.keys()].sort(compareCodePoints).map((k) => pairs.get(k) as Matchups["pairs"][number]),
  };
}

export interface MatchRecord {
  wins: number;
  losses: number;
  draws: number;
}

/** "W-L-D" as melee.gg and swumetastats print it; anything else is no record. */
export function parseMatchRecord(text: string | null | undefined): MatchRecord | null {
  const m = /^\s*(\d+)-(\d+)-(\d+)\s*$/.exec(text ?? "");
  return m === null ? null : { wins: Number(m[1]), losses: Number(m[2]), draws: Number(m[3]) };
}

export const archetypeEvidenceKey = (leader: string, baseAspects: readonly string[]): string => `${leader}|${baseAspects.join("+")}`;
export const aspectsEvidenceKey = (aspects: readonly string[]): string => `aspects:${[...aspects].sort(compareCodePoints).join("+")}`;

type Group = DeckEvidence["groups"][number];
interface Tally extends MatchRecord {
  decks: number;
}

const add = (t: Tally, r: MatchRecord): void => {
  t.decks += 1;
  t.wins += r.wins;
  t.losses += r.losses;
  t.draws += r.draws;
};
const matchesOf = (t: MatchRecord): number => t.wins + t.losses + t.draws;
/** Decisive matches, the n behind a win rate (swumetastats' own convention: draws are left out). */
const decisive = (t: MatchRecord): number => t.wins + t.losses;

export function foldDeckEvidence(
  decks: readonly MetaDeck[],
  facts: ReadonlyMap<string, CardFact>,
  window: { from: string; to: string },
  minN: number,
): DeckEvidence {
  const groups = new Map<string, Omit<Group, "cards"> & { cards: Map<string, Tally> }>();
  const events = new Set<string>();
  let used = 0;
  let matches = 0;
  for (const d of decks) {
    const day = d.createdAt.slice(0, 10);
    if (d.population !== "tournament" || d.record === undefined || d.record === null) continue;
    if (compareCodePoints(day, window.from) < 0 || compareCodePoints(day, window.to) > 0) continue;
    const record = d.record;
    used += 1;
    matches += matchesOf(record);
    if (d.event !== null) events.add(d.event);
    const baseAspects = facts.get(d.base)?.aspectIcons ?? [];
    const aspects = [...(facts.get(d.leader)?.aspectIcons ?? []), ...baseAspects].sort(compareCodePoints);
    const targets: (Omit<Group, "cards" | "decks" | "wins" | "losses" | "draws"> & { key: string })[] = [
      { level: "archetype", key: archetypeEvidenceKey(d.leader, baseAspects), leader: d.leader, baseAspects, aspects },
      { level: "aspects", key: aspectsEvidenceKey(aspects), leader: null, baseAspects: null, aspects },
    ];
    for (const t of targets) {
      const g = groups.get(t.key) ?? { ...t, decks: 0, wins: 0, losses: 0, draws: 0, cards: new Map<string, Tally>() };
      add(g, record);
      for (const [card] of d.cards) {
        const c = g.cards.get(card) ?? { decks: 0, wins: 0, losses: 0, draws: 0 };
        add(c, record);
        g.cards.set(card, c);
      }
      groups.set(t.key, g);
    }
  }
  const out: Group[] = [];
  for (const key of [...groups.keys()].sort(compareCodePoints)) {
    const g = groups.get(key) as Omit<Group, "cards"> & { cards: Map<string, Tally> };
    const total = decisive(g);
    const cards = [...g.cards]
      .filter(([, c]) => decisive(c) >= minN && total - decisive(c) >= minN)
      .sort((a, b) => compareCodePoints(a[0], b[0]))
      .map(([cardKey, c]) => ({ cardKey, decks: c.decks, wins: c.wins, losses: c.losses, draws: c.draws }));
    if (cards.length === 0) continue;
    out.push({ ...g, cards });
  }
  return {
    source: SWUMETASTATS_SOURCE,
    label: "tournament decklists with their match record (melee.gg Premier events via swumetastats.com)",
    basis: "card in the deck's main deck; record = the deck's whole-event match wins-losses-draws",
    opponents:
      "unknown: swumetastats publishes no per-match pairings, so each record is against the deck's whole field, never against one archetype",
    window: { from: window.from, to: window.to },
    decks: used,
    events: events.size,
    matches,
    groups: out,
  };
}
