/**
 * @displayName Reader zip assembler
 * @strategicPurpose Manipulation node (LampaGJ/swu-mcp#7): the built run data/runs/<date>/ in, the lean reader
 * package out (staged under data/packages/<date>/ and zipped), byte-identical on a rerun of the same build.
 * @tacticalObjective Reshapes run outputs into llm/ (what a reader loads), optional/ (vectors), audit/ (skip) and
 * docs/, writes a README that tells a reader what to load first, and records the sha256 and token count of every
 * file in audit/package.json. Token counts use gpt-tokenizer o200k as a proxy and are dev-only.
 *
 * Usage: pnpm package:zip [--data <run dir>] [--out <dir>] [--no-zip]
 *   --data    default: newest dated dir under data/runs (SWU_MCP_DATA wins)
 *   --out     default: <repo>/tmp/package
 *   --no-zip  stage the package only
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import { loadStore, resolveDataDir } from "../src/data.js";
import { clustersFileSchema, neighboursFileSchema, vectorsFileSchema } from "../src/embed/files.js";
import { buildLeanReadme, type PackagedFile } from "../src/package/readme.js";
import {
  LEAN_DROP_COLUMNS,
  augmentCards,
  clusterRows,
  fungibleRows,
  leanIndexRows,
  legendRows,
  neighbourRows,
  pairingRows,
  rulingRows,
  trioRows,
  vectorRows,
  type LegendEntry,
} from "../src/package/tables.js";
import { cardRulingsFileSchema } from "../src/rules/schemas.js";
import { scoresFileSchema } from "../src/scorer/scores-file.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../src/swu/canonical.js";
import { INDEX_FACETS, encodeToonTable, type FlatRow } from "../src/swu/llm-flatten.js";
import { loadSynergyContext } from "../src/synergy/context.js";
import { TRIO_FANOUT } from "../src/synergy/trios.js";
import { TOOLS } from "../src/tools.js";
import { codeCommit } from "./lib/code-commit.js";
import { expandHome } from "./lib/originals.js";
import { progress } from "./lib/progress.mjs";
import { REPO_ROOT } from "../src/paths.js";

const PAIRS_PER_CARD = 10;
const TRIOS_PER_SHAPE = 200;
const TRIO_MAX_COST = 9;
const NEIGHBOURS = 5;

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const rowsSchema = z.array(z.record(z.string(), cell));
const buildRecordSchema = z.looseObject({ buildHash: z.string(), date: z.string(), steps: z.array(z.looseObject({ name: z.string() })) });

const TRIO_SHAPE_MEANING: Record<string, string> = {
  chain: "A feeds B and B feeds C (cardA, cardB, cardC in that order).",
  "convergent-different-wants": "A and B both feed C, through different wants of C.",
  "convergent-same-want": "A and B both feed the same want of C.",
  loop: "A feeds B, B feeds C and C feeds A.",
};

const read = (dir: string, rel: string): string => readFileSync(path.join(dir, rel), "utf8");
const readJson = (dir: string, rel: string): unknown => JSON.parse(read(dir, rel));

function withoutWallTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutWallTimes);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "wallTimeMs").map(([key, inner]) => [key, withoutWallTimes(inner)]));
  }
  return value;
}

function main(): void {
  const { values } = parseArgs({ options: { data: { type: "string" }, out: { type: "string", default: path.join(REPO_ROOT, "tmp/package") }, "no-zip": { type: "boolean", default: false } } });
  const runDir = path.resolve(expandHome(values.data ?? resolveDataDir()));
  const build = buildRecordSchema.parse(readJson(runDir, "build.json"));
  const date = z.iso.date().parse(build.date);
  const p = progress("package-zip", { total: 4, everyN: 1 });

  p.log({ phase: "read" });
  const cardsText = read(runDir, "llm/cards.toon");
  const cards: FlatRow[] = rowsSchema.parse((decode(cardsText) as { cards: unknown }).cards);
  if (encodeToonTable("cards", cards) !== cardsText) throw new Error("llm/cards.toon does not survive a decode and encode unchanged");
  const scores = scoresFileSchema.parse(readJson(runDir, "scores/scores.json"));
  const scoreOf = new Map(scores.cards.map((row) => [row.cardKey, { total: row.total, playCalibrated: row.playCalibrated }]));
  const clusters = clustersFileSchema.parse(readJson(runDir, "similarity/clusters.json"));
  const clusterOf = new Map(clusters.clusters.flatMap((cluster) => cluster.members.map((key) => [key, cluster.id] as const)));
  const similar = neighboursFileSchema.parse(readJson(runDir, "similarity/similar.json"));
  const kin = neighboursFileSchema.parse(readJson(runDir, "similarity/kin.json"));
  const vectors = vectorsFileSchema.parse(readJson(runDir, "similarity/vectors.json"));
  const rulings = cardRulingsFileSchema.parse(readJson(runDir, "rules/card-rulings.json"));
  const synergy = loadSynergyContext(runDir);

  p.log({ phase: "tables" });
  const files = new Map<string, string>();
  const legend: LegendEntry[] = [];
  let indexWithDefinitions = 0;
  let indexValues = 0;
  for (const facet of INDEX_FACETS) {
    const source = z
      .object({ [facet]: rowsSchema })
      .parse(decode(read(runDir, `llm/index/${facet}.toon`)))[facet];
    indexWithDefinitions += countTokens(encodeToonTable(facet, source));
    indexValues += source.length;
    for (const row of source) if (typeof row.definition === "string" && row.definition !== "") legend.push({ kind: facet, id: String(row.value), definition: row.definition });
    files.set(`llm/index/${facet}.toon`, encodeToonTable(facet, leanIndexRows(source)));
  }
  files.set("llm/index/names.toon", read(runDir, "llm/index/names.toon"));

  const pairings = pairingRows(synergy.graph, PAIRS_PER_CARD);
  for (const [id, meaning] of pairings.reasons) legend.push({ kind: "pairing-reason", id, definition: meaning });
  for (const [id, meaning] of Object.entries(TRIO_SHAPE_MEANING)) legend.push({ kind: "trio-shape", id, definition: meaning });
  files.set("llm/legend.toon", encodeToonTable("legend", legendRows(legend)));

  const fullCards = augmentCards(cards, scoreOf, clusterOf, false);
  files.set("llm/cards.toon", encodeToonTable("cards", augmentCards(cards, scoreOf, clusterOf, true)));
  files.set("llm/index/similar.toon", encodeToonTable("similar", neighbourRows(similar.cards, NEIGHBOURS)));
  files.set("llm/index/kin.toon", encodeToonTable("kin", neighbourRows(kin.cards, NEIGHBOURS)));
  files.set("llm/index/clusters.toon", encodeToonTable("clusters", clusterRows(clusters.clusters)));
  files.set("llm/index/pairings.toon", encodeToonTable("pairings", pairings.rows));
  const search = synergy.trios({ keep: TRIOS_PER_SHAPE, accept: (_keys, cost) => cost <= TRIO_MAX_COST });
  const trios = trioRows(search.trios, TRIOS_PER_SHAPE, TRIO_MAX_COST);
  files.set("llm/index/trios.toon", encodeToonTable("trios", trios));
  const fungible = fungibleRows(synergy.fungibility);
  files.set("llm/index/fungible.toon", encodeToonTable("fungible", fungible));
  files.set("llm/rules/core-primer.md", read(runDir, "rules/core-primer.md"));
  files.set("llm/rules/card-rulings.toon", encodeToonTable("rulings", rulingRows(rulings)));
  files.set("optional/vectors.toon", encodeToonTable("vectors", vectorRows(vectors.cards)));

  p.log({ phase: "docs" });
  const store = loadStore(runDir);
  const rubric = TOOLS.explain_rubric.handler(store, { section: "summary" }).content.map((part) => part.text).join("");
  files.set(
    "docs/swu-rubric-summary.md",
    `# How the card scores are built

Two scores sit at the end of each row in llm/cards.toon. playCalibrated is fitted to how often a card appears in Premier decks. total is a designer-style stat efficiency. The summary below is the output of the explain_rubric tool of the swu-mcp server, in TOON. Read caveats first. Fitted terms with standard errors are in the repository (pnpm score output and data/rubric-coefficients.json), not in this zip. The full derivation is in audit/swu-card-value-rubric.md; skip it unless you are checking the method.

\`\`\`
${rubric}
\`\`\`
`,
  );
  files.set("docs/swu-card-data-fields.md", read(runDir, "docs/swu-card-data-fields.md"));
  files.set("audit/swu-card-value-rubric.md", read(runDir, "docs/swu-card-value-rubric.md"));
  files.set("audit/swu-card-data.schema.json", read(runDir, "docs/swu-card-data.schema.json"));
  files.set("audit/swu-glossary.json", read(runDir, "docs/swu-glossary.json"));
  files.set("audit/swu-glossary.schema.json", read(runDir, "docs/swu-glossary.schema.json"));
  files.set("audit/gameplay-mismatches.toon", read(runDir, "llm/gameplay-mismatches.toon"));
  files.set("audit/replay/build.json", `${JSON.stringify(withoutWallTimes(readJson(runDir, "build.json")), null, 1)}\n`);
  files.set("audit/replay/package.json", read(runDir, "replay.json"));
  for (const step of ["features", "scores", "synergy", "market", "rules", "similarity"]) files.set(`audit/replay/${step}.json`, read(runDir, `${step}/replay.json`));

  p.log({ phase: "readme" });
  const measured: PackagedFile[] = [...files].map(([rel, content]) => ({
    path: rel,
    bytes: Buffer.byteLength(content),
    tokens: rel.startsWith("optional/") || rel.startsWith("audit/") ? null : countTokens(content),
  }));
  const llmTokens = measured.filter((file) => file.path.startsWith("llm/")).reduce((sum, file) => sum + (file.tokens ?? 0), 0);
  const runReadme = read(runDir, "README.md");
  const sources = /## Sources\n\n([\s\S]*?)\n\n## /.exec(runReadme)?.[1];
  const sizeKeys = /- artFront: (.+)/.exec(runReadme)?.[1];
  if (sources === undefined || sizeKeys === undefined) throw new Error("run README.md lacks the Sources block or the artFront size keys");
  const readme = buildLeanReadme({
    packageDate: date,
    buildHash: build.buildHash,
    sourcesBlock: sources,
    imageSizeKeys: sizeKeys,
    counts: {
      cards: cards.length,
      scored: scores.cards.filter((row) => row.scored).length,
      clusters: clusters.clusters.length,
      trioShapes: Object.keys(TRIO_SHAPE_MEANING).length,
      pairingCards: pairings.rows.length,
      fungibleClasses: fungible.length,
      rulings: rulingRows(rulings).length,
      vectors: Object.keys(vectors.cards).length,
    },
    params: { pairsPerCard: PAIRS_PER_CARD, triosPerShape: TRIOS_PER_SHAPE, trioMaxCost: TRIO_MAX_COST, neighbours: NEIGHBOURS, trioFanout: TRIO_FANOUT, vectorDims: vectors.dims, vectorScale: vectors.scale },
    droppedColumns: [...LEAN_DROP_COLUMNS].sort(compareCodePoints),
    files: measured,
    llmTokens,
  });
  files.set("README.md", readme);

  const record = {
    schemaVersion: 1,
    date,
    buildHash: build.buildHash,
    codeCommit: codeCommit("whole-tree"),
    tokenizer: "gpt-tokenizer o200k_base, a proxy; null for files that are not read as text",
    files: Object.fromEntries(
      [...files].sort(([a], [b]) => compareCodePoints(a, b)).map(([rel, content]) => [rel, { bytes: Buffer.byteLength(content), sha256: sha256Hex(content), tokens: measured.find((file) => file.path === rel)?.tokens ?? null }]),
    ),
  };
  files.set("audit/package.json", `${JSON.stringify(JSON.parse(canonicalJson(record)), null, 1)}\n`);

  const stage = path.join(REPO_ROOT, "data/packages", date);
  rmSync(stage, { recursive: true, force: true });
  const names = [...files.keys()].sort(compareCodePoints);
  const fixed = new Date(`${date}T00:00:00Z`);
  for (const rel of names) {
    const target = path.join(stage, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, files.get(rel) as string);
    utimesSync(target, fixed, fixed);
  }
  let zipPath: string | null = null;
  if (!values["no-zip"]) {
    const outDir = path.resolve(expandHome(values.out));
    mkdirSync(outDir, { recursive: true });
    zipPath = path.join(outDir, `swu-data-${date}.zip`);
    rmSync(zipPath, { force: true });
    execFileSync("zip", ["-q", "-X", zipPath, "-@"], { cwd: stage, input: `${names.join("\n")}\n` });
  }
  p.done({ files: names.length, llmTokens });

  const tokenOf = (rel: string): number | null => measured.find((file) => file.path === rel)?.tokens ?? null;
  const fullCardsTokens = countTokens(encodeToonTable("cards", fullCards));
  console.log(
    JSON.stringify(
      {
        zip: zipPath,
        stage,
        llmTokens,
        files: Object.fromEntries(names.map((rel) => [rel, { bytes: Buffer.byteLength(files.get(rel) as string), tokens: tokenOf(rel) }])),
        comparison: {
          cardsAllColumnsPlusThree: fullCardsTokens,
          cardsLean: tokenOf("llm/cards.toon"),
          indexesWithDefinitions: indexWithDefinitions,
          indexesWithoutDefinitions: [...INDEX_FACETS].reduce((sum, facet) => sum + (tokenOf(`llm/index/${facet}.toon`) ?? 0), 0),
          legend: tokenOf("llm/legend.toon"),
          indexValues,
        },
      },
      null,
      1,
    ),
  );
}

main();
