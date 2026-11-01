import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../src/paths.js";
import { archetypeShares, type CalibrationRow } from "../../../src/sims/calibration.js";
import { parsePolicySpec, policyHeader, specName } from "../../../src/sims/policies/index.js";
import { withoutPass } from "../../../src/sims/policies/lookahead.js";
import { makeRulePolicy, RUNG1_PARAMS, type RuleParams } from "../../../src/sims/policies/rules.js";
import { abilityProfileOf, loadTables } from "../../../src/sims/policies/tables.js";
import type { AbilityProfile, LegalAnswer } from "../../../src/sims/policies/types.js";
import { button, card, cardAnswer, leader, view } from "./fixtures.js";

const rules = (extra: Partial<RuleParams> = {}) => makeRulePolicy({ id: "rung1-rules", version: "1", rung: 1, params: { ...RUNG1_PARAMS, ...extra } });
const labelOf = (answers: LegalAnswer[], i: number): string => answers[i].label;
const ability = (over: Partial<AbilityProfile> = {}): AbilityProfile => ({ sacrificeAction: false, whenDefeated: false, takeInitiativeCost: null, ...over });

describe("ability profile from the parsed card faces", () => {
  const krennic = {
    text: [{ kind: "ability" as const, triggers: [{ trigger: "action", cost: { exhaust: true, resources: 0, other: ["defeat a friendly unit"] } }], clauses: [{ text: "Create a Credit token." }] }],
    deployBox: [{ kind: "ability" as const, triggers: [{ trigger: "when_deployed" }], clauses: [{ text: "Another friendly unit deals damage equal to its power to an enemy unit." }] }],
  };
  const mando = {
    text: [{ kind: "ability" as const, triggers: [{ trigger: "take_initiative" }], clauses: [{ text: "You may pay 1 resource. If you do, draw a card." }] }],
    deployBox: [{ kind: "ability" as const, triggers: [{ trigger: "on_attack" }], clauses: [{ text: "If you have the initiative, you may draw a card." }] }],
  };
  const brute = { text: [{ kind: "ability" as const, triggers: [{ trigger: "when_defeated" }], clauses: [{ text: "Heal 2 damage from a base." }] }] };
  const creditCost = { text: [{ kind: "ability" as const, triggers: [{ trigger: "action", cost: { other: ["defeat a friendly Credit token"] } }], clauses: [{ text: "Draw a card." }] }] };

  it("reads a sacrifice cost, a When Defeated trigger and a take-the-initiative payment from the face in use", () => {
    expect(abilityProfileOf(krennic, "text")).toEqual(ability({ sacrificeAction: true }));
    expect(abilityProfileOf(krennic, "deployBox")).toEqual(ability());
    expect(abilityProfileOf(mando, "text")).toEqual(ability({ takeInitiativeCost: 1 }));
    expect(abilityProfileOf(mando, "deployBox")).toEqual(ability());
    expect(abilityProfileOf(brute, "text")).toEqual(ability({ whenDefeated: true }));
  });

  it("reads the pinned card tables the same way: Krennic's sacrifice, the Mandalorian's paid draw, Onyx Squadron Brute's When Defeated", () => {
    const tables = loadTables({ runDir: path.join(REPO_ROOT, "data/runs/2026-10-31"), complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
    expect(tables.ability("07010008", "text").sacrificeAction).toBe(true);
    expect(tables.ability("07010008", "deployBox").sacrificeAction).toBe(false);
    expect(tables.ability("08010014", "text").takeInitiativeCost).toBe(1);
    expect(tables.ability("04010033", "text").whenDefeated).toBe(true);
  });

  it("does not count a token cost as a sacrifice, and reads nothing from a missing face", () => {
    expect(abilityProfileOf(creditCost, "text").sacrificeAction).toBe(false);
    expect(abilityProfileOf(undefined, "text")).toEqual(ability());
    expect(abilityProfileOf({}, "deployBox")).toEqual(ability());
  });
});

describe("pilot rule: sacrifice guard (sacGuard)", () => {
  const krennic = leader(true, { title: "Krennic", cost: 7, ability: ability({ sacrificeAction: true }) });
  const gideon = card({ title: "Gideon", cardKey: "G1", cost: 3, power: 2, hp: 5, exhausted: true, score: 0 });
  const brute = card({ title: "Brute", cardKey: "B1", cost: 2, power: 2, hp: 3, exhausted: true, score: 1, ability: ability({ whenDefeated: true }) });

  it("rung 1 spends its only good unit on a sacrifice ability; the guard keeps it, a healthy 3-cost When Defeated unit included", () => {
    const v = view({ mine: [gideon], me: { leader: krennic, resources: { total: 3, ready: 0 } } });
    const answers = [button("Pass"), cardAnswer(krennic)];
    expect(labelOf(answers, rules().choose(answers, v))).toBe("Krennic");
    expect(labelOf(answers, rules({ sacGuard: 1 }).choose(answers, v))).toBe("Pass");
    const sentinel = card({ title: "Sentinel", cardKey: "S1", cost: 3, power: 2, hp: 5, exhausted: true, ability: ability({ whenDefeated: true }) });
    expect(labelOf(answers, rules({ sacGuard: 1 }).choose(answers, view({ mine: [sentinel], me: { leader: krennic, resources: { total: 3, ready: 0 } } })))).toBe("Pass");
    const hurt = { ...sentinel, id: "hurt", damage: 2, remainingHp: 3 };
    expect(labelOf(answers, rules({ sacGuard: 1 }).choose(answers, view({ mine: [hurt], me: { leader: krennic, resources: { total: 3, ready: 0 } } })))).toBe("Krennic");
  });

  it("uses the ability when a unit with a When Defeated ability or a token can pay for it", () => {
    const answers = [button("Pass"), cardAnswer(krennic)];
    expect(labelOf(answers, rules({ sacGuard: 1 }).choose(answers, view({ mine: [gideon, brute], me: { leader: krennic, resources: { total: 3, ready: 0 } } })))).toBe("Krennic");
    const token = card({ title: "Spy", cardKey: null, power: 0, hp: 2, exhausted: true });
    expect(labelOf(answers, rules({ sacGuard: 1 }).choose(answers, view({ mine: [gideon, token], me: { leader: krennic, resources: { total: 3, ready: 0 } } })))).toBe("Krennic");
  });

  it("pays the cost with the When Defeated unit, not the cheapest one", () => {
    const prompt = { kind: "target" as const, intent: "defeatOwn" as const, title: "Defeat a friendly unit" };
    const answers = [cardAnswer(gideon), cardAnswer(brute)];
    const v = view({ prompt, mine: [gideon, brute] });
    expect(labelOf(answers, rules().choose(answers, v))).toBe("Gideon");
    expect(labelOf(answers, rules({ sacGuard: 1 }).choose(answers, v))).toBe("Brute");
  });
});

describe("pilot rule: initiative draw (initDraw)", () => {
  const mando = leader(true, { title: "Mando", cost: 6, ability: ability({ takeInitiativeCost: 1 }) });
  const big = card({ title: "Big", cost: 3, score: 2, zone: "hand" });
  const small = card({ title: "Small", cost: 2, score: 1, zone: "hand" });

  it("keeps the trigger's resource for taking the initiative while it can still be taken", () => {
    const v = view({ hand: [big, small], me: { leader: mando, resources: { total: 3, ready: 3 } } });
    const answers = [button("Claim Initiative"), button("Pass"), cardAnswer(big), cardAnswer(small)];
    expect(labelOf(answers, rules().choose(answers, v))).toBe("Big");
    expect(labelOf(answers, rules({ initDraw: 1 }).choose(answers, v))).toBe("Small");
  });

  it("spends everything when the initiative is gone or the leader is deployed", () => {
    const answers = [button("Pass"), cardAnswer(big), cardAnswer(small)];
    expect(labelOf(answers, rules({ initDraw: 1 }).choose(answers, view({ hand: [big, small], me: { leader: mando, resources: { total: 3, ready: 3 } } })))).toBe("Big");
    const withClaim = [button("Claim Initiative"), ...answers];
    const deployed = view({ hand: [big, small], me: { leader: mando, leaderDeployed: true, resources: { total: 3, ready: 3 } } });
    expect(labelOf(withClaim, rules({ initDraw: 1 }).choose(withClaim, deployed))).toBe("Big");
  });
});

describe("pilot rule: resource toward the costliest card in hand (handCap)", () => {
  it("keeps resourcing past the cap while the hand holds a card it cannot yet afford", () => {
    const cheap = card({ title: "Cheap", cost: 2, score: 0 });
    const top = card({ title: "Top", cost: 9, score: 5 });
    const prompt = { kind: "resource" as const, title: "Select between 0 and 1 cards to resource" };
    const answers = [button("Skip Resourcing"), cardAnswer(cheap), cardAnswer(top)];
    const v = view({ prompt, hand: [cheap, top], me: { resources: { total: 7, ready: 7 }, maxDeckCost: 9 } });
    expect(labelOf(answers, rules().choose(answers, v))).toBe("Skip Resourcing");
    expect(labelOf(answers, rules({ handCap: 1 }).choose(answers, v))).toBe("Cheap");
    const done = view({ prompt, hand: [cheap, top], me: { resources: { total: 9, ready: 9 }, maxDeckCost: 9 } });
    expect(labelOf(answers, rules({ handCap: 1 }).choose(answers, done))).toBe("Skip Resourcing");
  });
});

describe("pilot rule: call the aspect our own deck holds most (aspectCall)", () => {
  const aspects = ["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"].map(button);
  const withDeck = (title: string) => {
    const v = view({ prompt: { kind: "menu", title } });
    return { ...v, me: { ...v.me, deckAspects: () => ({ Cunning: 10, Heroism: 8, Vigilance: 12 }) } };
  };

  it("names the commonest aspect of our draw deck and discards from our own deck; rung 1 takes the first button", () => {
    expect(labelOf(aspects, rules().choose(aspects, withDeck("Choose an aspect")))).toBe("Aggression");
    expect(labelOf(aspects, rules({ aspectCall: 1 }).choose(aspects, withDeck("Choose an aspect")))).toBe("Vigilance");
    const decks = [button("Cancel"), button("Opponent's deck"), button("Your deck")];
    expect(labelOf(decks, rules().choose(decks, withDeck("Choose a deck to discard from")))).toBe("Opponent's deck");
    expect(labelOf(decks, rules({ aspectCall: 1 }).choose(decks, withDeck("Choose a deck to discard from")))).toBe("Your deck");
  });
});

describe("pilot policy names", () => {
  const pinned = (file: string): string => (JSON.parse(readFileSync(path.join(REPO_ROOT, "data/pinned/sim-calibration-v1", file), "utf8")) as { policy: { paramsSha256: string } }).policy.paramsSha256;

  it("names a pilot rung by its switches and keeps the pinned rungs' names and params hashes", () => {
    expect(specName(parsePolicySpec("rung1:initDraw=1,sacGuard=1"))).toBe("rung1:sacGuard=1,initDraw=1");
    expect(specName(parsePolicySpec("rung1"))).toBe("rung1");
    expect(policyHeader(parsePolicySpec("rung1")).paramsSha256).toBe(pinned("calibration-rung1.json"));
    expect(specName(parsePolicySpec("rung3:k=8,noPass=1,sacGuard=1"))).toBe("rung3:k=8,sacGuard=1,noPass=1");
    expect(policyHeader(parsePolicySpec("rung3:k=8")).paramsSha256).toBe(pinned("calibration-rung3-k-8.json"));
    expect(policyHeader(parsePolicySpec("rung1:sacGuard=1")).paramsSha256).not.toBe(pinned("calibration-rung1.json"));
  });

  it("rejects a switch that is not 0 or 1, and switches on rung 2", () => {
    expect(() => parsePolicySpec("rung1:sacGuard=2")).toThrow();
    expect(() => parsePolicySpec("rung2:mu=1,lambda=1,sacGuard=1")).toThrow();
  });
});

describe("rung 3 pass exclusion (noPass)", () => {
  const answers = [button("Pass"), button("Claim Initiative"), button("Play A"), button("Play B")];
  it("drops Pass from the candidates unless rung 1's own pick is Pass", () => {
    expect(withoutPass([2, 0, 3], answers)).toEqual([2, 3]);
    expect(withoutPass([0, 2, 3], answers)).toEqual([0, 2, 3]);
  });
});

describe("per-archetype shares beside the tournament", () => {
  const row = (a: string, b: string, simWins: number, simN: number, tWins: number, tN: number): CalibrationRow => ({
    a,
    b,
    aName: a,
    bName: b,
    tournament: { wins: tWins, losses: tN - tWins, n: tN, share: tWins / tN, low: null, high: null, excludesHalf: false },
    sim: { wins: simWins, n: simN, share: simN === 0 ? null : simWins / simN, low: null, high: null, nonDecisive: 0 },
  });

  it("averages the archetype's matchups from its own side with a 95% interval, sim and tournament apart", () => {
    const rows = [row("K", "X", 10, 40, 60, 100), row("Y", "K", 30, 40, 50, 100), row("X", "Y", 20, 40, 50, 100)];
    const k = archetypeShares(rows, "K");
    expect(k.matchups).toBe(2);
    expect(k.sim?.mean).toBeCloseTo(0.25, 6);
    expect(k.tournament.mean).toBeCloseTo(0.55, 6);
    expect(k.error).toBeCloseTo(-0.3, 6);
    expect(k.sim?.low).toBeLessThan(0.25);
    expect(k.sim?.high).toBeGreaterThan(0.25);
    expect(k.tournament.high - k.tournament.low).toBeLessThan((k.sim?.high ?? 0) - (k.sim?.low ?? 0));
  });

  it("skips a matchup with no decisive sim game", () => {
    expect(archetypeShares([row("K", "X", 0, 0, 60, 100)], "K").sim).toBeNull();
  });
});
