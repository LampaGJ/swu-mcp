import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore } from "../src/data.js";
import { labelClusters } from "../src/embed/labels.js";
import {
  dequantiseInt8,
  fromBase64Url,
  kmeans,
  mulberry32,
  neighboursOf,
  quantiseInt8,
  roundHalfEven,
  toBase64Url,
  unitRows,
} from "../src/embed/math.js";
import { bytesToFloats, floatsToBytes, loadCapture } from "../src/embed/pinned.js";
import { hashTexts, inputHashOf, parseRenderCards, renderAll, RENDER_VERSION } from "../src/embed/render.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const cards = parseRenderCards(loadStore(fixtures).cards);
const rendered = renderAll(cards);
const at = (key: string): number => rendered.keys.indexOf(key);

describe("renderings", () => {
  it("is versioned and keyed in card order", () => {
    expect(RENDER_VERSION).toBe(1);
    expect(rendered.keys).toHaveLength(9);
  });

  it("ability puts keywords first and keeps card text verbatim", () => {
    expect(rendered.ability[at("0101033")]).toBe(
      "When Played: Deal 2 damage to a friendly ground unit and 2 damage to an enemy ground unit.",
    );
    expect(rendered.ability[at("0101070")]).toBe(
      "Keywords: Restore. Attached unit gains Restore 2. (When this unit attacks, heal 2 damage from its controller's base.)",
    );
  });

  it("falls back to a type sentence for a card with no text", () => {
    expect(rendered.ability[at("0101030")]).toBe("Base with no ability text.");
    expect(rendered.abstract[at("0101030")]).toBe("Base with no ability text.");
  });

  it("abstract masks arenas and numbers", () => {
    expect(rendered.abstract[at("0101033")]).toBe(
      "When Played: Deal N damage to a friendly ARENA unit and N damage to an enemy ARENA unit.",
    );
    expect(rendered.abstract[at("0101074")]).toBe("Heal N damage from a unit or base.");
  });

  it("abstract drops reminder text and masks keywords and traits", () => {
    expect(rendered.abstract[at("0101070")]).toBe("Attached unit gains KEYWORD N.");
    expect(rendered.abstract[at("0101165")]).toBe("KEYWORD");
    expect(rendered.abstract[at("04010087")]).toBe("KEYWORD When Played/When Defeated: Create a TIE TRAIT token.");
  });

  it("hashes are stable and sensitive to the text", () => {
    expect(inputHashOf(rendered)).toEqual(inputHashOf(renderAll(cards)));
    expect(hashTexts(["a", "b"])).not.toBe(hashTexts(["a", "c"]));
    expect(inputHashOf(rendered).inputHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

function fixtureVectors(rows: number, dims: number, seed: number): Float32Array {
  const random = mulberry32(seed);
  return Float32Array.from({ length: rows * dims }, () => random() - 0.5);
}

describe("cosine neighbours", () => {
  const rows = 12;
  const dims = 8;
  const unit = unitRows(fixtureVectors(rows, dims, 7), rows, dims);

  it("ranks best first, excludes the query and honours the filter", () => {
    const found = neighboursOf(unit, dims, rows, 0, (i) => i !== 3);
    expect(found).toHaveLength(rows - 2);
    expect(found.map((n) => n.index)).not.toContain(0);
    expect(found.map((n) => n.index)).not.toContain(3);
    for (let i = 1; i < found.length; i += 1) expect(found[i - 1].cosine).toBeGreaterThanOrEqual(found[i].cosine);
  });

  it("breaks exact ties on the lower index and repeats exactly", () => {
    const same = new Float32Array([1, 0, 1, 0, 1, 0]);
    const tied = neighboursOf(unitRows(same, 3, 2), 2, 3, 0, () => true);
    expect(tied.map((n) => n.index)).toEqual([1, 2]);
    expect(JSON.stringify(neighboursOf(unit, dims, rows, 5, () => true))).toBe(
      JSON.stringify(neighboursOf(unit, dims, rows, 5, () => true)),
    );
  });
});

describe("k-means", () => {
  const rows = 60;
  const dims = 4;
  const centres = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ];
  const random = mulberry32(3);
  const data = new Float64Array(rows * dims);
  for (let r = 0; r < rows; r += 1) for (let d = 0; d < dims; d += 1) data[r * dims + d] = centres[r % 3][d] + (random() - 0.5) * 0.1;
  const options = { k: 3, seed: 11, restarts: 3, maxIter: 50 };

  it("gives identical assignments for the same seed", () => {
    const a = kmeans(data, rows, dims, options);
    const b = kmeans(data, rows, dims, options);
    expect(Array.from(a.assign)).toEqual(Array.from(b.assign));
    expect(a.inertia).toBe(b.inertia);
  });

  it("recovers three planted groups", () => {
    const { assign } = kmeans(data, rows, dims, options);
    for (let r = 3; r < rows; r += 1) expect(assign[r]).toBe(assign[r % 3]);
    expect(new Set(Array.from(assign)).size).toBe(3);
  });

  it("the seeded generator repeats", () => {
    const a = mulberry32(5);
    const b = mulberry32(5);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe("int8 vectors", () => {
  const rows = 50;
  const dims = 32;
  const values = fixtureVectors(rows, dims, 21);

  it("round-trips a truncated, renormalised matrix within half a step (outside the clipped tail)", () => {
    const q = quantiseInt8(values, rows, dims, 16);
    const back = dequantiseInt8(q);
    const exact = unitRows(values, rows, dims, 16);
    let worst = 0;
    for (let i = 0; i < exact.length; i += 1)
      if (Math.abs(exact[i]) <= 127 * q.scale) worst = Math.max(worst, Math.abs(exact[i] - back[i]));
    expect(worst).toBeLessThanOrEqual(q.scale * 0.5 + 1e-12);
    expect(Math.max(...Array.from(q.rows, Math.abs))).toBeLessThanOrEqual(127);
  });

  it("survives base64url and keeps cosine close", () => {
    const q = quantiseInt8(values, rows, dims, 16);
    const row = new Uint8Array(q.rows.buffer, 0, 16);
    const text = toBase64Url(row);
    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(fromBase64Url(text))).toEqual(Array.from(q.rows.subarray(0, 16)));
    const back = dequantiseInt8(q);
    const exact = unitRows(values, rows, dims, 16);
    const dot = (a: Float64Array, b: Float64Array, x: number, y: number): number =>
      Array.from({ length: 16 }, (_, d) => a[x * 16 + d] * b[y * 16 + d]).reduce((s, v) => s + v, 0);
    expect(Math.abs(dot(exact, exact, 0, 1) - dot(back, back, 0, 1))).toBeLessThan(0.05);
  });

  it("rounds halves to even like numpy", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5].map(roundHalfEven)).toEqual([0, 2, 2, 0, -2]);
  });
});

describe("cluster labels", () => {
  it("counts shared features and respects the family cap", () => {
    const assign = cards.map((_, i) => (i % 2 === 0 ? 0 : 1));
    const labels = labelClusters(cards, assign, 2);
    expect(labels).toHaveLength(2);
    expect(labels).toEqual(labelClusters(cards, assign, 2));
  });
});

describe("pinned capture", () => {
  it("refuses a file whose bytes differ from replay.json", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "capture-"));
    try {
      const floats = new Float32Array([1, 2, 3, 4]);
      expect(Array.from(bytesToFloats(floatsToBytes(floats)))).toEqual([1, 2, 3, 4]);
      writeFileSync(path.join(dir, "index.json"), JSON.stringify({ renderVersion: 1, dims: 2, count: 2, layout: "x", keys: ["a", "b"] }));
      writeFileSync(path.join(dir, "ability.f32"), floatsToBytes(floats));
      writeFileSync(path.join(dir, "abstract.f32"), floatsToBytes(floats));
      const zero = "0".repeat(64);
      writeFileSync(
        path.join(dir, "replay.json"),
        JSON.stringify({
          model: "m",
          ollamaVersion: "1",
          ollamaDigest: zero,
          weightsBlobSha256: zero,
          prefix: "",
          endpoint: "/api/embed",
          batchSize: 1,
          renderVersion: 1,
          dims: 2,
          count: 2,
          inputHash: zero,
          inputHashes: { ability: zero, abstract: zero, keys: zero },
          outputHash: { "ability.f32": zero, "abstract.f32": zero },
        }),
      );
      expect(() => loadCapture(dir)).toThrow(/pins/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
