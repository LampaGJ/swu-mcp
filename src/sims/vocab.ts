/**
 * @displayName Evaluator card vocabulary
 * @strategicPurpose A trained evaluator addresses cards and keywords by integer index. A pinned, append-only
 * vocabulary per data release keeps those indices stable, so a new release adds cards without permuting what a
 * model learned.
 * @tacticalObjective Builds the vocabulary from the card store and the engine's keyword list (the parent version's
 * keys and keywords first, new ones appended in code-point order, tokens aliased to one key per (type, title)),
 * hashes its content, verifies that hash on load and resolves cardKeys and keywords to indices.
 */
import { z } from "zod";
import { hex64 } from "../schemas/hash.js";
import { canonicalJson, compareCodePoints, sha256Hex } from "../swu/canonical.js";

export const RESERVED = { pad: 0, unknown: 1, hidden: 2 } as const;
export const FIRST_CARD_INDEX = 3;
export const ALIAS_RULE =
  "token cards sharing (type, title) resolve to the first such key by code point in the earliest vocabulary that holds the group; every child version inherits the target unchanged; alias sources take no keys slot";
export const KEYWORD_SOURCE = "server/game/core/Constants.ts KeywordName";
/** Extra keys: the #109 bridge's printing keys for engine cards, so cards outside the data release keep their identity. */
export const BRIDGE_KEY_SOURCE = "scripts/sims/card-bridge.ts engineCardKeys";

const cardKey = z.string().min(1);

const vocabShape = {
  schemaVersion: z.literal(1),
  dataVersion: z.string().min(1),
  buildHash: hex64,
  cardsToonSha256: hex64,
  engine: z.strictObject({ commit: z.string().min(7), keywordSource: z.literal(KEYWORD_SOURCE) }),
  reserved: z.strictObject({ pad: z.literal(0), unknown: z.literal(1), hidden: z.literal(2) }),
  keys: z.array(cardKey),
  aliases: z.record(cardKey, cardKey),
  aliasRule: z.literal(ALIAS_RULE),
  keywords: z.array(z.string().min(1)).max(30),
  parent: z.strictObject({ dataVersion: z.string().min(1), contentSha256: hex64 }).nullable(),
  /** Absent means 1. A revision above 1 extends a vocabulary of the same data release; a new release restarts at 1. */
  revision: z.int().min(2).optional(),
  extraKeySource: z.literal(BRIDGE_KEY_SOURCE).optional(),
};

export const vocabSchema = z.strictObject({ ...vocabShape, contentSha256: hex64 }).superRefine((v, ctx) => {
  const keys = new Set(v.keys);
  if (keys.size !== v.keys.length) ctx.addIssue({ code: "custom", message: "keys holds duplicates", path: ["keys"] });
  if (new Set(v.keywords).size !== v.keywords.length)
    ctx.addIssue({ code: "custom", message: "keywords holds duplicates", path: ["keywords"] });
  for (const [source, target] of Object.entries(v.aliases)) {
    if (keys.has(source))
      ctx.addIssue({ code: "custom", message: `alias source ${source} also holds a keys slot`, path: ["aliases", source] });
    if (!keys.has(target)) ctx.addIssue({ code: "custom", message: `alias target ${target} is not in keys`, path: ["aliases", source] });
  }
});

export type Vocab = z.infer<typeof vocabSchema>;
export type VocabBody = Omit<Vocab, "contentSha256">;

export function vocabContentHash(body: VocabBody): string {
  return sha256Hex(canonicalJson(body));
}

/** Parses and verifies the content hash; an edited body without a recomputed hash is refused. */
export function parseVocab(raw: unknown): Vocab {
  const vocab = vocabSchema.parse(raw);
  const { contentSha256, ...body } = vocab;
  const actual = vocabContentHash(body);
  if (actual !== contentSha256) throw new Error(`vocabulary contentSha256 ${contentSha256} does not match its content (${actual})`);
  return vocab;
}

/** Refuses a child whose keys, keywords or aliases do not extend the parent's unchanged. */
export function assertChildOf(child: Vocab, parent: Vocab): void {
  if (child.parent === null || child.parent.dataVersion !== parent.dataVersion || child.parent.contentSha256 !== parent.contentSha256) {
    throw new Error(`vocabulary ${child.dataVersion} does not name ${parent.dataVersion} (${parent.contentSha256}) as its parent`);
  }
  parent.keys.forEach((key, i) => {
    if (child.keys[i] !== key) throw new Error(`vocabulary ${child.dataVersion} changes parent key ${i}: ${key} -> ${child.keys[i]}`);
  });
  parent.keywords.forEach((keyword, i) => {
    if (child.keywords[i] !== keyword)
      throw new Error(`vocabulary ${child.dataVersion} changes parent keyword ${i}: ${keyword} -> ${child.keywords[i]}`);
  });
  for (const [source, target] of Object.entries(parent.aliases)) {
    if (child.aliases[source] !== target) throw new Error(`vocabulary ${child.dataVersion} changes alias ${source} -> ${target}`);
  }
}

export interface VocabCard {
  cardKey: string;
  type: string;
  title: string;
}

export interface BuildVocabInput {
  dataVersion: string;
  buildHash: string;
  cardsToonSha256: string;
  engineCommit: string;
  cards: readonly VocabCard[];
  engineKeywords: readonly string[];
  parent: Vocab | null;
  revision?: number;
  /** Keys beyond the card store (BRIDGE_KEY_SOURCE), appended with the store's new keys in code-point order. */
  extraKeys?: readonly string[];
}

export const vocabRevision = (v: Pick<Vocab, "revision">): number => v.revision ?? 1;

/** <dataVersion>.json for revision 1, <dataVersion>.v<revision>.json above it: a revision never takes a data release's name. */
export const vocabFileName = (v: Pick<Vocab, "dataVersion" | "revision">): string =>
  vocabRevision(v) === 1 ? `${v.dataVersion}.json` : `${v.dataVersion}.v${vocabRevision(v)}.json`;

export function buildVocab(input: BuildVocabInput): Vocab {
  const parent = input.parent;
  const revision = input.revision ?? 1;
  if (revision > 1 && parent?.dataVersion !== input.dataVersion)
    throw new Error(`revision ${revision} must extend a vocabulary of the same data release ${input.dataVersion}`);
  if (parent !== null && parent.dataVersion === input.dataVersion && revision <= vocabRevision(parent))
    throw new Error(`revision ${revision} of ${input.dataVersion} must exceed its parent's revision ${vocabRevision(parent)}`);
  const parentKeys = new Set(parent?.keys ?? []);
  const aliases: Record<string, string> = { ...(parent?.aliases ?? {}) };

  const groups = new Map<string, string[]>();
  for (const card of input.cards) {
    if (!card.type.includes("Token")) continue;
    const group = [card.type, card.title].join(String.fromCharCode(0));
    groups.set(group, [...(groups.get(group) ?? []), card.cardKey]);
  }
  for (const members of groups.values()) {
    const sorted = [...members].sort(compareCodePoints);
    const inherited = sorted.map((key) => aliases[key] ?? (parentKeys.has(key) ? key : undefined)).find((key) => key !== undefined);
    const target = inherited ?? sorted[0];
    for (const key of sorted) {
      if (key !== target && !parentKeys.has(key) && aliases[key] === undefined) aliases[key] = target;
    }
  }

  const fresh = [...input.cards.map((card) => card.cardKey), ...(input.extraKeys ?? [])]
    .filter((key) => !parentKeys.has(key) && aliases[key] === undefined)
    .sort(compareCodePoints);
  const keys = [...(parent?.keys ?? []), ...new Set(fresh)];
  const parentKeywords = parent?.keywords ?? [];
  const keywords = [
    ...parentKeywords,
    ...[...new Set(input.engineKeywords)].filter((k) => !parentKeywords.includes(k)).sort(compareCodePoints),
  ];

  const body: VocabBody = {
    schemaVersion: 1,
    dataVersion: input.dataVersion,
    buildHash: input.buildHash,
    cardsToonSha256: input.cardsToonSha256,
    engine: { commit: input.engineCommit, keywordSource: KEYWORD_SOURCE },
    reserved: { ...RESERVED },
    keys,
    aliases: Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => compareCodePoints(a, b))),
    aliasRule: ALIAS_RULE,
    keywords,
    parent: parent === null ? null : { dataVersion: parent.dataVersion, contentSha256: parent.contentSha256 },
    ...(revision > 1 ? { revision } : {}),
    ...((input.extraKeys?.length ?? 0) > 0 || parent?.extraKeySource !== undefined ? { extraKeySource: BRIDGE_KEY_SOURCE } : {}),
  };
  return vocabSchema.parse({ ...body, contentSha256: vocabContentHash(body) });
}

export interface CompiledVocab {
  sha256: string;
  index: ReadonlyMap<string, number>;
  /** Bit position per keyword; bit 0 is reserved for keywords the vocabulary does not list. */
  keywordBit: ReadonlyMap<string, number>;
}

export function compileVocab(vocab: Vocab): CompiledVocab {
  const index = new Map(vocab.keys.map((key, i) => [key, i + FIRST_CARD_INDEX]));
  for (const [source, target] of Object.entries(vocab.aliases)) index.set(source, index.get(target) as number);
  return { sha256: vocab.contentSha256, index, keywordBit: new Map(vocab.keywords.map((keyword, i) => [keyword, i + 1])) };
}
