import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";
import type { CardOutcomes, TournamentResults, WinRatesFile } from "./schema.js";

/**
 * @displayName Meta outcome aggregation
 * @strategicPurpose Win rates behind meta_answers and archetype strength, ranked by how close they are to real
 * competitive play (owner direction 2026-10-17): tournament matchups first, tournament match results with decklists
 * (LampaGJ/swu-mcp#26) next for card-level rates, human Karabast games last and labelled. Bot simulations are never
 * read. Only aggregates leave this module: counts per leader pair and per (card, opponent leader), never a game.
 * @tacticalObjective Parses the pinned swumetastats capture, resolves leader and base names to cardKeys and base
 * aspects, and folds game sides into wins and n per opponent leader; card rows under minN are dropped.
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
): NonNullable<WinRatesFile["matchups"]> {
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
    source: "swumetastats-matchups",
    label: "tournament matchups (melee.gg Premier events via swumetastats.com), aggregate per leader and base",
    period: { from: period.from, to: period.to },
    rows: response.matchups.length,
    unresolvedRows: unresolved,
    // Each match is listed once from each side.
    matches: Math.round(matches / 2),
    pairs: [...pairs.keys()].sort(compareCodePoints).map((k) => pairs.get(k) as NonNullable<WinRatesFile["matchups"]>["pairs"][number]),
  };
}

export interface OutcomeSide {
  leader: string | null;
  won: 0 | 1 | null;
  cards: readonly string[];
}

/** Two sides of one game or match; each side's cards are counted against the other side's leader. */
export type OutcomeGame = readonly [OutcomeSide, OutcomeSide];

export function foldCardOutcomes(
  games: Iterable<OutcomeGame>,
  meta: { source: CardOutcomes["source"]; rank: number; label: string; basis: string; period: CardOutcomes["period"] },
  leaders: ReadonlySet<string>,
  minN: number,
): CardOutcomes {
  const against = new Map<string, { wins: number; n: number; cards: Map<string, { wins: number; n: number }> }>();
  let sides = 0;
  for (const game of games) {
    for (const [self, other] of [
      [game[0], game[1]],
      [game[1], game[0]],
    ] as const) {
      if (self.won === null || other.leader === null || !leaders.has(other.leader)) continue;
      sides += 1;
      const entry = against.get(other.leader) ?? { wins: 0, n: 0, cards: new Map() };
      entry.wins += self.won;
      entry.n += 1;
      for (const card of new Set(self.cards)) {
        const c = entry.cards.get(card) ?? { wins: 0, n: 0 };
        c.wins += self.won;
        c.n += 1;
        entry.cards.set(card, c);
      }
      against.set(other.leader, entry);
    }
  }
  return {
    ...meta,
    sides,
    byLeader: [...against.keys()].sort(compareCodePoints).map((leader) => {
      const e = against.get(leader) as { wins: number; n: number; cards: Map<string, { wins: number; n: number }> };
      return {
        leader,
        against: { wins: e.wins, n: e.n },
        cards: [...e.cards]
          .filter(([, c]) => c.n >= minN)
          .sort((a, b) => compareCodePoints(a[0], b[0]))
          .map(([cardKey, c]) => ({ cardKey, wins: c.wins, n: c.n })),
      };
    }),
  };
}

export function tournamentGames(results: TournamentResults): OutcomeGame[] {
  return results.matches.map((m) => {
    const side = (i: 0 | 1): OutcomeSide => ({
      leader: m.sides[i].leader,
      won: m.winner === null ? null : m.winner === i ? 1 : 0,
      cards: m.sides[i].cards.map(([c]) => c),
    });
    return [side(0), side(1)] as const;
  });
}
