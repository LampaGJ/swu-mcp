import { z } from "zod";
import type { CardStore } from "../data.js";
import { ATTACK_PATTERNS_FILE, loadAttackPatterns, METHODS, type AttackerRow } from "../play/attack-patterns.js";
import type { ToolResult } from "../tools.js";
import { fail, ok } from "./common.js";

/**
 * @displayName attack_patterns tool
 * @strategicPurpose Shows how cards are used to attack in observed play, people and our bots side by side, so an
 * assistant can say which cards attack most, what they go after and how the fights end (#181, D104).
 * @tacticalObjective Reads only the built data/attack-patterns.json (never the decisions it was built from), filters
 * by method and card, adds card titles from the store, and keeps every population's method, tier and counts of
 * unrecognised attacks beside its rows. Populations are never pooled (D21).
 */

export const attackPatternsShape = {
  method: z.enum([...METHODS, "both"]).default("both").describe("human play, computer play, or both side by side (default)"),
  cardKey: z.string().min(1).optional().describe("Only this attacking card"),
  limit: z.number().int().min(1).max(30).default(10).describe("Top attackers per population (at most 30)"),
};
const inputSchema = z.object(attackPatternsShape);

export function attackPatterns(store: CardStore, input: unknown, file = ATTACK_PATTERNS_FILE): ToolResult {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return fail(z.prettifyError(parsed.error));
  const { method, cardKey, limit } = parsed.data;
  const product = loadAttackPatterns(file);
  if (product === null) return fail("attack_patterns: no attack-patterns data product is built in this install");
  const byKey = new Map(store.cards.map((c) => [c.cardKey, c]));
  const name = (k: string, printed?: string): string => {
    const c = byKey.get(k);
    return c === undefined ? (printed ?? k) : c.subtitle ? c.title + ", " + String(c.subtitle) : c.title;
  };
  const view = (a: AttackerRow) => ({
    card: name(a.cardKey, a.title),
    cardKey: a.cardKey,
    attacks: a.attacks,
    games: a.games,
    gameShare: a.gameShare,
    attacksPerGame: a.attacksPerGame,
    targets: { ...a.targets, top: a.topTargets.map((t) => ({ card: name(t.cardKey, t.title), cardKey: t.cardKey, attacks: t.attacks, share: t.share })) },
    results: a.results,
    sideResult: a.sideResult,
  });
  const populations = product.populations
    .filter((p) => method === "both" || p.method === method)
    .map((p) => {
      const rows = cardKey === undefined ? p.attackers.slice(0, limit) : p.attackers.filter((a) => a.cardKey === cardKey);
      return {
        method: p.method,
        tier: p.tier,
        label: p.label,
        window: p.window,
        games: p.games,
        attacks: p.attacks,
        unresolvedAttackers: p.unresolvedAttackers,
        unresolvedTargets: p.unresolvedTargets,
        measuredAttacks: p.measuredAttacks,
        notes: p.notes,
        attackers: rows.map(view),
        ...(cardKey !== undefined && rows.length === 0 ? { missing: name(cardKey, rows[0]?.title) + " is not among this population's top " + String(p.attackers.length) + " attackers" } : {}),
      };
    });
  return ok({
    status: "fact",
    basis: "observed attacks, counted per attacking card; results read from the board before and after each attack; win share counts each side once by its game result, with a Wilson 95% interval",
    populations,
  });
}

export const PLAY_TOOLS = {
  attack_patterns: {
    title: "Attack patterns",
    description:
      "Which cards attack most, what they attack (the opponent's base or units, and the most-attacked units) and what happens (defender destroyed, attacker destroyed, both, neither, average damage to the defender and to the base), with the attacking side's game result once per side and a Wilson 95% interval. Human play (casual online games between people) and computer play (our simulator's bots) are listed side by side, each labelled by method and tier and never pooled; each names its games, attacks and the attacks whose card was not recognised. method narrows to one population, cardKey to one attacking card, limit sets the top attackers per population (default 10, at most 30).",
    shape: attackPatternsShape,
    handler: (store: CardStore, input: unknown): ToolResult => attackPatterns(store, input),
  },
} as const;
