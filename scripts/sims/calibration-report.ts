/**
 * @displayName Simulation calibration report
 * @strategicPurpose The verification write-up's figures for #171 come from committed code, not hand arithmetic: the
 * external gate's sim and tournament shares side by side per matchup, each tier named and never pooled (D21), the
 * matchups the sim gets most wrong, and per archetype how far the bot moves it from its tournament results under
 * each record, so one list against several lists separates a list effect from a pilot effect.
 * @tacticalObjective Reads pinned gate records (src/sims/calibration.ts gateRecordSchema) and prints plain lines: per
 * record the Spearman and favourite figures with 95% intervals and the mean distance from 50%, the Spearman between
 * each two records' sim shares on their common pairs, per matchup the tournament share and interval beside every
 * record's sim share, the clear matchups ranked by sim error, and per archetype its mean signed error (sim minus
 * tournament, from that archetype's side). No Karabast data is read (D22).
 *
 *   node --import tsx scripts/sims/calibration-report.ts data/pinned/sim-calibration-v1/calibration-rung1.json data/pinned/sim-calibration-v1/lists3/calibration-rung1.json
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { archetypeShares, externalIntervals, gateRecordSchema, spearman, type GateRecord } from "../../src/sims/calibration.js";
import { compareCodePoints } from "../../src/swu/canonical.js";

type Row = GateRecord["gates"]["external"]["rows"][number];

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const short = (name: string): string => name.split(" / ")[0];
const pairKey = (r: Row): string => `${r.a}|${r.b}`;

export function report(files: readonly string[]): string {
  const recs = files.map((f) => ({ file: f, rec: gateRecordSchema.parse(JSON.parse(readFileSync(f, "utf8"))) }));
  const label = (k: number): string => {
    const r = recs[k].rec;
    return `${r.policy.spec}, ${r.seeds.listsPerArchetype ?? 1} list${(r.seeds.listsPerArchetype ?? 1) === 1 ? "" : "s"} per archetype`;
  };
  const out: string[] = [];
  out.push("Sim figures are bot play (forceteki), not human results; tournament figures are swumetastats melee.gg matchups. Side by side, never pooled (D21).", "");

  out.push("## Gate figures");
  recs.forEach(({ file, rec }, k) => {
    const e = rec.gates.external;
    const iv = externalIntervals(e);
    const live = e.rows.filter((r) => r.sim.share !== null);
    const dist = live.reduce((s, r) => s + Math.abs((r.sim.share as number) - 0.5), 0) / (live.length || 1);
    const tdist = e.rows.reduce((s, r) => s + Math.abs(r.tournament.share - 0.5), 0) / (e.rows.length || 1);
    out.push(
      `- ${label(k)} (${path.basename(path.dirname(file))}/${path.basename(file)}, ${rec.seeds.gamesPerPair} games per pair): Spearman ${e.spearman} [${iv.spearman95?.join(", ") ?? "n/a"}] over ${e.pairs} pairs; favourite agrees in ${e.favourite.agree} of ${e.favourite.counted} clear matchups (${pct(e.favourite.counted === 0 ? null : e.favourite.agree / e.favourite.counted)} [${iv.favourite95?.map(pct).join(", ") ?? "n/a"}], one-sided p = ${e.favourite.pValue}); external ${e.pass ? "pass" : `fail (${e.failed.join(", ")})`}; mean distance from 50%: sim ${r4(dist)}, tournament ${r4(tdist)}; record ${rec.pass ? "passes" : `fails ${rec.failedGates.join(", ")}`}`,
    );
  });
  for (let x = 0; x < recs.length; x++)
    for (let y = x + 1; y < recs.length; y++) {
      const by = new Map(recs[y].rec.gates.external.rows.map((r) => [pairKey(r), r]));
      const common = recs[x].rec.gates.external.rows.filter((r) => r.sim.share !== null && by.get(pairKey(r))?.sim.share != null);
      const rho = spearman(
        common.map((r) => r.sim.share as number),
        common.map((r) => by.get(pairKey(r))?.sim.share as number),
      );
      out.push(`- Spearman between the sim shares of ${label(x)} and ${label(y)}: ${rho === null ? "n/a" : r4(rho)} over ${common.length} common pairs`);
    }

  const base = recs[0].rec.gates.external.rows;
  const simOf = (k: number, r: Row): Row["sim"] | undefined => recs[k].rec.gates.external.rows.find((x) => pairKey(x) === pairKey(r))?.sim;
  out.push("", "## Per matchup", "Tournament share is the first archetype's share of decisive matches with its Wilson 95% interval (clear when it excludes 50%); each sim figure is the first archetype's share of its decisive games.");
  for (const r of base) {
    const t = r.tournament;
    const sims = recs.map((_, k) => {
      const s = simOf(k, r);
      return `${label(k)} ${s === undefined ? "n/a" : `${pct(s.share)} (${s.wins} of ${s.n})`}`;
    });
    out.push(`- ${short(r.aName)} vs ${short(r.bName)}: tournament ${pct(t.share)} (${t.wins}-${t.losses}, [${pct(t.low)}, ${pct(t.high)}]${t.excludesHalf ? ", clear" : ""}); ${sims.join("; ")}`);
  }

  recs.forEach((_, k) => {
    const rows = recs[k].rec.gates.external.rows.filter((r) => r.tournament.excludesHalf && r.sim.share !== null);
    const ranked = rows
      .map((r) => ({ r, err: (r.sim.share as number) - r.tournament.share, wrong: (r.sim.share as number) > 0.5 !== r.tournament.share > 0.5 && r.sim.share !== 0.5 }))
      .sort((p, q) => Math.abs(q.err) - Math.abs(p.err) || compareCodePoints(pairKey(p.r), pairKey(q.r)));
    out.push("", `## Most wrong clear matchups, ${label(k)}`);
    for (const { r, err, wrong } of ranked.slice(0, 10))
      out.push(`- ${short(r.aName)} vs ${short(r.bName)}: tournament ${pct(r.tournament.share)}, sim ${pct(r.sim.share)}, error ${err >= 0 ? "+" : ""}${(err * 100).toFixed(1)} points${wrong ? ", opposite favourite" : ""}`);
  });

  out.push("", "## Per archetype: mean signed error, sim minus tournament, from the archetype's side, over its matchups with a sim share");
  const names = new Map<string, string>();
  for (const r of base) {
    names.set(r.a, short(r.aName));
    names.set(r.b, short(r.bName));
  }
  for (const [id, name] of [...names].sort(([a], [b]) => compareCodePoints(a, b))) {
    const parts = recs.map((_, k) => {
      let s = 0;
      let n = 0;
      for (const r of recs[k].rec.gates.external.rows) {
        if (r.sim.share === null || (r.a !== id && r.b !== id)) continue;
        const err = (r.sim.share as number) - r.tournament.share;
        s += r.a === id ? err : -err;
        n++;
      }
      return `${label(k)} ${n === 0 ? "n/a" : `${s / n >= 0 ? "+" : ""}${((s / n) * 100).toFixed(1)} points over ${n}`}`;
    });
    out.push(`- ${name} (${id}): ${parts.join("; ")}`);
  }

  out.push(
    "",
    "## Per archetype: mean share over its matchups with a 95% interval, sim and tournament side by side (#174)",
    "Each matchup weighs equally and is read from the archetype's side; the interval is normal on the per-matchup binomial variances (archetypeShares, src/sims/calibration.ts). The two tiers are never pooled (D21).",
  );
  for (const [id, name] of [...names].sort(([a], [b]) => compareCodePoints(a, b))) {
    const t = archetypeShares(base, id).tournament;
    const parts = recs.map((_, k) => {
      const s = archetypeShares(recs[k].rec.gates.external.rows, id);
      return s.sim === null ? `${label(k)} n/a` : `${label(k)} ${pct(s.sim.mean)} [${pct(s.sim.low)}, ${pct(s.sim.high)}], error ${(s.error ?? 0) >= 0 ? "+" : ""}${((s.error ?? 0) * 100).toFixed(1)} points`;
    });
    out.push(`- ${name} (${id}): tournament ${pct(t.mean)} [${pct(t.low)}, ${pct(t.high)}]; ${parts.join("; ")}`);
  }
  return `${out.join("\n")}\n`;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("usage: calibration-report.ts <gate record> [<gate record> ...]");
  process.stdout.write(report(files));
}
