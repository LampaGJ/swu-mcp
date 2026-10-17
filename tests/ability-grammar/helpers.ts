import { extractFeatures, walkAbilities } from "../../src/ability-grammar/index.js";
import {
  swuFeatureInputCardSchema,
  type SwuCardFeatures,
  type SwuClause,
} from "../../src/schemas/card-features.js";

export interface CardSpec {
  cardKey: string;
  title: string;
  type: string;
  traits?: string;
  keywords?: string;
  text?: string;
  deployBox?: string;
  epicAction?: string;
}

/** Runs the real extractor on one card with an empty curated table, so only the grammar is under test. */
export function featuresOf(spec: CardSpec): SwuCardFeatures {
  const card = swuFeatureInputCardSchema.parse({ type2: "", ...spec });
  const [out] = extractFeatures([card], new Map()).cards;
  return out;
}

export interface FlatClause {
  face: string;
  trigger: string;
  granted: boolean;
  clause: SwuClause;
}

export function clausesOf(card: SwuCardFeatures): FlatClause[] {
  const out: FlatClause[] = [];
  for (const face of Object.keys(card.faces) as (keyof typeof card.faces)[]) {
    const nodes = card.faces[face];
    if (!nodes) continue;
    for (const { a, clauses } of walkAbilities(nodes, null)) {
      for (const clause of clauses) out.push({ face, trigger: a.triggers[0]?.trigger ?? "none", granted: a.granted, clause });
    }
  }
  return out;
}

/** The first clause whose text contains the fragment. */
export function clauseWith(card: SwuCardFeatures, fragment: string): SwuClause {
  const hit = clausesOf(card).find((c) => c.clause.text.includes(fragment));
  if (!hit) throw new Error(`no clause contains ${JSON.stringify(fragment)} in ${card.cardKey}`);
  return hit.clause;
}

export const offerTags = (card: SwuCardFeatures): string[] => card.tags.offers.map((t) => t.tag);
export const wantTags = (card: SwuCardFeatures): string[] => card.tags.wants.map((t) => t.tag);
