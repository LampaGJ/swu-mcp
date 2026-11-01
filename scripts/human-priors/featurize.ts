/**
 * @displayName Human-prior training tables
 * @strategicPurpose Manipulation node (reduces): decision records in, the numeric tables the human-play prior models
 * train on out (git-ignored, per-decision), plus the count-based card-play prior and the coverage of our card
 * vocabulary and canonical descriptors (#181, D104).
 * @tacticalObjective One pass over the records: the state vector of every kept main-action decision with its action
 * class, game result and by-game fold; one row per rebuilt attack option of every matched attack; per-leader card-play
 * counts from the training folds, scored on held-out games against the cards each side later revealed; and coverage
 * counts. Writes little-endian binary arrays and a meta file with the input hash and code commit.
 *
 * Usage: node --max-old-space-size=16384 --import tsx scripts/human-priors/featurize.ts [--decisions <manifest.json>] [--out <dir>] [--vocab <file>]
 */
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { loadStore } from "../../src/data.js";
import { parseVocab } from "../../src/sims/vocab.js";
import { compareCodePoints, sha256Hex } from "../../src/swu/canonical.js";
import { progress } from "../lib/progress.mjs";
import { codeCommit, defaultRun, isMain, REPO_ROOT } from "../bench/code-commit.js";
import { decisionRecordSchema, type DecisionRecord } from "./decisions.js";
import { manifestSchema } from "./extract-decisions.js";
import { ACTION_CLASSES, actionClass, cardPriorScore, descriptorOf, foldOf, optionFeatures, OPTION_FEATURES, stateFeatures, STATE_FEATURES, stateFromRecord, unitOf, type CardPrior, type PUnit } from "./features.js";

export const DEFAULT_VOCAB = path.join(REPO_ROOT, "data/pinned/sim-vocab/2026-10-30.r6.v2.json");
export const HELD_OUT_FOLD = 0;

const kept = (r: DecisionRecord): boolean => !r.flags.undone && !r.flags.revert && !r.flags.repeat;
const sideOf = (r: DecisionRecord): string => r.g + "|" + (r.won !== null ? "w" + String(r.won) : r.seat !== null ? "s" + String(r.seat) : "?");

function writeArray(file: string, data: ArrayLike<number>, kind: "f32" | "i8" | "i32"): void {
  const arr = kind === "f32" ? Float32Array.from(data) : kind === "i8" ? Int8Array.from(data) : Int32Array.from(data);
  writeFileSync(file, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { decisions: { type: "string" }, out: { type: "string" }, vocab: { type: "string" }, run: { type: "string" } } });
  if (values.decisions === undefined) throw new Error("--decisions <manifest.json> is required");
  const manifestFile = path.resolve(values.decisions);
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "data/originals/karabast/human-priors/v1"));
  const store = loadStore(path.resolve(values.run ?? defaultRun()));
  const costOf = new Map(store.cards.map((c) => [c.cardKey, typeof c.cost === "number" ? c.cost : Number(c.cost ?? 0)]));
  const vocabFile = path.resolve(values.vocab ?? DEFAULT_VOCAB);
  const vocab = parseVocab(JSON.parse(readFileSync(vocabFile, "utf8")));
  const inVocab = (k: string): boolean => vocab.keys.includes(k) || vocab.aliases[k] !== undefined;
  const vocabSet = new Set([...vocab.keys, ...Object.keys(vocab.aliases)]);

  const p = progress("human-priors-featurize", { total: manifest.output.records, everyMs: 5000 });
  const state: number[] = [];
  const sY: number[] = [];
  const sWon: number[] = [];
  const sFold: number[] = [];
  const sForfeit: number[] = [];
  const opt: number[] = [];
  const oGroup: number[] = [];
  const oChosen: number[] = [];
  const oFold: number[] = [];
  let groups = 0;
  let singleOption = 0;
  const priorCounts = { global: new Map<string, number>(), byLeader: new Map<string, Map<string, number>>(), total: 0 };
  const coverage = {
    cards: { refs: 0, resolved: 0, inVocab: 0, distinct: new Set<string>(), distinctInVocab: 0 },
    boardUnits: { seen: 0, resolved: 0, inVocab: 0 },
    leaders: { seen: 0, resolved: 0, inVocab: 0 },
    descriptor: Object.fromEntries([...ACTION_CLASSES, "other"].map((c) => [c, { records: 0, mapped: 0 }])) as Record<string, { records: number; mapped: number }>,
  };
  const heldOutPlays: DecisionRecord[] = [];
  const revealed = new Map<string, Set<string>>();

  let game: string | null = null;
  let n = 0;
  const stream = createReadStream(path.join(path.dirname(manifestFile), manifest.output.file)).pipe(createGunzip());
  for await (const text of readline.createInterface({ input: stream, crlfDelay: Infinity })) {
    if (text === "") continue;
    const r = decisionRecordSchema.parse(JSON.parse(text));
    if (++n % 50000 === 0) p.tick(n, { states: sY.length, options: oGroup.length });
    if (r.g !== game) game = r.g;
    const fold = foldOf(r.g);
    const cls = actionClass(r.kind);

    if (r.cardRef) {
      coverage.cards.refs++;
      if (r.card !== null) {
        coverage.cards.resolved++;
        if (vocabSet.has(r.card)) coverage.cards.inVocab++;
        coverage.cards.distinct.add(r.card);
      }
    }
    coverage.leaders.seen++;
    if (r.me.leader !== null) {
      coverage.leaders.resolved++;
      if (vocabSet.has(r.me.leader)) coverage.leaders.inVocab++;
    }
    for (const b of r.before === null ? [] : [...r.before.me, ...r.before.opp]) {
      coverage.boardUnits.seen++;
      if (b.card !== null) {
        coverage.boardUnits.resolved++;
        if (vocabSet.has(b.card)) coverage.boardUnits.inVocab++;
      }
    }
    const dc = coverage.descriptor[cls ?? "other"];
    dc.records++;
    if (descriptorOf(r) !== null) dc.mapped++;

    if (!kept(r) || r.phase !== "action") continue;
    if (cls === "play" && r.card !== null) {
      if (fold === HELD_OUT_FOLD) {
        heldOutPlays.push(r);
        const side = sideOf(r);
        revealed.set(side, (revealed.get(side) ?? new Set()).add(r.card));
      } else {
        priorCounts.total++;
        priorCounts.global.set(r.card, (priorCounts.global.get(r.card) ?? 0) + 1);
        if (r.me.leader !== null) {
          const row = priorCounts.byLeader.get(r.me.leader) ?? new Map<string, number>();
          row.set(r.card, (row.get(r.card) ?? 0) + 1);
          priorCounts.byLeader.set(r.me.leader, row);
        }
      }
    }
    const s = stateFromRecord(r);
    if (s === null) continue;
    state.push(...stateFeatures(s));
    sY.push(cls === null ? -1 : ACTION_CLASSES.indexOf(cls));
    sWon.push(r.won ?? -1);
    sFold.push(fold);
    sForfeit.push(r.forfeit ? 1 : 0);

    const atk = r.attacks;
    if (r.kind !== "attack" || atk === undefined || atk.chosen === null || r.before === null) continue;
    if (atk.options.length < 2) {
      singleOption++;
      continue;
    }
    const pick = (list: readonly (typeof r.before.me)[number][], card: string, arena: string, ready: boolean): PUnit | null => {
      const want = card === "?" ? null : card;
      const u = list.find((x) => x.card === want && x.arena === arena && (!ready || !x.exhausted));
      return u === undefined ? null : unitOf(u);
    };
    const rows: number[][] = [];
    for (const [attacker, arena, target] of atk.options) {
      const a = pick(r.before.me, attacker, arena, true);
      const t = target === "base" ? "base" : pick(r.before.opp, target, arena, false);
      if (a === null || t === null) break;
      rows.push(optionFeatures(s, a, t, atk.options.length));
    }
    if (rows.length !== atk.options.length) continue;
    for (const [i, row] of rows.entries()) {
      opt.push(...row);
      oGroup.push(groups);
      oChosen.push(i === atk.chosen ? 1 : 0);
      oFold.push(fold);
    }
    groups++;
  }

  const prior: CardPrior = {
    alpha: 20,
    total: priorCounts.total,
    global: Object.fromEntries([...priorCounts.global].sort((a, b) => compareCodePoints(a[0], b[0]))),
    byLeader: Object.fromEntries(
      [...priorCounts.byLeader].sort((a, b) => compareCodePoints(a[0], b[0])).map(([l, row]) => [l, Object.fromEntries([...row].sort((a, b) => compareCodePoints(a[0], b[0])))]),
    ),
  };
  // Held-out card plays: rank the cards the same side revealed in that game and could afford.
  const evalCard = { decisions: 0, prior: { top1: 0, top3: 0 }, popularity: { top1: 0, top3: 0 }, uniform: { top1: 0, top3: 0 } };
  for (const r of heldOutPlays) {
    const card = r.card as string;
    const set = [...(revealed.get(sideOf(r)) ?? [])].filter((c) => c === card || (costOf.get(c) ?? 99) <= r.me.resources).sort(compareCodePoints);
    if (set.length < 2) continue;
    evalCard.decisions++;
    const rank = (score: (c: string) => number) => [...set].sort((a, b) => score(b) - score(a) || compareCodePoints(a, b)).indexOf(card);
    const rp = rank((c) => cardPriorScore(prior, r.me.leader, c));
    const rg = rank((c) => prior.global[c] ?? 0);
    if (rp === 0) evalCard.prior.top1++;
    if (rp < 3) evalCard.prior.top3++;
    if (rg === 0) evalCard.popularity.top1++;
    if (rg < 3) evalCard.popularity.top3++;
    evalCard.uniform.top1 += 1 / set.length;
    evalCard.uniform.top3 += Math.min(1, 3 / set.length);
  }
  const share = (x: number) => Math.round((x / Math.max(1, evalCard.decisions)) * 1e4) / 1e4;

  mkdirSync(outDir, { recursive: true });
  writeArray(path.join(outDir, "state.f32"), state, "f32");
  writeArray(path.join(outDir, "state-y.i8"), sY, "i8");
  writeArray(path.join(outDir, "state-won.i8"), sWon, "i8");
  writeArray(path.join(outDir, "state-fold.i8"), sFold, "i8");
  writeArray(path.join(outDir, "state-forfeit.i8"), sForfeit, "i8");
  writeArray(path.join(outDir, "opt.f32"), opt, "f32");
  writeArray(path.join(outDir, "opt-group.i32"), oGroup, "i32");
  writeArray(path.join(outDir, "opt-chosen.i8"), oChosen, "i8");
  writeArray(path.join(outDir, "opt-fold.i8"), oFold, "i8");
  const priorText = JSON.stringify(prior) + "\n";
  writeFileSync(path.join(outDir, "card-prior.json"), priorText);
  const distinct = [...coverage.cards.distinct];
  const meta = {
    kind: "human-prior-tables",
    schemaVersion: 1,
    decisions: { manifest: path.basename(manifestFile), outputHash: manifest.outputHash },
    codeCommit: codeCommit(),
    vocab: { file: path.relative(REPO_ROOT, vocabFile), contentSha256: vocab.contentSha256 },
    heldOutFold: HELD_OUT_FOLD,
    state: { rows: sY.length, columns: [...STATE_FEATURES] },
    options: { rows: oGroup.length, groups, singleOptionSkipped: singleOption, columns: [...OPTION_FEATURES] },
    classes: [...ACTION_CLASSES],
    cardPrior: { sha256: sha256Hex(priorText), trainPlays: prior.total, leaders: Object.keys(prior.byLeader).length, cards: Object.keys(prior.global).length },
    cardPriorEval: { decisions: evalCard.decisions, prior: { top1: share(evalCard.prior.top1), top3: share(evalCard.prior.top3) }, popularity: { top1: share(evalCard.popularity.top1), top3: share(evalCard.popularity.top3) }, uniform: { top1: share(evalCard.uniform.top1), top3: share(evalCard.uniform.top3) } },
    coverage: {
      cards: { refs: coverage.cards.refs, resolved: coverage.cards.resolved, inVocab: coverage.cards.inVocab, distinct: distinct.length, distinctInVocab: distinct.filter(inVocab).length },
      boardUnits: coverage.boardUnits,
      leaders: coverage.leaders,
      descriptor: coverage.descriptor,
    },
  };
  writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  p.done({ states: sY.length, options: oGroup.length, groups });
  console.log(JSON.stringify(meta, null, 1));
}

if (isMain(import.meta.url)) await main();
