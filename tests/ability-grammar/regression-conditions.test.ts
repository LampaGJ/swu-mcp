import { describe, expect, it } from "vitest";
import { parseClause } from "../../src/ability-grammar/index.js";
import { CARDS } from "./regression-cards.js";
import { clauseWith, featuresOf } from "./helpers.js";

// Golden regressions for RC13: a condition is a typed feature, not residue, and it is applied to the effect it gates.

const cats = (xs: readonly { cat: string }[]): string[] => xs.map((x) => x.cat);

describe("RC13 conditions are typed and applied to the effect", () => {
  it("08010042 Jabba the Hutt: if it's returned to your hand", () => {
    const clause = clauseWith(featuresOf(CARDS["08010042"]), "If it's returned to your hand");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "returned" }]);
    expect(clause.effects.length).toBeGreaterThan(0);
    for (const e of clause.effects) expect(e.conditional).toBe(true);
    expect(cats(clause.effects)).toContain("play_extra");
  });

  it("07010225 Han's Golden Dice: if its cost is odd", () => {
    const clause = clauseWith(featuresOf(CARDS["07010225"]), "If its cost is odd");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "cost", state: "odd" }]);
    expect(clause.effects).toMatchObject([{ cat: "create_token", token: "Credit", conditional: true }]);
  });

  it("09010148 Local Support: if it shares a trait with a friendly unit", () => {
    const clause = clauseWith(featuresOf(CARDS["09010148"]), "If it shares a trait");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "shares_trait", what: { side: "friendly", kind: "unit" } }]);
    expect(clause.effects).toMatchObject([{ cat: "draw", conditional: true }]);
  });

  it("07010111 Leia's Disguise: if attached unit is Leia Organa (a name, not a trait)", () => {
    const clause = clauseWith(featuresOf(CARDS["07010111"]), "If attached unit is Leia Organa");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "attached_is", what: { restrict: ["named:Leia Organa"] } }]);
    expect(clause.effects).toMatchObject([{ cat: "give_token", conditional: true }]);
  });

  it("05010187 Corrupted Saber: if attached unit is a Force unit, the granted ability is conditional", () => {
    const clause = clauseWith(featuresOf(CARDS["05010187"]), "If attached unit is a Force unit");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "attached_is", what: { kind: "unit", restrict: ["trait:Force"] } }]);
    expect(clause.structure).toMatchObject([{ cat: "granted_ability", conditional: true }]);
  });

  it("0201057 Rickety Quadjumper: if it's not a unit", () => {
    const clause = clauseWith(featuresOf(CARDS["0201057"]), "If it's not a unit");
    expect(clause.residue).toEqual([]);
    expect(clause.conditions).toMatchObject([{ cat: "target_check", check: "is_not", what: { kind: "unit" } }]);
    expect(clause.effects).toMatchObject([{ cat: "give_token", conditional: true }]);
  });

  it("leaves an unconditional effect unmarked", () => {
    expect(parseClause("Draw a card.").accepted.effect[0].conditional).toBeUndefined();
  });

  it("does not treat a for-each scaling as a gate", () => {
    expect(parseClause("Deal 1 damage to a unit for each card in your hand.").accepted.effect[0].conditional).toBeUndefined();
  });
});

describe("the While-you-control clauses become typed conditions", () => {
  it("0201168 Hunting Nexu: while you control another Aggression unit", () => {
    const clause = clauseWith(featuresOf(CARDS["0201168"]), "While you control another Aggression unit");
    expect(clause.conditions).toMatchObject([{ cat: "control", what: { kind: "unit", restrict: ["aspect:Aggression", "other"] } }]);
    expect(clause.effects).toMatchObject([{ cat: "grant_keyword", conditional: true }]);
  });

  it("while you control a Force unit or a Force upgrade", () => {
    const r = parseClause("While you control a Force unit or a Force upgrade, this unit gets +1/+1.");
    expect(cats(r.accepted.condition)).toEqual(["control"]);
    expect(r.accepted.effect[0].conditional).toBe(true);
  });

  it("keeps while_other for a while clause no typed rule knows", () => {
    expect(cats(parseClause("While this unit is being frobnicated, it gets +1/+1.").accepted.condition)).toContain("while_other");
  });
});
