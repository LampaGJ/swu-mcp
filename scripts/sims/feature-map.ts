/**
 * @displayName Legacy feature map
 * @strategicPurpose No model file on the volume names its features; the old harness's getAllFeatureNames() is the
 * only authority, and each column must be classed as rebuildable or not before any reused model is scored.
 * @tacticalObjective Runs getAllFeatureNames() before and after registerDefaultPlugins() in a scratch copy of the
 * harness, assigns every column a tier by the ordered rules below, and writes data/pinned/sim-models/feature-map.json
 * with a replay record.
 *
 * Usage: pnpm sims:feature-map [--harness /Volumes/Models/swu-data/simulation] [--out data/pinned/sim-models]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "../../src/paths.js";
import { featureMapSchema } from "../../src/sims/model-manifest.js";
import { canonicalJson, sha256Hex } from "../../src/swu/canonical.js";
import { codeCommit } from "../lib/code-commit.js";
import { harnessCopy, runHarnessProbe } from "./model-parity.js";

/** Columns the new engine state gives directly (names from FeatureExtractor.ts:160 onward, matched by name, never by index). */
const EXACT = new Set([
  "turn",
  "p1_resources",
  "p2_resources",
  "p1_base_damage",
  "p2_base_damage",
  "p1_board_power",
  "p2_board_power",
  "p1_hand_size",
  "p2_hand_size",
  "p1_unit_count",
  "p2_unit_count",
  "p1_ground_power",
  "p1_space_power",
  "p1_ground_units",
  "p1_space_units",
  "p2_ground_power",
  "p2_space_power",
  "p2_ground_units",
  "p2_space_units",
  "resource_advantage",
  "base_damage_advantage",
  "board_power_advantage",
  "hand_size_advantage",
  "unit_count_advantage",
  "p1_health_pct",
  "p2_health_pct",
  "game_progress",
  "is_mid_game",
  "is_late_game",
]);

type Tier = z.infer<typeof featureMapSchema>["columns"][number]["tier"];
export function tierOf(name: string, index: number, coreCount: number, embedding: ReadonlySet<string>): { tier: Tier; rule: string } {
  if (index >= coreCount) return { tier: "unavailable", rule: "plugin column: needs the old plugin state" };
  if (embedding.has(name)) return { tier: "embedding", rule: "enhanced card embedding (EnhancedCardEmbeddings.ts:512)" };
  if (EXACT.has(name)) return { tier: "exact", rule: "named engine-state column" };
  if (name.startsWith("action_")) return { tier: "derived", rule: "action type of the decision being scored" };
  if (/^(p1_|p2_|my_|their_)?deck_/.test(name)) return { tier: "derived", rule: "needs the decklist tracker" };
  return { tier: "unavailable", rule: "fail-closed default: needs the old CardAbilityParser, timing, stat or tracker state" };
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isMain) {
  const { values } = parseArgs({
    options: {
      harness: { type: "string", default: "/Volumes/Models/swu-data/simulation" },
      out: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-models") },
    },
  });
  const head = execFileSync("git", ["-C", values.harness, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dir = harnessCopy(values.harness, head);
  const names = z
    .strictObject({
      core: z.array(z.string().min(1)).min(1),
      all: z.array(z.string().min(1)).min(1),
      embedding: z.array(z.string().min(1)),
    })
    .parse(
      runHarnessProbe(
        dir,
        [
          `import { getAllFeatureNames } from "./src/ml/FeatureExtractor";`,
          `import { getEnhancedEmbeddingFeatureNames } from "./src/ml/EnhancedCardEmbeddings";`,
          `import { registerDefaultPlugins } from "./src/ml/plugins";`,
          `const core = [...getAllFeatureNames()];`,
          `registerDefaultPlugins();`,
          `console.log(JSON.stringify({ core, all: getAllFeatureNames(), embedding: getEnhancedEmbeddingFeatureNames() }));`,
        ].join("\n"),
      ),
    );
  if (names.all.slice(0, names.core.length).some((n, i) => n !== names.core[i]))
    throw new Error("plugin registration reordered the core columns");
  // Names are not unique (two keyword columns repeat inside the core list), so columns are keyed by index, never by name.
  const embedding = new Set(names.embedding);
  const body = {
    schemaVersion: 1 as const,
    harness: { path: "swu-data/simulation", repoCommit: head },
    coreCount: names.core.length,
    columns: names.all.map((name, index) => ({ index, name, ...tierOf(name, index, names.core.length, embedding) })),
  };
  const outputHash = sha256Hex(canonicalJson(body));
  const map = featureMapSchema.parse({
    ...body,
    replay: {
      inputHash: sha256Hex(canonicalJson({ head, names })),
      codeCommit: codeCommit(["scripts/sims/feature-map.ts", "src/sims/model-manifest.ts"]),
      outputHash,
    },
  });
  mkdirSync(values.out, { recursive: true });
  writeFileSync(path.join(values.out, "feature-map.json"), `${JSON.stringify(map, null, 1)}\n`);
  const tally = Object.fromEntries(
    ["exact", "derived", "embedding", "unavailable"].map((t) => [t, map.columns.filter((c) => c.tier === t).length]),
  );
  console.log(JSON.stringify({ coreCount: map.coreCount, total: map.columns.length, tally, outputHash }));
}
