import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadStore } from "../../src/data.js";
import {
  assertChildOf,
  BRIDGE_KEY_SOURCE,
  buildVocab,
  type BuildVocabInput,
  compileVocab,
  FIRST_CARD_INDEX,
  parseVocab,
  type VocabBody,
  vocabContentHash,
} from "../../src/sims/vocab.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const release = JSON.parse(readFileSync(path.join(REPO_ROOT, "src/data-release.json"), "utf8")) as { dataVersion: string };
const RUN_DIR = path.join(REPO_ROOT, "data/runs", release.dataVersion.slice(0, 10));
const PINNED = path.join(REPO_ROOT, "data/pinned/sim-vocab", `${release.dataVersion}.json`);
const hasRun = existsSync(path.join(RUN_DIR, "llm/cards.toon"));

const base = (over: Partial<BuildVocabInput> = {}): BuildVocabInput => ({
  dataVersion: "test.r1",
  buildHash: "a".repeat(64),
  cardsToonSha256: "b".repeat(64),
  engineCommit: "0000000",
  cards: [
    { cardKey: "0101002", type: "Unit", title: "B" },
    { cardKey: "0101001", type: "Unit", title: "A" },
    { cardKey: "05010t02", type: "Token Upgrade", title: "Shield" },
    { cardKey: "04010t04", type: "Token Upgrade", title: "Shield" },
  ],
  engineKeywords: ["sentinel", "raid"],
  parent: null,
  ...over,
});

describe("vocabulary", () => {
  it("sorts keys by code point after the reserved indices and aliases tokens by (type, title)", () => {
    const v = buildVocab(base());
    expect(v.keys).toEqual(["0101001", "0101002", "04010t04"]);
    expect(v.aliases).toEqual({ "05010t02": "04010t04" });
    expect(v.keywords).toEqual(["raid", "sentinel"]);
    const c = compileVocab(v);
    expect(c.index.get("0101001")).toBe(FIRST_CARD_INDEX);
    expect(c.index.get("05010t02")).toBe(c.index.get("04010t04"));
    expect(c.keywordBit.get("raid")).toBe(1);
  });

  it("refuses a body edited without recomputing contentSha256", () => {
    const v = buildVocab(base());
    expect(() => parseVocab({ ...v, keys: [...v.keys, "0101009"] })).toThrow(/does not match/);
    expect(parseVocab(JSON.parse(JSON.stringify(v)))).toEqual(v);
  });

  it("extends the parent as a prefix, appends new keywords last and keeps dropped cards", () => {
    const parent = buildVocab(base());
    const child = buildVocab(
      base({
        dataVersion: "test.r2",
        cards: [{ cardKey: "0101000", type: "Unit", title: "Z" }, ...base().cards.filter((c) => c.cardKey !== "0101002")],
        engineKeywords: ["sentinel", "raid", "ambush"],
        parent,
      }),
    );
    expect(child.keys).toEqual(["0101001", "0101002", "04010t04", "0101000"]);
    expect(child.keywords).toEqual(["raid", "sentinel", "ambush"]);
    expect(() => assertChildOf(child, parent)).not.toThrow();
  });

  it("rejects a child whose prefix is reordered", () => {
    const parent = buildVocab(base());
    const child = buildVocab(base({ dataVersion: "test.r2", parent }));
    const swappedKeys = [child.keys[1], child.keys[0], ...child.keys.slice(2)];
    const body = { ...child, keys: swappedKeys } as Record<string, unknown>;
    delete body.contentSha256;
    const swapped = parseVocab({ ...body, contentSha256: vocabContentHash(body as VocabBody) });
    expect(() => assertChildOf(swapped, parent)).toThrow(/changes parent key 0/);
  });

  it("inherits an alias target instead of re-picking it by sort order", () => {
    const parent = buildVocab(base());
    const child = buildVocab(
      base({ dataVersion: "test.r2", cards: [...base().cards, { cardKey: "03010t09", type: "Token Upgrade", title: "Shield" }], parent }),
    );
    expect(child.aliases["03010t09"]).toBe("04010t04");
    expect(child.keys).not.toContain("03010t09");
  });

  it("rejects a child that re-picks an alias target", () => {
    const parent = buildVocab(base());
    const child = buildVocab(base({ dataVersion: "test.r2", parent }));
    const body = { ...child, aliases: { "04010t04": "05010t02" }, keys: ["0101001", "0101002", "05010t02"] } as Record<string, unknown>;
    delete body.contentSha256;
    const repicked = parseVocab({ ...body, contentSha256: vocabContentHash(body as VocabBody) });
    expect(() => assertChildOf(repicked, parent)).toThrow(/changes parent key 2|changes alias/);
  });
});

describe("vocabulary revisions of one data release", () => {
  it("appends bridge printing keys after the parent prefix, skipping keys it already holds", () => {
    const parent = buildVocab(base());
    const child = buildVocab(base({ parent, revision: 2, extraKeys: ["0301240", "0101002", "0101059", "0301240"] }));
    expect(child.dataVersion).toBe(parent.dataVersion);
    expect(child.revision).toBe(2);
    expect(child.extraKeySource).toBe(BRIDGE_KEY_SOURCE);
    expect(child.keys).toEqual([...parent.keys, "0101059", "0301240"]);
    expect(() => assertChildOf(child, parent)).not.toThrow();
    expect(parseVocab(JSON.parse(JSON.stringify(child)))).toEqual(child);
    expect(compileVocab(child).index.get("0301240")).toBe(FIRST_CARD_INDEX + parent.keys.length + 1);
  });

  it("refuses a revision that does not exceed its parent's for the same data release", () => {
    const parent = buildVocab(base());
    expect(() => buildVocab(base({ parent }))).toThrow(/revision/);
    const second = buildVocab(base({ parent, revision: 2, extraKeys: ["0101059"] }));
    expect(() => buildVocab(base({ parent: second, revision: 2 }))).toThrow(/revision/);
  });

  it("keeps a revision-1 vocabulary free of the new fields, so its content hash is unchanged", () => {
    const v = buildVocab(base());
    expect(Object.keys(v)).not.toContain("revision");
    expect(Object.keys(v)).not.toContain("extraKeySource");
  });
});

describe.skipIf(!hasRun)("vocabulary against the built data release", () => {
  it("resolves every cardKey of the store to an index of 3 or more", () => {
    const store = loadStore(RUN_DIR);
    const vocab = existsSync(PINNED)
      ? parseVocab(JSON.parse(readFileSync(PINNED, "utf8")))
      : buildVocab(base({ cards: store.cards.map((c) => ({ cardKey: c.cardKey, type: c.type, title: c.title })) }));
    const index = compileVocab(vocab).index;
    const missing = store.cards.filter((c) => (index.get(c.cardKey) ?? 0) < FIRST_CARD_INDEX).map((c) => c.cardKey);
    expect(missing).toEqual([]);
    expect(store.cards.length).toBe(store.byKey.size);
  });
});
