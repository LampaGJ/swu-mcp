/**
 * @displayName Opponent sampler CLI
 * @strategicPurpose Manipulation node (reduces, #112 of #104): shows what the opponent sampler (src/sims/opponents.ts)
 * draws from a built run and a deck snapshot, so a battle-test's field can be inspected before any game is played.
 * Reads melee tournament lists only (D22: no Karabast data), so every output names its population.
 * @tacticalObjective Modes: `panel` (the highest-placing buildable list of each of the top archetypes), `stratified`
 * (per-archetype draws plus a rest-of-field stratum), `field` (draws in proportion to share), `report` (every list the
 * id bridge or the archetype assignment left out, by name). No clocks: the seed is an argument.
 *
 * Usage: node scripts/sims/opponents.ts --mode panel|stratified|field|report [--seed s] [--n 100] [--top 6]
 *   [--per-stratum 100] [--rest 100] [--archetypes <archetypes.json>] [--decks <snapshot dir>] [--data <run dir>]
 *   [--bridge map|store] [--originals <dir>] [--engine <forceteki clone>] [--out <file>]
 *   Two bridges, two jobs. --bridge picks the SET_NNN -> cardKey index that places a list in its archetype: map (default)
 *   is the index the meta step uses, store is the Premier card table (src/tools/swudb.ts), which lacks rotated sets.
 *   --engine decides which lists are buildable: a list passes when the clone's test/json/_setCodeMap.json holds every id
 *   (J24_005 fails at new Deck); without a clone the cardKey index decides.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DATED_DIR, loadStore } from "../../src/data.js";
import {
  deckPanel,
  engineSetCodes,
  engineUnmappedCards,
  loadOpponentPool,
  poolReport,
  sampleProportional,
  sampleStratified,
  stratifiedPlan,
  mapCardKeyOf,
  storeAspectsOf,
  storeCardKeyOf,
  type Draw,
  type OpponentList,
} from "../../src/sims/opponents.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { DEFAULT_ORIGINALS_ROOT, loadCardMap } from "../bench/card-map.js";
import { defaultRun, REPO_ROOT } from "../bench/code-commit.js";

const DEFAULT_FORCETEKI = "/Volumes/Local Files/Projects/forceteki";
const MODES = ["panel", "stratified", "field", "report"] as const;
type Mode = (typeof MODES)[number];

function newestSnapshot(): string {
  const root = path.join(REPO_ROOT, "data/originals/decks");
  const newest = readdirSync(root)
    .filter((n) => DATED_DIR.test(n) && statSync(path.join(root, n)).isDirectory())
    .sort(compareCodePoints)
    .at(-1);
  if (newest === undefined) throw new Error(`no dated deck snapshot under ${root}`);
  return path.join(root, newest);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "panel" },
      seed: { type: "string", default: "opponents" },
      n: { type: "string", default: "100" },
      top: { type: "string", default: "6" },
      "per-stratum": { type: "string", default: "100" },
      rest: { type: "string", default: "100" },
      archetypes: { type: "string" },
      decks: { type: "string" },
      data: { type: "string" },
      bridge: { type: "string", default: "map" },
      originals: { type: "string" },
      engine: { type: "string", default: DEFAULT_FORCETEKI },
      out: { type: "string" },
    },
  });
  if (!MODES.includes(values.mode as Mode)) throw new Error(`--mode must be one of ${MODES.join(", ")}`);
  const mode = values.mode as Mode;
  const run = path.resolve(values.data ?? defaultRun());
  const store = loadStore(run);
  if (values.bridge !== "map" && values.bridge !== "store") throw new Error("--bridge must be map or store");
  const cardKeyOf =
    values.bridge === "store"
      ? storeCardKeyOf(store)
      : mapCardKeyOf(loadCardMap(run, path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16"))).setNumber.byId);
  const engineAvailable = existsSync(path.join(values.engine as string, "test/json/_setCodeMap.json"));
  const pool = loadOpponentPool({
    archetypesFile: path.resolve(values.archetypes ?? path.join(run, "meta/archetypes.json")),
    decksDir: path.resolve(values.decks ?? newestSnapshot()),
    cardKeyOf,
    baseAspectsOf: storeAspectsOf(store),
    unmappedCards: engineAvailable ? engineUnmappedCards(engineSetCodes(values.engine as string)) : undefined,
  });
  const titleOf = (id: string, kind: "leader" | "base"): string => {
    const key = cardKeyOf(id, kind);
    const row = key === null ? undefined : store.byKey.get(key);
    return row === undefined ? `${id} (unmapped)` : row.subtitle ? `${row.title}, ${row.subtitle}` : row.title;
  };
  const describe = (l: OpponentList) => ({
    key: l.key,
    name: l.name,
    leader: titleOf(l.leader.id, "leader"),
    base: titleOf(l.base.id, "base"),
    event: l.event,
    placement: l.placement,
    field: l.field,
    date: l.date,
  });

  const bridge = { placement: values.bridge, buildable: engineAvailable ? "engine set-code map" : "cardKey index (no forceteki clone found)" };
  let full: unknown;
  let summary: unknown;
  if (mode === "report") {
    const r = poolReport(pool);
    full = r;
    summary = {
      population: r.population,
      bridge,
      lists: r.lists,
      unmappedLists: r.unmappedLists,
      unmappedWeightShare: r.unmappedWeightShare,
      unassigned: r.unassigned.byReason,
      archetypesWithoutLists: r.archetypesWithoutLists,
    };
  } else if (mode === "panel") {
    const panel = deckPanel(pool, { top: Number(values.top) });
    full = summary = {
      bridge,
      population: `melee tournament decklists, ${pool.window.from} to ${pool.window.to}, placement-weighted archetype share`,
      panel: panel.map((p) => ({
        archetype: p.archetypeName,
        share: p.share,
        list: p.list === null ? null : describe(p.list),
        skippedUnmapped: p.skippedUnmapped,
      })),
    };
  } else {
    const plan =
      mode === "stratified"
        ? stratifiedPlan(pool, { top: Number(values.top), perStratum: Number(values["per-stratum"]), restOfField: Number(values.rest) })
        : undefined;
    const result =
      plan === undefined
        ? sampleProportional(pool, { seed: values.seed as string, n: Number(values.n) })
        : sampleStratified(pool, plan, { seed: values.seed as string });
    const row = (d: Draw) => ({ index: d.index, stratum: d.stratum, archetype: d.archetypeId, list: d.list.key, source: d.source });
    const perStratum = new Map<string, number>();
    for (const d of result.draws) perStratum.set(d.stratum, (perStratum.get(d.stratum) ?? 0) + 1);
    full = { ...result, draws: result.draws.map(row) };
    summary = {
      population: result.population,
      bridge,
      seed: result.seed,
      mode: result.mode,
      plan: plan?.map((p) => ({ id: p.id, name: p.name, weight: Math.round(p.weight * 1e4) / 1e4, n: p.n, archetypes: p.archetypeIds.length })),
      drawsPerStratum: Object.fromEntries([...perStratum].sort((a, b) => compareCodePoints(a[0], b[0]))),
      skippedUnmapped: result.skippedUnmapped.length,
      unplayableArchetypes: result.unplayableArchetypes,
    };
  }
  if (values.out !== undefined) {
    mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
    writeFileSync(path.resolve(values.out), `${JSON.stringify(full, null, 1)}\n`);
  }
  console.log(JSON.stringify(summary, null, 1));
}

main();
