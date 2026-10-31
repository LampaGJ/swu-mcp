/**
 * @displayName Deck card swap
 * @strategicPurpose The owner's discrimination check (#114): the same deck with one card swapped must be playable on
 * the same seeds, so any change in its bot win share comes from the card.
 * @tacticalObjective Applies OUT>IN swaps, one copy each, to a SWUDB deck; a deterministic transform recorded with
 * the result, never a hand-edited list.
 */

export interface DeckEntry {
  id: string;
  count: number;
  [k: string]: unknown;
}
export interface DeckFile {
  leader: DeckEntry;
  base: DeckEntry;
  deck: DeckEntry[];
  [k: string]: unknown;
}

/** Applies OUT>IN swaps (one copy each) to a deck; a deterministic transform recorded with the result. */
export function swapCards(deck: DeckFile, swaps: readonly string[]): DeckFile {
  const cards = deck.deck.map((e) => ({ ...e }));
  for (const s of swaps) {
    const [out, inn] = s.split(">");
    const o = cards.find((e) => e.id === out);
    if (!o || o.count < 1) throw new Error(`swap ${s}: ${out} is not in the deck`);
    o.count--;
    const i = cards.find((e) => e.id === inn);
    if (i) i.count++;
    else cards.push({ id: inn, count: 1 });
  }
  return { ...deck, deck: cards.filter((e) => e.count > 0) };
}

