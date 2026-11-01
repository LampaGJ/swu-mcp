/**
 * @displayName Human-prior feature layout
 * @strategicPurpose The human-play priors are trained on decision records and used inside the simulator on engine
 * views; both sides must compute the same numbers from the same public facts, or the pilot reads a model it was not
 * trained for (#181, D104).
 * @tacticalObjective One viewer-relative public state (both bases' damage, hand sizes, ready and total resources,
 * units with power, remaining HP, cost, readiness, arena and Sentinel, leader deployed, round, initiative), a fixed
 * state vector and a fixed attack-option vector over it, the five main-action classes, the canonical descriptor
 * prefix of a decision, and the by-game fold.
 */
import type { BoardUnit, DecisionRecord } from "./decisions.js";

export interface PUnit {
  power: number;
  hpLeft: number;
  cost: number;
  exhausted: boolean;
  arena: "ground" | "space";
  sentinel: boolean;
}
export interface PSide {
  baseDamage: number;
  hand: number;
  ready: number;
  total: number;
  units: PUnit[];
  leaderDeployed: boolean;
}
export interface PState {
  round: number;
  initiative: boolean;
  me: PSide;
  opp: PSide;
}

const SIDE = ["BaseDamage", "Hand", "Ready", "Total", "Ground", "Space", "ReadyUnits", "PowerGround", "PowerSpace", "ReadyPower", "HpLeft", "Sentinels", "LeaderDeployed", "MaxPower"] as const;
export const STATE_FEATURES = [...SIDE.map((k) => "me" + k), ...SIDE.map((k) => "opp" + k), "round", "initiative", "baseDamageDiff", "powerDiff", "unitDiff"] as const;

export const OPTION_FEATURES = [
  "aPower",
  "aHpLeft",
  "aCost",
  "aSpace",
  "toBase",
  "tPower",
  "tHpLeft",
  "tCost",
  "tSentinel",
  "tExhausted",
  "kills",
  "dies",
  "trade",
  "killFree",
  "chump",
  "costGain",
  "baseHit",
  "meBaseDamage",
  "oppBaseDamage",
  "options",
] as const;

export const unitOf = (u: BoardUnit): PUnit => ({ power: u.power, hpLeft: Math.max(0, u.hp - u.damage), cost: u.cost, exhausted: u.exhausted, arena: u.arena, sentinel: u.kw.includes("Sentinel") });

/** The public state a record's decision was made on; null without a before-board. */
export function stateFromRecord(r: DecisionRecord): PState | null {
  if (r.before === null) return null;
  const side = (s: DecisionRecord["me"], units: readonly BoardUnit[], deployed: boolean): PSide => ({ baseDamage: s.baseDamage, hand: s.hand, ready: s.resources, total: s.totalResources, units: units.map(unitOf), leaderDeployed: deployed });
  return {
    round: r.turn,
    initiative: r.initiative,
    me: side(r.me, r.before.me, r.before.meLeader?.deployed ?? false),
    opp: side(r.opp, r.before.opp, r.before.oppLeader?.deployed ?? false),
  };
}

function sideVector(s: PSide): number[] {
  const sum = (f: (u: PUnit) => number, keep: (u: PUnit) => boolean = () => true) => s.units.filter(keep).reduce((n, u) => n + f(u), 0);
  return [
    s.baseDamage,
    s.hand,
    s.ready,
    s.total,
    s.units.filter((u) => u.arena === "ground").length,
    s.units.filter((u) => u.arena === "space").length,
    s.units.filter((u) => !u.exhausted).length,
    sum((u) => u.power, (u) => u.arena === "ground"),
    sum((u) => u.power, (u) => u.arena === "space"),
    sum((u) => u.power, (u) => !u.exhausted),
    sum((u) => u.hpLeft),
    s.units.filter((u) => u.sentinel).length,
    s.leaderDeployed ? 1 : 0,
    Math.max(0, ...s.units.map((u) => u.power)),
  ];
}

export function stateFeatures(s: PState): number[] {
  const me = sideVector(s.me);
  const opp = sideVector(s.opp);
  const power = (v: number[]) => v[7] + v[8];
  return [...me, ...opp, s.round, s.initiative ? 1 : 0, s.opp.baseDamage - s.me.baseDamage, power(me) - power(opp), s.me.units.length - s.opp.units.length];
}

export function optionFeatures(s: PState, a: PUnit, t: PUnit | "base", options: number): number[] {
  const base = t === "base";
  const tu: PUnit = base ? { power: 0, hpLeft: 0, cost: 0, exhausted: false, arena: a.arena, sentinel: false } : t;
  const kills = !base && a.power >= tu.hpLeft ? 1 : 0;
  const dies = !base && tu.power >= a.hpLeft ? 1 : 0;
  return [
    a.power,
    a.hpLeft,
    a.cost,
    a.arena === "space" ? 1 : 0,
    base ? 1 : 0,
    tu.power,
    tu.hpLeft,
    tu.cost,
    tu.sentinel ? 1 : 0,
    tu.exhausted ? 1 : 0,
    kills,
    dies,
    kills && dies ? 1 : 0,
    kills && !dies ? 1 : 0,
    !kills && dies ? 1 : 0,
    (kills ? tu.cost : 0) - (dies ? a.cost : 0),
    base ? a.power : 0,
    s.me.baseDamage,
    s.opp.baseDamage,
    options,
  ];
}

export const ACTION_CLASSES = ["attack", "play", "ability", "pass", "claim"] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** The main-action class of a decision kind; null for kinds that are not main-action choices. */
export function actionClass(kind: DecisionRecord["kind"]): ActionClass | null {
  switch (kind) {
    case "attack":
      return "attack";
    case "play_unit":
    case "play_event":
      return "play";
    case "unit_ability":
    case "leader_ability":
    case "base_ability":
    case "ability":
      return "ability";
    case "pass":
      return "pass";
    case "claim_initiative":
      return "claim";
    default:
      return null;
  }
}

/**
 * The `kind|card|zone` prefix of our canonical descriptor (src/sims/actions.ts) a decision maps to; ordinal and tail
 * are never recoverable. Null when the kind has no canonical counterpart or the card part is unknown.
 */
export function descriptorOf(r: DecisionRecord): string | null {
  const cls = actionClass(r.kind);
  if (cls === "pass") return "pass||";
  if (cls === "claim") return "takeInitiative||";
  if (cls === null || r.card === null) return null;
  if (cls === "play") return "play|" + r.card + "|hand";
  const zone = r.kind === "leader_ability" ? "base" : r.kind === "base_ability" ? "base" : (r.before?.me.find((u) => u.card === r.card)?.arena ?? "ground");
  return "act|" + r.card + "|" + zone;
}

/** Five folds by game key; fold 0 is held out. Every row of one game shares its fold. */
export const foldOf = (game: string): number => Number.parseInt(game.slice(0, 8), 16) % 5;

/** Count-based card-play prior: per-leader counts smoothed toward the global play distribution. */
export interface CardPrior {
  alpha: number;
  global: Record<string, number>;
  total: number;
  byLeader: Record<string, Record<string, number>>;
}

export function cardPriorScore(prior: CardPrior, leader: string | null, card: string): number {
  const vocab = Object.keys(prior.global).length + 1;
  const pg = ((prior.global[card] ?? 0) + 1) / (prior.total + vocab);
  const row = leader === null ? undefined : prior.byLeader[leader];
  if (row === undefined) return Math.log(pg);
  const n = Object.values(row).reduce((s, x) => s + x, 0);
  return Math.log(((row[card] ?? 0) + prior.alpha * pg) / (n + prior.alpha));
}
