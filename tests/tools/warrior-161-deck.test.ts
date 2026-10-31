import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import type { SynergyCard } from "../../src/synergy/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS, resolveRef } from "../../src/tools/deck.js";
import { META_TOOLS, negativeEvidenceLast, type EvidenceClass } from "../../src/tools/meta.js";
import { readPenaltyRemovers, type RemovalCard } from "../../src/tools/penalty-removal.js";

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
const DARKSABER = "ASH_135";
const LEGACY_RUN = "05010213";

const real = hasData ? loadStore(builtRun as string) : (undefined as never);

describe.skipIf(!hasData)("deck_audit shows the card that removes an aspect penalty (#161, D75)", () => {
  const audit = (decklist = DECKLIST): Record<string, any> => body(DECK_TOOLS.deck_audit.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist, gapLimit: 10 }));
  const rowOf = (a: Record<string, any>, title: string): Record<string, any> => a.aspect.uncovered.find((r: Record<string, any>) => r.card.startsWith(title));

  it("notes The Darksaber on every penalised row it can cover, with the effective penalty, and keeps the printed penalty", () => {
    const a = audit();
    expect(a.aspect.penalty).toBe(16);
    for (const title of ["Qimir", "Darth Traya", "Marchion Ro", "Oppo Rancisis"]) {
      const row = rowOf(a, title);
      expect(row.removedBy, title).toContain("The Darksaber, Icon of Leadership attached to");
      expect(row.effectivePenaltyEach, title).toBe(0);
      expect(row.effectivePenaltyTotal, title).toBe(0);
      expect(row.penaltyEach, title).toBe(2);
    }
  });

  it("never names the penalised card as its own carrier, and names Command units for Oppo and Villainy units for Qimir", () => {
    const a = audit();
    expect(rowOf(a, "Qimir").removedBy).not.toContain("Qimir, Everyone");
    expect(rowOf(a, "Qimir").removedBy).toMatch(/Darth Traya|Marchion Ro/);
    expect(rowOf(a, "Oppo Rancisis").removedBy).not.toContain("Oppo");
    expect(rowOf(a, "Oppo Rancisis").removedBy).toMatch(/Chewbacca, Resourceful Wookiee|Luke Skywalker|Ahsoka Tano/);
  });

  it("lists the remover in the section note, and carries no removal fields when the deck holds no Darksaber", () => {
    expect(audit().aspect.note).toContain("Removers in this deck: The Darksaber, Icon of Leadership");
    expect(DECKLIST.some((d) => d.card === DARKSABER)).toBe(true);
    const without = audit(DECKLIST.filter((d) => d.card !== DARKSABER));
    expect(without.aspect.note).not.toContain("Removers in this deck");
    for (const row of without.aspect.uncovered) expect(row.removedBy).toBeUndefined();
  });

  it("reads a leader's standing ignore clause (Mon Mothma ignores the penalties of non-Villainy Official units) and spares the Villainy Official", () => {
    const a = body(
      DECK_TOOLS.deck_audit.handler(real, {
        leader: "06010009",
        base: "07010022",
        decklist: [
          { card: "06010041", count: 3 },
          { card: "06010079", count: 3 },
        ],
      }),
    );
    const advisor = rowOf(a, "Populist Advisor");
    expect(advisor.removedBy).toContain("Mon Mothma, Forming a Coalition");
    expect(advisor.removedBy).toContain("Ignore the aspect penalties on non-Villainy Official units you play");
    expect(advisor.effectivePenaltyEach).toBe(0);
    const politician = rowOf(a, "Corrupt Politician");
    expect(politician.penaltyEach).toBe(2);
    expect(politician.removedBy).toBeUndefined();
  });

  it("names the cards each cluster gap points to, at most three, with cost, penalty and play share", () => {
    const gaps = audit().clusterGaps;
    expect(gaps.clusters.length).toBeGreaterThan(0);
    expect(gaps.gapCards.map((g: Record<string, any>) => g.clusterId)).toEqual(gaps.clusters.map((c: Record<string, any>) => c.clusterId));
    for (const row of gaps.gapCards) {
      const named = String(row.cards).split("; ").filter((s) => s !== "");
      expect(named.length, row.label).toBeGreaterThanOrEqual(1);
      expect(named.length, row.label).toBeLessThanOrEqual(3);
      for (const n of named) expect(n, row.label).toMatch(/\((\d+|-)(, \+\d+)?(, locked)?, (\d+% of lists|unplayed)\)$/);
    }
    expect(gaps.gapCardsRule).toContain("gapCards names, per shown cluster, the top 3 cards");
  });

  it("names no card the deck already holds", () => {
    const heldTitles = new Set(
      DECKLIST.map((d) => {
        const hit = resolveRef(real, d.card, "main");
        return hit.ok ? hit.row.title : undefined;
      }),
    );
    for (const row of audit().clusterGaps.gapCards) {
      for (const n of String(row.cards).split("; ")) expect(heldTitles.has(n.split(",")[0].split(" (")[0]), n).toBe(false);
    }
  });
});

describe("readPenaltyRemovers on synthetic cards (#161, D75)", () => {
  const card = (key: string, title: string, over: { type?: string; icons?: string[]; aspects?: string[]; traits?: string[] } = {}): SynergyCard =>
    ({
      cardKey: key,
      title,
      subtitle: null,
      type: over.type ?? "Unit",
      structured: { cost: 3, aspects: over.aspects ?? over.icons ?? [], aspectIcons: over.icons ?? over.aspects ?? [], traits: over.traits ?? [] },
      faces: {},
      tags: { offers: [], wants: [] },
    }) as SynergyCard;
  const piece = (syn: SynergyCard, over: { text?: string | null; unique?: boolean; count?: number } = {}): RemovalCard => ({
    syn,
    text: over.text ?? null,
    unique: over.unique ?? true,
    count: over.count ?? 1,
  });
  const LENDER = "Attach to a <uq> non-Vehicle unit.\nAttached unit gains: “While you are paying costs, this unit provides its aspect icons.”";
  const saber = piece(card("S", "Saber", { type: "Upgrade", icons: ["Command"] }), { text: LENDER });
  const leader = piece(card("L", "Leader", { type: "Leader", icons: ["Heroism"] }));
  const base = piece(card("B", "Base", { type: "Base", icons: ["Command"] }));

  it("takes off only the icons the carrier prints and keeps the rest of the penalty", () => {
    const tax = card("T", "Taxed", { icons: ["Villainy", "Cunning"] });
    const carrier = card("C", "Carrier", { icons: ["Villainy"] });
    const reader = readPenaltyRemovers(leader, base, [saber, piece(tax), piece(carrier)]);
    expect(reader.noteFor(tax, ["Heroism", "Command"])).toEqual({ by: "Saber attached to Carrier", effectivePenaltyEach: 2 });
  });

  it("refuses a non-unique carrier, a Vehicle, the card itself and a carrier with no icon in common", () => {
    const tax = card("T", "Taxed", { icons: ["Villainy"] });
    const common = piece(card("C", "Common", { icons: ["Villainy"] }), { unique: false });
    const ship = piece(card("V", "Ship", { icons: ["Villainy"], traits: ["Vehicle"] }));
    const other = piece(card("O", "Other", { icons: ["Aggression"] }));
    const reader = readPenaltyRemovers(leader, base, [saber, piece(tax), common, ship, other]);
    expect(reader.noteFor(tax, ["Heroism", "Command"])).toBeNull();
  });

  it("reads a standing ignore clause with an aspect gate and a trait gate, spares a card outside it, and ignores a one-play Action", () => {
    const official = card("A", "Official", { aspects: ["Vigilance", "Heroism"], icons: ["Vigilance", "Heroism"], traits: ["Official"] });
    const villain = card("D", "Dark Official", { aspects: ["Vigilance", "Villainy"], icons: ["Vigilance", "Villainy"], traits: ["Official"] });
    const plain = card("P", "Plain", { aspects: ["Vigilance"], icons: ["Vigilance"] });
    const ignoring = piece(card("M", "Mothma", { type: "Leader", icons: ["Command"] }), { text: "Ignore the aspect penalties on non‑Villainy Official units you play." });
    const oneShot = piece(card("K", "Kallus", { type: "Leader", icons: ["Command"] }), { text: "Action [1 resource]: Play a card from your hand, ignoring its aspect penalties." });
    const reader = readPenaltyRemovers(ignoring, base, [piece(official), piece(villain), piece(plain)]);
    expect(reader.noteFor(official, [])?.effectivePenaltyEach).toBe(0);
    expect(reader.noteFor(villain, [])).toBeNull();
    expect(reader.noteFor(plain, [])).toBeNull();
    expect(readPenaltyRemovers(oneShot, base, [piece(official)]).noteFor(official, [])).toBeNull();
  });

  it("reads a conditional ignore clause and quotes the condition", () => {
    const hero = card("H", "Hero", { aspects: ["Heroism"], icons: ["Heroism"] });
    const hera = piece(card("R", "Hera", { type: "Leader", icons: ["Command"] }), {
      text: "While you control 2 or more units, ignore the aspect penalties on Heroism units you play.",
    });
    const note = readPenaltyRemovers(hera, base, [piece(hero)]).noteFor(hero, []);
    expect(note?.by).toContain("While you control 2 or more units, ignore the aspect penalties on Heroism units you play.");
  });
});

describe("negativeEvidenceLast (#161, D75)", () => {
  const row = (name: string, evidenceClass: EvidenceClass, partlyLocked = false) => ({ name, evidenceClass, partlyLocked });
  const names = (rows: { name: string }[]): string[] => rows.map((r) => r.name);

  it("moves a negative row to just behind the last ok row and keeps the order of every other row", () => {
    const rows = [row("a-neg", "negative"), row("b-ok", "ok"), row("c-unm", "unmeasured"), row("d-ok", "ok"), row("e-unm", "unmeasured"), row("f-neg", "negative")];
    expect(names(negativeEvidenceLast(rows))).toEqual(["b-ok", "c-unm", "d-ok", "a-neg", "e-unm", "f-neg"]);
  });

  it("leaves a negative row where it is when no ok row follows it, and every list without an ok row unchanged", () => {
    expect(names(negativeEvidenceLast([row("a-ok", "ok"), row("b-neg", "negative"), row("c-unm", "unmeasured")]))).toEqual(["a-ok", "b-neg", "c-unm"]);
    expect(names(negativeEvidenceLast([row("a-neg", "negative"), row("b-unm", "unmeasured"), row("c-thin", "thin-control")]))).toEqual(["a-neg", "b-unm", "c-thin"]);
  });

  it("keeps the partly-locked partition outermost: a locked ok row does not pull an unlocked negative row behind it", () => {
    const rows = [row("neg", "negative"), row("ok", "ok"), row("locked-ok", "ok", true), row("locked-neg", "negative", true)];
    expect(names(negativeEvidenceLast(rows))).toEqual(["ok", "neg", "locked-ok", "locked-neg"]);
  });
});

describe.skipIf(!hasData)("meta_answers ranks a thin or negative addition after the ok ones (#161, D75)", () => {
  const answers = (extra: object = {}): Record<string, any> =>
    body(META_TOOLS.meta_answers.handler(real, { leader: WARRIOR, base: ORIGIN_TREE, decklist: DECKLIST, limit: 60, archetypes: 6, ...extra }));

  it("lists The Legacy Run (negative, 5 decks) after every unlocked addition whose class is ok", () => {
    const additions = answers().additions as Record<string, any>[];
    const at = additions.findIndex((r) => r.cardKey === LEGACY_RUN);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(additions[at].evidenceClass).toBe("negative");
    // A partly locked answer (D65) stays behind every unlocked one, a negative included; a row rescued from under the inclusion floor is appended last.
    const open = (x: Record<string, any>): boolean => x.baseLocked === undefined && x.needsUnitAspect === undefined && x.nameLocked === undefined && x.needsForce === undefined && x.needsTrait === undefined;
    for (const r of additions.filter((x) => x.evidenceClass === "ok" && open(x) && x.hiddenByFloor === undefined)) expect(additions.indexOf(r), r.title).toBeLessThan(at);
  });

  it("no longer leads the additions on the default page, and the note states the rule", () => {
    const a = answers({ limit: 10 });
    expect(a.additions[0].cardKey).not.toBe(LEGACY_RUN);
    expect(a.note).toContain("is listed after every addition whose class is ok");
  });
});

describe.skipIf(!hasData)("leader_cards carries the penalty and the lock of each row under the given base (#161, D75)", () => {
  const lift = (extra: object = {}): Record<string, any> => body(META_TOOLS.leader_cards.handler(real, { leader: WARRIOR, limit: 20, sortBy: "lift", ...extra }));

  it("marks penalised rows with penalty and penalised: true under Origin Tree, and a row that pays none carries neither", () => {
    const cards = lift({ base: ORIGIN_TREE }).cards as Record<string, any>[];
    const volley = cards.find((c) => c.title === "Volley Fire") as Record<string, any>;
    expect(volley.penalty).toBe(2);
    expect(volley.penalised).toBe(true);
    const raiding = cards.find((c) => c.title === "Raiding Party") as Record<string, any>;
    expect(raiding.penalty).toBeUndefined();
    expect(raiding.penalised).toBeUndefined();
    expect(cards.filter((c) => c.penalised).length).toBeGreaterThanOrEqual(5);
  });

  it("flags the Tatooine-locked rows (Ritual Dragon, Sandstorm) under Origin Tree and none under Jundland Wastes", () => {
    const tree = lift({ base: ORIGIN_TREE }).cards as Record<string, any>[];
    expect(tree.find((c) => c.title === "Ritual Dragon")?.baseLocked).toBe("Tatooine");
    expect(tree.find((c) => c.title === "Sandstorm")?.baseLocked).toBe("Tatooine");
    const dune = lift({ base: "Jundland Wastes" }).cards as Record<string, any>[];
    expect(dune.filter((c) => c.baseLocked !== undefined)).toEqual([]);
  });

  it("keeps the old row shape when no base is given and points to the base argument in the note", () => {
    const a = lift();
    for (const c of a.cards as Record<string, any>[]) {
      expect(c.penalty).toBeUndefined();
      expect(c.baseLocked).toBeUndefined();
    }
    expect(a.note).toContain("Give base to see, per row, the aspect penalty it pays and the locks it carries");
  });
});

describe.skipIf(!hasData)("budget_alternatives flags Darth Sidious's Force lock in the Cad Bane core (#161, D75; judge-7-w15 step 10)", () => {
  const CORE = ["04010140", "08010148", "08010146", "04010239", "08010053", "04010043", "08010052", "08010030", "05010130", "08010048", "08010079", "06010163"].map((card) => ({ card, count: 3 }));
  const run = (extra: object = {}): Record<string, any> =>
    body(DECK_TOOLS.budget_alternatives.handler(real, { decklist: CORE, leader: "08010011", base: "08010020", maxPrice: 2, perSlot: 10, ...extra }));

  it("lists Sidious under Pre Vizsla with needsForce, after every open substitute of that slot", () => {
    const slot = (run().slots as Record<string, any>[]).find((s) => s.cardKey === "08010053") as Record<string, any>;
    const alts = slot.alternatives as Record<string, any>[];
    const at = alts.findIndex((a) => a.cardKey === "05010039");
    expect(alts[at].needsForce).toBe("use the Force");
    for (const open of alts.filter((a) => a.needsForce === undefined && a.needsTrait === undefined && a.baseLocked === undefined && a.nameLocked === undefined && a.needsUnitAspect === undefined))
      expect(alts.indexOf(open), open.title).toBeLessThan(at);
  });

  it("no longer offers him within the default three per slot", () => {
    const keys = (run({ perSlot: 3 }).slots as Record<string, any>[]).flatMap((s) => (s.alternatives as Record<string, any>[]).map((a) => a.cardKey));
    expect(keys).not.toContain("05010039");
  });
});
