import { createHash } from "node:crypto";
import { mulberry32 } from "../embed/math.js";
import { compareCodePoints } from "../swu/canonical.js";
import { SLEEPER_VERDICTS, type SleeperEstimate, type SleeperRow, type SleeperScope } from "./sleepers-schema.js";

/**
 * @displayName Sleeper-card analysis
 * @strategicPurpose Finds cards that win more than their play rate suggests, and cards whose edge grows with the
 * player's skill (LampaGJ/swu-mcp#184), with honest intervals and false-discovery control, from public tournament
 * decklists with whole-event match records.
 * @tacticalObjective Pure and deterministic. Per card and scope, the match win rate of decks with the card minus
 * comparable decks without it (same meta period, leader and base aspects), pooled with Mantel-Haenszel-style
 * weights; standard errors from a seeded bootstrap that resamples whole events; two-sided normal p; BH and BY
 * q-values per family. Skill is a player's shrunken excess win rate in their other events (leave-one-event-out);
 * the interaction is the gap among the strongest third minus the weakest third. A within-player comparison
 * (bootstrap over players) and a within-build-style comparison guard against selection. A label-shuffle run checks
 * the false-discovery machinery finds nothing where nothing exists. Statistics are short closed formulas kept here
 * with tests, as scripts/bench/stats.ts does, instead of a statistics library.
 */

export interface SleeperDeck {
  event: string;
  period: string;
  leader: string;
  baseAspects: readonly string[];
  /** Leader and base aspect icons, sorted. */
  aspects: readonly string[];
  /** Opaque player key, held in memory only; never written out. */
  player: string | null;
  wins: number;
  losses: number;
  draws: number;
  /** Distinct main-deck cardKeys. */
  cards: readonly string[];
  /** Build-style (archetype cluster) label inside the deck's period, leader and base aspects; null when unclustered. */
  style: string | null;
}

export interface SleeperOptions {
  replicates: number;
  nullReplicates: number;
  seed: string;
  q: number;
  minDecks: number;
  minEvents: number;
  minTierDecks: number;
  minPlayers: number;
  /** Fewest decisive matches in a player's other events before a skill estimate is made. */
  skillMinMatches: number;
  /** A card played in at least this share of its comparable decks is common, not a sleeper. */
  commonPlayRate: number;
  /** Name and rotation status per cardKey; defaults to the key itself and not rotated. */
  cardInfo?: (cardKey: string) => { title: string; rotated: boolean };
  onProgress?: (phase: string, done: number, total: number) => void;
}

export const DEFAULT_SLEEPER_OPTIONS: SleeperOptions = {
  replicates: 400,
  nullReplicates: 200,
  seed: "sleepers-v1",
  q: 0.1,
  minDecks: 20,
  minEvents: 5,
  minTierDecks: 10,
  minPlayers: 10,
  skillMinMatches: 3,
  commonPlayRate: 0.5,
};

const Z95 = 1.959964;

/** The repo's seeded generator (scripts/bench/stats.ts seededRandom): sha256 of the label seeds mulberry32. */
const seededRandom = (seed: string): (() => number) => mulberry32(createHash("sha256").update(seed, "utf8").digest().readUInt32BE(0));

/** Two-sided normal p, erfc(|z| / sqrt 2) by Abramowitz and Stegun 7.1.26 computed directly so small p keeps its digits. */
export function twoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return Math.min(1, Math.max(0, poly * Math.exp(-x * x)));
}

/** Step-up q-values: Benjamini-Hochberg (scale 1) or Benjamini-Yekutieli (scale = harmonic sum of m). */
export function stepUpQ(pValues: readonly number[], method: "BH" | "BY"): number[] {
  const m = pValues.length;
  if (m === 0) return [];
  let scale = 1;
  if (method === "BY") {
    scale = 0;
    for (let i = 1; i <= m; i++) scale += 1 / i;
  }
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p || a.i - b.i);
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank--) {
    const { p, i } = order[rank - 1];
    running = Math.min(running, (p * m * scale) / rank);
    q[i] = Math.min(1, running);
  }
  return q;
}

class Ids {
  readonly map = new Map<string, number>();
  readonly keys: string[] = [];
  id(key: string): number {
    let i = this.map.get(key);
    if (i === undefined) {
      i = this.keys.length;
      this.map.set(key, i);
      this.keys.push(key);
    }
    return i;
  }
}

/** Decisive-match tallies per (stratum, event) and per (card, stratum, event), laid out for fast re-weighting. */
interface Tally {
  strata: number;
  sDecks: Int32Array;
  sStart: Int32Array;
  sEvent: Int32Array;
  sW: Float64Array;
  sN: Float64Array;
  pairCard: Int32Array;
  pairStratum: Int32Array;
  pairDecks: Int32Array;
  pStart: Int32Array;
  pEvent: Int32Array;
  pW: Float64Array;
  pN: Float64Array;
  pairOf: Map<number, number>;
}

function buildTally(
  decks: readonly SleeperDeck[],
  stratumOf: readonly number[],
  cardIds: readonly (readonly number[])[],
  eventOf: readonly number[],
  keep: (i: number) => boolean,
  strata: number,
  events: number,
): Tally {
  const sCells = new Map<number, [number, number]>();
  const sDecks = new Int32Array(strata);
  const pCells = new Map<number, [number, number]>();
  const pairDeckCount = new Map<number, number>();
  decks.forEach((d, i) => {
    if (!keep(i)) return;
    const s = stratumOf[i];
    if (s < 0) return;
    const e = eventOf[i];
    sDecks[s] += 1;
    const sk = s * events + e;
    const sc = sCells.get(sk) ?? [0, 0];
    sc[0] += d.wins;
    sc[1] += d.wins + d.losses;
    sCells.set(sk, sc);
    for (const c of cardIds[i]) {
      const pair = c * strata + s;
      pairDeckCount.set(pair, (pairDeckCount.get(pair) ?? 0) + 1);
      const pk = pair * events + e;
      const pc = pCells.get(pk) ?? [0, 0];
      pc[0] += d.wins;
      pc[1] += d.wins + d.losses;
      pCells.set(pk, pc);
    }
  });
  const sKeys = [...sCells.keys()].sort((a, b) => a - b);
  const sStart = new Int32Array(strata + 1);
  const sEvent = new Int32Array(sKeys.length);
  const sW = new Float64Array(sKeys.length);
  const sN = new Float64Array(sKeys.length);
  sKeys.forEach((k, j) => {
    const s = Math.floor(k / events);
    sStart[s + 1] += 1;
    sEvent[j] = k - s * events;
    const [w, n] = sCells.get(k) as [number, number];
    sW[j] = w;
    sN[j] = n;
  });
  for (let s = 0; s < strata; s++) sStart[s + 1] += sStart[s];

  const pairs = [...pairDeckCount.keys()].sort((a, b) => a - b);
  const pairOf = new Map<number, number>(pairs.map((p, j) => [p, j]));
  const pKeys = [...pCells.keys()].sort((a, b) => a - b);
  const pStart = new Int32Array(pairs.length + 1);
  const pEvent = new Int32Array(pKeys.length);
  const pW = new Float64Array(pKeys.length);
  const pN = new Float64Array(pKeys.length);
  pKeys.forEach((k, j) => {
    const pair = Math.floor(k / events);
    const pj = pairOf.get(pair) as number;
    pStart[pj + 1] += 1;
    pEvent[j] = k - pair * events;
    const [w, n] = pCells.get(k) as [number, number];
    pW[j] = w;
    pN[j] = n;
  });
  for (let j = 0; j < pairs.length; j++) pStart[j + 1] += pStart[j];
  return {
    strata,
    sDecks,
    sStart,
    sEvent,
    sW,
    sN,
    pairCard: Int32Array.from(pairs, (p) => Math.floor(p / strata)),
    pairStratum: Int32Array.from(pairs, (p) => p % strata),
    pairDecks: Int32Array.from(pairs, (p) => pairDeckCount.get(p) as number),
    pStart,
    pEvent,
    pW,
    pN,
    pairOf,
  };
}

interface Weighted {
  TW: Float64Array;
  TN: Float64Array;
  PW: Float64Array;
  PN: Float64Array;
}

function weigh(t: Tally, k: Float64Array | null): Weighted {
  const TW = new Float64Array(t.strata);
  const TN = new Float64Array(t.strata);
  for (let s = 0; s < t.strata; s++) {
    let w = 0;
    let n = 0;
    for (let j = t.sStart[s]; j < t.sStart[s + 1]; j++) {
      const m = k === null ? 1 : k[t.sEvent[j]];
      w += m * t.sW[j];
      n += m * t.sN[j];
    }
    TW[s] = w;
    TN[s] = n;
  }
  const P = t.pairCard.length;
  const PW = new Float64Array(P);
  const PN = new Float64Array(P);
  for (let p = 0; p < P; p++) {
    let w = 0;
    let n = 0;
    for (let j = t.pStart[p]; j < t.pStart[p + 1]; j++) {
      const m = k === null ? 1 : k[t.pEvent[j]];
      w += m * t.pW[j];
      n += m * t.pN[j];
    }
    PW[p] = w;
    PN[p] = n;
  }
  return { TW, TN, PW, PN };
}

/** Pooled with-minus-without win rate over the given pairs; weights n_with n_without / (n_with + n_without). */
function pooledGap(t: Tally, w: Weighted, pairs: readonly number[]): number | null {
  let num = 0;
  let den = 0;
  for (const p of pairs) {
    const s = t.pairStratum[p];
    const nw = w.PN[p];
    const no = w.TN[s] - nw;
    if (nw <= 0 || no <= 0) continue;
    const gap = w.PW[p] / nw - (w.TW[s] - w.PW[p]) / no;
    const weight = (nw * no) / (nw + no);
    num += weight * gap;
    den += weight;
  }
  return den > 0 ? num / den : null;
}

class Moments {
  n = 0;
  sum = 0;
  sumSq = 0;
  add(x: number | null): void {
    if (x === null) return;
    this.n += 1;
    this.sum += x;
    this.sumSq += x * x;
  }
  sd(): number | null {
    if (this.n < 2) return null;
    const mean = this.sum / this.n;
    return Math.sqrt(Math.max(0, (this.sumSq - this.n * mean * mean) / (this.n - 1)));
  }
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const sig4 = (x: number): number => (x === 0 ? 0 : Number(x.toPrecision(4)));

function multinomial(random: () => number, size: number): Float64Array {
  const k = new Float64Array(size);
  for (let i = 0; i < size; i++) k[Math.min(size - 1, Math.floor(random() * size))] += 1;
  return k;
}

interface RowPlan {
  card: number;
  pairs: number[];
  decksWith: number;
  decksWithout: number;
  eventsWith: number;
  effectiveEvents: number;
  matchesWith: number;
  matchesWithout: number;
  latestPeriod: string;
  tierPairs: { strong: number[]; weak: number[]; decksStrong: number; decksWeak: number } | null;
  stylePairs: number[] | null;
  playerGroups: number[] | null;
}

interface ScopeDef {
  key: string;
  leader: string | null;
  baseAspects: string[] | null;
  aspects: string[];
  strata: Set<number>;
}

interface PlayerGroup {
  player: number;
  wW: number;
  nW: number;
  wO: number;
  nO: number;
}

export interface SleeperAnalysis {
  counts: { decks: number; events: number; players: number; decksWithSkill: number; strata: number; styles: number };
  skill: { priorMatches: number; betweenPlayerSd: number; tierCuts: [number, number] };
  nullCheck: { method: string; replicates: number; rows: number; passBH: number; passBY: number; minP: number | null };
  global: SleeperRow[];
  aspects: SleeperScope[];
  archetypes: SleeperScope[];
}

/** Leave-one-event-out skill: the player's excess wins over their stratum's match win rate in other events, shrunk. */
function skills(
  decks: readonly SleeperDeck[],
  stratumOf: readonly number[],
  eventOf: readonly number[],
  rate: Float64Array,
  minMatches: number,
): { skill: (number | null)[]; priorMatches: number; betweenSd: number } {
  const byPlayer = new Map<string, Map<number, { x: number; n: number }>>();
  decks.forEach((d, i) => {
    if (d.player === null) return;
    const n = d.wins + d.losses;
    const ev = byPlayer.get(d.player) ?? new Map<number, { x: number; n: number }>();
    const cur = ev.get(eventOf[i]) ?? { x: 0, n: 0 };
    cur.x += d.wins - n * rate[stratumOf[i]];
    cur.n += n;
    ev.set(eventOf[i], cur);
    byPlayer.set(d.player, ev);
  });
  const totals = new Map<string, { x: number; n: number }>();
  for (const [player, ev] of byPlayer) {
    let x = 0;
    let n = 0;
    for (const v of ev.values()) {
      x += v.x;
      n += v.n;
    }
    totals.set(player, { x, n });
  }
  // Between-player variance from the covariance of one player's per-match excess at two different events: event
  // noise is independent across events, and dropping out after early losses (which shrinks single-event spread)
  // cannot fake it. Each pair weighs n1 n2 / (n1 + n2).
  let num = 0;
  let den = 0;
  for (const player of [...byPlayer.keys()].sort(compareCodePoints)) {
    const ev = [...(byPlayer.get(player) as Map<number, { x: number; n: number }>).entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, v]) => v.n > 0);
    for (let a = 0; a < ev.length; a++)
      for (let b = a + 1; b < ev.length; b++) {
        const [, u] = ev[a];
        const [, v] = ev[b];
        const w = (u.n * v.n) / (u.n + v.n);
        num += w * (u.x / u.n) * (v.x / v.n);
        den += w;
      }
  }
  const tau2 = den > 0 ? num / den : 0;
  // With no measurable spread, skill carries no information: a huge prior shrinks every estimate to 0.
  const priorMatches = tau2 > 1e-6 ? 0.25 / tau2 : 1e6;
  const betweenSd = Math.sqrt(Math.max(tau2, 0));
  const skill = decks.map((d, i) => {
    if (d.player === null) return null;
    const total = totals.get(d.player) as { x: number; n: number };
    const own = byPlayer.get(d.player)?.get(eventOf[i]) ?? { x: 0, n: 0 };
    const n = total.n - own.n;
    if (n < minMatches) return null;
    return (total.x - own.x) / (n + priorMatches);
  });
  return { skill, priorMatches, betweenSd };
}

function estimateOf(value: number, sd: number | null, p: number, qBH: number, qBY: number): SleeperEstimate {
  const se = sd ?? Number.POSITIVE_INFINITY;
  const half = Number.isFinite(se) ? Z95 * se : 1;
  return { value: r4(value), low: r4(value - half), high: r4(value + half), p: sig4(p), qBH: sig4(qBH), qBY: sig4(qBY) };
}

const pOf = (value: number, sd: number | null): number => (sd === null || sd === 0 ? (value === 0 ? 1 : 0) : twoSidedP(value / sd));

/** Everything the step writes except provenance and the simulator view. */
export function analyseSleepers(input: readonly SleeperDeck[], opts: SleeperOptions = DEFAULT_SLEEPER_OPTIONS): SleeperAnalysis {
  const decks = input;
  const events = new Ids();
  const cards = new Ids();
  const strataIds = new Ids();
  const styleIds = new Ids();
  const players = new Ids();
  const stratumInfo: { period: string; leader: string; baseAspects: string[]; aspects: string[] }[] = [];
  const eventOf: number[] = [];
  const stratumOf: number[] = [];
  const styleOf: number[] = [];
  const cardIds: number[][] = [];
  const playerOf: number[] = [];
  for (const d of decks) {
    eventOf.push(events.id(d.event));
    const key = `${d.period}\u0000${d.leader}\u0000${d.baseAspects.join("+")}`;
    const s = strataIds.id(key);
    if (stratumInfo.length <= s)
      stratumInfo.push({ period: d.period, leader: d.leader, baseAspects: [...d.baseAspects], aspects: [...d.aspects] });
    stratumOf.push(s);
    styleOf.push(d.style === null ? -1 : styleIds.id(`${key}\u0000${d.style}`));
    cardIds.push([...new Set(d.cards)].sort(compareCodePoints).map((c) => cards.id(c)));
    playerOf.push(d.player === null ? -1 : players.id(d.player));
  }
  const E = events.keys.length;
  const S = strataIds.keys.length;
  const all = buildTally(decks, stratumOf, cardIds, eventOf, () => true, S, E);
  const point = weigh(all, null);
  const rate = new Float64Array(S);
  for (let s = 0; s < S; s++) rate[s] = point.TN[s] > 0 ? point.TW[s] / point.TN[s] : 0.5;

  const { skill, priorMatches, betweenSd } = skills(decks, stratumOf, eventOf, rate, opts.skillMinMatches);
  const ranked = skill
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== null)
    .sort((a, b) => a.v - b.v || a.i - b.i);
  const tier = new Int8Array(decks.length);
  const third = Math.floor(ranked.length / 3);
  ranked.forEach((x, rank) => {
    if (rank < third) tier[x.i] = -1;
    else if (rank >= ranked.length - third) tier[x.i] = 1;
  });
  const tierCuts: [number, number] =
    ranked.length >= 3 ? [r4(ranked[third - 1]?.v ?? 0), r4(ranked[ranked.length - third]?.v ?? 0)] : [0, 0];
  const strong = buildTally(decks, stratumOf, cardIds, eventOf, (i) => tier[i] === 1, S, E);
  const weak = buildTally(decks, stratumOf, cardIds, eventOf, (i) => tier[i] === -1, S, E);
  const SS = styleIds.keys.length;
  const styled = buildTally(decks, styleOf, cardIds, eventOf, (i) => styleOf[i] >= 0, Math.max(SS, 1), E);

  const groupIds = new Ids();
  const groupDecks: number[][] = [];
  const groupPlayer: number[] = [];
  decks.forEach((d, i) => {
    if (playerOf[i] < 0) return;
    const g = groupIds.id(`${playerOf[i]}\u0000${d.leader}\u0000${d.baseAspects.join("+")}`);
    if (groupDecks.length <= g) {
      groupDecks.push([]);
      groupPlayer.push(playerOf[i]);
    }
    groupDecks[g].push(i);
  });
  const playerGroupsOf = new Map<number, PlayerGroup[]>();
  groupDecks.forEach((members, g) => {
    if (members.length < 2) return;
    const present = new Map<number, number>();
    for (const i of members) for (const c of cardIds[i]) present.set(c, (present.get(c) ?? 0) + 1);
    for (const [c, count] of [...present].sort((a, b) => a[0] - b[0])) {
      if (count === members.length) continue;
      const pg: PlayerGroup = { player: groupPlayer[g], wW: 0, nW: 0, wO: 0, nO: 0 };
      const has = (i: number): boolean => cardIds[i].includes(c);
      for (const i of members) {
        const d = decks[i];
        if (has(i)) {
          pg.wW += d.wins;
          pg.nW += d.wins + d.losses;
        } else {
          pg.wO += d.wins;
          pg.nO += d.wins + d.losses;
        }
      }
      if (pg.nW === 0 || pg.nO === 0) continue;
      const list = playerGroupsOf.get(c) ?? [];
      list.push(pg);
      playerGroupsOf.set(c, list);
    }
  });

  const periodOrder = new Map<string, number>();
  for (const d of decks) if (!periodOrder.has(d.period)) periodOrder.set(d.period, periodOrder.size);

  const pairsByCard = new Map<number, number[]>();
  for (let p = 0; p < all.pairCard.length; p++) {
    const list = pairsByCard.get(all.pairCard[p]) ?? [];
    list.push(p);
    pairsByCard.set(all.pairCard[p], list);
  }
  const eventsOfPair = (t: Tally, p: number): Map<number, number> => {
    const out = new Map<number, number>();
    for (let j = t.pStart[p]; j < t.pStart[p + 1]; j++) out.set(t.pEvent[j], (out.get(t.pEvent[j]) ?? 0) + t.pN[j]);
    return out;
  };

  const planRow = (card: number, scope: ScopeDef): RowPlan | null => {
    const pairs = (pairsByCard.get(card) ?? []).filter((p) => {
      const s = all.pairStratum[p];
      return scope.strata.has(s) && all.sDecks[s] - all.pairDecks[p] > 0;
    });
    if (pairs.length === 0) return null;
    let decksWith = 0;
    let decksWithout = 0;
    let matchesWith = 0;
    let matchesWithout = 0;
    const evN = new Map<number, number>();
    let latest = -1;
    let latestLabel = "";
    for (const p of pairs) {
      const s = all.pairStratum[p];
      decksWith += all.pairDecks[p];
      decksWithout += all.sDecks[s] - all.pairDecks[p];
      matchesWith += point.PN[p];
      matchesWithout += point.TN[s] - point.PN[p];
      for (const [e, n] of eventsOfPair(all, p)) evN.set(e, (evN.get(e) ?? 0) + n);
      const order = periodOrder.get(stratumInfo[s].period) as number;
      if (order > latest) {
        latest = order;
        latestLabel = stratumInfo[s].period;
      }
    }
    if (decksWith < opts.minDecks || decksWithout < opts.minDecks || evN.size < opts.minEvents) return null;
    let sum = 0;
    let sumSq = 0;
    for (const n of evN.values()) {
      sum += n;
      sumSq += n * n;
    }
    let tierPairs: RowPlan["tierPairs"] = null;
    const sPairs: number[] = [];
    const wPairs: number[] = [];
    let decksStrong = 0;
    let decksWeak = 0;
    for (const p of pairs) {
      const key = card * S + all.pairStratum[p];
      const sp = strong.pairOf.get(key);
      const wp = weak.pairOf.get(key);
      const s = all.pairStratum[p];
      if (sp === undefined || wp === undefined) continue;
      if (strong.sDecks[s] - strong.pairDecks[sp] <= 0 || weak.sDecks[s] - weak.pairDecks[wp] <= 0) continue;
      sPairs.push(sp);
      wPairs.push(wp);
      decksStrong += strong.pairDecks[sp];
      decksWeak += weak.pairDecks[wp];
    }
    if (decksStrong >= opts.minTierDecks && decksWeak >= opts.minTierDecks)
      tierPairs = { strong: sPairs, weak: wPairs, decksStrong, decksWeak };
    return {
      card,
      pairs,
      decksWith,
      decksWithout,
      eventsWith: evN.size,
      effectiveEvents: sumSq > 0 ? (sum * sum) / sumSq : 0,
      matchesWith,
      matchesWithout,
      latestPeriod: latestLabel,
      tierPairs,
      stylePairs: null,
      playerGroups: null,
    };
  };

  const styledByCard = new Map<number, number[]>();
  for (let p = 0; p < styled.pairCard.length; p++) {
    if (styled.sDecks[styled.pairStratum[p]] - styled.pairDecks[p] <= 0) continue;
    const list = styledByCard.get(styled.pairCard[p]) ?? [];
    list.push(p);
    styledByCard.set(styled.pairCard[p], list);
  }

  const allStrata = new Set<number>(Array.from({ length: S }, (_, s) => s));
  const globalScope: ScopeDef = { key: "global", leader: null, baseAspects: null, aspects: [], strata: allStrata };
  const aspectScopes = new Map<string, ScopeDef>();
  const archetypeScopes = new Map<string, ScopeDef>();
  stratumInfo.forEach((info, s) => {
    const aKey = `aspects:${info.aspects.join("+")}`;
    const a = aspectScopes.get(aKey) ?? { key: aKey, leader: null, baseAspects: null, aspects: info.aspects, strata: new Set<number>() };
    a.strata.add(s);
    aspectScopes.set(aKey, a);
    const rKey = `${info.leader}|${info.baseAspects.join("+")}`;
    const r = archetypeScopes.get(rKey) ?? {
      key: rKey,
      leader: info.leader,
      baseAspects: info.baseAspects,
      aspects: info.aspects,
      strata: new Set<number>(),
    };
    r.strata.add(s);
    archetypeScopes.set(rKey, r);
  });

  const cardOrder = cards.keys.map((k, i) => ({ k, i })).sort((a, b) => compareCodePoints(a.k, b.k));
  const planScope = (scope: ScopeDef): RowPlan[] => cardOrder.map(({ i }) => planRow(i, scope)).filter((r): r is RowPlan => r !== null);
  const globalPlans = planScope(globalScope).map((plan) => ({
    ...plan,
    stylePairs: styledByCard.get(plan.card) ?? null,
    playerGroups: (() => {
      const groups = playerGroupsOf.get(plan.card) ?? [];
      return new Set(groups.map((g) => g.player)).size >= opts.minPlayers ? groups.map((_, j) => j) : null;
    })(),
  }));
  const scopeList = (m: Map<string, ScopeDef>): ScopeDef[] => [...m.values()].sort((a, b) => compareCodePoints(a.key, b.key));
  const aspectPlans = scopeList(aspectScopes).map((scope) => ({ scope, plans: planScope(scope) }));
  const archetypePlans = scopeList(archetypeScopes).map((scope) => ({ scope, plans: planScope(scope) }));

  const families = [{ plans: globalPlans }, ...aspectPlans, ...archetypePlans];
  const gapM = families.map((f) => f.plans.map(() => new Moments()));
  const intM = families.map((f) => f.plans.map(() => new Moments()));
  const styleM = globalPlans.map(() => new Moments());

  const replicate = (k: Float64Array | null): { gaps: (number | null)[][]; ints: (number | null)[][]; styles: (number | null)[] } => {
    const wAll = weigh(all, k);
    const wStrong = weigh(strong, k);
    const wWeak = weigh(weak, k);
    const wStyle = weigh(styled, k);
    const gaps = families.map((f) => f.plans.map((plan) => pooledGap(all, wAll, plan.pairs)));
    const ints = families.map((f) =>
      f.plans.map((plan) => {
        if (plan.tierPairs === null) return null;
        const a = pooledGap(strong, wStrong, plan.tierPairs.strong);
        const b = pooledGap(weak, wWeak, plan.tierPairs.weak);
        return a === null || b === null ? null : a - b;
      }),
    );
    const styles = globalPlans.map((plan) => (plan.stylePairs === null ? null : pooledGap(styled, wStyle, plan.stylePairs)));
    return { gaps, ints, styles };
  };

  const est = replicate(null);
  const tierPoint = {
    strong: weigh(strong, null),
    weak: weigh(weak, null),
  };
  for (let r = 0; r < opts.replicates; r++) {
    const k = multinomial(seededRandom(`${opts.seed}|events|${r}`), E);
    const rep = replicate(k);
    rep.gaps.forEach((row, f) => row.forEach((x, j) => gapM[f][j].add(x)));
    rep.ints.forEach((row, f) => row.forEach((x, j) => intM[f][j].add(x)));
    rep.styles.forEach((x, j) => styleM[j].add(x));
    opts.onProgress?.("bootstrap", r + 1, opts.replicates);
  }

  // Within-player comparison: bootstrap over players.
  const P = players.keys.length;
  const wpM = globalPlans.map(() => new Moments());
  const wpOf = (plan: RowPlan, m: Float64Array | null): number | null => {
    if (plan.playerGroups === null) return null;
    const groups = playerGroupsOf.get(plan.card) ?? [];
    let num = 0;
    let den = 0;
    for (const g of groups) {
      const mult = m === null ? 1 : m[g.player];
      if (mult === 0) continue;
      const w = (g.nW * g.nO) / (g.nW + g.nO);
      num += mult * w * (g.wW / g.nW - g.wO / g.nO);
      den += mult * w;
    }
    return den > 0 ? num / den : null;
  };
  const wpPoint = globalPlans.map((plan) => wpOf(plan, null));
  for (let r = 0; r < opts.replicates; r++) {
    const m = multinomial(seededRandom(`${opts.seed}|players|${r}`), Math.max(P, 1));
    globalPlans.forEach((plan, j) => wpM[j].add(wpOf(plan, m)));
  }

  const finish = (plans: RowPlan[], f: number, global: boolean): SleeperRow[] => {
    const gapP = plans.map((plan, j) => pOf(est.gaps[f][j] ?? 0, gapM[f][j].sd()));
    const gapBH = stepUpQ(gapP, "BH");
    const gapBY = stepUpQ(gapP, "BY");
    const intIdx = plans.map((_, j) => j).filter((j) => est.ints[f][j] !== null && intM[f][j].sd() !== null);
    const intP = intIdx.map((j) => pOf(est.ints[f][j] as number, intM[f][j].sd()));
    const intBH = stepUpQ(intP, "BH");
    const intBY = stepUpQ(intP, "BY");
    const intAt = new Map(intIdx.map((j, n) => [j, n]));
    return plans.map((plan, j) => {
      const gap = estimateOf(est.gaps[f][j] ?? 0, gapM[f][j].sd(), gapP[j], gapBH[j], gapBY[j]);
      const n = intAt.get(j);
      const tp = plan.tierPairs;
      const skillOut =
        n === undefined || tp === null
          ? null
          : {
              gapStrong: r4(pooledGap(strong, tierPoint.strong, tp.strong) ?? 0),
              gapWeak: r4(pooledGap(weak, tierPoint.weak, tp.weak) ?? 0),
              decksStrong: tp.decksStrong,
              decksWeak: tp.decksWeak,
              interaction: estimateOf(est.ints[f][j] as number, intM[f][j].sd(), intP[n], intBH[n], intBY[n]),
            };
      const wp = global ? wpPoint[j] : null;
      const wpSd = global ? wpM[j].sd() : null;
      const withinPlayer =
        wp === null || wpSd === null
          ? null
          : {
              value: r4(wp),
              low: r4(wp - Z95 * wpSd),
              high: r4(wp + Z95 * wpSd),
              players: new Set((playerGroupsOf.get(plan.card) ?? []).map((g) => g.player)).size,
            };
      const st = global ? est.styles[j] : null;
      const stSd = global ? styleM[j].sd() : null;
      const withinStyle = st === null || stSd === null ? null : { value: r4(st), low: r4(st - Z95 * stSd), high: r4(st + Z95 * stSd) };
      const playRate = plan.decksWith / (plan.decksWith + plan.decksWithout);
      const significant = gap.qBY <= opts.q;
      const verdict: (typeof SLEEPER_VERDICTS)[number] =
        significant && gap.low > 0
          ? playRate < opts.commonPlayRate
            ? "sleeper"
            : "proven-winner"
          : significant && gap.high < 0
            ? "loses-ground"
            : "no-clear-effect";
      const info = opts.cardInfo?.(cards.keys[plan.card]) ?? { title: cards.keys[plan.card], rotated: false };
      return {
        cardKey: cards.keys[plan.card],
        title: info.title,
        rotated: info.rotated,
        decksWith: plan.decksWith,
        decksWithout: plan.decksWithout,
        eventsWith: plan.eventsWith,
        effectiveEvents: r4(plan.effectiveEvents),
        matchesWith: plan.matchesWith,
        matchesWithout: plan.matchesWithout,
        playRate: r4(playRate),
        gap,
        skill: skillOut,
        withinPlayer,
        withinStyle,
        latestPeriod: plan.latestPeriod,
        verdict,
        skilledEdge: skillOut !== null && skillOut.interaction.qBY <= opts.q && skillOut.interaction.low > 0,
        selectionWarning: verdict !== "no-clear-effect" && withinPlayer !== null && withinPlayer.low <= 0 && withinPlayer.high >= 0,
      };
    });
  };

  const global = finish(globalPlans, 0, true);
  const scopeOut = (list: { scope: ScopeDef; plans: RowPlan[] }[], offset: number): SleeperScope[] =>
    list
      .map(({ scope, plans }, i) => ({
        key: scope.key,
        leader: scope.leader,
        baseAspects: scope.baseAspects,
        aspects: scope.aspects,
        decks: [...scope.strata].reduce((n, s) => n + all.sDecks[s], 0),
        rows: finish(plans, offset + i, false),
      }))
      .filter((s) => s.rows.length > 0);
  const aspects = scopeOut(aspectPlans, 1);
  const archetypes = scopeOut(archetypePlans, 1 + aspectPlans.length);

  // Label-shuffle null: card lists permuted among decks of the same stratum, so no card can carry real signal.
  const shuffled = cardIds.map((c) => c);
  const byStratum = new Map<number, number[]>();
  stratumOf.forEach((s, i) => {
    const list = byStratum.get(s) ?? [];
    list.push(i);
    byStratum.set(s, list);
  });
  const nullRandom = seededRandom(`${opts.seed}|null-shuffle`);
  for (const s of [...byStratum.keys()].sort((a, b) => a - b)) {
    const members = byStratum.get(s) as number[];
    const lists = members.map((i) => cardIds[i]);
    for (let i = lists.length - 1; i > 0; i--) {
      const j = Math.floor(nullRandom() * (i + 1));
      [lists[i], lists[j]] = [lists[j], lists[i]];
    }
    members.forEach((i, n) => (shuffled[i] = lists[n]));
  }
  const nullTally = buildTally(decks, stratumOf, shuffled, eventOf, () => true, S, E);
  const nullPoint = weigh(nullTally, null);
  const nullPairs = new Map<number, number[]>();
  for (let p = 0; p < nullTally.pairCard.length; p++) {
    const s = nullTally.pairStratum[p];
    if (nullTally.sDecks[s] - nullTally.pairDecks[p] <= 0) continue;
    const list = nullPairs.get(nullTally.pairCard[p]) ?? [];
    list.push(p);
    nullPairs.set(nullTally.pairCard[p], list);
  }
  const nullRows = cardOrder
    .map(({ i }) => nullPairs.get(i))
    .filter((pairs): pairs is number[] => {
      if (pairs === undefined) return false;
      const w = pairs.reduce((n, p) => n + nullTally.pairDecks[p], 0);
      const wo = pairs.reduce((n, p) => n + nullTally.sDecks[nullTally.pairStratum[p]] - nullTally.pairDecks[p], 0);
      return w >= opts.minDecks && wo >= opts.minDecks;
    });
  const nullM = nullRows.map(() => new Moments());
  for (let r = 0; r < opts.nullReplicates; r++) {
    const k = multinomial(seededRandom(`${opts.seed}|null-events|${r}`), E);
    const w = weigh(nullTally, k);
    nullRows.forEach((pairs, j) => nullM[j].add(pooledGap(nullTally, w, pairs)));
    opts.onProgress?.("null", r + 1, opts.nullReplicates);
  }
  const nullP = nullRows.map((pairs, j) => pOf(pooledGap(nullTally, nullPoint, pairs) ?? 0, nullM[j].sd()));
  const nullBH = stepUpQ(nullP, "BH");
  const nullBY = stepUpQ(nullP, "BY");

  return {
    counts: {
      decks: decks.length,
      events: E,
      players: P,
      decksWithSkill: ranked.length,
      strata: S,
      styles: SS,
    },
    skill: { priorMatches: r4(priorMatches), betweenPlayerSd: r4(betweenSd), tierCuts },
    nullCheck: {
      method: "card lists shuffled among decks of the same meta period, leader and base aspects (seeded), then the global pass rerun",
      replicates: opts.nullReplicates,
      rows: nullRows.length,
      passBH: nullBH.filter((q) => q <= opts.q).length,
      passBY: nullBY.filter((q) => q <= opts.q).length,
      minP: nullP.length === 0 ? null : sig4(Math.min(...nullP)),
    },
    global,
    aspects,
    archetypes,
  };
}
