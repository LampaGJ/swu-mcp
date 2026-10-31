import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { hex64 } from "../schemas/hash.js";
import { REPO_ROOT } from "../paths.js";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName forceteki engine pin
 * @strategicPurpose The rules engine is an input like any decklist (#109, D77): one recorded commit, one card-data
 * snapshot and the Node that ran it, so a seeded match replays byte for byte, and a silently re-fetched card pool
 * fails loudly instead of changing results.
 * @tacticalObjective Schema of `data/pinned/forceteki/pin.json`, the content hash of the clone's `test/json`, the
 * verify step every simulation runs before it loads the engine, and the pure setup plan the pin script executes.
 */

export const DEFAULT_FORCETEKI = "/Volumes/Local Files/Projects/forceteki";
export const DEFAULT_PIN_PATH = path.join(REPO_ROOT, "data/pinned/forceteki/pin.json");
export const FORCETEKI_REPO = "https://github.com/SWU-Karabast/forceteki.git";

export const enginePinSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repo: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40}$/, { error: "a full 40-character commit sha" }),
  cardDataVersion: z.string().min(1),
  /** sha256 over every file under the clone's test/json, see cardDataSha256. */
  cardDataSha256: hex64,
  cardDataFiles: z.int().positive(),
  /** The engine's own test/json/card-data-hash.txt: a hash of its fetch inputs, not of the fetched cards. */
  engineCardDataInputSha256: hex64,
  node: z.strictObject({ required: z.string().min(1), used: z.string().regex(/^v\d+\.\d+\.\d+$/), satisfiesRequired: z.boolean().nullable() }),
  steps: z.array(z.string().min(1)).min(1),
  notes: z.array(z.string().min(1)),
});
export type EnginePin = z.infer<typeof enginePinSchema>;

export function readPin(file: string = DEFAULT_PIN_PATH): EnginePin {
  return enginePinSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function listFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * The engine fetches its cards live from the official API, and its own card-data-hash.txt covers only the fetch
 * inputs, so this hashes the fetched files themselves: one line `path NUL sha256(bytes)` per file, paths sorted.
 */
export function cardDataSha256(jsonDir: string): { sha256: string; files: number } {
  const files = listFiles(jsonDir).sort(compareCodePoints);
  const hash = createHash("sha256");
  for (const rel of files) hash.update(`${rel}\u0000${createHash("sha256").update(readFileSync(path.join(jsonDir, rel))).digest("hex")}\n`);
  return { sha256: hash.digest("hex"), files: files.length };
}

const version = (v: string): number[] | null => {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v.trim());
  return m === null ? null : [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
};
const cmp = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Reads only the engine's `>=a <b` engines range; anything else is unknown (null), never a guess. */
export function nodeSatisfies(nodeVersion: string, range: string): boolean | null {
  const m = /^>=\s*(\S+)\s+<\s*(\S+)$/.exec(range.trim());
  const v = version(nodeVersion);
  if (m === null || v === null) return null;
  const lo = version(m[1]);
  const hi = version(m[2]);
  if (lo === null || hi === null) return null;
  return cmp(v, lo) >= 0 && cmp(v, hi) < 0;
}

export interface Verification {
  problems: string[];
  warnings: string[];
  cardData: { sha256: string; files: number } | null;
}

export interface VerifyDeps {
  head: (root: string) => string | null;
  nodeVersion: string;
}

export const BUILT_MARKER = "build/server/game/core/Game.js";

/** Every way the clone can differ from the pin, as sentences; empty problems means the engine may load. */
export function verifyEngine(root: string, pin: EnginePin, deps: VerifyDeps): Verification {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!existsSync(root)) return { problems: [`no forceteki clone at ${root}; run pnpm sims:pin --setup`], warnings, cardData: null };
  const head = deps.head(root);
  if (head !== pin.commit) problems.push(`clone ${root} is at commit ${head ?? "unknown"}, pinned ${pin.commit}`);
  const versionFile = path.join(root, "card-data-version.txt");
  const cardDataVersion = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : null;
  if (cardDataVersion !== pin.cardDataVersion) problems.push(`card-data-version.txt is ${cardDataVersion ?? "missing"}, pinned ${pin.cardDataVersion}`);
  let cardData: Verification["cardData"] = null;
  const jsonDir = path.join(root, "test/json");
  if (!existsSync(jsonDir)) problems.push(`no card data at ${jsonDir}; run npm run get-cards in the clone`);
  else {
    cardData = cardDataSha256(jsonDir);
    if (cardData.sha256 !== pin.cardDataSha256)
      problems.push(
        `card data hash differs from the pin: pinned ${pin.cardDataSha256}, found ${cardData.sha256} (${cardData.files} files, pinned ${pin.cardDataFiles}). The engine fetches cards live, so the card pool changed; replays of pinned matches would silently diverge. Re-pin deliberately with pnpm sims:pin --write.`,
      );
  }
  if (!existsSync(path.join(root, BUILT_MARKER))) problems.push(`clone is not built (${BUILT_MARKER} missing); run pnpm sims:pin --setup`);
  if (deps.nodeVersion !== pin.node.used)
    warnings.push(
      `Node ${deps.nodeVersion} differs from the pinned ${pin.node.used}; determinism across Node versions is unmeasured (pin notes), so traces may not match records made on ${pin.node.used}.`,
    );
  return { problems, warnings, cardData };
}

export interface CloneState {
  exists: boolean;
  head: string | null;
  built: boolean;
  hasCardData: boolean;
}

export interface SetupStep {
  label: "clone" | "checkout" | "install" | "get-cards" | "build";
  command: "git" | "npm";
  args: string[];
  cwd: string | null;
}

export const NPM_INSTALL_ARGS = ["install", "--engine-strict=false", "--no-audit", "--no-fund"];

/**
 * What the pin script must run to reach a built clone at the pinned commit. A clone at another commit is refused,
 * never checked out over, because it may hold someone's work.
 */
export function setupPlan(state: CloneState, pin: EnginePin, root: string, opts: { rebuild?: boolean; refetch?: boolean } = {}): SetupStep[] {
  const steps: SetupStep[] = [];
  if (!state.exists) {
    steps.push({ label: "clone", command: "git", args: ["clone", pin.repo, root], cwd: null });
    steps.push({ label: "checkout", command: "git", args: ["-C", root, "checkout", "--detach", pin.commit], cwd: null });
  } else if (state.head !== pin.commit) {
    throw new Error(`clone ${root} is at ${state.head ?? "an unknown commit"}, pinned ${pin.commit}; move or remove it yourself, the pin script never rewrites a clone`);
  }
  const fresh = !state.exists;
  const install = fresh || opts.rebuild === true || !state.built;
  if (install) steps.push({ label: "install", command: "npm", args: NPM_INSTALL_ARGS, cwd: root });
  if (fresh || opts.refetch === true || !state.hasCardData) steps.push({ label: "get-cards", command: "npm", args: ["run", "get-cards"], cwd: root });
  if (install) steps.push({ label: "build", command: "npm", args: ["run", "build"], cwd: root });
  return steps;
}
