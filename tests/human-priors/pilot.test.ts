import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_CLASSES, OPTION_FEATURES, STATE_FEATURES, type CardPrior } from "../../scripts/human-priors/features.js";
import { answerClass, attackTargetPick, loadPriors, priorOrder, stateFromView, type Priors } from "../../scripts/human-priors/pilot.js";
import { sha256Hex } from "../../src/swu/canonical.js";
import { parsePolicySpec, policyHeader, specName } from "../../src/sims/policies/index.js";
import { driverName, registerRungs } from "../../src/sims/policies/typed-adapter.js";
import type { CardTables } from "../../src/sims/policies/tables.js";
import { button, card, cardAnswer, view } from "../sims/policies/fixtures.js";

const linear = (features: readonly string[], classes: number, weights: Record<string, number[]> = {}, intercept: number[] = new Array(classes).fill(0)) => ({
  features: [...features],
  mean: features.map(() => 0),
  scale: features.map(() => 1),
  coef: Array.from({ length: classes }, (_, c) => features.map((f) => weights[f]?.[c] ?? 0)),
  intercept,
  classes: null as string[] | null,
});

/** Synthetic priors: humans attack most, then play; they attack what they can kill; with leader L1 they play P2. */
const priors: Priors = {
  actionType: { ...linear(STATE_FEATURES, 5, {}, [3, 2, 1, 0, -1]), classes: [...ACTION_CLASSES] },
  attack: linear(OPTION_FEATURES, 1, { kills: [5], toBase: [1] }),
  value: linear(STATE_FEATURES, 1),
  cardPrior: { alpha: 20, total: 10, global: { P1: 5, P2: 5 }, byLeader: { L1: { P2: 10 } } } satisfies CardPrior,
  sha256: { models: "0".repeat(64), cardPrior: "1".repeat(64) },
};

describe("rung3h names (#181)", () => {
  it("has a canonical name that always states k, hk and hp, and its own params hash", () => {
    expect(driverName("rung3h")).toBe("rung3h:k=8,hk=4,hp=v1");
    expect(specName(parsePolicySpec("rung3h:hk=3,at=0"))).toBe("rung3h:k=8,hk=3,hp=v1,at=0");
    expect(specName(parsePolicySpec("rung3h:hp=v1,k=6,sacGuard=1"))).toBe("rung3h:k=6,hk=4,hp=v1,sacGuard=1");
    const h = policyHeader(parsePolicySpec("rung3h"));
    expect(h).toMatchObject({ id: "rung3-human", rung: 3, version: "1" });
    expect(h.params).toMatchObject({ k: 8, hk: 4, hp: 1, at: 1 });
    expect(h.paramsSha256).not.toBe(policyHeader(parsePolicySpec("rung3:k=8")).paramsSha256);
    expect(() => parsePolicySpec("rung3h:hk=0")).toThrow(/hk/);
    expect(() => parsePolicySpec("rung3h:hp=1")).toThrow(/bad policy parameter/);
  });

  it("is never registered from src/ (it reads model weights, D1)", () => {
    const registry: Record<string, () => unknown> = {};
    registerRungs(registry, () => ({}), ["rung3h"], { pins: {} } as unknown as CardTables);
    expect(registry).toEqual({});
  });
});

describe("human-play priors on an engine view", () => {
  const mine = card({ id: "m1", power: 3, hp: 3, zone: "ground" });
  const tired = card({ id: "m2", power: 3, hp: 3, zone: "ground", exhausted: true });
  const weak = card({ id: "t1", power: 1, hp: 2, zone: "ground", cost: 4 });
  const tough = card({ id: "t2", power: 5, hp: 6, zone: "ground", cost: 6 });
  const p1 = card({ id: "h1", cardKey: "P1", kind: "unit", cost: 1 });
  const p2 = card({ id: "h2", cardKey: "P2", kind: "unit", cost: 1 });

  it("reads the public state the human data was featurised from", () => {
    const v = view({ mine: [mine, tired], theirs: [weak], hand: [p1], me: { resources: { total: 5, ready: 2 } } });
    const s = stateFromView(v);
    expect(s.me).toMatchObject({ ready: 2, total: 5, hand: 1, baseDamage: 0 });
    expect(s.me.units.map((u) => u.exhausted)).toEqual([false, true]);
    expect(s.opp.units[0]).toMatchObject({ power: 1, hpLeft: 2, cost: 4 });
  });

  it("classes main-action answers as attack, play, ability, pass or claim", () => {
    const v = view({ mine: [mine, tired], hand: [p1] });
    const answers = [cardAnswer(mine), cardAnswer(tired), cardAnswer(v.me.hand[0]), cardAnswer(v.me.leader), button("Pass"), button("Claim Initiative")];
    expect(answers.map((a) => answerClass(a, v))).toEqual(["attack", "ability", "play", "ability", "pass", "claim"]);
  });

  it("orders rung 3's candidates by the priors, keeps hk of them and always keeps rung 1's pick", () => {
    const v = view({ mine: [mine], theirs: [weak], hand: [p1, p2], me: { leader: card({ id: "myLeader", cardKey: "L1", kind: "leader", zone: "base", leader: true }) } });
    const answers = [button("Pass"), cardAnswer(v.me.hand[0]), cardAnswer(v.me.hand[1]), cardAnswer(mine)];
    // Rung 1 ranked: Pass, P1, P2, attack. Priors: attack first (class), then P2 over P1 (leader L1), Pass last.
    expect(priorOrder(priors, answers, v, [0, 1, 2, 3], 0, 2)).toEqual([3, 2, 0]);
    expect(priorOrder(priors, answers, v, [0, 1, 2, 3], 3, 2)).toEqual([3, 2]);
    expect(priorOrder(priors, answers, v, [0, 1, 2, 3], 0, 8)).toEqual([3, 2, 1, 0]);
  });

  it("picks the attack target the ranker prefers, never a friendly card", () => {
    const v = view({ mine: [mine], theirs: [tough, weak], prompt: { kind: "attackTarget", sourceId: "m1" } });
    const answers = [cardAnswer(v.opp.units[0]), cardAnswer(v.opp.units[1]), cardAnswer(v.opp.base), button("Cancel")];
    expect(attackTargetPick(priors, answers, v)).toBe(1);
    expect(attackTargetPick(priors, [button("Cancel")], v)).toBeNull();
    expect(attackTargetPick(priors, answers, view({ mine: [mine], theirs: [weak], prompt: { kind: "action" } }))).toBeNull();
  });
});

describe("loadPriors", () => {
  it("refuses weights whose hash differs from the manifest", () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "tmp", "hp-priors-"));
    const models = JSON.stringify({ schemaVersion: 1, heldOutFold: 0, split: "by game", actionType: priors.actionType, attack: priors.attack, value: priors.value });
    const prior = JSON.stringify(priors.cardPrior);
    writeFileSync(path.join(dir, "models.json"), models);
    writeFileSync(path.join(dir, "card-prior.json"), prior);
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ files: { "models.json": sha256Hex(models), "card-prior.json": sha256Hex(prior) } }));
    expect(loadPriors(dir).sha256.models).toBe(sha256Hex(models));
    writeFileSync(path.join(dir, "models.json"), models + " ");
    expect(() => loadPriors(dir)).toThrow(/sha256/);
  });
});
