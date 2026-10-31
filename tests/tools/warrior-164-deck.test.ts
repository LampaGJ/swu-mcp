import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS } from "../../src/tools/deck.js";
import { META_TOOLS, measuredBeforeUnmeasured, significantGain, type EvidenceClass } from "../../src/tools/meta.js";
import { readPenaltyRemovers, type RemovalCard } from "../../src/tools/penalty-removal.js";
import type { SynergyCard } from "../../src/synergy/schema.js";

// LampaGJ/swu-mcp#164, D82: meta_answers ranks measured answers first and quotes a whole mode, budget swaps of an upgrade
// fill every role, the audit's orphan feeders name the upgrades that attach to the unit, and a taxed carrier removes no penalty.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as { deck: { id: string; count: number }[] };
const DECKLIST = OWNER_DECK.deck.map((d) => ({ card: d.id, count: d.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const MON_CAL_CRUISER = "09010232";
const STOLEN_AT_HAULER = "04010221";
const BOWCASTER = "09010127";
const ASCENSION_CABLE = "05010215";
const CAD_BANE = "08010011";
const NEVARRO_CITY = "08010020";
/** The judged Cad Bane core (deck-session-dump-7-w16.txt line 1256). */
const CAD_CORE = [
  { card: "Marrok, Mysterious Warrior", count: 3 },
  { card: "Pre Vizsla, Strong-Willed Ruler", count: 3 },
  { card: "08010052", count: 3 },
  { card: "IG-2000, Assassin's Aggressor", count: 3 },
  { card: "No Glory, Only Results", count: 3 },
  { card: "Koska Reeves, Warrior of Mandalore", count: 3 },
  { card: "Justifier, Relentless", count: 3 },
  { card: "TIE Dagger Vanguard", count: 3 },
  { card: "HK-47, Exclamation: Die, Meatbag!", count: 3 },
  { card: "Onyx Squadron Brute", count: 3 },
  { card: "Ninth Sister, Hulking Inquisitor", count: 2 },
  { card: "Outer Rim Constable", count: 2 },
];

const real = hasData ? loadStore(builtRun as string) : (undefined as never);

describe.skipIf(!hasData)("meta_answers ranks on evidence and quotes a whole mode (#164 item 4, D82)", () => {
  const step3 = (): Record<string, any> => body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 10, archetypes: 6 }));

  it("an addition measured with a significant gain ranks before every unmeasured one (Stolen AT-Hauler before Mon Cal Cruiser)", () => {
    const additions: Record<string, any>[] = step3().additions;
    const keys = additions.map((a) => a.cardKey);
    expect(keys).toContain(STOLEN_AT_HAULER);
    const firstUnmeasured = additions.findIndex((a) => a.evidenceClass === "unmeasured");
    additions.forEach((a, i) => {
      if (a.significant === true && firstUnmeasured >= 0) expect(i, a.title).toBeLessThan(firstUnmeasured);
    });
    expect(additions.find((a) => a.cardKey === STOLEN_AT_HAULER)?.significant).toBe(true);
    if (keys.includes(MON_CAL_CRUISER)) expect(keys.indexOf(STOLEN_AT_HAULER)).toBeLessThan(keys.indexOf(MON_CAL_CRUISER));
  });

  it("Mon Cal Cruiser's hand-disruption quote keeps its whole mode: look, discard, and the refill", () => {
    const a = body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 60, perThreat: 60, archetypes: 6 }));
    const row = [...a.staples, ...a.additions].find((r: Record<string, any>) => r.cardKey === MON_CAL_CRUISER) as Record<string, any>;
    expect(row).toBeDefined();
    const quote = String(row.answers.find((x: Record<string, any>) => x.offer === "offers:discard-opponent")?.evidence);
    expect(quote).toContain("Look at an opponent's hand.");
    expect(quote).toContain("You may discard a card from it.");
    expect(quote).toContain("If you do, they draw a card.");
  });

  it("among the staples no negative answer sits above an ok one", () => {
    const staples: Record<string, any>[] = step3().staples;
    const lastOk = staples.map((s) => s.evidenceClass).lastIndexOf("ok");
    staples.forEach((s, i) => {
      if (s.evidenceClass === "negative" && s.partlyLocked !== true) expect(i, s.title).toBeGreaterThan(lastOk);
    });
  });
});

describe.skipIf(!hasData)("an upgrade swap fills every role of the upgrade it replaces (#164 item 5, D82)", () => {
  it("budget_alternatives offers no Ascension Cable for Chewbacca's Bowcaster (it fills 1 of 2 roles and ramps nothing)", () => {
    const b = body(DECK_TOOLS.budget_alternatives.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, maxPrice: 2 }));
    const slot = (b.slots as Record<string, any>[]).find((s) => s.cardKey === BOWCASTER);
    const alternatives: Record<string, any>[] = slot?.alternatives ?? [];
    expect(alternatives.map((a) => a.cardKey)).not.toContain(ASCENSION_CABLE);
    const roles = String(slot?.roles ?? "").split(", ").filter((r) => r !== "").length;
    for (const alt of alternatives) expect(alt.fills, alt.title).toBe(roles);
  });
});

describe.skipIf(!hasData)("deck_audit names attaching upgrades as orphan feeders and no free penalty through a taxed carrier (#164 item 6, D82)", () => {
  it("Marrok's upgrades-attached feeders name an in-colour upgrade that attaches to him before any unplayed unit", () => {
    const a = body(DECK_TOOLS.deck_audit.handler(real, { leader: CAD_BANE, base: NEVARRO_CITY, decklist: CAD_CORE }));
    const row = (a.orphanWants as Record<string, any>[]).find((r) => String(r.card).startsWith("Marrok"));
    expect(row).toBeDefined();
    const named = String(row?.feeders).split("; ");
    const upgrade = named.findIndex((n) => /^(Grim Valor|Creditor's Claim|Thermal Detonator) /.test(n));
    expect(upgrade, named.join(" | ")).toBeGreaterThanOrEqual(0);
    const unplayedUnit = named.findIndex((n) => /^(FN Trooper Corps|Hidden Hand Supplier) /.test(n));
    if (unplayedUnit >= 0) expect(upgrade).toBeLessThan(unplayedUnit);
  });

  it("Qimir, Darth Traya and Marchion Ro: every Darksaber carrier named for them is itself a taxed Villainy card, so they are freed only in sequence (D83); Oppo's untaxed carriers still free him", () => {
    const a = body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, gapLimit: 10 }));
    const rowOf = (title: string): Record<string, any> => a.aspect.uncovered.find((r: Record<string, any>) => r.card.startsWith(title));
    // D83 (#165) flipped this expectation: a taxed carrier frees the cards played after it, so these rows read 0 in sequence.
    for (const title of ["Qimir", "Darth Traya", "Marchion Ro"]) {
      expect(rowOf(title).effectivePenaltyEach, title).toBe(0);
      expect(rowOf(title).sequenced, title).toBe(true);
      expect(rowOf(title).removedBy, title).toContain("taxed");
    }
    expect(rowOf("Oppo Rancisis").effectivePenaltyEach).toBe(0);
  });
});

describe("readPenaltyRemovers on synthetic cards: a taxed carrier removes nothing, an untaxed one still does (#164 item 6, D82)", () => {
  const card = (key: string, title: string, icons: string[], type = "Unit"): SynergyCard =>
    ({ cardKey: key, title, subtitle: null, type, structured: { cost: 3, aspects: icons, aspectIcons: icons, traits: [] }, faces: {}, tags: { offers: [], wants: [] } }) as SynergyCard;
  const piece = (syn: SynergyCard, text: string | null = null): RemovalCard => ({ syn, text, unique: true, count: 1 });
  const LENDER = "Attach to a <uq> non-Vehicle unit.\nAttached unit gains: \u201cWhile you are paying costs, this unit provides its aspect icons.\u201d";
  const saber = piece(card("S", "Saber", ["Command"], "Upgrade"), LENDER);
  const leader = piece(card("L", "Leader", ["Heroism"], "Leader"));
  const base = piece(card("B", "Base", ["Command"], "Base"));

  it("an untaxed carrier takes off the icons it prints and the rest stays", () => {
    const tax = card("T", "Taxed", ["Command", "Command", "Cunning"]);
    const carrier = card("C", "Carrier", ["Command"]);
    expect(readPenaltyRemovers(leader, base, [saber, piece(tax), piece(carrier)]).noteFor(tax, ["Heroism", "Command"])).toEqual({ by: "Saber attached to Carrier", effectivePenaltyEach: 2 });
  });

  it("an untaxed carrier is preferred over a taxed one that would cover more", () => {
    const tax = card("T", "Taxed", ["Command", "Command", "Villainy"]);
    const free = card("F", "Free", ["Command"]);
    const taxed = card("X", "Taxed Carrier", ["Command", "Villainy"]);
    const note = readPenaltyRemovers(leader, base, [saber, piece(tax), piece(free), piece(taxed)]).noteFor(tax, ["Heroism", "Command"]);
    expect(note).toEqual({ by: "Saber attached to Free", effectivePenaltyEach: 2 });
  });
});

describe("significantGain and measuredBeforeUnmeasured (#164 item 4, D82)", () => {
  const ev = (withCi: string, withoutCi: string, difference: number) => ({ withCard: { n: 500, decks: 50, ci95: withCi }, withoutCard: { n: 500, decks: 50, ci95: withoutCi }, difference });
  it("is significant only for an ok gain whose with-card interval lies wholly above the without-card one", () => {
    expect(significantGain(ev("0.48..0.53", "0.41..0.45", 0.08), "ok")).toBe(true);
    expect(significantGain(ev("0.45..0.53", "0.41..0.47", 0.05), "ok")).toBe(false);
    expect(significantGain(ev("0.48..0.53", "0.41..0.45", 0.08), "thin-control")).toBe(false);
    expect(significantGain("no tournament decklists captured", "unmeasured")).toBe(false);
  });
  it("moves each unmeasured row ahead of the last significant row to just behind it and keeps every other row's order", () => {
    const row = (id: string, evidenceClass: EvidenceClass, significant = false) => ({ id, evidenceClass, significant });
    const rows = [row("u1", "unmeasured"), row("ok1", "ok"), row("s1", "ok", true), row("u2", "unmeasured"), row("s2", "ok", true), row("n1", "negative"), row("u3", "unmeasured")];
    expect(measuredBeforeUnmeasured(rows).map((r) => r.id)).toEqual(["ok1", "s1", "s2", "u1", "u2", "n1", "u3"]);
  });
});
