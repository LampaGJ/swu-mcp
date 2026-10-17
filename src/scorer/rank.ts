/**
 * @displayName At-or-below count
 * @strategicPurpose One definition of "how many values rank at or below this one" for the scores
 * file percentiles and the value-gap tools, so the two cannot drift on tie handling.
 * @tacticalObjective Upper-bound binary search over an ascending array; callers keep their own arithmetic.
 */

/** Count of entries in `sorted` (ascending) that are less than or equal to `v`. */
export function countAtOrBelow(sorted: readonly number[], v: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= v) low = mid + 1;
    else high = mid;
  }
  return low;
}
