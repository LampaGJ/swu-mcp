import { seededRandom } from "../../scripts/bench/stats.js";
import type { SleeperDeck } from "../../src/meta/sleepers.js";

export interface Plant {
  /** Win-probability boost for every deck holding the card. */
  boost?: number;
  /** Extra boost scaled by the player's true skill (skill in -1..1). */
  skillBoost?: number;
  /** Probability a deck includes the card; skillPick raises it with skill (selection). */
  rate: number;
  skillPick?: number;
}

/** Synthetic tournament: events of decks, two leaders, players who return across events with a fixed true skill. */
export function fixture(
  plants: Record<string, Plant>,
  seed = "fixture",
  eventsN = 60,
  perEvent = 40,
  playersN = 400,
  leaders: readonly string[] = ["L1", "L2"],
): SleeperDeck[] {
  const random = seededRandom(seed);
  const trueSkill = Array.from({ length: playersN }, () => random() * 2 - 1);
  const decks: SleeperDeck[] = [];
  for (let e = 0; e < eventsN; e++) {
    for (let k = 0; k < perEvent; k++) {
      const player = Math.floor(random() * playersN);
      const s = trueSkill[player];
      const leader = leaders[Math.min(leaders.length - 1, Math.floor(random() * leaders.length))];
      const cards: string[] = [];
      let p = 0.5 + 0.08 * s;
      for (const [card, plant] of Object.entries(plants)) {
        if (random() < Math.min(0.95, plant.rate + (plant.skillPick ?? 0) * s)) {
          cards.push(card);
          p += (plant.boost ?? 0) + (plant.skillBoost ?? 0) * s;
        }
      }
      let wins = 0;
      let losses = 0;
      for (let m = 0; m < 6; m++) {
        if (random() < Math.min(0.95, Math.max(0.05, p))) wins += 1;
        else losses += 1;
      }
      decks.push({
        event: `e${e}`,
        period: e < eventsN / 2 ? "P1" : "P2",
        leader,
        baseAspects: ["Vigilance"],
        aspects: ["Command", "Vigilance"],
        player: `p${player}`,
        wins,
        losses,
        draws: 0,
        cards,
        style: null,
      });
    }
  }
  return decks;
}
