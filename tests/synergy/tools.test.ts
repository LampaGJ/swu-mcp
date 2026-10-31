import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decode } from "@toon-format/toon";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createServer } from "../../src/create-server.js";
import { loadStore } from "../../src/data.js";
import { createSynergyContext } from "../../src/synergy/context.js";
import { aspectCover, deferRepeatedLinks, explainSynergy, findPairings, findTrios, fungibleSubstitutes, SYNERGY_TOOLS } from "../../src/tools/synergy.js";
import { indexLeaderCards } from "../../src/meta/schema.js";
import type { ToolResult } from "../../src/tools.js";
import { COMMITTED_TABLE, mk, table } from "./fixtures.js";

const unit = (key: string, title: string, aspects: string[], cost: number, extra: Record<string, unknown> = {}) =>
  mk(key, title, { aspects, cost, abilities: [{ repeat: "once_on_play", text: `${title} text`, n: 1 }], ...extra });

const cards = [
  mk("L1", "Aggro Leader", { type: "Leader", icons: ["Aggression", "Villainy"] }),
  mk("L2", "Green Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
  mk("BC", "Command Base", { type: "Base", icons: ["Command"] }),
  mk("BV", "Vigilance Base", { type: "Base", icons: ["Vigilance"] }),
  unit("1", "Death Trooper", ["Vigilance", "Villainy"], 3, {
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": "text: Death Trooper text" },
  }),
  unit("2", "Pinger Red", ["Aggression"], 3, {
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": "text: Pinger Red text" },
  }),
  unit("3", "Pinger Green", ["Command"], 3, {
    offers: ["offers:damage-friendly-unit"],
    why: { "offers:damage-friendly-unit": "text: Pinger Green text" },
  }),
  unit("4", "The Elite Squad", ["Aggression", "Villainy"], 8, { wants: ["wants:damage-friendly"] }),
  unit("5", "Grit Brute", ["Aggression"], 3, { wants: ["wants:self-damaged"], offers: ["offers:draw"] }),
  unit("6", "Draw Payoff", ["Command"], 2, { wants: ["wants:draw"] }),
];

const ctx = createSynergyContext(cards, COMMITTED_TABLE);

function body(result: ToolResult): Record<string, any> {
  expect(result.isError).toBeUndefined();
  return decode(result.content[0].text) as Record<string, any>;
}

describe("fungible_substitutes", () => {
  it("lists substitutes for the slot's role, grouped by aspect", () => {
    const out = body(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:damage-friendly-unit" }));
    expect(out.roles).toHaveLength(1);
    const role = out.roles[0];
    expect(role.classSize).toBe(3);
    expect(role.substitutes.map((g: any) => g.aspects)).toEqual(["Aggression", "Command"]);
    expect(role.substitutes.every((g: any) => g.differsFromSlot)).toBe(true);
  });

  it("puts aspects the deck covers first", () => {
    const out = body(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:damage-friendly-unit", preferAspects: ["Command"] }));
    expect(out.roles[0].substitutes[0]).toMatchObject({ aspects: "Command", covered: true });
  });

  it("reports every role when no tag is given, and errors on an unknown card or tag", () => {
    expect(body(fungibleSubstitutes(ctx, { cardKey: "5" })).roles.map((r: any) => r.tag)).toEqual(["offers:draw", "wants:self-damaged"]);
    expect(fungibleSubstitutes(ctx, { cardKey: "nope" }).isError).toBe(true);
    expect(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:heal" }).isError).toBe(true);
  });
});

describe("find_pairings", () => {
  it("finds payoffs and enablers with reason, score and penalty", () => {
    const out = body(findPairings(ctx, { cardKey: "1" }));
    const partners = out.pairings.map((p: any) => p.cardKey);
    expect(partners).toEqual(expect.arrayContaining(["4", "5"]));
    const squad = out.pairings.find((p: any) => p.cardKey === "4");
    expect(squad).toMatchObject({ partnerIs: "payoff", link: "offers:damage-friendly-unit -> wants:damage-friendly" });
    expect(squad.reason).toContain("Damaging your own unit");
    expect(squad.score).toBeGreaterThan(0);
    expect(typeof squad.penalty).toBe("number");
  });

  it("filters by direction, maxCost and trait-only links", () => {
    expect(body(findPairings(ctx, { cardKey: "4", direction: "payoffs" })).pairings).toEqual([]);
    const enablers = body(findPairings(ctx, { cardKey: "4", direction: "enablers" }));
    expect(enablers.pairings.every((p: any) => p.partnerIs === "enabler")).toBe(true);
    expect(body(findPairings(ctx, { cardKey: "1", maxCost: 2 })).pairings).toEqual([]);
  });

  it("measures the penalty against the aspects given and ranks covered partners higher", () => {
    const out = body(findPairings(ctx, { cardKey: "1", aspects: ["Aggression", "Villainy"] }));
    const grit = out.pairings.find((p: any) => p.cardKey === "5");
    expect(grit.penalty).toBe(2);
    expect(grit.rank).toBeLessThan(grit.score);
    const squad = out.pairings.find((p: any) => p.cardKey === "4");
    expect(squad.penalty).toBe(2);
  });

  it("lists the partner slot's alternatives by aspect", () => {
    const out = body(findPairings(ctx, { cardKey: "4", direction: "enablers" }));
    const trooper = out.pairings.find((p: any) => p.cardKey === "1");
    expect(trooper.alternatives.join(" ")).toContain("Pinger Red");
    expect(trooper.alternatives.join(" ")).toContain("Pinger Green");
    expect(
      body(findPairings(ctx, { cardKey: "4", direction: "enablers", withAlternatives: false })).pairings[0].alternatives,
    ).toBeUndefined();
  });

  it("rejects an unknown card", () => {
    expect(findPairings(ctx, { cardKey: "nope" }).isError).toBe(true);
  });
});

describe("find_pairings perLink", () => {
  const linkCtx = createSynergyContext(
    [
      mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Base", { type: "Base", icons: ["Command"] }),
      mk("F", "Focus", { offers: ["offers:x", "offers:y"], aspects: ["Command"], cost: 2 }),
      ...["A1", "A2", "A3", "A4"].map((k) => mk(k, `Payoff ${k}`, { wants: ["wants:x"], aspects: ["Command"], cost: 2 })),
      ...["B1", "B2", "B3"].map((k) => mk(k, `Payoff ${k}`, { wants: ["wants:y"], aspects: ["Command"], cost: 2 })),
    ],
    table([
      { id: "rx", offers: { "offers:x": 1 }, wants: { "wants:x": 1 }, strength: 3 },
      { id: "ry", offers: { "offers:y": 1 }, wants: { "wants:y": 1 }, strength: 1 },
    ]),
  );
  const keys = (out: Record<string, any>) => out.pairings.map((p: any) => p.cardKey);
  const args = { cardKey: "F", withAlternatives: false, evidence: false, limit: 100 };

  it("ranks the stronger link first with no cap (perLink 100)", () => {
    const out = body(findPairings(linkCtx, { ...args, perLink: 100 }));
    expect(keys(out)).toEqual(["A1", "A2", "A3", "A4", "B1", "B2", "B3"]);
    expect(out).toMatchObject({ total: 7, shown: 7, capped: 0 });
    expect(out.note).toBeUndefined();
  });

  it("lists at most perLink rows per link first, then the deferred tail in rank order", () => {
    const out = body(findPairings(linkCtx, { ...args, perLink: 2 }));
    expect(keys(out)).toEqual(["A1", "A2", "B1", "B2", "A3", "A4", "B3"]);
    expect(out).toMatchObject({ total: 7, shown: 7, capped: 3 });
    expect(out.note).toContain("perLink 2");
    expect(out.note).toContain("3 further rows");
  });

  it("defaults to 3 rows per link and keeps deferred rows reachable by limit", () => {
    const out = body(findPairings(linkCtx, { ...args, limit: 5 }));
    expect(keys(out)).toEqual(["A1", "A2", "A3", "B1", "B2"]);
    expect(out).toMatchObject({ total: 7, shown: 5, capped: 1 });
  });

  it("matches the uncapped output when no link repeats more than perLink times", () => {
    const capped = body(findPairings(linkCtx, { ...args, perLink: 4 }));
    const open = body(findPairings(linkCtx, { ...args, perLink: 100 }));
    expect(capped.pairings).toEqual(open.pairings);
    expect(capped.capped).toBe(0);
  });

  it("rejects perLink outside 1-100", () => {
    expect(() => findPairings(linkCtx, { ...args, perLink: 0 })).toThrow();
    expect(() => findPairings(linkCtx, { ...args, perLink: 101 })).toThrow();
  });
});

describe("deferRepeatedLinks", () => {
  const rows = [
    { id: 1, link: "a" },
    { id: 2, link: "a" },
    { id: 3, link: "a" },
    { id: 4, link: "b" },
    { id: 5, link: "a" },
    { id: 6, link: "b" },
  ];

  it("keeps the first perLink rows of each link, then the deferred rows, each in input order", () => {
    const out = deferRepeatedLinks(rows, (r) => r.link, 2);
    expect(out.ordered.map((r) => r.id)).toEqual([1, 2, 4, 6, 3, 5]);
    expect(out.deferred).toBe(2);
  });

  it("returns the input order when the cap is never reached", () => {
    const out = deferRepeatedLinks(rows, (r) => r.link, 100);
    expect(out.ordered).toEqual(rows);
    expect(out.deferred).toBe(0);
  });
});

describe("find_trios", () => {
  const chainCtx = createSynergyContext(
    [
      mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Base", { type: "Base", icons: ["Command"] }),
      mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
      mk("1b", "Alpha Twin", { offers: ["offers:x"], aspects: ["Cunning"], cost: 2 }),
      mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
      mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 9 }),
      mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
    ],
    table([
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    ]),
  );

  it("returns ranked trios with cost, aspect pair, penalty and per-slot alternatives", () => {
    const out = body(findTrios(chainCtx, {}));
    expect(out.trios[0]).toMatchObject({ shape: "chain", cardKeys: "1|2|4", totalCost: 6, penalty: 0 });
    expect(out.trios[0].aspectPair).toBe("leader Command+Heroism / base Command");
    const slotA = out.trios[0].alternatives[0];
    expect(slotA).toMatchObject({ slot: "A", roles: "offers:x" });
    expect(slotA.substitutes.join(" ")).toContain("Alpha Twin");
  });

  it("caps total cost (default 9) and filters by card and shape", () => {
    const out = body(findTrios(chainCtx, {}));
    expect(out.trios.every((t: any) => t.totalCost <= 9)).toBe(true);
    expect(out.trios.map((t: any) => t.cardKeys)).not.toContain("1|2|3");
    const wide = body(findTrios(chainCtx, { maxTotalCost: 20 }));
    expect(wide.trios.map((t: any) => t.cardKeys)).toContain("1|2|3");
    expect(body(findTrios(chainCtx, { cardKey: "4" })).trios.every((t: any) => t.cardKeys.split("|").includes("4"))).toBe(true);
    expect(findTrios(chainCtx, { shape: "loop" }).content[0].text).toContain("shown: 0");
  });

  it("measures the penalty against a fixed leader and base", () => {
    const out = body(findTrios(chainCtx, { leaderAspects: ["Aggression", "Villainy"], baseAspects: ["Vigilance"] }));
    expect(out.trios[0].penalty).toBe(6);
    expect(out.trios[0].aspectPair).toBe("leader Aggression+Villainy / base Vigilance");
  });

  it("rejects an unknown card", () => {
    expect(findTrios(chainCtx, { cardKey: "nope" }).isError).toBe(true);
  });
});

describe("leader and base partners", () => {
  const lbCtx = createSynergyContext(
    [
      mk("L", "Cover Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Cover Base", { type: "Base", icons: ["Command"] }),
      mk("LX", "Feeding Leader", { type: "Leader", aspects: ["Command"], cost: 1, offers: ["offers:x"] }),
      mk("BX", "Wanting Base", { type: "Base", aspects: ["Command"], cost: 0, wants: ["wants:y"] }),
      mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
      mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
      mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
    ],
    table([
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    ]),
  );
  const pairKeys = (out: Record<string, any>) => out.pairings.map((p: any) => p.cardKey).sort();

  it("find_pairings leaves Leader and Base partners out by default and says so", () => {
    const enablers = body(findPairings(lbCtx, { cardKey: "2", direction: "enablers", withAlternatives: false }));
    expect(pairKeys(enablers)).toEqual(["1"]);
    expect(enablers.partnerFilter).toContain("Leader and Base");
    expect(enablers.partnerFilter).toContain("includeLeaders");
    const payoffs = body(findPairings(lbCtx, { cardKey: "2", direction: "payoffs", withAlternatives: false }));
    expect(pairKeys(payoffs)).toEqual(["4"]);
    expect(body(findPairings(lbCtx, { cardKey: "2", withAlternatives: false })).total).toBe(2);
  });

  it("find_pairings lists them when includeLeaders is true", () => {
    const out = body(findPairings(lbCtx, { cardKey: "2", includeLeaders: true, withAlternatives: false }));
    expect(pairKeys(out)).toEqual(["1", "4", "BX", "LX"]);
    expect(out.partnerFilter).toContain("included");
    expect(out.pairings.find((p: any) => p.cardKey === "LX")).toMatchObject({ type: "Leader", partnerIs: "enabler" });
  });

  it("find_pairings from a Leader still lists its Unit partners", () => {
    const out = body(findPairings(lbCtx, { cardKey: "LX", withAlternatives: false }));
    expect(pairKeys(out)).toEqual(["2"]);
  });

  it("find_pairings keeps Leader and Base cards out of the partner alternatives", () => {
    const out = body(findPairings(lbCtx, { cardKey: "2", direction: "enablers" }));
    expect(out.pairings[0].alternatives.join(" ")).not.toContain("Feeding Leader");
  });

  it("find_trios never builds a trio around a Leader or Base unless includeLeaders is true", () => {
    const hasLeader = (out: Record<string, any>) => out.trios.some((t: any) => /LX|BX/.test(t.cardKeys));
    const out = body(findTrios(lbCtx, {}));
    expect(out.trios.length).toBeGreaterThan(0);
    expect(hasLeader(out)).toBe(false);
    expect(out.partnerFilter).toContain("Leader and Base");
    const open = body(findTrios(lbCtx, { includeLeaders: true }));
    expect(hasLeader(open)).toBe(true);
    expect(open.partnerFilter).toContain("included");
  });
});

describe("explain_synergy", () => {
  it("explains a link with rows, tags, the text behind each tag and the non-obviousness terms", () => {
    const out = body(explainSynergy(ctx, { cardKeys: ["1", "4"] }));
    expect(out.links).toHaveLength(1);
    expect(out.links[0]).toMatchObject({ from: "Death Trooper", to: "The Elite Squad", differentAspects: true });
    expect(out.links[0].rows[0]).toMatchObject({
      row: "ping-own-damage-payoff",
      offer: "offers:damage-friendly-unit",
      want: "wants:damage-friendly",
    });
    expect(out.evidence.map((e: any) => e.tag)).toEqual(["offers:damage-friendly-unit", "wants:damage-friendly"]);
    expect(out.totalCost).toBe(11);
  });

  it("names pairs with no link, and checks the keys", () => {
    const out = body(explainSynergy(ctx, { cardKeys: ["1", "4", "6"] }));
    expect(out.noLink).toEqual(expect.arrayContaining(["Death Trooper / Draw Payoff"]));
    expect(explainSynergy(ctx, { cardKeys: ["1", "1"] }).isError).toBe(true);
    expect(explainSynergy(ctx, { cardKeys: ["1", "nope"] }).isError).toBe(true);
    expect(() => explainSynergy(ctx, { cardKeys: ["1"] })).toThrow();
  });
});

describe("aspect_cover", () => {
  it("ranks leader and base combinations cheapest first with the arithmetic", () => {
    const out = body(aspectCover(ctx, { cardKeys: ["2", "3"] }));
    expect(out.combinations).toBe(4);
    expect(out.combos[0].penalty).toBe(0);
    const penalties = out.combos.map((c: any) => c.penalty);
    expect(penalties).toEqual([...penalties].sort((a, b) => a - b));
    expect(out.best.combo).toBe("leader Aggression+Villainy / base Command");
    const worst = body(aspectCover(ctx, { cardKeys: ["2", "3"], limit: 100 })).combos.at(-1);
    expect(worst.penalty).toBe(2);
  });

  it("tests one fixed combination and lists the uncovered icons per card", () => {
    const out = body(aspectCover(ctx, { cardKeys: ["2", "3", "5"], leaderAspects: ["Command", "Heroism"], baseAspects: ["Command"] }));
    expect(out.combinations).toBe(1);
    expect(out.best.penalty).toBe(4);
    expect(out.best.uncovered.map((u: any) => [u.card, u.icons])).toEqual([
      ["Pinger Red", "Aggression"],
      ["Grit Brute", "Aggression"],
    ]);
  });

  it("counts penalty-free combinations and rejects unknown cards", () => {
    expect(body(aspectCover(ctx, { cardKeys: ["6"] })).penaltyFree).toBe(3);
    expect(aspectCover(ctx, { cardKeys: ["nope"] }).isError).toBe(true);
  });
});

describe("registration", () => {
  const store = loadStore(path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures"));

  it("exposes the five tools through the server", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([createServer(store).connect(serverSide), client.connect(clientSide)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of Object.keys(SYNERGY_TOOLS)) expect(names).toContain(name);
    await client.close();
  });

  it("reports a missing feature file as a tool error that names the fix", () => {
    const bare = { ...store, dataDir: path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures-missing/llm") };
    const result = SYNERGY_TOOLS.aspect_cover.handler(bare, { cardKeys: ["0101033"] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pnpm card-features");
  });
});

describe("candidate evidence", () => {
  const long = "x".repeat(300);
  const evCtx = createSynergyContext(
    [
      mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
      mk("Z", "Base", { type: "Base", icons: ["Command"] }),
      mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2, why: { "offers:x": `text: Alpha pings ${long}` } }),
      mk("1b", "Alpha Twin", { offers: ["offers:x"], aspects: ["Cunning"], cost: 2, why: { "offers:x": "text: Twin pings" } }),
      mk("2", "Bravo", {
        wants: ["wants:x"],
        offers: ["offers:y"],
        aspects: ["Command"],
        cost: 3,
        why: { "wants:x": "text: Bravo wants pings", "offers:y": "text: Bravo gives y" },
      }),
      mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1, why: { "wants:y": "text: Delta wants y" } }),
    ],
    table([
      { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
      { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
    ]),
  );

  it("find_pairings returns status candidate and the clause text of both cards, clipped to 160 characters", () => {
    const row = body(findPairings(evCtx, { cardKey: "2", direction: "enablers" })).pairings.find((p: any) => p.cardKey === "1");
    expect(row.status).toBe("candidate");
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0].want).toBe("text: Bravo wants pings");
    expect(row.evidence[0].offer.length).toBe(160);
    expect(row.evidence[0].offer.endsWith("…")).toBe(true);
    expect(row.evidence[0].offer.startsWith("text: Alpha pings")).toBe(true);
  });

  it("find_pairings leaves evidence out on request but keeps the status", () => {
    const row = body(findPairings(evCtx, { cardKey: "2", direction: "enablers", evidence: false })).pairings[0];
    expect(row.evidence).toBeUndefined();
    expect(row.status).toBe("candidate");
  });

  it("find_trios carries each link's clause texts", () => {
    const trio = body(findTrios(evCtx, {})).trios[0];
    expect(trio.status).toBe("candidate");
    expect(trio.evidence.map((e: any) => [e.link, e.want])).toEqual([
      ["Alpha > Bravo", "text: Bravo wants pings"],
      ["Bravo > Delta", "text: Delta wants y"],
    ]);
    expect(trio.evidence[1].offer).toBe("text: Bravo gives y");
    expect(body(findTrios(evCtx, { evidence: false })).trios[0].evidence).toBeUndefined();
  });

  it("explain_synergy clips the tag text, adds the status and honours evidence:false", () => {
    const out = body(explainSynergy(evCtx, { cardKeys: ["1", "2"] }));
    expect(out.status).toBe("candidate");
    expect(out.evidence.find((e: any) => e.tag === "offers:x").why.length).toBe(160);
    const bare = body(explainSynergy(evCtx, { cardKeys: ["1", "2"], evidence: false }));
    expect(bare.evidence).toBeUndefined();
    expect(bare.status).toBe("candidate");
  });

  it("fungible_substitutes shows the role clause of the slot card and of each substitute", () => {
    const out = body(fungibleSubstitutes(evCtx, { cardKey: "1", tag: "offers:x" }));
    expect(out.status).toBe("candidate");
    const role = out.roles[0];
    expect(role.slotText.length).toBe(160);
    expect(role.substitutes[0].cards[0]).toMatchObject({ cardKey: "1b", text: "text: Twin pings" });
    const bare = body(fungibleSubstitutes(evCtx, { cardKey: "1", tag: "offers:x", evidence: false }));
    expect(bare.roles[0].slotText).toBeUndefined();
    expect(bare.roles[0].substitutes[0].cards[0].text).toBeUndefined();
  });

  it("describes the candidate status in the four tool descriptions", () => {
    for (const name of ["find_pairings", "find_trios", "explain_synergy", "fungible_substitutes"] as const)
      expect(SYNERGY_TOOLS[name].description).toContain("candidate");
  });
});

describe("fungible_substitutes widening", () => {
  const lone = (key: string, title: string, cost: number, n: number, extra: Record<string, unknown> = {}) =>
    mk(key, title, {
      cost,
      aspects: ["Command"],
      arenas: ["Ground"],
      wants: ["wants:self-damaged"],
      why: { "wants:self-damaged": `text: ${title} wants` },
      abilities: [{ repeat: "static", text: `${title} wants`, n }],
      ...extra,
    });
  const wideCtx = createSynergyContext(
    [
      lone("slot", "Lone Slot", 3, 1),
      lone("near", "Next Band", 5, 1, { aspects: ["Aggression"] }),
      lone("big", "Bigger", 5, 3, { aspects: ["Cunning"] }),
      lone("space", "Other Arena", 4, 1, { arenas: ["Space"] }),
    ],
    COMMITTED_TABLE,
  );

  it("reports widened: 'cost band' and tags the substitutes found that way", () => {
    const out = body(fungibleSubstitutes(wideCtx, { cardKey: "slot", tag: "wants:self-damaged", evidence: false }));
    const role = out.roles[0];
    expect(role.classSize).toBe(1);
    expect(role.widened).toBe("cost band");
    const cards = role.substitutes.flatMap((g: any) => g.cards);
    expect(cards.map((c: any) => c.cardKey)).toEqual(["near"]);
    expect(cards.every((c: any) => c.match === "widened")).toBe(true);
  });

  it("widens past magnitude only when the cost-band step finds nothing, and keeps the arena", () => {
    const only = createSynergyContext([lone("slot", "Lone Slot", 3, 1), lone("big", "Bigger", 5, 3), lone("space", "Other Arena", 4, 3, { arenas: ["Space"] })], COMMITTED_TABLE);
    const role = body(fungibleSubstitutes(only, { cardKey: "slot", tag: "wants:self-damaged", evidence: false })).roles[0];
    expect(role.widened).toBe("cost band + magnitude");
    expect(role.substitutes.flatMap((g: any) => g.cards.map((c: any) => [c.cardKey, c.match]))).toEqual([["big", "widened"]]);
  });

  it("reports widened: null, and no match field, when the exact class has other members", () => {
    const role = body(fungibleSubstitutes(ctx, { cardKey: "1", tag: "offers:damage-friendly-unit" })).roles[0];
    expect(role.widened).toBeNull();
    expect(role.substitutes.flatMap((g: any) => g.cards).some((c: any) => "match" in c)).toBe(false);
  });

  it("reports widened: null with no substitutes when widening finds nothing", () => {
    const alone = createSynergyContext([lone("slot", "Lone Slot", 3, 1), lone("far", "Far", 9, 1)], COMMITTED_TABLE);
    const role = body(fungibleSubstitutes(alone, { cardKey: "slot", tag: "wants:self-damaged", evidence: false })).roles[0];
    expect(role.widened).toBeNull();
    expect(role.substitutes).toEqual([]);
  });
});

/** A small leader-cards.json (meta/leader-cards.json shape, src/meta/schema.ts leaderCardsFileSchema). */
const leaderCardsFile = (leaderKey: string, title: string, aspects: string[], rows: [string, number][]) =>
  indexLeaderCards({
    schemaVersion: 1,
    window: { from: "2026-07-20", to: "2026-10-17", days: 90 },
    weighting: "test weighting",
    baseline: "test baseline",
    maxCards: 150,
    leaders: [
      {
        leader: { cardKey: leaderKey, title, aspects },
        population: "tournament",
        fallback: false,
        decks: 12,
        weight: 10.5,
        window: { from: "2026-07-20", to: "2026-10-17" },
        topBase: null,
        cards: rows.map(([cardKey, inclusion]) => ({ cardKey, title: cardKey, inclusion, meanCopies: 2, baselineInclusion: 0.1, lift: inclusion - 0.1 })),
      },
    ],
  });

describe("find_pairings with a leader", () => {
  const leaderCtx = createSynergyContext(cards, COMMITTED_TABLE, leaderCardsFile("L1", "Aggro Leader", ["Aggression", "Villainy"], [["5", 0.8]]));

  it("leaves the no-leader answer byte-identical when leader data is loaded", () => {
    for (const args of [{ cardKey: "1" }, { cardKey: "1", aspects: ["Command"] }, { cardKey: "4", direction: "enablers" }]) {
      expect(findPairings(leaderCtx, args).content[0].text).toBe(findPairings(ctx, args).content[0].text);
    }
  });

  it("carries each partner's leaderInclusion (null when unplayed) and weights the rank by it", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "L1" }));
    const plain = body(findPairings(ctx, { cardKey: "1", aspects: ["Aggression", "Villainy"] }));
    const rankOf = (o: Record<string, any>, k: string) => o.pairings.find((p: any) => p.cardKey === k).rank as number;
    const grit = out.pairings.find((p: any) => p.cardKey === "5");
    const squad = out.pairings.find((p: any) => p.cardKey === "4");
    expect(grit.leaderInclusion).toBe(0.8);
    expect(squad.leaderInclusion).toBeNull();
    expect(grit.rank).toBeCloseTo(rankOf(plain, "5") * 1.3, 3);
    expect(squad.rank).toBeCloseTo(rankOf(plain, "4") * 0.5, 3);
    expect(out.pairings[0].cardKey).toBe("5");
  });

  it("defaults aspects to the leader's icons and names the population and window", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "Aggro Leader" }));
    expect(out.pairings.every((p: any) => p.aspectPair === "icons Aggression+Villainy")).toBe(true);
    expect(out.leader).toMatchObject({ cardKey: "L1", population: "tournament", decks: 12, window: "2026-07-20..2026-10-17" });
    expect(out.leader.note).toContain("tournament, 12 decks, 2026-07-20..2026-10-17");
    const given = body(findPairings(leaderCtx, { cardKey: "1", leader: "L1", aspects: ["Command"] }));
    expect(given.pairings.every((p: any) => p.aspectPair === "icons Command")).toBe(true);
  });

  it("rejects a leader that is not a Leader card", () => {
    expect(findPairings(leaderCtx, { cardKey: "1", leader: "nope" }).isError).toBe(true);
    expect(findPairings(leaderCtx, { cardKey: "1", leader: "5" }).isError).toBe(true);
  });

  it("says so when the package has no decklists for the leader, and does not weight the rank", () => {
    const out = body(findPairings(leaderCtx, { cardKey: "1", leader: "L2" }));
    expect(out.leader.note).toContain("no decklist data");
    expect(out.pairings.every((p: any) => !("leaderInclusion" in p))).toBe(true);
  });
});

describe("find_trios with a leader", () => {
  const trioCards = [
    mk("L", "Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
    mk("Z", "Base", { type: "Base", icons: ["Command"] }),
    mk("1", "Alpha", { offers: ["offers:x"], aspects: ["Command"], cost: 2 }),
    mk("2", "Bravo", { wants: ["wants:x"], offers: ["offers:y"], aspects: ["Command"], cost: 3 }),
    mk("3", "Charlie", { wants: ["wants:y"], aspects: ["Command"], cost: 3 }),
    mk("4", "Delta", { wants: ["wants:y"], aspects: ["Command"], cost: 1 }),
  ];
  const trioTable = table([
    { id: "r1", offers: { "offers:x": 1 }, wants: { "wants:x": 1 } },
    { id: "r2", offers: { "offers:y": 1 }, wants: { "wants:y": 1 } },
  ]);
  const plainCtx = createSynergyContext(trioCards, trioTable);
  const leaderCtx = createSynergyContext(trioCards, trioTable, leaderCardsFile("L", "Leader", ["Command", "Heroism"], [["1", 0.5], ["2", 0.5], ["3", 0.9]]));

  it("leaves the no-leader answer byte-identical when leader data is loaded", () => {
    expect(findTrios(leaderCtx, {}).content[0].text).toBe(findTrios(plainCtx, {}).content[0].text);
  });

  it("carries each member's leaderInclusion and ranks played members first", () => {
    const plain = body(findTrios(plainCtx, { leaderAspects: ["Command", "Heroism"] }));
    expect(plain.trios[0].cardKeys).toBe("1|2|4");
    const out = body(findTrios(leaderCtx, { leader: "L" }));
    expect(out.trios[0].cardKeys).toBe("1|2|3");
    expect(out.trios[0].leaderInclusion).toEqual([0.5, 0.5, 0.9]);
    const delta = out.trios.find((t: any) => t.cardKeys === "1|2|4");
    expect(delta.leaderInclusion).toEqual([0.5, 0.5, null]);
    expect(delta.rank).toBeCloseTo(delta.score * 1 * 1 * 0.5, 3);
  });

  it("defaults the leader aspects to the leader's icons and names the population and window", () => {
    const out = body(findTrios(leaderCtx, { leader: "L" }));
    expect(out.trios[0].aspectPair).toBe(body(findTrios(plainCtx, { leaderAspects: ["Command", "Heroism"] })).trios[0].aspectPair);
    expect(out.leader).toMatchObject({ cardKey: "L", population: "tournament", window: "2026-07-20..2026-10-17" });
    expect(findTrios(leaderCtx, { leader: "nope" }).isError).toBe(true);
  });
});

describe("fungible_substitutes ordering and keyword roles", () => {
  const sentinel = (key: string, title: string, extra: Record<string, unknown> = {}) =>
    mk(key, title, { cost: 3, aspects: ["Command"], arenas: ["Ground"], power: 3, hp: 4, keywords: ["Sentinel"], ...extra });
  const orderCtx = (rows: [string, number][]) =>
    createSynergyContext(
      [
        mk("LD", "Order Leader", { type: "Leader", icons: ["Command", "Heroism"] }),
        sentinel("slot", "Slot Sentinel", {
          aspects: ["Vigilance"],
          wants: ["wants:upgrades-attached"],
          why: { "wants:upgrades-attached": "text: While this unit is upgraded, he gains Saboteur." },
          abilities: [{ repeat: "constant", text: "While this unit is upgraded, he gains Saboteur." }],
        }),
        sentinel("a", "Alpha"),
        sentinel("b", "Bravo"),
        sentinel("c", "Charlie"),
        sentinel("d", "Delta", { cost: 2 }),
        sentinel("sp", "Space Sentinel", { arenas: ["Space"] }),
      ],
      COMMITTED_TABLE,
      leaderCardsFile("LD", "Order Leader", ["Command", "Heroism"], rows),
    );
  const scores = new Map([
    ["a", { playCalibrated: 1 }],
    ["b", { playCalibrated: 3 }],
    ["c", { playCalibrated: 2 }],
    ["d", { playCalibrated: null }],
  ]);
  const keysOf = (out: Record<string, any>, tag = "keyword:Sentinel") =>
    out.roles.find((r: any) => r.tag === tag).substitutes.flatMap((g: any) => g.cards.map((c: any) => c.cardKey));

  it("lists the keyword role before the while-upgraded role and leaves out the Space Sentinel", () => {
    const out = body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", evidence: false }));
    expect(out.roles.map((r: any) => r.tag)).toEqual(["keyword:Sentinel", "wants:upgrades-attached"]);
    expect(keysOf(out)).not.toContain("sp");
    expect(keysOf(out).sort()).toEqual(["a", "b", "c", "d"]);
    const withText = body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", tag: "keyword:Sentinel" })).roles[0];
    expect(withText.slotText).toBe("printed keyword Sentinel");
    expect(withText.substitutes[0].cards[0].text).toBe("printed keyword Sentinel");
  });

  it("without a leader sorts by play-calibrated score (unscored last, then cost, then cardKey) and adds no leaderInclusion", () => {
    const out = body(fungibleSubstitutes(orderCtx([["a", 0.9]]), { cardKey: "slot", evidence: false }, scores));
    expect(keysOf(out)).toEqual(["b", "c", "a", "d"]);
    expect(JSON.stringify(out)).not.toContain("leaderInclusion");
    expect(out.leader).toBeUndefined();
    expect(keysOf(body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", evidence: false })))).toEqual(["d", "a", "b", "c"]);
    const tied = new Map([["a", { playCalibrated: 2 }], ["b", { playCalibrated: 2 }], ["c", { playCalibrated: 2 }]]);
    expect(keysOf(body(fungibleSubstitutes(orderCtx([]), { cardKey: "slot", evidence: false }, tied)))).toEqual(["a", "b", "c", "d"]);
  });

  it("with a leader sorts by leaderInclusion desc (null last), then play-calibrated score, and carries leaderInclusion", () => {
    const ctxL = orderCtx([["a", 0.5], ["b", 0.5], ["c", 0.8]]);
    const out = body(fungibleSubstitutes(ctxL, { cardKey: "slot", leader: "LD", evidence: false }, scores));
    expect(keysOf(out)).toEqual(["c", "b", "a", "d"]);
    const cards2 = out.roles[0].substitutes.flatMap((g: any) => g.cards);
    expect(cards2.map((c: any) => c.leaderInclusion)).toEqual([0.8, 0.5, 0.5, null]);
    expect(out.leader).toMatchObject({ cardKey: "LD", population: "tournament", decks: 12, window: "2026-07-20..2026-10-17" });
    expect(keysOf(body(fungibleSubstitutes(ctxL, { cardKey: "slot", leader: "Order Leader", evidence: false })))).toEqual(["c", "a", "b", "d"]);
  });

  it("names a leader without decklist data and rejects an unknown leader", () => {
    const bare = createSynergyContext([mk("LD", "Order Leader", { type: "Leader" }), sentinel("slot", "Slot"), sentinel("a", "Alpha")], COMMITTED_TABLE);
    const out = body(fungibleSubstitutes(bare, { cardKey: "slot", leader: "LD", evidence: false }));
    expect(out.leader.note).toMatch(/no decklist data/);
    expect(out.roles[0].substitutes[0].cards[0].leaderInclusion).toBeNull();
    expect(fungibleSubstitutes(bare, { cardKey: "slot", leader: "nope" }).isError).toBe(true);
  });
});
