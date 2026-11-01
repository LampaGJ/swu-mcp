import { describe, expect, it } from "vitest";
import {
  MATCHUP_LIMITS,
  applySwaps,
  canonicalInput,
  endBoardTop,
  h2hPlan,
  jobKey,
  jobFileSchema,
  leaksHiddenInformation,
  matchupLabel,
  plannedGames,
  relativeLabel,
  relativeNotes,
  opponentPlan,
  parseMatchupInput,
  renderResult,
  summarizeH2H,
  summarizeRelative,
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

describe("relative mode (D108)", () => {
  const swap = ["0101100>0101300"];
  it("parses the second deck from variant or opponentDeck and adds the field only when opponent is given", () => {
    const v = parseMatchupInput({ deck: deck(), variant: swap, relative: true });
    expect(v.ok && v.input.mode).toBe("relative");
    expect(v.ok && plannedGames(v.input)).toBe(300);
    const f = parseMatchupInput({ deck: deck(), variant: swap, opponent: "field", relative: true, games: 50 });
    expect(f.ok && f.input.mode).toBe("relative");
    expect(f.ok && plannedGames(f.input)).toBe(3 * 50 + 2 * 7 * 50);
    const d = parseMatchupInput({ deck: deck(), opponentDeck: deck(), opponent: "t001", relative: true });
    expect(d.ok && d.input.mode).toBe("relative");
    expect(d.ok && plannedGames(d.input)).toBe(300 + 200);
  });

  it("refuses relative without a second deck, with two, and leaves the absolute rules alone when it is false", () => {
    const none = parseMatchupInput({ deck: deck(), opponent: "field", relative: true });
    expect(!none.ok && none.error).toMatch(/relative compares two decks: give variant or opponentDeck/);
    const two = parseMatchupInput({ deck: deck(), opponentDeck: deck(), variant: swap, relative: true });
    expect(!two.ok && two.error).toMatch(/not both/);
    expect(parseMatchupInput({ deck: deck(), opponentDeck: deck(), opponent: "field", relative: false }).ok).toBe(false);
    const abs = parseMatchupInput({ deck: deck(), variant: swap, relative: false });
    expect(abs.ok && abs.input.mode).toBe("h2h");
  });

  it("caps the games of a relative job like any other", () => {
    const r = parseMatchupInput({ deck: deck(), variant: swap, opponent: "field", relative: true, games: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 3000 games/);
  });

  it("keys a relative job apart from the absolute head-to-head and does not change an absolute key", () => {
    const rel = parseMatchupInput({ deck: deck(), variant: swap, relative: true });
    const abs = parseMatchupInput({ deck: deck(), variant: swap });
    if (!rel.ok || !abs.ok) throw new Error("parse");
    const pins = { codeCommit: "c", engineCommit: "e", cardDataSha256: "a".repeat(64), gateRecordSha256: "b".repeat(64) };
    expect(jobKey(canonicalInput(rel.input, "rung1"), pins)).not.toBe(jobKey(canonicalInput(abs.input, "rung1"), pins));
    expect(Object.keys(canonicalInput(abs.input, "rung1")).sort()).toEqual(["deck", "games", "mode", "opponent", "opponentDeck", "policy", "seed", "variant"]);
    expect(jobFileSchema.shape.input.safeParse(canonicalInput(rel.input, "rung1")).success).toBe(true);
  });

  it("labels exactly as the issue says and notes the hidden-card lookahead only for the rungs that have it (#183)", () => {
    expect(relativeLabel("rung3:k=8")).toBe("bot play (forceteki rung3:k=8), relative comparison on identical shuffles, not a human or tournament win rate");
    for (const spec of ["rung3", "rung3:k=8", "rung3v:k=8,ev=v1,horizon=round,noPass=1"]) expect(leaksHiddenInformation(spec)).toBe(true);
    for (const spec of ["rung1", "rung3mc:playout=rung1,n=2", "rung4:k=8"]) expect(leaksHiddenInformation(spec)).toBe(false);
    expect(relativeNotes("rung3:k=8").join(" ")).toMatch(/#183/);
    expect(relativeNotes("rung1")).toEqual([]);
    const out = renderResult({ label: relativeLabel("rung1"), body: { mode: "relative" }, policy: "rung1", inputHash: "a".repeat(64), codeCommit: "abc1234", engine: { commit: "445792e", cardDataVersion: "v" }, seed: "1", policyVersion: "1" });
    expect(out.label).toBe("bot play (forceteki rung1), relative comparison on identical shuffles, not a human or tournament win rate");
    expect(out.status).toBe("candidate");
  });

  const sg = (stratum: string, won: boolean | null, end = won === null ? "draw" : "base_destroyed"): SubjectGame => ({ stratum, won, endCondition: end, rounds: 6, endBoard: ["A"] });
  it("serves the head-to-head figures and the paired field difference, and no absolute win share for either deck", () => {
    const pairs = Array.from({ length: 12 }, (_, i) => ({ seed: `s${i}`, a: i < 10 ? (1 as const) : (2 as const), b: i < 10 ? (2 as const) : (1 as const) }));
    const h2hGames = pairs.flatMap((p) => [sg("h2h", p.a === 1), sg("h2h", p.b === 2)]);
    const strata = [{ id: "t1", name: "One", weight: 0.75 }, { id: "rest", name: "Rest", weight: 0.25 }];
    const deckG = [sg("t1", true), sg("t1", true), sg("t1", false), sg("t1", null), sg("rest", true), sg("rest", null, "error")];
    const varG = [sg("t1", false), sg("t1", true), sg("t1", true), sg("t1", true), sg("rest", false), sg("rest", true)];
    const out = summarizeRelative({ h2hPairs: pairs, mirrorWinners: [1, 2, 1, 2, null], h2hGames, field: { deck: deckG, variant: varG, strata }, seed: "7" });
    expect(out.headToHead).toMatchObject({ pairs: 12, n: 24, wins: 20, winShare: 0.8333, nonDecisive: 0, seedsWonBothOrders: { deck: 10, variant: 2 }, mirror: { games: 5, nonDecisive: 1 }, errorRate: 0 });
    expect(out.headToHead.seedsWonBothOrders.pValue).toBeCloseTo(0.0386, 3);
    expect(out.headToHead.wilson95?.low).toBeLessThan(0.8333);
    const f = out.field as NonNullable<typeof out.field>;
    expect(f).toMatchObject({ pairs: 4, bothWon: 1, bothLost: 0, undecided: 2, errorRate: 0.0833, pooledPairs: { deckOnlyWon: 2, variantOnlyWon: 1, pValue: 1 } });
    expect(f.perArchetype).toHaveLength(2);
    expect(f.perArchetype[0]).toMatchObject({ id: "t1", pairs: 3, deckOnlyWon: 1, variantOnlyWon: 1, difference: 0 });
    expect(f.deckMinusVariant.difference).toBe(0.25);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/variantDeck|"deck":\{/);
    expect(summarizeRelative({ h2hPairs: pairs, mirrorWinners: [], h2hGames, field: null, seed: "7" }).field).toBeNull();
  });
});
