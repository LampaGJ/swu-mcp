import { metaFileSchema, type MetaFile } from "../../src/meta/schema.js";
import type { CardKeyOf, ReadCounts, SnapshotEntry } from "../../src/sims/opponents.js";

/** A valid but empty threat profile; the sampler never reads it. */
const profile = {
  cardsKnown: 0,
  units: 0,
  events: 0,
  upgrades: 0,
  arena: { ground: 0, space: 0, spaceShare: 0 },
  curve: {},
  meanCost: null,
  keywords: {},
  offers: {},
  cheapUnits: 0,
  cheapUnitMedianHp: null,
  leader: { power: null, hp: null, arenas: [] },
  keyUnits: [],
};

export interface ArchetypeSpec {
  id: string;
  leader: string;
  share: number;
  core: string[];
  baseAspects?: string[];
  bases?: string[];
  decks?: number;
}

/** A synthetic archetypes.json: leader cardKeys are "K-<leader id>", cards are "K-<id>". */
export function metaOf(specs: readonly ArchetypeSpec[]): MetaFile {
  return metaFileSchema.parse({
    schemaVersion: 1,
    window: { from: "2026-07-20", to: "2026-10-17", days: 90 },
    primary: "tournament",
    fallback: false,
    method: { seed: "test", joinJaccard: 0.4, coreInclusion: 0.5, minDecks: 5, rounds: 8, weighting: "test" },
    populations: [],
    archetypes: specs.map((s) => ({
      id: s.id,
      name: `Archetype ${s.id}`,
      population: "tournament",
      leader: { cardKey: `K-${s.leader}`, title: `Leader ${s.leader}`, aspects: [] },
      baseAspects: s.baseAspects ?? [],
      bases: (s.bases ?? []).map((b) => ({ cardKey: `K-${b}`, title: b, decks: 1 })),
      decks: s.decks ?? 10,
      weight: 1,
      share: s.share,
      top8: 0,
      top8Share: null,
      window: { from: "2026-07-20", to: "2026-10-17" },
      cohesion: 1,
      core: s.core.map((c) => ({ cardKey: `K-${c}`, title: c, inclusion: 1, meanCopies: 3 })),
      profile,
    })),
  });
}

export const cardKeyOf: CardKeyOf = (id) => `K-${id}`;

export const counts: ReadCounts = { files: 0, melee: 0, nonMelee: 0, nonPremier: 0, invalid: 0, undated: 0, outOfWindow: 0, noPlacement: 0 };

let serial = 0;

/** One synthetic melee list. Its event holds `field` players, so the placement weight is 1 + (1 - (placement - 1) / field). */
export function entryOf(spec: {
  leader: string;
  cards: string[];
  placement?: number;
  field?: number;
  event?: string;
  base?: string;
  name?: string;
  key?: string;
}): SnapshotEntry {
  serial += 1;
  return {
    key: spec.key ?? `melee-synthetic-${serial}`,
    name: spec.name ?? `Synthetic list ${serial}`,
    source: "melee",
    via: "test",
    event: { key: `test:${spec.event ?? "e1"}`, name: spec.event ?? "e1", players: spec.field ?? 100 },
    date: "2026-09-01",
    placement: spec.placement ?? 1,
    leader: { id: spec.leader, count: 1 },
    base: { id: spec.base ?? "B1", count: 1 },
    deck: spec.cards.map((id) => ({ id, count: 3 })),
  };
}
