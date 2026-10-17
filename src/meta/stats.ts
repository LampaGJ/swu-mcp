/**
 * @displayName Win-rate interval
 * @strategicPurpose Every shipped win rate carries an honest 95% interval, so a 7-5 record is not read as a 58% fact.
 * @tacticalObjective Wilson score interval for wins out of n decisive matches (draws left out, as swumetastats does), rounded to 4 places.
 */

const Z95 = 1.959964;
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4 || 0;

export function wilson(wins: number, n: number, z = Z95): { low: number; high: number } | null {
  if (n <= 0) return null;
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: r4(Math.max(0, centre - half)), high: r4(Math.min(1, centre + half)) };
}
