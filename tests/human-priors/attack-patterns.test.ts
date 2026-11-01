import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BoardUnit, DecisionRecord } from "../../scripts/human-priors/decisions.js";
import { aggregateAttacks, attackEvent, type AttackEvent } from "../../scripts/human-priors/attack-patterns.js";
import { attackPatternsSchema, populationSchema } from "../../src/play/attack-patterns.js";

const u = (card: string, o: Partial<BoardUnit> = {}): BoardUnit => ({ card, cost: 2, power: 3, hp: 3, damage: 0, exhausted: false, arena: "ground", kw: [], up: 0, ...o });

const ev = (o: Partial<AttackEvent>): AttackEvent => ({ game: "g1", side: "s1", won: 1, attacker: "A", target: "base", before: null, after: null, baseDamage: null, ...o });

describe("aggregateAttacks", () => {
  const events: AttackEvent[] = [
    // A hits the base twice in game 1 (side wins), dealing 3 then unknown.
    ev({ baseDamage: 3, before: { me: [u("A")], opp: [] }, after: { me: [u("A", { exhausted: true })], opp: [] } }),
    ev({}),
    // A trades with X in game 2 (side loses): both defeated.
    ev({ game: "g2", side: "s2", won: 0, target: "X", before: { me: [u("A")], opp: [u("X")] }, after: { me: [], opp: [] } }),
    // A hits Y in game 3 for 3 of 5 HP and survives; side result unknown.
    ev({ game: "g3", side: "s3", won: null, target: "Y", before: { me: [u("A")], opp: [u("Y", { hp: 5 })] }, after: { me: [u("A", { damage: 1, exhausted: true })], opp: [u("Y", { hp: 5, damage: 3 })] } }),
    // B attacks an unresolved unit; an unresolved attacker is counted, never listed.
    ev({ game: "g3", side: "s4", won: null, attacker: "B", target: null }),
    ev({ game: "g3", side: "s4", won: null, attacker: null, target: "base" }),
  ];
  const pop = aggregateAttacks(events, { method: "human play", label: "test population", window: null, top: 30, topTargets: 10, notes: [], title: (k) => "T-" + k });

  it("counts attacks, games and attacks per game by card, unresolved ones apart", () => {
    expect(populationSchema.safeParse(pop).success).toBe(true);
    expect(pop).toMatchObject({ method: "human play", tier: "casual online games", games: 3, attacks: 6, unresolvedAttackers: 1, unresolvedTargets: 1, measuredAttacks: 3 });
    expect(pop.attackers.map((a) => [a.cardKey, a.attacks, a.games, a.gameShare, a.attacksPerGame])).toEqual([
      ["A", 4, 3, 1, 1.3333],
      ["B", 1, 1, 0.3333, 1],
    ]);
  });

  it("splits targets into base and units with the top unit targets", () => {
    const a = pop.attackers[0];
    expect(a.targets).toEqual({ base: 2, units: 2, unresolvedUnits: 0, baseShare: 0.5 });
    expect(a.topTargets).toEqual([
      { cardKey: "X", title: "T-X", attacks: 1, share: 0.25 },
      { cardKey: "Y", title: "T-Y", attacks: 1, share: 0.25 },
    ]);
  });

  it("reads combat results from the before and after boards", () => {
    expect(pop.attackers[0].results).toEqual({ measured: 3, unitAttacks: 2, targetDefeated: 1, attackerDefeated: 1, both: 1, neither: 1, meanDamageToTarget: 3, baseAttacks: 1, meanBaseDamage: 3 });
  });

  it("counts the attacking side's game result once per side, with a Wilson interval", () => {
    expect(pop.attackers[0].sideResult).toMatchObject({ sides: 2, wins: 1, winShare: 0.5 });
    expect(pop.attackers[0].sideResult.low).toBeLessThan(0.5);
    expect(pop.attackers[1].sideResult).toEqual({ sides: 0, wins: 0, winShare: null, low: null, high: null });
  });

  it("is order-free", () => {
    const again = aggregateAttacks([...events].reverse(), { method: "human play", label: "test population", window: null, top: 30, topTargets: 10, notes: [], title: (k) => "T-" + k });
    expect(JSON.stringify(again)).toBe(JSON.stringify(pop));
  });
});

describe("attackEvent", () => {
  const rec = (o: Partial<DecisionRecord>): DecisionRecord =>
    ({
      g: "0123456789abcdef",
      i: 0,
      seat: 1,
      turn: 1,
      phase: "action",
      kind: "attack",
      card: "A",
      cardType: "basicUnit",
      cardRef: true,
      target: "base",
      targetRef: true,
      smuggle: null,
      initiative: true,
      me: { resources: 1, totalResources: 1, baseDamage: 0, hand: 1, deck: 1, discard: 0, credits: 0, ground: 1, space: 0, power: 3, leader: null, base: null, aspects: [] },
      opp: { resources: 1, totalResources: 1, baseDamage: 4, hand: 1, deck: 1, discard: 0, credits: 0, ground: 0, space: 0, power: 0, leader: null, base: null, aspects: [] },
      before: null,
      won: 1,
      forfeit: false,
      flags: { undone: false, revert: false, repeat: false },
      next: { meBaseDamage: 0, oppBaseDamage: 7 },
      ...o,
    }) as DecisionRecord;

  it("takes base damage from the next row and skips undone, repeated and non-attack rows", () => {
    expect(attackEvent(rec({}))?.baseDamage).toBe(3);
    expect(attackEvent(rec({ flags: { undone: true, revert: false, repeat: false } }))).toBeNull();
    expect(attackEvent(rec({ flags: { undone: false, revert: false, repeat: true } }))).toBeNull();
    expect(attackEvent(rec({ kind: "pass" }))).toBeNull();
    expect(attackEvent(rec({ won: null, seat: null }))?.side).toBe(attackEvent(rec({ won: null, seat: null }))?.side);
  });
});

describe("the data product names no player or game (D102)", () => {
  it("has no player name, player id or game id field anywhere in its schema", () => {
    const props: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.properties !== undefined) props.push(...Object.keys(o.properties as object));
      for (const v of Object.values(o)) walk(v);
    };
    walk(z.toJSONSchema(attackPatternsSchema));
    expect(props.length).toBeGreaterThan(20);
    expect(props.filter((p) => /player|^name$|^id$|gameid|game_id|^g$|^game$|^side$|uuid|user/i.test(p))).toEqual([]);
  });
});
