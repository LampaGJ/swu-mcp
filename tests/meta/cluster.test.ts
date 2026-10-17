import { describe, expect, it } from "vitest";
import { clusterDecks, coreOf, jaccard, type ClusterDeck } from "../../src/meta/cluster.js";
import { compareCodePoints } from "../../src/swu/canonical.js";

const OPTIONS = { seed: "test", joinJaccard: 0.4, coreInclusion: 0.5, minDecks: 3, rounds: 8 };

const range = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function family(prefix: string, count: number, core: string[], flex: string[]): ClusterDeck[] {
  return Array.from({ length: count }, (_, i) => ({ key: `${prefix}-${i}`, cards: [...core, flex[i % flex.length]], weight: 1 }));
}

describe("jaccard", () => {
  it("is intersection over union", () => {
    expect(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(0.5);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe("coreOf", () => {
  it("keeps cards held by at least half the member weight", () => {
    const decks: ClusterDeck[] = [
      { key: "a", cards: ["x", "y"], weight: 2 },
      { key: "b", cards: ["x", "z"], weight: 1 },
    ];
    expect(coreOf(decks, [0, 1], 0.5)).toEqual(["x", "y"]);
  });
});

describe("clusterDecks", () => {
  const aggro = family("aggro", 8, range("a", 12), ["fa", "fb"]);
  const control = family("control", 6, range("c", 12), ["fc"]);
  const stray: ClusterDeck[] = [{ key: "stray", cards: [...range("a", 9), ...range("s", 4)], weight: 1 }];
  const decks = [...aggro, ...control, ...stray];

  it("separates two builds of one leader and merges a lone stray into its nearest cluster", () => {
    const clusters = clusterDecks(decks, OPTIONS);
    expect(clusters).toHaveLength(2);
    const [big, small] = clusters;
    expect(big.members.map((i) => decks[i].key).filter((k) => k.startsWith("control"))).toEqual([]);
    expect(big.members.map((i) => decks[i].key)).toContain("stray");
    expect(small.members).toHaveLength(6);
    expect(big.core).toEqual(range("a", 12).sort(compareCodePoints));
  });

  it("is deterministic for a seed and independent of input order", () => {
    const keysOf = (input: ClusterDeck[]) =>
      clusterDecks(input, OPTIONS)
        .map((c) => c.members.map((i) => input[i].key).sort(compareCodePoints))
        .sort((x, y) => compareCodePoints(x[0], y[0]));
    expect(keysOf(decks)).toEqual(keysOf([...decks].reverse()));
  });

  it("drops everything when the group is smaller than minDecks", () => {
    expect(clusterDecks(control.slice(0, 2), OPTIONS)).toEqual([]);
  });
});
