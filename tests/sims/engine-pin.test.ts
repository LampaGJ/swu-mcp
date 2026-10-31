import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PIN_PATH,
  cardDataSha256,
  nodeSatisfies,
  readPin,
  setupPlan,
  verifyEngine,
  type EnginePin,
} from "../../src/sims/engine-pin.js";

const tmpRoot = path.join(process.cwd(), "tmp");
mkdirSync(tmpRoot, { recursive: true });

function fakeClone(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpRoot, "pin-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const basePin = (over: Partial<EnginePin> = {}): EnginePin => ({
  schemaVersion: 1,
  repo: "https://github.com/SWU-Karabast/forceteki.git",
  commit: "445792e6185c10ca66c27a95893474c25256f3cc",
  cardDataVersion: "20260423_00",
  cardDataSha256: "0".repeat(64),
  cardDataFiles: 2,
  engineCardDataInputSha256: "1".repeat(64),
  node: { required: ">=26.12.1 <27", used: "v26.4.0", satisfiesRequired: false },
  steps: ["npm install --engine-strict=false --no-audit --no-fund", "npm run get-cards", "npm run build"],
  notes: ["n"],
  ...over,
});

describe("card data hash over test/json", () => {
  it("is order-independent, path-sensitive and content-sensitive", () => {
    const a = fakeClone({ "test/json/Card/a.json": "1", "test/json/_cardMap.json": "[]" });
    const b = fakeClone({ "test/json/_cardMap.json": "[]", "test/json/Card/a.json": "1" });
    const c = fakeClone({ "test/json/_cardMap.json": "[]", "test/json/Card/b.json": "1" });
    const d = fakeClone({ "test/json/_cardMap.json": "[]", "test/json/Card/a.json": "2" });
    const ha = cardDataSha256(path.join(a, "test/json"));
    expect(ha.files).toBe(2);
    expect(ha.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cardDataSha256(path.join(b, "test/json")).sha256).toBe(ha.sha256);
    expect(cardDataSha256(path.join(c, "test/json")).sha256).not.toBe(ha.sha256);
    expect(cardDataSha256(path.join(d, "test/json")).sha256).not.toBe(ha.sha256);
  });
});

describe("verifyEngine fails loudly", () => {
  const clone = () =>
    fakeClone({
      "card-data-version.txt": "20260423_00\n",
      "test/json/_cardMap.json": "[]",
      "test/json/_setCodeMap.json": "{}",
      "build/server/game/core/Game.js": "",
    });

  it("passes when commit, version, hash and build all match", () => {
    const dir = clone();
    const { sha256, files } = cardDataSha256(path.join(dir, "test/json"));
    const v = verifyEngine(dir, basePin({ cardDataSha256: sha256, cardDataFiles: files }), { head: () => basePin().commit, nodeVersion: "v26.4.0" });
    expect(v.problems).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("names a card-data hash mismatch with both hashes", () => {
    const dir = clone();
    const v = verifyEngine(dir, basePin(), { head: () => basePin().commit, nodeVersion: "v26.4.0" });
    expect(v.problems.join("\n")).toMatch(/card data hash differs from the pin: pinned 0{64}, found [0-9a-f]{64}/);
  });

  it("names a wrong commit, a wrong card-data version and a missing build", () => {
    const dir = fakeClone({ "card-data-version.txt": "20990101_00", "test/json/x.json": "{}" });
    const v = verifyEngine(dir, basePin(), { head: () => "f".repeat(40), nodeVersion: "v26.4.0" });
    const text = v.problems.join("\n");
    expect(text).toMatch(/commit/);
    expect(text).toMatch(/card-data-version\.txt is 20990101_00, pinned 20260423_00/);
    expect(text).toMatch(/not built/);
  });

  it("names a missing clone", () => {
    const v = verifyEngine(path.join(tmpRoot, "no-such-clone"), basePin(), { head: () => null, nodeVersion: "v26.4.0" });
    expect(v.problems[0]).toMatch(/no forceteki clone/);
  });

  it("records a Node mismatch as a warning, never silently", () => {
    const dir = clone();
    const { sha256, files } = cardDataSha256(path.join(dir, "test/json"));
    const v = verifyEngine(dir, basePin({ cardDataSha256: sha256, cardDataFiles: files }), { head: () => basePin().commit, nodeVersion: "v26.12.1" });
    expect(v.problems).toEqual([]);
    expect(v.warnings.join("\n")).toMatch(/Node v26\.12\.1 differs from the pinned v26\.4\.0/);
  });
});

describe("nodeSatisfies", () => {
  it("reads the engine's >=a <b range", () => {
    expect(nodeSatisfies("v26.4.0", ">=26.12.1 <27")).toBe(false);
    expect(nodeSatisfies("v26.12.1", ">=26.12.1 <27")).toBe(true);
    expect(nodeSatisfies("v26.20.0", ">=26.12.1 <27")).toBe(true);
    expect(nodeSatisfies("v27.0.0", ">=26.12.1 <27")).toBe(false);
    expect(nodeSatisfies("v22.1.0", "weird")).toBeNull();
  });
});

describe("setupPlan", () => {
  const pin = basePin();
  it("clones, checks out, installs, fetches and builds from scratch", () => {
    const plan = setupPlan({ exists: false, head: null, built: false, hasCardData: false }, pin, "/x/forceteki");
    expect(plan.map((s) => s.label)).toEqual(["clone", "checkout", "install", "get-cards", "build"]);
    expect(plan[0].args).toEqual(["clone", pin.repo, "/x/forceteki"]);
    expect(plan[1].args).toEqual(["-C", "/x/forceteki", "checkout", "--detach", pin.commit]);
    expect(plan[2].args).toEqual(["install", "--engine-strict=false", "--no-audit", "--no-fund"]);
  });
  it("skips everything for a built clone at the pinned commit", () => {
    expect(setupPlan({ exists: true, head: pin.commit, built: true, hasCardData: true }, pin, "/x")).toEqual([]);
  });
  it("refuses a clone at another commit instead of moving it", () => {
    expect(() => setupPlan({ exists: true, head: "a".repeat(40), built: true, hasCardData: true }, pin, "/x")).toThrow(/is at a{40}, pinned 445792e/);
  });
  it("rebuilds on request without re-cloning", () => {
    const plan = setupPlan({ exists: true, head: pin.commit, built: true, hasCardData: true }, pin, "/x", { rebuild: true });
    expect(plan.map((s) => s.label)).toEqual(["install", "build"]);
  });
});

describe("the committed pin", () => {
  it("parses and records the unsupported Node it ran on", () => {
    const pin = readPin(DEFAULT_PIN_PATH);
    expect(pin.commit).toBe("445792e6185c10ca66c27a95893474c25256f3cc");
    expect(pin.cardDataVersion).toBe("20260423_00");
    expect(pin.node.required).toBe(">=26.12.1 <27");
    expect(pin.node.satisfiesRequired).toBe(nodeSatisfies(pin.node.used, pin.node.required));
    expect(pin.notes.join(" ")).toMatch(/Open question/);
  });
});
