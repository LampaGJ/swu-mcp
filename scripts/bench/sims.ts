/**
 * @displayName Engine-simulation game join
 * @strategicPurpose forceteki bot-vs-bot game records name decks, not cards; joined to the decklists they were
 * loaded from, they give a deck-level win/loss signal that is separate from (and biased unlike) human play.
 * @tacticalObjective Parses only the record header (everything before initialState) and joins each player's deck
 * by (normalised name, leader, base); a name shared by several lists keeps the candidates its opening hand fits,
 * so a later card-membership test can still use the side when every candidate agrees.
 */
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { normalizeName } from "./card-map.js";

const simPlayer = z.looseObject({
  deckId: z.string(),
  deckName: z.string(),
  leaderId: z.string(),
  baseId: z.string(),
  cardsPlayed: z.number().optional(),
});

export const simHeaderSchema = z.looseObject({
  gameId: z.string(),
  timestamp: z.string(),
  format: z.string().optional(),
  player1: simPlayer,
  player2: simPlayer,
  winner: z.union([z.number(), z.string(), z.null()]).optional(),
  winReason: z.string().optional(),
  turnCount: z.number().optional(),
});
export type SimHeader = z.infer<typeof simHeaderSchema>;

export function parseSimHeader(line: string): SimHeader | null {
  const cut = line.indexOf(',"initialState":');
  try {
    const parsed = simHeaderSchema.safeParse(JSON.parse(cut < 0 ? line : `${line.slice(0, cut)}}`));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type SimDeckIndex = Map<string, string[]>;

const joinKey = (name: string, leader: string, base: string): string => `${normalizeName(name)}\u0000${leader}\u0000${base}`;

export function buildSimDeckIndex(
  decks: readonly { key: string; leader: string | null; base: string | null; names: readonly string[] }[],
): SimDeckIndex {
  const index: SimDeckIndex = new Map();
  for (const d of decks) {
    if (d.leader === null || d.base === null) continue;
    for (const name of d.names) {
      const k = joinKey(name, d.leader, d.base);
      index.set(k, [...(index.get(k) ?? []), d.key]);
    }
  }
  return index;
}

export type SimJoin = { deck: string } | { ambiguous: string[] } | { unknown: true };

export function matchSimDeck(
  index: SimDeckIndex,
  byId: ReadonlyMap<string, string>,
  p: { deckName: string; leaderId: string; baseId: string },
): SimJoin {
  const leader = byId.get(p.leaderId);
  const base = byId.get(p.baseId);
  if (leader === undefined || base === undefined) return { unknown: true };
  const hits = [...new Set(index.get(joinKey(p.deckName, leader, base)) ?? [])];
  if (hits.length === 0) return { unknown: true };
  return hits.length === 1 ? { deck: hits[0] } : { ambiguous: hits.sort(compareCodePoints) };
}

const MULLIGAN = /"player":(\d),"type":"mulligan"[^[]*?"preActionHand":\[(.*?)\],"hasPlayableTurn1Card"/g;

/** Each player's hand before their mulligan decision, as engine card slugs, read without parsing the action log. */
export function openingHands(line: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const m of line.matchAll(MULLIGAN)) {
    const player = Number(m[1]);
    if (!out.has(player))
      out.set(
        player,
        [...m[2].matchAll(/"cardId":"([^"]+)"/g)].map((x) => x[1]),
      );
  }
  return out;
}

/** The candidate lists that hold a printing of every hand card whose slug resolves. */
export function disambiguateByHand(
  candidates: readonly string[],
  hand: readonly string[],
  slugs: ReadonlyMap<string, readonly string[]>,
  deckCards: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const resolved = hand.map((slug) => slugs.get(slug)).filter((keys): keys is readonly string[] => keys !== undefined);
  const fits = candidates.filter((deck) => {
    const cards = deckCards.get(deck);
    return cards !== undefined && resolved.every((keys) => keys.some((k) => cards.has(k)));
  });
  return fits;
}
