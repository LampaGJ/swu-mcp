import type { SwuCardFeatures, SwuEffect } from "../schemas/card-features.js";
import { walkAbilities } from "../ability-grammar/walk.js";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Scorer feature builder
 * @strategicPurpose Turns the ability-grammar output and the structured card fields into one
 * sparse numeric feature map. The fit script and the runtime scorer both call it, so a coefficient
 * always multiplies the feature it was fitted on.
 * @tacticalObjective Pure and deterministic: no clock, no randomness, no locale-sensitive sort.
 */

export interface ScorerCard {
  features: SwuCardFeatures;
  /** First JTL-or-later set the card appears in (Weekly Play codes folded to their parent), or null. */
  set: string | null;
}

export type FeatureValues = Record<string, number>;

export const SCORED_TYPES = ["Unit", "Event", "Upgrade", "Leader", "Base"] as const;
export const PLAY_MODEL_TYPES = ["Unit", "Event", "Upgrade"] as const;
export const PLAY_EXCLUDED_SETS = ["HMW"] as const;
export const SET_ORDER = ["JTL", "LOF", "SEC", "LAW", "ASH", "HMW"] as const;

/** Effect categories whose size matters; every other category is an indicator. */
const MAGNITUDE_CATS = new Set(["damage", "damage_base", "indirect_damage", "heal", "draw", "search", "look", "stat_mod", "stat_debuff"]);
const MAGNITUDE_CAP = 8;
/** Unresolved sizes ("X", "equal to") count as 3, the rubric's judgment value. */
const VARIABLE_MAGNITUDE = 3;

/** Stat points of a created token unit (rubric, effect features: Mandalorian counts its Shield as 1). */
const TOKEN_UNIT_STATS: Record<string, number> = {
  "Battle Droid": 2,
  "Clone Trooper": 4,
  "TIE Fighter": 2,
  "X-Wing": 4,
  Spy: 2,
  Mandalorian: 5,
  Beast: 6,
};

const TRIGGER_CLASS: Record<string, string | null> = {
  when_played: "t:whenPlayed",
  when_played_as_upgrade: "t:whenPlayed",
  on_attack: "t:onAttack",
  when_defeated: "t:whenDefeated",
  action: "t:action",
  epic_action: "t:action",
  attack_end: "t:attackEnd",
  reactive_friendly: "t:reactive",
  reactive_opponent: "t:reactive",
  reactive_self: "t:reactive",
  reactive_you: "t:reactive",
  reactive_other: "t:reactive",
  constant: "t:constant",
  event_resolve: null,
};

export const FEATURE_NOTES = {
  magnitudeCap: MAGNITUDE_CAP,
  variableMagnitude: VARIABLE_MAGNITUDE,
  tokenUnitStats: TOKEN_UNIT_STATS,
  conditionWeight: 0.5,
} as const;

function magnitude(effect: SwuEffect): number {
  const n = effect.n;
  if (typeof n === "number") return Math.abs(n);
  if (n === null || n === undefined) return 1;
  return VARIABLE_MAGNITUDE;
}

function effectCat(effect: SwuEffect): string {
  if (effect.cat === "damage") {
    const kind = effect.target?.kind;
    return kind === "base" || kind === "player" ? "damage_base" : "damage";
  }
  if (effect.cat === "stat_mod" && effect.sign === "debuff") return "stat_debuff";
  return effect.cat;
}

function add(into: FeatureValues, key: string, value: number): void {
  into[key] = (into[key] ?? 0) + value;
}

export function isSpace(card: SwuCardFeatures): boolean {
  return card.structured.arenas[0] === "Space";
}

/** Counts of ability lines, effects, tokens and timings on the card's own text face. */
function textFeatures(card: SwuCardFeatures): FeatureValues {
  const out: FeatureValues = {};
  const abilities = card.faces.text ?? [];
  out.line = abilities.filter((a) => a.kind === "ability" && !a.granted).length;
  const timings = new Set<string>();
  for (const visit of walkAbilities(abilities, null)) {
    const trigger = visit.a.triggers[0]?.trigger;
    const timing = trigger === undefined ? "t:constant" : (TRIGGER_CLASS[trigger] ?? (trigger === "event_resolve" ? null : "t:other"));
    for (const clause of visit.clauses) {
      const weight = clause.conditions.some((c) => c.cat !== "if_you_do") ? FEATURE_NOTES.conditionWeight : 1;
      if (clause.effects.length > 0 && timing !== null) timings.add(timing);
      for (const effect of clause.effects) {
        if (effect.cat === "give_token") {
          const tokens = effect.tokens ?? (effect.token === undefined ? [] : ([[effect.token, effect.n ?? 1]] as [string, number | string | null][]));
          for (const [name, n] of tokens) add(out, `tok:${name}`, weight * (typeof n === "number" ? n : VARIABLE_MAGNITUDE));
          continue;
        }
        if (effect.cat === "create_token") {
          const count = typeof effect.n === "number" ? effect.n : 1;
          if (effect.token === "Credit") add(out, "credit", weight * count);
          else {
            add(out, "tokenUnit", weight * count * (TOKEN_UNIT_STATS[effect.token ?? ""] ?? 2));
            if (effect.token === "Beast") add(out, "mech:Beast", count);
          }
          continue;
        }
        const cat = effectCat(effect);
        add(out, `fx:${cat}`, weight * (MAGNITUDE_CATS.has(cat) ? magnitude(effect) : 1));
      }
    }
  }
  for (const [key, value] of Object.entries(out)) {
    if (key.startsWith("fx:")) out[key] = MAGNITUDE_CATS.has(key.slice(3)) ? Math.min(value, MAGNITUDE_CAP) : Math.min(value, 1);
    if (key === "tokenUnit" || key === "credit" || key.startsWith("tok:")) out[key] = Math.min(value, MAGNITUDE_CAP);
  }
  for (const timing of [...timings].sort(compareCodePoints)) out[timing] = 1;
  return out;
}

function keywordFeatures(card: SwuCardFeatures): FeatureValues {
  const out: FeatureValues = {};
  for (const keyword of card.keywords) {
    out[`kw:${keyword.keyword}`] = 1;
    if (keyword.n !== undefined && keyword.n > 1) out[`kwn:${keyword.keyword}`] = keyword.n - 1;
  }
  return out;
}

/** All features of one card; zero-valued features are omitted. */
export function cardFeatureValues(card: ScorerCard): FeatureValues {
  const f = card.features;
  const s = f.structured;
  const out: FeatureValues = { ...textFeatures(f), ...keywordFeatures(f) };
  if (f.type !== "Leader") out.aspects = Math.max(s.aspectIcons.length - 1, 0);
  if (s.unique) out.unique = 1;
  if (isSpace(f)) out.space = 1;
  if (f.type === "Event") out["type:Event"] = 1;
  if (f.type === "Upgrade") {
    out["type:Upgrade"] = 1;
    out.upgradeStats = (s.upgradePower ?? 0) + (s.upgradeHp ?? 0);
  }
  if (f.type === "Base" && (f.faces.text ?? []).some((a) => a.kind === "ability")) out.hasAbility = 1;
  if (card.set !== null && (SET_ORDER as readonly string[]).indexOf(card.set) > 0) out[`set:${card.set}`] = 1;
  for (const key of Object.keys(out)) if (out[key] === 0) delete out[key];
  return out;
}

export function conditionalKeywordGrant(card: SwuCardFeatures): boolean {
  for (const visit of walkAbilities(card.faces.text ?? [], null))
    for (const clause of visit.clauses)
      if (clause.conditions.some((c) => c.cat !== "if_you_do") && clause.effects.some((e) => e.cat === "grant_keyword" && e.target?.side === "self")) return true;
  return false;
}
