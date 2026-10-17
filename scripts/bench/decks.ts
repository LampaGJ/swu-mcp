/**
 * @displayName Decklist normaliser
 * @strategicPurpose Community decklists arrive as printing ids from several snapshots that overlap; co-inclusion
 * needs each distinct list once, on logical cards, with the dates that decide which cards it could contain.
 * @tacticalObjective Maps SET_NNN ids to cardKeys, sums copies across printings, hashes the canonical list
 * (leader, base, main deck), and merges duplicates keeping every snapshot and the earliest createdAt. The author
 * field is never copied.
 */
import { z } from "zod";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";

const entry = z.looseObject({ id: z.string().min(1), count: z.number().int().positive().optional() });

export const deckFileSchema = z.looseObject({
  metadata: z
    .looseObject({
      createdAt: z.string().optional(),
      source: z.string().optional(),
      idea_source: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  leader: entry,
  base: entry,
  deck: z.array(entry),
  sideboard: z.array(entry).optional(),
});
export type DeckFile = z.infer<typeof deckFileSchema>;

export interface Deck {
  key: string;
  leader: string | null;
  base: string | null;
  aspects: string[];
  cards: [string, number][];
  sideboard: [string, number][];
  unmapped: string[];
  createdAt: string | null;
  source: string | null;
  name: string | null;
}

function sourceOf(meta: NonNullable<DeckFile["metadata"]>): string | null {
  if (meta.source !== undefined) return meta.source;
  if (meta.idea_source === undefined) return null;
  const host = /^https?:\/\/([^/]+)/.exec(meta.idea_source);
  return host ? host[1] : null;
}

function fold(entries: readonly z.infer<typeof entry>[], byId: ReadonlyMap<string, string>, unmapped: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const key = byId.get(e.id);
    if (key === undefined) {
      unmapped.push(e.id);
      continue;
    }
    counts.set(key, (counts.get(key) ?? 0) + (e.count ?? 1));
  }
  return [...counts].sort((a, b) => compareCodePoints(a[0], b[0]));
}

export function normalizeDeck(raw: unknown, byId: ReadonlyMap<string, string>, iconsByKey: ReadonlyMap<string, readonly string[]>): Deck {
  const file = deckFileSchema.parse(raw);
  const unmapped: string[] = [];
  const leader = byId.get(file.leader.id) ?? null;
  const base = byId.get(file.base.id) ?? null;
  if (leader === null) unmapped.push(file.leader.id);
  if (base === null) unmapped.push(file.base.id);
  const cards = fold(file.deck, byId, unmapped);
  const sideboard = fold(file.sideboard ?? [], byId, []);
  const aspects = [...(leader === null ? [] : (iconsByKey.get(leader) ?? [])), ...(base === null ? [] : (iconsByKey.get(base) ?? []))].sort(
    compareCodePoints,
  );
  const meta = file.metadata ?? {};
  return {
    key: sha256Hex(canonicalJson({ leader, base, cards })).slice(0, 16),
    leader,
    base,
    aspects,
    cards,
    sideboard,
    unmapped: [...new Set(unmapped)].sort(compareCodePoints),
    createdAt: meta.createdAt ?? null,
    source: sourceOf(meta),
    name: meta.name ?? null,
  };
}

export interface SnapshotDeck extends Deck {
  snapshots: string[];
  names: string[];
}

/** One deck per content key; ties on createdAt keep the earliest, snapshots and names are unioned. */
export function dedupeDecks(entries: readonly { snapshot: string; deck: Deck }[]): {
  decks: SnapshotDeck[];
  duplicatesWithinSnapshot: number;
  duplicatesAcrossSnapshots: number;
} {
  const byKey = new Map<string, SnapshotDeck>();
  const seen = new Set<string>();
  let within = 0;
  let across = 0;
  for (const { snapshot, deck } of entries) {
    const tag = `${snapshot}\u0000${deck.key}`;
    if (seen.has(tag)) {
      within += 1;
      continue;
    }
    seen.add(tag);
    const current = byKey.get(deck.key);
    if (current === undefined) {
      byKey.set(deck.key, { ...deck, snapshots: [snapshot], names: deck.name === null ? [] : [deck.name] });
      continue;
    }
    across += 1;
    current.snapshots = [...new Set([...current.snapshots, snapshot])].sort(compareCodePoints);
    if (deck.name !== null) current.names = [...new Set([...current.names, deck.name])].sort(compareCodePoints);
    if (deck.createdAt !== null && (current.createdAt === null || deck.createdAt < current.createdAt)) {
      current.createdAt = deck.createdAt;
      current.source = deck.source;
    }
  }
  return {
    decks: [...byKey.values()].sort((a, b) => compareCodePoints(a.key, b.key)),
    duplicatesWithinSnapshot: within,
    duplicatesAcrossSnapshots: across,
  };
}
