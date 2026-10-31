/**
 * @displayName cardKey to forceteki id bridge
 * @strategicPurpose swu-mcp keys cards by cardKey; the engine takes SWUDB set codes (SET_NNN) and names cards by its
 * own slug. Battle-testing a deck built from cardKeys, and logging engine choices as cardKeys, both cross this seam
 * (#109), so it is one tested module instead of ad hoc lookups.
 * @tacticalObjective The inverse of `buildSetNumberIndex`: per cardKey, the best-ranked printing whose set code the
 * engine's `_setCodeMap.json` holds, with the `title#subtitle` slug (`engineSlug`) through `_cardMap.json` as the
 * fallback. Translates a decklist id the engine lacks (the 2024 promo J24_005) by card identity, and lists every id
 * it cannot place instead of dropping it. Engine JSON is parsed at the boundary.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { buildSetNumberIndex, engineSlug, loadCardMap, setNumberId, variantRank, type Printing } from "../bench/card-map.js";

export type BridgePrinting = Pick<Printing, "cardKey" | "expansion" | "cardNumber" | "title" | "subtitle" | "type" | "variantTypes">;

export interface EngineCardMaps {
  setCodeMap: Readonly<Record<string, string>>;
  cardMap: readonly { id: string; internalName: string }[];
}

export interface EngineRef {
  setCode: string;
  via: "printing" | "slug";
}

export interface Translation {
  from: string;
  setCode: string;
  via: "direct" | "printing" | "slug";
  cardKey: string | null;
}

export interface CardBridge {
  toEngine(cardKey: string): EngineRef | null;
  translate(setCode: string): Translation | null;
  cardKeyOf(internalName: string): string | null;
  /** The engine card a set code names, or null. */
  engineIdOf(setCode: string): string | null;
  /** internalName to cardKey, a plain object so it crosses a worker boundary. */
  engineCardKeys: Readonly<Record<string, string>>;
}

const engineCardMapSchema = z.array(z.looseObject({ id: z.string().min(1), internalName: z.string().min(1) }));
const engineSetCodeMapSchema = z.record(z.string(), z.string().min(1));

export function loadEngineCardMaps(forcetekiRoot: string): EngineCardMaps {
  const read = (name: string): unknown => JSON.parse(readFileSync(path.join(forcetekiRoot, "test/json", name), "utf8"));
  const cardMap = engineCardMapSchema.parse(read("_cardMap.json")).map((e) => ({ id: e.id, internalName: e.internalName }));
  return { setCodeMap: engineSetCodeMapSchema.parse(read("_setCodeMap.json")), cardMap };
}

const uniqueOrNull = (values: Set<string> | undefined): string | null => (values !== undefined && values.size === 1 ? [...values][0] : null);

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(value);
  map.set(key, set);
}

export function buildCardBridge(printings: readonly BridgePrinting[], engine: EngineCardMaps): CardBridge {
  const setCodes = Object.keys(engine.setCodeMap).sort(compareCodePoints);
  const idByInternal = new Map<string, Set<string>>();
  const internalById = new Map<string, string>();
  for (const e of engine.cardMap) {
    addTo(idByInternal, e.internalName, e.id);
    internalById.set(e.id, e.internalName);
  }
  const setCodesById = new Map<string, string[]>();
  for (const code of setCodes) {
    const id = engine.setCodeMap[code];
    setCodesById.set(id, [...(setCodesById.get(id) ?? []), code]);
  }

  const byCardKey = new Map<string, BridgePrinting[]>();
  const slugKeys = new Map<string, Set<string>>();
  for (const pr of printings) {
    byCardKey.set(pr.cardKey, [...(byCardKey.get(pr.cardKey) ?? []), pr]);
    addTo(slugKeys, engineSlug(pr.title, pr.subtitle), pr.cardKey);
  }
  const setNumber = buildSetNumberIndex(printings.map((pr) => ({ ...pr, serialCode: "", aspectIcons: [] })));

  const toEngine = (cardKey: string): EngineRef | null => {
    const own = (byCardKey.get(cardKey) ?? []).filter((pr) => pr.cardNumber !== null && pr.expansion !== "" && !pr.type.includes("Token"));
    const ranked = own
      .map((pr) => ({ code: setNumberId(pr.expansion, pr.cardNumber as number), rank: variantRank(pr.variantTypes) }))
      .sort((a, b) => a.rank - b.rank || compareCodePoints(a.code, b.code));
    const hit = ranked.find((r) => engine.setCodeMap[r.code] !== undefined);
    if (hit !== undefined) return { setCode: hit.code, via: "printing" };
    const ids = new Set<string>();
    for (const pr of byCardKey.get(cardKey) ?? []) for (const id of idByInternal.get(engineSlug(pr.title, pr.subtitle)) ?? []) ids.add(id);
    const id = uniqueOrNull(ids);
    const code = id === null ? undefined : setCodesById.get(id)?.[0];
    return code === undefined ? null : { setCode: code, via: "slug" };
  };

  const engineKeys = new Map<string, Set<string>>();
  for (const code of setCodes) {
    const internal = internalById.get(engine.setCodeMap[code]);
    const cardKey = setNumber.byId.get(code);
    if (internal !== undefined && cardKey !== undefined) addTo(engineKeys, internal, cardKey);
  }
  const engineCardKeys: Record<string, string> = {};
  for (const internal of [...idByInternal.keys()].sort(compareCodePoints)) {
    const viaCode = uniqueOrNull(engineKeys.get(internal));
    const resolved = viaCode ?? (engineKeys.has(internal) ? null : uniqueOrNull(slugKeys.get(internal)));
    if (resolved !== null) engineCardKeys[internal] = resolved;
  }

  return {
    toEngine,
    translate(setCode) {
      if (engine.setCodeMap[setCode] !== undefined) {
        const internal = internalById.get(engine.setCodeMap[setCode]);
        return { from: setCode, setCode, via: "direct", cardKey: setNumber.byId.get(setCode) ?? (internal === undefined ? null : (engineCardKeys[internal] ?? null)) };
      }
      const cardKey = setNumber.byId.get(setCode);
      const ref = cardKey === undefined ? null : toEngine(cardKey);
      return ref === null ? null : { from: setCode, setCode: ref.setCode, via: ref.via, cardKey: cardKey ?? null };
    },
    cardKeyOf: (internalName) => engineCardKeys[internalName] ?? null,
    engineIdOf: (setCode) => engine.setCodeMap[setCode] ?? null,
    engineCardKeys,
  };
}

export function loadCardBridge(runDir: string, originalsDir: string, forcetekiRoot: string): CardBridge {
  return buildCardBridge(loadCardMap(runDir, originalsDir).printings, loadEngineCardMaps(forcetekiRoot));
}

interface Entry {
  id: string;
  count: number;
}

export interface DeckListLike {
  leader: Entry;
  base: Entry;
  deck: Entry[];
  sideboard?: Entry[];
  [extra: string]: unknown;
}

/**
 * The list with every id the engine lacks replaced by its identity translation. Order and counts are kept, because
 * the engine builds its draw pile in list order before shuffling. Ids nothing can place stay as they are and are
 * listed in `unmapped`; the caller decides, and the engine's own Deck would reject them by name.
 */
export function translateDeck<T extends DeckListLike>(bridge: CardBridge, list: T): { deck: T; translations: Translation[]; unmapped: string[] } {
  const translations: Translation[] = [];
  const unmapped: string[] = [];
  const one = (e: Entry): Entry => {
    const t = bridge.translate(e.id);
    if (t === null) {
      if (!unmapped.includes(e.id)) unmapped.push(e.id);
      return e;
    }
    if (t.via !== "direct") {
      if (!translations.some((x) => x.from === t.from)) translations.push(t);
      return { ...e, id: t.setCode };
    }
    return e;
  };
  const deck = { ...list, leader: one(list.leader), base: one(list.base), deck: list.deck.map(one), ...(list.sideboard === undefined ? {} : { sideboard: list.sideboard.map(one) }) };
  return { deck, translations, unmapped };
}

export interface DeckCoverage {
  dir: string;
  files: number;
  slots: number;
  directSlots: number;
  translatedIds: Record<string, { setCode: string; via: Translation["via"]; cardKey: string | null; slots: number; files: number }>;
  filesWithTranslation: string[];
  unmappedAfterTranslation: { id: string; slots: number; files: string[] }[];
  /** cardKey to engine direction: every cardKey the lists name, sent through toEngine, must reach the engine card its own set code names. */
  roundTrip: { cardKeys: number; viaSlug: string[]; mismatches: { cardKey: string; listed: string; toEngine: string | null }[] };
}

const deckFileSchema = z.looseObject({
  leader: z.looseObject({ id: z.string(), count: z.number() }),
  base: z.looseObject({ id: z.string(), count: z.number() }),
  deck: z.array(z.looseObject({ id: z.string(), count: z.number() })),
  sideboard: z.array(z.looseObject({ id: z.string(), count: z.number() })).optional(),
});

/** Every card slot (leader, base, deck, sideboard) of every deck file in `dir`, counted by how it reaches the engine. */
export function deckCoverage(bridge: CardBridge, dir: string): DeckCoverage {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "manifest.json" && f !== "rejects.json")
    .sort(compareCodePoints);
  const report: DeckCoverage = { dir, files: names.length, slots: 0, directSlots: 0, translatedIds: {}, filesWithTranslation: [], unmappedAfterTranslation: [], roundTrip: { cardKeys: 0, viaSlug: [], mismatches: [] } };
  const roundTrip = new Map<string, string>();
  const unmapped = new Map<string, { slots: number; files: Set<string> }>();
  for (const name of names) {
    const deck = deckFileSchema.parse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
    const entries = [deck.leader, deck.base, ...deck.deck, ...(deck.sideboard ?? [])];
    const seen = new Set<string>();
    for (const e of entries) {
      report.slots += 1;
      const t = bridge.translate(e.id);
      if (t === null) {
        const u = unmapped.get(e.id) ?? { slots: 0, files: new Set<string>() };
        u.slots += 1;
        u.files.add(name);
        unmapped.set(e.id, u);
      } else if (t.via === "direct") {
        report.directSlots += 1;
        if (t.cardKey !== null && !roundTrip.has(t.cardKey)) roundTrip.set(t.cardKey, e.id);
      }
      else {
        const row = report.translatedIds[e.id] ?? { setCode: t.setCode, via: t.via, cardKey: t.cardKey, slots: 0, files: 0 };
        row.slots += 1;
        if (!seen.has(e.id)) row.files += 1;
        seen.add(e.id);
        report.translatedIds[e.id] = row;
      }
    }
    if (seen.size > 0) report.filesWithTranslation.push(name);
  }
  for (const cardKey of [...roundTrip.keys()].sort(compareCodePoints)) {
    const listed = roundTrip.get(cardKey) as string;
    const ref = bridge.toEngine(cardKey);
    report.roundTrip.cardKeys += 1;
    if (ref?.via === "slug") report.roundTrip.viaSlug.push(cardKey);
    if (ref === null || bridge.engineIdOf(ref.setCode) !== bridge.engineIdOf(listed)) report.roundTrip.mismatches.push({ cardKey, listed, toEngine: ref?.setCode ?? null });
  }
  report.unmappedAfterTranslation = [...unmapped.keys()].sort(compareCodePoints).map((id) => {
    const u = unmapped.get(id) as { slots: number; files: Set<string> };
    return { id, slots: u.slots, files: [...u.files].sort(compareCodePoints) };
  });
  return report;
}
