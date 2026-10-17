import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTags } from "../../src/ability-grammar/tags.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { uncoveredOffers } from "../../src/synergy/run.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import { COMMITTED_TABLE } from "./fixtures.js";

/** Real feature records named in docs/verification/2026-10-17-round2.md and the #14 example pairs (see the file's `source`). */
const raw = (JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "real-cards-14.json"), "utf8")) as { cards: Record<string, unknown>[] }).cards;
const withFreshTags = (rec: Record<string, unknown>): Record<string, unknown> => {
  const input = { ...rec };
  delete input.tags;
  return { ...rec, tags: buildTags(input as unknown as Parameters<typeof buildTags>[0]) };
};
const REAL = synergyCardsSchema.parse(raw.map(withFreshTags));
const graph = buildPairGraph(REAL, COMMITTED_TABLE);
const byKey = new Map(REAL.map((c) => [c.cardKey, c]));
/** Rows linking offerer a to wanter b; the direction is the point of most checks below. */
const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];
const offersOf = (k: string): string[] => (byKey.get(k) as SynergyCard).tags.offers.map((t) => t.tag);
const wantsOf = (k: string): string[] => (byKey.get(k) as SynergyCard).tags.wants.map((t) => t.tag);
const retag = (k: string, edit: (json: string) => string): ReturnType<typeof buildTags> => {
  const rec = raw.find((c) => c.cardKey === k) as Record<string, unknown>;
  const input = JSON.parse(edit(JSON.stringify(rec))) as Record<string, unknown>;
  delete input.tags;
  return buildTags(input as unknown as Parameters<typeof buildTags>[0]);
};

describe("every offer tag is a decision (#14)", () => {
  const ISSUE_TAGS = [
    "has-when-played", "buff", "grant-sentinel", "give-shield-self", "exhaust-any", "give-advantage", "grant-raid", "give-weakness",
    "discard-opponent", "defeat-upgrade", "grant-ambush", "grant-grit", "grant-hidden", "grant-overwhelm", "grant-restore", "grant-saboteur",
    "grant-shielded", "grant-support", "capture", "return-from-discard", "mill-opponent", "bounce-enemy",
  ].map((t) => `offers:${t}`);
  const fed = new Set(COMMITTED_TABLE.rows.flatMap((r) => Object.keys(r.offers)));
  const noted = new Set((COMMITTED_TABLE.feedsNothing ?? []).map((n) => n.tag));

  it.each(ISSUE_TAGS)("%s has a row or a note", (tag) => {
    expect(fed.has(tag) || noted.has(tag)).toBe(true);
  });

  it("never lists a tag both as fed and as feeding nothing", () => {
    expect([...noted].filter((t) => fed.has(t))).toEqual([]);
  });

  it("reports an offer with neither a row nor a note", () => {
    const stray = { ...REAL[0], tags: { offers: [{ tag: "offers:made-up", why: "x" }], wants: [] } } as SynergyCard;
    expect(uncoveredOffers([stray], COMMITTED_TABLE)).toEqual(["offers:made-up"]);
  });

  it("leaves no offer on the real cards unexplained", () => {
    expect(uncoveredOffers(REAL, COMMITTED_TABLE)).toEqual([]);
  });
});

describe("rows added for #14 link their real example pairs", () => {
  const pairs: [string, string, string][] = [
    ["0101033", "05010197", "when-played-repeater"],
    ["04010195", "06010263", "exhaust-enemy-payoff"],
    ["09010002", "09010200", "weaken-enemy-payoff"],
    ["08010090", "08010161", "own-upgrade-defeat-watcher"],
    ["04010176", "06010144", "enemy-base-damage-payoff"],
    ["04010058", "06010032", "grant-sentinel-payoff"],
    ["05010010", "05010211", "grant-hidden-payoff"],
    ["07010093", "08010064", "grant-shielded-payoff"],
  ];
  it.each(pairs)("%s > %s links through %s", (a, b, row) => {
    expect(rowsOf(a, b)).toContain(row);
  });
});

describe("tag source fixes (#14, #15 RC06)", () => {
  it("keeps no bare 'wants:trait-' tag when a restriction names no trait", () => {
    const tags = retag("05010111", (j) => j.replaceAll('"trait:Force"', '"trait:"'));
    expect(tags.wants.map((t) => t.tag).filter((t) => t === "wants:trait-" || t.endsWith("-"))).toEqual([]);
  });

  it("makes no tag from an unnamed token (Moff Jerjerrod's 'twice that number of tokens')", () => {
    expect(offersOf("08010094")).not.toContain("offers:create-token-token");
  });

  it("tells a Weakness given to your own unit from one given to the enemy's", () => {
    expect(offersOf("09010199")).toContain("offers:give-weakness-own");
    expect(offersOf("09010199")).not.toContain("offers:give-weakness");
    expect(offersOf("09010197")).toContain("offers:give-weakness-enemy");
  });

  it("keeps a Shield given to 'this unit' away from the shared give-shield class", () => {
    expect(offersOf("07010052")).toContain("offers:give-shield-self");
    expect(offersOf("07010052")).not.toContain("offers:give-shield");
    expect(rowsOf("07010052", "08010253")).not.toContain("upgrade-stacking");
  });

  it("separates a watcher of the opponent's draws from one of your own draws", () => {
    expect(wantsOf("04010111")).toContain("wants:opponent-draws");
    expect(wantsOf("04010111")).not.toContain("wants:draw");
    expect(rowsOf("09010189", "04010111")).not.toContain("draw-hand-size");
    expect(rowsOf("05010059", "04010111")).not.toContain("draw-hand-size");
  });

  it("does not offer damage to a unit the same clause just created", () => {
    expect(offersOf("09010153")).not.toContain("offers:damage-any-unit");
    expect(rowsOf("09010153", "08010175")).not.toContain("ping-own-damage-payoff");
  });
});

describe("pairing respects qualifiers (#15 RC06)", () => {
  it("does not return a 5-cost Darth Sion with a bounce limited to cost 3 or less (Rio Durant)", () => {
    expect(rowsOf("07010093", "06010035")).not.toContain("bounce-replay");
  });

  it("does not hand a Pilot back to you when Force Speed returns the enemy defender's upgrades", () => {
    expect(rowsOf("05010205", "04010101")).not.toContain("upgrade-return-reattach");
  });
});
