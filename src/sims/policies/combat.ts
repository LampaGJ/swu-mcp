import type { CardView, GameView, Keyword } from "./types.js";

/**
 * @displayName Bot combat arithmetic
 * @strategicPurpose Lets a rule bot judge an attack the way a player does at the table: who dies, who survives, how much
 * reaches the base, from printed and current power, HP, damage and keywords rather than from a card's name.
 * @tacticalObjective Pure functions over CardView: attack outcome (Raid, Shield, Saboteur, Overwhelm), legal attack
 * targets under Sentinel, a unit's threat, lethal reach on the enemy base, and the best attack per attacker.
 */

/** Threat weights (estimates, tuned on the seeded grid): power counts most, then cost, then keywords and score. */
export const THREAT = { power: 1, hp: 0.25, cost: 0.5, leader: 2, shield: 1, score: 0.5 } as const;
const KEYWORD_THREAT: Partial<Record<Keyword, number>> = { overwhelm: 1, saboteur: 1, sentinel: 1, grit: 1, ambush: 0.5, shielded: 0.5, hidden: 0.5 };

export const has = (c: CardView, k: Keyword): boolean => c.keywords.has(k);
export const isUnitInPlay = (c: CardView): boolean => c.zone === "ground" || c.zone === "space";

export function threat(c: CardView): number {
  let t = THREAT.power * c.power + THREAT.hp * c.remainingHp + THREAT.cost * c.cost + THREAT.score * Math.max(0, c.score);
  for (const k of c.keywords) t += KEYWORD_THREAT[k] ?? 0;
  t += c.raid;
  if (c.shield) t += THREAT.shield;
  if (c.leader) t += THREAT.leader;
  return t;
}

/** Power an attacker deals while attacking: current power plus Raid. */
export const attackPower = (a: CardView): number => Math.max(0, a.power + a.raid);

export interface AttackOutcome {
  defenderDies: boolean;
  attackerDies: boolean;
  /** Damage to the defending base: the full hit on a base, Overwhelm excess on a unit. */
  baseDamage: number;
}

/** One attack resolved on printed arithmetic. A Shield absorbs one hit; Saboteur strips the defender's shield first. */
export function attackOutcome(att: CardView, def: CardView): AttackOutcome {
  const p = attackPower(att);
  if (def.kind === "base") return { defenderDies: p >= def.remainingHp, attackerDies: false, baseDamage: p };
  const defShield = def.shield && !has(att, "saboteur");
  const defenderDies = !defShield && p >= def.remainingHp;
  const attackerDies = !att.shield && def.power >= att.remainingHp && def.power > 0;
  const baseDamage = !defShield && has(att, "overwhelm") ? Math.max(0, p - def.remainingHp) : 0;
  return { defenderDies, attackerDies, baseDamage };
}

/** Enemy cards an attacker may attack: units in its arena (Sentinel first unless Saboteur), and the base when no Sentinel blocks. */
export function attackTargets(att: CardView, view: GameView): CardView[] {
  const sameArena = view.opp.units.filter((u) => u.zone === att.zone);
  const sentinels = has(att, "saboteur") ? [] : sameArena.filter((u) => has(u, "sentinel"));
  if (sentinels.length > 0) return sentinels;
  return [...sameArena, view.opp.base];
}

/** Whether the ready attackers can deal the enemy base's remaining HP this phase (Raid and Overwhelm excess counted, Sentinel blocking). */
export function lethalReach(attackers: readonly CardView[], view: GameView): number {
  let total = 0;
  for (const a of attackers) {
    const targets = attackTargets(a, view);
    if (targets.includes(view.opp.base)) total += attackPower(a);
    else total += Math.max(0, ...targets.map((t) => attackOutcome(a, t).baseDamage));
  }
  return total;
}

export type TradeKind = "kill" | "even" | "none";

/**
 * A favourable trade: the defender dies and the attacker survives ("kill"), or both die and the defender's
 * value exceeds the attacker's ("even"). Value is the caller's utility (playCalibrated for rung 1).
 */
export function tradeKind(att: CardView, def: CardView, value: (c: CardView) => number): TradeKind {
  if (def.kind === "base") return "none";
  const o = attackOutcome(att, def);
  if (o.defenderDies && !o.attackerDies) return "kill";
  if (o.defenderDies && o.attackerDies && value(def) > value(att)) return "even";
  return "none";
}

export interface AttackPlan {
  target: CardView;
  kind: TradeKind | "base";
  /** Higher is better: threat removed (kills), threat difference (even trades), base damage. */
  gain: number;
}

/** The best favourable trade for an attacker among the given targets, or null. Ties go to the earlier target. */
export function bestTrade(att: CardView, targets: readonly CardView[], value: (c: CardView) => number): AttackPlan | null {
  let best: AttackPlan | null = null;
  for (const t of targets) {
    const k = tradeKind(att, t, value);
    if (k === "none") continue;
    const gain = (k === "kill" ? 10 : 0) + threat(t) + attackOutcome(att, t).baseDamage * 0.5;
    if (best === null || gain > best.gain) best = { target: t, kind: k, gain };
  }
  return best;
}
