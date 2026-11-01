/**
 * @displayName Computer-play attack events
 * @strategicPurpose The attack_patterns tool sets people's attacks beside our bots' (D21's last tier, never pooled);
 * the bots' attacks are not in any match record, so this step plays seeded rung 1 games and writes each attack as
 * the same event the human build reads (#181, D104).
 * @tacticalObjective Wraps rung 1's driver policy in an observer that, at each of its attack-target prompts, notes the
 * attacker, the chosen target and both boards from its own view builder (fed a fixed number stream, so rung 1 draws
 * nothing extra), and closes the event at its seat's next decision with the board then; plays every ordered pair of
 * the ladder panel on seeds 5,000,000+ in this thread and writes one strict event per line.
 *
 * Usage: node --import tsx scripts/human-priors/computer-attacks.ts [--games 10] [--out reports/human-priors/computer-attack-events.jsonl]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadContext, DEFAULT_ORIGINALS, DEFAULT_RUN } from "../sims/context.js";
import { prepareDeck } from "../sims/decks.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_FORCETEKI } from "../../src/sims/engine-pin.js";
import { playMatch, type DeckInput } from "../../src/sims/match.js";
import { POLICIES, PolicyChain } from "../../src/sims/policy.js";
import { ViewBuilder } from "../../src/sims/policies/engine-view.js";
import { parsePolicySpec, policyOf } from "../../src/sims/policies/index.js";
import { loadTables, type CardTables } from "../../src/sims/policies/tables.js";
import { driverPolicy, inputsOf, type DriverPolicy } from "../../src/sims/policies/typed-adapter.js";
import type { CardView, GameView } from "../../src/sims/policies/types.js";
import { progress } from "../lib/progress.mjs";
import { isMain } from "../bench/code-commit.js";
import type { BoardUnit } from "./decisions.js";
import { attackEventSchema, type AttackEvent } from "./attack-patterns.js";

export const COMPUTER_SEED0 = 5_000_000;

const ladderPanelSchema = z.looseObject({ panel: z.array(z.looseObject({ file: z.string().min(1) })) });

const boardUnit = (c: CardView): BoardUnit => ({ card: c.cardKey, cost: c.cost, power: c.power, hp: c.hp, damage: c.damage, exhausted: c.exhausted, arena: c.zone === "space" ? "space" : "ground", kw: [], up: 0 });
const inPlay = (c: CardView): boolean => c.zone === "ground" || c.zone === "space";
const board = (v: GameView) => ({ me: v.me.units.filter(inPlay).map(boardUnit), opp: v.opp.units.filter(inPlay).map(boardUnit) });

/** Rung 1 (or any driver policy) that also reports its attacks; it changes no choice. */
export function attackRecorder(inner: DriverPolicy, tables: CardTables, game: string, sink: (e: Omit<AttackEvent, "won">, seat: 1 | 2) => void): DriverPolicy {
  let builder: ViewBuilder | null = null;
  let current: unknown = null;
  let pending: { e: Omit<AttackEvent, "won">; oppBase: number; seat: 1 | 2 } | null = null;
  const close = (v: GameView | null) => {
    if (pending === null) return;
    const e = pending.e;
    if (v !== null) {
      e.after = board(v);
      if (e.target === "base") e.baseDamage = Math.max(0, v.opp.base.damage - pending.oppBase);
    }
    sink(e, pending.seat);
    pending = null;
  };
  const still = () => 0.5;
  return {
    ...inner,
    choose(actions, view, random) {
      if (builder === null || current !== view.game) {
        close(null);
        current = view.game;
        builder = new ViewBuilder(view.game, view.seat, tables);
      }
      const { view: gv, answers } = builder.build(actions, still);
      close(gv);
      const res = inner.choose(actions, view, random);
      if (res !== null && gv.prompt.kind === "attackTarget" && gv.prompt.sourceId !== null) {
        const att = gv.cards.get(gv.prompt.sourceId);
        const a = answers[res.index];
        const t = a?.cardId == null ? undefined : gv.cards.get(a.cardId);
        if (att !== undefined && t !== undefined && !t.mine) {
          pending = {
            seat: view.seat,
            oppBase: gv.opp.base.damage,
            e: { game, side: game + "|" + String(view.seat), attacker: att.cardKey, target: t.kind === "base" ? "base" : t.cardKey, before: board(gv), after: null, baseDamage: null },
          };
        }
      }
      return res;
    },
    /** Flushes an attack still open when the game ended. */
    ...{ flush: () => close(null) },
  } as DriverPolicy & { flush: () => void };
}

export function registerRecorder(tables: CardTables, game: () => string, sink: (e: Omit<AttackEvent, "won">, seat: 1 | 2) => void, open: (p: { flush: () => void }) => void): void {
  const spec = parsePolicySpec("rung1");
  const inputs = inputsOf(spec, tables);
  POLICIES.rung1 = () => {
    const bot = policyOf(spec, tables);
    if (bot === null) throw new Error("rung1");
    const rec = attackRecorder(driverPolicy(bot, tables, inputs), tables, game(), sink) as DriverPolicy & { flush: () => void };
    open(rec);
    return new PolicyChain([rec] as never);
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { games: { type: "string", default: "10" }, out: { type: "string" } } });
  const out = path.resolve(values.out ?? path.join(REPO_ROOT, "reports/human-priors/computer-attack-events.jsonl"));
  const ctx = loadContext({ forceteki: DEFAULT_FORCETEKI, run: DEFAULT_RUN, originals: DEFAULT_ORIGINALS, "no-memo": false });
  const tables = loadTables({ runDir: DEFAULT_RUN, complementarity: path.join(REPO_ROOT, "data/complementarity.json"), pairs: false });
  const record = ladderPanelSchema.parse(JSON.parse(readFileSync(path.join(REPO_ROOT, "data/pinned/sim-ladder-v1/rung3h-vs-rung0.json"), "utf8")));
  const decks: DeckInput[] = record.panel.map((p) => {
    const rel = path.join("data/originals/decks/2026-10-17", p.file);
    return prepareDeck(ctx.bridge, JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8")), "file:" + rel);
  });
  const perPair = Number(values.games);
  const total = decks.length * decks.length * perPair;
  const p = progress("human-priors-computer-attacks", { total, everyMs: 5000 });
  const lines: string[] = [];
  let game = "";
  const open: { flush: () => void }[] = [];
  let buffer: { e: Omit<AttackEvent, "won">; seat: 1 | 2 }[] = [];
  registerRecorder(tables, () => game, (e, seat) => buffer.push({ e, seat }), (rec) => open.push(rec));
  let n = 0;
  for (let a = 0; a < decks.length; a++)
    for (let b = 0; b < decks.length; b++)
      for (let k = 0; k < perPair; k++) {
        const seed = String(COMPUTER_SEED0 + n);
        game = "g" + seed;
        buffer = [];
        open.length = 0;
        const { record: rec } = await playMatch(ctx.engine, { seed, decks: [decks[a], decks[b]], policies: ["rung1", "rung1"], recordMode: "none", undo: false, codeCommit: "computer-attacks" }, ctx.bridge.engineCardKeys);
        for (const r of open) r.flush();
        const winner = rec.footer.result.winner;
        for (const { e, seat } of buffer) lines.push(JSON.stringify(attackEventSchema.parse({ ...e, won: winner === null ? null : winner === seat ? 1 : 0 })));
        n++;
        if (n % 10 === 0) p.tick(n, { attacks: lines.length });
      }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join("\n") + "\n");
  p.done({ games: n, attacks: lines.length, out });
  console.log(JSON.stringify({ games: n, attacks: lines.length, out }));
}

if (isMain(import.meta.url)) await main();
