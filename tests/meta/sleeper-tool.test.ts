import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import type { CardRow, CardStore } from "../../src/data.js";
import { analyseSleepers, DEFAULT_SLEEPER_OPTIONS } from "../../src/meta/sleepers.js";
import { sleepersFileSchema, type SleepersFile } from "../../src/meta/sleepers-schema.js";
import { pairedEffect, SIM_CAVEAT, simRecordSchema, simulatorView } from "../../src/meta/sleepers-sim.js";
import type { ToolResult } from "../../src/tools.js";
import { sleeperCards } from "../../src/tools/sleepers.js";
import { fixture } from "./sleeper-fixtures.js";

const row = (cardKey: string, title: string, type: string, aspects: string | null): CardRow => ({
  cardKey,
  title,
  subtitle: null,
  type,
  cost: type === "Unit" ? 3 : null,
  power: null,
  hp: null,
  aspects,
  traits: null,
  keywords: null,
  arenas: null,
  text: null,
  sets: "SEC",
});
const rows = [
  row("L1", "First Leader", "Leader", "Command"),
  row("L2", "Second Leader", "Leader", "Command"),
  row("B1", "Green Base", "Base", "Vigilance"),
  row("good", "Good Card", "Unit", "Command"),
  row("skilled", "Skilled Card", "Unit", "Command"),
  row("n1", "Plain Card", "Unit", "Command"),
  row("n2", "Other Card", "Unit", "Command"),
];
const store: CardStore = {
  dataDir: "/nonexistent/sleepers",
  cards: rows,
  byKey: new Map(rows.map((r) => [r.cardKey, r])),
  facets: new Map(),
};

const simRecord = (rung: number, spec: string, variantOnly: number) =>
  simRecordSchema.parse({
    label: "bot play",
    policy: { spec, rung },
    results: [
      { name: "base", swaps: [], share: { wins: 50, n: 100 }, vsFirst: null },
      {
        name: "plain-to-good",
        swaps: ["SEC_010>SEC_020"],
        share: { wins: 50 + variantOnly - 10, n: 100 },
        vsFirst: { baseOnly: 10, variantOnly, pValue: 0.05 },
      },
    ],
  });
const ids: Record<string, string> = { SEC_010: "n1", SEC_020: "good" };

function sleepersFile(): SleepersFile {
  const analysis = analyseSleepers(
    fixture({ good: { boost: 0.12, rate: 0.25 }, skilled: { skillBoost: 0.2, rate: 0.4 }, n1: { rate: 0.3 }, n2: { rate: 0.5 } }).map(
      (d) => ({
        ...d,
        baseAspects: ["Vigilance"],
      }),
    ),
    { ...DEFAULT_SLEEPER_OPTIONS, replicates: 100, nullReplicates: 50, cardInfo: (k) => ({ title: `title ${k}`, rotated: k === "n2" }) },
  );
  return sleepersFileSchema.parse({
    schemaVersion: 1,
    source: "swumetastats.com",
    population: "tournament decklists with their whole-event match record",
    precedence: "D21 tier 1",
    window: { from: "2026-01-01", to: "2026-03-01" },
    periods: [{ label: "P1", from: "2026-01-01", to: "2026-03-01", decks: analysis.counts.decks, events: analysis.counts.events }],
    counts: analysis.counts,
    method: {
      unit: "u",
      outcome: "o",
      comparison: "c",
      interval: "i",
      coverage: 0.95,
      test: "t",
      fdr: "f",
      q: 0.1,
      replicates: 100,
      seed: "s",
      minDecks: 20,
      minEvents: 5,
      minTierDecks: 10,
      minPlayers: 10,
      skill: { definition: "d", ...analysis.skill },
      nullCheck: analysis.nullCheck,
      verdicts: "v",
    },
    global: analysis.global,
    aspects: analysis.aspects,
    archetypes: analysis.archetypes,
    simulator: simulatorView(
      [
        { name: "r1.json", sha256: "a".repeat(64), record: simRecord(1, "rung1", 30) },
        { name: "r3.json", sha256: "b".repeat(64), record: simRecord(3, "rung3:k=8", 20) },
      ],
      (id) => ids[id],
      "test deck",
      "test opponents",
    ),
  });
}

const file = sleepersFile();
const read = (result: ToolResult): Record<string, unknown> => {
  expect(result.isError, result.content[0].text).toBeUndefined();
  return decode(result.content[0].text) as Record<string, unknown>;
};
type Card = Record<string, unknown> & { cardKey: string };

describe("pairedEffect", () => {
  it("is (variantOnly - baseOnly) / n with the discordant-pair standard error", () => {
    const { effect, se } = pairedEffect(10, 30, 100);
    expect(effect).toBeCloseTo(0.2, 10);
    expect(se).toBeCloseTo(Math.sqrt((0.4 - 0.04) / 100), 10);
  });
});

describe("simulatorView", () => {
  it("labels both roles, keeps the pilot apart and computes the lookahead-minus-rules difference", () => {
    const sim = file.simulator;
    expect(sim?.caveat).toBe(SIM_CAVEAT);
    expect(sim?.cards.good.effects.map((e) => [e.role, e.pilotKind])).toEqual([
      ["added", "rules"],
      ["added", "lookahead"],
    ]);
    expect(sim?.cards.n1.effects[0].role).toBe("removed");
    expect(sim?.cards.good.pilotSensitivity[0].value).toBeCloseTo(-0.1, 4);
  });
});

describe("sleeper_cards", () => {
  it("lists the planted sleeper for the whole field with its range, decks and status candidate", () => {
    const out = read(sleeperCards(store, "test/0", file, {}));
    const cards = out.cards as Card[];
    expect(cards.map((c) => c.cardKey)).toContain("good");
    const good = cards.find((c) => c.cardKey === "good") as Card;
    expect(good.title).toBe("Good Card");
    expect(good.verdict).toBe("sleeper");
    expect(good.status).toBe("candidate");
    expect(good.decksWith).toBeGreaterThan(20);
    expect(String(good.rangePts)).toMatch(/^-?\d+(\.\d)?\.\.-?\d+(\.\d)?$/);
    expect(out.precedence).toBe("D21 tier 1");
    expect(out.simulatorCaveat).toBe(SIM_CAVEAT);
    expect((good.simulator as unknown[]).length).toBe(2);
  });

  it("lists a card whose gap holds inside the same players' own decks before any card whose gap does not", () => {
    const cards = read(sleeperCards(store, "test/0", file, { limit: 100 })).cards as Card[];
    const holds = cards.map((c) => c.holdsForSamePlayers === true);
    expect(holds.some(Boolean)).toBe(true);
    expect(holds.indexOf(false) === -1 || holds.lastIndexOf(true) < holds.indexOf(false)).toBe(true);
  });

  it("flags the skill-dependent card as helping strong players more", () => {
    const cards = read(sleeperCards(store, "test/0", file, {})).cards as Card[];
    expect(cards.find((c) => c.cardKey === "skilled")?.skilledEdge).toBe(true);
  });

  it("scopes to one leader and base, and to an aspect set", () => {
    const one = read(sleeperCards(store, "test/0", file, { leader: "L1", base: "B1", show: "all" }));
    expect((one.scope as { kind: string }).kind).toBe("leader-base");
    expect(String((one.scope as { label: string }).label)).toContain("First Leader");
    const asp = read(sleeperCards(store, "test/0", file, { aspects: ["Vigilance", "Command"], show: "all" }));
    expect((asp.scope as { kind: string }).kind).toBe("aspects");
    expect((asp.cards as Card[]).length).toBeGreaterThan(0);
  });

  it("applies minDecks and limit, and show all ranks by lower bound", () => {
    const all = read(sleeperCards(store, "test/0", file, { show: "all", limit: 2 }));
    expect((all.cards as Card[]).length).toBe(2);
    const none = read(sleeperCards(store, "test/0", file, { show: "all", minDecks: 100000 }));
    expect(none.measured).toBe(0);
  });

  it("hides a rotated card unless asked, and names it from the data product when the card list lacks it", () => {
    const hidden = read(sleeperCards(store, "test/0", file, { show: "all", limit: 100 }));
    expect((hidden.cards as Card[]).map((c) => c.cardKey)).not.toContain("n2");
    expect(hidden.rotatedHidden).toBe(1);
    const shown = read(sleeperCards(store, "test/0", file, { show: "all", limit: 100, includeRotated: true }));
    const n2 = (shown.cards as Card[]).find((c) => c.cardKey === "n2") as Card;
    expect(n2.rotated).toMatch(/rotated out/);
    const noName = { ...store, byKey: new Map([...store.byKey].filter(([k]) => k !== "n2")) };
    const fromFile = (read(sleeperCards(noName, "test/0", file, { show: "all", limit: 100, includeRotated: true })).cards as Card[]).find(
      (c) => c.cardKey === "n2",
    );
    expect(fromFile?.title).toBe("title n2");
  });

  it("fails with a reason for a half-given scope, an unknown pair and a package without the file", () => {
    expect(sleeperCards(store, "test/0", file, { leader: "L1" }).isError).toBe(true);
    expect(sleeperCards(store, "test/0", file, { aspects: ["Aggression"] }).isError).toBe(true);
    const missing = sleeperCards(store, "test/0", null, {});
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("pnpm meta:sleepers");
  });
});
