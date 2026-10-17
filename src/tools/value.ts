import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { walkAbilities } from "../ability-grammar/walk.js";
import { REPO_ROOT } from "../paths.js";
import { DATED_DIR, packageDirOf, splitCell, type CardRow, type CardStore } from "../data.js";
import {
  SWU_CURATED_EFFECT_CATS,
  SWU_EFFECT_CATS,
  SWU_TRIGGER_IDS,
  swuCardFeaturesFileSchema,
  swuCardFeaturesReplaySchema,
  type SwuCardFeatures,
  type SwuClause,
  type SwuEffect,
} from "../schemas/card-features.js";
import { parseCoefficients, type Coefficients } from "../scorer/coefficients.js";
import { scoresFileSchema, scoresReplaySchema, type ScoreRow, type ScoresReplay } from "../scorer/scores-file.js";
import { compareCodePoints } from "../swu/canonical.js";
import type { ToolResult } from "../tools.js";
import { ok, fail, lower, hasValue } from "./common.js";

/**
 * @displayName Value tools
 * @strategicPurpose MCP read-only tools over the deterministic scorer's output: score_card,
 * rank_cards, compare_cards, card_features, find_by_effect, explain_rubric and data_version.
 * @tacticalObjective Loads <package>/scores and <package>/features once per store (the package is the
 * directory that holds llm/, resolved by src/data.ts), and answers in compact TOON. Every number is
 * read from committed files; nothing is computed by a model.
 */

export interface ValueData {
  packageDir: string;
  rows: Map<string, ScoreRow>;
  features: Map<string, SwuCardFeatures>;
  replay: ScoresReplay;
  featuresReplay: z.infer<typeof swuCardFeaturesReplaySchema>;
  coefficients: Coefficients;
  coefficientsSha256: string;
}

const cache = new WeakMap<CardStore, ValueData>();


function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function valueData(store: CardStore): ValueData {
  const hit = cache.get(store);
  if (hit !== undefined) return hit;
  const packageDir = packageDirOf(store);
  for (const needed of ["scores/scores.json", "scores/replay.json", "features/features.json", "features/replay.json"]) {
    if (!existsSync(path.join(packageDir, needed))) throw new Error(`${path.join(packageDir, needed)} is missing; run "pnpm card-features" then "pnpm score"`);
  }
  const scores = scoresFileSchema.parse(readJson(path.join(packageDir, "scores/scores.json")));
  const loaded = parseCoefficients(readFileSync(path.join(REPO_ROOT, "data/rubric-coefficients.json"), "utf8"));
  const data: ValueData = {
    packageDir,
    rows: new Map(scores.cards.map((row) => [row.cardKey, row])),
    features: new Map(swuCardFeaturesFileSchema.parse(readJson(path.join(packageDir, "features/features.json"))).map((card) => [card.cardKey, card])),
    replay: scoresReplaySchema.parse(readJson(path.join(packageDir, "scores/replay.json"))),
    featuresReplay: swuCardFeaturesReplaySchema.parse(readJson(path.join(packageDir, "features/replay.json"))),
    coefficients: loaded.coefficients,
    coefficientsSha256: loaded.sha256,
  };
  cache.set(store, data);
  return data;
}

/** Wraps a handler so a missing or invalid scores package becomes a tool error, not a thrown exception. */
function guarded(handler: (store: CardStore, data: ValueData, input: unknown) => ToolResult): (store: CardStore, input: unknown) => ToolResult {
  return (store, input) => {
    let data: ValueData;
    try {
      data = valueData(store);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    return handler(store, data, input);
  };
}

const r2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100 || 0);
const limit = z.number().int().min(1).max(200).default(20);

export const dataVersion = (replay: ScoresReplay): string => `${replay.rubricVersion}/${replay.outputHash.slice(0, 12)}`;

const cardRef = {
  cardKey: z.string().min(1).optional().describe("Exact cardKey, for example 0101033"),
  title: z.string().min(1).optional().describe("Exact card title, case-insensitive"),
  subtitle: z.string().optional().describe("Exact subtitle, case-insensitive; narrows a title shared by several leaders"),
};

function resolveCard(store: CardStore, args: { cardKey?: string; title?: string; subtitle?: string }): CardRow | string {
  if (args.cardKey !== undefined) return store.byKey.get(args.cardKey) ?? `no card with cardKey ${args.cardKey}`;
  if (args.title === undefined) return "give cardKey, or title with an optional subtitle";
  const title = args.title.toLowerCase();
  const subtitle = args.subtitle?.toLowerCase();
  const matches = store.cards.filter((card) => lower(card.title) === title && (subtitle === undefined || lower(card.subtitle) === subtitle));
  if (matches.length === 0) return `no card titled "${args.title}"${args.subtitle === undefined ? "" : ` with subtitle "${args.subtitle}"`}`;
  if (matches.length > 1) return `"${args.title}" matches ${matches.length} cards (${matches.map((m) => `${m.cardKey} ${m.subtitle ?? ""}`.trim()).join("; ")}); pass the cardKey or a subtitle`;
  return matches[0];
}

// ---------------------------------------------------------------------------------------------
// score_card

export const scoreCardShape = {
  ...cardRef,
  includeBreakdown: z.boolean().default(true).describe("Include the per-term contributions behind each component"),
};

const fmt = (x: number): string => `${x >= 0 ? "+" : ""}${(Math.round(x * 100) / 100).toFixed(2)}`;

function termList(row: ScoreRow, component: string, take = 4): string {
  const items = row.terms.filter((t) => t.component === component).slice(0, take);
  return items.length === 0 ? "none" : items.map((t) => `${t.term} ${fmt(t.value)}`).join(", ");
}

function componentLines(row: ScoreRow, card: CardRow, data: ValueData): { name: string; value: number | null; why: string }[] {
  const c = row.components;
  const d = data.coefficients.designer;
  const arena = splitCell(card.arenas)[0]?.toLowerCase() ?? "ground";
  const lines: { name: string; value: number | null; why: string }[] = [];
  if (row.model === "unit" || row.model === "leader") {
    lines.push({
      name: "expectedStats",
      value: r2(c.expectedStats),
      why:
        row.model === "unit"
          ? `Power plus HP a text-less ${arena} unit of cost ${row.cost} has on the fitted vanilla curve.`
          : `Power plus HP a leader unit with deploy threshold ${row.cost} has on the fitted curve.`,
    });
  }
  if (row.model === "base") lines.push({ name: "expectedStats", value: r2(c.expectedStats), why: "HP of a base with no ability on the fitted curve." });
  const surplusWhy: Record<string, string> = {
    unit: `Power x${d.powerWeight} plus HP x${d.hpWeight} above the vanilla curve (${card.power}/${card.hp} printed).`,
    leader: `Leader-unit power plus HP above the curve for its deploy threshold (${card.power}/${card.hp} printed).`,
    base: `Printed HP minus the HP of a no-ability base (${card.hp}).`,
    upgrade: `Priced value of the +${card.upgradePower ?? 0}/+${card.upgradeHp ?? 0} the upgrade gives, at ${d.statPointsPerResource.toFixed(1)} stat points per resource.`,
    event: "Events carry no stats.",
  };
  lines.push({ name: "statSurplus", value: r2(c.statSurplus), why: surplusWhy[row.model ?? "event"] });
  if (row.model === "event" || row.model === "upgrade") {
    const base = (row.model === "event" ? d.event : d.upgrade).intercept.b;
    lines.push({ name: "costTerm", value: r2(c.costTerm), why: `Stat points for paying ${row.cost} resources against the model's baseline price of ${base.toFixed(2)} (${d.statPointsPerResource.toFixed(1)} points per resource).` });
  }
  lines.push({ name: "keywordPoints", value: r2(c.keywordPoints), why: `Designer price of keywords on the card: ${termList(row, "keywordPoints")}.` });
  lines.push({ name: "effectPoints", value: r2(c.effectPoints), why: `Designer price of ability lines and effects: ${termList(row, "effectPoints")}.` });
  lines.push({ name: "modifiers", value: r2(c.modifiers), why: `Allowance for aspect icons, uniqueness, set and the model baseline: ${termList(row, "modifiers")}.` });
  if (row.playCalibrated !== null) {
    lines.push({ name: "playabilityT", value: r2(c.playabilityT), why: `T(cost ${row.cost}) in log-inclusion units against cost 2; as stat points ${fmt(c.playabilityTStat)}.` });
    lines.push({ name: "playCalibrated", value: r2(row.playCalibrated), why: "Sum of play-fitted weights on the card's features plus T(cost), in log-inclusion units; compare ranks only." });
  }
  lines.push({ name: "total", value: r2(row.total), why: "statSurplus + costTerm + keywordPoints + effectPoints + modifiers + playabilityT in stat points." });
  return lines;
}

export const scoreCardHandler = guarded((store, data, input) => {
  const args = z.object(scoreCardShape).parse(input);
  const card = resolveCard(store, args);
  if (typeof card === "string") return fail(card);
  const row = data.rows.get(card.cardKey);
  if (row === undefined) return fail(`no score for cardKey ${card.cardKey}; rerun "pnpm score"`);
  if (!row.scored) return ok({ card: { cardKey: row.cardKey, title: row.title, type: row.type }, scored: false, flags: row.flags, dataVersion: dataVersion(data.replay) });
  return ok({
    card: { cardKey: row.cardKey, title: row.title, subtitle: row.subtitle, type: row.type, cost: row.cost, set: row.set },
    total: r2(row.total),
    efficiency: r2(row.efficiency),
    playCalibrated: r2(row.playCalibrated),
    percentileInType: row.percentile,
    components: componentLines(row, card, data),
    ...(args.includeBreakdown ? { terms: row.terms.slice(0, 16).map((t) => ({ term: t.term, component: t.component, value: r2(t.value) })) } : {}),
    flags: row.flags,
    unclassifiedClauses: row.unclassifiedClauses,
    rubricVersion: data.replay.rubricVersion,
    dataVersion: dataVersion(data.replay),
  });
});

// ---------------------------------------------------------------------------------------------
// rank_cards

const SORT_KEYS = ["total", "playCalibrated", "statEfficiency"] as const;
export const rankCardsShape = {
  set: z.string().optional().describe("Expansion code the card has a printing in, for example JTL"),
  aspect: z.string().optional().describe("Aspect, for example Vigilance"),
  type: z.string().optional().describe("Card type: Unit, Event, Upgrade, Leader or Base"),
  arena: z.string().optional().describe("Ground or Space"),
  minCost: z.number().int().min(0).optional().describe("Lowest cost, inclusive"),
  maxCost: z.number().int().min(0).optional().describe("Highest cost, inclusive"),
  keyword: z.string().optional().describe("Keyword, for example Sentinel"),
  trait: z.string().optional().describe("Trait, for example Imperial"),
  sortBy: z
    .enum(SORT_KEYS)
    .default("playCalibrated")
    .describe("playCalibrated: fitted to Premier inclusion (recommended). total: designer stat points including T(cost). statEfficiency: designer stat points without T(cost)."),
  limit,
};

export const rankCardsHandler = guarded((store, data, input) => {
  const args = z.object(rankCardsShape).parse(input);
  const metric = (row: ScoreRow): number | null => (args.sortBy === "statEfficiency" ? row.efficiency : row[args.sortBy]);
  const matches = store.cards
    .filter((card) => {
      if (args.type !== undefined && lower(card.type) !== args.type.toLowerCase()) return false;
      if (args.aspect !== undefined && !hasValue(card.aspects, args.aspect)) return false;
      if (args.trait !== undefined && !hasValue(card.traits, args.trait)) return false;
      if (args.keyword !== undefined && !hasValue(card.keywords, args.keyword)) return false;
      if (args.set !== undefined && !hasValue(card.sets, args.set)) return false;
      if (args.arena !== undefined && !hasValue(card.arenas, args.arena)) return false;
      if ((args.minCost !== undefined || args.maxCost !== undefined) && card.cost === null) return false;
      if (args.minCost !== undefined && (card.cost ?? 0) < args.minCost) return false;
      if (args.maxCost !== undefined && (card.cost ?? 0) > args.maxCost) return false;
      return true;
    })
    .flatMap((card) => {
      const row = data.rows.get(card.cardKey);
      const value = row === undefined ? null : metric(row);
      return row === undefined || value === null ? [] : [{ card, row, value }];
    })
    .sort((a, b) => b.value - a.value || compareCodePoints(a.card.cardKey, b.card.cardKey));
  const shown = matches.slice(0, args.limit);
  return ok({
    sortBy: args.sortBy,
    total: matches.length,
    shown: shown.length,
    ...(args.sortBy !== "playCalibrated" && args.type === undefined
      ? { note: "total and statEfficiency are comparable within one type; pass type, or sort by playCalibrated for a mixed list." }
      : {}),
    cards: shown.map(({ card, row, value }, index) => ({
      rank: index + 1,
      cardKey: card.cardKey,
      title: card.title,
      subtitle: card.subtitle,
      type: card.type,
      cost: card.cost,
      aspects: card.aspects,
      value: r2(value),
      total: r2(row.total),
      playCalibrated: r2(row.playCalibrated),
    })),
    dataVersion: dataVersion(data.replay),
  });
});

// ---------------------------------------------------------------------------------------------
// compare_cards

export const compareCardsShape = {
  cardKeys: z.array(z.string().min(1)).min(2).max(5).describe("Two to five cardKeys"),
};

export const compareCardsHandler = guarded((store, data, input) => {
  const args = z.object(compareCardsShape).parse(input);
  const picked: { card: CardRow; row: ScoreRow }[] = [];
  for (const key of args.cardKeys) {
    const card = store.byKey.get(key);
    const row = data.rows.get(key);
    if (card === undefined || row === undefined) return fail(`no scored card with cardKey ${key}`);
    picked.push({ card, row });
  }
  const metric = (name: string, pickValue: (p: { card: CardRow; row: ScoreRow }) => unknown) => ({
    metric: name,
    ...Object.fromEntries(picked.map((p) => [p.card.cardKey, pickValue(p) ?? null])),
  });
  const numeric: [string, (p: { card: CardRow; row: ScoreRow }) => number | null][] = [
    ["total", (p) => r2(p.row.total)],
    ["efficiency", (p) => r2(p.row.efficiency)],
    ["playCalibrated", (p) => r2(p.row.playCalibrated)],
    ["percentileTotal", (p) => p.row.percentile.total],
    ["percentilePlay", (p) => p.row.percentile.playCalibrated],
    ["expectedStats", (p) => r2(p.row.components.expectedStats)],
    ["statSurplus", (p) => r2(p.row.components.statSurplus)],
    ["costTerm", (p) => r2(p.row.components.costTerm)],
    ["keywordPoints", (p) => r2(p.row.components.keywordPoints)],
    ["effectPoints", (p) => r2(p.row.components.effectPoints)],
    ["modifiers", (p) => r2(p.row.components.modifiers)],
    ["playabilityT", (p) => r2(p.row.components.playabilityT)],
  ];
  const highest = Object.fromEntries(
    ["total", "efficiency", "playCalibrated"].flatMap((name) => {
      const entry = numeric.find(([n]) => n === name);
      const best = picked
        .map((p) => ({ key: p.card.cardKey, v: entry?.[1](p) ?? null }))
        .filter((x): x is { key: string; v: number } => x.v !== null)
        .sort((a, b) => b.v - a.v || compareCodePoints(a.key, b.key))[0];
      return best === undefined ? [] : [[name, best.key]];
    }),
  );
  return ok({
    cards: picked.map(({ card }) => ({ cardKey: card.cardKey, title: card.title, subtitle: card.subtitle })),
    metrics: [
      metric("type", (p) => p.card.type),
      metric("cost", (p) => p.card.cost),
      metric("powerHp", (p) => (p.card.power === null && p.card.hp === null ? null : `${p.card.power ?? "-"}/${p.card.hp ?? "-"}`)),
      metric("aspects", (p) => p.card.aspects),
      metric("keywords", (p) => p.card.keywords || null),
      metric("set", (p) => p.row.set),
      ...numeric.map(([name, fn]) => metric(name, fn)),
      metric("flags", (p) => (p.row.flags.length === 0 ? null : p.row.flags.join(","))),
    ],
    highest,
    dataVersion: dataVersion(data.replay),
  });
});

// ---------------------------------------------------------------------------------------------
// card_features

export const cardFeaturesShape = {
  ...cardRef,
  includeProvenance: z.boolean().default(true).describe("Say for each clause whether the grammar or the curated table produced it"),
};

function targetText(effect: SwuEffect): string | null {
  const t = effect.target;
  return t === undefined ? null : [t.side, t.kind, t.arena === "any" ? "" : t.arena].filter((x) => x !== "").join(" ");
}

function effectText(effect: SwuEffect): string {
  const n = effect.n === undefined || effect.n === null ? "" : ` ${effect.n}`;
  const token = effect.tokens !== undefined ? ` ${effect.tokens.map(([name, count]) => `${count} ${name}`).join("+")}` : effect.token !== undefined ? ` ${effect.token}` : "";
  const to = targetText(effect);
  return `${effect.cat}${n}${token}${to === null ? "" : ` -> ${to}`}`;
}

interface ClauseVisit {
  face: string;
  trigger: string;
  repeat: string;
  optionOrGranted: boolean;
  clause: SwuClause;
}

function visitClauses(card: SwuCardFeatures): ClauseVisit[] {
  const out: ClauseVisit[] = [];
  for (const face of ["text", "deployBox", "epicAction"] as const) {
    const abilities = card.faces[face];
    if (abilities === undefined) continue;
    const top = new Set(abilities.filter((a) => a.kind === "ability").flatMap((a) => (a.kind === "ability" ? a.clauses : [])));
    for (const visit of walkAbilities(abilities, null)) {
      for (const clause of visit.clauses) {
        out.push({ face, trigger: visit.a.triggers[0]?.trigger ?? "constant", repeat: visit.repeat, optionOrGranted: !top.has(clause), clause });
      }
    }
  }
  return out;
}

function structuredView(f: SwuCardFeatures): Record<string, unknown> {
  const { cost, power, hp, upgradePower, upgradeHp, arenas, aspects, traits, unique, deployable } = f.structured;
  return { cost, power, hp, upgradePower, upgradeHp, arenas, aspects, traits, unique, deployable };
}

export const cardFeaturesHandler = guarded((store, data, input) => {
  const args = z.object(cardFeaturesShape).parse(input);
  const card = resolveCard(store, args);
  if (typeof card === "string") return fail(card);
  const f = data.features.get(card.cardKey);
  if (f === undefined) return fail(`no features for cardKey ${card.cardKey}`);
  const clauses = visitClauses(f);
  return ok({
    card: { cardKey: f.cardKey, title: f.title, subtitle: f.subtitle, type: f.type },
    structured: structuredView(f),
    keywords: f.keywords.map((k) => ({ keyword: k.keyword, n: k.n ?? null, cost: k.cost ?? null, granted: k.granted })),
    triggers: f.vector.triggers,
    conditionCounts: f.vector.conditions,
    clauses: clauses.map(({ face, trigger, repeat, optionOrGranted, clause }) => ({
      face,
      trigger,
      repeat,
      nested: optionOrGranted,
      text: clause.text,
      effects: clause.effects.map(effectText),
      conditions: clause.conditions.map((c) => c.cat),
      ...(args.includeProvenance ? { source: clause.source, curatedId: clause.curatedId ?? null } : {}),
    })),
    offers: f.tags.offers.map((t) => ({ tag: t.tag, why: t.why })),
    wants: f.tags.wants.map((t) => ({ tag: t.tag, why: t.why })),
    unclassified: f.unclassified.map((u) => ({ face: u.face, text: u.text })),
    ...(args.includeProvenance
      ? { provenance: { grammarClauses: clauses.filter((c) => c.clause.source === "grammar").length, curatedClauses: clauses.filter((c) => c.clause.source === "curated").length } }
      : {}),
    dataVersion: dataVersion(data.replay),
  });
});

// ---------------------------------------------------------------------------------------------
// find_by_effect

const EFFECT_CATS = [...SWU_EFFECT_CATS, ...SWU_CURATED_EFFECT_CATS];
export const findByEffectShape = {
  effect: z.string().min(1).describe("Effect category such as damage, draw, defeat, take_control, give_token, bounce, heal, capture; with role offers or wants, a fragment of a tag such as damage-enemy-unit"),
  role: z.enum(["effect", "offers", "wants"]).default("effect").describe("effect: the card produces this effect. offers or wants: match the synergy tags"),
  side: z.enum(["any", "friendly", "enemy", "mixed", "self", "ref"]).optional().describe("Whose cards the effect targets"),
  arena: z.enum(["any", "ground", "space", "both", "same", "other"]).optional().describe("Arena the effect targets"),
  timing: z.enum(SWU_TRIGGER_IDS).optional().describe("Trigger of the ability that holds the effect, for example when_played or on_attack"),
  aspect: z.string().optional(),
  type: z.string().optional().describe("Card type: Unit, Event, Upgrade, Leader or Base"),
  maxCost: z.number().int().min(0).optional(),
  limit,
};

export const findByEffectHandler = guarded((store, data, input) => {
  const args = z.object(findByEffectShape).parse(input);
  const effectName = args.effect.toLowerCase();
  if (args.role === "effect" && !EFFECT_CATS.includes(effectName as (typeof EFFECT_CATS)[number])) {
    return fail(`"${args.effect}" is not an effect category; use one of: ${EFFECT_CATS.join(", ")}`);
  }
  const rows = [];
  for (const row of store.cards) {
    const f = data.features.get(row.cardKey);
    if (f === undefined) continue;
    if (args.type !== undefined && lower(row.type) !== args.type.toLowerCase()) continue;
    if (args.aspect !== undefined && !hasValue(row.aspects, args.aspect)) continue;
    if (args.maxCost !== undefined && (row.cost === null || row.cost > args.maxCost)) continue;
    if (args.role === "effect") {
      const visits = visitClauses(f);
      const hit = visits.find((v) =>
        v.clause.effects.some((e) => e.cat === effectName && (args.side === undefined || e.target?.side === args.side) && (args.arena === undefined || e.target?.arena === args.arena)) &&
        (args.timing === undefined || v.trigger === args.timing),
      );
      if (hit === undefined) continue;
      const effect = hit.clause.effects.find((e) => e.cat === effectName);
      rows.push({
        cardKey: row.cardKey, title: row.title, subtitle: row.subtitle, type: row.type, cost: row.cost, aspects: row.aspects,
        trigger: hit.trigger, effect: effect === undefined ? null : effectText(effect), clause: hit.clause.text, source: hit.clause.source,
      });
    } else {
      const tags = args.role === "offers" ? f.tags.offers : f.tags.wants;
      const tag = tags.find((t) => t.tag.toLowerCase().includes(effectName));
      if (tag === undefined) continue;
      rows.push({
        cardKey: row.cardKey, title: row.title, subtitle: row.subtitle, type: row.type, cost: row.cost, aspects: row.aspects,
        trigger: null, effect: tag.tag, clause: tag.why, source: null,
      });
    }
  }
  rows.sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
  const shown = rows.slice(0, args.limit);
  return ok({ role: args.role, effect: args.effect, total: rows.length, shown: shown.length, cards: shown, dataVersion: dataVersion(data.replay) });
});

// ---------------------------------------------------------------------------------------------
// explain_rubric

const SECTIONS = ["summary", "unit_terms", "event_terms", "upgrade_terms", "play_terms"] as const;
export const explainRubricShape = {
  section: z.enum(SECTIONS).default("summary").describe("summary: formula, curve and weights. The others list fitted terms with standard errors and support"),
};

function termRows(terms: Record<string, { b: number; se: number; support: number }>): { term: string; b: number | null; se: number | null; t: number | null; support: number }[] {
  return Object.keys(terms)
    .sort(compareCodePoints)
    .map((name) => ({
      term: name,
      b: r2(terms[name].b),
      se: r2(terms[name].se),
      t: terms[name].se > 0 ? r2(terms[name].b / terms[name].se) : null,
      support: terms[name].support,
    }));
}

export const explainRubricHandler = guarded((_store, data, input) => {
  const args = z.object(explainRubricShape).parse(input);
  const c = data.coefficients;
  const source = {
    rubric: c.source.rubricDoc,
    fittedBy: "scripts/fit-coefficients.ts",
    capture: c.source.swuStatsCapture,
    coefficientsSha256: data.coefficientsSha256,
    rubricVersion: c.rubricVersion,
  };
  if (args.section === "summary") {
    return ok({
      formula: [
        "unit: expectedStats = vanilla power + HP at the card's cost, arena and uniqueness (linear in cost).",
        `unit: statSurplus = ${c.designer.powerWeight} x (power - expected power) + ${c.designer.hpWeight} x (HP - expected HP).`,
        "unit: keywordPoints, effectPoints, modifiers = minus the fitted coefficient x feature, so stats designers removed for text are added back.",
        "event and upgrade: costTerm = points-per-resource x (model baseline cost - printed cost); keyword and effect terms add points-per-resource x coefficient x feature.",
        "leader: unit-side stats against a curve on deploy threshold. base: HP against a no-ability base, plus an ability allowance. Effects on leaders are not priced.",
        "total = statSurplus + costTerm + keywordPoints + effectPoints + modifiers + T(cost) in stat points. efficiency is total without T(cost).",
        "playCalibrated = sum of fitted weights on surplus, keywords, effects, timing, type, space and unique, plus T(cost), in log-inclusion units. Fixed effects for set and aspect combination are excluded. Rank-meaningful only; units, events and upgrades only.",
        "A clause the grammar and curated table cannot classify has no feature, scores 0 and flags the card (unclassified_sentences). A condition halves a clause's effect value.",
      ],
      vanillaCurve: { n: c.vanilla.n, power: c.vanilla.power, hp: c.vanilla.hp },
      designerWeights: {
        powerWeight: c.designer.powerWeight,
        hpWeight: c.designer.hpWeight,
        fittedPowerHpRatio: r2(c.designer.fittedPowerHpRatio),
        statPointsPerResource: r2(c.designer.statPointsPerResource),
      },
      playabilityT: { appliedLogInclusionVsCost2: c.play.cost.applied, appliedFromCost: c.play.cost.appliedFrom, fitted: Object.entries(c.play.cost.fitted).map(([cost, t]) => ({ cost, b: r2(t.b), se: r2(t.se), support: t.support })) },
      playModel: { window: c.play.window, playerGames: c.play.games, cards: c.play.n, r2: r2(c.play.r2), statPointsPerLogInclusion: r2(c.play.perStatPoint), heldOutSpearmanLeaveOneSetOut: c.play.heldOutSpearman },
      caveats: [
        "Designer efficiency (total, efficiency) does not predict play; playCalibrated is fitted to SWU Stats Premier inclusion, so a score-versus-play gap is partly circular.",
        "Online simulator games, not paper. Homeworlds (HMW) has under one week of play data and is outside the play fit.",
        "Unit effect prices are mostly not identified beyond the per-line price; many fitted effect coefficients have |t| under 2 (see unit_terms).",
      ],
      source,
    });
  }
  const models = { unit_terms: c.designer.unit, event_terms: c.designer.event, upgrade_terms: c.designer.upgrade };
  if (args.section === "play_terms") {
    return ok({ section: args.section, dependent: "log((inclusions + 1) / player-games)", terms: termRows(c.play.terms), source });
  }
  const model = models[args.section];
  return ok({
    section: args.section,
    dependent: model.dependent,
    n: model.n,
    r2: r2(model.r2),
    intercept: r2(model.intercept.b),
    note: args.section === "unit_terms" ? "Price in stat points = minus the coefficient." : "Coefficients are resources of cost; multiplied by points-per-resource in the score.",
    terms: termRows(model.terms),
    source,
  });
});

// ---------------------------------------------------------------------------------------------
// data_version

export const dataVersionHandler = guarded((store, data) => {
  const date = path.basename(data.packageDir);
  return ok({
    packageDate: DATED_DIR.test(date) ? date : null,
    rubricVersion: data.replay.rubricVersion,
    codeCommit: data.replay.codeCommit,
    coefficientsSha256: data.replay.coefficientsSha256,
    coefficientsFileSha256: data.coefficientsSha256,
    scoresCurrent: data.replay.coefficientsSha256 === data.coefficientsSha256,
    scoredCards: data.replay.scoredCards,
    cards: store.cards.length,
    scoresOutputHash: data.replay.outputHash,
    inputHashes: data.replay.inputHashes,
    features: {
      inputHash: data.featuresReplay.inputHash,
      codeCommit: data.featuresReplay.codeCommit,
      curatedTableSha256: data.featuresReplay.curatedTableSha256,
      curatedTableVersion: data.featuresReplay.curatedTableVersion,
      grammarVersion: data.featuresReplay.grammarVersion,
      outputHashes: data.featuresReplay.outputHashes,
    },
    swuStatsCapture: { file: data.coefficients.source.swuStatsCapture, sha256: data.coefficients.source.swuStatsCaptureSha256, window: data.coefficients.play.window, playerGames: data.coefficients.play.games },
  });
});

export const VALUE_TOOLS = {
  score_card: {
    title: "Score a card",
    description:
      "Deterministic rubric score of one card with a component breakdown (expected stats, stat surplus, keyword and effect points, modifiers, T(cost)) and a play-calibrated score fitted to Premier inclusion. Each component carries a one-line explanation. Flags show unclassified text and unproven mechanics.",
    shape: scoreCardShape,
    handler: scoreCardHandler,
  },
  rank_cards: {
    title: "Rank cards by score",
    description:
      "Cards ranked by play-calibrated score (default), total or stat efficiency, filtered by set, aspect, type, arena, cost range, keyword and trait. total and statEfficiency compare within one type only.",
    shape: rankCardsShape,
    handler: rankCardsHandler,
  },
  compare_cards: {
    title: "Compare cards side by side",
    description: "Two to five cards in aligned columns: stats, aspects, keywords, every score component, percentiles and flags, with the leader on total, efficiency and play score.",
    shape: compareCardsShape,
    handler: compareCardsHandler,
  },
  card_features: {
    title: "Card ability features",
    description:
      "Parsed triggers, effects, conditions and synergy offers and wants for one card, clause by clause, with the clause text and whether the grammar or the curated table produced each one.",
    shape: cardFeaturesShape,
    handler: cardFeaturesHandler,
  },
  find_by_effect: {
    title: "Find cards by effect",
    description:
      "Cards that produce a named effect category (damage, draw, defeat, take_control, give_token...), optionally filtered by target side, target arena and trigger timing; or cards whose synergy tags offer or want a fragment.",
    shape: findByEffectShape,
    handler: findByEffectHandler,
  },
  explain_rubric: {
    title: "Explain the rubric",
    description: "The scoring formula, the fitted vanilla curve, weights, T(cost) table and fitted terms with standard errors, and where each number comes from. Use section for the long term lists.",
    shape: explainRubricShape,
    handler: explainRubricHandler,
  },
  data_version: {
    title: "Data version",
    description: "Package date, rubric version, code commit, coefficients hash, input hashes and feature-extraction replay record behind every score.",
    shape: {},
    handler: dataVersionHandler,
  },
} as const;
