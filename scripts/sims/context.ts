/**
 * @displayName Simulation CLI context
 * @strategicPurpose Every simulation CLI loads the same three pinned inputs the same way: the engine (verified against
 * its pin), the cardKey bridge, and the code commit, so their records agree on every header field.
 * @tacticalObjective Loads and verifies the engine, prints the pin's Node warning once, builds the bridge from the run
 * and originals, and exposes the default paths.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { installSelectableCardsMemo, loadEngine, type Engine } from "../../src/sims/engine.js";
import { DEFAULT_ORIGINALS_ROOT } from "../bench/card-map.js";
import { codeCommit } from "../bench/code-commit.js";
import { loadCardBridge, type CardBridge } from "./card-bridge.js";

export const DEFAULT_RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");
export const DEFAULT_ORIGINALS = path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16");

export const contextOptions = {
  forceteki: { type: "string", default: DEFAULT_FORCETEKI },
  run: { type: "string", default: DEFAULT_RUN },
  originals: { type: "string", default: DEFAULT_ORIGINALS },
  "no-memo": { type: "boolean", default: false },
} as const;

export interface SimContext {
  engine: Engine;
  bridge: CardBridge;
  codeCommit: string;
}

export function loadContext(values: { forceteki: string; run: string; originals: string; "no-memo": boolean }): SimContext {
  const head = (r: string): string => execFileSync("git", ["-C", r, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const engine = loadEngine(values.forceteki, { head });
  for (const w of engine.warnings) console.error(`sims: warning: ${w}`);
  if (!values["no-memo"]) installSelectableCardsMemo(values.forceteki);
  return { engine, bridge: loadCardBridge(values.run, values.originals, values.forceteki), codeCommit: codeCommit() };
}
