/**
 * @displayName Human-trained pilot (rung3h)
 * @strategicPurpose Rung 3 tries its best few actions on the real engine; the human-play priors (#181, D104) decide
 * which few, from how people play the same public position, and pick attack targets the way people do. Simulation bots
 * only; the weights live under /Volumes/Models and are read from scripts/ (D1).
 * @tacticalObjective Loads the priors (weights hash-checked against their manifest), reads the engine view into the
 * public state the human data was featurised from (scripts/human-priors/features.ts), scores every main-action answer
 * as log P(class | state) plus a within-class term (attack ranker for attackers, the leader's card-play prior for
 * plays, an even split otherwise), keeps rung 3's candidates in that order up to hk plus rung 1's pick, and at
 * attack-target prompts picks the target the ranker scores highest.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { HumanParams } from "../../src/sims/policies/index.js";
import { HUMAN_VERSION } from "../../src/sims/policies/index.js";
import { lookaheadPolicy, type LookaheadHooks } from "../../src/sims/policies/rung3.js";
import type { CardTables } from "../../src/sims/policies/tables.js";
import type { CardView, GameView, LegalAnswer, SideView } from "../../src/sims/policies/types.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { ACTION_CLASSES, cardPriorScore, optionFeatures, OPTION_FEATURES, stateFeatures, STATE_FEATURES, type ActionClass, type CardPrior, type PSide, type PState, type PUnit } from "./features.js";

export const HUMAN_PRIORS_ROOT = "/Volumes/Models/swu/swu-mcp/human-priors";
export const priorsDir = (version: number): string => path.join(process.env.SWU_HUMAN_PRIORS_ROOT ?? HUMAN_PRIORS_ROOT, "v" + String(version));

const linearSchema = z.strictObject({
  features: z.array(z.string()),
  mean: z.array(z.number()),
  scale: z.array(z.number()),
  coef: z.array(z.array(z.number())),
  intercept: z.array(z.number()),
  classes: z.array(z.string()).nullable(),
});
export type Linear = z.infer<typeof linearSchema>;
const modelsSchema = z.strictObject({ schemaVersion: z.literal(1), heldOutFold: z.int(), split: z.string(), actionType: linearSchema, attack: linearSchema, value: linearSchema });
const cardPriorSchema = z.strictObject({ alpha: z.number(), total: z.number(), global: z.record(z.string(), z.number()), byLeader: z.record(z.string(), z.record(z.string(), z.number())) });
const manifestSchema = z.looseObject({ files: z.strictObject({ "models.json": z.string(), "card-prior.json": z.string() }) });

export interface Priors {
  actionType: Linear;
  attack: Linear;
  value: Linear;
  cardPrior: CardPrior;
  sha256: { models: string; cardPrior: string };
}

/** Reads and verifies one priors directory: each file's sha256 must match the manifest, and the layouts ours. */
export function loadPriors(dir: string): Priors {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  const read = (name: "models.json" | "card-prior.json"): { text: string; sha: string } => {
    const text = readFileSync(path.join(dir, name), "utf8");
    const sha = sha256Hex(text);
    if (sha !== manifest.files[name]) throw new Error(`human priors ${name} sha256 ${sha} differs from its manifest (${manifest.files[name]})`);
    return { text, sha };
  };
  const m = read("models.json");
  const c = read("card-prior.json");
  const models = modelsSchema.parse(JSON.parse(m.text));
  const same = (got: readonly string[], want: readonly string[], what: string) => {
    if (got.length !== want.length || got.some((f, i) => f !== want[i])) throw new Error(`human priors ${what} columns differ from scripts/human-priors/features.ts`);
  };
  same(models.actionType.features, STATE_FEATURES, "action-type");
  same(models.value.features, STATE_FEATURES, "value");
  same(models.attack.features, OPTION_FEATURES, "attack");
  same(models.actionType.classes ?? [], ACTION_CLASSES, "action classes");
  return { actionType: models.actionType, attack: models.attack, value: models.value, cardPrior: cardPriorSchema.parse(JSON.parse(c.text)), sha256: { models: m.sha, cardPrior: c.sha } };
}

/** Logits of a standardised linear model, one per class row. */
export function logits(m: Linear, x: readonly number[]): number[] {
  return m.coef.map((row, c) => row.reduce((s, w, i) => s + (w * (x[i] - m.mean[i])) / m.scale[i], m.intercept[c]));
}
const logSoftmax = (xs: readonly number[]): number[] => {
  const top = Math.max(...xs);
  const lse = top + Math.log(xs.reduce((s, x) => s + Math.exp(x - top), 0));
  return xs.map((x) => x - lse);
};

const unitOfView = (c: CardView): PUnit => ({ power: c.power, hpLeft: c.remainingHp, cost: c.cost, exhausted: c.exhausted, arena: c.zone === "space" ? "space" : "ground", sentinel: c.keywords.has("sentinel") });
const inPlay = (c: CardView): boolean => c.zone === "ground" || c.zone === "space";

export function stateFromView(v: GameView): PState {
  const side = (s: SideView, hand: number): PSide => ({ baseDamage: s.base.damage, hand, ready: s.resources.ready, total: s.resources.total, units: s.units.filter(inPlay).map(unitOfView), leaderDeployed: s.leaderDeployed });
  return { round: v.round, initiative: v.me.hasInitiative, me: side(v.me, v.me.handSize), opp: side(v.opp, v.opp.handSize) };
}

/** The main-action class an answer belongs to; null for anything else. */
export function answerClass(a: LegalAnswer, v: GameView): ActionClass | null {
  if (a.kind === "button") return /^pass\b/i.test(a.label) ? "pass" : /claim initiative/i.test(a.label) ? "claim" : null;
  if (a.kind !== "card" || a.cardId === null) return null;
  const c = v.cards.get(a.cardId);
  if (c === undefined || !c.mine) return null;
  if (c.zone === "hand" || c.zone === "resource" || c.zone === "discard") return "play";
  if (inPlay(c) && c.kind !== "leader" && !c.exhausted && c.power > 0) return "attack";
  if (inPlay(c) && c.leader && !c.exhausted && c.power > 0) return "attack";
  return "ability";
}

/** Legal targets of one attacker on the view: its arena, Sentinels first unless it is a Saboteur, else the units and the base. */
function targetsOf(att: CardView, v: GameView): (CardView | "base")[] {
  const there = v.opp.units.filter((u) => inPlay(u) && u.zone === att.zone);
  const sentinels = att.keywords.has("saboteur") ? [] : there.filter((u) => u.keywords.has("sentinel"));
  return sentinels.length > 0 ? sentinels : [...there, "base"];
}

const optionScore = (p: Priors, s: PState, att: CardView, t: CardView | "base", n: number): number => logits(p.attack, optionFeatures(s, unitOfView(att), t === "base" ? "base" : unitOfView(t), n))[0];

/** Log-prior of every answer; -Infinity for answers outside the five classes. */
export function answerScores(p: Priors, answers: readonly LegalAnswer[], v: GameView): number[] {
  const s = stateFromView(v);
  const classLog = logSoftmax(logits(p.actionType, stateFeatures(s)));
  const cls = answers.map((a) => answerClass(a, v));
  const within = new Array<number>(answers.length).fill(0);
  const group = (c: ActionClass) => answers.map((_, i) => i).filter((i) => cls[i] === c);
  const card = (i: number): CardView => v.cards.get(answers[i].cardId as string) as CardView;
  const attackers = group("attack");
  if (attackers.length > 0) {
    const best = attackers.map((i) => {
      const ts = targetsOf(card(i), v);
      return Math.max(...ts.map((t) => optionScore(p, s, card(i), t, ts.length)));
    });
    logSoftmax(best).forEach((x, j) => (within[attackers[j]] = x));
  }
  const plays = group("play");
  if (plays.length > 0) {
    const leader = v.me.leader.cardKey;
    logSoftmax(plays.map((i) => (card(i).cardKey === null ? Math.log(1e-6) : cardPriorScore(p.cardPrior, leader, card(i).cardKey as string)))).forEach((x, j) => (within[plays[j]] = x));
  }
  for (const c of ["ability", "pass", "claim"] as const) {
    const g = group(c);
    for (const i of g) within[i] = -Math.log(g.length);
  }
  return answers.map((_, i) => {
    const c = cls[i];
    return c === null ? Number.NEGATIVE_INFINITY : classLog[ACTION_CLASSES.indexOf(c)] + within[i];
  });
}

/** Rung 3's candidates (ranked; ranked[0] is rung 1's pick) in prior order, cut to hk, with rung 1's pick kept. */
export function priorOrder(p: Priors, answers: readonly LegalAnswer[], v: GameView, ranked: readonly number[], top: number, hk: number): number[] {
  const score = answerScores(p, answers, v);
  const rank = new Map(ranked.map((i, r) => [i, r]));
  const order = [...ranked].sort((a, b) => score[b] - score[a] || (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || compareCodePoints(answers[a].descriptor, answers[b].descriptor));
  const kept = order.slice(0, hk);
  if (!kept.includes(top)) kept.push(top);
  return kept;
}

/** At an attack-target prompt: the enemy card answer the attack ranker scores highest; null hands the prompt to rung 1. */
export function attackTargetPick(p: Priors, answers: readonly LegalAnswer[], v: GameView): number | null {
  if (v.prompt.kind !== "attackTarget" || v.prompt.sourceId === null) return null;
  const att = v.cards.get(v.prompt.sourceId);
  if (att === undefined) return null;
  const s = stateFromView(v);
  const cands = answers.flatMap((a, i) => {
    const c = a.kind === "card" && a.cardId !== null ? v.cards.get(a.cardId) : undefined;
    if (c === undefined || c.mine) return [];
    return [{ i, t: c.kind === "base" ? ("base" as const) : c }];
  });
  if (cands.length === 0) return null;
  let best = cands[0];
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const c of cands) {
    const sc = optionScore(p, s, att, c.t, cands.length);
    if (sc > bestScore) {
      best = c;
      bestScore = sc;
    }
  }
  return best.i;
}

export function humanHooks(p: Priors, params: HumanParams): LookaheadHooks {
  return {
    policyId: "rung3-human",
    policyVersion: HUMAN_VERSION,
    candidates: (answers, view, ranked) => priorOrder(p, answers, view, ranked, ranked[0], params.hk),
    ...(params.at === 1 ? { override: (answers: readonly LegalAnswer[], view: GameView) => attackTargetPick(p, answers, view) } : {}),
  };
}

export function humanPolicy(tables: CardTables, params: HumanParams, inputs: Record<string, string>, p: Priors) {
  return lookaheadPolicy(tables, params, inputs, humanHooks(p, params));
}
