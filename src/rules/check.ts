import { z } from "zod";
import { compareCodePoints } from "../swu/canonical.js";

/**
 * @displayName Rules version check
 * @strategicPurpose Tells the maintainer whether the pinned Comprehensive Rules (CR) are still the newest
 * official ones, because the CDN filename carries a hash and no stable "latest" URL exists.
 * @tacticalObjective Pure comparison of the pinned replay record against what the CDN, the official pages
 * and the articles API report. The network reads live in scripts/rules-check.ts, so this logic is testable.
 */

export const EXIT_CURRENT = 0;
export const EXIT_NEWER = 10;
export const EXIT_ERROR = 2;

export const pinnedRulesSchema = z.object({
  rulesVersion: z.string(),
  source: z.object({ fetchedAt: z.iso.date(), pdfSha256: z.string(), pdfBytes: z.number().int() }),
});

export interface Pinned {
  rulesVersion: string;
  fetchedAt: string;
  pdfSha256: string;
  pdfBytes: number;
  url: string;
  fileName: string;
}

export interface Article {
  title: string;
  slug?: string;
  publishOn: string | null;
  updatedAt: string | null;
}

export interface Observed {
  pdfHead: { status: number; contentLength: number | null; lastModified: string | null };
  /** CR filenames found on official pages, for example SWH_Comp_Rules_v8_0_e26603c6e1.pdf. */
  listedFileNames: string[];
  /** Articles whose title mentions "rules", newest first. */
  rulesArticles: Article[];
  newestArticle: Article | null;
  /** Set only when the PDF was downloaded (--verify-hash). */
  downloadedSha256?: string;
}

export const CR_FILE_NAME = /SWH_Comp_Rules_[A-Za-z0-9_]+\.pdf/g;

/** "SWH_Comp_Rules_v8_0_e26603c6e1.pdf" -> "8.0"; null when the name carries no version. */
export function versionOfFileName(fileName: string): string | null {
  const match = /_v(\d+)_(\d+)_/.exec(fileName);
  return match === null ? null : `${match[1]}.${match[2]}`;
}

export function articleStamp(article: Article): string | null {
  const stamps = [article.publishOn, article.updatedAt].filter((value): value is string => value !== null);
  return stamps.sort(compareCodePoints).at(-1) ?? null;
}

export interface Verdict {
  status: "current" | "newer-available";
  reasons: string[];
}

/** A rules article counts as newer when its newest stamp falls on a date after the day the CR was pinned. */
export function evaluate(pinned: Pinned, observed: Observed): Verdict {
  const reasons: string[] = [];
  const { pdfHead } = observed;
  if (pdfHead.status !== 200) reasons.push(`pinned URL answers HTTP ${pdfHead.status}, so the CR may have moved`);
  else if (pdfHead.contentLength !== null && pdfHead.contentLength !== pinned.pdfBytes) {
    reasons.push(`pinned URL serves ${pdfHead.contentLength} bytes, the pinned PDF has ${pinned.pdfBytes}`);
  }
  if (observed.downloadedSha256 !== undefined && observed.downloadedSha256 !== pinned.pdfSha256) {
    reasons.push(`downloaded sha256 ${observed.downloadedSha256} differs from pinned ${pinned.pdfSha256}`);
  }
  for (const name of [...new Set(observed.listedFileNames)].sort(compareCodePoints)) {
    if (name === pinned.fileName) continue;
    const version = versionOfFileName(name);
    reasons.push(version !== null && version !== pinned.rulesVersion ? `official page lists CR ${name} (version ${version}, pinned ${pinned.rulesVersion})` : `official page lists CR file ${name}, pinned ${pinned.fileName}`);
  }
  for (const article of observed.rulesArticles) {
    const stamp = articleStamp(article);
    if (stamp !== null && stamp.slice(0, 10) > pinned.fetchedAt) reasons.push(`rules article "${article.title}" is dated ${stamp}, after the pin date ${pinned.fetchedAt}`);
  }
  return { status: reasons.length === 0 ? "current" : "newer-available", reasons };
}
