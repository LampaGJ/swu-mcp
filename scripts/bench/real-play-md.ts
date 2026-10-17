/**
 * @displayName Real-play summary renderer
 * @strategicPurpose The committed summary must hold aggregates only and must be regenerated, never hand-edited,
 * when the benchmark reruns.
 * @tacticalObjective Pure function from the real-play report JSON to markdown: headline bullets, per-row bullets
 * ordered weakest first, and the fixed method and caveat text. No per-game or per-player value reaches it.
 */

type Json = Record<string, unknown>;

const at = (obj: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Json)[k] : undefined), obj);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

function fmt(v: number | null, digits = 3): string {
  return v === null ? "n/a" : v.toFixed(digits);
}

/** "0.123 (95% CI 0.100 to 0.150)" for a bootstrap CI object. */
function ci(obj: unknown, digits = 3): string {
  const value = num(at(obj, "value"));
  if (value === null) return "n/a";
  return `${fmt(value, digits)} (95% CI ${fmt(num(at(obj, "low")), digits)} to ${fmt(num(at(obj, "high")), digits)}, n ${at(obj, "n")})`;
}

/** "41.2% (95% CI 40.1 to 42.3%, 1234 of 3000)" for a Wilson interval. */
function pct(obj: unknown): string {
  const value = num(at(obj, "value"));
  if (value === null) return "n/a";
  const p = (x: unknown): string => ((num(x) ?? 0) * 100).toFixed(1);
  return `${p(value)}% (95% CI ${p(at(obj, "low"))} to ${p(at(obj, "high"))}%, ${at(obj, "n")} of ${at(obj, "of")})`;
}

const lift = (logCi: unknown): string => {
  const v = num(at(logCi, "value"));
  return v === null ? "" : ` (lift ×${Math.exp(v).toFixed(2)})`;
};

function rowNames(section: unknown): string[] {
  return Object.keys((section ?? {}) as Json).filter((k) => k.startsWith("row:"));
}

function coInclusionBullets(section: unknown, label: string): string[] {
  const all = at(section, "all");
  const noTrait = at(section, "all-excluding-trait-only");
  const out = [
    `- ${label}, all ${at(all, "pairs", "pairs")} pairs: ${at(all, "pairs", "measured")} measured, ${at(all, "pairs", "unplayed")} with a card never included, ${at(all, "pairs", "notObservable")} not observable.`,
    `  - Mean log-lift ${ci(at(all, "pairs", "meanLogLift"))}${lift(at(all, "pairs", "meanLogLift"))}; median ${ci(at(all, "pairs", "medianLogLift"))}.`,
    `  - Random matched partners (same type, cost band, aspect icons): mean log-lift ${ci(at(all, "randomMatched", "meanLogLift"))}; paired difference pair minus its random partner ${ci(at(all, "pairedDiffVsRandom"))}.`,
    `  - Top embedding-similar pairs: mean log-lift ${ci(at(section, "similarBaseline", "meanLogLift"))}.`,
    `  - Share with lift above 1: ${pct(at(all, "pairs", "shareLiftAboveOne"))}; random partners ${pct(at(all, "randomMatched", "shareLiftAboveOne"))}.`,
    `  - Pair score as a ranker of lift above 1 (AUC): ${fmt(num(at(all, "pairs", "scoreAuc")))}.`,
  ];
  if (noTrait !== undefined) {
    out.push(
      `  - Excluding trait-only pairs (${at(noTrait, "pairs", "measured")} measured): mean log-lift ${ci(at(noTrait, "pairs", "meanLogLift"))}; paired difference vs random ${ci(at(noTrait, "pairedDiffVsRandom"))}.`,
    );
  }
  return out;
}

function perRowBullets(section: unknown): string[] {
  const rows = rowNames(section).map((name) => ({ name: name.slice(4), body: at(section, name) }));
  const key = (r: { body: unknown }): number => num(at(r.body, "pairedDiffVsRandom", "value")) ?? Number.POSITIVE_INFINITY;
  rows.sort((a, b) => key(a) - key(b) || (a.name < b.name ? -1 : 1));
  return rows.map((r) => {
    const diff = at(r.body, "pairedDiffVsRandom");
    const low = num(at(diff, "low"));
    const flag = low === null ? " [too few measured]" : low <= 0 ? " [not above random]" : "";
    return `- ${r.name}${flag}: ${at(r.body, "pairs", "measured")} of ${at(r.body, "pairs", "pairs")} measured; mean log-lift ${ci(at(r.body, "pairs", "meanLogLift"), 2)}; random ${ci(at(r.body, "randomMatched", "meanLogLift"), 2)}; paired difference ${ci(diff, 2)}; lift above 1 ${pct(at(r.body, "pairs", "shareLiftAboveOne"))}.`;
  });
}

/** Rows whose paired difference against random partners is entirely below 0, or straddles 0 with at least 30 measured pairs. */
function rowVerdicts(section: unknown, label: string): string[] {
  const below: string[] = [];
  const flat: string[] = [];
  for (const name of rowNames(section)) {
    const diff = at(section, name, "pairedDiffVsRandom");
    const low = num(at(diff, "low"));
    const high = num(at(diff, "high"));
    const measured = num(at(section, name, "pairs", "measured")) ?? 0;
    if (low === null || high === null) continue;
    if (high < 0) below.push(name.slice(4));
    else if (low <= 0 && measured >= 30) flat.push(name.slice(4));
  }
  return [
    `- Rows below their random partners on ${label} (whole 95% CI under 0): ${below.join(", ") || "none"}.`,
    `- Rows indistinguishable from random partners on ${label} (CI spans 0, at least 30 measured pairs): ${flat.join(", ") || "none"}.`,
  ];
}

function interactionBullets(section: unknown): string[] {
  const rows = rowNames(section).map((name) => ({ name: name.slice(4), body: at(section, name) }));
  const rate = (r: unknown): number => num(at(r, "pairs", "offerInPlayWhenWantPlayed", "value")) ?? -1;
  rows.sort((a, b) => rate(a.body) - rate(b.body) || (a.name < b.name ? -1 : 1));
  return rows.map(
    (r) =>
      `- ${r.name}: ${at(r.body, "pairs", "coOccurringSides")} co-occurring sides; offer in play when want played ${pct(at(r.body, "pairs", "offerInPlayWhenWantPlayed"))} vs random ${pct(at(r.body, "randomMatched", "offerInPlayWhenWantPlayed"))}; MH win-rate difference by leader ${ci(at(r.body, "pairs", "mhRiskDifferenceByLeader"))}.`,
  );
}

function agreementBullets(obj: unknown, label: string): string {
  const mw = at(obj, "mannWhitney");
  return `- ${label}: correct pairs ${at(obj, "correct", "measured")} of ${at(obj, "correct", "items")} measured (median log-lift ${fmt(num(at(obj, "correct", "medianLogLift")))}), wrong pairs ${at(obj, "wrong", "measured")} of ${at(obj, "wrong", "items")} (median ${fmt(num(at(obj, "wrong", "medianLogLift")))}); Mann-Whitney AUC correct over wrong ${fmt(num(at(mw, "auc")))}, rank-biserial ${fmt(num(at(mw, "rankBiserial")))}, p ${fmt(num(at(mw, "p")), 4)}.`;
}

export function renderMarkdown(report: Json): string {
  const decks = at(report, "deckCoInclusion");
  const pooled = at(decks, "pooled-conditioned");
  const games = at(report, "humanGames", "coOccurrence", "coOccurrence-conditioned");
  const inter = at(report, "humanGames", "interactionAndWins");
  const fix = at(report, "pairsV1Agreement");
  const fung = at(report, "fungible");
  const trios = at(report, "trios", "all");
  const sims = at(report, "simulations");
  const inputs = at(report, "inputs");
  const snapshots = (at(inputs, "decks", "snapshots") as Json[] | undefined) ?? [];
  const snapshotSections = Object.keys((decks ?? {}) as Json).filter((k) => k.startsWith("snapshot:"));

  const lines: string[] = [
    "---",
    "type: report",
    "status: final",
    'related: ["#18"]',
    "review_by: 2027-01-17",
    "---",
    "",
    `# Real-play benchmark: synergy output against decklists, human games and engine simulations (run ${at(report, "run")})`,
    "",
    "Generated by `pnpm bench:real-play`; do not edit by hand. Aggregates only: no per-game, per-player or per-deck rows.",
    "",
    "## TL;DR",
    "",
    `- Decklists (${at(inputs, "decks", "decks")} unique Premier lists): emitted pairs have mean deck co-inclusion log-lift ${ci(at(pooled, "all", "pairs", "meanLogLift"))}${lift(at(pooled, "all", "pairs", "meanLogLift"))}, against ${ci(at(pooled, "all", "randomMatched", "meanLogLift"))} for random partners matched on type, cost band and aspect icons. The paired difference is ${ci(at(pooled, "all", "pairedDiffVsRandom"))}.`,
    `- Human Karabast games (${at(inputs, "humanGames", "games")} games, ${at(inputs, "humanGames", "sides")} sides): co-occurrence on one side has mean log-lift ${ci(at(games, "all", "pairs", "meanLogLift"))} against ${ci(at(games, "all", "randomMatched", "meanLogLift"))} for random partners. When both cards appear, the offering card is in play when the wanting card is played on ${pct(at(inter, "all", "pairs", "offerInPlayWhenWantPlayed"))} of sides (random partners ${pct(at(inter, "all", "randomMatched", "offerInPlayWhenWantPlayed"))}).`,
    `- Win rate, human games, both cards versus only one, Mantel-Haenszel by leader: ${ci(at(inter, "all", "pairs", "mhRiskDifferenceByLeader"))} (random partners ${ci(at(inter, "all", "randomMatched", "mhRiskDifferenceByLeader"))}). Confounded by deck strength and by how long a game lasts.`,
    ...rowVerdicts(pooled, "decklists"),
    ...rowVerdicts(games, "human-game co-occurrence"),
    agreementBullets(at(fix, "decksPooledConditioned"), "pairs-v1 judges vs decklists"),
    agreementBullets(at(fix, "humanGamesConditioned"), "pairs-v1 judges vs human games"),
    `- Fungible classes (substitutes): pooled observed/expected co-occurrence within a leader ${fmt(num(at(fung, "classes", "pooledOE")))} against ${fmt(num(at(fung, "randomMatchedGroups", "pooledOE")))} for matched random groups; classes below chance ${pct(at(fung, "classes", "shareBelowChance"))}.`,
    `- Trios: mean log(observed/expected) of all three in one deck ${ci(at(trios, "trios", "meanLogOE"))} against ${ci(at(trios, "randomMatched", "meanLogOE"))} for matched random trios.`,
    `- Engine simulations (bot play, reported separately): decks holding both cards versus one, MH win-rate difference by leader ${ci(at(sims, "all", "pairs", "mhRiskDifferenceByLeader"))} (random partners ${ci(at(sims, "all", "randomMatched", "mhRiskDifferenceByLeader"))}).`,
    "",
    "## Sources and observability windows",
    "",
    ...snapshots.map((s) => `- Decklist snapshot \`${s.label}\`: created ${at(s, "createdAt", "min")} to ${at(s, "createdAt", "max")}.`),
    `- Human games: Karabast spectator capture through ${at(report, "windows", "humanGames", "capturedThrough")}; reaches set release order ${at(report, "windows", "humanGames", "reachesOrder")}.`,
    ...Object.entries((at(report, "windows", "decks") ?? {}) as Json).map(
      ([k, w]) => `- Decklists \`${k}\` reach set release order ${at(w, "reachesOrder")}.`,
    ),
    `- Release dates come from the run's expansion index; only ${Object.keys((at(report, "windows", "releaseDatesFromRun") ?? {}) as Json).join(", ") || "none"} carries one. A source also reaches a set when it shows at least 20 uses of that set or a later one, because Karabast ran sets before their street date. A pair whose card a source cannot contain is counted as not observable there, never as unplayed.`,
    `- Simulations: ${at(sims, "gamesUsed")} forceteki bot-vs-bot games used (mirror or winnerless games skipped: ${at(sims, "gamesSkippedMirrorOrNoWinner")}), ${at(sims, "distinctDeckSeats")} distinct deck seats.`,
    "",
    "## Method",
    "",
    "- Units: a decklist (main deck), a human game side, or a simulated decklist seat. Lift = P(A and B) / (P(A) P(B)) over units; log-lift is ln((observed + 0.5) / (expected + 0.5)), which shrinks rare pairs toward 0. Conditioned figures keep only units whose leader and base cover both cards' aspect icons, so the +2 penalty never applies.",
    "- A pair is measured when both cards appear in at least one unit of the source. Pairs counts are emitted pairings (offer card A, want card B); a pairing claimed by several rows counts once overall and once in each row.",
    "- Baselines: (1) each pair's B replaced by a seeded random card of the same type, cost band and aspect icons that A is not paired with; (2) each card's nearest ability-text embedding neighbour (similarity/similar.json).",
    "- Intervals: Wilson 95% for proportions, seeded percentile bootstrap (resampling pairs) for means, medians and ratio estimates; n is the number of pairs (or classes, trios) behind an estimate. Pairs share cards, so they are not independent and the intervals are optimistic. Proportions pooled over pairs count one side or seat once per pair it holds.",
    "- In-game events: the extract records, for every card played from hand, which cards were already on that player's board; the player's leader and base count as always in play.",
    "- Win-rate differences: units holding both cards against units holding exactly one, Mantel-Haenszel risk difference stratified by leader, bootstrapped over pairs.",
    "- Fungible classes: within each leader with at least 20 decks, observed member co-occurrences against the independence expectation; below 1 means members replace each other. Rate similarity is the coefficient of variation of member inclusion rates among aspect-eligible decks.",
    "",
    "## (a) Deck co-inclusion",
    "",
    ...coInclusionBullets(pooled, "Pooled, aspect-conditioned"),
    ...coInclusionBullets(at(decks, "pooled-unconditioned"), "Pooled, unconditioned"),
    ...snapshotSections.flatMap((k) => coInclusionBullets(at(decks, k), `Snapshot ${k.slice(9)}`)),
    "",
    "### Per complementarity row (pooled, conditioned), weakest paired difference first",
    "",
    ...perRowBullets(pooled),
    "",
    "## (b) Human games",
    "",
    ...coInclusionBullets(games, "Same-side co-occurrence, aspect-conditioned"),
    "",
    "### Per complementarity row: co-occurrence, weakest first",
    "",
    ...perRowBullets(games),
    "",
    "### Per complementarity row: played-while-in-play and win rate, lowest interaction rate first",
    "",
    ...interactionBullets(inter),
    "",
    "## (c) Agreement with the pairs-v1 judges",
    "",
    agreementBullets(at(fix, "decksPooledConditioned"), "Decklists"),
    agreementBullets(at(fix, "humanGamesConditioned"), "Human games"),
    "- An AUC above 0.5 means judge-correct pairs co-occur more than judge-wrong ones.",
    "",
    "## (d) Fungible classes",
    "",
    `- ${at(fung, "classesWithTwoOrMoreObservableMembers")} classes have two or more observable members; ${at(fung, "classes", "measured")} have enough expected co-occurrence to measure.`,
    `- Classes: mean log(O/E) ${ci(at(fung, "classes", "meanLogOE"))}, pooled O/E ${fmt(num(at(fung, "classes", "pooledOE")))}, below chance ${pct(at(fung, "classes", "shareBelowChance"))}, median rate CV ${fmt(num(at(fung, "classes", "medianRateCV")))}.`,
    `- Matched random groups: mean log(O/E) ${ci(at(fung, "randomMatchedGroups", "meanLogOE"))}, pooled O/E ${fmt(num(at(fung, "randomMatchedGroups", "pooledOE")))}, below chance ${pct(at(fung, "randomMatchedGroups", "shareBelowChance"))}, median rate CV ${fmt(num(at(fung, "randomMatchedGroups", "medianRateCV")))}.`,
    `- Classes vs random, log(O/E): AUC ${fmt(num(at(fung, "logOEClassesVsRandom", "auc")))}, p ${fmt(num(at(fung, "logOEClassesVsRandom", "p")), 4)}. Rate CV: AUC ${fmt(num(at(fung, "rateCVClassesVsRandom", "auc")))}, p ${fmt(num(at(fung, "rateCVClassesVsRandom", "p")), 4)} (below 0.5 means classes have more similar rates than random groups).`,
    "",
    "## (e) Trios",
    "",
    `- ${at(trios, "trios", "trios")} trios: ${at(trios, "trios", "measured")} measured, ${at(trios, "trios", "notObservable")} not observable, ${at(trios, "trios", "unplayed")} with a card never included; ${at(trios, "trios", "withAllThreeTogether")} appear together in at least one deck.`,
    `- Mean log(O/E) ${ci(at(trios, "trios", "meanLogOE"))}, median ${ci(at(trios, "trios", "medianLogOE"))}, above chance ${pct(at(trios, "trios", "shareAboveChance"))}.`,
    `- Matched random trios: mean log(O/E) ${ci(at(trios, "randomMatched", "meanLogOE"))}, above chance ${pct(at(trios, "randomMatched", "shareAboveChance"))}.`,
    ...Object.keys((at(report, "trios") ?? {}) as Json)
      .filter((k) => k.startsWith("shape:"))
      .map(
        (k) =>
          `- Shape ${k.slice(6)}: ${at(report, "trios", k, "measured")} measured, mean log(O/E) ${ci(at(report, "trios", k, "meanLogOE"))}.`,
      ),
    "",
    "## Engine simulations (separate source)",
    "",
    "- Bot-vs-bot games on the Karabast engine (forceteki). The bots do not build or pilot decks like people, so a pair that wins for bots may only suit the bot's play pattern. The records name decks, not played cards, so only deck-level win rates are available. Never pooled with human play.",
    `- All pairs, seat-games pooled over pairs (not independent): win rate holding both ${pct(at(sims, "all", "pairs", "winRateBoth"))}, holding one ${pct(at(sims, "all", "pairs", "winRateOnlyOne"))}; MH difference by leader ${ci(at(sims, "all", "pairs", "mhRiskDifferenceByLeader"))}; random partners ${ci(at(sims, "all", "randomMatched", "mhRiskDifferenceByLeader"))}.`,
    ...rowNames(sims).map(
      (k) =>
        `- ${k.slice(4)}: MH difference ${ci(at(sims, k, "pairs", "mhRiskDifferenceByLeader"))} vs random ${ci(at(sims, k, "randomMatched", "mhRiskDifferenceByLeader"))}.`,
    ),
    "",
    "## Caveats",
    "",
    "- Co-inclusion measures popularity of a combination, not its strength. Strong staples co-occur with everything in their aspects, which the aspect-conditioned figures and the matched baseline only partly absorb.",
    "- The decklists predate the human games by about three weeks, and both predate the newest sets in the run, so many pairs are not observable at all.",
    "- Win-rate differences are confounded by deck strength and game length (a longer game shows more cards). Leader stratification removes only part of that.",
    "- Human-game sides record only cards that were seen (played, on the board, in the last ten discards), not the full decklist.",
    "",
  ];
  return `${lines.join("\n")}`;
}
