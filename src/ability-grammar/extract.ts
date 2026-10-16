import {
  SWU_FEATURE_FACES,
  type SwuAbility,
  type SwuAbilityNode,
  type SwuCardFeatures,
  type SwuCardFeaturesCoverage,
  type SwuClause,
  type SwuFeatureFace,
  type SwuFeatureInputCard,
  type SwuUnclassifiedShape,
} from "./deps.js";
import { compareCodePoints, sha256Hex } from "./deps.js";
import { curatedKey, curatedReport, type CuratedIndex, type CuratedReport } from "./curated.js";
import { parseClause } from "./grammar.js";
import { extractGranted, isKeywordLine, normalizeText, parseHeader, parseKeywordList, splitHeader, splitSentences, stripReminders } from "./segment.js";
import { buildTags } from "./tags.js";
import { ASPECTS, KEYWORDS, TOKENS, alternation, escapeRegex } from "./vocab.js";
import { walkAbilities, walkKeywords } from "./walk.js";

// Shape normalisation is reporting only; it uses its own trait list (no "Force", the token/trait overlap).
const SHAPE_TRAITS = [
  "Bounty Hunter", "Capital Ship", "First Order", "New Republic", "Armor", "Clone", "Condition", "Creature", "Droid", "Ewok",
  "Fighter", "Fortification", "Fringe", "Gambit", "Gungan", "Hutt", "Imperial", "Inquisitor", "Item", "Jawa", "Jedi", "Kaminoan",
  "Law", "Learned", "Lightsaber", "Mandalorian", "Modification", "Musician", "Naboo", "Night", "Nihil", "Official", "Pilot", "Plan",
  "Rebel", "Republic", "Resistance", "Separatist", "Sith", "Spectre", "Speeder", "Supply", "Tactic", "Tank", "Transport", "Trick",
  "Trooper", "Tusken", "Twi'lek", "Undead", "Underworld", "Vehicle", "Walker", "Weapon", "Wookiee",
];

const vocabRe = (words: readonly string[]): RegExp => new RegExp(`\\b(?:${alternation(words)})\\b`, "g");
const SHAPE_VOCAB: readonly (readonly [RegExp, string])[] = [
  [vocabRe(TOKENS.map((t) => `${t} token`)), "TOKEN token"],
  [vocabRe(KEYWORDS), "KW"],
  [vocabRe(ASPECTS), "ASPECT"],
  [vocabRe(SHAPE_TRAITS), "TRAIT"],
];

function titleRegex(cards: readonly SwuFeatureInputCard[]): RegExp | null {
  const titles = [...new Set(cards.map((c) => c.title).filter((t) => t && /\s|-/.test(t)))]
    .sort((a, b) => b.length - a.length || compareCodePoints(a, b))
    .map(escapeRegex);
  return titles.length ? new RegExp(`\\b(?:${titles.join("|")})\\b`, "g") : null;
}

const splitList = (s: string | null | undefined): string[] => (s ? String(s).split("|").filter(Boolean) : []);

export function sortKeysDeep(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeysDeep);
  if (x && typeof x === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x).sort(compareCodePoints)) o[k] = sortKeysDeep((x as Record<string, unknown>)[k]);
    return o;
  }
  return x;
}

const pct = (a: number, b: number): number => (b === 0 ? 0 : Math.round((10000 * a) / b) / 100);

interface Stats {
  clauses: number;
  grammar: number;
  curated: number;
  full: number;
  contentWords: number;
  residueWords: number;
  headers: number;
  headersKnown: number;
  reminderOnly: number;
  keywordLines: number;
}

interface ShapeSlot {
  n: number;
  cards: Set<string>;
  example: SwuUnclassifiedShape["example"];
}

interface Context {
  stats: Stats;
  shapes: Map<string, ShapeSlot>;
  curated: CuratedIndex;
  shapeOf: (clause: string) => string;
}

function defaultTrigger(card: SwuFeatureInputCard, face: SwuFeatureFace): { trigger: "event_resolve" | "constant"; repeat: "once_on_play" | "constant" } {
  if (face === "text" && card.type === "Event") return { trigger: "event_resolve", repeat: "once_on_play" };
  return { trigger: "constant", repeat: "constant" };
}

function classifyClause(ctx: Context, card: SwuFeatureInputCard, face: SwuFeatureFace, clause: string, path: string): SwuClause {
  const { stats } = ctx;
  stats.clauses++;
  const r = parseClause(clause);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
  const strip = <T extends { span: [number, number] }>(xs: T[]): Omit<T, "span">[] => xs.map(({ span: _span, ...rest }) => rest);
  const rec = {
    path,
    text: clause,
    source: r.classified ? "grammar" : "none",
    effects: strip(r.accepted.effect),
    conditions: strip(r.accepted.condition),
    structure: strip(r.accepted.structure),
    modifiers: strip(r.accepted.modifier),
    residue: r.residueWords,
  } as SwuClause;
  const cur = ctx.curated.get(curatedKey(card.cardKey, face, sha256Hex(clause)));
  if (cur && (!r.classified || cur.entry.override === true)) {
    cur.used = true;
    rec.source = "curated";
    rec.curatedId = cur.entry.id;
    rec.effects = cur.entry.features.effects ?? [];
    rec.conditions = cur.entry.features.conditions ?? rec.conditions;
    rec.structure = cur.entry.features.structure ?? rec.structure;
    rec.wants = cur.entry.features.wants ?? [];
    rec.offers = cur.entry.features.offers ?? [];
    rec.residue = [];
  } else if (cur) {
    cur.redundant = true;
  }
  stats.contentWords += r.contentWords;
  stats.residueWords += rec.residue.length;
  if (rec.source === "grammar") stats.grammar++;
  if (rec.source === "curated") stats.curated++;
  if (rec.source !== "none" && rec.residue.length === 0) stats.full++;
  if (rec.source === "none") {
    const shape = ctx.shapeOf(clause);
    rec.shape = shape;
    const slot = ctx.shapes.get(shape) ?? { n: 0, cards: new Set<string>(), example: { cardKey: card.cardKey, title: card.title, face, clause } };
    slot.n++;
    slot.cards.add(card.cardKey);
    ctx.shapes.set(shape, slot);
  }
  return rec;
}

function parseParagraphs(ctx: Context, card: SwuFeatureInputCard, face: SwuFeatureFace, text: string, granted: boolean, path: string): SwuAbilityNode[] {
  const abilities: SwuAbilityNode[] = [];
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  let modalHost: SwuAbility | null = null;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const { text: p0 } = stripReminders(paragraphs[pi]);
    if (!p0) {
      ctx.stats.reminderOnly++;
      continue;
    }
    if (isKeywordLine(p0)) {
      ctx.stats.keywordLines++;
      abilities.push({ kind: "keyword", keywords: parseKeywordList(p0), granted, source: p0 });
      continue;
    }
    const { body: withG, granted: grantedTexts } = extractGranted(p0);
    const { header, body } = splitHeader(withG);
    let triggers: SwuAbility["triggers"] | null;
    if (header) {
      triggers = parseHeader(header);
      for (const t of triggers) {
        ctx.stats.headers++;
        if (t.trigger !== "unknown_header") ctx.stats.headersKnown++;
      }
    } else if (modalHost) {
      triggers = null;
    } else {
      const d = defaultTrigger(card, face);
      triggers = [d];
    }
    const sentences = splitSentences(body);
    const clauses = sentences.map((sentence, si) => classifyClause(ctx, card, face, sentence, `${path}p${pi}s${si}`));
    const grantedAbilities = grantedTexts.map((g, gi) => ({ index: gi, abilities: parseParagraphs(ctx, card, face, g, true, `${path}p${pi}g${gi}.`) }));
    if (triggers === null) {
      (modalHost as SwuAbility).options.push({ clauses, granted: grantedAbilities });
      continue;
    }
    let repeat = triggers[0].repeat;
    if (clauses.some((c) => c.modifiers.some((m) => m.cat === "limit_per_round"))) repeat = "per_round";
    const ability: SwuAbility = { kind: "ability", triggers, repeat, granted, clauses, grantedAbilities, options: [] };
    abilities.push(ability);
    modalHost = /:$/.test(body) ? ability : null;
  }
  return abilities;
}

function buildVector(faces: SwuCardFeatures["faces"]): SwuCardFeatures["vector"] {
  const v: SwuCardFeatures["vector"] = { triggers: {}, effects: {}, conditions: {}, optionalEffects: 0, unclassified: 0 };
  for (const face of SWU_FEATURE_FACES) {
    const abilities = faces[face];
    if (!abilities) continue;
    for (const { a, repeat, clauses, option } of walkAbilities(abilities, null)) {
      if (!option) for (const t of a.triggers) v.triggers[`${face}:${t.trigger}`] = (v.triggers[`${face}:${t.trigger}`] ?? 0) + 1;
      for (const c of clauses) {
        if (c.source === "none") {
          v.unclassified++;
          continue;
        }
        const optional = c.modifiers.some((m) => m.cat === "optional");
        for (const e of c.effects) {
          const tgt = e.target ? `${e.target.side}_${e.target.kind}${e.target.arena !== "any" ? `_${e.target.arena}` : ""}` : "none";
          const key = `${face}:${e.cat}`;
          const slot = v.effects[key] ?? (v.effects[key] = { count: 0, sumN: 0, varN: 0, byRepeat: {}, byTarget: {}, granted: 0, modal: 0 });
          slot.count++;
          if (typeof e.n === "number") slot.sumN += e.n;
          else if (e.n != null) slot.varN++;
          slot.byRepeat[repeat] = (slot.byRepeat[repeat] ?? 0) + 1;
          slot.byTarget[tgt] = (slot.byTarget[tgt] ?? 0) + 1;
          if (a.granted) slot.granted++;
          if (option) slot.modal++;
          if (optional) v.optionalEffects++;
        }
        for (const k of c.conditions) v.conditions[k.cat] = (v.conditions[k.cat] ?? 0) + 1;
      }
    }
  }
  return sortKeysDeep(v) as SwuCardFeatures["vector"];
}

export interface ExtractionResult {
  cards: SwuCardFeatures[];
  coverage: SwuCardFeaturesCoverage;
  shapes: SwuUnclassifiedShape[];
  curated: CuratedReport;
}

/**
 * @displayName SWU ability-text feature extractor
 * @strategicPurpose Turns the free text on every card into typed, scoreable
 * features by deterministic rungs only (structured fields, exact patterns, a
 * trigger x effect grammar, a curated per-card table), so the value rubric and
 * the pairing step never depend on a model (LampaGJ/mault#322).
 * @tacticalObjective Pure function of (card rows, curated index): sorts cards
 * by cardKey, segments each face into abilities and clauses, classifies each
 * clause, derives the vector and offers/wants tags, and returns the coverage
 * report and the unclassified-shape list. Mutates only the passed curated
 * index's used/redundant flags; build a fresh index per run.
 */
export function extractFeatures(inputCards: readonly SwuFeatureInputCard[], curated: CuratedIndex): ExtractionResult {
  const cards = [...inputCards].sort((a, b) => compareCodePoints(a.cardKey, b.cardKey));
  const titleRe = titleRegex(cards);
  const shapeOf = (clause: string): string => {
    let s = clause.replace(/⟦G\d+⟧/g, "GRANTED");
    if (titleRe) s = s.replace(titleRe, "NAME");
    for (const [re, tag] of SHAPE_VOCAB) s = s.replace(re, tag);
    return s.replace(/\[[^\]]*\]/g, "[COST]").replace(/[+-]?\d+/g, "N").toLowerCase().replace(/\s+/g, " ").trim();
  };
  const ctx: Context = {
    stats: { clauses: 0, grammar: 0, curated: 0, full: 0, contentWords: 0, residueWords: 0, headers: 0, headersKnown: 0, reminderOnly: 0, keywordLines: 0 },
    shapes: new Map(),
    curated,
    shapeOf,
  };

  const out: SwuCardFeatures[] = [];
  const kwMismatchCards: SwuCardFeaturesCoverage["keywordFieldMismatches"] = [];
  for (const card of cards) {
    const faces: SwuCardFeatures["faces"] = {};
    for (const face of SWU_FEATURE_FACES) {
      const t = normalizeText(card[face]);
      if (t.trim()) faces[face] = parseParagraphs(ctx, card, face, t, false, `${face}.`);
    }
    const textKeywords = SWU_FEATURE_FACES.flatMap((f) => {
      const nodes = faces[f];
      return nodes ? [...walkKeywords(nodes)] : [];
    });
    const fieldKeywords = splitList(card.keywords).sort(compareCodePoints);
    const printedOwn = [...new Set(textKeywords.filter((k) => !k.granted).map((k) => k.keyword))].sort(compareCodePoints);
    const missingInText = fieldKeywords.filter((k) => !printedOwn.includes(k));
    const missingInField = printedOwn.filter((k) => !fieldKeywords.includes(k));
    if (missingInField.length) kwMismatchCards.push({ cardKey: card.cardKey, title: card.title, missingInField });
    const unclassified: SwuCardFeatures["unclassified"] = [];
    for (const face of SWU_FEATURE_FACES) {
      const nodes = faces[face];
      if (!nodes) continue;
      for (const { clauses } of walkAbilities(nodes, null)) {
        for (const c of clauses) if (c.source === "none") unclassified.push({ face, path: c.path, text: c.text, shape: c.shape });
      }
    }
    const withoutTags: Omit<SwuCardFeatures, "tags"> = {
      cardKey: card.cardKey,
      title: card.title,
      subtitle: card.subtitle ?? null,
      type: card.type,
      structured: {
        cost: card.cost ?? null,
        power: card.power ?? null,
        hp: card.hp ?? null,
        upgradePower: card.upgradePower ?? null,
        upgradeHp: card.upgradeHp ?? null,
        arenas: splitList(card.arenas).sort(compareCodePoints),
        aspects: splitList(card.aspects),
        aspectIcons: [...splitList(card.aspects), ...splitList(card.aspectDuplicates)].sort(compareCodePoints),
        traits: splitList(card.traits).sort(compareCodePoints),
        keywordsField: fieldKeywords,
        unique: card.unique === true,
        deployable: card.type2 === "Leader Unit",
      },
      keywords: textKeywords,
      keywordCheck: { fieldNotInText: missingInText, textNotInField: missingInField },
      vector: buildVector(faces),
      unclassified,
      faces,
    };
    out.push({ ...withoutTags, tags: buildTags(withoutTags) });
  }

  const report = curatedReport(curated);
  const shapes: SwuUnclassifiedShape[] = [...ctx.shapes.entries()]
    .map(([shape, s]) => ({
      shape,
      clauses: s.n,
      cards: s.cards.size,
      example: s.example,
      recommend: s.cards.size >= 3 ? ("grammar_rule" as const) : ("curated_entry" as const),
    }))
    .sort((a, b) => b.clauses - a.clauses || b.cards - a.cards || compareCodePoints(a.shape, b.shape));

  const { stats } = ctx;
  const coverage: SwuCardFeaturesCoverage = {
    cards: out.length,
    cardsWithText: out.filter((c) => Object.keys(c.faces).length > 0).length,
    cardsFullyClassified: out.filter((c) => c.unclassified.length === 0).length,
    clauses: stats.clauses,
    classifiedByGrammar: stats.grammar,
    classifiedByCurated: stats.curated,
    unclassified: stats.clauses - stats.grammar - stats.curated,
    clauseCoveragePct: pct(stats.grammar + stats.curated, stats.clauses),
    fullyParsedClauses: stats.full,
    fullyParsedPct: pct(stats.full, stats.clauses),
    contentWordCoveragePct: pct(stats.contentWords - stats.residueWords, stats.contentWords),
    keywordLines: stats.keywordLines,
    reminderOnlyParagraphs: stats.reminderOnly,
    triggerHeaders: stats.headers,
    triggerHeadersKnownPct: pct(stats.headersKnown, stats.headers),
    distinctUnclassifiedShapes: shapes.length,
    singletonShapes: shapes.filter((s) => s.cards === 1).length,
    keywordFieldMismatchCards: kwMismatchCards.length,
    keywordFieldMismatches: kwMismatchCards,
    curated: report,
    topUnclassifiedShapes: shapes.slice(0, 30),
  };
  return { cards: out, coverage, shapes, curated: report };
}
