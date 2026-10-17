import { createHash } from "node:crypto";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Seeded Jaccard deck clustering
 * @strategicPurpose Splits the decks of one leader and base aspect into archetypes by the cards they share, so two
 * builds of the same leader that play differently are reported apart (LampaGJ/swu-mcp#25).
 * @tacticalObjective Leader clustering in a seeded hash order, then a fixed number of reassignment rounds against
 * weighted cores, then small clusters merged into their nearest large one. Pure and deterministic: the order comes
 * from sha256(seed, deck key), never from Math.random, and every tie breaks on index or code point.
 */

export interface ClusterDeck {
  key: string;
  cards: readonly string[];
  weight: number;
}

export interface ClusterOptions {
  seed: string;
  joinJaccard: number;
  coreInclusion: number;
  minDecks: number;
  rounds: number;
}

export interface Cluster {
  members: number[];
  core: string[];
  cohesion: number;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let both = 0;
  for (const x of a) if (b.has(x)) both += 1;
  return both / (a.size + b.size - both);
}

const seededKey = (seed: string, key: string): string => createHash("sha256").update(`${seed}\u0000${key}`, "utf8").digest("hex");

/** Cards held by at least `share` of the members' weight, in code-point order; the heaviest member's cards when none are. */
export function coreOf(decks: readonly ClusterDeck[], members: readonly number[], share: number): string[] {
  const total = members.reduce((s, i) => s + decks[i].weight, 0);
  const held = new Map<string, number>();
  for (const i of members) for (const c of decks[i].cards) held.set(c, (held.get(c) ?? 0) + decks[i].weight);
  const core = [...held].filter(([, w]) => w >= share * total - 1e-9).map(([c]) => c);
  if (core.length > 0) return core.sort(compareCodePoints);
  const heaviest = [...members].sort((x, y) => decks[y].weight - decks[x].weight || x - y)[0];
  return [...decks[heaviest].cards].sort(compareCodePoints);
}

function nearest(set: ReadonlySet<string>, cores: readonly ReadonlySet<string>[]): { index: number; score: number } {
  let index = -1;
  let score = -1;
  cores.forEach((core, i) => {
    const s = jaccard(set, core);
    if (s > score) {
      score = s;
      index = i;
    }
  });
  return { index, score };
}

/** Clusters of deck indexes; decks in clusters below minDecks with no large cluster to join are left out. */
export function clusterDecks(decks: readonly ClusterDeck[], options: ClusterOptions): Cluster[] {
  if (decks.length === 0) return [];
  const sets = decks.map((d) => new Set(d.cards));
  const order = decks.map((d, i) => ({ i, k: seededKey(options.seed, d.key) })).sort((a, b) => compareCodePoints(a.k, b.k) || a.i - b.i);

  let cores: Set<string>[] = [];
  let assign = new Array<number>(decks.length).fill(-1);
  for (const { i } of order) {
    const hit = nearest(sets[i], cores);
    if (hit.index >= 0 && hit.score >= options.joinJaccard) assign[i] = hit.index;
    else {
      cores.push(new Set(sets[i]));
      assign[i] = cores.length - 1;
    }
  }

  const membersOf = (a: readonly number[], k: number): number[][] => {
    const out: number[][] = Array.from({ length: k }, () => []);
    a.forEach((c, i) => {
      if (c >= 0) out[c].push(i);
    });
    return out;
  };

  for (let round = 0; round < options.rounds; round++) {
    const groups = membersOf(assign, cores.length).filter((m) => m.length > 0);
    cores = groups.map((m) => new Set(coreOf(decks, m, options.coreInclusion)));
    const next = decks.map((_, i) => nearest(sets[i], cores).index);
    const same = next.every((c, i) => c === assign[i]) && groups.length === cores.length;
    assign = next;
    if (same) break;
  }

  let groups = membersOf(assign, cores.length).filter((m) => m.length > 0);
  const large = groups.filter((m) => m.length >= options.minDecks);
  if (large.length === 0) {
    groups = decks.length >= options.minDecks ? [decks.map((_, i) => i)] : [];
  } else if (large.length < groups.length) {
    const largeCores = large.map((m) => new Set(coreOf(decks, m, options.coreInclusion)));
    const merged = large.map((m) => [...m]);
    for (const small of groups.filter((m) => m.length < options.minDecks)) {
      for (const i of small) merged[nearest(sets[i], largeCores).index].push(i);
    }
    groups = merged.map((m) => m.sort((a, b) => a - b));
  }

  return groups
    .map((members) => {
      const core = coreOf(decks, members, options.coreInclusion);
      const coreSet = new Set(core);
      const total = members.reduce((s, i) => s + decks[i].weight, 0);
      const cohesion = members.reduce((s, i) => s + decks[i].weight * jaccard(sets[i], coreSet), 0) / total;
      return { members, core, cohesion };
    })
    .sort((x, y) => y.members.length - x.members.length || x.members[0] - y.members[0]);
}
