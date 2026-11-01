/**
 * @displayName Legacy random-forest loader
 * @strategicPurpose Reads the twelve iterative-training forests from the older simulation harness without running
 * that harness, so they can be scored and compared on fresh positions.
 * @tacticalObjective Parses the harness's JSON forest format and predicts the mean leaf value over trees, projecting
 * each input through that tree's own feature subset and sending a node left when x <= threshold, exactly as
 * /Volumes/Models/swu-data/simulation/src/ml/RandomForest.ts:202-215 and DecisionTree.ts:287-297 do (float64).
 */
import { z } from "zod";

type Node = { type: "leaf"; prediction: number } | { type: "split"; featureIndex: number; threshold: number; left: Node; right: Node };
const nodeSchema: z.ZodType<Node> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.looseObject({ type: z.literal("leaf"), prediction: z.number() }),
    z.looseObject({ type: z.literal("split"), featureIndex: z.int().min(0), threshold: z.number(), left: nodeSchema, right: nodeSchema }),
  ]),
) as z.ZodType<Node>;
// looseObject: leaves also carry samples and distribution, and the file carries createdAt and training metrics.
const forestFileSchema = z.looseObject({
  type: z.literal("random_forest"),
  training: z.looseObject({ objective: z.string().optional() }).optional(),
  data: z.looseObject({ trees: z.array(z.unknown()).min(1), featureSubsets: z.array(z.array(z.int().min(0))) }),
});

export interface Forest {
  objective: string | null;
  trees: Node[];
  featureSubsets: number[][];
  numFeatures: number;
}

export function parseForest(raw: unknown): Forest {
  const file = forestFileSchema.parse(raw);
  const trees = file.data.trees.map((tree, i) => {
    const parsed = nodeSchema.safeParse(tree);
    if (!parsed.success) throw new Error(`forest tree ${i} does not parse: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    return parsed.data;
  });
  if (file.data.featureSubsets.length !== trees.length)
    throw new Error(`forest has ${trees.length} trees but ${file.data.featureSubsets.length} feature subsets`);
  return {
    objective: file.training?.objective ?? null,
    trees,
    featureSubsets: file.data.featureSubsets,
    numFeatures: Math.max(...file.data.featureSubsets.flat()) + 1,
  };
}

export function predictForest(forest: Forest, x: readonly number[]): number {
  let sum = 0;
  forest.trees.forEach((tree, i) => {
    const projected = forest.featureSubsets[i].map((column) => x[column]);
    let node = tree;
    while (node.type === "split") node = projected[node.featureIndex] <= node.threshold ? node.left : node.right;
    sum += node.prediction;
  });
  return sum / forest.trees.length;
}
