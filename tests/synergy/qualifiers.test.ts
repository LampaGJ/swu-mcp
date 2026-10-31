import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFungibility, roleOf } from "../../src/synergy/fungibility.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { conflictBetween, qualifierOf } from "../../src/synergy/qualifiers.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import { COMMITTED_TABLE, mk } from "./fixtures.js";

/** Real feature records of the cards adjudicated in docs/verification/2026-10-16.md (see the file's `source`). */
const REAL = synergyCardsSchema.parse(
  (JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "real-cards.json"), "utf8")) as { cards: unknown }).cards,
);
const graph = buildPairGraph(REAL, COMMITTED_TABLE);
const byKey = new Map(REAL.map((c) => [c.cardKey, c]));
const rowsOf = (a: string, b: string): string[] => graph.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];
const card = (k: string): SynergyCard => byKey.get(k) as SynergyCard;

describe("confirmed-wrong pairs are not emitted (#12)", () => {
  const wrong: [string, string, string, string][] = [
    ["09010094", "04010033", "sac-outlet-when-defeated", "ground-only defeat outlet, Space payoff"],
    ["08010110", "06010013", "self-defeat-defeat-watcher", "payoff needs a defeat while attacking; the defeat is a When Played"],
    ["07010232", "07010106", "credits", "payoff wants an enemy Credit token; the offer creates your own"],
    ["07010061", "07010074", "ready-reuse", "readies a Bounty Hunter only; the partner is Underworld"],
    ["09010078", "07010005", "self-defeat-defeat-watcher", "payoff needs a defeated friendly Rebel; the defeater is not a Rebel"],
    ["09010037", "04010062", "heal-payoff", "heals a non-Vehicle unit; the partner is a Vehicle"],
    ["07010224", "09010159", "bounce-replay", "returns upgrades, not the unit"],
    ["08010042", "05010234", "bounce-replay", "returns an upgrade, not the unit"],
    ["04010145", "05010205", "ready-reuse", "a 'for this attack' ability does not survive a ready"],
  ];
  it.each(wrong)("%s > %s does not link through %s (%s)", (a, b, row) => {
    expect(rowsOf(a, b)).not.toContain(row);
  });
});

describe("confirmed-correct pairs keep their link (#12)", () => {
  const right: [string, string, string][] = [
    ["06010074", "04010062", "heal-payoff"],
    ["07010133", "05010064", "sac-outlet-when-defeated"],
    ["09010207", "09010179", "ping-own-damage-payoff"],
    ["06010016", "09010069", "ping-own-damage-payoff"],
    ["07010155", "07010040", "credits"],
    ["09010231", "08010035", "exhaust-own-payoff"],
    ["09010099", "09010037", "fill-discard"],
    ["05010128", "05010130", "removal-defeat-watcher"],
    ["09010266", "08010189", "extra-attack-on-attack"],
  ];
  it.each(right)("%s > %s links through %s", (a, b, row) => {
    if (!byKey.has(a) || !byKey.has(b)) return;
    expect(rowsOf(a, b)).toContain(row);
  });
});

describe("qualifier extraction", () => {
  it("reads arena, ownership and kind from the effect that produced the tag", () => {
    const sando = card("09010094");
    const q = qualifierOf(sando, "offers", "offers:defeat-any-unit", sando.tags.offers.find((t) => t.tag === "offers:defeat-any-unit")?.why ?? "");
    expect(q.subject).toMatchObject({ kind: "unit", arena: "ground" });
    const scrapper = card("07010106");
    const w = qualifierOf(scrapper, "wants", "wants:credit-tokens", scrapper.tags.wants.find((t) => t.tag === "wants:credit-tokens")?.why ?? "");
    expect(w.subject).toMatchObject({ side: "enemy", kind: "token" });
  });

  it("reads a negated trait from the target text, not the positive trait the grammar kept", () => {
    const bacta = card("09010037");
    const q = qualifierOf(bacta, "offers", "offers:heal", bacta.tags.offers.find((t) => t.tag === "offers:heal")?.why ?? "");
    expect(q.subject.notTraits).toEqual(["Vehicle"]);
    expect(q.subject.traits).toEqual([]);
  });

  it("takes the head noun, so a friendly resource is a resource and not a unit", () => {
    const chewbacca = card("07010013");
    const why = chewbacca.tags.offers.find((t) => t.tag === "offers:defeat-friendly-unit")?.why ?? "";
    expect(qualifierOf(chewbacca, "offers", "offers:defeat-friendly-unit", why).subject).toMatchObject({ kind: "resource", side: "friendly" });
  });

  it("marks the abilities a one-attack grant gives", () => {
    const forceSpeed = card("05010205");
    const q = qualifierOf(forceSpeed, "wants", "wants:extra-attacks", "text: on_attack");
    expect(q.forAttackOnly).toBe(true);
  });

  it("fails open when the features state nothing", () => {
    const a = mk("a", "Plain A", { offers: ["offers:defeat-friendly-unit"] });
    const b = mk("b", "Plain B", { wants: ["wants:self-defeated"] });
    const oq = qualifierOf(a, "offers", "offers:defeat-friendly-unit", "x");
    const wq = qualifierOf(b, "wants", "wants:self-defeated", "x");
    expect(conflictBetween(a, "offers:defeat-friendly-unit", oq, b, "wants:self-defeated", wq)).toBeNull();
  });
});

describe("fungible classes separate by target (#12)", () => {
  const fung = buildFungibility(REAL);
  const idOf = (k: string, tag: string): string => roleOf(fung, k, tag)?.id ?? "";

  it("puts damage to your own base in a different class from damage to a friendly unit", () => {
    expect(idOf("08010179", "offers:damage-friendly-unit")).toContain("|tbase");
    expect(idOf("05010137", "offers:damage-friendly-unit")).toContain("|tbase");
  });

  it("separates readying resourced cards from readying a unit", () => {
    expect(idOf("09010123", "offers:ready-unit")).toContain("|tcard");
  });

  it("does not file a deck tuck under return to hand", () => {
    expect(idOf("09010218", "offers:return-any-to-hand")).toContain("|ttuck");
  });

  it("separates exhausting enemy resources from exhausting an enemy unit", () => {
    expect(idOf("06010235", "offers:exhaust-enemy")).toContain("|tresource");
  });
});

/** Feature-record excerpts of the cards in the judge finding (data/runs/2026-10-30/features/features.json), trimmed to the fields the matcher reads. */
const clause = (text: string, effects: unknown[]) => ({ text, effects, conditions: [], modifiers: [] });
const ability = (trigger: string, clauses: unknown[]) => ({ kind: "ability", triggers: [{ trigger }], clauses, options: [], grantedAbilities: [] });
const rec = (cardKey: string, title: string, type: string, traits: string[], faces: Record<string, unknown[]>, offers: [string, string][], wants: [string, string][]): SynergyCard =>
  synergyCardsSchema.parse([
    {
      cardKey,
      title,
      subtitle: null,
      type,
      structured: { cost: 3, aspects: [], aspectIcons: [], traits },
      faces,
      tags: { offers: offers.map(([tag, why]) => ({ tag, why })), wants: wants.map(([tag, why]) => ({ tag, why })) },
    },
  ])[0];

const GAR = rec("08010047", "Gar Saxon", "Unit", ["Mandalorian", "Trooper"], {
  text: [ability("reactive_you", [clause("You may create a Mandalorian token.", [{ cat: "create_token", token: "Mandalorian", n: 1 }])])],
}, [["offers:create-token-units", "text: You may create a Mandalorian token."]], []);
const FISH = rec("09010099", "Always a Bigger Fish", "Event", ["Innate"], {
  text: [ability("event_resolve", [clause("Defeat a friendly Creature unit.", [{ cat: "defeat", n: 1, target: { side: "friendly", kind: "unit", arena: "any", restrict: ["trait:Creature"], text: "a friendly Creature unit" } }])])],
}, [["offers:defeat-friendly-unit", "text: Defeat a friendly Creature unit."]], [["wants:sac-fodder", "defeats your own units"]]);
const SCENT = rec("09010195", "Catch the Scent", "Event", ["Innate"], {
  text: [ability("event_resolve", [clause("Create 2 Beast tokens and ready 1 of them.", [
    { cat: "create_token", token: "Beast", n: 2 },
    { cat: "ready", n: 1, target: { side: "any", kind: "ref", arena: "any", restrict: [], text: "1 of them" } },
  ])])],
}, [["offers:create-token-units", "text: Create 2 Beast tokens and ready 1 of them."], ["offers:ready-unit", "text: Create 2 Beast tokens and ready 1 of them."]], []);
const CAD = rec("08010011", "Cad Bane", "Leader", ["Bounty Hunter", "Underworld"], { text: [] }, [], [["wants:extra-attacks", "deployBox: on_attack"]]);
const MANDO_TOKEN = rec("08010t01", "Mandalorian", "Token Unit", ["Mandalorian"], { text: [] }, [], []);
const BEAST_TOKEN = rec("09010t03", "Beast", "Token Unit", ["Creature"], { text: [] }, [], []);

describe("a want's trait restriction binds the subject the offer supplies (judge finding, find_trios)", () => {
  const g = buildPairGraph([GAR, FISH, SCENT, CAD, MANDO_TOKEN, BEAST_TOKEN], COMMITTED_TABLE);
  const rows = (a: string, b: string): string[] => g.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];

  it("a Mandalorian token is not fodder for 'Defeat a friendly Creature unit'", () => {
    expect(rows("08010047", "09010099")).not.toContain("fodder-for-outlet");
  });

  it("a Beast token (trait Creature) is still fodder for the same outlet", () => {
    expect(rows("09010195", "09010099")).toContain("fodder-for-outlet");
  });

  it("'ready 1 of them' readies only the tokens just created, not the leader that wants extra attacks", () => {
    expect(rows("09010195", "08010011")).not.toContain("ready-reuse");
  });

  it("reads the sac-fodder want's trait from the card's own defeat outlet", () => {
    expect(qualifierOf(FISH, "wants", "wants:sac-fodder", "defeats your own units").subject.traits).toEqual(["Creature"]);
  });

  it("names the token's printed traits in the conflict", () => {
    const tokens = new Map([["Mandalorian", ["Mandalorian"]]]);
    const oq = qualifierOf(GAR, "offers", "offers:create-token-units", "text: You may create a Mandalorian token.", tokens);
    const wq = qualifierOf(FISH, "wants", "wants:sac-fodder", "defeats your own units", tokens);
    expect(conflictBetween(GAR, "offers:create-token-units", oq, FISH, "wants:sac-fodder", wq)).toBe("the offer supplies a Mandalorian token, the want needs a Creature");
  });

  it("fails open on a token whose printed card is not in the set", () => {
    const oq = qualifierOf(GAR, "offers", "offers:create-token-units", "text: You may create a Mandalorian token.");
    const wq = qualifierOf(FISH, "wants", "wants:sac-fodder", "defeats your own units");
    expect(conflictBetween(GAR, "offers:create-token-units", oq, FISH, "wants:sac-fodder", wq)).toBeNull();
  });
});
