import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../../src/paths.js";
import { driverName, greedyHashPolicy, registerRungs, type DriverPolicy } from "../../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../../src/sims/policies/tables.js";

const RUN = path.join(REPO_ROOT, "data/runs/2026-10-31");

describe("typed-driver adapter", () => {
  it("names harness policies by their driver registry names", () => {
    expect(driverName("random-spike")).toBe("rung0");
    expect(driverName("rung0")).toBe("rung0");
    expect(driverName("greedy")).toBe("greedy-hash");
    expect(driverName("rung2:mu=2,lambda=0")).toBe("rung2:mu=2,lambda=0");
  });

  it("the greedy baseline prefers a hand card over Pass", () => {
    const g = greedyHashPolicy();
    const players = [{ getArenaCards: () => [], hand: [{ internalName: "x", cost: 2 }] }, {}];
    const actions = [
      { kind: "pass", label: "Pass", descriptor: "pass|-|-|0|Pass", engineCardId: null, controller: null, zone: null, ordinal: 0, targets: [] },
      { kind: "play", label: "x", descriptor: "play|K|p1.hand|0", engineCardId: "x", controller: 1, zone: "hand", ordinal: 0, targets: [] },
    ];
    expect(g.choose(actions, { seat: 1, k: 0, promptKind: "mainAction", multi: false, game: {}, players }, () => 0.5)?.index).toBe(1);
  });

  it.skipIf(!existsSync(path.join(RUN, "synergy/pairs.toon")))("registers one chain per name, with the pinned inputs each rung reads", () => {
    const tables = loadTables({ runDir: RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: true });
    const registry: Record<string, () => unknown> = {};
    registerRungs(registry, (ps) => ps, ["rung0", "rung1", "rung2:mu=1,lambda=0.5", "greedy-hash"], tables);
    expect(Object.keys(registry).sort()).toEqual(["greedy-hash", "rung1", "rung2:mu=1,lambda=0.5"]);
    const [r1] = registry.rung1() as DriverPolicy[];
    const [r2] = registry["rung2:mu=1,lambda=0.5"]() as DriverPolicy[];
    expect(Object.keys(r1.inputs).sort()).toEqual(["coefficients", "features", "scores"]);
    expect(Object.keys(r2.inputs).sort()).toEqual(["coefficients", "complementarity", "features", "leaderCards", "pairPrecision", "pairs", "scores"]);
    expect(r2.params).toMatchObject({ mu: 1, lambda: 0.5 });
  });
});
