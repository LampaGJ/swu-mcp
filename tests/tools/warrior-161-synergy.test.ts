import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { evidenceSpan } from "../../src/synergy/evidence.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { resolveRef } from "../../src/tools/deck.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
};
const DECKLIST = OWNER_DECK.deck.map((d) => ({ card: d.id, count: d.count }));

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";
const CHEWBACCA = "09010117";
const CHIEFTAIN = "09010212";
const INSURGENT_CAMP = "09010216";
const FIGURE_OF_UNITY = "06010104";
const HANS_GOLDEN_DICE = "07010225";
const WEAK_NEW_CARDS = ["06010216", "06010093", HANS_GOLDEN_DICE]; // Regulations Bureaucrat, C-3PO, Han's Golden Dice
const LEADER_CLAUSE = "Play a unit with 3 or less power from your hand (paying its cost) and give it Ambush for this phase.";
const COLOURS = ["Cunning", "Heroism", "Command"];

const real = hasData ? loadStore(builtRun as string) : (undefined as never);
const ctx = hasData ? synergyContextOf(real) : (undefined as never);
const IN_DECK = new Set(
  DECKLIST.map((d) => {
    const hit = hasData ? resolveRef(real, d.card, "main") : undefined;
    return hit?.ok ? hit.row.cardKey : d.card;
  }),
);
const newCards = (t: Record<string, any>): string[] => String(t.cardKeys).split("|").filter((k) => !IN_DECK.has(k));
/** A raw trigger kind ("text: on_attack", "deployBox: attack_end") instead of card text. */
const RAW_TRIGGER = /^\w+: [a-z]+(?:_[a-z]+)+$/;

describe.skipIf(!hasData)("find_trios ranks a mixed trio's new card by its standing (#161, D74)", () => {
  const step14 = (): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_trios.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 5, withAlternatives: false })).trios;

  const strongBeforeWeak = (trios: Record<string, any>[]): void => {
    const strong = trios.findIndex((t) => newCards(t).some((k) => k === INSURGENT_CAMP || k === FIGURE_OF_UNITY));
    expect(strong, trios.map((t) => t.cards).join("\n")).toBeGreaterThanOrEqual(0);
    trios.forEach((t, i) => {
      if (newCards(t).some((k) => WEAK_NEW_CARDS.includes(k))) expect(i, `${t.cards} ranks above the first Insurgent Camp / Figure of Unity trio`).toBeGreaterThan(strong);
    });
  };

  // Flipped by #173 (D91): with no leader, Insurgent Camp has no engine job, and its ready and Figure of Unity's keywords are links the
  // deck already has (Neel readies Grogu, Chewbacca and Captain Tarpals give Oppo Rancisis the keywords), so those trios carry
  // deckHasLinks and follow the idea-tier trios whose new card adds a link the deck lacks, Regulations Bureaucrat's among them; one that
  // shares two members with a listed row is listed under that row's alsoWith (coordinator ruling 2026-10-31).
  it("step 6 (colours, no leader): Figure of Unity carries deckHasLinks, as a row that follows every idea-tier trio whose new card adds a link or under a row's alsoWith", () => {
    const trios = body(SYNERGY_TOOLS.find_trios.handler(real, { leaderAspects: ["Cunning", "Heroism"], baseAspects: ["Command"], decklist: DECKLIST, limit: 50, withAlternatives: false, evidence: false })).trios as Record<string, any>[];
    const fou = [
      ...trios.filter((t) => newCards(t).includes(FIGURE_OF_UNITY)).map((t) => t.deckHasLinks),
      ...trios.flatMap((t) => ((t.alsoWith ?? []) as Record<string, any>[]).filter((a) => a.title === "Figure of Unity").map((a) => a.deckHasLinks)),
    ];
    expect(fou.length, trios.map((t) => t.cards).join("\n")).toBeGreaterThan(0);
    for (const held of fou) expect(held).toMatch(/Figure of Unity > Oppo Rancisis/);
    const idea = trios.filter((t) => t.newCardWeight !== undefined && t.riderUnmet === undefined && t.leaderAlreadyFeeds === undefined && t.penalty < 4);
    const firstHeld = idea.findIndex((t) => t.deckHasLinks !== undefined);
    expect(idea.slice(firstHeld).every((t) => t.deckHasLinks !== undefined), idea.map((t) => `${t.cards} ${t.deckHasLinks ?? ""}`).join("\n")).toBe(true);
    expect(idea.findIndex((t) => newCards(t).some((k) => WEAK_NEW_CARDS.includes(k)))).toBeLessThan(firstHeld);
  });

  it("step 14 (leader and base): Insurgent Camp or Figure of Unity outranks them too", () => {
    strongBeforeWeak(step14());
  });

  it("a mixed trio states the new card's weight; a trio with no card outside the deck carries none", () => {
    for (const t of step14()) {
      if (newCards(t).length === 0 || newCards(t).length === 3) expect(t.newCardWeight).toBeUndefined();
      else expect(typeof t.newCardWeight).toBe("number");
    }
  });
});

describe.skipIf(!hasData)("Insurgent Camp is a leader-engine partner of The Warrior (#161, D74)", () => {
  const pairings = (cardKey: string, extra: object = {}): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 100, perLink: 100, aspects: COLOURS, ...extra })).pairings;
  const camp = (rows: Record<string, any>[]): Record<string, any> => {
    const row = rows.find((r) => r.cardKey === INSURGENT_CAMP);
    expect(row).toBeDefined();
    return row as Record<string, any>;
  };

  it("5a: the Camp row is a leader-engine row quoting both clauses, not the generic 'still counts as played'", () => {
    const row = camp(pairings(WARRIOR));
    expect(row.linkKind).toBe("leader-engine");
    expect(row.reason).toContain(LEADER_CLAUSE);
    expect(row.reason).toContain("When you play a unit with 3 or less power: You may defeat this upgrade. If you do, ready that unit.");
    expect(row.reason).toContain("Ambush attack");
    expect(row.reason).not.toContain("still counts as played");
    expect(row.evidence[0].offer).toBe(`text: ${LEADER_CLAUSE}`);
    expect(row.evidence[0].want).toContain("If you do, ready that unit.");
  });

  it("5b and 5c: the Camp row no longer says it re-uses an Action [Exhaust]; it readies the unit as it is played", () => {
    for (const subject of [CHEWBACCA, CHIEFTAIN]) {
      const row = camp(pairings(subject));
      expect(row.reason).not.toContain("re-uses its Action [Exhaust]");
      expect(row.reason).toMatch(/as you play it/);
    }
  });
});

describe.skipIf(!hasData)("evidence is card text, never a trigger tag (#161, D74)", () => {
  it("Han's Golden Dice quotes its granted On Attack clause", () => {
    const dice = ctx.graph.byKey.get(HANS_GOLDEN_DICE) as SynergyCard;
    const why = dice.tags.wants.find((w) => w.tag === "wants:extra-attacks")?.why as string;
    expect(why).toBe("text: on_attack");
    const span = evidenceSpan(dice, why);
    expect(span).toBe("text: Attached unit gains: “On Attack: Discard a card from your deck. If its cost is odd, create a Credit token.”");
  });

  it("no tag of any card resolves to a raw trigger kind", () => {
    const leaks = ctx.cards.flatMap((c) => [...c.tags.offers, ...c.tags.wants].flatMap((t) => (RAW_TRIGGER.test(evidenceSpan(c, t.why)) ? [`${c.cardKey} ${t.tag} ${t.why}`] : [])));
    expect(leaks).toEqual([]);
  });

  it("find_pairings for Han's Golden Dice quotes no trigger tag", () => {
    const rows = body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: HANS_GOLDEN_DICE, limit: 20 })).pairings as Record<string, any>[];
    const texts = rows.flatMap((r) => (r.evidence as { offer: string; want: string }[]).flatMap((e) => [e.offer, e.want]));
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((t) => RAW_TRIGGER.test(t))).toEqual([]);
  });
});

describe.skipIf(!hasData)("step 13 control: generic play-trigger rows rank after every specific link (#161, D74)", () => {
  const GENERIC = /^(?:offers:(?:paid-play|cheat-play|play-from-discard|play-from-resources|tutor-to-play) -> wants:units-played)(?:; offers:(?:paid-play|cheat-play|play-from-discard|play-from-resources|tutor-to-play) -> wants:units-played)*$/;
  const step13 = (extra: object = {}): Record<string, any>[] =>
    body(SYNERGY_TOOLS.find_pairings.handler(real, { cardKey: WARRIOR, leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 100, weighting: "none", ...extra })).pairings;
  const isGeneric = (r: Record<string, any>): boolean => r.linkKind !== "leader-engine" && GENERIC.test(String(r.link));

  it("weighting none: no generic play-trigger row precedes a specific one, and Obi-Wan does not lead", () => {
    const rows = step13();
    expect(rows[0].title).not.toMatch(/^Obi-Wan Kenobi/);
    const firstGeneric = rows.findIndex(isGeneric);
    expect(firstGeneric).toBeGreaterThan(0);
    const unlocked = rows.filter((r) => ["baseLocked", "nameLocked", "needsForce", "needsTrait"].every((k) => r[k] === undefined));
    const lastSpecific = unlocked.map((r, i) => (isGeneric(r) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    const firstGenericUnlocked = unlocked.findIndex(isGeneric);
    expect(firstGenericUnlocked).toBeGreaterThan(lastSpecific);
  });

  it("the leader-weighted call (5a) applies the same order, so the control differs only by the play-share factor", () => {
    const rows = step13({ weighting: "leader", aspects: COLOURS });
    const unlocked = rows.filter((r) => ["baseLocked", "nameLocked", "needsForce", "needsTrait"].every((k) => r[k] === undefined));
    const lastSpecific = unlocked.map((r, i) => (isGeneric(r) ? -1 : i)).reduce((a, b) => Math.max(a, b), -1);
    expect(unlocked.findIndex(isGeneric)).toBeGreaterThan(lastSpecific);
  });
});

const CONDEMN = "06010038";
const MARROK = "08010030";
const UNFETTERED_AMBITION = "08010182";
const SULLUSTAN_SPACER = "04010255";
const BOLSTERED_ENDURANCE = "05010074";
const ARVEL_SKEEN = "07010191";
const GRIM_VALOR = "04010073";
const BITH_BRUTE = "07010049";
const CAD_BANE = "08010011";
const NEVARRO = "08010020";
const keysOf = (t: Record<string, any>): string[] => String(t.cardKeys).split("|");

describe.skipIf(!hasData)("Cad Bane session: a host-negating upgrade feeds no ability of its host (#161 item 5, D74)", () => {
  it("Condemn ('loses all other abilities' while attacking) is no upgrade feeder of Marrok, so deck_audit cannot name it", () => {
    expect(ctx.graph.edgeByKey.get(`${CONDEMN}>${MARROK}`)).toBeUndefined();
  });

  it("no trio holds Condemn, Unfettered Ambition and Marrok, and Cad Bane step 14 holds no Condemn + Marrok trio", () => {
    const withCondemn = body(SYNERGY_TOOLS.find_trios.handler(real, { cardKey: CONDEMN, limit: 50, minPlayed: 0, evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    expect(withCondemn.filter((t) => [UNFETTERED_AMBITION, MARROK].every((k) => keysOf(t).includes(k))).map((t) => t.cards)).toEqual([]);
    const step14 = body(SYNERGY_TOOLS.find_trios.handler(real, { leader: CAD_BANE, base: NEVARRO, limit: 5, evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    expect(step14.filter((t) => keysOf(t).includes(CONDEMN) && keysOf(t).includes(MARROK)).map((t) => t.cards)).toEqual([]);
  });
});

describe.skipIf(!hasData)("Cad Bane session: trio members that share a host need one legal host (#161 item 6, D74)", () => {
  it("Sullustan Spacer (pilots a Vehicle) and Bolstered Endurance (attaches to a Force unit) never stack on one Unfettered Ambition host", () => {
    const trios = body(SYNERGY_TOOLS.find_trios.handler(real, { cardKey: UNFETTERED_AMBITION, limit: 50, evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    expect(trios.length).toBeGreaterThan(0);
    expect(trios.filter((t) => [SULLUSTAN_SPACER, BOLSTERED_ENDURANCE].every((k) => keysOf(t).includes(k))).map((t) => t.cards)).toEqual([]);
  });

  it("step 6 of the Cad Bane session (colours only) lists no such trio", () => {
    const trios = body(SYNERGY_TOOLS.find_trios.handler(real, { leaderAspects: ["Aggression", "Villainy"], baseAspects: ["Vigilance"], limit: 20, evidence: false, withAlternatives: false })).trios as Record<string, any>[];
    expect(trios.filter((t) => keysOf(t).includes(SULLUSTAN_SPACER) && keysOf(t).includes(BOLSTERED_ENDURANCE)).map((t) => t.cards)).toEqual([]);
  });
});

describe.skipIf(!hasData)("Cad Bane session: a token that is not a unit fires no unit trigger (#161 item 7, D74)", () => {
  it("Arvel Skeen defeating a Credit token feeds no When Defeated (Grim Valor)", () => {
    expect(ctx.graph.edgeByKey.get(`${ARVEL_SKEEN}>${GRIM_VALOR}`)).toBeUndefined();
  });

  it("no offer that defeats a Credit, Force, Experience, Shield or Advantage token feeds a unit-defeat want", () => {
    const NON_UNIT_TOKEN = /\bdefeat (?:a |an |any number of |up to \w+ )?(?:friendly |enemy )?(?:Credit|Force|Experience|Shield|Advantage) tokens?\b/i;
    const leaks = ctx.graph.edges.flatMap((e) =>
      e.rows.flatMap((r) => {
        if (!/^offers:defeat-(?:any|friendly|enemy)-unit$/.test(r.offer)) return [];
        const why = (ctx.graph.byKey.get(e.a) as SynergyCard).tags.offers.find((t) => t.tag === r.offer)?.why ?? "";
        return NON_UNIT_TOKEN.test(why) ? [`${e.a}>${e.b} ${r.row}`] : [];
      }),
    );
    expect(leaks).toEqual([]);
  });
});

describe.skipIf(!hasData)("fungible_substitutes joins printers and self-gainers of a keyword (#161 item 8, D74)", () => {
  it("Bith Brute's text prints Saboteur", () => {
    const bith = ctx.graph.byKey.get(BITH_BRUTE) as SynergyCard;
    expect((bith.keywords as { keyword: string; granted?: boolean }[]).some((k) => k.keyword === "Saboteur" && k.granted !== true)).toBe(true);
  });

  it("Marrok (gains Saboteur while upgraded) lists Bith Brute in his Saboteur class, labelled by the printed keyword", () => {
    const out = body(SYNERGY_TOOLS.fungible_substitutes.handler(real, { cardKey: MARROK, preferAspects: ["Aggression", "Villainy", "Vigilance"] }));
    const saboteur = (out.roles as Record<string, any>[]).find((r) => r.tag === "offers:gain-saboteur-self") as Record<string, any>;
    expect(saboteur).toBeDefined();
    const cards = (saboteur.substitutes as Record<string, any>[]).flatMap((g) => g.cards as Record<string, any>[]);
    const bith = cards.find((c) => c.cardKey === BITH_BRUTE);
    expect(bith, cards.map((c) => c.title).join("; ")).toBeDefined();
    expect(bith?.text).toBe("printed keyword Saboteur");
    expect(bith?.keywordJob).toBe("keyword:Saboteur");
    expect((out.standIns as Record<string, any>[]).some((s) => s.cardKey === BITH_BRUTE)).toBe(true);
  });
});
