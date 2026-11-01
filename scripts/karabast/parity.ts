/**
 * @displayName Player-view parity batch (karabast phase 1)
 * @strategicPurpose Measures, on the true engine, how much of each rung 1 decision a live karabast client can rebuild
 * from the gamestate the server sends (#182 phase 1), before any socket is opened.
 * @tacticalObjective Plays `--games` rung 1 mirrors over every ordered pair of the ladder panel decks plus the owner's
 * deck, with the players' autoSingleTarget setting toggled to `--auto-single-target` at game start (off is the live
 * default), runs the parity oracle (src/karabast/parity.ts) at every decision, first checks that probing changes no
 * trace, and writes the tallies to `<out>/report.json`. Single process; heartbeat at reports/.progress/karabast-parity-<label>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { progress } from "../lib/progress.mjs";
import { contextOptions, loadContext } from "../sims/context.js";
import { REPO_ROOT } from "../../src/paths.js";
import { loadCardIndex } from "../../src/karabast/player-view.js";
import { emptyTally, playParityGame } from "../../src/karabast/parity.js";
import { DEFAULT_DECKS, ladderDecks, ownDeckOf, registerRung1, rung1Bot, rung1Tables } from "./context.js";

const { values } = parseArgs({
  options: {
    ...contextOptions,
    games: { type: "string", default: "200" },
    "auto-single-target": { type: "string", default: "off" },
    decks: { type: "string", default: DEFAULT_DECKS },
    out: { type: "string" },
  },
});
const ast = values["auto-single-target"] === "on";
const label = `ast-${ast ? "on" : "off"}`;
const out = path.resolve(values.out ?? path.join(REPO_ROOT, "tmp/karabast/parity", label));
const games = Number(values.games);

const ctx = loadContext(values);
const tables = rung1Tables(values.run);
registerRung1(tables);
const index = loadCardIndex(values.forceteki);
const decks = ladderDecks(ctx, values.run, path.resolve(values.decks), values.forceteki);
const owns = decks.map((d) => ownDeckOf(d.list, values.forceteki));
const pairs: [number, number][] = [];
for (let a = 0; a < decks.length; a++) for (let b = 0; b < decks.length; b++) if (a !== b) pairs.push([a, b]);

const tally = emptyTally();
const ends: Record<string, number> = {};
const errors: string[] = [];
const base = { engine: ctx.engine, autoSingleTarget: ast, cardKeys: ctx.bridge.engineCardKeys, tables, index, makeBot: () => rung1Bot(tables) };

const [a0, b0] = pairs[0];
const plain = await playParityGame({ ...base, decks: [decks[a0], decks[b0]], ownDecks: [owns[a0], owns[b0]], seed: "parity:0", probe: false }, emptyTally());
const probed = await playParityGame({ ...base, decks: [decks[a0], decks[b0]], ownDecks: [owns[a0], owns[b0]], seed: "parity:0" }, emptyTally());
const probeNeutral = plain.traceSha256 === probed.traceSha256;
if (!probeNeutral) throw new Error(`probing changed the trace: ${plain.traceSha256} vs ${probed.traceSha256}`);

const p = progress(`karabast-parity-${label}`, { total: games, everyN: 5 });
for (let i = 0; i < games; i++) {
  const [a, b] = pairs[i % pairs.length];
  const r = await playParityGame({ ...base, decks: [decks[a], decks[b]], ownDecks: [owns[a], owns[b]], seed: `parity:${i}` }, tally);
  ends[r.endCondition] = (ends[r.endCondition] ?? 0) + 1;
  if (r.error !== null && errors.length < 10) errors.push(`parity:${i}: ${r.error}`);
  p.tick(i + 1, { decisions: tally.decisions, descriptorMatch: tally.descriptorMatch, schemaFailures: tally.schemaFailures });
}

const rate = (x: number, n: number) => (n === 0 ? null : Math.round((x / n) * 1e4) / 1e4);
const report = {
  autoSingleTarget: ast,
  games,
  decks: decks.map((d) => d.source),
  probeNeutral,
  endConditions: ends,
  engineErrors: errors,
  decisions: tally.decisions,
  descriptorAgreement: { match: tally.descriptorMatch, of: tally.decisions, rate: rate(tally.descriptorMatch, tally.decisions) },
  idleSeatAgreement: { match: tally.idleMatch, of: tally.idleChecks, rate: rate(tally.idleMatch, tally.idleChecks) },
  commandAgreement: { match: tally.commandMatch, of: tally.commandChecks, rate: rate(tally.commandMatch, tally.commandChecks) },
  schemaFailures: tally.schemaFailures,
  schemaExamples: tally.schemaExamples,
  promptKinds: Object.fromEntries(
    Object.entries(tally.kinds)
      .sort((x, y) => y[1].n - x[1].n)
      .map(([k, v]) => [k, { ...v, kindRate: rate(v.kind, v.n), intentRate: rate(v.intent, v.n), titleOnlyIntentRate: rate(v.titleOnlyIntent, v.n), sourceRate: rate(v.source, v.n) }]),
  ),
  rung1: { ...tally.rung1, sameRate: rate(tally.rung1.same, tally.rung1.compared) },
  rung1Causes: Object.fromEntries(Object.entries(tally.rung1Causes).sort((x, y) => y[1] - x[1])),
  fieldDiffs: Object.fromEntries(Object.entries(tally.fieldDiffs).sort((x, y) => y[1] - x[1])),
  mismatchClasses: tally.mismatchClasses,
  examples: tally.examples,
  gaps: tally.gaps,
};
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
p.done({ out: path.relative(REPO_ROOT, out), descriptorRate: report.descriptorAgreement.rate });
console.log(JSON.stringify({ out, decisions: report.decisions, descriptorAgreement: report.descriptorAgreement, commandAgreement: report.commandAgreement, schemaFailures: report.schemaFailures, mismatchClasses: report.mismatchClasses, rung1: report.rung1 }));
