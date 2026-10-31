import { baseLocationsFileSchema, compareCodePoints, sha256Hex, type SwuFeatureInputCard } from "./deps.js";

/**
 * @displayName Base location merge
 * @strategicPurpose Manipulation node: the official data gives every base empty traits, so the printed location
 * (Tatooine, Kashyyyk) comes from a pinned capture of the engine's card data and joins each base's traits here,
 * the one place a base's traits differ from the copied field (D59).
 * @tacticalObjective Consumer gate: parses the pinned file. Adds each base's location display name to its
 * traits and reports which bases had no pinned location. Pure: no clock, no randomness, same bytes in, same out.
 */

export interface BaseLocationMerge {
  cards: SwuFeatureInputCard[];
  record: { sha256: string; applied: number; missing: string[] };
}

export function mergeBaseLocations(cards: readonly SwuFeatureInputCard[], pinnedJson: string): BaseLocationMerge {
  const pin = baseLocationsFileSchema.parse(JSON.parse(pinnedJson));
  const nameOf = new Map(pin.rows.map((r) => [r.cardKey, r.locationName]));
  if (nameOf.size !== pin.rows.length) throw new Error("pinned base locations hold a duplicate cardKey");
  let applied = 0;
  const missing: string[] = [];
  const merged = cards.map((card) => {
    if (card.type !== "Base") return card;
    const name = nameOf.get(card.cardKey);
    if (name === undefined) {
      missing.push(`${card.cardKey} ${card.title}`);
      return card;
    }
    applied += 1;
    const traits = [...new Set([...(card.traits ? card.traits.split("|").filter(Boolean) : []), name])].sort(compareCodePoints);
    return { ...card, traits: traits.join("|") };
  });
  return { cards: merged, record: { sha256: sha256Hex(pinnedJson), applied, missing: missing.sort(compareCodePoints) } };
}
