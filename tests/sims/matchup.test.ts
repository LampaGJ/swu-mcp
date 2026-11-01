import { describe, expect, it } from "vitest";
import {
  MATCHUP_LIMITS,
  applySwaps,
  canonicalInput,
  endBoardTop,
  h2hPlan,
  jobKey,
  matchupLabel,
  opponentPlan,
  parseMatchupInput,
  renderResult,
  summarizeH2H,
  summarizeVsOpponent,
  validateDeck,
  type CardLookup,
  type SubjectGame,
} from "../../src/sims/matchup.js";

const deck = (extra: { cardKey: string; count: number }[] = []) => ({
  leader: "09010018",
  base: "09010024",
  cards: [
    ...Array.from({ length: 16 }, (_, i) => ({ cardKey: `0101${String(100 + i)}`, count: 3 })),
    { cardKey: "0101200", count: 2 },
    ...extra,
  ],
});

describe("simulate_matchup input (Zod v4 strict)", () => {
  it("parses a deck against the field with defaults", () => {
    const r = parseMatchupInput({ deck: deck(), opponent: "field" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input.mode).toBe("opponent");
    expect(r.input.games).toBe(MATCHUP_LIMITS.gamesDefault);
    expect(r.input.seed).toBe("1");
  });

  it("rejects unknown keys, a bad swap, and games over the cap with plain messages", () => {
    const extra = parseMatchupInput({ deck: deck(), opponent: "field", colour: "red" });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.error).toMatch(/colour/);
    const swap = parseMatchupInput({ deck: deck(), variant: ["0101100-0101300"] });
    expect(swap.ok).toBe(false);
    if (!swap.ok) expect(swap.error).toMatch(/OUT>IN/);
    const many = parseMatchupInput({ deck: deck(), opponent: "field", games: MATCHUP_LIMITS.gamesMax + 2 });
    expect(many.ok).toBe(false);
  });

  it("needs exactly one comparison: opponent, opponentDeck or variant (variant may add opponent)", () => {
    expect(parseMatchupInput({ deck: deck() }).ok).toBe(false);
    const noDeck = parseMatchupInput({ opponent: "field" });
    expect(noDeck.ok).toBe(false);
    if (!noDeck.ok) expect(noDeck.error).toMatch(/give deck/);
    expect(parseMatchupInput({ deck: deck(), opponentDeck: deck(), opponent: "field" }).ok).toBe(false);
    expect(parseMatchupInput({ deck: deck(), opponentDeck: deck(), variant: ["0101100>0101300"] }).ok).toBe(false);
    const h = parseMatchupInput({ deck: deck(), variant: ["0101100>0101300"] });
    expect(h.ok && h.input.mode).toBe("h2h");
    const v = parseMatchupInput({ deck: deck(), variant: ["0101100>0101300"], opponent: "field" });
    expect(v.ok && v.input.mode).toBe("variant-vs-opponent");
    const o = parseMatchupInput({ deck: deck(), opponentDeck: deck() });
    expect(o.ok && o.input.mode).toBe("h2h");
  });

  it("caps the games a job may play", () => {
    const r = parseMatchupInput({ deck: deck(), opponent: "field", variant: ["0101100>0101300"], games: 400 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 3000 games/);
  });
});

describe("deck checks", () => {
  const cards: Record<string, { type: string; title: string }> = { "09010018": { type: "Leader", title: "The Warrior" }, "09010024": { type: "Base", title: "Origin Tree" } };
  const lookup: CardLookup = (k) => cards[k] ?? (k.startsWith("0101") ? { type: "Unit", title: `card ${k}` } : undefined);

  it("accepts a 50-card Premier deck", () => {
    expect(validateDeck(deck(), lookup)).toBeNull();
  });

  it("rejects a short deck, an unknown card, a leader in the wrong slot and four copies", () => {
    expect(validateDeck({ ...deck(), cards: deck().cards.slice(1) }, lookup)).toMatch(/47 cards.*50 to 60/);
    expect(validateDeck(deck([{ cardKey: "9999999", count: 1 }]), lookup)).toMatch(/no card with cardKey 9999999/);
    expect(validateDeck({ ...deck(), leader: "09010024" }, lookup)).toMatch(/leader 09010024 is a Base/);
    expect(validateDeck(deck([{ cardKey: "0101100", count: 1 }]), lookup)).toMatch(/4 copies of 0101100/);
  });
});

describe("cache key", () => {
  const pins = { codeCommit: "abc1234", engineCommit: "445792e", cardDataSha256: "f".repeat(64), gateRecordSha256: "e".repeat(64) };
  const parse = (x: unknown) => {
    const r = parseMatchupInput(x);
    if (!r.ok) throw new Error(r.error);
    return r.input;
  };

  it("ignores card order and duplicate rows, and depends on seed, policy and every pin", () => {
    const a = parse({ deck: deck(), opponent: "field" });
    const shuffled = { ...deck(), cards: [...deck().cards].reverse() };
    const b = parse({ deck: shuffled, opponent: "field" });
    expect(jobKey(canonicalInput(a, "rung3:k=8"), pins)).toBe(jobKey(canonicalInput(b, "rung3:k=8"), pins));
    const split = { ...deck(), cards: [...deck().cards.slice(0, -1), { cardKey: "0101200", count: 1 }, { cardKey: "0101200", count: 1 }] };
    expect(canonicalInput(parse({ deck: split, opponent: "field" }), "rung1")).toEqual(canonicalInput(a, "rung1"));
    const k = jobKey(canonicalInput(a, "rung3:k=8"), pins);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(jobKey(canonicalInput(parse({ deck: deck(), opponent: "field", seed: 2 }), "rung3:k=8"), pins)).not.toBe(k);
    expect(jobKey(canonicalInput(a, "rung1"), pins)).not.toBe(k);
    expect(jobKey(canonicalInput(a, "rung3:k=8"), { ...pins, codeCommit: "def5678" })).not.toBe(k);
    expect(jobKey(canonicalInput(a, "rung3:k=8"), { ...pins, engineCommit: "0000000" })).not.toBe(k);
  });
});

describe("variant swaps and pairing", () => {
  it("applies OUT>IN one copy each by cardKey and refuses a card the deck lacks", () => {
    const v = applySwaps(deck(), ["0101100>0101300", "0101100>0101300"]);
    expect(v.cards.find((c) => c.cardKey === "0101100")?.count).toBe(1);
    expect(v.cards.find((c) => c.cardKey === "0101300")?.count).toBe(2);
    expect(() => applySwaps(deck(), ["0109999>0101300"])).toThrow(/0109999 is not in the deck/);
  });

  it("plays each head-to-head seed twice with the seats swapped, plus a mirror on the same seeds", () => {
    const plan = h2hPlan("7", 3);
    expect(plan.pairs.map((p) => p.seed)).toEqual(["7|h2h|0", "7|h2h|1", "7|h2h|2"]);
    expect(plan.mirror).toEqual(["7|h2h|0", "7|h2h|1", "7|h2h|2"]);
  });

  it("gives both decks of a variant comparison the same opponent seed and seat", () => {
    const plan = opponentPlan("7", [{ stratum: "t001", index: 0 }, { stratum: "t001", index: 1 }, { stratum: "rest-of-field", index: 0 }]);
    expect(plan).toEqual([
      { stratum: "t001", index: 0, seed: "7|t001|0", subjectSeat: 1 },
      { stratum: "t001", index: 1, seed: "7|t001|1", subjectSeat: 2 },
      { stratum: "rest-of-field", index: 0, seed: "7|rest-of-field|0", subjectSeat: 1 },
    ]);
  });
});

const g = (stratum: string, won: boolean | null, end = won === null ? "draw" : "base_destroyed", board: string[] = ["A"]): SubjectGame => ({ stratum, won, endCondition: end, rounds: 6, endBoard: board });

describe("summaries", () => {
  it("summarizes one archetype with Wilson and the draw and error rates", () => {
    const games = [g("t001", true), g("t001", true), g("t001", false), g("t001", null), g("t001", null, "error")];
    const s = summarizeVsOpponent(games, [{ id: "t001", name: "Krennic", weight: 1 }], { field: false, seed: "1" });
    expect(s).toMatchObject({ n: 3, wins: 2, winShare: 0.6667, drawRate: 0.2, errorRate: 0.2, meanRounds: 6 });
    expect(s.wilson95).not.toBeNull();
    expect(s.perArchetype).toHaveLength(1);
    expect(s.perArchetype[0]).toMatchObject({ id: "t001", n: 3, wins: 2 });
  });

  it("weights field strata by share, with rest-of-field its own row", () => {
    const games = [...Array.from({ length: 10 }, () => g("t001", true)), ...Array.from({ length: 10 }, () => g("rest-of-field", false))];
    const s = summarizeVsOpponent(games, [{ id: "t001", name: "Krennic", weight: 0.25 }, { id: "rest-of-field", name: "the rest", weight: 0.75 }], { field: true, seed: "1" });
    expect(s.winShare).toBe(0.25);
    expect(s.rawShare).toBe(0.5);
    expect(s.interval95?.method).toMatch(/bootstrap/);
    expect(s.perArchetype.map((r) => r.id)).toEqual(["t001", "rest-of-field"]);
  });

  it("names the most common end-board cards", () => {
    expect(endBoardTop([g("x", true, "base_destroyed", ["B", "A"]), g("x", true, "base_destroyed", ["B"])], 2)).toEqual([
      { cardKey: "B", games: 2 },
      { cardKey: "A", games: 1 },
    ]);
  });

  it("scores a head-to-head with the sign test and a mirror control", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ seed: `s${i}`, a: i < 10 ? (1 as const) : (2 as const), b: i < 10 ? (2 as const) : (1 as const) }));
    const s = summarizeH2H(pairs, [1, 2, 1, 2, null]);
    expect(s.deckShare.wins).toBe(20);
    expect(s.deckShare.n).toBe(24);
    expect(s.discordant).toMatchObject({ deckWonBoth: 10, otherWonBoth: 2 });
    expect(s.mirror).toMatchObject({ games: 5, nonDecisive: 1 });
    expect(s.mirror.seat1Share.share).toBe(0.5);
  });
});

describe("rendering", () => {
  it("labels bot play, marks the status candidate and hashes the output", () => {
    const out = renderResult({ body: { mode: "opponent", n: 3 }, policy: "rung3:k=8", inputHash: "a".repeat(64), codeCommit: "abc1234", engine: { commit: "445792e", cardDataVersion: "v" }, seed: "1", policyVersion: "1" });
    expect(out.label).toBe(matchupLabel("rung3:k=8"));
    expect(out.label).toBe("bot play (forceteki rung3:k=8), not human results");
    expect(out.status).toBe("candidate");
    expect(out.replay.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.replay.rungs).toEqual(["rung3:k=8", "rung3:k=8"]);
    const again = renderResult({ body: { mode: "opponent", n: 3 }, policy: "rung3:k=8", inputHash: "a".repeat(64), codeCommit: "abc1234", engine: { commit: "445792e", cardDataVersion: "v" }, seed: "1", policyVersion: "1" });
    expect(again.replay.outputHash).toBe(out.replay.outputHash);
  });
});
