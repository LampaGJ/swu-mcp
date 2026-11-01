/**
 * @displayName Attack patterns build
 * @strategicPurpose Manipulation node (reduces): the human-play decision records (and, when given, computer-play
 * attack events) in, the aggregate data/attack-patterns.json out, so the attack_patterns tool serves which cards
 * attack most, what they attack and what happens without ever reading a raw row (D102, D104).
 * @tacticalObjective Turns each kept attack record into an event (undone and double-logged rows dropped), counts per
 * attacking card its attacks, games, targets and combat results read from the before and after boards, and the
 * attacking side's game result once per side with a Wilson 95% interval; writes the strict product and a plain-language
 * local markdown view.
 *
 * Usage: node --import tsx scripts/human-priors/attack-patterns.ts [--decisions <manifest.json>] [--computer <events.jsonl>] [--out <file>] [--report <md>]
 *   --decisions  default: the newest manifest in data/originals/karabast/decisions
 *   --out        default: data/attack-patterns.json
 *   --report     default: reports/human-priors/attack-patterns.md (git-ignored)
 */
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { z } from "zod";
import { loadStore } from "../../src/data.js";
import { wilson } from "../../src/meta/stats.js";
import { attackPatternsSchema, populationSchema, TIERS, type AttackerRow, type AttackPatterns, type AttackPopulation } from "../../src/play/attack-patterns.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";
import { DEFAULT_ORIGINALS_ROOT, displayName, loadCardMap } from "../bench/card-map.js";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "../bench/code-commit.js";
import { decisionRecordSchema, type BoardUnit, type DecisionRecord } from "./decisions.js";
import { DEFAULT_DECISIONS_DIR, manifestSchema } from "./extract-decisions.js";

/** One attack, with opaque per-game and per-side keys that never leave this module. */
export interface AttackEvent {
  game: string;
  side: string;
  won: 0 | 1 | null;
  attacker: string | null;
  /** "base", a cardKey, or null for a unit target that did not resolve. */
  target: string | null;
  before: { me: readonly BoardUnit[]; opp: readonly BoardUnit[] } | null;
  after: { me: readonly BoardUnit[]; opp: readonly BoardUnit[] } | null;
  baseDamage: number | null;
}

const boardUnit = z.strictObject({ card: z.string().nullable(), cost: z.number(), power: z.number(), hp: z.number(), damage: z.number(), exhausted: z.boolean(), arena: z.enum(["ground", "space"]), kw: z.array(z.string()), up: z.number() });
const board = z.strictObject({ me: z.array(boardUnit), opp: z.array(boardUnit) }).nullable();
/** A computer-play attack event file line: the same event shape, foreign data parsed at the seam. */
export const attackEventSchema = z.strictObject({
  game: z.string().min(1),
  side: z.string().min(1),
  won: z.union([z.literal(0), z.literal(1)]).nullable(),
  attacker: z.string().nullable(),
  target: z.string().nullable(),
  before: board,
  after: board,
  baseDamage: z.number().min(0).nullable(),
});

/** The attack in a decision record, or null for a non-attack, an undone attack or a second log row of one combat. */
export function attackEvent(r: DecisionRecord): AttackEvent | null {
  if (r.kind !== "attack" || r.flags.undone || r.flags.repeat) return null;
  const sideKey = r.won !== null ? "w" + String(r.won) : r.seat !== null ? "s" + String(r.seat) : "?";
  const baseDamage = r.target === "base" && r.next !== null && r.next !== undefined ? Math.max(0, r.next.oppBaseDamage - r.opp.baseDamage) : null;
  return {
    game: r.g,
    side: r.g + "|" + sideKey,
    won: r.won,
    attacker: r.card,
    target: r.targetRef ? r.target : "base",
    before: r.before === null ? null : { me: r.before.me, opp: r.before.opp },
    after: r.after ?? null,
    baseDamage,
  };
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;
const countOf = (list: readonly BoardUnit[], card: string): number => list.filter((u) => u.card === card).length;
const damageOn = (list: readonly BoardUnit[], card: string): number => list.filter((u) => u.card === card).reduce((n, u) => n + u.damage, 0);

interface Acc {
  attacks: number;
  games: Set<string>;
  base: number;
  units: number;
  unresolvedUnits: number;
  targets: Map<string, number>;
  measured: number;
  unitAttacks: number;
  targetDefeated: number;
  attackerDefeated: number;
  both: number;
  neither: number;
  damage: number[];
  baseAttacks: number;
  baseDamage: number[];
  sides: Map<string, 0 | 1>;
}

export interface PopulationMeta {
  method: AttackPopulation["method"];
  label: string;
  window: AttackPopulation["window"];
  top: number;
  topTargets: number;
  notes: string[];
  /** The printed name of a cardKey; the key itself when unknown. */
  title: (cardKey: string) => string;
}

export function aggregateAttacks(events: readonly AttackEvent[], meta: PopulationMeta): AttackPopulation {
  const accs = new Map<string, Acc>();
  const games = new Set<string>();
  let unresolvedAttackers = 0;
  let unresolvedTargets = 0;
  let measuredAttacks = 0;
  for (const e of events) {
    games.add(e.game);
    if (e.target === null) unresolvedTargets++;
    if (e.attacker === null) {
      unresolvedAttackers++;
      continue;
    }
    let a = accs.get(e.attacker);
    if (a === undefined) {
      a = { attacks: 0, games: new Set(), base: 0, units: 0, unresolvedUnits: 0, targets: new Map(), measured: 0, unitAttacks: 0, targetDefeated: 0, attackerDefeated: 0, both: 0, neither: 0, damage: [], baseAttacks: 0, baseDamage: [], sides: new Map() };
      accs.set(e.attacker, a);
    }
    a.attacks++;
    a.games.add(e.game);
    if (e.won !== null) a.sides.set(e.side, e.won);
    if (e.target === "base") a.base++;
    else {
      a.units++;
      if (e.target === null) a.unresolvedUnits++;
      else a.targets.set(e.target, (a.targets.get(e.target) ?? 0) + 1);
    }
    if (e.before === null || e.after === null) continue;
    a.measured++;
    measuredAttacks++;
    if (e.target === "base") {
      a.baseAttacks++;
      if (e.baseDamage !== null) a.baseDamage.push(e.baseDamage);
      continue;
    }
    if (e.target === null) continue;
    a.unitAttacks++;
    const tDead = countOf(e.after.opp, e.target) < countOf(e.before.opp, e.target);
    const aDead = countOf(e.after.me, e.attacker) < countOf(e.before.me, e.attacker);
    if (tDead) a.targetDefeated++;
    if (aDead) a.attackerDefeated++;
    if (tDead && aDead) a.both++;
    if (!tDead && !aDead) a.neither++;
    const hit = e.before.opp.find((x) => x.card === e.target);
    a.damage.push(tDead ? Math.max(0, (hit?.hp ?? 0) - (hit?.damage ?? 0)) : Math.max(0, damageOn(e.after.opp, e.target) - damageOn(e.before.opp, e.target)));
  }
  const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : r4(xs.reduce((n, x) => n + x, 0) / xs.length));
  const rows: AttackerRow[] = [...accs]
    .sort((p, q) => q[1].attacks - p[1].attacks || compareCodePoints(p[0], q[0]))
    .slice(0, meta.top)
    .map(([cardKey, a]) => {
      const wins = [...a.sides.values()].filter((w) => w === 1).length;
      const ci = wilson(wins, a.sides.size);
      return {
        cardKey,
        title: meta.title(cardKey),
        attacks: a.attacks,
        games: a.games.size,
        gameShare: r4(a.games.size / Math.max(1, games.size)),
        attacksPerGame: r4(a.attacks / Math.max(1, a.games.size)),
        targets: { base: a.base, units: a.units, unresolvedUnits: a.unresolvedUnits, baseShare: r4(a.base / Math.max(1, a.attacks)) },
        topTargets: [...a.targets]
          .sort((p, q) => q[1] - p[1] || compareCodePoints(p[0], q[0]))
          .slice(0, meta.topTargets)
          .map(([k, n]) => ({ cardKey: k, title: meta.title(k), attacks: n, share: r4(n / a.attacks) })),
        results: {
          measured: a.measured,
          unitAttacks: a.unitAttacks,
          targetDefeated: a.targetDefeated,
          attackerDefeated: a.attackerDefeated,
          both: a.both,
          neither: a.neither,
          meanDamageToTarget: mean(a.damage),
          baseAttacks: a.baseAttacks,
          meanBaseDamage: mean(a.baseDamage),
        },
        sideResult: { sides: a.sides.size, wins, winShare: a.sides.size === 0 ? null : r4(wins / a.sides.size), low: ci?.low ?? null, high: ci?.high ?? null },
      };
    });
  return populationSchema.parse({
    method: meta.method,
    tier: TIERS[meta.method],
    label: meta.label,
    window: meta.window,
    games: games.size,
    attacks: events.length,
    unresolvedAttackers,
    unresolvedTargets,
    measuredAttacks,
    attackers: rows,
    notes: meta.notes,
  });
}

const pct = (x: number | null): string => (x === null ? "n/a" : (x * 100).toFixed(1) + "%");

/** The plain-language local view: no card-game jargon in the headings (owner request). */
export function renderMarkdown(product: AttackPatterns): string {
  const titles = new Map<string, string>();
  for (const p of product.populations) for (const a of p.attackers) for (const r of [a, ...a.topTargets]) titles.set(r.cardKey, r.title);
  const title = (k: string): string => titles.get(k) ?? k;
  const out: string[] = ["# How cards are used to attack", ""];
  for (const p of product.populations) {
    out.push("## " + (p.method === "human play" ? "People playing online" : "Our computer players"), "");
    out.push(p.label + ". Games: " + String(p.games) + ". Attacks: " + String(p.attacks) + ". Attacks whose attacking card was not recognised: " + String(p.unresolvedAttackers) + ". Attacks on a unit that was not recognised: " + String(p.unresolvedTargets) + ".", "");
    for (const n of p.notes) out.push("- " + n);
    out.push("", "### Which cards attacked most", "");
    for (const [i, a] of p.attackers.entries()) out.push(String(i + 1) + ". " + title(a.cardKey) + ": " + String(a.attacks) + " attacks in " + String(a.games) + " games (" + pct(a.gameShare) + " of games), " + String(a.attacksPerGame) + " per game when played.");
    out.push("", "### What they attacked", "");
    for (const a of p.attackers) {
      const tops = a.topTargets.slice(0, 5).map((t) => title(t.cardKey) + " " + String(t.attacks) + " (" + pct(t.share) + ")");
      out.push("- " + title(a.cardKey) + ": the opponent's base " + String(a.targets.base) + " times (" + pct(a.targets.baseShare) + "), units " + String(a.targets.units) + " times" + (tops.length > 0 ? "; most often " + tops.join(", ") : "") + ".");
    }
    out.push("", "### What happened", "");
    for (const a of p.attackers) {
      const r = a.results;
      const s = a.sideResult;
      out.push(
        "- " + title(a.cardKey) + ": of " + String(r.unitAttacks) + " measured attacks on units, the defender was destroyed " + String(r.targetDefeated) + " times, the attacker " + String(r.attackerDefeated) + " times, both " + String(r.both) + ", neither " + String(r.neither) +
          "; average damage to the defender " + String(r.meanDamageToTarget ?? "n/a") + ", average damage to the base " + String(r.meanBaseDamage ?? "n/a") + ". The side that used it won " + pct(s.winShare) + " of " + String(s.sides) + " games" + (s.low === null ? "" : " (95% range " + pct(s.low) + " to " + pct(s.high) + ")") + ".",
      );
    }
    out.push("");
  }
  return out.join("\n");
}

async function readEvents(file: string, gz: boolean, line: (text: string) => void, tick: (n: number) => void): Promise<void> {
  const stream = gz ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
  let n = 0;
  for await (const text of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (text === "") continue;
    line(text);
    if (++n % 50000 === 0) tick(n);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { decisions: { type: "string" }, computer: { type: "string" }, out: { type: "string" }, report: { type: "string" }, run: { type: "string" }, originals: { type: "string" } } });
  const manifestFile =
    values.decisions ??
    path.join(
      DEFAULT_DECISIONS_DIR,
      readdirSync(DEFAULT_DECISIONS_DIR)
        .filter((f) => f.endsWith(".manifest.json"))
        .sort((a, b) => statSync(path.join(DEFAULT_DECISIONS_DIR, b)).mtimeMs - statSync(path.join(DEFAULT_DECISIONS_DIR, a)).mtimeMs || compareCodePoints(a, b))[0],
    );
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
  const runDir = path.resolve(values.run ?? defaultRun());
  const map = loadCardMap(runDir, path.resolve(values.originals ?? path.join(DEFAULT_ORIGINALS_ROOT, "2026-10-16")));
  const names = new Map<string, string>();
  for (const pr of [...map.printings].sort((x, y) => compareCodePoints(x.serialCode, y.serialCode))) if (!names.has(pr.cardKey)) names.set(pr.cardKey, displayName(pr.title, pr.subtitle));
  for (const c of loadStore(runDir).cards) if (!names.has(c.cardKey)) names.set(c.cardKey, c.subtitle ? c.title + ", " + String(c.subtitle) : c.title);
  const title = (k: string): string => names.get(k) ?? k;
  const p = progress("human-priors-attack-patterns", { total: manifest.output.records, everyMs: 5000 });
  const human: AttackEvent[] = [];
  await readEvents(
    path.join(path.dirname(manifestFile), manifest.output.file),
    true,
    (text) => {
      const e = attackEvent(decisionRecordSchema.parse(JSON.parse(text)));
      if (e !== null) human.push(e);
    },
    (n) => p.tick(n, { phase: "human", attacks: human.length }),
  );
  const populations: AttackPopulation[] = [
    aggregateAttacks(human, {
      method: "human play",
      label: "Human play: casual online games between people, spectated",
      window: { from: "2026-02-08", to: "2026-02-10" },
      top: 30,
      topTargets: 10,
      title,
      notes: [
        "Casual online play (D21 tier 4); never pooled with tournament results or computer play.",
        "Combat results come from the board before and after each attack, where both were recorded.",
        "Win share counts each side that attacked with the card once, by its game result.",
      ],
    }),
  ];
  const inputs: Record<string, string> = { decisions: manifest.outputHash };
  if (values.computer !== undefined) {
    const computer: AttackEvent[] = [];
    await readEvents(values.computer, values.computer.endsWith(".gz"), (text) => computer.push(attackEventSchema.parse(JSON.parse(text))), (n) => p.tick(n, { phase: "computer" }));
    inputs.computer = sha256Hex(readFileSync(values.computer));
    populations.push(
      aggregateAttacks(computer, {
        method: "computer play",
        label: "Computer play: our simulator's bots on both seats",
        window: null,
        top: 30,
        topTargets: 10,
        title,
        notes: ["Bot simulations (D21 tier 5); never pooled with human play."],
      }),
    );
  }
  const product: AttackPatterns = attackPatternsSchema.parse({ schemaVersion: 1, populations, build: { inputHash: sha256Hex(canonicalJson(inputs)), codeCommit: codeCommit() } });
  const out = path.resolve(values.out ?? path.join(REPO_ROOT, "data/attack-patterns.json"));
  writeFileSync(out, JSON.stringify(product, null, 1) + "\n");
  const report = path.resolve(values.report ?? path.join(REPO_ROOT, "reports/human-priors/attack-patterns.md"));
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, renderMarkdown(product));
  p.done({ out, report, attacks: human.length });
  console.log(JSON.stringify({ out, report, populations: populations.map((x) => ({ method: x.method, games: x.games, attacks: x.attacks, unresolvedAttackers: x.unresolvedAttackers, unresolvedTargets: x.unresolvedTargets, measured: x.measuredAttacks })) }));
}

if (isMain(import.meta.url)) await main();
