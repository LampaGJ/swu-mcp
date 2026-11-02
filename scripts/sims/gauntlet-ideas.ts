/**
 * @displayName Deck gauntlet idea builder
 * @strategicPurpose Manipulation node (expands) between /swu-deck-ideas and `pnpm sims:gauntlet` (#198): every idea that
 * passed the gates is built into a full 50-card list by committed code, so the screen measures all of them, not only the
 * shortlist, and no list is ever written by hand.
 * @tacticalObjective Reads the idea pool files (src/sims/idea-pool.ts), fills bare card names from the pool and the card
 * table, and calls the build_deck handler (src/tools/build-deck.ts) once per idea: leader, base, the key cards and the
 * anchors at --copies each in mustInclude, and the cards --exclude names for that idea. Writes one SWUDB file per idea and,
 * for each --fallback-leaders leader, build_deck's own list for that leader on the base most of its ideas use (the named
 * fallback reference when no tournament list exists), plus manifest.json (inputs, legality, failures). Deterministic.
 *
 *   node --import tsx scripts/sims/gauntlet-ideas.ts --pool <dir of idea .md files> --out <dir> [--anchors k1,k2] [--copies 2]
 *     [--exclude <ideaId>=<card>]... [--fallback-leaders k1,k2] [--data <run dir>]
 */
import { decode } from "@toon-format/toon";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadStore, resolveDataDir } from "../../src/data.js";
import { buildInputOf, parseIdeaPool, resolveIdeas, type RefKind } from "../../src/sims/idea-pool.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { BUILD_DECK_TOOLS } from "../../src/tools/build-deck.js";
import { swudbDeckSchema } from "../../src/tools/swudb.js";

const buildOutput = z.looseObject({ swudb: swudbDeckSchema, legality: z.looseObject({ legal: z.boolean().optional() }).optional() });

function main(): void {
  const { values } = parseArgs({
    options: {
      pool: { type: "string" },
      out: { type: "string" },
      anchors: { type: "string", default: "" },
      copies: { type: "string", default: "2" },
      exclude: { type: "string", multiple: true, default: [] },
      "fallback-leaders": { type: "string", default: "" },
      data: { type: "string" },
    },
  });
  if (values.pool === undefined || values.out === undefined) throw new Error("give --pool <dir> and --out <dir>");
  const keys = (s: string): string[] =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  const copies = z.coerce.number().int().min(1).max(3).parse(values.copies);
  const anchors = keys(values.anchors);
  const excludeBy = new Map<string, string[]>();
  for (const e of values.exclude) {
    const m = /^([^=]+)=(.+)$/.exec(e);
    if (m === null) throw new Error(`--exclude takes <ideaId>=<card>, not ${e}`);
    excludeBy.set(m[1], [...(excludeBy.get(m[1]) ?? []), m[2]]);
  }
  const dataDir = values.data === undefined ? resolveDataDir() : path.resolve(values.data);
  const store = loadStore(dataDir);
  const handler = BUILD_DECK_TOOLS.build_deck.handler;

  const poolDir = path.resolve(values.pool);
  const files = readdirSync(poolDir)
    .filter((f) => f.endsWith(".md"))
    .sort(compareCodePoints);
  const poolHash = sha256Hex(files.map((f) => `${f}\u0000${sha256Hex(readFileSync(path.join(poolDir, f)))}\n`).join(""));
  const ideas = files.flatMap((f) => parseIdeaPool(readFileSync(path.join(poolDir, f), "utf8")));
  const kindOf = (type: string): RefKind => (type === "Leader" ? "leader" : type === "Base" ? "base" : "main");
  const titles = (name: string, kind: RefKind): string[] =>
    store.cards
      .filter((c) => kindOf(String(c.type)) === kind && !String(c.type).includes("Token"))
      .filter((c) => c.title === name || [c.title, c.subtitle].filter((s) => typeof s === "string" && s !== "").join(", ") === name)
      .map((c) => c.cardKey);
  const resolved = resolveIdeas(ideas, titles);
  for (const id of excludeBy.keys()) if (!ideas.some((i) => i.id === id)) throw new Error(`--exclude names idea ${id}, which is not in the pool`);

  const outDir = path.resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  const built: { id: string; file: string; input: unknown; legal: boolean | null; sha256: string }[] = [];
  const failures: { id: string; error: string }[] = [];
  const build = (id: string, input: Record<string, unknown>, file: string): void => {
    const r = handler(store, input);
    if (r.isError === true) {
      failures.push({ id, error: r.content[0].text });
      return;
    }
    const out = buildOutput.parse(decode(r.content[0].text));
    const text = `${JSON.stringify(out.swudb, null, 1)}\n`;
    writeFileSync(path.join(outDir, file), text);
    built.push({ id, file, input, legal: out.legality?.legal ?? null, sha256: sha256Hex(text) });
  };
  for (const idea of resolved.ideas) {
    if (idea.leader.key === null || idea.base.key === null) {
      failures.push({ id: idea.id, error: `leader or base unresolved (${idea.leader.name}, ${idea.base.name})` });
      continue;
    }
    const input = buildInputOf(idea, { anchors, copies, exclude: excludeBy.get(idea.id) ?? [] });
    build(idea.id, { ...input }, `${idea.id}.json`);
  }
  // The named fallback reference: build_deck's own list for a leader with no tournament list, on its ideas' usual base.
  for (const leader of keys(values["fallback-leaders"])) {
    const bases = new Map<string, number>();
    for (const i of resolved.ideas) if (i.leader.key === leader && i.base.key !== null) bases.set(i.base.key, (bases.get(i.base.key) ?? 0) + 1);
    const base = [...bases].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]))[0]?.[0];
    if (base === undefined) {
      failures.push({ id: `fallback-${leader}`, error: "no idea names this leader, so no base to build on" });
      continue;
    }
    build(`fallback-${leader}`, { leader, base, name: `build_deck default for ${leader}` }, `fallback-${leader}.json`);
  }
  const manifest = {
    kind: "gauntlet-ideas",
    pool: { files, sha256: poolHash },
    data: path.basename(dataDir),
    options: { anchors, copies, exclude: Object.fromEntries([...excludeBy].sort((a, b) => compareCodePoints(a[0], b[0]))) },
    unresolved: resolved.unresolved,
    built,
    failures,
  };
  writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(JSON.stringify({ out: outDir, ideas: ideas.length, built: built.length, illegal: built.filter((b) => b.legal === false).map((b) => b.id), unresolved: resolved.unresolved, failures, manifestSha256: sha256Hex(canonicalJson(manifest)) }, null, 1));
}

main();
