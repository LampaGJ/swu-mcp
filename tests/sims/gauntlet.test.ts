import { describe, expect, it } from "vitest";
import {
  FAIR_RUNG,
  buildTournamentPanel,
  calibrationLabel,
  controlVerdict,
  deadCardControl,
  gauntletLabel,
  planGauntlet,
  rankIdeas,
  renderReport,
  selectForConfirm,
  summarizeIdea,
  type GameOutcome,
  type PanelCandidate,
} from "../../src/sims/gauntlet.js";
import { canonicalJson } from "../../src/swu/canonical.js";

const cards = (prefix: string): [string, number][] => [...Array.from({ length: 16 }, (_, i) => [`${prefix}${String(i).padStart(4, "0")}`, 3] as [string, number]), [`${prefix}9999`, 2]];

function cand(over: Partial<PanelCandidate> & Pick<PanelCandidate, "leader" | "baseAspects">): PanelCandidate {
  return { base: "04010020", event: "swumetastats:1", eventSize: 64, date: "2026-10-20", placement: 5, record: { wins: 5, losses: 2, draws: 0 }, cards: cards("0101"), unmappedLines: 0, ...over };
}

const WINDOW = { from: "2026-10-09", to: "2026-11-01", label: "Homeworlds" };

describe("tournament-winner panel", () => {
  const candidates: PanelCandidate[] = [
    // Archetype A: the 1st-place list wins over a better record placed lower.
    cand({ leader: "05010006", baseAspects: ["Command"], placement: 3, record: { wins: 8, losses: 0, draws: 0 }, event: "swumetastats:7" }),
    cand({ leader: "05010006", baseAspects: ["Command"], placement: 1, record: { wins: 6, losses: 1, draws: 0 }, event: "swumetastats:9", cards: cards("0201") }),
    cand({ leader: "05010006", baseAspects: ["Command"], placement: null, record: null, event: "swumetastats:3" }),
    // Archetype B (most lists): no usable placement, so the best record wins.
    cand({ leader: "04010006", baseAspects: ["Aggression"], placement: null, record: { wins: 4, losses: 3, draws: 0 }, event: "swumetastats:2" }),
    cand({ leader: "04010006", baseAspects: ["Aggression"], placement: null, record: { wins: 6, losses: 1, draws: 0 }, event: "swumetastats:4", cards: cards("0301") }),
    // Archetype C: its 1st place cannot be built by the engine, so the 2nd place stands in.
    cand({ leader: "07010008", baseAspects: ["Vigilance"], placement: 1, event: "swumetastats:5", cards: cards("0999") }),
    cand({ leader: "07010008", baseAspects: ["Vigilance"], placement: 2, event: "swumetastats:6", cards: cards("0401") }),
    // Archetype D: one list, outside the top 3.
    cand({ leader: "09010003", baseAspects: ["Cunning"], placement: 1 }),
    // Outside the window: never counted.
    cand({ leader: "09010003", baseAspects: ["Cunning"], placement: 1, date: "2026-09-01" }),
    cand({ leader: "09010003", baseAspects: ["Cunning"], placement: 1, date: "2026-09-02" }),
    cand({ leader: "09010003", baseAspects: ["Cunning"], placement: 1, date: "2026-09-03" }),
    // Unresolved card lines or no base: counted in the share, never a panel deck.
    cand({ leader: "04010006", baseAspects: ["Aggression"], placement: 1, unmappedLines: 2 }),
    cand({ leader: "04010006", baseAspects: ["Aggression"], placement: 1, base: null }),
  ];
  const unbuildable = (deck: { cards: readonly { cardKey: string }[] }): string[] => deck.cards.filter((c) => c.cardKey.startsWith("0999")).map((c) => c.cardKey);
  const build = (xs: PanelCandidate[]) => buildTournamentPanel(xs, { top: 3, window: WINDOW, unbuildable, referenceLeaders: ["05010006", "09010003", "01010001"] });

  it("is byte-identical whatever order the decklists arrive in", () => {
    const a = canonicalJson(build(candidates));
    expect(canonicalJson(build([...candidates].reverse()))).toBe(a);
    expect(canonicalJson(build([...candidates.slice(5), ...candidates.slice(0, 5)]))).toBe(a);
  });

  it("takes the top archetypes by lists in the window and the best-placed buildable list of each", () => {
    const p = build(candidates);
    expect(p.listsInWindow).toBe(10);
    expect(p.entries.map((e) => e.archetype.key)).toEqual(["04010006|Aggression", "05010006|Command", "07010008|Vigilance"]);
    const [b, a, c] = p.entries;
    expect(a.placement).toBe(1);
    expect(a.event).toBe("swumetastats:9");
    expect(a.deck.cards[0].cardKey.startsWith("0201")).toBe(true);
    expect(b.placement).toBeNull();
    expect(b.record).toBe("6-1-0");
    expect(c.placement).toBe(2);
    expect(c.setAsideUnbuildable).toBe(1);
    expect(p.entries.map((e) => e.id)).toEqual(["p01", "p02", "p03"]);
  });

  it("weights the strata by their share of the window, summing to one", () => {
    const p = build(candidates);
    expect(p.entries.reduce((s, e) => s + e.weight, 0)).toBeCloseTo(1, 4);
    expect(p.entries[0].archetype.share).toBeCloseTo(4 / 10, 4);
  });

  it("names event, placement, record and date, and never a deck id or a player", () => {
    const p = build(candidates);
    expect(JSON.stringify(p)).not.toMatch(/guid|player/i);
    for (const e of p.entries) expect(Object.keys(e).sort()).toEqual(["archetype", "date", "deck", "event", "eventSize", "id", "placement", "record", "setAsideUnbuildable", "weight"]);
  });

  it("gives each named leader its best tournament list in the window, or null", () => {
    const p = build(candidates);
    expect(p.references.map((r) => [r.leader, r.entry?.event ?? null])).toEqual([
      ["01010001", null],
      ["05010006", "swumetastats:9"],
      ["09010003", "swumetastats:1"],
    ]);
  });
});

const deck = (leader: string, prefix: string) => ({ leader, base: "04010020", cards: Array.from({ length: 25 }, (_, i) => ({ cardKey: `${prefix}${String(i).padStart(4, "0")}`, count: 2 })) });

describe("dead-card control", () => {
  const cost = (k: string): number | null => Number(k.slice(-2));

  it("swaps four copies for the dead card when the copy limit allows", () => {
    const c = deadCardControl(deck("05010006", "0501"), { deadCard: "09010093", want: 4, copiesMax: 4, costOf: cost });
    expect(c.swaps).toHaveLength(4);
    expect(c.deck.cards.find((x) => x.cardKey === "09010093")?.count).toBe(4);
  });

  it("falls back to three swaps under the three-copy limit, taking copies from the most-played, costliest cards first", () => {
    const base = deck("05010006", "0501");
    const ref = { ...base, cards: [...base.cards.slice(1), { cardKey: "05010000", count: 3 }] };
    const c = deadCardControl(ref, { deadCard: "09010093", want: 4, copiesMax: 3, costOf: cost });
    expect(c.swaps).toEqual(["05010000>09010093", "05010024>09010093", "05010023>09010093"]);
    expect(c.note).toMatch(/three/);
    expect(c.deck.cards.reduce((s, x) => s + x.count, 0)).toBe(ref.cards.reduce((s, x) => s + x.count, 0));
  });
});

describe("gauntlet planning", () => {
  const panel = [
    { id: "p01", name: "A", weight: 0.6, deck: deck("05010006", "0601") },
    { id: "p02", name: "B", weight: 0.4, deck: deck("04010006", "0602") },
  ];
  const refs = [{ id: "ref-05010006", deck: deck("05010006", "0701") }];
  const ideas = [
    { id: "I1", deck: deck("05010006", "0801"), reference: "ref-05010006" },
    { id: "I2", deck: deck("05010006", "0802"), reference: "ref-05010006" },
  ];
  const plan = planGauntlet({ seed: "s1", h2hPairs: 3, fieldGames: 4, ideas, references: refs, panel });

  it("plays each idea against its reference in both seat orders, a mirror on the same seeds, and the panel", () => {
    const i1 = plan.ideas[0];
    expect(i1.h2h).toHaveLength(3);
    for (const pr of i1.h2h) {
      const a = plan.games[pr.a];
      const b = plan.games[pr.b];
      expect(a.seed).toBe(b.seed);
      expect(a.seats).toEqual(["I1", "ref-05010006"]);
      expect(b.seats).toEqual(["ref-05010006", "I1"]);
    }
    expect(i1.mirror.map((g) => plan.games[g].seed)).toEqual(i1.h2h.map((pr) => plan.games[pr.a].seed));
    expect(i1.mirror.every((g) => plan.games[g].seats[0] === "I1" && plan.games[g].seats[1] === "I1")).toBe(true);
    expect(i1.field).toHaveLength(8);
  });

  it("puts idea and reference on the same panel list, seed and seat in every field pair", () => {
    for (const f of plan.ideas[1].field) {
      const g = plan.games[f.idea];
      const r = plan.games[f.reference];
      expect(g.seed).toBe(r.seed);
      expect(g.seats.indexOf("I2")).toBe(r.seats.indexOf("ref-05010006"));
      expect(g.seats.filter((s) => s !== "I2")).toEqual(r.seats.filter((s) => s !== "ref-05010006"));
    }
  });

  it("plays the reference's field games once, shared by every idea with that reference", () => {
    expect(plan.ideas[0].field.map((f) => f.reference)).toEqual(plan.ideas[1].field.map((f) => f.reference));
    // Per idea: 3 pairs x 2 + 3 mirror + 8 field = 17; plus 8 reference field games once.
    expect(plan.games).toHaveLength(2 * 17 + 8);
    expect(new Set(plan.games.map((g) => g.key)).size).toBe(plan.games.length);
  });

  it("is deterministic", () => {
    expect(canonicalJson(planGauntlet({ seed: "s1", h2hPairs: 3, fieldGames: 4, ideas, references: refs, panel }))).toBe(canonicalJson(plan));
  });
});

describe("summarising and ranking", () => {
  const panel = [
    { id: "p01", name: "A", weight: 0.5, deck: deck("05010006", "0601") },
    { id: "p02", name: "B", weight: 0.5, deck: deck("04010006", "0602") },
  ];
  const refs = [{ id: "ref", deck: deck("05010006", "0701") }];
  const ideas = [
    { id: "strong", deck: deck("05010006", "0801"), reference: "ref" },
    { id: "weak", deck: deck("05010006", "0802"), reference: "ref" },
    { id: "even", deck: deck("05010006", "0803"), reference: "ref" },
  ];
  const plan = planGauntlet({ seed: "s", h2hPairs: 20, fieldGames: 30, ideas, references: refs, panel });
  const isPanel = (id: string): boolean => id.startsWith("p0");
  // Field: the reference wins its odd-index games, "strong" wins all, "weak" none, "even" copies the reference.
  // Head to head: "strong" always beats the reference, "weak" always loses, "even" splits by seat.
  const outcomes: GameOutcome[] = plan.games.map((g) => {
    const seatOf = (id: string): 1 | 2 => (g.seats[0] === id ? 1 : 2);
    const other = (id: string): 1 | 2 => (seatOf(id) === 1 ? 2 : 1);
    let winner: 1 | 2;
    if (g.seats[0] === g.seats[1]) winner = g.index % 2 === 0 ? 1 : 2;
    else if (!g.seats.some(isPanel)) {
      const idea = g.seats.find((s) => s !== "ref") as string;
      winner = idea === "strong" ? seatOf(idea) : idea === "weak" ? other(idea) : 1;
    } else {
      const subject = g.seats.find((s) => !isPanel(s)) as string;
      winner = subject === "strong" ? seatOf(subject) : subject === "weak" ? other(subject) : g.index % 2 === 1 ? seatOf(subject) : other(subject);
    }
    return { winner, endCondition: "base_destroyed", rounds: 7 };
  });
  const rows = plan.ideas.map((ip) => ({ id: ip.id, result: summarizeIdea(plan, ip, outcomes, panel, "s") }));

  it("reuses the relative summary: head to head, mirror and the paired field difference", () => {
    const [strong, weak, even] = rows.map((r) => r.result);
    expect(strong.headToHead.winShare).toBe(1);
    expect(strong.headToHead.mirror.games).toBe(20);
    expect(strong.field?.deckMinusVariant.difference).toBeCloseTo(0.5, 4);
    expect(even.field?.deckMinusVariant.difference).toBe(0);
    expect(weak.field?.deckMinusVariant.difference).toBeCloseTo(-0.5, 4);
  });

  it("ranks by the low end of the field difference interval, then the difference, then the id", () => {
    const ranked = rankIdeas(rows);
    expect(ranked.map((r) => r.id)).toEqual(["strong", "even", "weak"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(selectForConfirm(ranked, 2)).toEqual(["strong", "even"]);
  });

  it("detects a control only when its field interval sits wholly below zero", () => {
    expect(controlVerdict(rows[1].result).detected).toBe(true);
    expect(controlVerdict(rows[2].result).detected).toBe(false);
    expect(controlVerdict(rows[2].result).sentence).toMatch(/too small to rank/);
  });
});

describe("plain-language report", () => {
  const panel = [
    { id: "p01", name: "Krennic [Vigilance]", weight: 0.5, deck: deck("07010008", "0601") },
    { id: "p02", name: "Ahsoka [Vigilance]", weight: 0.5, deck: deck("04010006", "0602") },
  ];
  const plan = planGauntlet({ seed: "s", h2hPairs: 4, fieldGames: 4, ideas: [{ id: "I1", deck: deck("05010006", "0801"), reference: "ref" }, { id: "control-05010006", deck: deck("05010006", "0802"), reference: "ref" }], references: [{ id: "ref", deck: deck("05010006", "0701") }], panel });
  const outcomes: GameOutcome[] = plan.games.map((g) => ({ winner: g.seats[0] === "I1" ? 1 : g.seats[1] === "I1" ? 2 : 1, endCondition: "base_destroyed", rounds: 6 }));
  const idea = summarizeIdea(plan, plan.ideas[0], outcomes, panel, "s");
  const control = summarizeIdea(plan, plan.ideas[1], outcomes, panel, "s");
  const text = renderReport({
    run: "r1",
    stage: "screen",
    label: gauntletLabel("rung1"),
    calibration: calibrationLabel("rung1", true),
    fieldText: "8 tournament-winning decks",
    pilot: "rung1",
    sizes: { h2hPairs: 4, fieldGames: 4 },
    names: { I1: "T00-1 Snoke Ladder", ref: "Snoke reference" },
    referenceText: { ref: "Supreme Leader Snoke: swumetastats:1, place 11" },
    ranking: rankIdeas([{ id: "I1", result: idea }]),
    results: { I1: idea },
    references: { I1: "ref" },
    controls: [{ id: "control-05010006", reference: "ref", note: "the three-card version", result: control, verdict: controlVerdict(control) }],
    judges: new Map([["I1", { anonId: "I30", surprise: 4, win: 6, fits: 5, covers: 6, flags: "", risk: "slow" }]]),
    panelNames: Object.fromEntries(panel.map((p) => [p.id, p.name])),
  });

  it("leads with the exact label and the calibration caveat, and claims nothing VALUABLE", () => {
    expect(text).toContain(gauntletLabel("rung1"));
    expect(text).toContain("Spearman");
    expect(text).toMatch(/not a VALUABLE claim/);
  });

  it("speaks in wins per 100 games and puts the judges' scores beside the sims", () => {
    expect(text).toMatch(/1\. T00-1 Snoke Ladder \(I1\)/);
    expect(text).toMatch(/wins per 100 games/);
    expect(text).toMatch(/judges: likely to win 6, fits 5, surprise 4, covers 6/);
    expect(text).toMatch(/Krennic \[Vigilance\]/);
  });

  it("says whether the control was detected", () => {
    expect(text).toMatch(/control-05010006/);
    expect(text).toMatch(/detected|too small to rank/);
  });
});

describe("labels", () => {
  it("carries the issue's label and the calibration caveat on every output", () => {
    expect(gauntletLabel("rung1")).toBe("bot play (forceteki rung1), relative comparison on identical shuffles, not a human or tournament win rate");
    expect(calibrationLabel("rung1", true)).toMatch(/Spearman/);
    expect(calibrationLabel(FAIR_RUNG, false)).toMatch(/calibration unmeasured \(#183\)/);
  });
});
