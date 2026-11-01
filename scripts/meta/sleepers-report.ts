/**
 * @displayName Sleeper-card plain-language report
 * @strategicPurpose The owner's reading of the sleeper analysis (LampaGJ/swu-mcp#184): "cards that are surprisingly
 * good if competently played the right way", in plain words without card-game jargon.
 * @tacticalObjective Reads <run>/sleepers/sleepers.json (strict parse), the run's card names and the capture
 * manifest's per-window counts, and writes reports/sleepers/<snapshot>.md (git-ignored). Deterministic: same inputs,
 * same bytes. The data product carries no player names, so neither can this report.
 *
 * Usage: pnpm meta:sleepers-report [--data <package dir holding sleepers/ and llm/>] [--capture <dir>] [--out <file>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadStore, readJson } from "../../src/data.js";
import { decklistManifestSchema } from "../../src/meta/decklist-capture.js";
import { sleepersFileSchema, type SleeperRow, type SleepersFile } from "../../src/meta/sleepers-schema.js";
import { compareCodePoints } from "../../src/swu/canonical.js";
import { cardLabel } from "../../src/synergy/order.js";
import { defaultRun, REPO_ROOT } from "../bench/code-commit.js";

export const OWNER_LEADER = "09010018";
export const OWNER_BASE = "09010024";

const pts = (x: number): string => {
  const v = Math.round(x * 1000) / 10;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
};
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const n = (x: number): string => x.toLocaleString("en-US");
const range = (low: number, high: number): string => `between ${pts(low)} and ${pts(high)}`;
const moreOrFewer = (x: number): string => {
  const v = Math.abs(Math.round(x * 1000) / 10).toFixed(1);
  return x >= 0 ? `${v} more` : `${v} fewer`;
};
const qText = (x: number): string => (x < 0.001 ? "below 0.001" : String(Math.round(x * 1000) / 1000));
const plural = (k: number, one: string, many: string): string => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;

export function renderReport(
  file: SleepersFile,
  names: ReadonlyMap<string, string>,
  manifestCounts: {
    byMetaPeriod: Record<string, number>;
    decklistsCaptured: number;
    tournamentsWithDecklists: number;
    decklistsListed: number;
  } | null,
  owner: { baseAspects: readonly string[]; leaderAspects: readonly string[] },
): string {
  const titleOf = new Map([...file.global, ...file.archetypes.flatMap((a) => a.rows)].map((r) => [r.cardKey, r.title]));
  const name = (k: string): string => names.get(k) ?? titleOf.get(k) ?? k;
  const current = (r: SleeperRow): boolean => !r.rotated;
  const q = file.method.q;
  const byLow = (a: SleeperRow, b: SleeperRow): number => b.gap.low - a.gap.low || compareCodePoints(a.cardKey, b.cardKey);
  const allSleepers = file.global.filter((r) => r.verdict === "sleeper").sort(byLow);
  const sleepers = allSleepers.filter(current);
  const rotatedSleepers = allSleepers.filter((r) => r.rotated);
  const trusted = sleepers.filter((r) => r.withinPlayer !== null && r.withinPlayer.low > 0);
  const skilled = file.global
    .filter((r) => r.skilledEdge)
    .sort((a, b) => (b.skill?.interaction.low ?? 0) - (a.skill?.interaction.low ?? 0) || compareCodePoints(a.cardKey, b.cardKey));
  const proven = file.global.filter((r) => r.verdict === "proven-winner" && current(r)).sort(byLow);
  const losing = file.global
    .filter((r) => r.verdict === "loses-ground" && current(r))
    .sort((a, b) => a.gap.high - b.gap.high || compareCodePoints(a.cardKey, b.cardKey));
  const leads = file.global
    .filter((r) => r.verdict === "no-clear-effect" && current(r) && r.gap.value > 0 && r.playRate < 0.5)
    .sort((a, b) => a.gap.p - b.gap.p || compareCodePoints(a.cardKey, b.cardKey))
    .slice(0, 10);
  const sim = file.simulator;

  const lines: string[] = [];
  const say = (...xs: string[]): void => {
    lines.push(...xs);
  };
  const describe = (r: SleeperRow, i: number): void => {
    say(
      `${i + 1}. **${name(r.cardKey)}**: played in ${pct(r.playRate)} of comparable decks. Decks with it won ${moreOrFewer(r.gap.value)} matches out of 100 than comparable decks without it (likely ${range(r.gap.low, r.gap.high)}). Behind it: ${n(r.decksWith)} decks with it and ${n(r.decksWithout)} without, at ${n(r.eventsWith)} events (about ${Math.round(r.effectiveEvents)} events' worth of independent evidence). Fluke check across all cards: ${r.gap.qBY <= q ? "passes" : "does not pass"} (q ${qText(r.gap.qBY)}).`,
    );
    if (r.skill !== null) {
      say(
        `   - Strong players versus weak players: with the card, the strongest third of players gained ${pts(r.skill.gapStrong)}, the weakest third ${pts(r.skill.gapWeak)}; the difference is ${pts(r.skill.interaction.value)} (likely ${range(r.skill.interaction.low, r.skill.interaction.high)}), ${r.skilledEdge ? "a confirmed edge for strong players" : "not confirmed"}. Decks behind it: ${n(r.skill.decksStrong)} strong-player decks and ${n(r.skill.decksWeak)} weak-player decks with the card.`,
      );
    } else say("   - Strong players versus weak players: too few decks in one of the two groups to say.");
    if (r.withinPlayer !== null)
      say(
        `   - The same players with and without it: ${pts(r.withinPlayer.value)} (likely ${range(r.withinPlayer.low, r.withinPlayer.high)}), from ${n(r.withinPlayer.players)} players who sometimes played it and sometimes not with the same leader and kind of base.${r.selectionWarning ? " This range includes zero, so part of the advantage may come from who chooses the card rather than the card." : ""}`,
      );
    if (r.withinStyle !== null)
      say(`   - Inside the same build style: ${pts(r.withinStyle.value)} (likely ${range(r.withinStyle.low, r.withinStyle.high)}).`);
    const s = sim?.cards[r.cardKey];
    if (s !== undefined) {
      for (const e of s.effects)
        say(
          `   - Computer play (${e.pilot}, ${e.experiment}, ${e.copies} ${e.copies === 1 ? "copy" : "copies"} ${e.role === "added" ? "put in" : "taken out"}): ${pts(e.effect)} games out of 100 (likely ${range(e.low, e.high)}), ${n(e.games)} games.`,
        );
    }
    say(`   - Most recent season with data: ${r.latestPeriod}.`);
  };

  say(
    `# Sleeper cards: cards that win more than their popularity suggests`,
    "",
    `Data as of ${file.window.to} (tournaments ${file.window.from} to ${file.window.to}). Population: ${file.population}. Generated by scripts/meta/sleepers-report.ts from sleepers/sleepers.json.`,
    "",
    "## In short",
    "",
    `- ${n(file.counts.decks)} tournament decks from ${n(file.counts.events)} events had a full match record and went into the comparison.`,
    `- ${plural(sleepers.length, "card still legal in Premier passes", "cards still legal in Premier pass")} the check as underplayed winners: played in under half of the decks that could use them, yet those decks win clearly more (${plural(rotatedSleepers.length, "more card is", "more cards are")} from sets Premier has rotated out).`,
    `- Only ${plural(trusted.length, "of them also holds", "of them also hold")} up when the same players are compared with and without the card. For the rest, the advantage may come from who picks the card (strong players, better-built decks) rather than the card itself.`,
    `- ${plural(skilled.length, "card passes", "cards pass")} the check as helping strong players more than weak players.`,
    `- ${plural(proven.length, "card is a confirmed winner", "cards are confirmed winners")} that ${proven.length === 1 ? "is" : "are"} already widely played, and ${plural(losing.length, "card is", "cards are")} confirmed to go with fewer wins.`,
    `- A safety test shuffled which decks held which cards; ${file.method.nullCheck.passBY} of ${n(file.method.nullCheck.rows)} cards passed then (0 expected), so the check does not invent winners from noise.`,
    "",
    "## What was downloaded",
    "",
  );
  if (manifestCounts !== null) {
    say(
      `The download covered every Premier tournament that swumetastats.com tracks: ${n(manifestCounts.tournamentsWithDecklists)} events listing ${n(manifestCounts.decklistsListed)} decklists, of which ${n(manifestCounts.decklistsCaptured)} came back. Decklists per season:`,
      "",
    );
    for (const [label, count] of Object.entries(manifestCounts.byMetaPeriod)) say(`- ${label}: ${n(count)}`);
    say("");
  }
  say("Decks with a full match record, used for the comparison, per season:", "");
  for (const p of file.periods) say(`- ${p.label} (${p.from} to ${p.to}): ${n(p.decks)} decks at ${n(p.events)} events`);
  say(
    "",
    "Older events mostly list only the finishing place, not the match record, so the comparison rests on the seasons above. A season is the stretch between two card releases or rule changes.",
    "",
    `## The most trustworthy sleepers (${trusted.length})`,
    "",
    "These pass both tests: decks with the card win more than comparable decks without it, and the same players win more in the events where they play it.",
    "",
  );
  if (trusted.length === 0) say("No card passes both tests.", "");
  trusted.forEach(describe);
  say("", `## All underplayed winners still legal in Premier (${sleepers.length})`, "");
  if (sleepers.length === 0) say("No card passes the check. The closest leads are listed further down.", "");
  sleepers.slice(0, 25).forEach(describe);
  say("", `## Better in skilled hands (${skilled.length})`, "");
  if (skilled.length === 0)
    say(
      "No card passes the check for helping strong players more. This is a hard test: it needs many decks from both strong and weak players.",
      "",
    );
  skilled.slice(0, 15).forEach(describe);
  if (leads.length > 0) {
    say(
      "",
      "## Closest leads that do not pass the check",
      "",
      "These have a positive estimate and are played in under half of comparable decks, but the evidence is not strong enough yet. Treat them as ideas to test, not findings.",
      "",
    );
    leads.forEach(describe);
  }
  if (rotatedSleepers.length > 0) {
    say(
      "",
      `## Underplayed winners from rotated sets (${rotatedSleepers.length})`,
      "",
      "Measured while they were legal; Premier no longer allows them.",
      "",
    );
    for (const r of rotatedSleepers)
      say(
        `- ${name(r.cardKey)}: ${moreOrFewer(r.gap.value)} matches out of 100 (likely ${range(r.gap.low, r.gap.high)}), ${n(r.decksWith)} decks, last season ${r.latestPeriod}.`,
      );
  }
  say("", `## Confirmed winners that are already popular (top 10 of ${proven.length})`, "");
  proven.slice(0, 10).forEach(describe);
  say("", `## Cards that go with fewer wins (top 10 of ${losing.length})`, "");
  losing.slice(0, 10).forEach(describe);

  const ownerKey = `${OWNER_LEADER}|${[...owner.baseAspects].sort(compareCodePoints).join("+")}`;
  const ownerAspects = [...owner.leaderAspects, ...owner.baseAspects].sort(compareCodePoints);
  const ownerAspectScope = file.aspects.find((a) => a.key === `aspects:${ownerAspects.join("+")}`);
  const ownerScope = file.archetypes.find((a) => a.key === ownerKey);
  say("", `## Your deck: ${name(OWNER_LEADER)} with ${name(OWNER_BASE)}`, "");
  if (ownerScope === undefined) {
    say(
      `Too few tournament decks of this leader and kind of base to measure any card (each card needs ${file.method.minDecks} decks with it and ${file.method.minDecks} without). The leader comes from Homeworlds, released 2026-10-09, and the last event swumetastats.com tracks is from ${file.window.to}. The nearest comparison is every deck with the same aspects (${ownerAspects.join(", ")}), under any leader.`,
      "",
    );
    if (ownerAspectScope !== undefined) {
      const rows = ownerAspectScope.rows.filter(current).sort(byLow);
      const flagged = rows.filter((r) => r.verdict !== "no-clear-effect" || r.skilledEdge);
      say(
        `${n(ownerAspectScope.decks)} tournament decks with these aspects; ${rows.length} cards still legal in Premier have enough decks to measure; ${flagged.length} pass the check inside this group. The ten with the best lower bound:`,
        "",
      );
      rows.slice(0, 10).forEach(describe);
    } else say("Too few decks with these aspects either.", "");
  } else {
    const rows = ownerScope.rows.filter(current).sort(byLow);
    const flagged = rows.filter((r) => r.verdict !== "no-clear-effect" || r.skilledEdge);
    say(
      `${n(ownerScope.decks)} tournament decks of this leader and kind of base; ${rows.length} cards have enough decks to measure; ${flagged.length} pass the check inside this group. The ten with the best lower bound:`,
      "",
    );
    rows.slice(0, 10).forEach(describe);
  }

  if (sim !== null) {
    say(
      "",
      "## Computer play (kept apart from the tournament figures)",
      "",
      `${sim.label}. Deck: ${sim.deck}. Opponents: ${sim.opponents}.`,
      "",
      `Caveat: ${sim.caveat}`,
      "",
    );
    for (const [key, s] of Object.entries(sim.cards)) {
      say(`- **${name(key)}**`);
      for (const e of s.effects)
        say(
          `  - ${e.pilot}, ${e.experiment} (${e.copies} ${e.role === "added" ? "put in" : "taken out"}): ${pts(e.effect)} games out of 100 (likely ${range(e.low, e.high)}).`,
        );
      for (const p of s.pilotSensitivity)
        say(`  - Stronger pilot minus rules pilot (${p.lookahead}, ${p.experiment}): ${pts(p.value)} (likely ${range(p.low, p.high)}).`);
    }
  }

  say(
    "",
    "## How this works, in plain words",
    "",
    "- Each decklist comes with how many matches it won and lost at its event. For every card, we compare decks that played it with decks that did not, but only inside groups that are alike: the same leader, the same kind of base and the same season. Then we combine the groups.",
    "- The range is where the true advantage most likely sits (95% of the time). It comes from re-running the comparison many times on reshuffled sets of whole events, so one big event cannot sway it alone.",
    `- With about ${n(file.global.length)} cards tested at once, some would look good by luck. The check controls for that (the Benjamini-Yekutieli method, which stays valid even though cards in the same deck move together); a card passes only when its q is ${q} or less. The usual lighter version (Benjamini-Hochberg) is also stored for reference.`,
    `- A player's skill is read from their results at their other events (never the event being scored): how many more matches they won than the average deck of their leader and kind of base, pulled toward average when they have played few matches. Strong means the top third, weak the bottom third.`,
    "- To check that a card's advantage is not just strong players picking it, we also compare the same players with and without the card (same leader and kind of base), and decks of the same build style.",
    "",
    "## What this cannot tell you",
    "",
    "- Cause. Decks that play a card differ in their other cards too, so a card can mark a better build rather than make it. The same-player and same-build checks narrow this but cannot remove it.",
    "- Opponents. Each record is against a deck's whole event, never against one kind of opponent, so a card that beats one popular deck shows only as a general edge.",
    "- Timing. Strong players may add a card exactly when it suits the field; the design cannot separate that from the card helping them more.",
    "- Names. Players are linked across events by the name the event lists, so two people with one name merge and one person with two spellings splits.",
    "- The newest season. swumetastats.com lists no Premier event after 2026-10-06, so the current season has no tournament data yet; older seasons count beside newer ones.",
    "- Simulator figures come from computer pilots on one deck; they are a different kind of evidence and are never added to the tournament figures.",
    "",
    "## Numbers for the record",
    "",
    `- Method: ${file.method.comparison}. Interval: ${file.method.interval}. Test: ${file.method.test}. False discoveries: ${file.method.fdr}.`,
    `- Bootstrap: ${file.method.replicates} resamples, seed ${file.method.seed}. Minimums per card: ${file.method.minDecks} decks with and without, ${file.method.minEvents} events; ${file.method.minTierDecks} decks per skill group; ${file.method.minPlayers} players for the same-player check.`,
    `- Skill: shrinkage worth ${file.method.skill.priorMatches} matches; spread of true player skill ${pts(file.method.skill.betweenPlayerSd)} matches out of 100; group cut-offs ${file.method.skill.tierCuts.join(" and ")}. ${n(file.counts.decksWithSkill)} decks had a skill estimate.`,
    `- Shuffle check: ${file.method.nullCheck.method}; ${file.method.nullCheck.passBH} cards passed the lighter Benjamini-Hochberg version and ${file.method.nullCheck.passBY} the Benjamini-Yekutieli version, smallest p ${file.method.nullCheck.minP}.`,
    `- ${n(file.counts.strata)} comparison groups, ${n(file.counts.styles)} build styles, ${n(file.counts.players)} distinct player names.`,
    "",
  );
  return lines.join("\n");
}

function main(): void {
  const { values } = parseArgs({
    options: { data: { type: "string" }, capture: { type: "string" }, out: { type: "string" } },
  });
  const pkg = path.resolve(values.data ?? defaultRun());
  const file = sleepersFileSchema.parse(readJson(path.join(pkg, "sleepers/sleepers.json")));
  // Card names from the package's card list: features.json leaves some printed cards out, cards.toon has them all.
  const store = loadStore(pkg);
  const names = new Map(store.cards.map((row) => [row.cardKey, cardLabel(row)]));
  const manifest =
    values.capture === undefined
      ? null
      : decklistManifestSchema.parse(JSON.parse(readFileSync(path.join(values.capture, "manifest.json"), "utf8")));
  const aspectsOf = (key: string): string[] => (store.byKey.get(key)?.aspects ?? "").split("|").filter((a) => a !== "");
  const text = renderReport(file, names, manifest?.counts ?? null, {
    baseAspects: aspectsOf(OWNER_BASE),
    leaderAspects: aspectsOf(OWNER_LEADER),
  });
  const out = path.resolve(values.out ?? path.join(REPO_ROOT, "reports/sleepers", `${file.window.to}.md`));
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(out);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
