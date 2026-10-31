import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun } from "../../src/data.js";
import { clauseLock, isLocked, lockSupply } from "../../src/synergy/clause-lock.js";
import type { ToolResult } from "../../src/tools.js";
import { resolveRef } from "../../src/tools/deck.js";
import { SYNERGY_TOOLS, synergyContextOf } from "../../src/tools/synergy.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8")) as {
  leader: { id: string };
  base: { id: string };
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
const RYYK = "09010118";
const WARRIOR = "09010018";
const ORIGIN_TREE = "09010024";

// Session eight, fifth judge (#157, D67): Oppo Rancisis for the owner's deck, Anakin Skywalker, Force Prodigy as the named candidate.
describe.skipIf(!hasData)("fungible_substitutes for Oppo Rancisis against the built data (#157, D67)", () => {
  const real = hasData ? loadStore(builtRun as string) : (undefined as never);
  const ctx = hasData ? synergyContextOf(real) : (undefined as never);
  const call = (extra: object = {}): Record<string, any> =>
    body(
      SYNERGY_TOOLS.fungible_substitutes.handler(real, {
        cardKey: OPPO,
        preferAspects: ["Cunning", "Heroism", "Command"],
        leader: WARRIOR,
        base: ORIGIN_TREE,
        candidates: ["LOF_190"],
        decklist: OWNER_DECK.deck.map((d) => ({ card: d.id, count: d.count })),
        evidence: false,
        ...extra,
      }),
    );
  const rowsOf = (out: Record<string, any>): Record<string, any>[] => out.roles.flatMap((r: any) => r.substitutes.flatMap((g: any) => g.cards));

  it("marks Anakin Skywalker, Force Prodigy as a card that feeds Oppo, with the edge's row, and says so in the note", () => {
    const out = call();
    const anakin = out.candidates.find((c: any) => c.cardKey === ANAKIN_PRODIGY);
    expect(anakin.feedsOriginal).toBe(true);
    expect(anakin.feedsRow).toMatch(/offers:has-keyword-(hidden|shielded) -> wants:keyword-(hidden|shielded)$/);
    expect(out.note).toContain("Partners, not replacements: Anakin Skywalker, Force Prodigy feeds Oppo Rancisis, Ancient Councilor");
  });

  it("lists at most 8 role classes, ordered by coverage, and says how many were cut", () => {
    const out = call();
    expect(out.classesTotal).toBeGreaterThan(8);
    expect(out.roles).toHaveLength(8);
    expect(out.classesCut).toBe(out.classesTotal - 8);
    const coverage: number[] = out.roles.map((r: any) => r.coverage);
    expect(coverage).toEqual([...coverage].sort((a, b) => b - a));
    expect(out.note).toContain(`${out.classesCut} cut`);
    expect(call({ maxClasses: 3 }).roles).toHaveLength(3);
  });

  it("flags exactly the cards the D59 lock holds, and ranks them after the unlocked cards of their group", () => {
    const out = call({ maxClasses: 50 });
    const leader = ctx.graph.byKey.get(WARRIOR);
    const base = ctx.graph.byKey.get(ORIGIN_TREE);
    const deckCards = OWNER_DECK.deck.flatMap((d) => {
      const hit = resolveRef(real, d.id, "main");
      const syn = hit.ok ? ctx.graph.byKey.get(hit.row.cardKey) : undefined;
      return syn === undefined ? [] : [syn];
    });
    const supply = lockSupply(leader, base, deckCards);
    let lockedSeen = 0;
    for (const role of out.roles) {
      for (const group of role.substitutes) {
        const flags = group.cards.map((c: any) => Boolean(c.baseLocked ?? c.needsUnitAspect ?? c.nameLocked));
        group.cards.forEach((c: any, i: number) => {
          const lock = clauseLock(ctx.graph.byKey.get(c.cardKey)!, supply);
          expect(flags[i], `${c.title} lock ${JSON.stringify(lock)}`).toBe(isLocked(lock));
        });
        expect(flags, `${role.tag} ${group.aspects}`).toEqual([...flags].sort((a, b) => Number(a) - Number(b)));
        lockedSeen += flags.filter(Boolean).length;
      }
    }
    expect(deckCards.length, "every deck line resolves").toBeGreaterThan(20);
    expect(lockedSeen, "the base-locked stand-ins of the judged call are flagged").toBeGreaterThan(0);
    const opee = rowsOf(out).find((r) => r.title === "Opee Sea Killer");
    expect(opee?.baseLocked).toBe("Naboo");
  });

  it("drops a rejected card named by SET id: Ryyk Blademaster is listed without exclude and gone with exclude [HMW_118]", () => {
    expect(rowsOf(call({ maxClasses: 50 })).some((r) => r.cardKey === RYYK)).toBe(true);
    const out = call({ maxClasses: 50, exclude: ["HMW_118"] });
    expect(rowsOf(out).some((r) => r.cardKey === RYYK)).toBe(false);
    expect(out.excluded).toBe(RYYK);
  });
});
