import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { newestRun } from "../../src/data.js";
import { threatProfile, type CardFact, type MetaDeck } from "../../src/meta/build.js";
import { detectThreats, loadCounterTable } from "../../src/meta/counters.js";
import { metaFileSchema, type ThreatProfile } from "../../src/meta/schema.js";

// LampaGJ/swu-mcp#157, D66: #155 made "this unit gains Sentinel" a holder offer (offers:has-keyword-sentinel), and the
// counter table kept reading only printed keywords and grants, so Krennic's sentinel-wall stopped firing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const table = loadCounterTable();

const fact = (cardKey: string, keywords: string[], offers: string[]): CardFact => ({
  cardKey,
  title: cardKey,
  type: "Unit",
  cost: 3,
  power: 3,
  hp: 3,
  arenas: ["Ground"],
  aspectIcons: [],
  traits: [],
  keywords,
  offers,
});
const deck = (cards: [string, number][]): MetaDeck => ({
  key: "d1",
  population: "tournament",
  source: "melee",
  leader: "L",
  base: "B",
  cards,
  createdAt: "2026-10-01",
  event: null,
  placement: null,
  field: null,
});

describe("self-gained keyword holders in the threat profile (#157, D66)", () => {
  const facts = new Map([
    ["PRINTED", fact("PRINTED", ["Sentinel"], ["offers:has-keyword-sentinel"])],
    ["GAINS", fact("GAINS", [], ["offers:has-keyword-sentinel"])],
    ["RAIDER", fact("RAIDER", [], ["offers:has-keyword-raid"])],
  ]);
  const profile = threatProfile([{ deck: deck([["PRINTED", 5], ["GAINS", 3], ["RAIDER", 2]]), weight: 1 }], undefined, facts, 6);

  it("counts a holder whose keyword is not printed, and never a printed one twice", () => {
    expect(profile.keywords.Sentinel).toBe(5);
    expect(profile.gainedKeywords).toEqual({ Raid: 2, Sentinel: 3 });
  });

  it("fires sentinel-wall on printed plus self-gained Sentinel (5 + 3 reaches min 8)", () => {
    expect(detectThreats(profile, table).map((t) => t.threat.id)).toContain("sentinel-wall");
    const printedOnly: ThreatProfile = { ...profile, gainedKeywords: {} };
    expect(detectThreats(printedOnly, table).map((t) => t.threat.id)).not.toContain("sentinel-wall");
  });

  it("reads a profile built before D66 from its holder offers minus its printed keywords", () => {
    const old: ThreatProfile = { ...profile };
    delete old.gainedKeywords;
    expect(detectThreats({ ...old, offers: { ...old.offers, "offers:has-keyword-sentinel": 8 } }, table).map((t) => t.threat.id)).toContain("sentinel-wall");
    expect(detectThreats({ ...old, offers: { ...old.offers, "offers:has-keyword-sentinel": 5 } }, table).map((t) => t.threat.id)).not.toContain("sentinel-wall");
  });

  it("every threat metric that reads a keyword grant also reads the self-gained holders of that keyword", () => {
    const missing = table.threats.flatMap((t) =>
      t.metrics
        .map((m) => /^offers\.offers:grant-([a-z]+)$/.exec(m)?.[1])
        .filter((k): k is string => k !== undefined)
        .map((k) => `gainedKeywords.${k[0].toUpperCase()}${k.slice(1)}`)
        .filter((g) => !t.metrics.includes(g))
        .map((g) => `${t.id}: ${g}`),
    );
    expect(missing).toEqual([]);
  });
});

const builtRun = newestRun(path.join(REPO_ROOT, "data/runs"));
const archetypesFile = builtRun === undefined ? undefined : path.join(builtRun, "meta/archetypes.json");
const hasMeta = archetypesFile !== undefined && existsSync(archetypesFile);

describe.skipIf(!hasMeta)("the built meta (#157 regression)", () => {
  it("Director Krennic, Amidst My Achievement's archetype t001-a98697 carries sentinel-wall", () => {
    const meta = metaFileSchema.parse(JSON.parse(readFileSync(archetypesFile as string, "utf8")));
    const krennic = meta.archetypes.find((a) => a.id === "t001-a98697");
    expect(krennic?.leader.cardKey).toBe("07010008");
    expect(detectThreats(krennic?.profile as ThreatProfile, table).map((t) => t.threat.id)).toContain("sentinel-wall");
  });
});
