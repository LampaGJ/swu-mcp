import { describe, expect, it } from "vitest";
import { cardLabelOf } from "../../src/meta/build.js";
import {
  answerOffers,
  counterCardSchema,
  detectThreats,
  loadCounterTable,
  relationHit,
  removes,
  type EffectSpec,
} from "../../src/meta/counters.js";
import type { KeyUnit, ThreatProfile } from "../../src/meta/schema.js";
import { COUNTER_CARDS } from "./fixtures.js";

const table = loadCounterTable();
const cards = COUNTER_CARDS.map((c) => counterCardSchema.parse(c));
const byKey = new Map(cards.map((c) => [c.cardKey, c]));

const unit = (title: string, spec: Partial<KeyUnit> = {}): KeyUnit => ({
  cardKey: title,
  title,
  cost: spec.cost ?? 3,
  power: spec.power ?? 3,
  hp: spec.hp ?? 3,
  arenas: spec.arenas ?? ["Ground"],
  keywords: [],
  traits: spec.traits ?? [],
  meanCopies: spec.meanCopies ?? 3,
  inclusion: 1,
});

/** A profile on which every threat in the table fires. */
const everything: ThreatProfile = {
  cardsKnown: 50,
  units: 40,
  events: 5,
  upgrades: 8,
  arena: { ground: 20, space: 20, spaceShare: 0.5 },
  curve: { "2": 20 },
  meanCost: 3,
  keywords: { Sentinel: 9, Raid: 6, Shielded: 6, Smuggle: 3 },
  offers: { "offers:draw": 6, "offers:give-shield": 6, "offers:create-token-units": 6 },
  cheapUnits: 16,
  cheapUnitMedianHp: 2,
  leader: { power: 4, hp: 7, arenas: ["Ground"] },
  keyUnits: [unit("Ground Bruiser", { cost: 4, hp: 5 }), unit("Space Fighter", { cost: 2, hp: 3, arenas: ["Space"] })],
};

describe("data/counters.json", () => {
  it("parses, names only known threats and has a distinct id per row", () => {
    const threats = new Set(table.threats.map((t) => t.id));
    expect(table.relations.filter((r) => !threats.has(r.threat))).toEqual([]);
    expect(new Set(table.relations.map((r) => r.id)).size).toBe(table.relations.length);
    expect(table.relations.length).toBeGreaterThanOrEqual(12);
  });

  it("fires every threat on a profile built to carry them all", () => {
    expect(
      detectThreats(everything, table)
        .map((t) => t.threat.id)
        .sort(),
    ).toEqual(table.threats.map((t) => t.id).sort());
  });

  it.each(table.relations.map((r) => [r.id, r] as const))(
    "%s: the example card offers it from the named clause and answers the threat",
    (_, relation) => {
      const card = byKey.get(relation.example.cardKey);
      expect(
        card === undefined
          ? null
          : cardLabelOf(card.title, card.subtitle) === relation.example.card || card.title === relation.example.card,
      ).toBe(true);
      const offers = answerOffers(card as NonNullable<typeof card>).filter((o) => relation.offers[o.tag] !== undefined);
      expect(
        offers.some((o) => o.why.endsWith(relation.example.clause)),
        JSON.stringify(offers),
      ).toBe(true);
      const hit = relationHit(card as NonNullable<typeof card>, offers, relation, everything);
      expect(hit, relation.id).not.toBeNull();
      expect(hit?.threat).toBe(relation.threat);
      expect(hit?.evidence).toContain(relation.example.clause.slice(0, 20));
    },
  );
});

describe("removal qualifiers against key unit stats", () => {
  const effect = (spec: Partial<EffectSpec>): EffectSpec => ({
    cat: "defeat",
    n: 1,
    side: "any",
    kind: "unit",
    arena: "any",
    quant: "one",
    restrict: [],
    text: "a unit",
    ...spec,
  });

  it("damage must reach printed HP", () => {
    expect(removes(effect({ cat: "damage", n: 5 }), unit("u", { hp: 5 }))).toBe(true);
    expect(removes(effect({ cat: "damage", n: 4 }), unit("u", { hp: 5 }))).toBe(false);
    expect(removes(effect({ cat: "damage", n: "var" }), unit("u", { hp: 1 }))).toBe(false);
  });

  it("cost, HP, arena and trait limits are checked, and an unreadable limit fails", () => {
    expect(removes(effect({ restrict: ["cost_le_3", "non_leader"] }), unit("u", { cost: 3 }))).toBe(true);
    expect(removes(effect({ restrict: ["cost_le_3"] }), unit("u", { cost: 4 }))).toBe(false);
    expect(removes(effect({ restrict: ["hp_le_3"] }), unit("u", { hp: 4 }))).toBe(false);
    expect(removes(effect({ arena: "space" }), unit("u", { arenas: ["Ground"] }))).toBe(false);
    expect(removes(effect({ restrict: ["trait:Vehicle"] }), unit("u", { traits: ["Vehicle"] }))).toBe(true);
    expect(removes(effect({ restrict: ["non_trait:Vehicle"] }), unit("u", { traits: ["Vehicle"] }))).toBe(false);
    expect(removes(effect({ restrict: ["damaged"] }), unit("u"))).toBe(false);
    expect(removes(effect({ side: "friendly" }), unit("u"))).toBe(false);
  });

  it("a target with a condition the parser did not read is not a match, a cost or HP limit it did read is", () => {
    expect(removes(effect({ text: "a unit that dealt damage to a base this phase" }), unit("u"))).toBe(false);
    expect(removes(effect({ text: "those units" }), unit("u"))).toBe(false);
    expect(removes(effect({ text: "a non-leader unit that costs 4 or less", restrict: ["cost_le_4"] }), unit("u", { cost: 4 }))).toBe(true);
    expect(removes(effect({ text: "a unit with 5 or less remaining HP", restrict: ["hp_le_5"] }), unit("u", { hp: 5 }))).toBe(true);
    expect(removes(effect({ kind: "token", text: "a Credit token" }), unit("u"))).toBe(false);
  });

  it("weighs removal by the share of key-unit copies it can take", () => {
    const youreAllClear = byKey.get("04010055") as NonNullable<ReturnType<typeof byKey.get>>;
    const relation = table.relations.find((r) => r.id === "defeat-key-unit") as (typeof table.relations)[number];
    const hit = relationHit(youreAllClear, answerOffers(youreAllClear), relation, everything);
    expect(hit?.answers).toEqual(["Space Fighter"]);
    expect(hit?.fraction).toBe(0.5);
  });

  it("a sweeper must reach the archetype's median cheap-unit HP", () => {
    const deathField = byKey.get("05010141") as NonNullable<ReturnType<typeof byKey.get>>;
    const sweeper = table.relations.find((r) => r.id === "sweeper") as (typeof table.relations)[number];
    expect(relationHit(deathField, answerOffers(deathField), sweeper, everything)).not.toBeNull();
    expect(relationHit(deathField, answerOffers(deathField), sweeper, { ...everything, cheapUnitMedianHp: 3 })).toBeNull();
  });
});
