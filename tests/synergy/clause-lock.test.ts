import { decode } from "@toon-format/toon";
import { describe, expect, it } from "vitest";
import type { CardRow, CardStore } from "../../src/data.js";
import { aspectGateOfClause, clauseLock, lockFields, lockSupply, offerLock } from "../../src/synergy/clause-lock.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { baseLockOfAll } from "../../src/synergy/locks.js";
import type { ToolResult } from "../../src/tools.js";
import { deckAudit, type DeckEnv } from "../../src/tools/deck.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

const withText = (key: string, text: string, spec: Parameters<typeof mk>[2] = {}) => mk(key, key, { ...spec, abilities: [{ repeat: "constant", text }] });
const leader = mk("L", "Leader", { type: "Leader", aspects: ["Cunning", "Heroism"], icons: ["Cunning", "Heroism"] });
const origin = mk("OT", "Origin Tree", { type: "Base", aspects: ["Command"], icons: ["Command"], traits: ["Kashyyyk"] });
const jundland = mk("JW", "Jundland Wastes", { type: "Base", aspects: ["Command"], icons: ["Command"], traits: ["Tatooine"] });

describe("aspectGateOfClause (#147)", () => {
  it("reads a modal bullet and a control condition, with one aspect or several", () => {
    expect(aspectGateOfClause("Vigilance unit, heal 2 damage from a base.")).toEqual({ aspects: ["Vigilance"], another: false });
    expect(aspectGateOfClause("While you control another Aggression unit, this unit gains Raid 2.")).toEqual({ aspects: ["Aggression"], another: true });
    expect(aspectGateOfClause("If you control a Command or Cunning unit, draw a card.")).toEqual({ aspects: ["Command", "Cunning"], another: false });
  });

  it("reads no gate from an upgrade ('instead'), a target, a leader-or-base condition or plain text", () => {
    expect(aspectGateOfClause("If you control a Command or Cunning unit, you may deal 5 damage to a ground unit instead.")).toBeNull();
    expect(aspectGateOfClause("Give an Experience token to another friendly Command unit.")).toBeNull();
    expect(aspectGateOfClause("While you control an Aggression leader or base, draw a card.")).toBeNull();
    expect(aspectGateOfClause("Defeat a non-leader unit.")).toBeNull();
  });
});

describe("clauseLock (#147, #150)", () => {
  const ritual = withText("RD", "While you control a Tatooine base, friendly units enter play ready.");
  const sabine = mk("SM", "Sabine's Masterpiece", {
    abilities: [{ repeat: "constant", text: "Vigilance unit, heal 2 damage from a base." }, { repeat: "constant", text: "Cunning unit, exhaust or ready a resource." }],
  });
  const nexu = withText("HN", "While you control another Aggression unit, this unit gains Raid 2.", { aspects: ["Aggression"] });

  it("names a base lock under another location and clears it under the named one", () => {
    expect(clauseLock(ritual, lockSupply(leader, origin, []))).toEqual({ baseLocked: ["Tatooine"], needsUnitAspect: [] });
    expect(clauseLock(ritual, lockSupply(leader, jundland, []))).toEqual({ baseLocked: [], needsUnitAspect: [] });
    expect(baseLockOfAll([ritual], origin)).toEqual({ names: ["Tatooine"], unmet: true });
    expect(baseLockOfAll([ritual], jundland)).toEqual({ names: [], unmet: false });
  });

  it("names the aspect-unit clauses the leader, base and deck do not supply, and not the ones they do", () => {
    expect(lockFields(clauseLock(sabine, lockSupply(leader, origin, [])))).toEqual({ needsUnitAspect: "Vigilance" });
    const vigilanceUnit = mk("VU", "Vigilance Unit", { aspects: ["Vigilance"] });
    expect(lockFields(clauseLock(sabine, lockSupply(leader, origin, [vigilanceUnit])))).toEqual({});
  });

  it("does not let a card meet its own 'another' condition", () => {
    expect(lockFields(clauseLock(nexu, lockSupply(leader, origin, [nexu])))).toEqual({ needsUnitAspect: "Aggression" });
    expect(lockFields(clauseLock(nexu, lockSupply(leader, origin, [mk("AU", "Other Aggression", { aspects: ["Aggression"] })])))).toEqual({});
  });

  it("only counts a Unit card of the deck, not an event of that aspect", () => {
    const event = mk("EV", "Vigilance Event", { type: "Event", aspects: ["Vigilance"] });
    expect(lockFields(clauseLock(sabine, lockSupply(leader, origin, [event])))).toEqual({ needsUnitAspect: "Vigilance" });
  });

  it("reads an offer's clause as the tags cite it, face prefix and all", () => {
    const supply = lockSupply(leader, origin, []);
    expect(offerLock("text: If you control a Tatooine base, you may return an upgrade.", "SC", supply).baseLocked).toEqual(["Tatooine"]);
    expect(offerLock("text: Vigilance unit, heal 2 damage from a base.", "SM", supply).needsUnitAspect).toEqual(["Vigilance"]);
    expect(offerLock("printed keyword Saboteur", "SC", supply)).toEqual({ baseLocked: [], needsUnitAspect: [] });
  });
});

describe("deck_audit feeders follow the locked ones (#147)", () => {
  const wanter = mk("W", "Grit Brute", { wants: ["wants:damage-friendly"], aspects: ["Command"], cost: 3 });
  const open = mk("F2", "Open Pinger", { offers: ["offers:damage-friendly-unit"], aspects: ["Command"], cost: 3, abilities: [{ repeat: "constant", text: "Deal 1 damage to a friendly unit." }] });
  const locked = mk("F1", "Locked Pinger", {
    offers: ["offers:damage-friendly-unit"], aspects: ["Command"], cost: 2,
    abilities: [{ repeat: "constant", text: "While you control a Tatooine base, deal 1 damage to a friendly unit." }],
  });
  const fillers = Array.from({ length: 10 }, (_, i) => mk(`FL${i}`, `Filler ${i}`, { aspects: ["Command"], cost: 2 }));
  const cards = [leader, origin, jundland, wanter, open, locked, ...fillers];
  const rows: CardRow[] = cards.map((c) => ({
    cardKey: c.cardKey, title: c.title, subtitle: null, type: c.type, cost: c.structured.cost, power: null, hp: null,
    aspects: c.structured.aspects.join("|") || null, traits: null, keywords: null, arenas: null, text: null, sets: "SEC",
  }));
  const store: CardStore = {
    dataDir: "/nonexistent/swu-lock-feeders", cards: rows, byKey: new Map(rows.map((r) => [r.cardKey, r])),
    facets: new Map([["expansion", [{ value: "SEC", cards: 0, definition: "Secrets of Power. Premier legal.", cardKeys: [] }]]]),
  };
  const env: DeckEnv = {
    store, ctx: createSynergyContext(cards, COMMITTED_TABLE),
    market: { prices: { priceImportId: 1, priceImportFinishedAt: "", coverage: "", cards: [] }, play: { source: "", note: "", windows: [], cards: [] }, priceByKey: new Map(), playByKey: new Map() },
    scores: new Map(), clusters: null, dataVersion: "test/0",
  };
  const feeders = (base: string): string => {
    const result: ToolResult = deckAudit(env, { leader: "L", base, decklist: [{ card: "W", count: 3 }] });
    expect(result.isError, result.content[0].text).toBeUndefined();
    return (decode(result.content[0].text) as any).orphanWants[0].feeders;
  };

  it("lists the locked feeder after the open one and names its lock", () => {
    expect(feeders("OT")).toBe("Open Pinger (3); Locked Pinger (2, baseLocked: Tatooine)");
  });

  it("restores the order and drops the lock under the base it names", () => {
    expect(feeders("JW")).toBe("Locked Pinger (2); Open Pinger (3)");
  });
});
