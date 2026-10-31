/**
 * @displayName forceteki engine pin script
 * @strategicPurpose Turn the spike's manual engine recipe into one committed, fail-loud step (#109): every simulation
 * reads the pin, and nothing else touches the engine clone.
 * @tacticalObjective `--setup` clones SWU-Karabast/forceteki at the pinned commit when no clone exists, then runs
 * npm install, get-cards and build as needed; an existing clone at the pinned commit is reused. Every run then
 * verifies commit, card-data version, card-data content hash and build against the pin and exits 1 on any mismatch.
 * `--write` records the clone's current state as the pin instead (first pin or a deliberate re-pin).
 *
 * Usage: tsx scripts/sims/pin-engine.ts [--forceteki <dir>] [--pin <file>] [--setup] [--rebuild] [--refetch] [--write]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT } from "../../src/paths.js";
import { isMain } from "../bench/code-commit.js";
import {
  BUILT_MARKER,
  DEFAULT_FORCETEKI,
  DEFAULT_PIN_PATH,
  FORCETEKI_REPO,
  NPM_INSTALL_ARGS,
  cardDataSha256,
  enginePinSchema,
  nodeSatisfies,
  readPin,
  setupPlan,
  verifyEngine,
  type EnginePin,
} from "../../src/sims/engine-pin.js";

/** The commit the spike measured (2026-10-30); used only when no pin file exists yet. */
const SPIKE_COMMIT = "445792e6185c10ca66c27a95893474c25256f3cc";

const NOTES = [
  "Node: the engine's package.json requires >=26.12.1 <27 with engine-strict=true; install runs with --engine-strict=false. node.used is the Node that built and ran it; satisfiesRequired false means an unsupported combination that nonetheless built, passed the specs run and played the spike's games.",
  "The engine runs only as a local child process or worker, never in the public npx path, because swu-mcp declares Node 22 or newer.",
  "Card data is fetched live from https://admin.starwarsunlimited.com/api/cards by npm run get-cards and tracks the live card pool; cardDataSha256 hashes every file under test/json so a re-fetch that changed any card fails verification.",
  "Open question: does determinism hold across machines and across Node 26.4.0 versus 26.12.1? Same machine, same Node, same commit identity is measured; a second machine or the supported Node answers it.",
  "Card data is Fantasy Flight's: a launch-stage licensing question (noted once, proceeding).",
];

export function gitHead(root: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function pinFromClone(root: string, previous: EnginePin | null): EnginePin {
  const head = gitHead(root);
  if (head === null) throw new Error(`cannot read the commit of ${root}`);
  const { engines } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { engines?: { node?: string } };
  const required = engines?.node ?? "unknown";
  const cardData = cardDataSha256(path.join(root, "test/json"));
  return enginePinSchema.parse({
    schemaVersion: 1,
    repo: previous?.repo ?? FORCETEKI_REPO,
    commit: head,
    cardDataVersion: readFileSync(path.join(root, "card-data-version.txt"), "utf8").trim(),
    cardDataSha256: cardData.sha256,
    cardDataFiles: cardData.files,
    engineCardDataInputSha256: readFileSync(path.join(root, "test/json/card-data-hash.txt"), "utf8").trim(),
    node: { required, used: process.version, satisfiesRequired: nodeSatisfies(process.version, required) },
    steps: [`npm ${NPM_INSTALL_ARGS.join(" ")}`, "npm run get-cards", "npm run build"],
    notes: NOTES,
  });
}

function main(): void {
  const { values } = parseArgs({
    options: {
      forceteki: { type: "string", default: DEFAULT_FORCETEKI },
      pin: { type: "string", default: DEFAULT_PIN_PATH },
      setup: { type: "boolean", default: false },
      rebuild: { type: "boolean", default: false },
      refetch: { type: "boolean", default: false },
      write: { type: "boolean", default: false },
    },
  });
  const root = path.resolve(values.forceteki);
  const pinFile = path.resolve(values.pin);
  const existing = existsSync(pinFile) ? readPin(pinFile) : null;

  if (values.setup) {
    const planPin = existing ?? ({ repo: FORCETEKI_REPO, commit: SPIKE_COMMIT } as EnginePin);
    const state = {
      exists: existsSync(root),
      head: existsSync(root) ? gitHead(root) : null,
      built: existsSync(path.join(root, BUILT_MARKER)),
      hasCardData: existsSync(path.join(root, "test/json/_setCodeMap.json")),
    };
    const steps = setupPlan(state, planPin, root, { rebuild: values.rebuild, refetch: values.refetch });
    const npmCache = path.join(REPO_ROOT, "tmp/npm-cache");
    mkdirSync(npmCache, { recursive: true });
    for (const step of steps) {
      console.error(`pin-engine: ${step.label}: ${step.command} ${step.args.join(" ")}`);
      execFileSync(step.command, step.args, {
        cwd: step.cwd ?? undefined,
        stdio: "inherit",
        env: { ...process.env, TMPDIR: path.join(REPO_ROOT, "tmp"), npm_config_cache: npmCache, npm_config_engine_strict: "false" },
      });
    }
    if (steps.length === 0) console.error(`pin-engine: ${root} is built at ${planPin.commit}; nothing to clone or build`);
  }

  if (values.write) {
    const pin = pinFromClone(root, existing);
    mkdirSync(path.dirname(pinFile), { recursive: true });
    writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
    console.error(`pin-engine: wrote ${pinFile}`);
  }

  if (!existsSync(pinFile)) throw new Error(`no pin at ${pinFile}; run with --write once the clone is built`);
  const pin = readPin(pinFile);
  const v = verifyEngine(root, pin, { head: gitHead, nodeVersion: process.version });
  for (const w of v.warnings) console.error(`pin-engine: warning: ${w}`);
  console.log(JSON.stringify({ forceteki: root, commit: pin.commit, cardDataVersion: pin.cardDataVersion, cardData: v.cardData, node: { running: process.version, pinned: pin.node }, ok: v.problems.length === 0, problems: v.problems }));
  if (v.problems.length > 0) {
    for (const p of v.problems) console.error(`pin-engine: FAIL: ${p}`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) main();
