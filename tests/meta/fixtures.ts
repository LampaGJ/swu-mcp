import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CardFact, MetaDeck } from "../../src/meta/build.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Real feature records of the counter table's example cards (scripts/meta/make-counter-fixture.ts). */
export const COUNTER_CARDS = (
  JSON.parse(readFileSync(path.join(HERE, "counter-cards.json"), "utf8")) as { cards: Record<string, unknown>[] }
).cards;

export function fact(cardKey: string, spec: Partial<CardFact> = {}): CardFact {
  return {
    cardKey,
    title: spec.title ?? cardKey,
    type: spec.type ?? "Unit",
    cost: spec.cost === undefined ? 2 : spec.cost,
    power: spec.power === undefined ? 2 : spec.power,
    hp: spec.hp === undefined ? 2 : spec.hp,
    arenas: spec.arenas ?? ["Ground"],
    aspectIcons: spec.aspectIcons ?? [],
    traits: spec.traits ?? [],
    keywords: spec.keywords ?? [],
    offers: spec.offers ?? [],
  };
}

export function deck(key: string, spec: Partial<MetaDeck> & { leader: string; base: string; cards: [string, number][] }): MetaDeck {
  return {
    key,
    population: spec.population ?? "tournament",
    source: spec.source ?? "melee",
    leader: spec.leader,
    base: spec.base,
    cards: spec.cards,
    createdAt: spec.createdAt ?? "2026-10-01",
    event: spec.event === undefined ? "melee:1" : spec.event,
    placement: spec.placement === undefined ? 10 : spec.placement,
    field: spec.field ?? null,
  };
}
