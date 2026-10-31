import { hasDecision } from "./actions.js";
import type { EngineGame, EnginePlayer } from "./engine.js";
import type { Seat } from "./rng.js";

/**
 * @displayName Shared search-leaf check
 * @strategicPurpose The branch sampler (#125) and the rung-3 search (#128) must agree on where a trial stops, or one
 * overshoots by a decision the other counts (#141).
 * @tacticalObjective A leaf is a finished game or a moment where some seat must decide; a prompt where both seats
 * only wait is not a leaf, because the engine still has work to do before anyone chooses.
 */

/** Seats that must decide now, seat 1 first. */
export function decidingSeats(players: readonly [EnginePlayer, EnginePlayer]): Seat[] {
  const out: Seat[] = [];
  if (hasDecision(players[0])) out.push(1);
  if (hasDecision(players[1])) out.push(2);
  return out;
}

export function searchLeaf(game: EngineGame, players: readonly [EnginePlayer, EnginePlayer] = [game.getPlayerById("player1"), game.getPlayerById("player2")]): boolean {
  return game.isEnded || decidingSeats(players).length > 0;
}
