import { describe, expect, it } from "vitest";
import { evaluateV, maskState, pickCandidate, rankByExclusion, RUNG3_PARAMS, type RawSide, type RawState } from "../../../src/sims/policies/lookahead.js";
import { makeRulePolicy, RUNG1_PARAMS } from "../../../src/sims/policies/rules.js";
import { button, card, cardAnswer, view } from "./fixtures.js";

const unit = (power: number, remainingHp: number, over: Partial<RawSide["units"][number]> = {}) => ({ power, remainingHp, exhausted: false, leader: false, cost: 2, score: 0, ...over });

function side(over: Partial<RawSide> = {}): RawSide {
  return {
    baseDamage: 0,
    baseRemaining: 30,
    units: [],
    resources: { total: 4, ready: 4 },
    hand: [],
    deck: [],
    leaderDeployed: false,
    hasInitiative: false,
    ...over,
  };
}

const raw = (me: Partial<RawSide>, opp: Partial<RawSide>, over: Partial<RawState> = {}): RawState => ({ seat: 1, ended: false, winnerSeat: null, sides: [side(me), side(opp)], ...over });
const hc = (id: string, cardKey = id, cost = 2, score = 1) => ({ id, cardKey, cost, score });

describe("rung 3 state value V", () => {
  it("weighs base damage, board, hand, resources and ready units per the ladder doc, for the actor", () => {
    const w = { ...RUNG3_PARAMS, wBase: 1.5, wBoard: 1, wHand: 1, wResources: 1, wReady: 1, wScore: 0 };
    const s = maskState(
      raw(
        { baseDamage: 2, units: [unit(3, 4), unit(2, 1, { exhausted: true })], hand: [hc("a"), hc("b")], resources: { total: 5, ready: 1 } },
        { baseDamage: 6, units: [unit(1, 2)], hand: [hc("x")], resources: { total: 4, ready: 4 } },
      ),
      new Set(["a", "b"]),
    );
    // base 1.5*(6-2) + board ((3+4)+(2+1)) - (1+2) + hand (2-1) + resources (5-4) + ready (1-1)
    expect(evaluateV(s, w)).toBeCloseTo(6 + 7 + 1 + 1 + 0, 9);
    // seat 2 sees the same state with the sign flipped
    const flipped = maskState({ ...raw({}, {}), seat: 2, sides: [...[side({ baseDamage: 6, units: [unit(1, 2)], hand: [hc("x")], resources: { total: 4, ready: 4 } }), side({ baseDamage: 2, units: [unit(3, 4), unit(2, 1, { exhausted: true })], hand: [hc("a"), hc("b")], resources: { total: 5, ready: 1 } })]] as [RawSide, RawSide] }, new Set(["a", "b"]));
    expect(evaluateV(flipped, w)).toBeCloseTo(15, 9);
  });

  it("scores a won game +Infinity and a lost one -Infinity, whatever the board", () => {
    const board = { units: [unit(9, 9)] };
    expect(evaluateV(maskState(raw({}, board, { ended: true, winnerSeat: 1 }), new Set()), RUNG3_PARAMS)).toBe(Infinity);
    expect(evaluateV(maskState(raw(board, {}, { ended: true, winnerSeat: 2 }), new Set()), RUNG3_PARAMS)).toBe(-Infinity);
    expect(evaluateV(maskState(raw(board, {}, { ended: true, winnerSeat: null }), new Set()), RUNG3_PARAMS)).toBe(0);
  });

  it("adds the play-calibrated score of units in play only through wScore", () => {
    const s = maskState(raw({ units: [unit(1, 1, { score: 2.5 })] }, { units: [unit(1, 1, { score: 0.5 })] }), new Set());
    expect(evaluateV(s, { ...RUNG3_PARAMS, wScore: 0 })).toBeCloseTo(evaluateV(s, { ...RUNG3_PARAMS, wScore: 0 }), 9);
    expect(evaluateV(s, { ...RUNG3_PARAMS, wScore: 2 }) - evaluateV(s, { ...RUNG3_PARAMS, wScore: 0 })).toBeCloseTo(2 * (2.5 - 0.5), 9);
  });
});

describe("rung 3 hidden-information mask", () => {
  const me = { hand: [hc("a", "SOR_001", 3, 2), hc("b", "SOR_002", 1, 0.5)], deck: [hc("d1"), hc("d2")] };
  const opp = { hand: [hc("x", "SOR_100"), hc("y", "SOR_101")], deck: [hc("e1"), hc("e2"), hc("e3")] };
  const root = new Set(["a", "b"]);

  it("keeps the opponent's hand and both decks as counts only", () => {
    const s = maskState(raw(me, opp), root);
    expect(s.opp.handSize).toBe(2);
    expect(s.opp.deckSize).toBe(3);
    expect(s.me.deckSize).toBe(2);
    expect(JSON.stringify(s)).not.toMatch(/SOR_10[01]|"e1"|"d1"/);
  });

  it("gives the same masked state and V when only hidden facts differ: opponent hand identities, deck order", () => {
    const a = maskState(raw(me, opp), root);
    const b = maskState(raw({ ...me, deck: [hc("d2", "LOF_001"), hc("d1", "LOF_002")] }, { ...opp, hand: [hc("q", "JTL_050", 9, 7), hc("r", "JTL_051", 0, -3)], deck: [hc("e3"), hc("e1"), hc("e2")] }), root);
    expect(b).toEqual(a);
    for (const wScore of [0, 1]) expect(evaluateV(b, { ...RUNG3_PARAMS, wScore })).toBe(evaluateV(a, { ...RUNG3_PARAMS, wScore }));
  });

  it("never scores the identity of a card the trial drew: it counts toward hand size only", () => {
    const drewCheap = maskState(raw({ ...me, hand: [...me.hand, hc("n", "SOR_050", 1, -2)] }, opp), root);
    const drewBomb = maskState(raw({ ...me, hand: [...me.hand, hc("n2", "SOR_051", 8, 9)] }, opp), root);
    expect(drewCheap).toEqual(drewBomb);
    expect(drewCheap.me.handSize).toBe(3);
    expect(drewCheap.me.knownHand.map((c) => c.cardKey)).toEqual(["SOR_001", "SOR_002"]);
    expect(drewCheap.me.drawnInTrial).toBe(1);
  });
});

describe("rung 3 candidate order", () => {
  const rung1 = () => makeRulePolicy({ id: "rung1-rules", version: "1", rung: 1, params: RUNG1_PARAMS });

  it("ranks rung 1's choices by exclusion: its pick, then its pick without that, up to K", () => {
    const a = card({ title: "A", zone: "hand", score: 3, cost: 2 });
    const b = card({ title: "B", zone: "hand", score: 1, cost: 2 });
    const u = card({ title: "U", power: 3 });
    const answers = [button("Pass"), button("Claim Initiative"), cardAnswer(a), cardAnswer(b), cardAnswer(u)];
    const v = view({ hand: [a, b], mine: [u], me: { resources: { total: 3, ready: 3 } } });
    const p = rung1();
    const decide = p.decide as NonNullable<typeof p.decide>;
    expect(rankByExclusion(answers, v, decide, 5)).toEqual([2, 3, 4, 1, 0]);
    expect(rankByExclusion(answers, v, decide, 3)).toEqual([2, 3, 4]);
    expect(rankByExclusion(answers, v, decide, 1)).toEqual([2]);
    expect(p.stats.decisions).toBe(0);
  });

  it("picks the highest V; ties go to rung 1's order, then the descriptor", () => {
    expect(pickCandidate([{ index: 4, rank: 0, descriptor: "b", v: 1 }, { index: 2, rank: 1, descriptor: "a", v: 3 }]).index).toBe(2);
    expect(pickCandidate([{ index: 4, rank: 1, descriptor: "a", v: 3 }, { index: 2, rank: 0, descriptor: "b", v: 3 }]).index).toBe(2);
    expect(pickCandidate([{ index: 4, rank: 0, descriptor: "b", v: 3 }, { index: 2, rank: 0, descriptor: "a", v: 3 }]).index).toBe(2);
    expect(pickCandidate([{ index: 7, rank: 2, descriptor: "z", v: Infinity }, { index: 1, rank: 0, descriptor: "a", v: 50 }]).index).toBe(7);
    expect(pickCandidate([{ index: 7, rank: 2, descriptor: "z", v: Infinity }, { index: 1, rank: 1, descriptor: "a", v: Infinity }]).index).toBe(1);
  });

  it("drops a failed trial (null V) unless every trial failed, then keeps rung 1's pick", () => {
    expect(pickCandidate([{ index: 4, rank: 0, descriptor: "b", v: null }, { index: 2, rank: 1, descriptor: "a", v: -5 }]).index).toBe(2);
    expect(pickCandidate([{ index: 4, rank: 1, descriptor: "b", v: null }, { index: 2, rank: 0, descriptor: "a", v: null }]).index).toBe(2);
  });
});

describe("rung 3 policy names", () => {
  it("parses K, horizon and weights into a canonical name whose params hash carries the V version", async () => {
    const { parsePolicySpec, policyHeader } = await import("../../../src/sims/policies/index.js");
    const a = policyHeader(parsePolicySpec("rung3:wBase=2,k=5,horizon=reply"));
    expect(a.spec).toBe("rung3:horizon=reply,k=5,wBase=2");
    expect(a.rung).toBe(3);
    expect(a.params.vVersion).toBe(RUNG3_PARAMS.vVersion);
    expect(policyHeader(parsePolicySpec(a.spec)).paramsSha256).toBe(a.paramsSha256);
    expect(policyHeader(parsePolicySpec("rung3")).spec).toBe("rung3");
    expect(policyHeader(parsePolicySpec("rung3:k=3")).paramsSha256).toBe(policyHeader(parsePolicySpec("rung3")).paramsSha256);
    expect(() => parsePolicySpec("rung3:k=0")).toThrow(/k >= 1/);
    expect(() => parsePolicySpec("rung3:horizon=forever")).toThrow(/bad policy parameter/);
  });
});

describe("rung 3 flat Monte Carlo, pure parts", () => {
  it("scores a playout to game end as a win share (draw or cut 0.5) and one to the end of the round by V clamped at plus or minus 1000", async () => {
    const { playoutScore, MC_LENGTH } = await import("../../../src/sims/policies/lookahead.js");
    expect(playoutScore(MC_LENGTH.game, "won", null)).toBe(1);
    expect(playoutScore(MC_LENGTH.game, "lost", null)).toBe(0);
    expect(playoutScore(MC_LENGTH.game, "draw", null)).toBe(0.5);
    expect(playoutScore(MC_LENGTH.game, null, 12)).toBe(0.5);
    expect(playoutScore(MC_LENGTH.round, "won", null)).toBe(1000);
    expect(playoutScore(MC_LENGTH.round, "lost", null)).toBe(-1000);
    expect(playoutScore(MC_LENGTH.round, null, 7.5)).toBe(7.5);
    expect(playoutScore(MC_LENGTH.round, null, 5000)).toBe(1000);
  });

  it("names every playout's randomness by seed, seat, decision, candidate and playout, so a search replays", async () => {
    const { mcStreamKey } = await import("../../../src/sims/policies/lookahead.js");
    expect(mcStreamKey("2000001", 2, 57, 3, 1)).toBe("mc|2000001|2|57|3|1");
  });

  it("picks the best mean score; ties by the path's descriptors in code-point order", async () => {
    const { pickBestPath } = await import("../../../src/sims/policies/lookahead.js");
    expect(pickBestPath([{ path: ["play|b"], score: 0.5 }, { path: ["play|a"], score: 0.75 }]).path).toEqual(["play|a"]);
    expect(pickBestPath([{ path: ["play|b"], score: 0.5 }, { path: ["play|a", "card|x"], score: 0.5 }, { path: ["play|a", "card|w"], score: 0.5 }]).path).toEqual(["play|a", "card|w"]);
  });

  it("parses rung3mc names canonically", async () => {
    const { parsePolicySpec, policyHeader } = await import("../../../src/sims/policies/index.js");
    const h = policyHeader(parsePolicySpec("rung3mc:playout=rung1,n=2,length=game"));
    expect(h.spec).toBe("rung3mc:length=game,playout=rung1,n=2");
    expect(h.id).toBe("rung3-flat-mc");
    expect(policyHeader(parsePolicySpec(h.spec)).paramsSha256).toBe(h.paramsSha256);
    expect(() => parsePolicySpec("rung3mc:n=0")).toThrow(/n >= 1/);
  });
});

describe("fair lookahead mean (#183)", () => {
  it("averages the trials that scored, a decided game clamped at plus or minus 1000, so a win and a loss in two worlds give 0, not NaN", async () => {
    const { meanV, fairWorldKey } = await import("../../../src/sims/policies/lookahead.js");
    expect(meanV([Infinity, -Infinity])).toBe(0);
    expect(meanV([Infinity, 0])).toBe(500);
    expect(meanV([3, null, 5])).toBe(4);
    expect(meanV([null, null])).toBeNull();
    expect(fairWorldKey("7", 2, 41, 3)).toBe("fair-det|7|2|41|3");
  });
});
