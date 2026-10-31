import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { mechanicalRows } from "../../src/synergy/graph.js";
import type { ToolResult } from "../../src/tools.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  deck: { id: string; count: number }[];
};

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasData = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon")) && existsSync(path.join(builtRun, "meta/leader-cards.json"));

function body(result: ToolResult): Record<string, any> {
  expect(result.isError, result.content[0].text.slice(0, 300)).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

const OPPO = "05010105";
const ANAKIN_PRODIGY = "05010190";

// Session eight, sixth judge (#158, D69): Oppo Rancisis for the owner's deck, Anakin Skywalker, Force Prodigy as the named candidate.
describe.skipIf(!hasData)("fungible_substitutes splits partners from stand-ins for Oppo Rancisis against the built data (#158, D69)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const ctx = hasData ? synergyContextOf(real) : (undefined as never);
  const call = (extra: object = {}): Record<string, any> =>
    body(
      SYNERGY_TOOLS.fungible_substitutes.handler(real, {
        cardKey: OPPO,
        preferAspects: ["Cunning", "Heroism", "Command"],
        leader: "09010018",
        base: "09010024",
        candidates: ["LOF_190"],
        decklist: OWNER_DECK.deck.map((d) => ({ card: d.id, count: d.count })),
        evidence: false,
        ...extra,
      }),
    );
  const hasEdge = (key: string): boolean =>
    [`${key}>${OPPO}`, `${OPPO}>${key}`].some((k) => {
      const edge = ctx.graph.edgeByKey.get(k);
      return edge !== undefined && mechanicalRows(edge).length > 0;
    });

  it("lists Anakin Skywalker, Force Prodigy under partners, since he feeds Oppo", () => {
    const anakin = call().partners.find((p: any) => p.cardKey === ANAKIN_PRODIGY);
    expect(anakin).toMatchObject({ feedsOriginal: true, candidate: true });
    expect(anakin.feedsRow).toMatch(/offers:has-keyword-(hidden|shielded) -> wants:keyword-(hidden|shielded)$/);
  });

  it("returns a non-empty standIns list in which no card has a pair edge to Oppo, and partners that all have one", () => {
    const out = call({ maxPartners: 50 });
    expect(out.standIns.length).toBeGreaterThan(0);
    for (const row of out.standIns) expect(hasEdge(row.cardKey), `${row.title} is a partner`).toBe(false);
    expect(out.partners.length).toBeGreaterThan(1);
    for (const row of out.partners) expect(hasEdge(row.cardKey), `${row.title} has no edge`).toBe(true);
    const partnerKeys = new Set(out.partners.map((p: any) => p.cardKey));
    expect(out.standIns.some((s: any) => partnerKeys.has(s.cardKey))).toBe(false);
    const inRoles = out.roles.flatMap((r: any) => r.substitutes.flatMap((g: any) => g.cards.map((c: any) => c.cardKey)));
    expect(inRoles.some((k: string) => partnerKeys.has(k))).toBe(false);
  });

  it("no longer says the answer to which one is both", () => {
    expect(call().note).not.toContain("the answer to which one is both");
  });

  it("recommends between Oppo and Anakin from the penalty, the play share and the deck cards that feed each", () => {
    const rec = call().recommendation;
    const [oppo, anakin] = rec.cards;
    expect(oppo).toMatchObject({ cardKey: OPPO, role: "original", penalty: 2, playShare: "unplayed" });
    expect(anakin).toMatchObject({ cardKey: ANAKIN_PRODIGY, role: "candidate", penalty: 0, playShare: "unplayed", fedByDeck: 0 });
    expect(oppo.fedByDeck).toBeGreaterThan(3);
    for (const name of ["Captain Tarpals", "Tribubble Bongo Sub", "Grogu"]) expect(oppo.fedByCards, name).toContain(name);
    expect(oppo.fedByCards.split("; ")).toHaveLength(oppo.fedByDeck);
    expect(rec.keep).toBe(OPPO);
    expect(rec.decidedBy).toBe("deckFeeders");
    expect(rec.verdict).toBe(
      `Keep Oppo Rancisis, Ancient Councilor: ${oppo.fedByDeck} cards already in the deck feed it against 0 for Anakin Skywalker, Force Prodigy, a gap of at least 4 that outweighs its penalty 2, and Anakin Skywalker, Force Prodigy is a partner worth a slot elsewhere because it feeds Oppo Rancisis, Ancient Councilor. To make room for Anakin Skywalker, Force Prodigy, cut ${rec.cutForCandidate.title} (penalty ${rec.cutForCandidate.penalty}, unplayed, ${rec.cutForCandidate.deckLinks} pair links to other deck cards).`,
    );
    expect(call().note).toContain("recommendation (D69)");
  });

  it("gives no recommendation without candidates or without a decklist", () => {
    expect(call({ candidates: undefined })).not.toHaveProperty("recommendation");
    expect(call({ decklist: undefined })).not.toHaveProperty("recommendation");
  });
});
