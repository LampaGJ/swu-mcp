import type { Coefficients, Curve, LinearModel } from "./coefficients.js";
import { PLAY_EXCLUDED_SETS, PLAY_MODEL_TYPES, SCORED_TYPES, cardFeatureValues, conditionalKeywordGrant, isSpace, type FeatureValues, type ScorerCard } from "./features.js";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Deterministic card scorer
 * @strategicPurpose Applies the committed rubric coefficients to one card's feature vector. No
 * model, clock or randomness is involved, so the same card and coefficients always give the same score.
 * @tacticalObjective Returns per-card score components in designer stat points (total, efficiency)
 * and a play-calibrated score in log-inclusion units. An unclassified clause carries no feature and
 * therefore scores 0; the card is flagged instead.
 */

export type ScoreModel = "unit" | "event" | "upgrade" | "leader" | "base";

export interface ScoreComponents {
  /** Stat points a text-less card of this cost, arena and uniqueness has (units, leaders), or the base's no-ability HP. */
  expectedStats: number | null;
  /** Weighted stats above that expectation; for upgrades, the priced value of the stats they give. */
  statSurplus: number;
  /** Non-units: stat points for cost below the model's baseline price. Units carry cost in expectedStats. */
  costTerm: number;
  keywordPoints: number;
  effectPoints: number;
  /** Allowances designers make for aspect count, uniqueness and set, deducted so they do not read as surplus. */
  modifiers: number;
  /** T(cost) in log-inclusion units relative to cost 2. */
  playabilityT: number;
  /** T(cost) converted to stat points with the play model's power-surplus coefficient. */
  playabilityTStat: number;
}

export interface ScoreTerm {
  term: string;
  component: "statSurplus" | "keywordPoints" | "effectPoints" | "modifiers" | "playCalibrated";
  value: number;
}

export interface CardScore {
  cardKey: string;
  title: string;
  subtitle: string | null;
  type: string;
  cost: number | null;
  set: string | null;
  scored: boolean;
  model: ScoreModel | null;
  components: ScoreComponents;
  /** Designer efficiency: total without T(cost). */
  efficiency: number | null;
  total: number | null;
  playCalibrated: number | null;
  playCalibratedNoT: number | null;
  flags: string[];
  unclassifiedClauses: number;
  terms: ScoreTerm[];
}

const ZERO: ScoreComponents = {
  expectedStats: null,
  statSurplus: 0,
  costTerm: 0,
  keywordPoints: 0,
  effectPoints: 0,
  modifiers: 0,
  playabilityT: 0,
  playabilityTStat: 0,
};

/** Homeworlds mechanics with under a week of play data (rubric flag new_mechanic_no_play_data). */
const NEW_MECHANIC_FEATURES = ["kw:Fortify", "tok:Weakness", "mech:Beast"];

function curveAt(curve: Curve, cost: number, space: boolean, unique: boolean): number {
  return curve.intercept + curve.cost * cost + curve.space * (space ? 1 : 0) + curve.unique * (unique ? 1 : 0);
}

/** Vanilla expectation for power and HP of a unit. */
export function expectedPowerHp(c: Coefficients, cost: number, space: boolean, unique: boolean): { power: number; hp: number } {
  return { power: curveAt(c.vanilla.power, cost, space, unique), hp: curveAt(c.vanilla.hp, cost, space, unique) };
}

function componentFor(term: string): "keywordPoints" | "effectPoints" | "modifiers" | "statSurplus" {
  if (term.startsWith("kw:") || term.startsWith("kwn:")) return "keywordPoints";
  if (term === "aspects" || term === "unique" || term.startsWith("set:")) return "modifiers";
  if (term === "upgradeStats") return "statSurplus";
  return "effectPoints";
}

function playTerms(c: Coefficients, values: FeatureValues): { sum: number; terms: ScoreTerm[] } {
  let sum = 0;
  const terms: ScoreTerm[] = [];
  for (const name of Object.keys(c.play.terms).sort(compareCodePoints)) {
    const value = values[name];
    if (value === undefined) continue;
    const contribution = c.play.terms[name].b * value;
    sum += contribution;
    terms.push({ term: name, component: "playCalibrated", value: contribution });
  }
  return { sum, terms };
}

/** T(cost) from the applied table: costs above the table's top key use the top key. */
export function playabilityT(c: Coefficients, cost: number): number {
  const keys = Object.keys(c.play.cost.applied).map(Number);
  const top = Math.max(...keys);
  return c.play.cost.applied[String(Math.min(cost, top))] ?? 0;
}

function unscored(card: ScorerCard, flags: string[]): CardScore {
  const f = card.features;
  return {
    cardKey: f.cardKey, title: f.title, subtitle: f.subtitle, type: f.type, cost: f.structured.cost, set: card.set,
    scored: false, model: null, components: { ...ZERO }, efficiency: null, total: null, playCalibrated: null, playCalibratedNoT: null,
    flags, unclassifiedClauses: f.unclassified.length, terms: [],
  };
}

function linearTerms(model: LinearModel, values: FeatureValues, scale: number, sign: 1 | -1): ScoreTerm[] {
  const out: ScoreTerm[] = [];
  for (const name of Object.keys(model.terms).sort(compareCodePoints)) {
    const value = values[name];
    if (value === undefined) continue;
    out.push({ term: name, component: componentFor(name), value: sign * scale * model.terms[name].b * value });
  }
  return out;
}

export function scoreCard(card: ScorerCard, c: Coefficients): CardScore {
  const f = card.features;
  const s = f.structured;
  const flags: string[] = [];
  if (f.unclassified.length > 0) flags.push("unclassified_sentences");
  if (!(SCORED_TYPES as readonly string[]).includes(f.type)) return unscored(card, [...flags, "unscored_type"]);
  const values = cardFeatureValues(card);
  if (conditionalKeywordGrant(f)) flags.push("conditional_keywords");
  if (NEW_MECHANIC_FEATURES.some((k) => values[k] !== undefined)) flags.push("new_mechanic_no_play_data");
  if (card.set !== null && (PLAY_EXCLUDED_SETS as readonly string[]).includes(card.set)) flags.push("set_not_in_play_fit");

  const parts: ScoreComponents = { ...ZERO };
  let model: ScoreModel;
  let terms: ScoreTerm[] = [];

  if (f.type === "Unit") {
    model = "unit";
    if (s.cost === null || s.power === null || s.hp === null) return unscored(card, [...flags, "missing_stats"]);
    const space = isSpace(f);
    const exp = expectedPowerHp(c, s.cost, space, s.unique);
    parts.expectedStats = exp.power + exp.hp;
    parts.statSurplus = c.designer.powerWeight * (s.power - exp.power) + c.designer.hpWeight * (s.hp - exp.hp);
    // The model intercept is the average text-bearing unit's gap to the vanilla curve; removing it makes the average unit score 0.
    terms = [{ term: "baseline", component: "modifiers", value: -c.designer.unit.intercept.b }, ...linearTerms(c.designer.unit, values, 1, -1)];
  } else if (f.type === "Event" || f.type === "Upgrade") {
    model = f.type === "Event" ? "event" : "upgrade";
    if (s.cost === null) return unscored(card, [...flags, "missing_cost"]);
    const m = model === "event" ? c.designer.event : c.designer.upgrade;
    parts.costTerm = c.designer.statPointsPerResource * (m.intercept.b - s.cost);
    terms = linearTerms(m, values, c.designer.statPointsPerResource, 1);
  } else if (f.type === "Leader") {
    model = "leader";
    if (s.cost === null || s.power === null || s.hp === null) return unscored(card, [...flags, "missing_stats"]);
    const m = c.designer.leader;
    const predicted = m.intercept.b + (m.terms.cost?.b ?? 0) * s.cost + (m.terms.space?.b ?? 0) * (isSpace(f) ? 1 : 0);
    parts.expectedStats = predicted;
    parts.statSurplus = s.power + s.hp - predicted;
    flags.push("leader_effects_unpriced");
  } else {
    model = "base";
    if (s.hp === null) return unscored(card, [...flags, "missing_stats"]);
    const m = c.designer.base;
    parts.expectedStats = m.intercept.b;
    parts.statSurplus = s.hp - m.intercept.b;
    terms = linearTerms(m, values, 1, -1);
  }

  for (const t of terms) if (t.component !== "playCalibrated") parts[t.component] += t.value;

  let playCalibrated: number | null = null;
  let playCalibratedNoT: number | null = null;
  if ((PLAY_MODEL_TYPES as readonly string[]).includes(f.type) && s.cost !== null) {
    const pv: FeatureValues = { ...values };
    if (f.type === "Unit" && s.power !== null && s.hp !== null) {
      const exp = expectedPowerHp(c, s.cost, isSpace(f), s.unique);
      pv.powerSurplus = s.power - exp.power;
      pv.hpSurplus = s.hp - exp.hp;
    }
    const play = playTerms(c, pv);
    parts.playabilityT = playabilityT(c, s.cost);
    parts.playabilityTStat = parts.playabilityT / (c.play.terms.powerSurplus?.b ?? c.play.perStatPoint);
    playCalibratedNoT = play.sum;
    playCalibrated = play.sum + parts.playabilityT;
    terms = [...terms, ...play.terms];
  } else {
    flags.push("no_play_model");
  }

  const efficiency = parts.statSurplus + parts.costTerm + parts.keywordPoints + parts.effectPoints + parts.modifiers;
  const ordered = terms.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || compareCodePoints(a.term, b.term));
  return {
    cardKey: f.cardKey, title: f.title, subtitle: f.subtitle, type: f.type, cost: s.cost, set: card.set,
    scored: true, model, components: parts, efficiency, total: efficiency + parts.playabilityTStat,
    playCalibrated, playCalibratedNoT, flags, unclassifiedClauses: f.unclassified.length, terms: ordered,
  };
}
