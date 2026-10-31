import { describe, expect, it } from "vitest";
import { attackOutcome, lethalReach } from "../../../src/sims/policies/combat.js";
import { aspectPenalty, knapsack, makeRulePolicy, RUNG1_PARAMS, type PairLookups } from "../../../src/sims/policies/rules.js";
import type { LegalAnswer } from "../../../src/sims/policies/types.js";
import { base, button, card, cardAnswer, leader, view } from "./fixtures.js";

const rung1 = () => makeRulePolicy({ id: "rung1-rules", version: "1", rung: 1, params: RUNG1_PARAMS });
const labelOf = (answers: LegalAnswer[], i: number): string => answers[i].label;

describe("rung 1 rules, one fixture per rule", () => {
  it("mulligan keeps a hand with two cards of cost 3 or less and mulligans one with fewer", () => {
    const answers = [button("Keep"), button("Mulligan")];
    const keep = view({ prompt: { kind: "mulligan" }, hand: [card({ cost: 1 }), card({ cost: 3 }), card({ cost: 6 })] });
    const toss = view({ prompt: { kind: "mulligan" }, hand: [card({ cost: 2 }), card({ cost: 5 }), card({ cost: 6 })] });
    expect(labelOf(answers, rung1().choose(answers, keep))).toBe("Keep");
    expect(labelOf(answers, rung1().choose(answers, toss))).toBe("Mulligan");
  });

  it("resources the lowest playCalibrated card, a second copy of an in-play unique card first", () => {
    const weak = card({ title: "Weak", score: -0.5 });
    const strong = card({ title: "Strong", score: 3 });
    const prompt = { kind: "resource" as const, title: "Select between 0 and 1 cards to resource" };
    const answers = [button("Skip Resourcing"), cardAnswer(strong), cardAnswer(weak)];
    expect(labelOf(answers, rung1().choose(answers, view({ prompt, hand: [strong, weak], me: { resources: { total: 2, ready: 2 } } })))).toBe("Weak");
    const dupe = card({ title: "Dupe", cardKey: "U1", unique: true, score: 4 });
    const inPlay = card({ title: "Dupe", cardKey: "U1", unique: true });
    const answers2 = [button("Skip Resourcing"), cardAnswer(dupe), cardAnswer(weak)];
    expect(answers2[rung1().choose(answers2, view({ prompt, hand: [dupe, weak], mine: [inPlay], me: { resources: { total: 2, ready: 2 } } }))].cardId).toBe(dupe.id);
  });

  it("stops resourcing at the deck's top cost and confirms once a card is selected", () => {
    const c = card({ title: "Any" });
    const prompt = { kind: "resource" as const, title: "Select between 0 and 1 cards to resource" };
    const answers = [button("Skip Resourcing"), cardAnswer(c)];
    expect(labelOf(answers, rung1().choose(answers, view({ prompt, hand: [c], me: { resources: { total: 6, ready: 6 }, maxDeckCost: 6 } })))).toBe("Skip Resourcing");
    const answers2 = [button("Confirm Resources"), cardAnswer(c)];
    expect(labelOf(answers2, rung1().choose(answers2, view({ prompt: { ...prompt, selectedIds: [c.id] }, hand: [c], me: { resources: { total: 2, ready: 2 } } })))).toBe("Confirm Resources");
  });

  it("goes for lethal on the base, counting Raid, and Sentinel blocks the base", () => {
    const raider = card({ title: "Raider", power: 2, raid: 2 });
    const big = card({ title: "Big", power: 5, hp: 5 });
    const prey = card({ title: "Prey", power: 1, hp: 1 });
    const oppBase = { ...base(false, 26), remainingHp: 4 };
    const v = view({ mine: [raider, big], theirs: [prey], opp: { base: oppBase } });
    expect(lethalReach([raider], v)).toBe(4);
    const answers = [button("Pass"), cardAnswer(raider), cardAnswer(big)];
    // Lethal outranks the favourable trade Big has on Prey.
    expect(labelOf(answers, rung1().choose(answers, v))).toBe("Big");
    const wall = card({ title: "Wall", power: 0, hp: 9, keywords: ["sentinel"] });
    const blocked = view({ mine: [raider], theirs: [wall], opp: { base: oppBase } });
    expect(lethalReach([raider], blocked)).toBe(0);
  });

  it("counts Overwhelm excess through a Sentinel toward lethal", () => {
    const tank = card({ title: "Tank", power: 6, hp: 6, keywords: ["overwhelm"] });
    const wall = card({ title: "Wall", power: 0, hp: 2, keywords: ["sentinel"] });
    const v = view({ mine: [tank], theirs: [wall], opp: { base: { ...base(false, 26), remainingHp: 4 } } });
    expect(lethalReach([tank], v)).toBe(4);
  });

  it("takes a favourable trade by power and HP; a Shield absorbs the hit unless the attacker has Saboteur", () => {
    const att = card({ title: "Att", power: 3, hp: 4 });
    const def = card({ title: "Def", power: 2, hp: 3, mine: false });
    expect(attackOutcome(att, def)).toEqual({ defenderDies: true, attackerDies: false, baseDamage: 0 });
    const shielded = { ...def, shield: true };
    expect(attackOutcome(att, shielded).defenderDies).toBe(false);
    expect(attackOutcome({ ...att, keywords: new Set(["saboteur" as const]) }, shielded).defenderDies).toBe(true);
    const answers = [button("Pass"), cardAnswer(att)];
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [att], theirs: [def], opp: { base: { ...base(false), remainingHp: 30 } } })))).toBe("Att");
  });

  it("trades evenly only when the defender scores higher than the attacker", () => {
    const att = card({ title: "Att", power: 3, hp: 3, score: 1 });
    const better = card({ title: "Better", power: 3, hp: 3, score: 2, mine: false });
    const worse = card({ title: "Worse", power: 3, hp: 3, score: 0.5, mine: false });
    const prompt = { kind: "attackTarget" as const, sourceId: att.id };
    const a1 = [cardAnswer(better), cardAnswer({ ...base(false) })];
    const a2 = [cardAnswer(worse), cardAnswer({ ...base(false) })];
    expect(rung1().choose(a1, view({ mine: [att], theirs: [better], prompt }))).toBe(0);
    expect(a2[rung1().choose(a2, view({ mine: [att], theirs: [worse], prompt }))].cardId).toBe("oppBase");
  });

  it("plays the affordable card with the highest playCalibrated, filling the curve, and holds removal with no enemy unit", () => {
    const two = card({ title: "Two", cost: 2, score: 1.5 });
    const three = card({ title: "Three", cost: 3, score: 1 });
    const five = card({ title: "Five", cost: 5, score: 2 });
    const answers = [button("Pass"), cardAnswer(two), cardAnswer(three), cardAnswer(five)];
    // Five resources: Two + Three (value 2.5 + 2.5 tempo) beats Five alone (2 + 2.5).
    expect(labelOf(answers, rung1().choose(answers, view({ hand: [two, three, five], me: { resources: { total: 5, ready: 5 } } })))).toBe("Two");
    const removal = card({ title: "Removal", kind: "event", cost: 1, score: 5, effects: { removal: true, heal: false } });
    const filler = card({ title: "Filler", cost: 1, score: 0 });
    const a2 = [button("Pass"), cardAnswer(removal), cardAnswer(filler)];
    expect(labelOf(a2, rung1().choose(a2, view({ hand: [removal, filler] })))).toBe("Filler");
  });

  it("attacks the base with a ready unit that has no favourable trade", () => {
    const att = card({ title: "Att", power: 2, hp: 2 });
    const brute = card({ title: "Brute", power: 5, hp: 5, mine: false });
    const answers = [button("Pass"), cardAnswer(att)];
    const v = view({ mine: [att], theirs: [brute] });
    expect(labelOf(answers, rung1().choose(answers, v))).toBe("Att");
    const targets = [cardAnswer(brute), cardAnswer(v.opp.base), button("Cancel")];
    expect(targets[rung1().choose(targets, { ...v, prompt: { ...v.prompt, kind: "attackTarget", sourceId: att.id } })].cardId).toBe("oppBase");
  });

  it("deploys the leader when legal, then takes the initiative, then passes", () => {
    const lead = leader(true, { cost: 5 });
    const answers = [button("Claim Initiative"), button("Pass"), cardAnswer(lead)];
    expect(answers[rung1().choose(answers, view({ me: { leader: lead, resources: { total: 5, ready: 0 } } }))].cardId).toBe("myLeader");
    const sel = [button("Cancel"), button("Deploy Leader"), button("Use ability")];
    expect(labelOf(sel, rung1().choose(sel, view({ prompt: { kind: "actionSelection", sourceId: lead.id }, me: { leader: lead } })))).toBe("Deploy Leader");
    const a2 = [button("Claim Initiative"), button("Pass")];
    expect(labelOf(a2, rung1().choose(a2, view({})))).toBe("Claim Initiative");
    const a3 = [button("Pass")];
    expect(labelOf(a3, rung1().choose(a3, view({})))).toBe("Pass");
  });

  it("aims a harmful effect at the most threatening enemy it defeats, never at its own unit while it may decline", () => {
    const mine = card({ title: "Mine", power: 1, hp: 1 });
    const small = card({ title: "Small", power: 1, hp: 2, mine: false });
    const big = card({ title: "Big", power: 6, hp: 6, mine: false });
    const prompt = { kind: "target" as const, intent: "harm" as const, system: "DamageSystem", title: "Deal 2 damage to a unit" };
    const answers = [cardAnswer(mine), cardAnswer(small), cardAnswer(big)];
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [mine], theirs: [small, big], prompt })))).toBe("Small");
    const defeat = { ...prompt, system: "DefeatCardSystem", title: "Defeat a unit" };
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [mine], theirs: [small, big], prompt: defeat })))).toBe("Big");
    const onlyMine = [cardAnswer(mine), button("Pass")];
    expect(labelOf(onlyMine, rung1().choose(onlyMine, view({ mine: [mine], prompt })))).toBe("Pass");
  });

  it("aims a beneficial effect at its own most threatening unit and heals the most damaged", () => {
    const weak = card({ title: "Weak", power: 1, hp: 4, damage: 3 });
    const star = card({ title: "Star", power: 5, hp: 5, damage: 1 });
    const foe = card({ title: "Foe", power: 9, hp: 9, mine: false });
    const answers = [cardAnswer(weak), cardAnswer(star), cardAnswer(foe)];
    const give = { kind: "target" as const, intent: "help" as const, system: "GiveTokenUpgradeSystem", title: "Give an Experience token to a unit" };
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [weak, star], theirs: [foe], prompt: give })))).toBe("Star");
    const heal = { ...give, system: "HealSystem", title: "Heal 3 damage from a unit" };
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [weak, star], theirs: [foe], prompt: heal })))).toBe("Weak");
  });

  it("uses Ambush only when the ambusher has a favourable trade", () => {
    const amb = card({ title: "Amb", power: 4, hp: 4, keywords: ["ambush"] });
    const prey = card({ title: "Prey", power: 1, hp: 3, mine: false });
    const brute = card({ title: "Brute", power: 6, hp: 6, mine: false });
    const answers = [button("Pass"), button("Trigger")];
    const prompt = { kind: "optionalTrigger" as const, abilityText: "{keyword:ambush}", sourceId: amb.id };
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [amb], theirs: [prey], prompt })))).toBe("Trigger");
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [amb], theirs: [brute], prompt })))).toBe("Pass");
  });

  it("does not click a card whose action it cancelled until the board changes", () => {
    const att = card({ title: "Att", power: 2 });
    const wall = card({ title: "Wall", power: 5, hp: 9, mine: false, keywords: ["sentinel"] });
    const answers = [button("Pass"), cardAnswer(att)];
    expect(labelOf(answers, rung1().choose(answers, view({ mine: [att], theirs: [wall], cancelled: [att.id] })))).toBe("Pass");
  });

  it("counts a prompt it has no rule for as a fallback", () => {
    const p = rung1();
    p.choose([button("A"), button("B")], view({ prompt: { kind: "unknown", system: "MysteryPrompt" } }));
    expect(p.stats).toMatchObject({ decisions: 1, fallback: 1, fallbackBy: { "unknown:MysteryPrompt": 1 } });
  });
});

describe("rung 2 pairing utility", () => {
  const paired = card({ title: "Paired", cardKey: "P", cost: 2, score: 1 });
  const plain = card({ title: "Plain", cardKey: "Q", cost: 2, score: 1.2 });
  const partner = card({ title: "Partner", cardKey: "L" });
  const pairs: PairLookups = { leaderInclusion: (_l, k) => (k === "Q" ? 0.1 : 0), edgeWeight: (a, b) => (a === "L" && b === "P" ? 1.5 : 0) };
  const answers = [button("Pass"), cardAnswer(paired), cardAnswer(plain)];
  const v = view({ mine: [partner], hand: [paired, plain], me: { resources: { total: 2, ready: 2 } } });

  it("with mu = lambda = 0 chooses exactly as rung 1", () => {
    const r2 = makeRulePolicy({ id: "rung2-pairs", version: "1", rung: 2, params: { ...RUNG1_PARAMS, mu: 0, lambda: 0 }, pairs });
    expect(r2.choose(answers, v)).toBe(rung1().choose(answers, v));
    expect(labelOf(answers, r2.choose(answers, v))).toBe("Plain");
  });

  it("with lambda > 0 plays the card our board has a pair edge to", () => {
    const r2 = makeRulePolicy({ id: "rung2-pairs", version: "1", rung: 2, params: { ...RUNG1_PARAMS, lambda: 0.5 }, pairs });
    expect(labelOf(answers, r2.choose(answers, v))).toBe("Paired");
  });

  it("protects a strongly paired card from the resource row", () => {
    const r2 = makeRulePolicy({ id: "rung2-pairs", version: "1", rung: 2, params: { ...RUNG1_PARAMS, lambda: 1, protectThreshold: 1 }, pairs });
    const prompt = { kind: "resource" as const, title: "Select between 0 and 1 cards to resource" };
    const weakPaired = { ...paired, score: -1 };
    const a = [button("Skip Resourcing"), cardAnswer(weakPaired), cardAnswer(plain)];
    const rv = view({ mine: [partner], hand: [weakPaired, plain], prompt, me: { resources: { total: 2, ready: 2 } } });
    expect(labelOf(a, rung1().choose(a, rv))).toBe("Paired");
    expect(labelOf(a, r2.choose(a, rv))).toBe("Plain");
  });
});

describe("helpers", () => {
  it("prices the aspect penalty at 2 per unsupplied icon, icons counted as a multiset", () => {
    expect(aspectPenalty({ aspects: ["command", "command"] }, ["command", "heroism"])).toBe(2);
    expect(aspectPenalty({ aspects: ["cunning"] }, ["cunning"])).toBe(0);
  });

  it("knapsack keeps the best affordable set", () => {
    expect(knapsack([{ cost: 2, value: 3 }, { cost: 3, value: 3 }, { cost: 5, value: 5 }], 5)).toEqual([0, 1]);
    expect(knapsack([{ cost: 4, value: 1 }], 3)).toEqual([]);
  });
});
