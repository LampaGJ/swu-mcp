/**
 * @displayName Real-play pair measures
 * @strategicPurpose One set of counting primitives serves decks, human game sides and simulated seats, so every
 * source is measured the same way and only the population differs.
 * @tacticalObjective Bitset incidence per card over a population of units, aspect-cover eligibility (a unit can
 * field a card without the +2 penalty), smoothed pair lift, played-while-in-play events, leader-stratified win
 * sums, group substitution O/E and trio O/E, plus seeded matched-baseline partner draws.
 */
import { compareCodePoints } from "../../src/swu/canonical.js";
import { logLift, mhSums, seededRandom, type Stratum } from "./stats.js";

export class Bits {
  readonly words: Uint32Array;
  constructor(
    readonly n: number,
    words?: Uint32Array,
  ) {
    this.words = words ?? new Uint32Array((n + 31) >>> 5);
  }
  static from(n: number, indices: Iterable<number>): Bits {
    const b = new Bits(n);
    for (const i of indices) b.set(i);
    return b;
  }
  static full(n: number): Bits {
    return Bits.from(
      n,
      Array.from({ length: n }, (_, i) => i),
    );
  }
  set(i: number): void {
    this.words[i >>> 5] |= 1 << (i & 31);
  }
  has(i: number): boolean {
    return (this.words[i >>> 5] & (1 << (i & 31))) !== 0;
  }
  private zip(o: Bits, f: (x: number, y: number) => number): Bits {
    const w = new Uint32Array(this.words.length);
    for (let i = 0; i < w.length; i++) w[i] = f(this.words[i], o.words[i]);
    return new Bits(this.n, w);
  }
  and(o: Bits): Bits {
    return this.zip(o, (x, y) => x & y);
  }
  or(o: Bits): Bits {
    return this.zip(o, (x, y) => x | y);
  }
  andNot(o: Bits): Bits {
    return this.zip(o, (x, y) => x & ~y);
  }
  count(): number {
    let c = 0;
    for (const w of this.words) c += popcount(w);
    return c;
  }
  andCount(o: Bits): number {
    let c = 0;
    for (let i = 0; i < this.words.length; i++) c += popcount(this.words[i] & o.words[i]);
    return c;
  }
  *indices(): Generator<number> {
    for (let i = 0; i < this.words.length; i++) {
      let w = this.words[i];
      while (w !== 0) {
        const low = w & -w;
        yield (i << 5) + (31 - Math.clz32(low));
        w ^= low;
      }
    }
  }
}

function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Every icon the card needs, duplicates included, is supplied by the unit's leader and base icons. */
export function coverFree(cardIcons: readonly string[], have: readonly string[]): boolean {
  const left = new Map<string, number>();
  for (const icon of have) left.set(icon, (left.get(icon) ?? 0) + 1);
  for (const icon of cardIcons) {
    const n = left.get(icon) ?? 0;
    if (n === 0) return false;
    left.set(icon, n - 1);
  }
  return true;
}

export interface Unit {
  cards: ReadonlySet<string>;
  /** Cards a seat may or may not hold (simulated seats whose decklist is one of several candidates). */
  uncertain?: ReadonlySet<string>;
  icons: readonly string[];
  leader: string | null;
  base: string | null;
  won: 0 | 1 | null;
  /** Several games folded into one unit (a simulated decklist's record); overrides `won`. */
  results?: { wins: number; n: number };
  played?: ReadonlySet<string>;
  co?: ReadonlySet<string>;
}

export const CO_SEP = "\u0000";

export class Population {
  readonly n: number;
  private readonly cardBits = new Map<string, Bits>();
  private readonly uncertainBits = new Map<string, Bits>();
  private readonly eligibleMemo = new Map<string, Bits>();
  readonly empty: Bits;
  readonly all: Bits;
  constructor(
    readonly units: readonly Unit[],
    private readonly iconsOf: (cardKey: string) => readonly string[],
  ) {
    this.n = units.length;
    this.empty = new Bits(this.n);
    this.all = Bits.full(this.n);
    units.forEach((u, i) => {
      for (const c of u.cards) this.bitsFor(this.cardBits, c).set(i);
      for (const c of u.uncertain ?? []) this.bitsFor(this.uncertainBits, c).set(i);
    });
  }
  private bitsFor(map: Map<string, Bits>, key: string): Bits {
    let b = map.get(key);
    if (b === undefined) {
      b = new Bits(this.n);
      map.set(key, b);
    }
    return b;
  }
  has(card: string): Bits {
    return this.cardBits.get(card) ?? this.empty;
  }
  uncertain(card: string): Bits {
    return this.uncertainBits.get(card) ?? this.empty;
  }
  includes(card: string): number {
    return this.has(card).count();
  }
  /** Units that can field the card without an aspect penalty; memoised per icon multiset. */
  eligible(card: string): Bits {
    const icons = this.iconsOf(card);
    const key = [...icons].sort(compareCodePoints).join("+");
    let b = this.eligibleMemo.get(key);
    if (b === undefined) {
      b = Bits.from(
        this.n,
        this.units.flatMap((u, i) => (coverFree(icons, u.icons) ? [i] : [])),
      );
      this.eligibleMemo.set(key, b);
    }
    return b;
  }
}

export interface Lift {
  n: number;
  nA: number;
  nB: number;
  nAB: number;
  lift: number | null;
  logLift: number | null;
}

/** Lift among `within` units (all by default), optionally only those eligible for both cards; null when either card is never included. */
export function pairLift(pop: Population, a: string, b: string, opts: { conditioned: boolean; within?: Bits }): Lift {
  let scope = opts.within ?? pop.all;
  if (opts.conditioned) scope = scope.and(pop.eligible(a)).and(pop.eligible(b));
  const known = scope.andNot(pop.uncertain(a)).andNot(pop.uncertain(b));
  const A = pop.has(a).and(known);
  const n = known.count();
  const nA = A.count();
  const nB = pop.has(b).andCount(known);
  const nAB = A.andCount(pop.has(b));
  const measured = nA > 0 && nB > 0;
  return { n, nA, nB, nAB, lift: measured ? (nAB * n) / (nA * nB) : null, logLift: measured ? logLift(nAB, nA, nB, n) : null };
}

/** Among units holding both cards: how often A was in play (board, leader or base) when B was played, and the reverse. */
export function inPlayEvents(
  pop: Population,
  a: string,
  b: string,
): { coSides: number; aInPlayWhenBPlayed: number; bInPlayWhenAPlayed: number } {
  let coSides = 0;
  let ab = 0;
  let ba = 0;
  const present = (u: Unit, x: string, y: string): boolean =>
    (u.co?.has(`${x}${CO_SEP}${y}`) ?? false) || ((u.leader === x || u.base === x) && (u.played?.has(y) ?? false));
  for (const i of pop.has(a).and(pop.has(b)).indices()) {
    const u = pop.units[i];
    coSides += 1;
    if (present(u, a, b)) ab += 1;
    if (present(u, b, a)) ba += 1;
  }
  return { coSides, aInPlayWhenBPlayed: ab, bInPlayWhenAPlayed: ba };
}

export interface PairWin {
  both: { wins: number; n: number };
  one: { wins: number; n: number };
  mh: { num: number; den: number };
}

/** Units holding both cards versus exactly one (known result, certain membership), with Mantel-Haenszel sums stratified by leader. */
export function pairWin(pop: Population, a: string, b: string, within?: Bits): PairWin {
  const A = pop.has(a);
  const B = pop.has(b);
  let scope = A.or(B).andNot(pop.uncertain(a)).andNot(pop.uncertain(b));
  if (within !== undefined) scope = scope.and(within);
  const strata = new Map<string, Stratum>();
  const both = { wins: 0, n: 0 };
  const one = { wins: 0, n: 0 };
  for (const i of scope.indices()) {
    const u = pop.units[i];
    const r = u.results ?? (u.won === null ? null : { wins: u.won, n: 1 });
    if (r === null || r.n === 0) continue;
    const s = strata.get(u.leader ?? "") ?? { a: 0, n1: 0, c: 0, n0: 0 };
    const group = A.has(i) && B.has(i) ? both : one;
    group.n += r.n;
    group.wins += r.wins;
    if (group === both) {
      s.n1 += r.n;
      s.a += r.wins;
    } else {
      s.n0 += r.n;
      s.c += r.wins;
    }
    strata.set(u.leader ?? "", s);
  }
  return { both, one, mh: mhSums(strata.values()) };
}

/**
 * Substitution test for a group of cards: within each leader with at least `minPerLeader` units, observed member
 * co-occurrences sum(k choose 2) against expectation sum_{i<j} n_i n_j / n_L under independence.
 */
export function groupOE(
  pop: Population,
  members: readonly string[],
  minPerLeader: number,
): { observed: number; expected: number; leaders: number } {
  const byLeader = new Map<string, number[]>();
  pop.units.forEach((u, i) => {
    const l = u.leader ?? "";
    byLeader.set(l, [...(byLeader.get(l) ?? []), i]);
  });
  let observed = 0;
  let expected = 0;
  let leaders = 0;
  const memberBits = members.map((m) => pop.has(m));
  for (const idx of byLeader.values()) {
    if (idx.length < minPerLeader) continue;
    leaders += 1;
    const counts = memberBits.map(() => 0);
    for (const i of idx) {
      let k = 0;
      memberBits.forEach((b, m) => {
        if (b.has(i)) {
          k += 1;
          counts[m] += 1;
        }
      });
      observed += (k * (k - 1)) / 2;
    }
    const s1 = counts.reduce((x, y) => x + y, 0);
    const s2 = counts.reduce((x, y) => x + y * y, 0);
    expected += (s1 * s1 - s2) / (2 * idx.length);
  }
  return { observed, expected, leaders };
}

/** All three together versus n pA pB pC among units eligible for all three. */
export function trioOE(
  pop: Population,
  a: string,
  b: string,
  c: string,
  within?: Bits,
): { n: number; observed: number; expected: number; nA: number; nB: number; nC: number } {
  const scope = (within ?? pop.all).and(pop.eligible(a)).and(pop.eligible(b)).and(pop.eligible(c));
  const n = scope.count();
  const A = pop.has(a).and(scope);
  const nA = A.count();
  const nB = pop.has(b).andCount(scope);
  const nC = pop.has(c).andCount(scope);
  const observed = A.and(pop.has(b)).andCount(pop.has(c));
  return { n, observed, expected: n === 0 ? 0 : (nA * nB * nC) / (n * n), nA, nB, nC };
}

/**
 * For each pair, a replacement for B drawn uniformly from B's stratum (same type, cost band and aspect icons),
 * never A, B, or a partner A is already paired with. Seeded per pair id, so the draw is stable when pairs change.
 */
export function matchedPartners(
  pairs: readonly { a: string; b: string; id: string }[],
  stratumOf: ReadonlyMap<string, string>,
  pool: ReadonlyMap<string, readonly string[]>,
  emitted: ReadonlySet<string>,
  seed: string,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pairs) {
    const stratum = stratumOf.get(p.b);
    const options = (stratum === undefined ? [] : (pool.get(stratum) ?? [])).filter(
      (x) => x !== p.a && x !== p.b && !emitted.has(`${p.a}${CO_SEP}${x}`),
    );
    if (options.length === 0) continue;
    out.set(p.id, options[Math.floor(seededRandom(`${seed}|${p.id}`)() * options.length)]);
  }
  return out;
}
