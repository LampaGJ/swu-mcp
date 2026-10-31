import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../src/paths.js";
import { registerRungs } from "../../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../../src/sims/policies/tables.js";

const DRIVER = process.env.SIMS_DRIVER_ROOT ?? REPO_ROOT;
const FORCETEKI = "/Volumes/Local Files/Projects/forceteki";
const RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");
const ready = existsSync(path.join(DRIVER, "src/sims/policy.ts")) && existsSync(path.join(FORCETEKI, "build/server/game/core/Game.js")) && existsSync(path.join(RUN, "synergy/pairs.toon"));

const driverModule = async (rel: string): Promise<any> => import(pathToFileURL(path.join(DRIVER, rel)).href);

describe.skipIf(!ready)("bot rungs on the typed forceteki driver", () => {
  it("plays whole games; rung 2 with mu = lambda = 0 reproduces rung 1's trace; a seed replays; rule coverage is near total", async () => {
    const policy = await driverModule("src/sims/policy.ts");
    const match = await driverModule("src/sims/match.ts");
    const context = await driverModule("scripts/sims/context.ts");
    const decks = await driverModule("scripts/sims/decks.ts");
    const tables = loadTables({ runDir: RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: true });
    registerRungs(policy.POLICIES, (ps) => new policy.PolicyChain(ps), ["rung1", "rung2:mu=0,lambda=0", "rung2:mu=1,lambda=1", "greedy-hash"], tables);
    const ctx = context.loadContext({ forceteki: FORCETEKI, run: RUN, originals: context.DEFAULT_ORIGINALS, "no-memo": false });
    const deck = decks.prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, "tests/fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")), "file:warrior");
    const play = async (p1: string, p2: string, seed: string) =>
      (await match.playMatch(ctx.engine, { seed, decks: [deck, deck], policies: [p1, p2], recordMode: "none", undo: false, codeCommit: "test" }, ctx.bridge.engineCardKeys)).record.footer;
    const r1 = await play("rung1", "rung0", "7");
    expect(r1.result.endCondition).toBe("base_destroyed");
    expect(r1.coverage.decisions[0]).toBeGreaterThan(20);
    expect(1 - r1.coverage.answered[0] / r1.coverage.decisions[0]).toBeLessThan(0.05);
    expect((await play("rung1", "rung0", "7")).traceSha256).toBe(r1.traceSha256);
    expect((await play("rung2:mu=0,lambda=0", "rung0", "7")).traceSha256).toBe(r1.traceSha256);
    expect((await play("rung2:mu=1,lambda=1", "greedy-hash", "7")).result.endCondition).toBe("base_destroyed");
  }, 120_000);
});
