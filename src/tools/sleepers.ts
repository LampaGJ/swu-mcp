import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageDirOf, readJson, type CardStore } from "../data.js";
import { sleepersFileSchema, type SleeperRow, type SleepersFile, type SleeperScope } from "../meta/sleepers-schema.js";
import { compareCodePoints } from "../swu/canonical.js";
import { CANDIDATE_STATUS } from "../synergy/evidence.js";
import { cardLabel } from "../synergy/order.js";
import type { ToolResult } from "../tools.js";
import { fail, ok } from "./common.js";
import { baseField, leaderField, resolveRef } from "./deck.js";

/**
 * @displayName Sleeper cards tool
 * @strategicPurpose Serves the sleeper-card analysis (LampaGJ/swu-mcp#184, owner 2026-11-01: "the analyses should be
 * built into our mcp capabilities"): cards that win more than their play rate suggests, and cards whose edge grows
 * with the player's skill, for the whole field, one aspect set, or one leader and base.
 * @tacticalObjective Reads <package>/sleepers/sleepers.json (written by `pnpm meta:sleepers`, parsed strictly), picks
 * the scope, filters and ranks rows, and returns each with its range, its decks and the simulator view where one
 * exists. Every row is status: candidate (a measured association, not proof of cause). No model and no clock.
 */

const loaded = new WeakMap<CardStore, SleepersFile | null>();

export function sleepersOf(store: CardStore): SleepersFile | null {
  if (loaded.has(store)) return loaded.get(store) ?? null;
  const file = path.join(packageDirOf(store), "sleepers", "sleepers.json");
  const parsed = existsSync(file) ? sleepersFileSchema.parse(readJson(file)) : null;
  loaded.set(store, parsed);
  return parsed;
}

const ASPECTS = ["Aggression", "Command", "Cunning", "Heroism", "Vigilance", "Villainy"] as const;

export const sleeperCardsShape = {
  leader: leaderField.optional().describe("With base: rank cards among decks of this leader and base aspects"),
  base: baseField.optional().describe("With leader: the deck's base; its aspects pick the comparable decks"),
  aspects: z
    .array(z.enum(ASPECTS))
    .min(1)
    .max(4)
    .optional()
    .describe(
      "Instead of leader and base: the deck's aspect icons (leader plus base, duplicates kept), for example [Vigilance, Heroism, Command]",
    ),
  show: z
    .enum(["sleepers", "all"])
    .default("sleepers")
    .describe(
      "sleepers (default): cards that pass the false-discovery gate as underplayed winners or as helping strong players more; all: every measured card, best lower bound first",
    ),
  minDecks: z.number().int().min(1).default(20).describe("Leave out cards measured on fewer decks with the card than this"),
  limit: z.number().int().min(1).max(100).default(15),
  includeRotated: z
    .boolean()
    .default(false)
    .describe("Also list cards from sets Premier has rotated out (measured in the seasons they were legal; not playable in Premier now)"),
};

export const byLowerBound = (a: SleeperRow, b: SleeperRow): number =>
  b.gap.low - a.gap.low || a.gap.p - b.gap.p || compareCodePoints(a.cardKey, b.cardKey);
export const holdsForSamePlayers = (r: SleeperRow): boolean => r.withinPlayer !== null && r.withinPlayer.low > 0;

/** The rows that pass the gate as underplayed winners or as helping strong players more; a gap that also holds inside the same players' own decks is the stronger evidence, so it leads. */
export function flaggedRows(measured: readonly SleeperRow[]): SleeperRow[] {
  return measured
    .filter((r) => r.verdict === "sleeper" || r.skilledEdge)
    .sort((a, b) => Number(holdsForSamePlayers(b)) - Number(holdsForSamePlayers(a)) || byLowerBound(a, b));
}

const pts = (x: number): number => Math.round(x * 1000) / 10;

export function scopeOf(
  store: CardStore,
  file: SleepersFile,
  args: { leader?: string; base?: string; aspects?: string[] },
): { kind: "field" | "aspects" | "leader-base"; label: string; rows: SleeperRow[]; decks: number } | string {
  if (args.leader !== undefined || args.base !== undefined) {
    if (args.leader === undefined || args.base === undefined)
      return "give leader and base together, or aspects, or neither for the whole field";
    const leader = resolveRef(store, args.leader, "leader");
    if (!leader.ok) return `leader "${args.leader}": ${leader.reason}, ${leader.detail}`;
    const base = resolveRef(store, args.base, "base");
    if (!base.ok) return `base "${args.base}": ${base.reason}, ${base.detail}`;
    const baseAspects = (base.row.aspects ?? "")
      .split("|")
      .filter((a) => a !== "")
      .sort(compareCodePoints);
    const key = `${leader.row.cardKey}|${baseAspects.join("+")}`;
    const label = `${cardLabel(leader.row)} with a ${baseAspects.join("+") || "neutral"} base`;
    const scope = file.archetypes.find((s) => s.key === key);
    if (scope === undefined)
      return `no card has enough tournament decks of ${label} with and without it (at least ${file.method.minDecks} each, in ${file.method.minEvents} or more events) in ${file.window.from}..${file.window.to}; try aspects or the whole field`;
    return { kind: "leader-base", label, rows: scope.rows, decks: scope.decks };
  }
  if (args.aspects !== undefined) {
    const aspects = [...args.aspects].sort(compareCodePoints);
    const key = `aspects:${aspects.join("+")}`;
    const scope: SleeperScope | undefined = file.aspects.find((s) => s.key === key);
    if (scope === undefined)
      return `no card has enough tournament decks with aspects ${aspects.join("+")} in ${file.window.from}..${file.window.to}`;
    return { kind: "aspects", label: `decks with aspects ${aspects.join("+")} (any leader)`, rows: scope.rows, decks: scope.decks };
  }
  return {
    kind: "field",
    label: "every tournament deck, compared within its own meta period, leader and base aspects",
    rows: file.global,
    decks: file.counts.decks,
  };
}

export function sleeperCards(store: CardStore, dataVersion: string, file: SleepersFile | null, input: unknown): ToolResult {
  const args = z.object(sleeperCardsShape).parse(input);
  if (file === null)
    return fail(
      'no sleepers/sleepers.json in this data package; it predates the sleeper step (run "pnpm meta:sleepers" or "pnpm build:data")',
    );
  const scope = scopeOf(store, file, args);
  if (typeof scope === "string") return fail(scope);
  const q = file.method.q;
  const rotatedHidden = args.includeRotated ? 0 : scope.rows.filter((r) => r.rotated && r.decksWith >= args.minDecks).length;
  const measured = scope.rows.filter((r) => r.decksWith >= args.minDecks && (args.includeRotated || !r.rotated));
  const flagged = flaggedRows(measured);
  const chosen = args.show === "all" ? measured.slice().sort(byLowerBound) : flagged;
  const shown = chosen.slice(0, args.limit);
  const fill =
    args.show === "sleepers" && shown.length < args.limit
      ? measured
          .filter((r) => r.verdict === "no-clear-effect" && !r.skilledEdge && r.gap.value > 0 && r.playRate < 0.5)
          .sort((a, b) => a.gap.p - b.gap.p || compareCodePoints(a.cardKey, b.cardKey))
          .slice(0, Math.min(5, args.limit - shown.length))
      : [];
  const sim = file.simulator;
  const view = (r: SleeperRow) => {
    const row = store.byKey.get(r.cardKey);
    const simCard = sim?.cards[r.cardKey];
    return {
      cardKey: r.cardKey,
      title: row === undefined ? r.title : cardLabel(row),
      ...(r.rotated ? { rotated: "a set Premier has rotated out: measured while it was legal, not playable in Premier now" } : {}),
      verdict: r.verdict,
      playRate: r.playRate,
      winAdvantagePts: pts(r.gap.value),
      rangePts: `${pts(r.gap.low)}..${pts(r.gap.high)}`,
      qBY: r.gap.qBY,
      qBH: r.gap.qBH,
      decksWith: r.decksWith,
      decksWithout: r.decksWithout,
      events: r.eventsWith,
      effectiveEvents: Math.round(r.effectiveEvents * 10) / 10,
      skilledEdge: r.skilledEdge,
      ...(r.skill === null
        ? { skill: "not measured (too few decks in the strongest or weakest third of players)" }
        : {
            skill: {
              extraForStrongPts: pts(r.skill.interaction.value),
              rangePts: `${pts(r.skill.interaction.low)}..${pts(r.skill.interaction.high)}`,
              qBY: r.skill.interaction.qBY,
              strongPlayersPts: pts(r.skill.gapStrong),
              weakPlayersPts: pts(r.skill.gapWeak),
              decksStrong: r.skill.decksStrong,
              decksWeak: r.skill.decksWeak,
            },
          }),
      ...(r.withinPlayer === null
        ? {}
        : {
            ...(holdsForSamePlayers(r) ? { holdsForSamePlayers: true } : {}),
            samePlayerPts: pts(r.withinPlayer.value),
            samePlayerRangePts: `${pts(r.withinPlayer.low)}..${pts(r.withinPlayer.high)}`,
            samePlayers: r.withinPlayer.players,
          }),
      ...(r.withinStyle === null
        ? {}
        : { sameBuildPts: pts(r.withinStyle.value), sameBuildRangePts: `${pts(r.withinStyle.low)}..${pts(r.withinStyle.high)}` }),
      ...(r.selectionWarning
        ? { selectionWarning: "the same players' own decks show no clear difference: the gap may come from who plays the card" }
        : {}),
      latestPeriod: r.latestPeriod,
      ...(simCard === undefined
        ? {}
        : {
            simulator: simCard.effects.map((e) => ({
              pilot: e.pilot,
              experiment: e.experiment,
              role: e.role,
              copies: e.copies,
              effectPts: pts(e.effect),
              rangePts: `${pts(e.low)}..${pts(e.high)}`,
              games: e.games,
            })),
            pilotSensitivity: simCard.pilotSensitivity.map((s) => ({
              experiment: s.experiment,
              lookahead: s.lookahead,
              extraPts: pts(s.value),
              rangePts: `${pts(s.low)}..${pts(s.high)}`,
            })),
          }),
      status: CANDIDATE_STATUS,
    };
  };
  const anySim = [...shown, ...fill].some((r) => sim?.cards[r.cardKey] !== undefined);
  return ok({
    dataVersion,
    scope: { kind: scope.kind, label: scope.label, decks: scope.decks },
    population: file.population,
    precedence: file.precedence,
    source: file.source,
    window: `${file.window.from}..${file.window.to}`,
    status: CANDIDATE_STATUS,
    show: args.show,
    measured: measured.length,
    ...(rotatedHidden > 0 ? { rotatedHidden } : {}),
    flagged: flagged.length,
    shown: shown.length,
    cards: shown.map(view),
    ...(fill.length === 0 ? {} : { unconfirmed: fill.map(view) }),
    ...(anySim && sim !== null ? { simulatorLabel: sim.label, simulatorCaveat: sim.caveat, simulatorDeck: sim.deck } : {}),
    nullCheck: `${file.method.nullCheck.passBY} of ${file.method.nullCheck.rows} cards passed with card lists shuffled (expected 0)`,
    note: `winAdvantagePts = match win rate of decks with the card minus comparable decks without it (same meta period, leader and base aspects), in percentage points, with a 95% range from a bootstrap over whole events. A card is flagged only when its Benjamini-Yekutieli q (false-discovery control valid however the cards' tests depend on each other) is at most ${q}; qBH is the Benjamini-Hochberg q, shown for reference. sleeper = flagged winner played in under half of comparable decks; proven-winner = flagged winner played in half or more. skill.extraForStrongPts = the card's advantage among the strongest third of players minus the weakest third (skill = each player's results in their other events); skilledEdge = that difference passes the same gate. samePlayerPts compares one player's own decks with and without the card, so it is not explained by strong players choosing the card; sameBuildPts compares decks of the same build style. holdsForSamePlayers: true marks a card whose samePlayer range is above 0, and such cards are listed first. unconfirmed rows have a positive point estimate that does not pass the gate. Cards from sets Premier has rotated out are left out unless includeRotated is true (rotatedHidden counts them). Opponents are unknown (each record is against the deck's whole event), the rest of the deck differs between decks with and without the card, and old meta periods count beside new ones, so every row is a candidate, not proof. Simulator rows are computer play on one deck and are never pooled with tournament figures.`,
  });
}
