import { decode } from "@toon-format/toon";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadStore } from "../src/data.js";
import type { ToolResult } from "../src/tools.js";
import { clusterHandler, kinCardsHandler, similarCardsHandler } from "../src/tools/similarity.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const dir = mkdtempSync(path.join(os.tmpdir(), "similarity-tools-"));
cpSync(fixtures, dir, { recursive: true });
mkdirSync(path.join(dir, "similarity"));
const zero = "0".repeat(64);
const write = (name: string, value: unknown): void => writeFileSync(path.join(dir, "similarity", name), JSON.stringify(value));
const base = { renderVersion: 1, limit: 10 };
write("similar.json", {
  ...base,
  edge: "similar",
  meaning: "ability cosine",
  rendering: "ability",
  minCosine: 0.75,
  cards: {
    "0101033": [
      ["0101074", 0.81],
      ["04010001", 0.76],
    ],
    "0101074": [["0101033", 0.81]],
  },
});
write("kin.json", {
  ...base,
  edge: "kin",
  meaning: "surface-blind",
  rendering: "abstract",
  minCosine: null,
  cards: { "0101033": [["09010218", 0.9]] },
});
write("clusters.json", {
  renderVersion: 1,
  k: 2,
  seed: 1,
  restarts: 1,
  maxIter: 1,
  inertia: 1,
  clusters: [
    { id: 0, size: 2, label: "word:damage(100%)", members: ["0101033", "0101074"] },
    { id: 1, size: 1, label: "", members: ["09010218"] },
  ],
});
write("replay.json", {
  codeCommit: "x",
  renderVersion: 1,
  capture: "1-abcdef012345",
  inputHash: { capture: zero, "ability.f32": zero, "abstract.f32": zero, cards: zero },
  params: { similarLimit: 10, similarMinCosine: 0.75, kinLimit: 10, k: 2, seed: 1, restarts: 1, maxIter: 1, mrlDims: 128 },
  outputHash: { "similar.json": zero },
});
const store = loadStore(dir);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe("similar_cards", () => {
  it("labels the edge and lists neighbours with cosine", () => {
    const out = body(similarCardsHandler(store, { cardKey: "0101033" }));
    expect(out.edge).toBe("similar");
    expect(out.neighbours.map((n: { cardKey: string }) => n.cardKey)).toEqual(["0101074", "04010001"]);
    expect(out.neighbours[0].cosine).toBe(0.81);
    expect(out.cluster).toBe(0);
  });

  it("honours limit and reports unknown or textless cards as errors", () => {
    expect(body(similarCardsHandler(store, { cardKey: "0101033", limit: 1 })).found).toBe(1);
    expect(similarCardsHandler(store, { cardKey: "nope" }).isError).toBe(true);
    expect(similarCardsHandler(store, { cardKey: "0101030" }).isError).toBe(true);
  });
});

describe("kin_cards", () => {
  it("is a separate edge type", () => {
    const out = body(kinCardsHandler(store, { cardKey: "0101033" }));
    expect(out.edge).toBe("kin");
    expect(out.neighbours[0].cardKey).toBe("09010218");
  });
});

describe("cluster", () => {
  it("answers by cardKey and by clusterId", () => {
    const byCard = body(clusterHandler(store, { cardKey: "09010218" }));
    expect(byCard.clusterId).toBe(1);
    const byId = body(clusterHandler(store, { clusterId: 0 }));
    expect(byId.label).toBe("word:damage(100%)");
    expect(byId.members.map((m: { cardKey: string }) => m.cardKey)).toEqual(["0101033", "0101074"]);
  });

  it("rejects missing or unknown references", () => {
    expect(clusterHandler(store, {}).isError).toBe(true);
    expect(clusterHandler(store, { clusterId: 9 }).isError).toBe(true);
  });
});

describe("without a similarity run", () => {
  it("returns a tool error naming the command to run", () => {
    const result = similarCardsHandler(loadStore(fixtures), { cardKey: "0101033" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pnpm similarity");
  });
});
