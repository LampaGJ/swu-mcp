import { describe, expect, it } from "vitest";
import type { BoardUnit, DecisionRecord } from "../../scripts/human-priors/decisions.js";
import { actionClass, descriptorOf, foldOf, optionFeatures, OPTION_FEATURES, stateFeatures, STATE_FEATURES, stateFromRecord, type PState } from "../../scripts/human-priors/features.js";

const u = (o: Partial<BoardUnit> = {}): BoardUnit => ({ card: "K", cost: 3, power: 2, hp: 4, damage: 1, exhausted: false, arena: "ground", kw: [], up: 0, ...o });

const rec = (o: Partial<DecisionRecord> = {}): DecisionRecord =>
  ({
    g: "00000005aaaaaaaa",
    i: 3,
    seat: 1,
    turn: 4,
    phase: "action",
    kind: "attack",
    card: "K",
    cardType: "basicUnit",
    cardRef: true,
    target: "base",
    targetRef: true,
    smuggle: null,
    initiative: true,
    me: { resources: 2, totalResources: 5, baseDamage: 3, hand: 4, deck: 30, discard: 2, credits: 0, ground: 2, space: 0, power: 5, leader: null, base: null, aspects: [] },
    opp: { resources: 1, totalResources: 4, baseDamage: 7, hand: 6, deck: 31, discard: 1, credits: 0, ground: 1, space: 1, power: 4, leader: null, base: null, aspects: [] },
    before: { me: [u(), u({ exhausted: true, power: 3, kw: ["Sentinel"] })], opp: [u({ arena: "space", power: 4, hp: 4, damage: 0 })], meLeader: { exhausted: false, damage: 0, deployed: true }, oppLeader: null },
    won: 1,
    forfeit: false,
    flags: { undone: false, revert: false, repeat: false },
    ...o,
  }) as DecisionRecord;

describe("public-state features shared by the human data and the pilot", () => {
  it("reads one record into the viewer-relative public state and a fixed-length vector", () => {
    const s = stateFromRecord(rec()) as PState;
    expect(s.me.units).toHaveLength(2);
    expect(s.me).toMatchObject({ baseDamage: 3, hand: 4, ready: 2, total: 5, leaderDeployed: true });
    const v = stateFeatures(s);
    expect(v).toHaveLength(STATE_FEATURES.length);
    const at = (name: string) => v[STATE_FEATURES.indexOf(name as (typeof STATE_FEATURES)[number])];
    expect(at("meReadyPower")).toBe(2);
    expect(at("mePowerGround")).toBe(5);
    expect(at("meHpLeft")).toBe(6);
    expect(at("meSentinels")).toBe(1);
    expect(at("oppPowerSpace")).toBe(4);
    expect(at("baseDamageDiff")).toBe(4);
    expect(at("round")).toBe(4);
    expect(stateFromRecord(rec({ before: null }))).toBeNull();
  });

  it("describes one attack option by attacker, target and the trade it makes", () => {
    const s = stateFromRecord(rec()) as PState;
    const atk = { power: 4, hpLeft: 2, cost: 3, exhausted: false, arena: "space" as const, sentinel: false };
    const tgt = { power: 4, hpLeft: 4, cost: 5, exhausted: false, arena: "space" as const, sentinel: false };
    const v = optionFeatures(s, atk, tgt, 3);
    expect(v).toHaveLength(OPTION_FEATURES.length);
    const at = (name: string) => v[OPTION_FEATURES.indexOf(name as (typeof OPTION_FEATURES)[number])];
    expect([at("kills"), at("dies"), at("trade"), at("toBase"), at("costGain")]).toEqual([1, 1, 1, 0, 2]);
    const b = optionFeatures(s, atk, "base", 3);
    expect([at("toBase"), b[OPTION_FEATURES.indexOf("toBase")], b[OPTION_FEATURES.indexOf("baseHit")]]).toEqual([0, 1, 4]);
  });

  it("maps decision kinds to the five main-action classes and to canonical descriptor kinds", () => {
    expect(["attack", "play_unit", "play_event", "unit_ability", "leader_ability", "pass", "claim_initiative", "resource", "mulligan"].map((k) => actionClass(k as DecisionRecord["kind"]))).toEqual([
      "attack",
      "play",
      "play",
      "ability",
      "ability",
      "pass",
      "claim",
      null,
      null,
    ]);
    expect(descriptorOf(rec())).toBe("act|K|ground");
    expect(descriptorOf(rec({ kind: "play_unit", card: "P" }))).toBe("play|P|hand");
    expect(descriptorOf(rec({ kind: "claim_initiative", card: null }))).toBe("takeInitiative||");
    expect(descriptorOf(rec({ kind: "play_unit", card: null }))).toBeNull();
    expect(descriptorOf(rec({ kind: "mulligan", card: null }))).toBeNull();
  });

  it("splits by game: every row of a game lands in one fold", () => {
    expect(foldOf("00000005aaaaaaaa")).toBe(0);
    expect(foldOf("00000006aaaaaaaa")).toBe(1);
    expect(foldOf(rec().g)).toBe(foldOf(rec({ i: 99 }).g));
  });
});
