/**
 * @displayName XGBoost JSON tree walker
 * @strategicPurpose Scores the existing XGBoost files without a Python runtime in the loop, and is the reference the
 * in-game evaluator (#127) must match.
 * @tacticalObjective Parses the fields of an XGBoost 3.x `save_model` JSON that prediction needs, then walks every
 * tree in float32: a node goes left when x < split_condition, a missing (NaN) input follows default_left, the margin
 * starts at logit(base_score) and the probability is the logistic of the summed margin.
 */
import { z } from "zod";

const intArray = z.array(z.int());
const treeSchema = z.looseObject({
  split_indices: intArray,
  split_conditions: z.array(z.number()),
  left_children: intArray,
  right_children: intArray,
  default_left: z.array(z.union([z.literal(0), z.literal(1), z.boolean()])),
});
// looseObject: the file holds training-only fields (loss_changes, sum_hessian, categories) this walker never reads.
const xgbFileSchema = z.looseObject({
  learner: z.looseObject({
    learner_model_param: z.looseObject({ base_score: z.string().min(1), num_feature: z.string().regex(/^\d+$/) }),
    objective: z.looseObject({ name: z.literal("binary:logistic") }),
    gradient_booster: z.looseObject({ name: z.literal("gbtree"), model: z.looseObject({ trees: z.array(treeSchema).min(1) }) }),
  }),
});

export interface XgbModel {
  numFeature: number;
  baseScore: number;
  trees: z.infer<typeof treeSchema>[];
}

/** XGBoost 3.x writes base_score as a bracketed vector string, "[5.4579264E-1]". */
export function parseBaseScore(raw: string): number {
  const m = /^\[?([-+0-9.eE]+)\]?$/.exec(raw.trim());
  const value = m === null ? Number.NaN : Number(m[1]);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new Error(`unreadable base_score ${JSON.stringify(raw)}`);
  return value;
}

export function parseXgb(raw: unknown): XgbModel {
  const learner = xgbFileSchema.parse(raw).learner;
  const trees = learner.gradient_booster.model.trees;
  trees.forEach((t, i) => {
    const n = t.left_children.length;
    if ([t.right_children, t.split_indices, t.split_conditions, t.default_left].some((a) => a.length !== n))
      throw new Error(`tree ${i}: node arrays differ in length`);
  });
  return {
    numFeature: Number(learner.learner_model_param.num_feature),
    baseScore: parseBaseScore(learner.learner_model_param.base_score),
    trees,
  };
}

export function predictXgb(model: XgbModel, x: readonly (number | null)[]): number {
  if (x.length !== model.numFeature) throw new Error(`XGBoost model expects ${model.numFeature} features, got ${x.length}`);
  const f = Math.fround;
  let margin = f(Math.log(model.baseScore / (1 - model.baseScore)));
  for (const t of model.trees) {
    let node = 0;
    while (t.left_children[node] !== -1) {
      const value = x[t.split_indices[node]];
      const goLeft = value === null || Number.isNaN(value) ? Boolean(t.default_left[node]) : f(value) < f(t.split_conditions[node]);
      node = goLeft ? t.left_children[node] : t.right_children[node];
    }
    margin = f(margin + f(t.split_conditions[node]));
  }
  return 1 / (1 + Math.exp(-margin));
}

/** total_gain per feature, from loss_changes on split nodes; used to measure how much a model leans on columns we cannot rebuild. */
export function totalGain(raw: unknown, numFeature: number): number[] {
  const trees = z
    .array(z.looseObject({ left_children: intArray, split_indices: intArray, loss_changes: z.array(z.number()) }))
    .parse(xgbFileSchema.parse(raw).learner.gradient_booster.model.trees);
  const gain = new Array<number>(numFeature).fill(0);
  for (const t of trees)
    t.left_children.forEach((left, node) => (left === -1 ? undefined : (gain[t.split_indices[node]] += t.loss_changes[node])));
  return gain;
}
