import { seededRandom } from "../../scripts/bench/stats.js";

/**
 * @displayName Counter-based bot randomness (sha256-counter-v1)
 * @strategicPurpose A branch at decision k must leave every decision before k byte-identical, and a changed policy
 * must not shift the engine's draws (#110). One shared bot stream fails both: each seat's choices move the other's.
 * @tacticalObjective Draw j at decision k for seat s is seededRandom("bot|" + seed + "|" + s + "|" + k + "|" + j)(),
 * the repo's sha256-to-mulberry32 helper. Stateless, so replay and branching need only the header seed and k.
 */

export const BOT_SCHEME = "sha256-counter-v1";

export type Seat = 1 | 2;

export const botDraw = (seed: string, seat: Seat, k: number, j: number): number => seededRandom(`bot|${seed}|${seat}|${k}|${j}`)();

/** The draws of one decision; `draws` feeds the record's rngCursor.botDraws. */
export class DecisionRandom {
  draws = 0;

  constructor(
    readonly seed: string,
    readonly seat: Seat,
    readonly k: number,
  ) {}

  next = (): number => botDraw(this.seed, this.seat, this.k, this.draws++);
}
