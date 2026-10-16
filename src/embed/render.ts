import { z } from "zod";
import { compareCodePoints, sha256Hex } from "../swu/canonical.js";

/**
 * @displayName Embedding renderings
 * @strategicPurpose The text that gets embedded. Each logical card becomes one "ability" string (what the
 * card does) and one "abstract" string (the same with names, traits, keywords, aspects, arenas and numbers
 * replaced by placeholders, so neighbours share mechanics, not surface labels).
 * @tacticalObjective Pure functions of the card list. Ported from scripts/embed/render.py and abstract.py
 * (RENDER_VERSION 1); the rendered strings are hashed and pinned beside the captured vectors.
 */

export const RENDER_VERSION = 1;

const nullableText = z.string().nullable().optional();

export const renderCardSchema = z.looseObject({
  cardKey: z.string().min(1),
  title: z.string(),
  type: z.string(),
  traits: nullableText,
  keywords: nullableText,
  aspects: nullableText,
  text: nullableText,
  deployBox: nullableText,
  epicAction: nullableText,
});
export type RenderCard = z.infer<typeof renderCardSchema>;

export function parseRenderCards(cards: readonly unknown[]): RenderCard[] {
  return cards.map((card) => renderCardSchema.parse(card));
}

const clean = (value: string | null | undefined): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const list = (value: string | null | undefined): string => (typeof value === "string" ? value.split("|").filter((part) => part !== "").join(", ") : "");

const noAbility = (card: RenderCard): string => `${card.type} with no ability text.`;

export function renderAbility(card: RenderCard): string {
  const parts: string[] = [];
  if (card.keywords) parts.push(`Keywords: ${list(card.keywords)}.`);
  if (clean(card.text)) parts.push(clean(card.text));
  if (clean(card.deployBox)) parts.push(`Deploy: ${clean(card.deployBox)}`);
  if (clean(card.epicAction)) parts.push(`Epic Action: ${clean(card.epicAction)}`);
  return parts.length > 0 ? parts.join(" ") : noAbility(card);
}

const WORD = "[\\p{L}\\p{N}_]";
const unique = (values: Iterable<string>): string[] => [...new Set(values)];
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const codePointLength = (value: string): number => [...value].length;

function alternation(words: Iterable<string>): string {
  return unique(words)
    .sort((a, b) => codePointLength(b) - codePointLength(a) || compareCodePoints(a, b))
    .map(escapeRegex)
    .join("|");
}

function cellValues(cards: readonly RenderCard[], field: "traits" | "keywords" | "aspects"): Set<string> {
  return new Set(cards.flatMap((card) => (card[field] ?? "").split("|").filter((part) => part !== "")));
}

const ASPECT_NAMES = ["Command", "Cunning", "Vigilance", "Aggression", "Villainy", "Heroism"];

type Rule = readonly [RegExp, string];

/** Vocabulary the abstract rendering masks, derived from the whole card list. */
export function buildAbstractRules(cards: readonly RenderCard[]): Rule[] {
  const traits = cellValues(cards, "traits");
  const keywords = cellValues(cards, "keywords");
  const aspects = cellValues(cards, "aspects");
  for (const name of ASPECT_NAMES) aspects.add(name);
  const names = new Set(cards.filter((card) => !card.type.includes("Token")).map((card) => card.title));
  for (const leader of cards.filter((card) => card.type === "Leader")) {
    for (const first of [leader.title.split(",")[0].split(" ")[0], leader.title.split(" ")[0]]) if (codePointLength(first) > 3) names.add(first);
  }
  const bounded = (words: Set<string>): string => `(?<!${WORD})(${alternation(words)})(?!${WORD})`;
  return [
    [/\([^)]*\)/gu, ""],
    [new RegExp(`(?<!${WORD})(${alternation(names)})(?:'s)?(?!${WORD})`, "gu"), "NAME"],
    [new RegExp(bounded(traits), "gu"), "TRAIT"],
    [new RegExp(bounded(keywords), "gu"), "KEYWORD"],
    [new RegExp(bounded(aspects), "gu"), "ASPECT"],
    [new RegExp(`(?<!${WORD})(ground|space)(?!${WORD})`, "giu"), "ARENA"],
    [/\p{Nd}+/gu, "N"],
  ];
}

export function renderAbstract(card: RenderCard, rules: readonly Rule[]): string {
  let text = [card.text, card.deployBox, card.epicAction].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  text = text.replace(/(KEYWORD[ ,.]*){2,}/g, "KEYWORD ");
  return clean(text) || noAbility(card);
}

export interface Renderings {
  renderVersion: number;
  keys: string[];
  ability: string[];
  abstract: string[];
}

export function renderAll(cards: readonly RenderCard[]): Renderings {
  const rules = buildAbstractRules(cards);
  return {
    renderVersion: RENDER_VERSION,
    keys: cards.map((card) => card.cardKey),
    ability: cards.map(renderAbility),
    abstract: cards.map((card) => renderAbstract(card, rules)),
  };
}

export const hashTexts = (texts: readonly string[]): string => sha256Hex(texts.join("\n"));

/** One hash over both renderings and the card order; the capture directory name uses its first 12 characters. */
export function inputHashOf(renderings: Renderings): { ability: string; abstract: string; keys: string; inputHash: string } {
  const ability = hashTexts(renderings.ability);
  const abstract = hashTexts(renderings.abstract);
  const keys = sha256Hex(renderings.keys.join("\n"));
  return { ability, abstract, keys, inputHash: sha256Hex(`v${renderings.renderVersion}\nability:${ability}\nabstract:${abstract}\nkeys:${keys}`) };
}
