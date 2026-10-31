import { describe, expect, it } from "vitest";
import { cardLabelOf } from "../../src/meta/build.js";
import {
  answerOffers,
  counterCardSchema,
  detectThreats,
  loadCounterTable,
  relationHit,
  removes,
  thresholdOf,
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
  heavyKeyUnits: 2,
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

  describe("key-units (D63, #154)", () => {
    const fires = (profile: ThreatProfile): boolean => detectThreats(profile, table).some((t) => t.threat.id === "key-units");

    it("fires on two heavy key units and not on one, however many ordinary key units the core holds", () => {
      expect(fires({ ...everything, heavyKeyUnits: 2 })).toBe(true);
      expect(fires({ ...everything, heavyKeyUnits: 1 })).toBe(false);
      expect(fires({ ...everything, heavyKeyUnits: 0, keyUnits: Array.from({ length: 8 }, (_, i) => unit(`U${i}`, { cost: 3 })) })).toBe(false);
    });

    it("reads a package built before the field from its listed key units: cost 6 or more and played by 80% of decks", () => {
      const old: ThreatProfile = { ...everything, heavyKeyUnits: undefined };
      const heavy = (title: string, inclusion: number, cost = 7): KeyUnit => ({ ...unit(title, { cost }), inclusion });
      expect(fires({ ...old, keyUnits: [heavy("A", 0.9), heavy("B", 0.85)] })).toBe(true);
      expect(fires({ ...old, keyUnits: [heavy("A", 0.9), heavy("B", 0.79)] })).toBe(false);
      expect(fires({ ...old, keyUnits: [heavy("A", 0.9), heavy("B", 0.9, 5)] })).toBe(false);
    });
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

describe("a conditional Saboteur gained on the card itself (D45)", () => {
  const marrok = byKey.get("08010030") as NonNullable<ReturnType<typeof byKey.get>>;
  const hitFor = (id: string) => {
    const relation = table.relations.find((r) => r.id === id) as (typeof table.relations)[number];
    return relationHit(marrok, answerOffers(marrok), relation, everything);
  };

  it("offers gain-saboteur-self from the self-conditioned clause, and no unconditional grant-saboteur", () => {
    const tags = answerOffers(marrok).map((o) => o.tag);
    expect(tags).toContain("offers:gain-saboteur-self");
    expect(tags).not.toContain("offers:grant-saboteur");
  });

  it("answers the sentinel wall at weight 0.5 with the condition in the evidence", () => {
    const hit = hitFor("sentinel-bypass-conditional");
    expect(hit).toMatchObject({ threat: "sentinel-wall", offer: "offers:gain-saboteur-self", weight: 0.5, fraction: 1 });
    expect(hit?.evidence).toContain("While this unit is upgraded");
    expect(hit?.evidence).toContain("gains Saboteur");
  });

  it("answers the shield threat at weight 0.5 too, but no unconditional-grant relation counts it as a full answer", () => {
    expect(hitFor("shield-removal-conditional")).toMatchObject({ threat: "shields", weight: 0.5 });
    expect(hitFor("sentinel-bypass")).toBeNull();
    expect(hitFor("shield-removal")).toBeNull();
  });
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

describe("a stat threshold in the target's own words (#152)", () => {
  const bounce = (spec: Partial<EffectSpec>): EffectSpec => ({
    cat: "bounce",
    n: 1,
    side: "any",
    kind: "unit",
    arena: "any",
    quant: "one",
    restrict: ["non_leader"],
    text: "a non-leader unit with 6 or more power",
    ...spec,
  });

  it("returns only units at or above a power floor the restrict list does not carry (Exploit Confidence)", () => {
    expect(removes(bounce({}), unit("Ant Droid", { power: 1 }))).toBe(false);
    expect(removes(bounce({}), unit("Chimaera", { power: 6 }))).toBe(true);
    expect(removes(bounce({}), unit("Devastator", { power: 9 }))).toBe(true);
  });

  it("reads a power ceiling, an HP floor and a cost floor the same way", () => {
    expect(removes(bounce({ text: "a unit with 3 or less power" }), unit("u", { power: 4 }))).toBe(false);
    expect(removes(bounce({ text: "a unit with 3 or less power" }), unit("u", { power: 3 }))).toBe(true);
    expect(removes(bounce({ text: "a unit with 5 or more HP" }), unit("u", { hp: 4 }))).toBe(false);
    expect(removes(bounce({ text: "a unit that costs 4 or more" }), unit("u", { cost: 3 }))).toBe(false);
    expect(removes(bounce({ text: "a unit that costs 4 or more" }), unit("u", { cost: 4 }))).toBe(true);
  });

  it("names the threshold in words, from the text or the restrict list, and null when the clause states none", () => {
    expect(thresholdOf(bounce({}))).toBe("power 6 or more");
    expect(thresholdOf(bounce({ text: "a unit", restrict: ["cost_le_3"] }))).toBe("cost 3 or less");
    expect(thresholdOf(bounce({ text: "a unit", restrict: ["non_leader"] }))).toBeNull();
  });

  it("credits an archetype only through the key units that meet the floor, and carries the threshold on the hit", () => {
    const exploit = counterCardSchema.parse({
      ...byKey.get("04010055"),
      cardKey: "EXPLOIT",
      title: "Exploit Confidence",
      tags: { offers: [{ tag: "offers:return-any-to-hand", why: "text: Return a non-leader unit with 6 or more power to its owner's hand." }] },
      faces: {
        text: [
          {
            kind: "ability",
            clauses: [{ text: "Return a non-leader unit with 6 or more power to its owner's hand.", effects: [{ cat: "bounce", n: 1, target: { side: "any", kind: "unit", arena: "any", quant: "one", restrict: ["non_leader"], text: "a non-leader unit with 6 or more power" } }] }],
          },
        ],
      },
    });
    const relation = table.relations.find((r) => r.id === "bounce-key-unit") as (typeof table.relations)[number];
    const profile = { ...everything, keyUnits: [unit("Ant Droid", { power: 1, meanCopies: 3 }), unit("Chimaera", { power: 6, meanCopies: 1 })] };
    const hit = relationHit(exploit, answerOffers(exploit), relation, profile);
    expect(hit?.answers).toEqual(["Chimaera"]);
    expect(hit?.fraction).toBe(0.25);
    expect(hit?.threshold).toBe("power 6 or more");
    expect(relationHit(exploit, answerOffers(exploit), relation, { ...everything, keyUnits: [unit("Ant Droid", { power: 1 })] })).toBeNull();
  });
});
