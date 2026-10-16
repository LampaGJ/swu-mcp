/**
 * Code-unit comparator for cardKeys, tags and labels. For BMP-only text it orders exactly like
 * compareCodePoints (src/swu/canonical.ts) without the per-call Array.from, which matters in the
 * trio search where sorts run millions of comparisons. Strings that may hold astral characters
 * (card titles) go through compareCodePoints instead.
 */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export const cardLabel = (c: { title: string; subtitle: string | null }): string => (c.subtitle ? `${c.title}, ${c.subtitle}` : c.title);
