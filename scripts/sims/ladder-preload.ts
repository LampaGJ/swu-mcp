/**
 * @displayName Ladder policy preload
 * @strategicPurpose The typed driver's worker threads resolve policies by name from its POLICIES registry; this
 * preload puts rung 1, rung 2 and the greedy baseline there in every worker before a match starts, without editing
 * the driver.
 * @tacticalObjective Loaded with `node --import tsx --import ./scripts/sims/ladder-preload.ts`; the driver's pool
 * passes the parent's execArgv to its workers, so each worker runs it too. Reads SIMS_POLICY_SPECS (names joined by
 * ";"), SIMS_RUN, SIMS_PAIR_TABLE (the parent's precomputed edge table, a JSON file) and SIMS_DRIVER_ROOT (default:
 * this repo). With SIMS_POLICY_SPECS unset (the parent at start-up) it does nothing. When SIMS_VIEW_KEYS is set (the
 * parent called prepareLearned, scripts/sims/policy/learned.ts) it also registers the learned rungs (#128) and the
 * evaluator observers (#127).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT } from "../../src/paths.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables, type PairTable } from "../../src/sims/policies/tables.js";

const names = (process.env.SIMS_POLICY_SPECS ?? "").split(";").filter(Boolean);
if (names.length > 0) {
  const root = process.env.SIMS_DRIVER_ROOT ?? REPO_ROOT;
  const driver = (await import(pathToFileURL(path.join(root, "src/sims/policy.ts")).href)) as {
    POLICIES: Record<string, () => unknown>;
    OBSERVERS: Record<string, () => never>;
    PolicyChain: new (policies: unknown[]) => unknown;
  };
  const pairFile = process.env.SIMS_PAIR_TABLE;
  const tables = loadTables({
    runDir: process.env.SIMS_RUN ?? path.join(REPO_ROOT, "data/runs/2026-10-31"),
    complementarity: path.join(REPO_ROOT, "data/complementarity.json"),
    pairs: pairFile ? (JSON.parse(readFileSync(pairFile, "utf8")) as PairTable) : false,
  });
  registerRungs(driver.POLICIES, (ps) => new driver.PolicyChain(ps), names, tables);
  if (process.env.SIMS_VIEW_KEYS !== undefined) {
    const learned = await import("./policy/learned.js");
    learned.registerFromEnv(driver.POLICIES, (ps) => new driver.PolicyChain(ps), names, tables, driver.OBSERVERS);
  }
}
