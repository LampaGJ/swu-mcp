import { makeBestCover, type CoverCombo } from "./cover.js";
import { edgeScore, mechanicalRows, type PairGraph } from "./graph.js";
import { cardLabel, cmp, r3 } from "./order.js";
import type { PairEdge, SynergyCard, TraitsMode, TrioRecord, TrioShape } from "./schema.js";
import { TRIO_SHAPES } from "./schema.js";

/**
 * @displayName SWU trio search
 * @strategicPurpose Finds three-card combos (chains A->B->C, two enablers into one payoff, loops
 * A->B->C->A) in the offers-to-wants pair graph, favouring low total cost and aspect playability
 * (ported from the mault-train prototype pairs.mjs, LampaGJ/mault#325).
 * @tacticalObjective Searches a pruned graph (top FANOUT in- and out-edges per node) so it never
 * enumerates all triples. Leaders and bases are never members; they only supply the aspect cover.
 */

export const TRIO_FANOUT = 30;
export const TRIO_MEMBER_TYPES: ReadonlySet<string> = new Set(["Unit", "Event", "Upgrade"]);
export const DEFAULT_TRIO_KEEP = 100;

export interface TrioSearchOptions {
  /** Trios kept per shape. */
  keep?: number;
  /** Aspect combinations to cover with; defaults to the data's leader and base combinations. */
  combos?: readonly CoverCombo[];
  /** Return false to skip scoring a candidate; counts still include it. */
  accept?: (keys: readonly [string, string, string], totalCost: number) => boolean;
  /** How shared traits count (default "bonus"). Only "include" admits trait-only links, and then a trio still needs one mechanical link. */
  traits?: TraitsMode;
}

export interface TrioSearchResult {
  trios: Record<TrioShape, TrioRecord[]>;
  counts: { chain: number; convergent: number; loop: number } & Partial<Record<TrioShape, number>>;
  graph: { edges: number; nodes: number; fanout: number };
}

export const trioOrder = (x: TrioRecord, y: TrioRecord): number =>
  y.score - x.score || cmp(`${x.cardA}${x.cardB}${x.cardC}`, `${y.cardA}${y.cardB}${y.cardC}`);

export function searchTrios(graph: PairGraph, combos: readonly CoverCombo[], options: TrioSearchOptions = {}): TrioSearchResult {
  const keep = options.keep ?? DEFAULT_TRIO_KEEP;
  const accept = options.accept ?? (() => true);
  const traits = options.traits ?? "bonus";
  const linkOf = (e: PairEdge): number =>
    traits === "bonus" ? e.link : traits === "exclude" ? e.mechanicalLink : e.mechanicalLink + e.traitLink;
  const linkRows = (e: PairEdge): PairEdge["rows"] => (traits === "include" ? e.rows : mechanicalRows(e));
  const shownRows = (e: PairEdge): PairEdge["rows"] => (traits === "exclude" ? mechanicalRows(e) : e.rows);
  const order = (x: PairEdge, y: PairEdge): number => edgeScore(y, traits) - edgeScore(x, traits) || cmp(x.a, y.a) || cmp(x.b, y.b);
  const mechanical = (links: readonly PairEdge[]): boolean => links.some((e) => !e.traitOnly);
  const { byKey } = graph;
  const bestCover = makeBestCover(options.combos ?? combos);
  const member = (k: string): SynergyCard => byKey.get(k) as SynergyCard;

  const trioEdges = graph.edges.filter(
    (e) => (traits === "include" || !e.traitOnly) && TRIO_MEMBER_TYPES.has(member(e.a).type) && TRIO_MEMBER_TYPES.has(member(e.b).type),
  );
  const outAdj = new Map<string, PairEdge[]>();
  const inAdj = new Map<string, PairEdge[]>();
  const push = (m: Map<string, PairEdge[]>, k: string, e: PairEdge): void => {
    const list = m.get(k);
    if (list) list.push(e);
    else m.set(k, [e]);
  };
  for (const e of trioEdges) {
    push(outAdj, e.a, e);
    push(inAdj, e.b, e);
  }
  for (const m of [outAdj, inAdj]) for (const [k, v] of m) m.set(k, v.sort(order).slice(0, TRIO_FANOUT));
  const edgeByKey = new Map(trioEdges.map((e) => [`${e.a}>${e.b}`, e]));

  function record(shape: TrioShape, keys: [string, string, string], links: PairEdge[]): TrioRecord {
    const ms = keys.map(member);
    const totalCost = ms.reduce((s, c) => s + (c.structured.cost ?? 0), 0);
    const allCheap = ms.every((c) => (c.structured.cost ?? 0) <= 3);
    const cover = bestCover(ms);
    const aspectsUsed = new Set(ms.flatMap((c) => c.structured.aspects.filter((x) => x !== "Heroism" && x !== "Villainy")));
    const link = links.reduce((s, e) => s + linkOf(e), 0);
    const nonObv = links.reduce((s, e) => s + e.nonObvious.factor, 0) / links.length;
    const costF = 1 / (1 + totalCost / 6) + (allCheap ? 0.25 : 0);
    const play = 1 / (1 + cover.penalty / 2);
    return {
      cardA: keys[0],
      cardB: keys[1],
      cardC: keys[2],
      shape,
      totalCost,
      allCostLe3: allCheap,
      aspectPair: cover.label,
      penalty: cover.penalty,
      reasons: links
        .map(
          (e) =>
            `${cardLabel(member(e.a))} -> ${cardLabel(member(e.b))}: ${shownRows(e)
              .map((r) => `${r.row} (${r.offer} -> ${r.want})`)
              .join("; ")}`,
        )
        .join(" | "),
      score: r3(link * costF * play * nonObv * (1 + 0.1 * aspectsUsed.size)),
    };
  }

  const trios: Record<TrioShape, TrioRecord[]> = {
    chain: [],
    "convergent-different-wants": [],
    "convergent-same-want": [],
    loop: [],
  };
  const counts: TrioSearchResult["counts"] = { chain: 0, convergent: 0, loop: 0 };
  const keepTop = (arr: TrioRecord[], rec: TrioRecord): void => {
    arr.push(rec);
    if (arr.length > keep * 5) {
      arr.sort(trioOrder);
      arr.length = keep;
    }
  };
  const sameName = (...ks: string[]): boolean => new Set(ks.map((k) => member(k).title)).size < ks.length;
  const costOf = (...ks: string[]): number => ks.reduce((s, k) => s + (member(k).structured.cost ?? 0), 0);

  const nodes = [...new Set(trioEdges.flatMap((e) => [e.a, e.b]))].sort(cmp);
  for (const b of nodes) {
    const ins = inAdj.get(b) ?? [];
    const outs = outAdj.get(b) ?? [];
    for (const e1 of ins) {
      for (const e2 of outs) {
        if (e1.a === e2.b || sameName(e1.a, b, e2.b) || !mechanical([e1, e2])) continue;
        counts.chain++;
        const keys: [string, string, string] = [e1.a, b, e2.b];
        if (accept(keys, costOf(...keys))) keepTop(trios.chain, record("chain", keys, [e1, e2]));
      }
    }
    for (let i = 0; i < ins.length; i++) {
      for (let j = i + 1; j < ins.length; j++) {
        const e1 = ins[i];
        const e2 = ins[j];
        if (e1.a === e2.a || sameName(e1.a, e2.a, b) || !mechanical([e1, e2])) continue;
        const [x, y] = cmp(e1.a, e2.a) < 0 ? [e1, e2] : [e2, e1];
        const wantsHit = new Set([...linkRows(x), ...linkRows(y)].map((r) => r.want));
        const shape: TrioShape = wantsHit.size > 1 ? "convergent-different-wants" : "convergent-same-want";
        counts.convergent++;
        counts[shape] = (counts[shape] ?? 0) + 1;
        const keys: [string, string, string] = [x.a, y.a, b];
        if (accept(keys, costOf(...keys))) keepTop(trios[shape], record(shape, keys, [x, y]));
      }
    }
    for (const e2 of outs) {
      const c = e2.b;
      for (const e3 of outAdj.get(c) ?? []) {
        const a = e3.b;
        if (a === b || a === c) continue;
        const e1 = edgeByKey.get(`${a}>${b}`);
        if (!e1 || !(cmp(a, b) < 0 && cmp(a, c) < 0) || sameName(a, b, c) || !mechanical([e1, e2, e3])) continue;
        counts.loop++;
        const keys: [string, string, string] = [a, b, c];
        if (accept(keys, costOf(...keys))) keepTop(trios.loop, record("loop", keys, [e1, e2, e3]));
      }
    }
  }
  for (const shape of TRIO_SHAPES) trios[shape] = trios[shape].sort(trioOrder).slice(0, keep);
  return { trios, counts, graph: { edges: trioEdges.length, nodes: nodes.length, fanout: TRIO_FANOUT } };
}
