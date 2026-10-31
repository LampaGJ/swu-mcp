import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildFungibility, roleOf } from "../../src/synergy/fungibility.js";
import { buildPairGraph } from "../../src/synergy/graph.js";
import { conflictBetween, offerTraitNeeds, qualifierOf } from "../../src/synergy/qualifiers.js";
import { synergyCardsSchema, type SynergyCard } from "../../src/synergy/schema.js";
import { coverCombos } from "../../src/synergy/cover.js";
import { trioLinks } from "../../src/synergy/slots.js";
import { searchTrios } from "../../src/synergy/trios.js";
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

const LAST_WORDS_TEXT = "If a friendly unit was defeated this phase, give 2 Experience tokens to a unit.";
const LAST_WORDS = rec("05010263", "Last Words", "Event", ["Learned"], {
  text: [ability("event_resolve", [clause(LAST_WORDS_TEXT, [{ cat: "give_token", token: "Experience", n: 2, target: { side: "any", kind: "unit", arena: "any", restrict: [], text: "a unit" } }])])],
}, [["offers:give-experience", `text: ${LAST_WORDS_TEXT}`]], [["wants:friendly-unit-defeated", `text: ${LAST_WORDS_TEXT}`]]);
const SACRIFICER = rec("x0000001", "Self Sacrificer", "Unit", ["Trooper"], {
  text: [ability("when_played", [clause("Defeat this unit.", [{ cat: "defeat", n: 1, target: { side: "self", kind: "unit", arena: "any", restrict: [], text: "this unit" } }])])],
}, [["offers:defeat-self", "text: Defeat this unit."]], []);
const WATCHER_TEXT = "When a friendly unit is defeated, draw a card.";
const CREATURE_WATCHER = rec("x0000002", "Creature Watcher", "Unit", ["Creature"], {
  text: [ability("reactive_you", [clause(WATCHER_TEXT, [{ cat: "draw", n: 1 }])])],
}, [], [["wants:friendly-unit-defeated", `text: ${WATCHER_TEXT}`]]);
const TROOPER_WATCHER = rec("x0000003", "Trooper Watcher", "Unit", ["Trooper"], {
  text: [ability("reactive_you", [clause(WATCHER_TEXT, [{ cat: "draw", n: 1 }])])],
}, [], [["wants:friendly-unit-defeated", `text: ${WATCHER_TEXT}`]]);
const BASE = rec("x0000009", "Plain Base", "Base", [], { text: [] }, [], []);

describe("an offer's trait restriction binds the card it feeds, or the trio's supplier (#108)", () => {
  const cards = [FISH, LAST_WORDS, SACRIFICER, CREATURE_WATCHER, TROOPER_WATCHER, SCENT, GAR, CAD, BASE, MANDO_TOKEN, BEAST_TOKEN];
  const g = buildPairGraph(cards, COMMITTED_TABLE);
  const rows = (a: string, b: string): string[] => g.edgeByKey.get(`${a}>${b}`)?.rows.map((r) => r.row) ?? [];
  const tokens = new Map([["Beast", ["Creature"]], ["Mandalorian", ["Mandalorian"]]]);
  const fishOffer = qualifierOf(FISH, "offers", "offers:defeat-friendly-unit", "text: Defeat a friendly Creature unit.", tokens);
  const FED = "wants:friendly-unit-defeated";
  const wantOf = (c: SynergyCard): ReturnType<typeof qualifierOf> =>
    qualifierOf(c, "wants", "wants:friendly-unit-defeated", c.tags.wants.find((t) => t.tag === "wants:friendly-unit-defeated")?.why ?? "", tokens);

  it("names the trait the fed card lacks", () => {
    expect(offerTraitNeeds(fishOffer, LAST_WORDS, FED, wantOf(LAST_WORDS), tokens)).toEqual(["Creature"]);
    expect(offerTraitNeeds(fishOffer, TROOPER_WATCHER, FED, wantOf(TROOPER_WATCHER), tokens)).toEqual(["Creature"]);
  });

  it("needs nothing when the fed card carries the trait (positive control: a Creature unit)", () => {
    expect(offerTraitNeeds(fishOffer, CREATURE_WATCHER, FED, wantOf(CREATURE_WATCHER), tokens)).toEqual([]);
  });

  it("a token maker carries its printed token traits (positive control: a Beast token)", () => {
    const watchingScent = rec("x0000004", "Scent Watcher", "Event", [], SCENT.faces, SCENT.tags.offers.map((t) => [t.tag, t.why]), [["wants:friendly-unit-defeated", "x"]]);
    expect(offerTraitNeeds(fishOffer, watchingScent, FED, wantOf(watchingScent), tokens)).toEqual([]);
  });

  it("a want that counts the discard pile is not bound: it watches what the defeat leaves, not the defeated unit", () => {
    expect(offerTraitNeeds(fishOffer, LAST_WORDS, "wants:cards-in-discard", wantOf(LAST_WORDS), tokens)).toEqual([]);
  });

  it("a pair: 'Defeat a friendly Creature unit' does not feed Last Words, which is no Creature", () => {
    expect(rows("09010099", "05010263")).not.toContain("sac-outlet-when-defeated");
    expect(rows("09010099", "x0000003")).not.toContain("sac-outlet-when-defeated");
  });

  it("a pair: the same outlet still feeds a Creature unit's defeat watcher", () => {
    expect(rows("09010099", "x0000002")).toContain("sac-outlet-when-defeated");
  });

  const trios = searchTrios(g, coverCombos(cards));
  const all = Object.values(trios.trios).flat();
  const members = (t: (typeof all)[number]): string[] => [t.cardA, t.cardB, t.cardC];

  it("a trio holds Always a Bigger Fish > Last Words only beside a card that supplies a Creature", () => {
    const withLink = all.filter((t) => trioLinks(g, t).some((e) => e.a === "09010099" && e.b === "05010263"));
    expect(withLink.length).toBeGreaterThan(0);
    for (const t of withLink) expect(members(t).some((k) => k === "09010195" || k === "x0000002")).toBe(true);
    expect(all.some((t) => members(t).includes("09010099") && members(t).includes("05010263") && members(t).includes("x0000001"))).toBe(false);
  });

  it("a trio: the Beast-token maker supplies the Creature in a chain into Last Words", () => {
    expect(trios.trios.chain.map(members)).toContainEqual(["09010195", "09010099", "05010263"]);
  });
});

/** A feature record with printed keywords, trimmed like `rec` (data/runs/2026-10-30/features/features.json). */
const kwRec = (cardKey: string, title: string, type: string, traits: string[], keywords: string[], faces: Record<string, unknown[]>, offers: [string, string][], wants: [string, string][]): SynergyCard =>
  synergyCardsSchema.parse([
    {
      cardKey,
      title,
      subtitle: null,
      type,
      keywords: keywords.map((keyword) => ({ keyword, granted: false })),
      structured: { cost: 3, aspects: [], aspectIcons: [], traits, keywordsField: keywords },
      faces,
      tags: { offers: offers.map(([tag, why]) => ({ tag, why })), wants: wants.map(([tag, why]) => ({ tag, why })) },
    },
  ])[0];
const hostAbility = (text: string) => ({
  kind: "ability",
  triggers: [{ trigger: "constant" }],
  clauses: [{ text, effects: [], conditions: [{ cat: "self_state", state: "upgraded" }], modifiers: [] }],
  options: [],
  grantedAbilities: [],
});
const attachTo = (text: string, target: Record<string, unknown>) => ({
  kind: "ability",
  triggers: [{ trigger: "constant" }],
  clauses: [{ text, effects: [], conditions: [], modifiers: [], structure: [{ rule: "attach_to", cat: "attach_restriction", target }] }],
  options: [],
  grantedAbilities: [],
});
const PILOT_OFFER: [string, string] = ["offers:upgrade-to-attach", "is an upgrade or Pilot"];
const MARROK_TEXT = "While this unit is upgraded, he loses Sentinel and gains Saboteur.";
const MARROK = kwRec("08010030", "Marrok", "Unit", ["Force", "Inquisitor"], ["Saboteur", "Sentinel"], { text: [hostAbility(MARROK_TEXT)] }, [], [["wants:upgrades-attached", `text: ${MARROK_TEXT}`]]);
const SPACER = kwRec("04010255", "Sullustan Spacer", "Unit", ["Fringe", "Pilot"], ["Piloting"], { epicAction: [{ kind: "keyword", keywords: [{ keyword: "Piloting" }], granted: false }] }, [PILOT_OFFER], []);
const CONSCRIPT = kwRec("04010236", "Indoctrinated Conscript", "Unit", ["First Order", "Pilot"], ["Piloting"], { epicAction: [{ kind: "keyword", keywords: [{ keyword: "Piloting" }], granted: false }] }, [PILOT_OFFER], []);
const FIGHTER_TEXT = "While this unit is upgraded, it gets +1/+0.";
const FIGHTER = kwRec("x0000010", "Upgraded Fighter", "Unit", ["Vehicle", "Fighter"], [], { text: [hostAbility(FIGHTER_TEXT)] }, [], [["wants:upgrades-attached", `text: ${FIGHTER_TEXT}`]]);
const SHADOWS_TEXT = "Give an Experience token to each of up to 3 friendly units with Hidden.";
const SHADOWS = kwRec("05010241", "In the Shadows", "Event", ["Plan"], [], {
  text: [ability("event_resolve", [clause(SHADOWS_TEXT, [{ cat: "give_token", target: { side: "friendly", kind: "unit", arena: "any", restrict: ["keyword:Hidden"], text: "each of up to 3 friendly units with Hidden" } }])])],
}, [["offers:give-experience", `text: ${SHADOWS_TEXT}`]], []);
const HIDDEN_TEXT = "While this unit is upgraded, she gets +1/+1.";
const HIDDEN_UNIT = kwRec("x0000011", "Hidden Host", "Unit", ["Underworld"], ["Hidden"], { text: [hostAbility(HIDDEN_TEXT)] }, [], [["wants:upgrades-attached", `text: ${HIDDEN_TEXT}`]]);
const SABER = kwRec("x0000012", "Plain Lightsaber", "Upgrade", ["Item", "Weapon", "Lightsaber"], [], {
  text: [attachTo("Attach to a non-Vehicle unit.", { side: "any", kind: "unit", arena: "any", restrict: ["non_trait:Vehicle"], text: "a non-Vehicle unit" })],
}, [PILOT_OFFER], []);
const TURRET = kwRec("x0000013", "Plain Turret", "Upgrade", ["Item", "Weapon"], [], {
  text: [attachTo("Attach to a Vehicle unit.", { side: "any", kind: "unit", arena: "any", restrict: ["trait:Vehicle"], text: "a Vehicle unit" })],
}, [PILOT_OFFER], []);
const CANNON = kwRec("x0000014", "Plain Cannon", "Upgrade", ["Item", "Weapon"], [], {
  text: [attachTo("Attach to a Capital Ship or Transport unit.", { side: "any", kind: "unit", arena: "any", restrict: ["trait:Capital Ship", "trait:Transport"], text: "a Capital Ship or Transport unit" })],
}, [PILOT_OFFER], []);
const TRANSPORT_TEXT = "While this unit is upgraded, it gains Sentinel.";
const TRANSPORT = kwRec("x0000015", "Upgraded Transport", "Unit", ["Vehicle", "Transport"], [], { text: [hostAbility(TRANSPORT_TEXT)] }, [], [["wants:upgrades-attached", `text: ${TRANSPORT_TEXT}`]]);
const CREATURE_XP_TEXT = "Give an Experience token to a friendly Creature unit.";
const CREATURE_XP = kwRec("x0000016", "Creature Training", "Event", [], [], {
  text: [ability("event_resolve", [clause(CREATURE_XP_TEXT, [{ cat: "give_token", target: { side: "friendly", kind: "unit", arena: "any", restrict: ["trait:Creature"], text: "a friendly Creature unit" } }])])],
}, [["offers:give-experience", `text: ${CREATURE_XP_TEXT}`]], []);
const BEAST_HOST = kwRec("x0000017", "Upgraded Beast", "Unit", ["Creature"], [], { text: [hostAbility(HIDDEN_TEXT)] }, [], [["wants:upgrades-attached", `text: ${HIDDEN_TEXT}`]]);
const EXECUTOR_TEXT = "This unit gets +1/+0 for each upgrade on other friendly units.";
const EXECUTOR = kwRec("x0000018", "Upgrade Counter", "Unit", ["Vehicle", "Capital Ship"], [], {
  text: [{ kind: "ability", triggers: [{ trigger: "constant" }], clauses: [{ text: EXECUTOR_TEXT, effects: [], conditions: [{ cat: "scaling", per: "upgrade on other friendly units" }], modifiers: [] }], options: [], grantedAbilities: [] }],
}, [], [["wants:upgrades-attached", `text: ${EXECUTOR_TEXT}`]]);

describe("an attach or give offer carries the receiving card's restriction (#119)", () => {
  const g = buildPairGraph([MARROK, SPACER, CONSCRIPT, FIGHTER, SHADOWS, HIDDEN_UNIT, SABER, TURRET, CANNON, TRANSPORT, CREATURE_XP, BEAST_HOST, EXECUTOR], COMMITTED_TABLE);
  const links = (a: string, b: string): boolean => (g.edgeByKey.get(`${a}>${b}`)?.rows.some((r) => r.row === "upgrade-stacking") ?? false) || g.conditionalByKey.has(`${a}>${b}`);
  const qOf = (c: SynergyCard, side: "offers" | "wants", tag: string) => qualifierOf(c, side, tag, c.tags[side].find((t) => t.tag === tag)?.why ?? "");

  it("a Pilot (Piloting attaches to a friendly Vehicle unit) does not feed Marrok, a non-Vehicle unit", () => {
    expect(links("04010255", "08010030")).toBe(false);
    expect(links("04010236", "08010030")).toBe(false);
  });

  it("names the Vehicle restriction in the conflict", () => {
    const why = conflictBetween(SPACER, "offers:upgrade-to-attach", qOf(SPACER, "offers", "offers:upgrade-to-attach"), MARROK, "wants:upgrades-attached", qOf(MARROK, "wants", "wants:upgrades-attached"));
    expect(why).toBe("the offer attaches to a Vehicle unit only, the wanting card is not one");
  });

  it("a Pilot still feeds a Vehicle that wants to be upgraded (positive control)", () => {
    expect(links("04010255", "x0000010")).toBe(true);
  });

  it("'Attach to a Vehicle unit' does not feed Marrok; 'Attach to a non-Vehicle unit' does not feed a Vehicle", () => {
    expect(links("x0000013", "08010030")).toBe(false);
    expect(links("x0000012", "x0000010")).toBe(false);
  });

  it("'Attach to a non-Vehicle unit' still feeds Marrok and 'Attach to a Vehicle unit' still feeds a Vehicle (positive controls)", () => {
    expect(links("x0000012", "08010030")).toBe(true);
    expect(links("x0000013", "x0000010")).toBe(true);
  });

  it("'Attach to a Capital Ship or Transport unit' needs one of the two traits, not both", () => {
    expect(links("x0000014", "x0000015")).toBe(true);
    expect(links("x0000014", "x0000010")).toBe(false);
  });

  it("In the Shadows ('friendly units with Hidden') does not feed Marrok, who has no Hidden", () => {
    expect(links("05010241", "08010030")).toBe(false);
  });

  it("In the Shadows still feeds a Hidden unit that wants to be upgraded (positive control)", () => {
    expect(links("05010241", "x0000011")).toBe(true);
  });

  it("'Give an Experience token to a friendly Creature unit' does not feed Marrok, even as a trio link, and still feeds a Creature host", () => {
    expect(links("x0000016", "08010030")).toBe(false);
    expect(links("x0000016", "x0000017")).toBe(true);
  });

  it("a want that counts upgrades on other units is not the receiving card, so a Pilot still feeds it", () => {
    expect(links("04010255", "x0000018")).toBe(true);
  });
});
