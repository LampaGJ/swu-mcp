/**
 * @displayName Real-play card identity map
 * @strategicPurpose Human games, decklists and engine simulations name cards three different ways
 * (set+number, "Title, Subtitle", engine slug); every benchmark needs them folded onto the run's logical cardKey.
 * @tacticalObjective Builds set_number -> cardKey from the raw printings with the same printing grouping the
 * package uses, a normalised name index over every printing, and per-card release/aspect facts from the run.
 */
import path from "node:path";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { printingCardKeys, type FlatRow } from "../../src/swu/llm-flatten.js";
import { loadRawPrintings, packageRawManifestSha256 } from "../lib/raw-pages.js";

export const DEFAULT_ORIGINALS_ROOT = "/Volumes/Local Files/Projects/mault/data/swu-originals";

/** Weekly Play and promo printings reuse a main set's code with their own numbering, so the main-set numbering wins. */
const VARIANT_RANK = [
  "Standard",
  "Standard Foil",
  "Hyperspace",
  "Hyperspace Foil",
  "Showcase",
  "Standard Prestige",
  "Foil Prestige",
  "Serialized Prestige",
];

export interface Printing {
  serialCode: string;
  cardKey: string;
  expansion: string;
  cardNumber: number | null;
  title: string;
  subtitle: string | null;
  type: string;
  variantTypes: string[];
  /** Aspect icons with duplicates, e.g. ["Command", "Command"]. */
  aspectIcons: string[];
}

export function setNumberId(expansion: string, cardNumber: number): string {
  return `${expansion}_${String(cardNumber).padStart(3, "0")}`;
}

/** Lowercase, accents and punctuation variants folded, "Title | Subtitle" and "Title, Subtitle" made equal. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*\|\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function displayName(title: string, subtitle: string | null): string {
  return subtitle !== null && subtitle !== "" ? `${title}, ${subtitle}` : title;
}

const variantRank = (types: readonly string[]): number => {
  const ranks = types.map((t) => VARIANT_RANK.indexOf(t)).filter((r) => r >= 0);
  return ranks.length === 0 ? VARIANT_RANK.length : Math.min(...ranks);
};

export interface SetNumberIndex {
  byId: Map<string, string>;
  ambiguous: string[];
}

/** SET_NNN -> cardKey from the best-ranked printings carrying that number; ids whose best rank names two cards are ambiguous. */
export function buildSetNumberIndex(printings: readonly Printing[]): SetNumberIndex {
  const candidates = new Map<string, { rank: number; keys: Set<string> }>();
  for (const p of printings) {
    if (p.cardNumber === null || p.expansion === "" || p.type.includes("Token")) continue;
    const id = setNumberId(p.expansion, p.cardNumber);
    const rank = variantRank(p.variantTypes);
    const current = candidates.get(id);
    if (current === undefined || rank < current.rank) candidates.set(id, { rank, keys: new Set([p.cardKey]) });
    else if (rank === current.rank) current.keys.add(p.cardKey);
  }
  const byId = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const id of [...candidates.keys()].sort(compareCodePoints)) {
    const keys = [...(candidates.get(id) as { keys: Set<string> }).keys];
    if (keys.length === 1) byId.set(id, keys[0]);
    else ambiguous.push(id);
  }
  return { byId, ambiguous };
}

/** Normalised display name -> the cardKeys carrying it (one per logical card), optionally per card type. */
export function buildNameIndex(printings: readonly Printing[]): Map<string, string[]> {
  const index = new Map<string, Set<string>>();
  const add = (key: string, cardKey: string): void => {
    const set = index.get(key) ?? new Set<string>();
    set.add(cardKey);
    index.set(key, set);
  };
  for (const p of printings) {
    if (p.type.includes("Token")) continue;
    add(normalizeName(displayName(p.title, p.subtitle)), p.cardKey);
    add(`${p.type.toLowerCase()}::${normalizeName(p.title)}`, p.cardKey);
    add(`title::${normalizeName(p.title)}`, p.cardKey);
  }
  return new Map([...index].map(([k, v]) => [k, [...v].sort(compareCodePoints)]));
}

/** Engine slug of a title/subtitle as forceteki writes card ids: punctuation dropped ("4-LOM" -> "4lom"), spaces to "-". */
export function engineSlug(title: string, subtitle: string | null): string {
  const slug = (s: string): string =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "-");
  return subtitle !== null && subtitle !== "" ? `${slug(title)}#${slug(subtitle)}` : slug(title);
}

export interface CardMap {
  printings: Printing[];
  setNumber: SetNumberIndex;
  names: Map<string, string[]>;
  rawManifestSha256: string;
}

const str = (row: FlatRow, key: string): string => (typeof row[key] === "string" ? (row[key] as string) : "");

/** Reads the raw pages the run was built from (refusing a different manifest) and builds every index. */
export function loadCardMap(runDir: string, originalsDir: string): CardMap {
  const { printings: rows, rawManifestSha256 } = loadRawPrintings(
    path.join(originalsDir, "swu-cards/raw-pages"),
    packageRawManifestSha256(path.join(runDir, "replay.json")),
  );
  const keyOf = printingCardKeys(rows);
  const printings: Printing[] = rows.map((row) => ({
    serialCode: str(row, "serialCode"),
    cardKey: keyOf.get(str(row, "serialCode")) as string,
    expansion: str(row, "expansion"),
    cardNumber: typeof row.cardNumber === "number" ? row.cardNumber : null,
    title: str(row, "title"),
    subtitle: str(row, "subtitle") === "" ? null : str(row, "subtitle"),
    type: str(row, "type"),
    variantTypes: str(row, "variantTypes") === "" ? [] : str(row, "variantTypes").split("|"),
    aspectIcons: [str(row, "aspects"), str(row, "aspectDuplicates")].flatMap((v) => (v === "" ? [] : v.split("|"))).sort(compareCodePoints),
  }));
  return { printings, setNumber: buildSetNumberIndex(printings), names: buildNameIndex(printings), rawManifestSha256 };
}
