import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { readJson } from "../data.js";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Premier format gate
 * @strategicPurpose Owner ruling 2026-10-17: Eternal and every other non-Premier deck is excluded from deck extracts
 * and the meta step. The snapshot query asks for Premier, but the gate is enforced on each file, not trusted to the query.
 * @tacticalObjective A deck is kept only when metadata.format is "premier" (any case). A deck with no format is kept
 * only when the snapshot's manifest.json declares `format: "Premier"` for the whole snapshot; every other deck is
 * rejected with reason "format:<value>" ("format:missing" when absent) so extracts can count the exclusions.
 */

export const PREMIER = "premier";

export type FormatVerdict = { keep: true } | { keep: false; reason: string };

const isPremier = (value: unknown): boolean => typeof value === "string" && value.trim().toLowerCase() === PREMIER;

const formatOf = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const meta = (raw as { metadata?: unknown }).metadata;
  return typeof meta === "object" && meta !== null ? (meta as { format?: unknown }).format : undefined;
};

export function premierVerdict(rawDeck: unknown, snapshotIsPremier: boolean): FormatVerdict {
  const format = formatOf(rawDeck);
  if (format === undefined || format === null || format === "") {
    return snapshotIsPremier ? { keep: true } : { keep: false, reason: "format:missing" };
  }
  return isPremier(format) ? { keep: true } : { keep: false, reason: `format:${typeof format === "string" ? format : JSON.stringify(format)}` };
}

const manifestFormatSchema = z.looseObject({ format: z.string().optional() });

/** True when <dir>/manifest.json declares the whole snapshot Premier. */
export function snapshotDeclaresPremier(dir: string): boolean {
  const file = path.join(dir, "manifest.json");
  if (!existsSync(file)) return false;
  const parsed = manifestFormatSchema.safeParse(readJson(file));
  return parsed.success && isPremier(parsed.data.format);
}

/** Running tally of rejections by reason, emitted sorted so extracts stay byte-identical. */
export class FormatRejects {
  private readonly counts = new Map<string, number>();
  add(reason: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }
  get total(): number {
    let n = 0;
    for (const v of this.counts.values()) n += v;
    return n;
  }
  toJSON(): Record<string, number> {
    return Object.fromEntries([...this.counts].sort((a, b) => compareCodePoints(a[0], b[0])));
  }
}
