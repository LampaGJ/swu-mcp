/**
 * @displayName Simulation deck loader
 * @strategicPurpose A decklist file is foreign data: it is parsed at the boundary and every id is sent through the
 * engine bridge before a match header names it, so a list the engine cannot build fails by name, never mid-batch.
 * @tacticalObjective Reads a SWUDB-format deck file (`swudbDeckSchema`), translates ids the engine lacks by card
 * identity, and returns the engine list (order kept, metadata dropped) plus its cardKey view for the header.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../src/paths.js";
import type { DeckInput } from "../../src/sims/match.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { swudbDeckSchema } from "../../src/tools/swudb.js";
import { translateDeck, type CardBridge } from "./card-bridge.js";

export function deckSource(file: string): string {
  const rel = path.relative(REPO_ROOT, path.resolve(file));
  return `file:${rel.startsWith("..") ? path.basename(file) : rel.split(path.sep).join("/")}`;
}

export function prepareDeck(bridge: CardBridge, raw: unknown, source: string): DeckInput {
  const doc = swudbDeckSchema.parse(raw);
  const { deck, unmapped } = translateDeck(bridge, doc);
  if (unmapped.length > 0) throw new Error(`${source}: the engine has no card for ${unmapped.join(", ")}`);
  const entry = (e: { id: string; count: number }) => ({ id: e.id, count: e.count });
  const list = { leader: entry(deck.leader), base: entry(deck.base), deck: deck.deck.map(entry), sideboard: (deck.sideboard ?? []).map(entry) };
  const keyOf = (id: string): string => {
    const t = bridge.translate(id);
    if (t?.cardKey === null || t === null) throw new Error(`${source}: no cardKey for ${id}`);
    return t.cardKey;
  };
  const counts = new Map<string, number>();
  for (const e of list.deck) counts.set(keyOf(e.id), (counts.get(keyOf(e.id)) ?? 0) + e.count);
  return {
    list,
    leader: keyOf(list.leader.id),
    base: keyOf(list.base.id),
    cards: [...counts].map(([cardKey, count]) => ({ cardKey, count })).sort((a, b) => compareCodePoints(a.cardKey, b.cardKey)),
    source,
  };
}

export const loadDeck = (bridge: CardBridge, file: string): DeckInput => prepareDeck(bridge, JSON.parse(readFileSync(file, "utf8")), deckSource(file));
