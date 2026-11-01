/**
 * @displayName Evaluator vocabulary builder
 * @strategicPurpose Pins the card and keyword vocabulary the evaluator's indices rest on, once per data release, so
 * training and inference agree on every index and a later release can only append.
 * @tacticalObjective Reads cards.toon from the built run matching src/data-release.json and the keyword enum from the
 * pinned forceteki clone, builds the vocabulary (extending --parent when given), and writes
 * data/pinned/sim-vocab/<dataVersion>.json plus a replay record. Refuses a run whose buildHash differs from the
 * release pin, and never overwrites a pinned vocabulary with different bytes.
 *
 * Usage: pnpm sims:vocab --data data/runs/<date> --engine <forceteki clone> [--parent data/pinned/sim-vocab/<v>.json]
 *   [--revision <n> --bridge-originals <mault originals dir>]: a revision above 1 extends --parent of the same data
 *   release with the #109 bridge's printing keys (engine cards outside the release), written as <dataVersion>.v<n>.json.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore } from "../../src/data.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI, readPin } from "../../src/sims/engine-pin.js";
import { hex64 } from "../../src/schemas/hash.js";
import { buildVocab, parseVocab, vocabFileName } from "../../src/sims/vocab.js";
import { loadCardBridge } from "./card-bridge.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { codeCommit } from "../lib/code-commit.js";

const { values } = parseArgs({
  options: {
    data: { type: "string" },
    engine: { type: "string", default: DEFAULT_FORCETEKI },
    parent: { type: "string" },
    revision: { type: "string", default: "1" },
    "bridge-originals": { type: "string" },
    out: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-vocab") },
  },
});
if (values.data === undefined) throw new Error("--data <run dir> is required");

// looseObject: both files carry more fields than this step reads (precedent: scripts/package-zip.ts:57).
const release = z
  .looseObject({ dataVersion: z.string().min(1), buildHash: hex64 })
  .parse(JSON.parse(readFileSync(path.join(REPO_ROOT, "src/data-release.json"), "utf8")));
const build = z.looseObject({ buildHash: hex64 }).parse(JSON.parse(readFileSync(path.join(values.data, "build.json"), "utf8")));
if (build.buildHash !== release.buildHash) {
  throw new Error(
    `${values.data}/build.json buildHash ${build.buildHash} differs from src/data-release.json ${release.buildHash}; build the pinned release first`,
  );
}

const constants = path.join(values.engine, "build/server/game/core/Constants.js");
if (!existsSync(constants)) throw new Error(`no compiled forceteki at ${values.engine} (missing ${constants})`);
const engineKeywords = z
  .array(z.string().min(1))
  .min(1)
  .parse(Object.values((createRequire(import.meta.url)(constants) as { KeywordName: Record<string, string> }).KeywordName));
const engineCommit = execFileSync("git", ["-C", values.engine, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const pinnedCommit = readPin().commit;
if (engineCommit !== pinnedCommit)
  throw new Error(
    `forceteki clone ${values.engine} is at ${engineCommit}, the engine pin (data/pinned/forceteki/pin.json) is ${pinnedCommit}`,
  );

const cardsToon = readFileSync(path.join(values.data, "llm/cards.toon"));
const store = loadStore(values.data);
const parent = values.parent === undefined ? null : parseVocab(JSON.parse(readFileSync(values.parent, "utf8")));
const revision = Number(values.revision);
if (!Number.isInteger(revision) || revision < 1) throw new Error(`--revision ${values.revision} is not a positive integer`);
if (revision > 1 && values["bridge-originals"] === undefined)
  throw new Error("--revision above 1 needs --bridge-originals <dir>: the revision exists to append the bridge's keys");
// The bridge from the same run and pinned clone the driver uses; its keys for cards the store lacks are the extra keys.
const extraKeys =
  values["bridge-originals"] === undefined
    ? []
    : [...new Set(Object.values(loadCardBridge(values.data, values["bridge-originals"], values.engine).engineCardKeys))]
        .filter((k) => !store.byKey.has(k))
        .sort(compareCodePoints);

const vocab = buildVocab({
  dataVersion: release.dataVersion,
  buildHash: release.buildHash,
  cardsToonSha256: sha256Hex(cardsToon),
  engineCommit,
  cards: store.cards.map((c) => ({ cardKey: c.cardKey, type: c.type, title: c.title })),
  engineKeywords,
  parent,
  revision,
  extraKeys,
});
const bytes = `${JSON.stringify(JSON.parse(canonicalJson(vocab)), null, 1)}\n`;
const replay = {
  inputHash: sha256Hex(
    canonicalJson({
      cardsToonSha256: vocab.cardsToonSha256,
      buildHash: vocab.buildHash,
      engineCommit,
      engineKeywords: [...engineKeywords].sort(compareCodePoints),
      parent: vocab.parent,
      ...(extraKeys.length > 0 ? { extraKeysSha256: sha256Hex(canonicalJson(extraKeys)) } : {}),
    }),
  ),
  codeCommit: codeCommit(["scripts/sims/build-vocab.ts", "src/sims/vocab.ts"]),
  outputHash: sha256Hex(bytes),
};

mkdirSync(values.out, { recursive: true });
const file = path.join(values.out, vocabFileName(vocab));
if (existsSync(file)) {
  if (readFileSync(file, "utf8") !== bytes) {
    throw new Error(
      `${file} already exists with different bytes; a pinned vocabulary is never overwritten. Pin a new data version instead.`,
    );
  }
  console.log(JSON.stringify({ file, status: "identical to the pinned vocabulary", outputHash: replay.outputHash }));
} else {
  writeFileSync(file, bytes);
  writeFileSync(file.replace(/\.json$/, ".replay.json"), `${JSON.stringify(replay, null, 1)}\n`);
  console.log(
    JSON.stringify({
      file,
      keys: vocab.keys.length,
      extraKeys: extraKeys.length,
      aliases: Object.keys(vocab.aliases).length,
      keywords: vocab.keywords.length,
      contentSha256: vocab.contentSha256,
      replay,
    }),
  );
}
