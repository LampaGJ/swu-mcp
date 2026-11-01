import { compareCodePoints } from "../../swu/canonical.js";
import { attackOutcome, attackPower, attackTargets, bestTrade, isUnitInPlay, lethalReach, threat, type AttackPlan } from "./combat.js";
import { randomIndex } from "./random.js";
import { emptyStats, type BotPolicy, type CardView, type GameView, type LegalAnswer, type PolicyStats } from "./types.js";

/**
 * @displayName Rung 1 and rung 2 rule bots
 * @strategicPurpose A bot that plays Star Wars: Unlimited like a competent beginner from the card data itself (cost,
 * power, HP, damage, keywords, aspects, parsed card text and the play-calibrated score), so swapping one card in a deck
 * changes how the deck plays; rung 2 adds the owner's pairing intent (leader lists and the pair graph).
 * @tacticalObjective `makeRulePolicy` answers every prompt kind the adapter names by fixed rules in priority order
 * (mulligan, resource, lethal, favourable trade, play by score and curve, base attack, deploy, abilities, initiative,
 * pass; target choice by threat and effect intent), falling back to rung 0 only where no rule applies, and counts
 * rule, default and fallback decisions. Rung 2 is the same rules over `utility(X) = playCalibrated(X) +
 * mu * leaderInclusion(X) + lambda * pairBonus(X)`, a pair-edge target preference and resource protection; with
 * mu = lambda = 0 every utility equals playCalibrated and the protection never fires, so its trace equals rung 1's.
 *
 * Circularity trap: rung 2 sims cannot validate pairing edges by co-occurrence, because the bot made the cards
 * co-occur. The only sim-based edge test is an ablation (mask the edge, re-run the same seeds).
 */

export interface RuleParams {
  /** Weight on the leader's tournament inclusion of a card (rung 2). */
  mu: number;
  /** Weight on the pair bonus against our leader, base, units and hand (rung 2). */
  lambda: number;
  /** Partner weight of a card in hand in the pair bonus (estimate). */
  handWeight: number;
  /** A card whose lambda * pairBonus exceeds this is not resourced while another card can be (estimate). */
  protectThreshold: number;
  /** Value of one spent resource in the play knapsack, the curve term (estimate). */
  tempo: number;
  /** Cards of cost 3 or less a kept opening hand needs. */
  mulliganCheap: number;
  /** Resource while fewer than min(max deck cost, this) resources are in play (estimate). */
  resourceCap: number;
  /**
   * Pilot switches (#174), 0 or 1, absent from RUNG1_PARAMS so rung 1's params hash and trace stay as pinned.
   * sacGuard: an ability whose cost defeats a friendly unit is used only on a token or a When Defeated unit.
   * initDraw: the resources a "When you take the initiative" leader trigger asks for are kept back from plays.
   * handCap: resource past resourceCap while the hand holds a card that costs more than the resources in play.
   * aspectCall: an aspect-naming prompt names the commonest aspect of our own draw deck and discards from our own deck.
   */
  sacGuard?: number;
  initDraw?: number;
  handCap?: number;
  aspectCall?: number;
}

export const RULE_PILOT_KEYS = ["sacGuard", "initDraw", "handCap", "aspectCall"] as const;

export const RUNG1_PARAMS: RuleParams = { mu: 0, lambda: 0, handWeight: 0.5, protectThreshold: 1, tempo: 0.5, mulliganCheap: 2, resourceCap: 7 };

/**
 * A friendly unit whose loss costs little: a token (cardKey null; unmapped cards also read null, kept rare by the
 * bridge), or a When Defeated unit that is cheap (cost 2 or less) or already damaged. A healthy costlier unit stays on
 * the board, because the traced losses (#174) were boards emptied every round.
 */
export const isFodder = (c: CardView): boolean => !c.leader && (c.cardKey === null || (c.ability?.whenDefeated === true && (c.cost <= 2 || c.damage > 0)));

export interface PairLookups {
  leaderInclusion(leaderKey: string | null, cardKey: string | null): number;
  edgeWeight(a: string | null, b: string | null): number;
}

const NO_PAIRS: PairLookups = { leaderInclusion: () => 0, edgeWeight: () => 0 };

type How = "rule" | "defaulted";
interface Choice {
  index: number;
  how: How;
}

/** Identical decisions (same prompt, answers and choice) within the last 2 * LOOP_LIMIT before the loop guard hands one to rung 0. */
const LOOP_LIMIT = 6;
const IS_PASS = /^pass\b/i;
const IS_SKIP = /^(pass|cancel|choose nothing|skip|skip resourcing|take nothing|done)$/i;
const IS_DONE = /^(done|confirm resources|confirm)$/i;

/** Aspect penalty in resources: 2 per printed icon the leader and base do not supply (icons counted as a multiset). */
export function aspectPenalty(card: Pick<CardView, "aspects">, supplied: readonly string[]): number {
  const pool = [...supplied];
  let missing = 0;
  for (const icon of card.aspects) {
    const i = pool.indexOf(icon);
    if (i >= 0) pool.splice(i, 1);
    else missing++;
  }
  return 2 * missing;
}

/** Best subset of cards under the resource budget, by summed value; returns the chosen indices. Hands hold about 10 cards. */
export function knapsack(items: readonly { cost: number; value: number }[], budget: number): number[] {
  const n = Math.min(items.length, 12);
  let best: number[] = [];
  let bestValue = 0;
  for (let mask = 1; mask < 1 << n; mask++) {
    let cost = 0;
    let value = 0;
    const set: number[] = [];
    for (let i = 0; i < n; i++)
      if (mask & (1 << i)) {
        cost += items[i].cost;
        value += items[i].value;
        set.push(i);
      }
    if (cost <= budget && value > bestValue + 1e-9) {
      bestValue = value;
      best = set;
    }
  }
  return best;
}

export function makeRulePolicy(opts: { id: string; version: string; rung: number; params: RuleParams; pairs?: PairLookups }): BotPolicy {
  const params = opts.params;
  const pairs = opts.pairs ?? NO_PAIRS;
  const stats: PolicyStats = emptyStats();

  const pairBonus = (card: CardView, view: GameView): number => {
    if (params.lambda === 0 || card.cardKey === null) return 0;
    const weight = new Map<string, number>();
    const add = (key: string | null, w: number): void => {
      if (key !== null) weight.set(key, Math.max(weight.get(key) ?? 0, w));
    };
    add(view.me.leader.cardKey, 1);
    add(view.me.base.cardKey, 1);
    for (const u of view.me.units) add(u.cardKey, 1);
    let skippedSelf = false;
    for (const h of view.me.hand) {
      if (!skippedSelf && h.id === card.id) {
        skippedSelf = true;
        continue;
      }
      add(h.cardKey, params.handWeight);
    }
    let sum = 0;
    for (const key of [...weight.keys()].sort(compareCodePoints)) {
      sum += (weight.get(key) as number) * (pairs.edgeWeight(key, card.cardKey) + pairs.edgeWeight(card.cardKey, key));
    }
    return sum;
  };

  const utility = (card: CardView, view: GameView): number => {
    if (!card.mine) return card.score;
    let u = card.score;
    if (params.mu !== 0) u += params.mu * pairs.leaderInclusion(view.me.leader.cardKey, card.cardKey);
    if (params.lambda !== 0) u += params.lambda * pairBonus(card, view);
    return u;
  };

  const edgeBonus = (view: GameView, target: CardView): number => {
    if (params.lambda === 0) return 0;
    const s = view.prompt.sourceCardKey;
    return params.lambda * (pairs.edgeWeight(s, target.cardKey) + pairs.edgeWeight(target.cardKey, s));
  };

  /** Highest rank wins; ties go to the smaller descriptor, then the earlier index, so engine order never decides. */
  const pickMax = <T extends { i: number }>(answers: readonly LegalAnswer[], cands: readonly T[], rank: (c: T) => number): T | null => {
    let best: T | null = null;
    let bestRank = -Infinity;
    for (const c of cands) {
      const r = rank(c);
      if (best === null || r > bestRank + 1e-9) {
        best = c;
        bestRank = r;
      } else if (Math.abs(r - bestRank) <= 1e-9) {
        const d = compareCodePoints(answers[c.i].descriptor, answers[best.i].descriptor);
        if (d < 0 || (d === 0 && c.i < best.i)) best = c;
      }
    }
    return best;
  };

  const buttonIndex = (answers: readonly LegalAnswer[], re: RegExp): number => {
    let found = -1;
    for (let i = 0; i < answers.length; i++) {
      if (answers[i].kind !== "button" || !re.test(answers[i].label)) continue;
      if (found < 0 || compareCodePoints(answers[i].descriptor, answers[found].descriptor) < 0) found = i;
    }
    return found;
  };

  const cardAnswers = (answers: readonly LegalAnswer[], view: GameView): { i: number; card: CardView }[] => {
    const out: { i: number; card: CardView }[] = [];
    for (let i = 0; i < answers.length; i++) {
      const id = answers[i].cardId;
      const card = id === null ? undefined : view.cards.get(id);
      if (card && (answers[i].kind === "card" || answers[i].kind === "display")) out.push({ i, card });
    }
    return out;
  };

  const rule = (index: number): Choice | null => (index >= 0 ? { index, how: "rule" } : null);

  // ---- mulligan, initiative, resource -------------------------------------------------------------

  const mulligan = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const cheap = view.me.hand.filter((c) => c.cost <= 3).length;
    return rule(buttonIndex(answers, cheap >= params.mulliganCheap ? /^keep$/i : /^mulligan$/i));
  };

  /** Resource order: a second copy of a unique card already in play goes first, then the lowest utility; rung 2 protects paired cards. */
  const resourceRank = (card: CardView, view: GameView): number => {
    if (card.unique && card.cardKey !== null && view.me.units.some((u) => u.cardKey === card.cardKey)) return -1e6;
    const protectedCard = params.lambda !== 0 && params.lambda * pairBonus(card, view) > params.protectThreshold;
    return utility(card, view) + (protectedCard ? 1e5 : 0);
  };

  const resource = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const range = /between (\d+) and (\d+)/i.exec(view.prompt.title);
    const exact = /select (\d+) cards?/i.exec(view.prompt.title);
    const min = range ? Number(range[1]) : exact ? Number(exact[1]) : 0;
    const max = range ? Number(range[2]) : exact ? Number(exact[1]) : 1;
    const handTop = params.handCap === 1 ? Math.max(0, ...view.me.hand.map((c) => c.cost)) : 0;
    const target = Math.min(view.me.maxDeckCost, Math.max(params.resourceCap, handTop));
    const want = Math.max(min, view.me.resources.total < target ? max : 0);
    const selected = new Set(view.prompt.selectedIds);
    if (selected.size < want) {
      const cands = cardAnswers(answers, view).filter((c) => !selected.has(c.card.id));
      const pick = pickMax(answers, cands, (c) => -resourceRank(c.card, view));
      if (pick) return rule(pick.i);
    }
    if (selected.size === 0) {
      const skip = buttonIndex(answers, /skip/i);
      if (skip >= 0) return rule(skip);
    }
    return rule(buttonIndex(answers, IS_DONE));
  };

  // ---- action window ------------------------------------------------------------------------------

  const readyAttackers = (view: GameView): CardView[] => view.me.units.filter((u) => !u.exhausted && u.power + u.raid > 0);

  const lethalOn = (view: GameView): boolean => {
    const reach = lethalReach(readyAttackers(view), view);
    return reach > 0 && reach >= view.opp.base.remainingHp;
  };

  /** Whether a play would do nothing useful now, read from parsed text: removal with no enemy unit, healing with no damage. */
  const pointless = (card: CardView, view: GameView): boolean => {
    if (card.kind === "event") {
      if (card.effects.removal && !card.effects.heal && view.opp.units.length === 0) return true;
      if (card.effects.heal && !card.effects.removal && view.me.base.damage === 0 && view.me.units.every((u) => u.damage === 0)) return true;
    }
    if (card.kind === "upgrade" && card.upgradePower + card.upgradeHp < 0 && view.opp.units.length === 0) return true;
    return false;
  };

  const attackIntent = (att: CardView, view: GameView): AttackPlan | null => {
    const targets = attackTargets(att, view);
    if (lethalOn(view) && targets.includes(view.opp.base)) return { target: view.opp.base, kind: "base", gain: attackPower(att) };
    const trade = bestTrade(att, targets, (c) => utility(c, view));
    if (trade) return trade;
    if (targets.includes(view.opp.base) && attackPower(att) > 0) return { target: view.opp.base, kind: "base", gain: attackPower(att) };
    return null;
  };

  const action = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const clickable = cardAnswers(answers, view).filter((c) => !view.cancelled.has(c.card.id));
    const myUnits = clickable.filter((c) => c.card.mine && isUnitInPlay(c.card));
    const ready = myUnits.filter((c) => !c.card.exhausted && attackPower(c.card) > 0);

    // 1. Lethal on the base.
    if (lethalOn(view)) {
      const hitters = ready.filter((c) => attackTargets(c.card, view).includes(view.opp.base));
      const pick = pickMax(answers, hitters, (c) => attackPower(c.card));
      if (pick) return rule(pick.i);
    }
    // 2. Favourable trade.
    const trades = ready.flatMap((c) => {
      const t = bestTrade(c.card, attackTargets(c.card, view), (x) => utility(x, view));
      return t ? [{ ...c, gain: t.gain }] : [];
    });
    const trade = pickMax(answers, trades, (c) => c.gain - 0.01 * utility(c.card, view));
    if (trade) return rule(trade.i);

    // 3. Play the best affordable cards by score and curve.
    const playable = clickable.filter((c) => c.card.mine && (c.card.zone === "hand" || c.card.zone === "resource" || c.card.zone === "discard"));
    const sensible = playable.filter((c) => !pointless(c.card, view));
    if (sensible.length > 0) {
      const items = sensible.map((c) => ({
        cost: c.card.cost + (c.card.zone === "hand" ? aspectPenalty(c.card, view.me.aspects) : 0),
        value: Math.max(0.01, utility(c.card, view) + params.tempo * c.card.cost),
      }));
      const lead = view.me.leader;
      const reserve =
        params.initDraw === 1 && !view.me.leaderDeployed && buttonIndex(answers, /claim initiative/i) >= 0 ? (lead.ability?.takeInitiativeCost ?? 0) : 0;
      const chosen = knapsack(items, Math.max(0, view.me.resources.ready - reserve)).map((k) => sensible[k]);
      const pool = chosen.length > 0 ? chosen : reserve > 0 ? [] : sensible;
      const pick = pickMax(answers, pool, (c) => utility(c.card, view) + 1e-4 * c.card.cost);
      if (pick) return rule(pick.i);
    }
    // 4. Attack the base with a ready unit that has no favourable trade.
    const hitters = ready.filter((c) => attackTargets(c.card, view).includes(view.opp.base));
    const hit = pickMax(answers, hitters, (c) => attackPower(c.card));
    if (hit) return rule(hit.i);

    // 5. Deploy the leader when legal.
    const leader = clickable.find((c) => c.card.mine && c.card.zone === "base" && c.card.leader);
    if (leader && !view.me.leaderDeployed && view.me.resources.total >= leader.card.cost) return rule(leader.i);

    // 6. Card abilities still available (leader, base, units), highest utility first.
    const fodder = params.sacGuard === 1 && view.me.units.some(isFodder);
    const abilities = clickable.filter((c) => c.card.mine && (c.card.zone === "base" || isUnitInPlay(c.card)) && !(params.sacGuard === 1 && c.card.ability?.sacrificeAction === true && !fodder));
    const ability = pickMax(answers, abilities, (c) => utility(c.card, view));
    if (ability) return rule(ability.i);

    // 7. Take the initiative, else pass.
    const claim = buttonIndex(answers, /claim initiative/i);
    if (claim >= 0) return rule(claim);
    return rule(buttonIndex(answers, IS_PASS));
  };

  const actionSelection = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const source = view.prompt.sourceId === null ? undefined : view.cards.get(view.prompt.sourceId);
    const deploy = buttonIndex(answers, /^deploy/i);
    if (deploy >= 0) return rule(deploy);
    const attack = buttonIndex(answers, /^attack$/i);
    if (attack >= 0 && source && isUnitInPlay(source) && attackIntent(source, view)) return rule(attack);
    const play = answers.findIndex((a) => a.kind === "button" && /^play\b/i.test(a.label) && !/pilot/i.test(a.label));
    if (play >= 0) return rule(play);
    const other = answers
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.kind === "button" && !/^(cancel|attack)$/i.test(a.label))
      .sort((x, y) => compareCodePoints(x.a.descriptor, y.a.descriptor));
    if (other.length > 0) return rule(other[0].i);
    if (attack >= 0) return rule(attack);
    return rule(buttonIndex(answers, /^cancel$/i));
  };

  const attackTarget = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const att = view.prompt.sourceId === null ? undefined : view.cards.get(view.prompt.sourceId);
    if (!att) return null;
    const cands = cardAnswers(answers, view).filter((c) => !c.card.mine);
    const base = cands.find((c) => c.card.kind === "base");
    if (base && (attackPower(att) >= base.card.remainingHp || lethalOn(view))) return rule(base.i);
    const trades = cands.flatMap((c) => {
      const t = bestTrade(att, [c.card], (x) => utility(x, view));
      return t ? [{ ...c, gain: t.gain }] : [];
    });
    const trade = pickMax(answers, trades, (c) => c.gain);
    if (trade) return rule(trade.i);
    if (base) return rule(base.i);
    const cancel = buttonIndex(answers, /^cancel$/i);
    if (cancel >= 0) return rule(cancel);
    const least = pickMax(answers, cands, (c) => {
      const o = attackOutcome(att, c.card);
      return (o.defenderDies ? threat(c.card) : 0) - (o.attackerDies ? threat(att) : 0);
    });
    return least ? rule(least.i) : null;
  };

  // ---- targets ------------------------------------------------------------------------------------

  const amountIn = (title: string): number | null => {
    const m = /(\d+) (?:damage|indirect)/i.exec(title);
    return m ? Number(m[1]) : null;
  };

  const target = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const p = view.prompt;
    const selected = new Set(p.selectedIds);
    const cards = cardAnswers(answers, view).filter((c) => !selected.has(c.card.id));
    const enemy = cards.filter((c) => !c.card.mine);
    const own = cards.filter((c) => c.card.mine);
    const skip = buttonIndex(answers, IS_SKIP);
    const done = buttonIndex(answers, IS_DONE);
    const amount = amountIn(p.title);
    const isExhaust = p.system === "ExhaustSystem";
    const limit = /up to (\d+)/i.exec(p.title);
    if (p.multiple && limit && selected.size >= Number(limit[1]) && done >= 0) return rule(done);
    switch (p.intent) {
      case "harm": {
        const pick = pickMax(answers, enemy, (c) => {
          if (c.card.kind === "base") return amount !== null && amount >= c.card.remainingHp ? 1e4 : -50;
          const dies = amount === null ? true : !c.card.shield && amount >= c.card.remainingHp;
          return (dies ? 100 : 0) + threat(c.card) + (isExhaust && c.card.exhausted ? -200 : 0) + edgeBonus(view, c.card);
        });
        if (pick && !(p.multiple && pick.card.kind === "base" && done >= 0)) return rule(pick.i);
        if (p.multiple && done >= 0) return rule(done);
        if (skip >= 0) return rule(skip);
        const forced = pickMax(answers, own, (c) => -(utility(c.card, view) + (amount !== null && c.card.remainingHp <= amount ? 5 : 0)));
        return forced ? rule(forced.i) : null;
      }
      case "help": {
        const heal = p.system === "HealSystem";
        const pick = pickMax(answers, own, (c) => {
          if (heal) return Math.min(c.card.damage, amount ?? 99) * (c.card.kind === "base" ? 0.8 : 1) + 0.01 * utility(c.card, view);
          if (c.card.kind === "base") return -50;
          return threat(c.card) + (c.card.exhausted ? 0 : 0.5) + edgeBonus(view, c.card);
        });
        if (pick && !(heal && pick.card.damage === 0 && skip >= 0)) return rule(pick.i);
        if (p.multiple && done >= 0) return rule(done);
        if (skip >= 0) return rule(skip);
        const forced = pickMax(answers, enemy, (c) => -threat(c.card));
        return forced ? rule(forced.i) : pick ? rule(pick.i) : null;
      }
      case "attackWith": {
        const pick = pickMax(answers, own, (c) => {
          const plan = attackIntent(c.card, view);
          return plan === null ? -1 : plan.kind === "base" ? plan.gain : 20 + plan.gain;
        });
        return pick ? rule(pick.i) : rule(skip);
      }
      case "play":
      case "choose": {
        const mine = own.length > 0 ? own : cards;
        const pick = pickMax(answers, mine, (c) => utility(c.card, view) + edgeBonus(view, c.card));
        if (pick) return rule(pick.i);
        return rule(p.multiple ? done : skip);
      }
      case "reveal": {
        if (done >= 0) return rule(done);
        const pick = pickMax(answers, own, (c) => -utility(c.card, view));
        return pick ? rule(pick.i) : rule(skip);
      }
      case "defeatOwn": {
        if (p.multiple && done >= 0) return rule(done);
        const cheap = (c: CardView): number => (params.sacGuard === 1 && c.mine && isFodder(c) ? 100 : 0);
        const pick = pickMax(answers, own.length > 0 ? own : cards, (c) => cheap(c.card) - (utility(c.card, view) + 0.1 * c.card.remainingHp + (c.card.exhausted ? 0 : 0.05)));
        return pick ? rule(pick.i) : null;
      }
      default:
        return null;
    }
  };

  // ---- other prompts ------------------------------------------------------------------------------

  const optionalTrigger = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const named = buttonIndex(answers, /^trigger$/i);
    const trigger = named >= 0 ? named : answers.findIndex((a) => a.kind === "button" && !IS_PASS.test(a.label));
    const pass = buttonIndex(answers, IS_PASS);
    if (/ambush/i.test(view.prompt.abilityText ?? "")) {
      const unit = view.prompt.sourceId === null ? undefined : view.cards.get(view.prompt.sourceId);
      const targets = unit ? attackTargets(unit, view).filter((t) => t.kind !== "base") : [];
      const good = unit ? bestTrade(unit, targets, (c) => utility(c, view)) : null;
      return rule(good ? trigger : pass >= 0 ? pass : trigger);
    }
    return rule(trigger >= 0 ? trigger : pass);
  };

  const triggerOrder = (answers: readonly LegalAnswer[]): Choice | null => {
    const shielded = answers.findIndex((a) => a.kind === "button" && /shielded/i.test(a.label));
    if (shielded >= 0) return { index: shielded, how: "rule" };
    const rest = answers
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.kind === "button" && !/ambush/i.test(a.label))
      .sort((x, y) => compareCodePoints(x.a.descriptor, y.a.descriptor));
    if (rest.length > 0) return { index: rest[0].i, how: "defaulted" };
    return answers.length > 0 ? { index: 0, how: "defaulted" } : null;
  };

  const menu = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const title = view.prompt.title;
    if (/credit tokens to pay/i.test(title)) {
      const use = buttonIndex(answers, /^(use \d+ credits?|select amount)$/i);
      if (use >= 0) return rule(use);
    }
    if (/will have no effect/i.test(title)) {
      const cancel = buttonIndex(answers, /^cancel$/i);
      if (cancel >= 0) return rule(cancel);
    }
    if (/choose a player to target/i.test(title)) {
      const harmful = /damage|discard|defeat|exhaust/i.test(title);
      const who = buttonIndex(answers, harmful ? /opponent/i : /yourself|\byou\b/i);
      if (who >= 0) return rule(who);
    }
    const toll = /^(.*) takes (\d+) \[damage\] or \[discard\]/i.exec(title);
    if (toll) {
      const unit = view.me.units.find((u) => toll[1].startsWith(u.title));
      const survives = unit !== undefined && unit.remainingHp > Number(toll[2]);
      const pick = buttonIndex(answers, survives || view.me.handSize === 0 ? /^damage$/i : /^discard$/i);
      if (pick >= 0) return rule(pick);
    }
    const aspectButtons = answers.map((a, i) => ({ a, i })).filter(({ a }) => a.kind === "button" && /^:[a-z]+:$/.test(a.label));
    if (aspectButtons.length > 0 && /enemy/i.test(title)) {
      const weight = (aspect: string): number => view.opp.units.filter((u) => u.aspects.includes(aspect)).reduce((sum, u) => sum + threat(u), 0);
      const pick = pickMax(answers, aspectButtons, ({ a }) => weight(a.label.slice(1, -1)));
      if (pick) return rule(pick.i);
    }
    if (params.aspectCall === 1 && /^choose an aspect$/i.test(title) && view.me.deckAspects !== undefined) {
      const counts = view.me.deckAspects();
      const named = answers.map((a, i) => ({ a, i })).filter(({ a }) => a.kind === "button" && counts[a.label] !== undefined);
      const pick = pickMax(answers, named, ({ a }) => counts[a.label] ?? 0);
      if (pick) return rule(pick.i);
    }
    if (params.aspectCall === 1 && /choose a deck to discard from/i.test(title)) {
      const own = buttonIndex(answers, /^your deck$/i);
      if (own >= 0) return rule(own);
    }
    if (/^trigger the effect/i.test(title)) {
      const go = answers.findIndex((a) => a.kind === "button" && !IS_PASS.test(a.label));
      if (go >= 0) return rule(go);
    }
    const you = buttonIndex(answers, /^(you|yourself)$/i);
    if (you >= 0) return rule(you);
    const opts = answers
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => !/^cancel$/i.test(a.label))
      .sort((x, y) => compareCodePoints(x.a.descriptor, y.a.descriptor));
    return opts.length > 0 ? { index: opts[0].i, how: "defaulted" } : null;
  };

  /** Deck-search and reveal displays: take the best unselected card while one is selectable, then confirm. */
  const display = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const selected = new Set(view.prompt.selectedIds);
    const shown = cardAnswers(answers, view).filter((c) => answers[c.i].kind === "display" && !selected.has(c.card.id));
    const pick = pickMax(answers, shown, (c) => utility({ ...c.card, mine: true }, view));
    if (pick) return rule(pick.i);
    if (selected.size > 0) {
      const confirm = answers.findIndex((a) => a.kind === "button" && !/^(take nothing|cancel|choose nothing)$/i.test(a.label));
      if (confirm >= 0) return rule(confirm);
    }
    const done = buttonIndex(answers, IS_DONE);
    if (done >= 0) return rule(done);
    return answers.length > 0 ? { index: 0, how: "defaulted" } : null;
  };

  /**
   * Harm: a kill scores the victim's threat, other damage half a point per point dealt, damage forced onto our own cards
   * counts against. Help: healing scores the damage removed, tokens the receiver's threat.
   */
  const allocationValue = (alloc: readonly { cardId: string; amount: number }[], want: "harm" | "help", heal: boolean, view: GameView): number => {
    let v = 0;
    for (const { cardId, amount } of alloc) {
      const c = view.cards.get(cardId);
      if (!c) continue;
      const sign = c.mine === (want === "help") ? 1 : -1;
      if (want === "help") v += sign * (heal ? Math.min(c.damage, amount) : c.kind === "base" ? 0 : threat(c));
      else if (c.kind === "base") v += sign * 0.3 * amount;
      else if (!c.shield && amount >= c.remainingHp) v += sign * (10 + threat(c));
      else v += sign * 0.5 * amount;
    }
    return v;
  };

  const distribute = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    const type = view.prompt.distribute?.type ?? "";
    const want = /heal|token/i.test(type) ? "help" : "harm";
    const planned = answers.findIndex((a) => a.plan === want);
    if (planned >= 0) return rule(planned);
    const cands = answers.flatMap((a, i) => (a.allocation ? [{ i, alloc: a.allocation }] : []));
    const pick = pickMax(answers, cands, (c) => allocationValue(c.alloc, want, /heal/i.test(type), view));
    return pick ? rule(pick.i) : null;
  };

  const decide = (answers: readonly LegalAnswer[], view: GameView): Choice | null => {
    switch (view.prompt.kind) {
      case "mulligan":
        return mulligan(answers, view);
      case "initiativeChoice":
        return rule(buttonIndex(answers, /^yourself$/i));
      case "resource":
        return resource(answers, view);
      case "action":
        return action(answers, view);
      case "actionSelection":
        return actionSelection(answers, view);
      case "attackTarget":
        return attackTarget(answers, view);
      case "target":
        return target(answers, view);
      case "distribute":
        return distribute(answers, view);
      case "optionalTrigger":
        return optionalTrigger(answers, view);
      case "triggerOrder":
        return triggerOrder(answers);
      case "menu":
        return menu(answers, view);
      case "display":
        return display(answers, view);
      case "number": {
        const nums = answers.map((a, i) => ({ i, n: a.kind === "number" ? Number(a.label) : -Infinity }));
        const top = nums.reduce((b, c) => (c.n > b.n ? c : b), nums[0]);
        return top && top.n > -Infinity ? { index: top.i, how: "defaulted" } : null;
      }
      case "list":
        return answers.length > 0 ? { index: 0, how: "defaulted" } : null;
      default:
        return null;
    }
  };

  const recent: string[] = [];

  /** The rule answer, or null (counted as a fallback) when no rule applies or the loop guard fires. */
  const tryChoose = (answers: readonly LegalAnswer[], view: GameView): number | null => {
    stats.decisions++;
    const c = answers.length === 0 ? null : decide(answers, view);
    const loopKey = c === null ? "" : `${view.prompt.kind}|${view.prompt.title}|${answers.map((a) => a.descriptor).join(";")}|${c.index}`;
    recent.push(loopKey);
    if (recent.length > 2 * LOOP_LIMIT) recent.shift();
    if (loopKey !== "" && recent.filter((k) => k === loopKey).length >= LOOP_LIMIT) {
      recent.length = 0;
      stats.fallback++;
      stats.fallbackBy["loop-guard"] = (stats.fallbackBy["loop-guard"] ?? 0) + 1;
      return null;
    }
    if (c !== null && c.index >= 0 && c.index < answers.length) {
      stats[c.how]++;
      return c.index;
    }
    stats.fallback++;
    const key = `${view.prompt.kind}:${view.prompt.system ?? view.prompt.intent ?? "-"}`;
    stats.fallbackBy[key] = (stats.fallbackBy[key] ?? 0) + 1;
    return null;
  };

  const choose = (answers: readonly LegalAnswer[], view: GameView): number => tryChoose(answers, view) ?? randomIndex(answers, view);

  const pure = (answers: readonly LegalAnswer[], view: GameView): number | null => {
    const c = answers.length === 0 ? null : decide(answers, view);
    return c !== null && c.index >= 0 && c.index < answers.length ? c.index : null;
  };

  return { id: opts.id, version: opts.version, rung: opts.rung, params: { ...params }, choose, tryChoose, decide: pure, stats };
}
