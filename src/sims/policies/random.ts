import { emptyStats, type BotPolicy, type GameView, type LegalAnswer } from "./types.js";

/**
 * @displayName Rung 0 random bot
 * @strategicPurpose The null policy every rung is measured against, and the fallback a rung descends to on a prompt it has no rule for.
 * @tacticalObjective Picks uniformly among the legal answers from the view's decision randomness; on a multi-select
 * prompt it takes Done half the time, as the typed driver's rung0 does (src/sims/policy.ts).
 */

export function randomIndex(answers: readonly LegalAnswer[], view: GameView): number {
  const done = answers.findIndex((a) => a.kind === "button" && /^(done|continue)$/i.test(a.label));
  if (view.prompt.multiple && done >= 0 && view.rnd() < 0.5) return done;
  return Math.floor(view.rnd() * answers.length);
}

export function makeRandomPolicy(): BotPolicy {
  const stats = emptyStats();
  return {
    id: "rung0-random",
    version: "1",
    rung: 0,
    params: {},
    stats,
    choose: (answers, view) => {
      stats.decisions++;
      stats.rule++;
      return randomIndex(answers, view);
    },
    tryChoose: (answers, view) => {
      stats.decisions++;
      stats.rule++;
      return randomIndex(answers, view);
    },
  };
}
