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
    record: spec.record ?? null,
  };
}

/**
 * Leader-cards scenario. Every deck is a lone winner (placement 1, field 1), so each weighs 2 and inclusion is a plain
 * share. LC (Command, Heroism) plays A and N in both decks and B in one. A (Command) is in all 4 Command decks and out of
 * reach of the Aggression deck (baseline 1, lift 0); N (neutral) is in 3 of all 5 decks (baseline 0.6, lift 0.4); B
 * (Heroism) can be played only by LC's decks (baseline 0.5, lift 0). CL has only a community list.
 */
export const LEADER_CARDS_FACTS = new Map(
  [
    fact("LC", { title: "Bounty Boss", type: "Leader", aspectIcons: ["Command", "Heroism"] }),
    fact("OX", { title: "Other Commander", type: "Leader", aspectIcons: ["Command", "Villainy"] }),
    fact("AX", { title: "Aggro Villain", type: "Leader", aspectIcons: ["Aggression", "Villainy"] }),
    fact("CL", { title: "Casual Leader", type: "Leader", aspectIcons: ["Cunning"] }),
    fact("CB", { title: "Command Base", type: "Base", aspectIcons: ["Command"] }),
    fact("CB2", { title: "Second Command Base", type: "Base", aspectIcons: ["Command"] }),
    fact("AB", { title: "Aggression Base", type: "Base", aspectIcons: ["Aggression"] }),
    fact("A", { title: "Card A", aspectIcons: ["Command"] }),
    fact("B", { title: "Card B", aspectIcons: ["Heroism"] }),
    fact("N", { title: "Card N", aspectIcons: [] }),
    fact("X", { title: "Card X", aspectIcons: ["Aggression"] }),
  ].map((f) => [f.cardKey, f]),
);

const winner = (key: string, event: string, spec: Omit<Parameters<typeof deck>[1], "event" | "placement" | "field">): MetaDeck =>
  deck(key, { ...spec, event: `melee:${event}`, placement: 1, field: 1 });

export const LEADER_CARDS_DECKS: MetaDeck[] = [
  winner("lc1", "e1", {
    leader: "LC",
    base: "CB",
    cards: [
      ["A", 3],
      ["B", 2],
      ["N", 1],
    ],
  }),
  winner("lc2", "e2", {
    leader: "LC",
    base: "CB",
    cards: [
      ["A", 2],
      ["N", 2],
    ],
  }),
  winner("ox1", "e3", { leader: "OX", base: "CB2", cards: [["A", 1]] }),
  winner("ox2", "e4", { leader: "OX", base: "CB2", cards: [["A", 3]] }),
  winner("ax1", "e5", {
    leader: "AX",
    base: "AB",
    cards: [
      ["X", 3],
      ["N", 1],
    ],
  }),
  deck("cl1", { leader: "CL", base: "CB", cards: [["N", 2]], population: "community", source: "swudb", event: null, placement: null }),
];
