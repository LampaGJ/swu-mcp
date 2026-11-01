/**
 * @displayName State-view extraction cost and overflow probe
 * @strategicPurpose #124's encoder caps units and hand slots and counts what it drops; the caps are only safe if the
 * overflow is rare in real games, and the extractor only fits the search budget if it costs well under the engine's
 * per-prompt time (docs/research/forceteki-simulation.md:62).
 * @tacticalObjective Plays seeded games on the pinned engine and, before every decision, extracts and encodes the
 * acting seat's view, timing extractStateView against Game.getState on the same decisions, and tallies units per
 * side, overflow, unknown card references and unresolved names into a local report.
 *
 * Usage: node node_modules/tsx/dist/cli.mjs scripts/sims/state-view-cost.ts [--games 1000] [--policy rung1]
 *   [--decks data/originals/decks/2026-10-17] [--panel 12] [--out reports/sims/state-view-cost.json]
 *   [--compare <second vocabulary>]: also encodes every state with it and tallies its unknown references
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { progress } from "../lib/progress.mjs";
import { REPO_ROOT } from "../../src/paths.js";
import { loadStore } from "../../src/data.js";
import { startGame } from "../../src/sims/engine.js";
import { buildHeader, chainForHeader, type DeckInput } from "../../src/sims/match.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { registerRungs } from "../../src/sims/policies/typed-adapter.js";
import { loadTables } from "../../src/sims/policies/tables.js";
import { Session } from "../../src/sims/session.js";
import { encodeState, H, U } from "../../src/sims/state.js";
import { extractStateView, stateViewKeysOf, UNRESOLVED_PREFIX } from "../../src/sims/state-view.js";
import { compileVocab, parseVocab } from "../../src/sims/vocab.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { contextOptions, loadContext } from "./context.js";
import { loadDeck } from "./decks.js";

const { values } = parseArgs({
  options: {
    ...contextOptions,
    games: { type: "string", default: "1000" },
    policy: { type: "string", default: "rung1" },
    decks: { type: "string", default: path.join(REPO_ROOT, "data/originals/decks/2026-10-17") },
    panel: { type: "string", default: "12" },
    vocab: { type: "string", default: path.join(REPO_ROOT, "data/pinned/sim-vocab/2026-10-30.r6.json") },
    release: { type: "string", default: path.join(REPO_ROOT, "data/runs/2026-10-30") },
    out: { type: "string", default: path.join(REPO_ROOT, "reports/sims/state-view-cost.json") },
    compare: { type: "string" },
  },
});

const ctx = loadContext(values);
const tables = loadTables({ runDir: values.run, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
if (values.policy !== "rung0") registerRungs(POLICIES, (ps) => new PolicyChain(ps as never), [values.policy], tables);
const vocab = compileVocab(parseVocab(JSON.parse(readFileSync(values.vocab, "utf8"))));
const compareVocab = values.compare === undefined ? null : compileVocab(parseVocab(JSON.parse(readFileSync(values.compare, "utf8"))));
const keys = stateViewKeysOf(loadStore(values.release).cards, ctx.bridge.engineCardKeys);

const deckFiles = readdirSync(values.decks)
  .filter((f) => f.endsWith(".json"))
  .sort(compareCodePoints);
const panel: { file: string; deck: DeckInput }[] = [];
let deckLoadFailures = 0;
for (const f of deckFiles) {
  if (panel.length >= Number(values.panel)) break;
  try {
    panel.push({ file: f, deck: loadDeck(ctx.bridge, path.join(values.decks, f)) });
  } catch {
    deckLoadFailures++;
  }
}
if (panel.length < 2) throw new Error(`fewer than two loadable decks in ${values.decks}`);

const games = Number(values.games);
const extractMs: number[] = [];
const encodeMs: number[] = [];
const getStateMs: number[] = [];
const unitsPerSide = new Map<number, number>();
const unresolved = new Map<string, number>();
let states = 0;
let statesOverflowUnits = 0;
let statesOverflowHand = 0;
let maxUnits = 0;
let maxHand = 0;
let cardRefs = 0;
let unknownRefs = 0;
let unknownKeywords = 0;
let compareUnknownRefs = 0;
const missing = new Map<string, number>();
const compareMissing = new Map<string, number>();
const capturesSeen = [0, 0];
let errors = 0;
const ends = new Map<string, number>();
const sessionErrors: { game: number; seed: string; extractor: boolean; error: string }[] = [];
let extractorFailures = 0;
const p = progress("sims-state-view-cost", { total: games });

for (let g = 0; g < games; g++) {
  const a = g % panel.length;
  const b = (a + 1 + (Math.floor(g / panel.length) % (panel.length - 1))) % panel.length;
  const seed = `svcost-${g}`;
  const header = buildHeader(
    ctx.engine,
    {
      seed,
      decks: [panel[a].deck, panel[b].deck],
      policies: [values.policy, values.policy],
      recordMode: "none",
      undo: false,
      codeCommit: ctx.codeCommit,
    },
    ctx.bridge.engineCardKeys,
  );
  try {
    const started = await startGame(ctx.engine, [header.decks[0].engineList, header.decks[1].engineList], {
      engineSeed: header.rng.engineSeed,
      undo: false,
    });
    const session = new Session(started, {
      seed,
      cardKeys: ctx.bridge.engineCardKeys,
      chains: [chainForHeader(header.policies[0]), chainForHeader(header.policies[1])],
      recordMode: "none",
      playedMetric: ctx.engine.playedMetric,
    });
    session.run({
      until: (pending, s) => {
        const t0 = performance.now();
        let view;
        try {
          view = extractStateView(s.game, pending.seat, keys);
        } catch (e) {
          // Session.run catches what this callback throws and ends the game as an error; mark it so the report tells the two apart.
          extractorFailures++;
          throw new Error(`extractor: ${String((e as Error)?.message ?? e).slice(0, 240)}`);
        }
        const t1 = performance.now();
        const encoded = encodeState(view, vocab);
        const t2 = performance.now();
        // getState advances per-viewer chat and animation cursors; tolerable in a measurement run, never in a search.
        (s.game as unknown as { getState(id: string): unknown }).getState(pending.seat === 1 ? "player1" : "player2");
        const t3 = performance.now();
        extractMs.push(t1 - t0);
        encodeMs.push(t2 - t1);
        getStateMs.push(t3 - t2);
        states++;
        for (const side of [view.me, view.opp]) {
          unitsPerSide.set(side.units.length, (unitsPerSide.get(side.units.length) ?? 0) + 1);
          maxUnits = Math.max(maxUnits, side.units.length);
        }
        maxHand = Math.max(maxHand, view.me.hand.length);
        if (encoded.overflow.me + encoded.overflow.opp > 0) statesOverflowUnits++;
        if (encoded.overflow.hand > 0) statesOverflowHand++;
        const refs = [view.me, view.opp].flatMap((side) => [
          ...side.units.flatMap((u) => [u.cardKey, ...u.upgrades]),
          ...side.discard,
          side.baseCardKey,
          side.leader.cardKey,
        ]);
        const all = [...refs, ...view.me.hand, ...view.me.library.flatMap((r) => Array.from({ length: r.count }, () => r.cardKey))];
        cardRefs += all.length;
        unknownRefs += encoded.unknown;
        unknownKeywords += encoded.unknownKeywords;
        for (const k of new Set(all)) if (!vocab.index.has(k)) missing.set(k, (missing.get(k) ?? 0) + 1);
        if (compareVocab !== null) {
          compareUnknownRefs += encodeState(view, compareVocab).unknown;
          for (const k of new Set(all)) if (!compareVocab.index.has(k)) compareMissing.set(k, (compareMissing.get(k) ?? 0) + 1);
        }
        for (const k of new Set(all)) if (k.startsWith(UNRESOLVED_PREFIX)) unresolved.set(k, (unresolved.get(k) ?? 0) + 1);
        if (view.me.capturedCards > 0) capturesSeen[pending.seat - 1]++;
        return false;
      },
    });
    ends.set(session.endCondition ?? "none", (ends.get(session.endCondition ?? "none") ?? 0) + 1);
    if (session.error !== null)
      sessionErrors.push({ game: g, seed, extractor: session.error.startsWith("extractor:"), error: session.error });
  } catch {
    errors++;
  }
  p.tick(g + 1, { states });
}

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((x, y) => x - y);
  return s.length === 0 ? Number.NaN : s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const ms = (xs: number[]) => ({ p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1) });
const report = {
  games,
  policy: values.policy,
  panel: panel.map((d) => d.file),
  deckLoadFailures,
  states,
  errors,
  extractorFailures,
  sessionErrors,
  endConditions: Object.fromEntries([...ends].sort(([x], [y]) => compareCodePoints(x, y))),
  extractStateViewMs: ms(extractMs),
  encodeStateMs: ms(encodeMs),
  getStateMs: ms(getStateMs),
  caps: { U, H },
  maxUnitsPerSide: maxUnits,
  maxHand,
  unitsPerSideHistogram: Object.fromEntries([...unitsPerSide].sort((x, y) => x[0] - y[0])),
  overflow: {
    statesWithUnitOverflow: statesOverflowUnits,
    statesWithHandOverflow: statesOverflowHand,
    unitRate: statesOverflowUnits / states,
    handRate: statesOverflowHand / states,
  },
  cardRefs,
  unknownRefs,
  unknownRate: unknownRefs / cardRefs,
  unknownKeywords,
  vocab: values.vocab,
  missingKeys: {
    distinct: missing.size,
    top: Object.fromEntries([...missing].sort((x, y) => y[1] - x[1] || compareCodePoints(x[0], y[0])).slice(0, 20)),
  },
  compare:
    compareVocab === null
      ? null
      : {
          vocab: values.compare,
          unknownRefs: compareUnknownRefs,
          unknownRate: compareUnknownRefs / cardRefs,
          missingKeys: {
            distinct: compareMissing.size,
            top: Object.fromEntries([...compareMissing].sort((x, y) => y[1] - x[1] || compareCodePoints(x[0], y[0])).slice(0, 20)),
          },
        },
  unresolvedNames: Object.fromEntries([...unresolved].sort((x, y) => y[1] - x[1] || compareCodePoints(x[0], y[0])).slice(0, 40)),
  capturesSeen: { viewerSeat1: capturesSeen[0], viewerSeat2: capturesSeen[1] },
  ambiguousStoreNames: keys.ambiguousNames,
};
mkdirSync(path.dirname(values.out), { recursive: true });
writeFileSync(values.out, `${JSON.stringify(report, null, 1)}\n`);
p.done({ states, errors });
console.log(
  JSON.stringify({
    out: values.out,
    states,
    errors,
    extract: report.extractStateViewMs,
    getState: report.getStateMs,
    maxUnits,
    overflow: report.overflow,
    unknownRate: report.unknownRate,
    compareUnknownRate: report.compare?.unknownRate ?? null,
  }),
);
