import { compareCodePoints } from "../swu/canonical.js";
import { roundHalfEven } from "./math.js";
import type { RenderCard } from "./render.js";

/**
 * @displayName Cluster labels
 * @strategicPurpose Names each k-means cluster by counting what its members share, never by asking a model.
 * @tacticalObjective Ports the bake-off method (scripts/embed/cluster.py): a feature is over-represented in a
 * cluster when at least 3 members and at least 30% of them carry it and it is more common there than overall;
 * features rank by coverage x log2(lift), at most 2 per family, at most 5 per label.
 */

const STOP = new Set(
  "a an the of to or and in on is if you your this that it its for with from at by as be are was can may then each other another".split(
    " ",
  ),
);

const cell = (value: string | null | undefined): string[] => (value ?? "").split("|").filter((part) => part !== "");

interface Feature {
  family: string;
  value: string;
}

const featureKey = (f: Feature): string => `${f.family}\u0000${f.value}`;

function featuresOf(card: RenderCard & { arenas?: string | null }): Map<string, Feature> {
  const out = new Map<string, Feature>();
  const add = (family: string, value: string): void => {
    out.set(featureKey({ family, value }), { family, value });
  };
  add("type", card.type);
  for (const a of cell(card.arenas)) add("arena", a);
  for (const [field, family] of [
    ["aspects", "aspect"],
    ["keywords", "kw"],
    ["traits", "trait"],
  ] as const)
    for (const v of cell(card[field])) add(family, v);
  const text = [card.text, card.deployBox, card.epicAction]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" ")
    .toLowerCase();
  for (const word of new Set(text.match(/[a-z]{4,}/g) ?? [])) if (!STOP.has(word)) add("word", word);
  return out;
}

export function labelClusters(cards: readonly RenderCard[], assign: ArrayLike<number>, k: number): string[] {
  const features = cards.map(featuresOf);
  const global = new Map<string, number>();
  for (const f of features) for (const key of f.keys()) global.set(key, (global.get(key) ?? 0) + 1);
  const labels: string[] = [];
  for (let cluster = 0; cluster < k; cluster += 1) {
    const members = features.filter((_, i) => assign[i] === cluster);
    const counts = new Map<string, { feature: Feature; n: number }>();
    for (const f of members) {
      for (const [key, feature] of f) {
        const hit = counts.get(key);
        if (hit === undefined) counts.set(key, { feature, n: 1 });
        else hit.n += 1;
      }
    }
    const scored: { score: number; feature: Feature; p: number }[] = [];
    for (const [key, { feature, n }] of counts) {
      const p = n / members.length;
      const q = (global.get(key) ?? 0) / cards.length;
      if (n >= 3 && p >= 0.3 && p > q) scored.push({ score: p * Math.log2(p / q), feature, p });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score || compareCodePoints(a.feature.family, b.feature.family) || compareCodePoints(a.feature.value, b.feature.value),
    );
    const perFamily = new Map<string, number>();
    const chosen: string[] = [];
    for (const { feature, p } of scored) {
      if ((perFamily.get(feature.family) ?? 0) >= 2) continue;
      perFamily.set(feature.family, (perFamily.get(feature.family) ?? 0) + 1);
      chosen.push(`${feature.family}:${feature.value}(${roundHalfEven(p * 100)}%)`);
      if (chosen.length === 5) break;
    }
    labels.push(chosen.join(" "));
  }
  return labels;
}
