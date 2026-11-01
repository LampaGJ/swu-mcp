import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CardStore } from "../../src/data.js";
import type { AttackPatterns, AttackerRow } from "../../src/play/attack-patterns.js";
import { attackPatterns } from "../../src/tools/play.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const row = (cardKey: string, attacks: number): AttackerRow => ({
  cardKey,
  title: "Printed " + cardKey,
  attacks,
  games: 2,
  gameShare: 0.5,
  attacksPerGame: attacks / 2,
  targets: { base: 1, units: attacks - 1, unresolvedUnits: 0, baseShare: 1 / attacks },
  topTargets: [{ cardKey: "C3", title: "Printed C3", attacks: attacks - 1, share: (attacks - 1) / attacks }],
  results: { measured: attacks, unitAttacks: attacks - 1, targetDefeated: 1, attackerDefeated: 0, both: 0, neither: attacks - 2, meanDamageToTarget: 2, baseAttacks: 1, meanBaseDamage: 3 },
  sideResult: { sides: 2, wins: 1, winShare: 0.5, low: 0.09, high: 0.91 },
});

const product: AttackPatterns = {
  schemaVersion: 1,
  populations: [
    { method: "human play", tier: "casual online games", label: "Human play: synthetic", window: { from: "2026-01-01", to: "2026-01-02" }, games: 4, attacks: 9, unresolvedAttackers: 1, unresolvedTargets: 0, measuredAttacks: 8, attackers: [row("C1", 5), row("C2", 3)], notes: ["casual"] },
    { method: "computer play", tier: "bot simulations", label: "Computer play: synthetic", window: null, games: 2, attacks: 4, unresolvedAttackers: 0, unresolvedTargets: 0, measuredAttacks: 4, attackers: [row("C2", 4)], notes: [] },
  ],
  build: { inputHash: "0".repeat(64), codeCommit: "abc1234" },
};

const store = { cards: [{ cardKey: "C1", title: "One" }, { cardKey: "C2", title: "Two", subtitle: "Second" }, { cardKey: "C3", title: "Three" }] } as unknown as CardStore;

function fileWith(p: AttackPatterns): string {
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? "tmp", "attack-tool-"));
  const file = path.join(dir, "attack-patterns.json");
  writeFileSync(file, JSON.stringify(p));
  return file;
}

describe("attack_patterns", () => {
  it("lists both populations side by side, labelled by method and tier, with card titles", () => {
    const res = attackPatterns(store, { limit: 10 }, fileWith(product));
    expect(res.isError).toBeUndefined();
    const text = res.content[0].text;
    expect(text).toContain("human play");
    expect(text).toContain("computer play");
    expect(text).toContain("casual online games");
    expect(text).toContain("bot simulations");
    expect(text).toContain("Two, Second");
    expect(text).toContain("Three");
  });

  it("narrows to one card and one method", () => {
    const text = attackPatterns(store, { cardKey: "C2", method: "computer play" }, fileWith(product)).content[0].text;
    expect(text).toContain("Two, Second");
    expect(text).not.toContain("human play");
    expect(text).not.toContain("One");
  });

  it("says so when the card is not among a population's top attackers", () => {
    const text = attackPatterns(store, { cardKey: "C1", method: "computer play" }, fileWith(product)).content[0].text;
    expect(text).toMatch(/not among/);
  });

  it("fails plainly when no product is built", () => {
    const res = attackPatterns(store, {}, path.join(REPO, "tmp", "no-such-attack-patterns.json"));
    expect(res.isError).toBe(true);
  });

  it("never names the human-play source (D102)", () => {
    const text = attackPatterns(store, {}, fileWith(product)).content[0].text.toLowerCase();
    expect(text).not.toContain("karabast");
  });
});

describe("attack_patterns reads only its data product (D102, D104)", () => {
  /** The same closure walk as tests/meta/no-karabast.test.ts. */
  const KARABAST_READ = /originals\/karabast|karabast-human|humanGame|extract-games|extract-decisions|human-priors\/decisions|games-\[0-9a-f\]|\.jsonl\.gz/i;
  function importClosure(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [path.join(REPO, entry)];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const m of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const spec = path.resolve(path.dirname(file), m[1]);
        const hit = [spec.replace(/\.js$/, ".ts"), spec].find((c) => existsSync(c) && /\.(ts|mjs)$/.test(c));
        if (hit !== undefined) queue.push(hit);
      }
    }
    return [...seen].map((f) => path.relative(REPO, f)).sort();
  }

  it("src/tools/play.ts and everything it imports never read the raw rows or the decision extracts", () => {
    const closure = importClosure("src/tools/play.ts");
    expect(closure.length).toBeGreaterThan(2);
    expect(closure.filter((f) => f.startsWith("scripts/"))).toEqual([]);
    expect(closure.filter((f) => KARABAST_READ.test(readFileSync(path.join(REPO, f), "utf8")))).toEqual([]);
  });

  it("the guard pattern does catch the build step that reads the extracts, so a zero above is a real zero", () => {
    expect(KARABAST_READ.test(readFileSync(path.join(REPO, "scripts/human-priors/attack-patterns.ts"), "utf8"))).toBe(true);
  });
});
