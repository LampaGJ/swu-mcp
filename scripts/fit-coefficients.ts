/**
 * @displayName Rubric coefficient fit
 * @strategicPurpose Manipulation node: the only place rubric weights are estimated. It reads the
 * feature output, the card rows and the pinned SWU Stats capture, and writes
 * data/rubric-coefficients.json, which the scorer reads and never changes.
 * @tacticalObjective Deterministic ordinary least squares (HC1 standard errors, scripts/rubric/ols.mjs)
 * over the feature builder in src/scorer/features.ts. No clock, randomness or model call.
 *
 * Usage: pnpm fit:coefficients [--data <package dir>] [--capture w29-55] [--out <file>] [--check]
 *   --data     default: newest dated dir under data/runs (SWU_MCP_DATA wins)
 *   --check    refit and compare with the committed file instead of writing; exit 4 on a difference
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sortKeysDeep } from "../src/ability-grammar/index.js";
import { resolveDataDir } from "../src/data.js";
import { coefficientsSchema, type Coefficients, type LinearModel, type Term } from "../src/scorer/coefficients.js";
import { PLAY_EXCLUDED_SETS, PLAY_MODEL_TYPES, SET_ORDER, cardFeatureValues, isSpace, type FeatureValues } from "../src/scorer/features.js";
import { loadScorerInputs } from "../src/scorer/inputs.js";
import { compareCodePoints, sha256Hex } from "../src/swu/canonical.js";
import { ols, type OlsFit } from "./rubric/ols.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUBRIC_VERSION = "2026-10-16.1";
/** Rubric choice (docs/research/swu-card-value-rubric.md, "Power versus HP"): the designers' ratio, rounded. */
const POWER_WEIGHT = 1.17;
const HP_WEIGHT = 1.0;

const SUPPORT = { unit: 15, event: 10, upgrade: 8, play: 5, aspectCombo: 8 } as const;

const round = (x: number): number => Math.round(x * 1e8) / 1e8 || 0;

interface Row {
  values: FeatureValues;
  y: number;
}

const has = (v: FeatureValues, key: string): number => v[key] ?? 0;

function support(rows: readonly FeatureValues[], name: string): number {
  return rows.filter((r) => (r[name] ?? 0) !== 0).length;
}

/** OLS on named columns; a column that is linearly dependent on earlier ones is dropped and the fit retried. */
function fitColumns(rows: readonly FeatureValues[], y: readonly number[], columns: readonly string[]): { fit: OlsFit; names: string[] } {
  let names = [...columns];
  for (;;) {
    const X = rows.map((r) => [1, ...names.map((n) => r[n] ?? 0)]);
    try {
      return { fit: ols(X, [...y], ["intercept", ...names]), names };
    } catch (error) {
      const m = /singular matrix at column (\d+)/.exec(error instanceof Error ? error.message : "");
      if (m === null || Number(m[1]) === 0) throw error;
      names = names.filter((_, i) => i !== Number(m[1]) - 1);
    }
  }
}

function term(fit: OlsFit, name: string, rows: readonly FeatureValues[]): Term {
  const c = fit.coefs.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no coefficient ${name}`);
  return { b: round(c.b), se: round(c.se), support: name === "intercept" ? rows.length : support(rows, name) };
}

function toModel(dependent: string, fit: OlsFit, names: readonly string[], rows: readonly FeatureValues[]): LinearModel {
  const terms: Record<string, Term> = {};
  for (const n of [...names].sort(compareCodePoints)) terms[n] = term(fit, n, rows);
  return { dependent, n: fit.n, r2: round(fit.r2), intercept: term(fit, "intercept", rows), terms };
}

function pick(rows: readonly FeatureValues[], prefixes: readonly string[], exact: readonly string[], minSupport: number): string[] {
  const all = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) if (prefixes.some((p) => k.startsWith(p)) || exact.includes(k)) all.add(k);
  return [...all].filter((k) => support(rows, k) >= minSupport).sort(compareCodePoints);
}

function spearman(a: readonly number[], b: readonly number[]): number {
  const rank = (v: readonly number[]): number[] => {
    const order = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const r = new Array<number>(v.length).fill(0);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const x = rank(a);
  const y = rank(b);
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function fitAll(dataDir: string, captureName: string): Coefficients {
  const inputs = loadScorerInputs(dataDir);
  const captureFile = path.join(REPO_ROOT, `data/pinned/gt/swustats-premier-${captureName}.json`);
  const captureText = readFileSync(captureFile, "utf8");
  const capture = JSON.parse(captureText) as { cardUid: string; timesIncluded: number }[];
  const replay = JSON.parse(readFileSync(path.join(dataDir, "features/replay.json"), "utf8")) as { inputHash: string };

  const cards = inputs.cards.map((card) => ({ card, values: cardFeatureValues(card) }));
  const ofType = (type: string) => cards.filter(({ card }) => card.features.type === type);

  // 1. Vanilla curve: units with no keyword and no ability text.
  const vanilla = ofType("Unit").filter(({ card, values }) => card.features.structured.cost !== null && card.features.keywords.length === 0 && has(values, "line") === 0);
  const curveRows = vanilla.map(({ card }) => ({ cost: card.features.structured.cost ?? 0, space: isSpace(card.features) ? 1 : 0, unique: card.features.structured.unique ? 1 : 0 }));
  const curveFit = (pick_: "power" | "hp") =>
    ols(
      curveRows.map((r) => [1, r.cost, r.space, r.unique]),
      vanilla.map(({ card }) => card.features.structured[pick_] ?? 0),
      ["intercept", "cost", "space", "unique"],
    );
  const curveOf = (fit: OlsFit) => ({ intercept: round(fit.beta[0]), cost: round(fit.beta[1]), space: round(fit.beta[2]), unique: round(fit.beta[3]) });
  const vanillaCurves = { n: vanilla.length, power: curveOf(curveFit("power")), hp: curveOf(curveFit("hp")) };
  const expected = (cost: number, space: boolean, unique: boolean) => {
    const at = (c: typeof vanillaCurves.power) => c.intercept + c.cost * cost + c.space * (space ? 1 : 0) + c.unique * (unique ? 1 : 0);
    return { power: at(vanillaCurves.power), hp: at(vanillaCurves.hp) };
  };

  // 2. Designer unit model: weighted stat surplus on aspects, uniqueness, set, keywords and text.
  const units = ofType("Unit").filter(({ card }) => card.features.structured.cost !== null);
  const unitRows = units.map(({ card, values }) => {
    const s = card.features.structured;
    const e = expected(s.cost ?? 0, isSpace(card.features), s.unique);
    const y = POWER_WEIGHT * ((s.power ?? 0) - e.power) + HP_WEIGHT * ((s.hp ?? 0) - e.hp);
    return { values, y } satisfies Row;
  });
  const unitValues = unitRows.map((r) => r.values);
  const unitCols = ["aspects", "unique", ...pick(unitValues, ["kw:", "kwn:", "fx:", "tok:", "set:", "t:"], ["line", "tokenUnit", "credit"], SUPPORT.unit)];
  const unitFit = fitColumns(unitValues, unitRows.map((r) => r.y), unitCols);

  // statPointsPerResource: cost regressed on power and HP with the same controls (rubric M2).
  const m2Values = units.map(({ card, values }) => ({ ...values, power: card.features.structured.power ?? 0, hp: card.features.structured.hp ?? 0 }));
  const m2 = fitColumns(m2Values, units.map(({ card }) => card.features.structured.cost ?? 0), ["power", "hp", "space", ...unitCols]);
  const bP = m2.fit.coefs.find((c) => c.name === "power")?.b ?? NaN;
  const bH = m2.fit.coefs.find((c) => c.name === "hp")?.b ?? NaN;
  if (!(bP > 0 && bH > 0)) throw new Error(`cost model gave non-positive stat prices (power ${bP}, hp ${bH})`);

  // 3. Event and upgrade cost models (rubric E1, U1): cost on effect features, in resources.
  const costModel = (type: "Event" | "Upgrade", minSupport: number) => {
    const set = ofType(type).filter(({ card }) => card.features.structured.cost !== null);
    const vals = set.map((s) => s.values);
    const base = type === "Upgrade" ? ["upgradeStats", "aspects", "unique"] : ["aspects"];
    const cols = [...base, ...pick(vals, ["kw:", "kwn:", "fx:", "tok:"], ["tokenUnit", "credit"], minSupport), ...(type === "Upgrade" ? pick(vals, ["t:"], [], minSupport) : [])];
    const { fit, names } = fitColumns(vals, set.map(({ card }) => card.features.structured.cost ?? 0), [...new Set(cols)]);
    return toModel("cost", fit, names, vals);
  };

  // 4. Leader (rubric L1: unit-side stats on deploy threshold) and base (B1: HP on having an ability).
  const leaders = ofType("Leader").filter(({ card }) => card.features.structured.cost !== null && card.features.structured.power !== null);
  const leaderVals = leaders.map(({ card }) => ({ cost: card.features.structured.cost ?? 0, space: isSpace(card.features) ? 1 : 0 }));
  const leaderFit = fitColumns(leaderVals, leaders.map(({ card }) => (card.features.structured.power ?? 0) + (card.features.structured.hp ?? 0)), ["cost", "space"]);
  const bases = ofType("Base").filter(({ card }) => card.features.structured.hp !== null);
  const baseVals = bases.map(({ values }) => values);
  const baseFit = fitColumns(baseVals, bases.map(({ card }) => card.features.structured.hp ?? 0), ["hasAbility"]);

  // 5. Play model: log Premier inclusion on content features, with set and aspect-combination fixed effects.
  const uidToKey = new Map<string, string>();
  for (const [key, row] of inputs.rows) if (row.cardUid !== null) uidToKey.set(String(row.cardUid), key);
  const included = new Map<string, number>();
  let matched = 0;
  for (const r of capture) {
    const key = uidToKey.get(r.cardUid);
    if (key === undefined) continue;
    matched++;
    included.set(key, (included.get(key) ?? 0) + r.timesIncluded);
  }
  const typeOf = new Map(cards.map(({ card }) => [card.features.cardKey, card.features.type]));
  const games = [...included.entries()].filter(([key]) => typeOf.get(key) === "Leader").reduce((s, [, v]) => s + v, 0);
  if (games <= 0) throw new Error("no leader inclusions matched the capture; cardUid join is broken");

  const playPop = cards.filter(({ card }) => (PLAY_MODEL_TYPES as readonly string[]).includes(card.features.type) && card.features.structured.cost !== null && card.set !== null && !(PLAY_EXCLUDED_SETS as readonly string[]).includes(card.set));
  const playRows = playPop.map(({ card, values }) => {
    const s = card.features.structured;
    const v: FeatureValues = { ...values };
    delete v.aspects;
    delete v.line;
    for (const k of Object.keys(v)) if (k.startsWith("set:")) delete v[k];
    if (card.features.type === "Unit" && s.power !== null && s.hp !== null) {
      const e = expected(s.cost ?? 0, isSpace(card.features), s.unique);
      v.powerSurplus = s.power - e.power;
      v.hpSurplus = s.hp - e.hp;
    }
    const cost = s.cost ?? 0;
    if (cost !== 2) v[`cost${Math.min(cost, 7)}`] = 1;
    if (card.set !== null && card.set !== "JTL") v[`ctx:set:${card.set}`] = 1;
    v[`ctx:asp:${[...s.aspects].sort(compareCodePoints).join("+")}`] = 1;
    return { values: v, y: Math.log(((included.get(card.features.cardKey) ?? 0) + 1) / games), set: card.set ?? "" };
  });
  const playValues = playRows.map((r) => r.values);
  const aspKeys = pick(playValues, ["ctx:asp:"], [], SUPPORT.aspectCombo);
  const costKeys = pick(playValues, ["cost"], [], SUPPORT.play);
  const contentKeys = [
    ...pick(playValues, ["kw:", "kwn:", "fx:", "tok:", "t:"], ["tokenUnit", "credit", "powerSurplus", "hpSurplus", "upgradeStats", "type:Event", "type:Upgrade", "space", "unique"], SUPPORT.play),
  ];
  const ctxKeys = [...pick(playValues, ["ctx:set:"], [], SUPPORT.play), ...aspKeys.slice(1)];
  const playFit = fitColumns(playValues, playRows.map((r) => r.y), [...contentKeys, ...costKeys, ...ctxKeys]);
  const playTermNames = playFit.names.filter((n) => !n.startsWith("cost") && !n.startsWith("ctx:"));
  const costFitted: Record<string, Term> = {};
  for (const n of playFit.names.filter((x) => x.startsWith("cost"))) costFitted[n.slice(4)] = term(playFit.fit, n, playValues);
  const APPLIED_FROM = 5;
  const applied: Record<string, number> = {};
  for (let c = 0; c <= 7; c++) applied[String(c)] = c >= APPLIED_FROM && costFitted[String(c)] !== undefined ? costFitted[String(c)].b : 0;
  const powerCoef = playFit.fit.coefs.find((c) => c.name === "powerSurplus")?.b ?? NaN;
  const hpCoef = playFit.fit.coefs.find((c) => c.name === "hpSurplus")?.b ?? NaN;
  const meanSurplusCoef = (powerCoef + hpCoef) / 2;
  const perStatPoint = meanSurplusCoef > 0 ? meanSurplusCoef : powerCoef;
  if (!(powerCoef > 0)) throw new Error(`play power-surplus coefficient is ${powerCoef}; T(cost) cannot be converted to stat points`);

  // Leave-one-set-out held-out Spearman, full model versus cost + type + aspect baseline.
  const heldOut: Coefficients["play"]["heldOutSpearman"] = [];
  const baselineKeys = [...costKeys, "type:Event", "type:Upgrade", ...aspKeys.slice(1)];
  for (const held of SET_ORDER.filter((s) => !(PLAY_EXCLUDED_SETS as readonly string[]).includes(s))) {
    const train = playRows.filter((r) => r.set !== held);
    const test = playRows.filter((r) => r.set === held);
    const run = (cols: readonly string[]): number => {
      const live = cols.filter((k) => train.some((r) => (r.values[k] ?? 0) !== 0));
      const { fit, names } = fitColumns(train.map((r) => r.values), train.map((r) => r.y), live);
      const pred = test.map((r) => fit.beta[0] + names.reduce((s, n, i) => s + (r.values[n] ?? 0) * fit.beta[i + 1], 0));
      return spearman(pred, test.map((r) => r.y));
    };
    const full = run([...contentKeys, ...costKeys, ...aspKeys.slice(1)]);
    const base = run(baselineKeys);
    heldOut.push({ heldOut: held, n: test.length, full: round(full), baseline: round(base) });
  }

  const unitModel = toModel("statSurplus", unitFit.fit, unitFit.names, unitValues);
  const out: Coefficients = {
    schemaVersion: 1,
    rubricVersion: RUBRIC_VERSION,
    source: {
      rubricDoc: "docs/research/swu-card-value-rubric.md",
      scriptSha256: sha256Hex(readFileSync(fileURLToPath(import.meta.url), "utf8")),
      featuresModuleSha256: sha256Hex(readFileSync(path.join(REPO_ROOT, "src/scorer/features.ts"), "utf8")),
      featuresJsonSha256: inputs.featuresJsonSha256,
      cardsToonSha256: inputs.cardsToonSha256,
      featuresReplayInputHash: replay.inputHash,
      swuStatsCapture: path.relative(REPO_ROOT, captureFile),
      swuStatsCaptureSha256: sha256Hex(captureText),
    },
    vanilla: vanillaCurves,
    designer: {
      powerWeight: POWER_WEIGHT,
      hpWeight: HP_WEIGHT,
      fittedPowerHpRatio: round(bP / bH),
      statPointsPerResource: round(2 / (bP + bH)),
      unit: unitModel,
      event: costModel("Event", SUPPORT.event),
      upgrade: costModel("Upgrade", SUPPORT.upgrade),
      leader: toModel("leaderUnitStats", leaderFit.fit, leaderFit.names, leaderVals),
      base: toModel("baseHp", baseFit.fit, baseFit.names, baseVals),
    },
    play: {
      window: captureName,
      games,
      n: playFit.fit.n,
      r2: round(playFit.fit.r2),
      perStatPoint: round(perStatPoint),
      terms: Object.fromEntries([...playTermNames].sort(compareCodePoints).map((n) => [n, term(playFit.fit, n, playValues)])),
      cost: { fitted: costFitted, applied, appliedFrom: APPLIED_FROM },
      heldOutSpearman: heldOut,
    },
  };
  console.error(`fit: vanilla n=${vanillaCurves.n}, units n=${unitModel.n} r2=${unitModel.r2}, play n=${out.play.n} r2=${out.play.r2}, capture rows matched ${matched}/${capture.length}, games ${games}`);
  return coefficientsSchema.parse(out);
}

function main(): void {
  const { values } = parseArgs({ options: { data: { type: "string" }, capture: { type: "string" }, out: { type: "string" }, check: { type: "boolean" } } });
  const dataDir = path.resolve(values.data ?? resolveDataDir());
  const outFile = path.resolve(values.out ?? path.join(REPO_ROOT, "data/rubric-coefficients.json"));
  const text = `${JSON.stringify(sortKeysDeep(fitAll(dataDir, values.capture ?? "w29-55")), null, 1)}\n`;
  if (values.check === true) {
    const same = readFileSync(outFile, "utf8") === text;
    console.log(same ? "coefficients replay: identical" : "coefficients replay: DIFFERENT");
    process.exitCode = same ? 0 : 4;
    return;
  }
  writeFileSync(outFile, text);
  console.log(`wrote ${outFile} sha256 ${sha256Hex(text)}`);
}

main();
