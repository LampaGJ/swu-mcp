import { decode } from "@toon-format/toon";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore, newestRun, type CardRow, type CardStore } from "../../src/data.js";
import type { ToolResult } from "../../src/tools.js";
import { DECK_TOOLS, deckEnvOf, resolveList, resolveRef } from "../../src/tools/deck.js";
import { expandSwudb, swudbDeckSchema } from "../../src/tools/swudb.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OWNER_DECK: unknown = JSON.parse(readFileSync(path.join(HERE, "../fixtures/decks/warrior-chewie-raid.swudb.json"), "utf8"));

function row(cardKey: string, title: string, extra: Record<string, unknown>): CardRow {
  return {
    cardKey,
    title,
    subtitle: null,
    type: "Unit",
    cost: 2,
    power: null,
    hp: null,
    aspects: null,
    traits: null,
    keywords: null,
    arenas: null,
    text: null,
    sets: "SOR",
    ...extra,
  };
}

const ROWS: CardRow[] = [
  row("0101033", "Death Trooper", { expansion: "SOR", cardNumber: 33, sets: "SOR|SHD" }),
  row("0101030", "Chopper Base", { type: "Base", cost: null, expansion: "SOR", cardNumber: 30 }),
  row("0101001", "Aggro Leader", { type: "Leader", cost: 6, subtitle: "The Hunter", expansion: "SOR", cardNumber: 1 }),
  row("05010002", "Mother Talzin", { type: "Leader", cost: 5, expansion: "LOF", cardNumber: 2, sets: "LOF" }),
  row("05010t02", "Shield Token", { type: "Token Upgrade", cost: null, expansion: "LOF", cardNumber: 2, sets: "LOF" }),
  row("0901005a", "Twin A", { expansion: "HMW", cardNumber: 5, sets: "HMW" }),
  row("0901005b", "Twin B", { expansion: "HMW", cardNumber: 5, sets: "HMW" }),
  row("legacy", "No Columns", {}),
];

const store: CardStore = {
  dataDir: "/nonexistent/swudb",
  cards: ROWS,
  byKey: new Map(ROWS.map((r) => [r.cardKey, r])),
  facets: new Map(),
};

const text = (result: ToolResult): string => result.content[0].text;
function body(result: ToolResult): Record<string, any> {
  expect(result.isError, text(result)).toBeUndefined();
  return decode(text(result)) as Record<string, any>;
}

describe("a SET_NNN id in the line form (#143)", () => {
  it("resolves through the expansion and card number columns", () => {
    const hit = resolveRef(store, "SOR_033", "main");
    expect(hit.ok && hit.row.cardKey).toBe("0101033");
    const leader = resolveRef(store, "SOR_001", "leader");
    expect(leader.ok && leader.row.cardKey).toBe("0101001");
  });

  it("resolves a reprint id to the first printing's cardKey when the sets column lists the set", () => {
    const reprint = resolveRef(store, "SHD_033", "main");
    expect(reprint.ok && reprint.row.cardKey).toBe("0101033");
  });

  it("errors naming an id that no card carries, and one in a set the card was not printed in", () => {
    for (const id of ["SOR_999", "JTL_033"]) {
      const miss = resolveRef(store, id, "main");
      expect(miss.ok).toBe(false);
      expect(!miss.ok && miss.detail).toContain(id);
    }
  });

  it("names every candidate when an id is ambiguous and prefers the card over a token that shares the number", () => {
    const twin = resolveRef(store, "HMW_005", "main");
    expect(twin.ok).toBe(false);
    expect(!twin.ok && twin.reason).toBe("ambiguous");
    expect(!twin.ok && twin.detail).toContain("0901005a");
    expect(!twin.ok && twin.detail).toContain("0901005b");
    const talzin = resolveRef(store, "LOF_002", "leader");
    expect(talzin.ok && talzin.row.cardKey).toBe("05010002");
    const token = resolveRef(store, "LOF_002", "main");
    expect(token.ok && token.row.cardKey).toBe("05010t02");
  });

  it("leaves cardKeys and titles resolving as before", () => {
    expect(resolveRef(store, "0101033", "main").ok).toBe(true);
    expect(resolveRef(store, "Death Trooper", "main").ok).toBe(true);
    expect(resolveRef(store, "legacy", "main").ok).toBe(true);
  });
});

describe("the interchange schema and its expansion into the line form (#143)", () => {
  const doc = {
    leader: { id: "SOR_001", count: 1 },
    base: { id: "SOR_030", count: 1 },
    deck: [{ id: "SOR_033", count: 3 }],
    sideboard: [{ id: "SHD_033", count: 1 }],
  };

  it("accepts the owner's export and rejects unknown keys, bad ids and a second leader", () => {
    expect(swudbDeckSchema.safeParse(OWNER_DECK).success).toBe(true);
    expect(swudbDeckSchema.safeParse({ ...doc, extra: 1 }).success).toBe(false);
    expect(swudbDeckSchema.safeParse({ ...doc, deck: [{ id: "sor-33", count: 1 }] }).success).toBe(false);
    expect(swudbDeckSchema.safeParse({ ...doc, leader: { id: "SOR_001", count: 2 } }).success).toBe(false);
  });

  it("rewrites the document into decklist, leader, base and sideboard", () => {
    expect(expandSwudb({ swudb: doc, gapLimit: 4 })).toEqual({
      input: {
        gapLimit: 4,
        decklist: [{ card: "SOR_033", count: 3 }],
        leader: "SOR_001",
        base: "SOR_030",
        sideboard: [{ card: "SHD_033", count: 1 }],
      },
    });
  });

  it("errors, naming the arguments given, when swudb comes with decklist, leader or base", () => {
    const both = expandSwudb({ swudb: doc, leader: "SOR_001", decklist: [{ card: "SOR_033", count: 1 }] });
    expect("error" in both && both.error).toContain("decklist, leader");
    expect("error" in both && both.error).toContain("swudb");
  });

  it("errors on a document that fails the schema, and passes through an input without swudb", () => {
    const bad = expandSwudb({ swudb: { ...doc, deck: [] } });
    expect("error" in bad && bad.error).toContain("swudb is not a SWUDB interchange document");
    const plain = { decklist: [{ card: "SOR_033", count: 1 }], leader: "SOR_001", base: "SOR_030" };
    expect(expandSwudb(plain)).toEqual({ input: plain });
  });
});

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const hasCards = builtRun !== undefined && existsSync(path.join(builtRun, "llm/cards.toon"));

describe.skipIf(!hasCards)("the owner's export against the built data (#143)", () => {
  const real = hasCards ? loadStore(builtRun as string) : (undefined as never);
  const expanded = expandSwudb({ swudb: OWNER_DECK });
  const input = "input" in expanded ? (expanded.input as { decklist: { card: string; count: number }[]; sideboard: { card: string; count: number }[] }) : null;

  it("resolves all 50 deck cards and all 10 sideboard cards with none unresolved", () => {
    expect(input).not.toBeNull();
    const env = deckEnvOf(real);
    const main = resolveList(env, input?.decklist ?? [], "main");
    const bench = resolveList(env, input?.sideboard ?? [], "main");
    expect(main.unresolved).toEqual([]);
    expect(bench.unresolved).toEqual([]);
    expect([main.copies, bench.copies]).toEqual([50, 10]);
    expect(resolveRef(real, "HMW_018", "leader").ok).toBe(true);
    expect(resolveRef(real, "HMW_024", "base").ok).toBe(true);
  });

  it("answers deck_audit with the swudb argument, naming The Warrior, Deft Duelist and Origin Tree", () => {
    const out = body(DECK_TOOLS.deck_audit.handler(real, { swudb: OWNER_DECK }));
    expect(out.leader.title).toContain("The Warrior");
    expect(out.leader.title).toContain("Deft Duelist");
    expect(out.base.title).toBe("Origin Tree");
    expect(out.deck.cards).toBe(50);
    expect(out.unresolved).toEqual([]);
    expect(out.sideboard.cards).toBe(10);
    expect(out.sideboard.rows.length).toBe(6);
  });

  it("answers deck_legality_check with the swudb argument and checks the sideboard limit", () => {
    const out = body(DECK_TOOLS.deck_legality_check.handler(real, { swudb: OWNER_DECK }));
    expect(out.leader.title).toContain("Deft Duelist");
    expect(out.base.title).toBe("Origin Tree");
    expect(out.counts.sideboard).toBe(10);
    expect(out.dataLimits.join(" ")).not.toContain("sideboard is not checked");
    const big = { ...(OWNER_DECK as object), sideboard: [{ id: "HMW_238", count: 11 }] };
    const over = body(DECK_TOOLS.deck_legality_check.handler(real, { swudb: big }));
    expect(over.legal).toBe(false);
    expect(JSON.stringify(over.failures)).toContain("sideboard");
  });

  it("errors from the handler when swudb comes with the existing arguments, and names an unknown id", () => {
    const both = DECK_TOOLS.deck_audit.handler(real, { swudb: OWNER_DECK, leader: "HMW_018" });
    expect(both.isError).toBe(true);
    expect(text(both)).toContain("leader");
    const unknown = { ...(OWNER_DECK as object), deck: [{ id: "HMW_999", count: 50 }] };
    const miss = DECK_TOOLS.deck_audit.handler(real, { swudb: unknown });
    expect(miss.isError).toBe(true);
    expect(text(miss)).toContain("HMW_999");
  });

  it("takes swudb on every deck-taking tool", () => {
    for (const name of ["deck_audit", "deck_legality_check", "budget_alternatives", "fungible_in_deck", "owned_vs_needed", "playable_cards"] as const) {
      expect(Object.keys(DECK_TOOLS[name].shape), name).toContain("swudb");
    }
    for (const name of ["fungible_in_deck", "budget_alternatives"] as const) {
      const out = DECK_TOOLS[name].handler(real, { swudb: OWNER_DECK });
      expect(out.isError, `${name}: ${text(out).slice(0, 200)}`).toBeUndefined();
    }
    const owned = DECK_TOOLS.owned_vs_needed.handler(real, { swudb: OWNER_DECK, owned: [{ card: "HMW_254", count: 2 }] });
    expect(owned.isError, text(owned).slice(0, 200)).toBeUndefined();
  });
});
