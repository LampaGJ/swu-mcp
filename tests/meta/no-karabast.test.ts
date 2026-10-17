import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SWUMETASTATS_SOURCE, winRatesFileSchema } from "../../src/meta/schema.js";

/**
 * Decision D22 (owner ruling 2026-10-17): Karabast-derived numbers, aggregates included, never ship in the data
 * release (meta/ is a SERVER_DIRS directory) or in tool output. These tests fail if the meta step or the meta tools
 * can reach Karabast data, or if winrates.json can carry a non-swumetastats source.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Code-level references to the private Karabast extract and its readers; a comment naming D22 does not match. */
const KARABAST_READ = /originals\/karabast|karabast-human|humanGame|extract-games|games-\[0-9a-f\]|\.jsonl\.gz/i;

/** Every repo file reachable from an entry by relative static imports. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [path.join(REPO, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const spec = path.resolve(path.dirname(file), m[1]);
      const candidates = [spec.replace(/\.js$/, ".ts"), spec.replace(/\.mjs$/, ".mjs"), spec];
      const hit = candidates.find((c) => existsSync(c) && /\.(ts|mjs)$/.test(c));
      if (hit !== undefined) queue.push(hit);
    }
  }
  return [...seen].map((f) => path.relative(REPO, f)).sort();
}

describe("no Karabast number can ship (D22)", () => {
  it.each(["scripts/meta.ts", "src/tools/meta.ts"])("%s and everything it imports never read Karabast data", (entry) => {
    const closure = importClosure(entry);
    expect(closure.length).toBeGreaterThan(3);
    expect(closure.filter((f) => f.startsWith("scripts/bench/") && !/card-map|code-commit/.test(f))).toEqual([]);
    const offenders = closure.filter((f) => KARABAST_READ.test(readFileSync(path.join(REPO, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the guard pattern does catch the benchmark that reads Karabast, so a zero above is a real zero", () => {
    expect(KARABAST_READ.test(readFileSync(path.join(REPO, "scripts/bench/meta-defense.ts"), "utf8"))).toBe(true);
  });

  it("winrates.json's schema names swumetastats as its only source and no karabast value anywhere", () => {
    const json = JSON.stringify(z.toJSONSchema(winRatesFileSchema));
    expect(json.toLowerCase()).not.toContain("karabast");
    expect(json).toContain(SWUMETASTATS_SOURCE);
  });

  it("winrates.json rejects a Karabast source and the old card-outcome block", () => {
    const base = { schemaVersion: 2, minN: 10, matchups: null, deckEvidence: null };
    expect(winRatesFileSchema.safeParse(base).success).toBe(true);
    const evidence = {
      source: "karabast-human",
      label: "x",
      basis: "x",
      opponents: "x",
      window: { from: "2026-01-01", to: "2026-02-10" },
      decks: 1,
      events: 1,
      matches: 1,
      groups: [],
    };
    expect(winRatesFileSchema.safeParse({ ...base, deckEvidence: evidence }).success).toBe(false);
    expect(winRatesFileSchema.safeParse({ ...base, cards: [{ source: "karabast-human", byLeader: [] }] }).success).toBe(false);
    expect(winRatesFileSchema.safeParse({ ...base, schemaVersion: 1 }).success).toBe(false);
  });
});
