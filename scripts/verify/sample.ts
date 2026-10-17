/**
 * Seeded, reproducible evidence packets for semantic verification (LampaGJ/swu-mcp#9, Part B).
 *
 * Every sampled item carries its ORIGINAL evidence inline (raw card text, PDF text, the curated clause) beside
 * the derived claim, so a small model can return a verdict without opening any other file. Items are ordered by
 * sha256(seed + id); stratified packets interleave strata first and use that order inside each stratum. The same
 * seed and the same inputs give byte-identical packets.
 *
 * Usage: pnpm verify:sample [--originals <dir>] [--run <dir>] [--out <dir>] [--seed <s>] [--date <YYYY-MM-DD>]
 *   --originals  default: newest dated dir under /Volumes/Local Files/Projects/mault/data/swu-originals
 *   --run        default: <repo>/data/runs/<date>
 *   --out        default: <repo>/tmp/verify/packets
 *   --seed       default: verify-<date>
 * Output: <out>/<packet>.json for eight packets plus <out>/index.json (packet list, sizes, verdict JSON schema).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { decode } from "@toon-format/toon";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { REPO_ROOT } from "../../src/paths.js";
import { DEFAULT_ORIGINALS_ROOT, newestDatedDir } from "../lib/originals.js";


type Rec = Record<string, unknown>;

export interface RawRecord {
  id: number | null;
  serial: string;
  attributes: Rec;
}

export interface FieldEntry {
  paths: string[];
  section: string;
  body: string;
}

export interface Inputs {
  cards: Rec[];
  records: RawRecord[];
  pageMeta: Rec[];
  features: Rec[];
  curated: Rec[];
  pairs: Rec[];
  complementarity: Rec[];
  fungibilityClasses: Rec[];
  sections: Rec[];
  pdfPages: string[];
  glossary: Record<string, Rec[]>;
  keywordRules: Rec[];
  fieldGuide: FieldEntry[];
  priceSources: { printings: Rec[]; corrections: Rec[]; quarantine: Rec[]; importRow: Rec[] };
}

export interface Packet {
  packet: string;
  packetType: string;
  seed: string;
  itemCount: number;
  whatToCheck: string;
  items: Rec[];
}

// ---------------------------------------------------------------- ordering

export const seedHash = (seed: string, id: string): string => createHash("sha256").update(seed + id).digest("hex");

/** Items ordered by sha256(seed + id), ties broken by id in code-point order. */
export function orderBySeed<T>(items: readonly T[], seed: string, idOf: (item: T) => string): T[] {
  return items
    .map((item) => ({ item, id: idOf(item), hash: seedHash(seed, idOf(item)) }))
    .sort((a, b) => compareCodePoints(a.hash, b.hash) || compareCodePoints(a.id, b.id))
    .map((entry) => entry.item);
}

/** Strata (outermost first) are visited in seed order and interleaved one item per round; inside the last stratum, seed order. */
export function orderStratified<T>(items: readonly T[], seed: string, idOf: (item: T) => string, levels: readonly ((item: T) => string)[]): T[] {
  if (levels.length === 0) return orderBySeed(items, seed, idOf);
  const [level, ...rest] = levels;
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = level(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const keys = orderBySeed([...groups.keys()], seed, (key) => `stratum:${levels.length}:${key}`);
  const lists = keys.map((key) => orderStratified(groups.get(key) as T[], seed, idOf, rest));
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round += 1) {
    for (const list of lists) if (round < list.length) out.push(list[round]);
  }
  return out;
}

/** Takes quota items per stratum in seed order, then tops up from the leftovers in seed order up to total. */
function pickWithQuotas<T>(items: readonly T[], seed: string, idOf: (item: T) => string, stratumOf: (item: T) => string, quotas: Record<string, number>, total: number): T[] {
  const chosen: T[] = [];
  const taken = new Set<string>();
  for (const [stratum, quota] of Object.entries(quotas)) {
    const pool = orderBySeed(
      items.filter((item) => stratumOf(item) === stratum),
      seed,
      idOf,
    );
    for (const item of pool.slice(0, quota)) {
      chosen.push(item);
      taken.add(idOf(item));
    }
  }
  const rest = orderBySeed(
    items.filter((item) => !taken.has(idOf(item))),
    seed,
    idOf,
  );
  for (const item of rest) if (chosen.length < total) chosen.push(item);
  return chosen.slice(0, total);
}

// ---------------------------------------------------------------- small helpers

const str = (r: Rec, key: string): string => (typeof r[key] === "string" ? (r[key] as string) : "");
const split = (value: unknown): string[] => (typeof value === "string" && value !== "" ? value.split("|") : []);
const clipText = (value: string, limit: number): string => (value.length > limit ? `${value.slice(0, limit)}…[+${value.length - limit} chars]` : value);

function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === "object") {
    const out: Rec = {};
    for (const [k, v] of Object.entries(value as Rec)) {
      const c = compact(v);
      const empty = c === null || c === undefined || c === "" || (Array.isArray(c) && c.length === 0) || (typeof c === "object" && !Array.isArray(c) && Object.keys(c as Rec).length === 0);
      if (!empty) out[k] = c;
    }
    return out;
  }
  return value;
}

function relNames(value: unknown): string[] {
  const data = (value as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data.map((e) => String((e as { attributes?: Rec }).attributes?.name ?? "")) : [];
}

function relName(value: unknown, field = "name"): string | null {
  const data = (value as { data?: unknown } | null)?.data;
  if (data === null || data === undefined || Array.isArray(data)) return null;
  const v = (data as { attributes?: Rec }).attributes?.[field];
  return typeof v === "string" ? v : null;
}

const trimText = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.replace(/[ \t]+$/gm, "").trim() : null);

/** The original card as printed: text fields as the official API returns them (trailing whitespace trimmed). */
export function rawView(record: RawRecord): Rec {
  const a = record.attributes;
  return compact({
    cardKey: record.serial,
    title: a.title,
    subtitle: a.subtitle,
    type: relName(a.type),
    type2: relName(a.type2),
    cost: a.cost,
    power: a.power,
    hp: a.hp,
    upgradePower: a.upgradePower,
    upgradeHp: a.upgradeHp,
    aspects: relNames(a.aspects),
    traits: relNames(a.traits),
    arenas: relNames(a.arenas),
    keywords: relNames(a.keywords),
    unique: a.unique === true ? true : undefined,
    text: trimText(a.text),
    deployBox: trimText(a.deployBox),
    epicAction: trimText(a.epicAction),
  }) as Rec;
}

// ---------------------------------------------------------------- packet builders

const VERDICT_RULE =
  "Return one verdict entry per item id. Use \"correct\" when everything you were asked to check holds, \"wrong\" when a claim is unsupported, contradicted or missing from the evidence (name the defect in `field` and say why in `reason`; add more entries with the same id for further defects), and \"unsure\" when the evidence cannot settle it. Judge only from the evidence inline in the item.";

const WHAT_TO_CHECK: Record<string, string> = {
  features:
    "Each item is one card. `raw` is the original card text and printed fields. `derived` is what our parser produced: abilities (triggers, clauses, effects, conditions), unclassified residue, and the offers/wants tags with a `why`. PRECISION: every trigger, effect, condition and tag must be supported by the raw text (is-trait and has-keyword tags may be supported by the printed traits and keywords). RECALL: every ability, trigger, effect, condition, keyword or target in the raw text should have a counterpart in `derived`; report anything missing with field `missing:<what>`. Name the offending tag or effect in `field`, for example `tags.offers[offers:draw-card]`.",
  curated:
    "Each item is one curated ability entry. `sourceClause` is the clause the entry was written for; `card` is the full original card text. Check that (1) the clause really appears in the card text, (2) `entry.features` (effects, conditions, structure, offers, wants) correctly model what the clause does, and (3) `entry.rationale` is accurate. Name the wrong part in `field`, for example `features.effects[0].cat`.",
  pairings:
    "Each item is one claimed synergy pair, direction A to B. `claim.reason` and `claim.rows` say why. `rowDefinitions` give each row's offers and wants tags. `a` and `b` hold the original card texts plus their offers/wants tags. Check that A really offers what B wants under the named row, using the original text (not just the tags), and that the reason sentence is true for this pair. Use field `reason`, `a.offers`, or `b.wants` to say which side fails.",
  fungible:
    "Each item is one class of cards our model treats as interchangeable (fungible) in a deck. `roleSignature` is what the members share. `members` hold the original text of up to eight of the class's members (`size` is the full count). Check that the shown members really fill the same role described by the signature (same tag, timing, rough magnitude and cost band). Name the odd member in `field` as `member:<cardKey>`.",
  rules:
    "Each item is one section of our parsed Comprehensive Rules. `ours` is our section id, depth, title path and text. `pdfExcerpt` is the raw `pdftotext -layout` text around that section (indentation and markers kept; private-use glyphs shown as [icon]). Check (1) that the id and nesting (parentId, depth, titlePath) match the numbering and indentation in the PDF, and (2) that our text is faithful to the PDF (nothing dropped, added or reordered, ignoring whitespace and line breaks). If `located` is false, the excerpt may be the wrong place: use \"unsure\" unless the id/text can be confirmed otherwise.",
  glossary:
    "Each item is one glossary entry. `claim` is our definition (and strategic value). `evidence` holds the supporting material: rule sections that define the keyword, card texts that use the value, or raw printings carrying it. Check that the definition is supported by the evidence and does not contradict it. The strategicValue is judgement: flag it only if the evidence contradicts it. Name `definition` or `strategicValue` in `field`.",
  fieldguide:
    "Each item is one field-guide entry (`entry.body` holds the Type, Meaning, Strategic value and Interacts-with claims). `examples` are up to three raw values of that field drawn from the original data. Check that the Type claim (string, integer, null, array, ...) and every concrete claim about values (example values, formats, ranges, what null means) agree with the raw examples. `examples.note` says when no non-null value was found: then use \"unsure\" for value claims. Name the claim in `field`, for example `Type` or `Meaning`.",
};

export const VERDICT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Verification verdict for one evidence packet",
  type: "object",
  additionalProperties: false,
  required: ["packet", "items", "summary"],
  properties: {
    packet: { type: "string", description: "The packet name, for example features-1." },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "reason"],
        properties: {
          id: { type: "string", description: "The item id from the packet." },
          verdict: { enum: ["correct", "wrong", "unsure"] },
          field: { type: "string", description: "The claim or field that is wrong or unclear." },
          reason: { type: "string", description: "One or two sentences quoting the evidence." },
        },
      },
    },
    summary: {
      type: "object",
      additionalProperties: false,
      required: ["correct", "wrong", "unsure"],
      description: "Counts of distinct item ids. An id with any wrong entry counts as wrong; otherwise unsure if any entry is unsure.",
      properties: { correct: { type: "integer" }, wrong: { type: "integer" }, unsure: { type: "integer" } },
    },
  },
} as const;

function rawByKey(inputs: Inputs): Map<string, RawRecord> {
  return new Map(inputs.records.map((record) => [record.serial, record]));
}

function featuresByKey(inputs: Inputs): Map<string, Rec> {
  return new Map(inputs.features.map((card) => [str(card, "cardKey"), card]));
}

function derivedClaims(card: Rec): Rec {
  const faces = (card.faces ?? {}) as Record<string, Rec[]>;
  const abilities: Rec[] = [];
  for (const [face, list] of Object.entries(faces)) {
    for (const ability of list) {
      abilities.push(
        compact({
          face,
          kind: ability.kind,
          triggers: ((ability.triggers ?? []) as Rec[]).map((t) => (t.text ? `${String(t.trigger)} ("${String(t.text)}")` : String(t.trigger))),
          granted: ability.granted === true ? true : undefined,
          keywords: ability.keywords,
          source: ability.source,
          clauses: ((ability.clauses ?? []) as Rec[]).map((clause) => ({
            text: clause.text,
            via: clause.source,
            effects: ((clause.effects ?? []) as Rec[]).map((effect) => {
              const target = (effect.target ?? null) as Rec | null;
              return { ...effect, target: target === null ? undefined : { side: target.side, kind: target.kind, arena: target.arena, quant: target.quant, restrict: target.restrict, text: target.text } };
            }),
            conditions: clause.conditions,
            structure: clause.structure,
            modifiers: clause.modifiers,
            residue: clause.residue,
          })),
          grantedAbilities: ability.grantedAbilities,
          options: ability.options,
        }) as Rec,
      );
    }
  }
  const tags = (card.tags ?? {}) as { offers?: Rec[]; wants?: Rec[] };
  return compact({
    abilities,
    unclassified: card.unclassified,
    keywordCheck: card.keywordCheck,
    tags: { offers: tags.offers, wants: tags.wants },
  }) as Rec;
}

/** Cards per type group in the 80-card features sample: weighted to units, whose text carries most abilities. */
const FEATURE_QUOTAS: Record<string, number> = { Unit: 26, Leader: 12, Event: 12, Upgrade: 12, Base: 8, Token: 10 };

function buildFeatures(inputs: Inputs, seed: string): Packet[] {
  const raw = rawByKey(inputs);
  const typeOf = new Map(inputs.cards.map((card) => [str(card, "cardKey"), str(card, "type")]));
  const firstSetOf = new Map(inputs.cards.map((card) => [str(card, "cardKey"), str(card, "firstSet")]));
  const groupOf = (card: Rec): string => {
    const type = typeOf.get(str(card, "cardKey")) ?? str(card, "type");
    return type.includes("Token") ? "Token" : type;
  };
  const halves: Rec[][] = [[], []];
  for (const [group, quota] of Object.entries(FEATURE_QUOTAS)) {
    const members = inputs.features.filter((card) => groupOf(card) === group);
    const chosen = orderStratified(members, seed, (card) => str(card, "cardKey"), [(card) => firstSetOf.get(str(card, "cardKey")) ?? ""]).slice(0, quota);
    chosen.forEach((card, index) => halves[index % 2].push(card));
  }
  const toItem = (card: Rec): Rec => {
    const record = raw.get(str(card, "cardKey"));
    return { id: str(card, "cardKey"), stratum: `${groupOf(card)}/${firstSetOf.get(str(card, "cardKey")) ?? ""}`, raw: record === undefined ? null : rawView(record), derived: derivedClaims(card) };
  };
  return halves.map((cards, half) => {
    const items = orderBySeed(cards, seed, (card) => str(card, "cardKey")).map(toItem);
    return { packet: `features-${half + 1}`, packetType: "features", seed, itemCount: items.length, whatToCheck: `${WHAT_TO_CHECK.features} ${VERDICT_RULE}`, items };
  });
}

function buildCurated(inputs: Inputs, seed: string): Packet {
  const raw = rawByKey(inputs);
  const items = orderBySeed(inputs.curated, seed, (entry) => str(entry, "id"))
    .slice(0, 40)
    .map((entry) => {
      const record = raw.get(str(entry, "cardKey"));
      return {
        id: str(entry, "id"),
        sourceClause: entry.sourceClause,
        face: entry.face,
        card: record === undefined ? null : rawView(record),
        entry: compact({ features: entry.features, rationale: entry.rationale, confidence: entry.confidence }),
      };
    });
  return { packet: "curated", packetType: "curated", seed, itemCount: items.length, whatToCheck: `${WHAT_TO_CHECK.curated} ${VERDICT_RULE}`, items };
}

const rowFamily = (rows: string): string => (rows.split("|")[0] ?? "").split(":")[0] ?? "";

/** Builds the evidence view of one synergy pair, shared by the #9 sample and the pair fixture. */
export function pairingItemBuilder(inputs: Inputs): (pair: Rec) => Rec {
  const raw = rawByKey(inputs);
  const features = featuresByKey(inputs);
  const defs = new Map(inputs.complementarity.map((row) => [str(row, "id"), row]));
  const side = (key: string, kind: "offers" | "wants"): Rec => {
    const record = raw.get(key);
    const tags = ((features.get(key)?.tags ?? {}) as Record<string, Rec[]>)[kind] ?? [];
    return { card: record === undefined ? null : rawView(record), [kind]: tags };
  };
  return (pair) => {
    const rows = str(pair, "rows").split("|");
    return {
      claim: { direction: "A offers what B wants", reason: pair.reason, rows: pair.rows, linkStrength: pair.link, nonObviousScore: pair.nonObvious, score: pair.score },
      rowDefinitions: rows.map((row) => {
        const def = defs.get(row.split(":")[0]);
        return { row, definition: def === undefined ? null : compact({ offers: def.offers, wants: def.wants, reason: def.reason }) };
      }),
      a: side(str(pair, "cardA"), "offers"),
      b: side(str(pair, "cardB"), "wants"),
    };
  };
}

export const PAIRINGS_INSTRUCTIONS = `${WHAT_TO_CHECK.pairings} ${VERDICT_RULE}`;

function buildPairings(inputs: Inputs, seed: string): Packet {
  const itemOf = pairingItemBuilder(inputs);
  const idOf = (pair: Rec): string => `${str(pair, "cardA")}|${str(pair, "cardB")}|${str(pair, "rows")}`;
  const items = orderStratified(inputs.pairs, seed, idOf, [(pair) => rowFamily(str(pair, "rows"))])
    .slice(0, 40)
    .map((pair) => ({ id: idOf(pair), ...itemOf(pair) }));
  return { packet: "pairings", packetType: "pairings", seed, itemCount: items.length, whatToCheck: PAIRINGS_INSTRUCTIONS, items };
}

function buildFungible(inputs: Inputs, seed: string): Packet {
  const raw = rawByKey(inputs);
  const features = featuresByKey(inputs);
  const eligible = inputs.fungibilityClasses.filter((cls) => ((cls.members ?? []) as string[]).length >= 3);
  const items = orderStratified(eligible, seed, (cls) => str(cls, "id"), [(cls) => str(cls, "tag")])
    .slice(0, 25)
    .map((cls) => {
      const members = orderBySeed((cls.members ?? []) as string[], seed, (key) => `${str(cls, "id")}#${key}`);
      const tag = str(cls, "tag");
      return {
        id: str(cls, "id"),
        roleSignature: { tag, side: cls.side, typeGroup: cls.typeGroup, timing: cls.timing, magnitude: cls.magnitude, costBand: cls.costBand },
        size: members.length,
        membersShown: Math.min(8, members.length),
        members: members.slice(0, 8).map((key) => {
          const record = raw.get(key);
          const tags = ((features.get(key)?.tags ?? {}) as Record<string, Rec[]>)[tag.startsWith("wants:") ? "wants" : "offers"] ?? [];
          return { card: record === undefined ? { cardKey: key } : rawView(record), tagWhy: tags.filter((t) => t.tag === tag).map((t) => t.why) };
        }),
      };
    });
  return { packet: "fungible", packetType: "fungible", seed, itemCount: items.length, whatToCheck: `${WHAT_TO_CHECK.fungible} ${VERDICT_RULE}`, items };
}

const alnum = (s: string): string => s.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
const isFooter = (line: string): boolean => line.includes("StarWarsUnlimited.com");

/** Raw pdftotext lines around a section: located by its heading or opening words on its start page (then the next, then the previous). */
export function pdfExcerpt(section: Rec, pdfPages: readonly string[]): { located: boolean; page: number | null; text: string } {
  const page = Number(section.page);
  const body = `${str(section, "title")} ${str(section, "text")}`;
  const needle = alnum(str(section, "title") === "" || str(section, "text") !== "" ? str(section, "text") || str(section, "title") : str(section, "title")).slice(0, 30);
  const target = alnum(body).length + 20;
  if (needle === "") return { located: false, page: null, text: "" };
  for (const pageNo of [page, page + 1, page - 1]) {
    const lines = (pdfPages[pageNo - 1] ?? "").split("\n").filter((line) => !isFooter(line));
    for (let i = 0; i < lines.length; i += 1) {
      const window = alnum(lines.slice(i, i + 3).join(" "));
      const next = alnum(lines.slice(i + 1, i + 4).join(" "));
      if (!window.includes(needle) || next.includes(needle)) continue;
      const out: string[] = [];
      let covered = 0;
      let pageIdx = pageNo;
      let lineIdx = Math.max(0, i - 2);
      let pageLines = lines;
      while (out.length < 40 && covered < target) {
        if (lineIdx >= pageLines.length) {
          pageIdx += 1;
          if (pageIdx > pdfPages.length) break;
          pageLines = (pdfPages[pageIdx - 1] ?? "").split("\n").filter((line) => !isFooter(line));
          lineIdx = 0;
          continue;
        }
        const line = pageLines[lineIdx];
        if (lineIdx >= i) covered += alnum(line).length;
        if (line.trim() !== "") out.push(line.replace(/[-]+/g, "[icon]").replace(/\s+$/, "").replace(/ {7,}/g, "      "));
        lineIdx += 1;
      }
      return { located: true, page: pageNo, text: out.join("\n") };
    }
  }
  return { located: false, page: null, text: "" };
}

function buildRules(inputs: Inputs, seed: string): Packet {
  const byId = new Map(inputs.sections.map((section) => [str(section, "id"), section]));
  const order = new Map(inputs.sections.map((section, index) => [str(section, "id"), index]));
  const chosen = pickWithQuotas(inputs.sections, seed, (s) => str(s, "id"), (s) => String(s.depth), { "0": 4, "1": 10, "2": 14, "3": 12 }, 40).sort((a, b) => (order.get(str(a, "id")) ?? 0) - (order.get(str(b, "id")) ?? 0));
  const items = chosen.map((section) => {
    const path: string[] = [];
    for (let parent = byId.get(str(section, "parentId")); parent !== undefined; parent = byId.get(str(parent, "parentId"))) {
      path.unshift(`${str(parent, "id")}${str(parent, "title") === "" ? "" : ` ${str(parent, "title")}`}`);
    }
    const excerpt = pdfExcerpt(section, inputs.pdfPages);
    return {
      id: str(section, "id"),
      ours: { id: section.id, parentId: section.parentId, depth: section.depth, page: section.page, titlePath: path, title: section.title, text: section.text },
      located: excerpt.located,
      pdfPage: excerpt.page,
      pdfExcerpt: excerpt.text,
    };
  });
  return { packet: "rules", packetType: "rules", seed, itemCount: items.length, whatToCheck: `${WHAT_TO_CHECK.rules} ${VERDICT_RULE}`, items };
}

const GLOSSARY_QUOTAS: Record<string, number> = { keyword: 9, trait: 8, aspect: 3, type: 3, arena: 1, rarity: 2, expansion: 5, variant: 5, token: 4 };

function buildGlossary(inputs: Inputs, seed: string): Packet {
  const raw = rawByKey(inputs);
  const sectionsById = new Map(inputs.sections.map((section) => [str(section, "id"), section]));
  const keywordRules = new Map(inputs.keywordRules.map((row) => [str(row, "keyword"), row]));
  const pool = Object.entries(inputs.glossary).flatMap(([facet, entries]) => entries.map((entry) => ({ facet, value: str(entry, "value"), entry })));
  const chosen = pickWithQuotas(pool, seed, (e) => `${e.facet}:${e.value}`, (e) => e.facet, GLOSSARY_QUOTAS, 40);
  const facetOrder = Object.keys(GLOSSARY_QUOTAS);
  chosen.sort((a, b) => facetOrder.indexOf(a.facet) - facetOrder.indexOf(b.facet) || compareCodePoints(seedHash(seed, `${a.facet}:${a.value}`), seedHash(seed, `${b.facet}:${b.value}`)));

  const cardColumns: Record<string, (card: Rec) => string[]> = {
    keyword: (card) => split(card.keywords),
    trait: (card) => split(card.traits),
    aspect: (card) => split(card.aspects),
    type: (card) => [...split(card.type), ...split(card.type2)],
    arena: (card) => split(card.arenas),
    rarity: (card) => split(card.rarity),
  };
  const cardEvidence = (key: string): Rec => {
    const record = raw.get(key);
    return record === undefined ? { cardKey: key } : rawView(record);
  };
  const printingEvidence = (record: RawRecord): Rec =>
    compact({ serial: record.serial, title: record.attributes.title, subtitle: record.attributes.subtitle, type: relName(record.attributes.type), expansion: relName(record.attributes.expansion, "code"), variantTypes: relNames(record.attributes.variantTypes), rarity: relName(record.attributes.rarity), power: record.attributes.power, hp: record.attributes.hp, text: trimText(record.attributes.text) }) as Rec;

  const items = chosen.map(({ facet, value, entry }) => {
    const evidence: Rec = {};
    const column = cardColumns[facet];
    if (column !== undefined) {
      const carriers = inputs.cards.filter((card) => column(card).includes(value));
      evidence.carriedByCards = carriers.length;
      evidence.carrierSamples = orderBySeed(carriers, seed, (card) => `${facet}:${value}#${str(card, "cardKey")}`).slice(0, 3).map((card) => cardEvidence(str(card, "cardKey")));
    }
    if (facet === "keyword") {
      const rule = keywordRules.get(value);
      const section = (id: string): Rec => {
        const s = sectionsById.get(id);
        const children = inputs.sections.filter((c) => str(c, "id").startsWith(`${id}.`)).slice(0, 6);
        return s === undefined ? { id } : { id, title: s.title, text: clipText(str(s, "text"), 700), children: children.map((c) => ({ id: c.id, text: clipText(str(c, "text"), 400) })) };
      };
      evidence.ruleSections = ((rule?.sections ?? []) as string[]).map(section);
      evidence.mentionedIn = ((rule?.mentionedIn ?? []) as string[]).slice(0, 3).map((id) => ({ id, text: clipText(str(sectionsById.get(id) ?? {}, "text"), 300) }));
      evidence.keywordRulesDefinition = rule?.definition ?? null;
      const printed = inputs.records.filter((record) => relNames(record.attributes.keywords).includes(value));
      evidence.rawPrintingsWithKeyword = printed.length;
      evidence.rawPrintingSamples = orderBySeed(printed, seed, (record) => `${facet}:${value}#${record.serial}`).slice(0, 2).map(printingEvidence);
    }
    if (facet === "trait") {
      const word = new RegExp(`(?<![A-Za-z])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "i");
      const mentioners = inputs.cards.filter((card) => !column(card).includes(value) && word.test(`${str(card, "text")} ${str(card, "deployBox")} ${str(card, "epicAction")}`));
      evidence.namedInTextOfCards = mentioners.length;
      evidence.mentionSamples = orderBySeed(mentioners, seed, (card) => `${facet}:${value}@${str(card, "cardKey")}`).slice(0, 2).map((card) => cardEvidence(str(card, "cardKey")));
    }
    if (facet === "expansion" || facet === "variant") {
      const carriers = inputs.records.filter((record) => (facet === "expansion" ? [relName(record.attributes.expansion, "code") ?? ""] : relNames(record.attributes.variantTypes)).includes(value));
      evidence.rawPrintings = carriers.length;
      evidence.printingSamples = orderBySeed(carriers, seed, (record) => `${facet}:${value}#${record.serial}`).slice(0, 3).map(printingEvidence);
    }
    if (facet === "token") {
      const carriers = inputs.records.filter((record) => String(record.attributes.title ?? "") === value && (relName(record.attributes.type) ?? "").includes("Token"));
      evidence.rawPrintings = carriers.length;
      evidence.printingSamples = orderBySeed(carriers, seed, (record) => `${facet}:${value}#${record.serial}`).slice(0, 2).map(printingEvidence);
    }
    return { id: `${facet}:${value}`, facet, claim: compact({ definition: entry.definition, strategicValue: entry.strategicValue, source: entry.source, inScope: entry.inScope }), evidence: compact(evidence) };
  });
  return { packet: "glossary", packetType: "glossary", seed, itemCount: items.length, whatToCheck: `${WHAT_TO_CHECK.glossary} ${VERDICT_RULE}`, items };
}

// ---------------------------------------------------------------- field guide

/** Bold-path bullets of the field guide with their indented body, tagged with the `##` section they sit in. */
export function parseFieldGuide(markdown: string): FieldEntry[] {
  const lines = markdown.split("\n");
  const entries: FieldEntry[] = [];
  let section = "";
  for (let i = 0; i < lines.length; i += 1) {
    const heading = /^## (.+)$/.exec(lines[i]);
    if (heading !== null) {
      section = heading[1].trim();
      continue;
    }
    const start = /^(\s*)- ((?:\*\*`[^`]+`\*\*(?:, )?)+)(.*)$/.exec(lines[i]);
    if (start === null) continue;
    const indent = start[1].length;
    const paths = [...start[2].matchAll(/\*\*`([^`]+)`\*\*/g)].map((m) => m[1]);
    const body = [start[3].replace(/^[:\s]+/, "").trim()].filter((l) => l !== "");
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      // A bold-path bullet ends the body only at the parent indent or shallower; a deeper one is a child and stays in the parent body.
      const lineIndent = line.length - line.trimStart().length;
      if (/^#{1,6} /.test(line) || (line.trim() !== "" && lineIndent <= indent)) break;
      if (line.trim() !== "") body.push(line.trim());
    }
    entries.push({ paths, section, body: body.join("\n") });
  }
  return entries;
}

function valuesAt(value: unknown, segments: readonly string[]): unknown[] {
  if (segments.length === 0) return [value];
  if (value === null || value === undefined) return [];
  const [head, ...rest] = segments;
  const many = head.endsWith("[]");
  const key = many ? head.slice(0, -2) : head;
  const child = key === "" ? value : (value as Rec)[key];
  if (many) return Array.isArray(child) ? child.flatMap((entry) => valuesAt(entry, rest)) : [];
  return valuesAt(child, rest);
}

const exampleText = (value: unknown): unknown => {
  if (typeof value === "string") return clipText(value, 300);
  if (value !== null && typeof value === "object") return clipText(JSON.stringify(value), 300);
  return value;
};

function fieldExamples(entry: FieldEntry, inputs: Inputs, seed: string): Rec {
  const path0 = entry.paths[0];
  const sources: { id: string; root: unknown }[] = [];
  let segments: string[] = [];
  const dotted = (p: string): string[] => p.split(".").filter((s) => s !== "");
  if (entry.section === "Price import") {
    segments = dotted(path0.replace(/^import\./, ""));
    sources.push(...inputs.priceSources.importRow.map((row, i) => ({ id: `import#${i}`, root: row })));
  } else if (entry.section === "TCG printing") {
    segments = dotted(path0.replace(/^printings\[\]\./, ""));
    sources.push(...inputs.priceSources.printings.map((row) => ({ id: `${str(row, "card_id")}/${str(row, "product_id")}`, root: row })));
  } else if (entry.section === "Correction" || entry.section === "Quarantine") {
    segments = dotted(path0.replace(/^\$\[\]\./, ""));
    const rows = entry.section === "Correction" ? inputs.priceSources.corrections : inputs.priceSources.quarantine;
    sources.push(...rows.map((row) => ({ id: String(row.id), root: row })));
  } else if (path0.startsWith("meta.")) {
    segments = dotted(path0).slice(1);
    sources.push(...inputs.pageMeta.map((meta, i) => ({ id: `page-${i + 1}`, root: meta })));
  } else if (path0 === "data[].id") {
    sources.push(...inputs.records.map((record) => ({ id: record.serial, root: { id: record.id } })));
    segments = ["id"];
  } else {
    const rest = path0.replace(/^printings\[\]\./, "").replace(/^data\[\]\.attributes\./, "");
    segments = dotted(rest);
    sources.push(...inputs.records.map((record) => ({ id: record.serial, root: record.attributes })));
  }
  const ordered = orderBySeed(sources, seed, (s) => `${path0}#${s.id}`);
  const seen = new Set<string>();
  const examples: Rec[] = [];
  let scanned = 0;
  let nullsOnly = 0;
  for (const source of ordered) {
    scanned += 1;
    for (const value of valuesAt(source.root, segments)) {
      if (value === null || value === undefined) {
        nullsOnly += 1;
        continue;
      }
      const key = JSON.stringify(value);
      if (seen.has(key) || examples.length >= 3) continue;
      seen.add(key);
      examples.push({ from: source.id, value: exampleText(value) });
    }
    if (examples.length >= 3) break;
  }
  const note = examples.length === 0 ? (nullsOnly > 0 ? `only null/absent values found in ${scanned} records` : `path not found in ${scanned} records`) : examples.length < 3 ? `only ${examples.length} distinct non-null value(s) found in ${scanned} records` : null;
  return compact({ sourceSection: entry.section, paths: entry.paths, values: examples, note, nullOrAbsentSeenBeforeStop: nullsOnly }) as Rec;
}

function buildFieldGuide(inputs: Inputs, seed: string): Packet {
  const items = orderStratified(inputs.fieldGuide, seed, (entry) => entry.paths.join(","), [(entry) => entry.section])
    .slice(0, 30)
    .map((entry) => ({ id: entry.paths.join(","), entry: { section: entry.section, paths: entry.paths, body: entry.body }, examples: fieldExamples(entry, inputs, seed) }));
  return { packet: "fieldguide", packetType: "fieldguide", seed, itemCount: items.length, whatToCheck: `${WHAT_TO_CHECK.fieldguide} ${VERDICT_RULE}`, items };
}

export function buildPackets(inputs: Inputs, seed: string): Packet[] {
  return [...buildFeatures(inputs, seed), buildCurated(inputs, seed), buildPairings(inputs, seed), buildFungible(inputs, seed), buildRules(inputs, seed), buildGlossary(inputs, seed), buildFieldGuide(inputs, seed)];
}

export const serialize = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function buildIndex(packets: readonly Packet[], seed: string, files: ReadonlyMap<string, number>): Rec {
  return {
    seed,
    ordering: "items ordered by sha256(seed + id) (lowercase hex, code-point order); stratified packets interleave strata first",
    packets: packets.map((p) => ({ packet: p.packet, file: `${p.packet}.json`, packetType: p.packetType, itemCount: p.itemCount, bytes: files.get(p.packet) ?? 0 })),
    totalItems: packets.reduce((n, p) => n + p.itemCount, 0),
    verdictSchema: VERDICT_SCHEMA,
  };
}

// ---------------------------------------------------------------- loading

function parseAt<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label}: ${z.prettifyError(result.error)}`);
  return result.data;
}

const recs = z.array(z.record(z.string(), z.unknown()));
const readJson = <T>(file: string, schema: z.ZodType<T>): T => parseAt(schema, JSON.parse(readFileSync(file, "utf8")), file);

function decodeTable(file: string, name: string): Rec[] {
  const table = decode(readFileSync(file, "utf8")) as Record<string, unknown>;
  return parseAt(recs, table[name], `${file}#${name}`);
}

export function loadInputs(options: { originalsDir: string; runDir: string }): Inputs {
  const { originalsDir, runDir } = options;
  const pagesDir = path.join(originalsDir, "swu-cards/raw-pages");
  const manifest = readJson(path.join(pagesDir, "manifest.json"), z.looseObject({ pages: z.array(z.looseObject({ page: z.number() })) }));
  const records: RawRecord[] = [];
  const pageMeta: Rec[] = [];
  const pageSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.number().nullish(), attributes: z.record(z.string(), z.unknown()) })), meta: z.record(z.string(), z.unknown()) });
  for (const entry of [...manifest.pages].sort((a, b) => a.page - b.page)) {
    const page = readJson(path.join(pagesDir, `page-${String(entry.page).padStart(4, "0")}.json`), pageSchema);
    pageMeta.push(page.meta);
    for (const record of page.data) {
      const attributes = { ...record.attributes };
      if (!seedHash("localizations", String(attributes.serialCode)).startsWith("00")) delete attributes.localizations;
      records.push({ id: record.id ?? null, serial: String(attributes.serialCode), attributes });
    }
  }
  const sectionsFile = readJson(path.join(runDir, "rules/sections.json"), z.looseObject({ document: z.looseObject({ version: z.string() }), sections: recs }));
  const pdfDir = path.join(REPO_ROOT, "data/originals/rules", sectionsFile.document.version);
  const pdfName = readdirSync(pdfDir).find((f) => f.endsWith(".pdf"));
  if (pdfName === undefined) throw new Error(`no CR PDF under ${pdfDir}`);
  const tmp = path.join(REPO_ROOT, "tmp");
  mkdirSync(tmp, { recursive: true });
  const pdfText = execFileSync("pdftotext", ["-layout", path.join(pdfDir, pdfName), "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, TMPDIR: tmp } });
  const pdfPages = pdfText.split("\f");
  if (pdfPages.at(-1)?.trim() === "") pdfPages.pop();
  const glossary = readJson(path.join(runDir, "docs/swu-glossary.json"), z.looseObject({ facets: z.record(z.string(), recs) }));
  const prices = path.join(originalsDir, "tcgplayer-prices");
  return {
    cards: decodeTable(path.join(runDir, "llm/cards.toon"), "cards"),
    records,
    pageMeta,
    features: readJson(path.join(runDir, "features/features.json"), recs),
    curated: readJson(path.join(REPO_ROOT, "data/curated-rules.json"), z.looseObject({ entries: recs })).entries,
    pairs: decodeTable(path.join(runDir, "synergy/pairs.toon"), "pairings"),
    complementarity: readJson(path.join(REPO_ROOT, "data/complementarity.json"), z.looseObject({ rows: recs })).rows,
    fungibilityClasses: readJson(path.join(runDir, "synergy/fungibility.json"), z.looseObject({ classes: recs })).classes,
    sections: sectionsFile.sections,
    pdfPages,
    glossary: glossary.facets,
    keywordRules: readJson(path.join(runDir, "rules/keyword_rules.json"), z.looseObject({ keywords: recs })).keywords,
    fieldGuide: parseFieldGuide(readFileSync(path.join(REPO_ROOT, "docs/concepts/swu-card-data-fields.md"), "utf8")),
    priceSources: {
      printings: readJson(path.join(prices, "printings.json"), recs),
      corrections: readJson(path.join(prices, "corrections.json"), recs),
      quarantine: readJson(path.join(prices, "quarantine.json"), recs),
      importRow: [readJson(path.join(prices, "price-import.json"), z.record(z.string(), z.unknown()))],
    },
  };
}

function main(): void {
  const { values } = parseArgs({ options: { originals: { type: "string" }, run: { type: "string" }, out: { type: "string" }, seed: { type: "string" }, date: { type: "string" } } });
  const originalsDir = path.resolve(values.originals ?? newestDatedDir(DEFAULT_ORIGINALS_ROOT, "originals"));
  const date = values.date ?? path.basename(originalsDir);
  const runDir = path.resolve(values.run ?? path.join(REPO_ROOT, "data/runs", date));
  const outDir = path.resolve(values.out ?? path.join(REPO_ROOT, "tmp/verify/packets"));
  const seed = values.seed ?? `verify-${date}`;
  const packets = buildPackets(loadInputs({ originalsDir, runDir }), seed);
  mkdirSync(outDir, { recursive: true });
  const sizes = new Map<string, number>();
  for (const packet of packets) {
    const text = serialize(packet);
    sizes.set(packet.packet, Buffer.byteLength(text));
    writeFileSync(path.join(outDir, `${packet.packet}.json`), text);
  }
  writeFileSync(path.join(outDir, "index.json"), serialize(buildIndex(packets, seed, sizes)));
  for (const packet of packets) console.log(`${packet.packet}: ${packet.itemCount} items, ${sizes.get(packet.packet)} bytes`);
  console.log(`wrote ${packets.length} packets and index.json to ${outDir}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
