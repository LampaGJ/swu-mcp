---
type: spec
status: active
review_by: 2027-01-31
related: ["docs/decisions.md", "docs/verification/2026-10-31-bot-ladder.md", "docs/research/tournament-winrate-sources.md"]
---

# Sleeper cards, 2026-11-01

## TL;DR

Issue #184 asked for cards that are "surprisingly good if competently played the right way". Measured on 33,227 tournament decklists with a whole-event match record (524 melee.gg Premier events tracked by swumetastats.com, 2025-04-05 to 2026-10-06), 26 cards still legal in Premier pass the false-discovery gate as underplayed winners. Decks with them win clearly more matches than comparable decks without them, yet fewer than half of those decks play them. One of the 26 also holds up inside the same players' own decks: Anakin Skywalker, Champion of Mortis. Decks with it win 2.6 more matches in 100 [95% interval 1.7, 3.5], from 5,487 decks with it at 500 events. The same 394 players win 2.1 more [0.2, 4.1] in the events where they play it. For the other 25, the same-player comparison includes zero, so their advantage may come from who picks them. One card passes the gate as better in skilled hands: Contraband Starhopper. Its advantage among the strongest third of players exceeds that among the weakest third by 12.1 points [6.6, 17.6], with Benjamini-Yekutieli q 0.086, from 96 strong-player and 111 weak-player decks. A label-shuffle run passes 0 of 1,058 cards, so the gate does not manufacture winners from noise. The analysis ships as `sleepers/sleepers.json` in the data run and is served by the `sleeper_cards` tool. Every row is `status: candidate`: an association with honest error bars, not proof of cause.

## Data

Population (D21 tier 1): tournament results joined to decklists and placements. Community lists and computer play are never pooled with it. No Karabast data is read; `tests/meta/no-karabast.test.ts` checks the import closure of the step and the capture.

Capture. `pnpm meta:capture-decklists --from 2024-03-01 --to 2026-11-01` pages `/api/tournaments`, then `/api/decklists?tournamentId=<id>` for every event that lists decklists. It sends 100 rows a page and waits at least 1.1 s between requests (`scripts/meta/capture-decklists.ts:65`). Each body is written unmodified, with an HTTP log line and a sha256 in `manifest.json`. A finished manifest is never overwritten (`scripts/meta/capture-decklists.ts:122`). The capture went into the git-ignored `data/originals/decklists/2026-11-01/`, manifest sha256 741f77e20816. It made 1,059 requests between 19:32:55Z and 19:59:07Z with no failure, refusal or rate limit. The earlier 2026-10-17 deck snapshot was made by a fetcher that was never committed; this script is its committed successor, and the old snapshot is untouched.

Counts. swumetastats lists 1,077 Premier events from 2024-03-01 on, 866 of them with decklists. Those events list 56,743 decklists, and 56,296 came back. 179 events returned a few rows fewer than listed (447 rows in all). One event appeared on two tournament pages, so the list's paging is not fully stable, and one event may be missing. swumetastats tracks no Premier event after 2026-10-06 and no event of any format after 2026-10-07 (its scraper last ran 2026-11-01T12:31Z). The current season, Homeworlds, which started 2026-10-09, therefore has no tournament data yet. The source has nothing before 2025-03.

Decklists per season (captured; season boundaries from `/api/meta-boundaries`): Jump to Lightspeed 1,389; JTL suspension update 2.0 9,448; Legends of the Force 10,139; LOF suspension update 3.0 4,884; Secrets of Power 9,880; A Lawless Time 9,400; Ashes of the Empire 5,968; ASH suspension update 4.0 5,188.

Usable decks. 23,063 decklists carry no match record (most events before November 2025 list placements only) and 6 have no decisive match; all are dropped (`scripts/meta/sleepers.ts:214`). That leaves 33,227 decks. Every leader and base resolved to the card list. A base name that two printings share resolves to its aspects, which is all the analysis needs. A leader listed by both faces is read by its front face, and a letter O typed as a zero is read as an O (`src/meta/decklist-capture.ts:77`). Two cards that share one name (Grassroots Resistance in SEC and ASH) are told apart by the line's printed cost, power and HP (`scripts/meta/sleepers.ts:113`). 780 card lines stay unmapped, mostly "Jar Jar Binks, Mesa Propose", which the 2026-10-16 card list does not hold. Per season, the decks with a match record are: JTL 424 decks at 1 event; JTL 2.0 887 at 5; LOF 147 at 2; LOF 3.0 1,387 at 5; SEC 9,856 at 175; LAW 9,376 at 168; ASH 5,963 at 87; ASH 4.0 5,187 at 81.

## Method

Unit and outcome. The unit is one decklist at one event. The outcome is its match win rate, wins / (wins + losses), with draws left out as swumetastats does.

Comparison. For each card, the comparison groups decks of the same season, leader and base aspects (1,277 groups). Inside each group it takes the match win rate of decks with the card minus decks without it. The groups are pooled with weights n_with × n_without / (n_with + n_without) in decisive matches (`src/meta/sleepers.ts:258`). A card is measured in a scope only with 20 or more decks on each side and 5 or more events with the card. The scopes are the whole field (1,058 cards), each aspect set (26 scopes), and each leader with base aspects (107 scopes, 2,919 rows).

Null model and interval. The null is no difference (gap 0). A seeded bootstrap resamples whole events 400 times, so decks of one event move together (`src/meta/sleepers.ts:653`). The interval is the estimate ± 1.96 bootstrap standard errors (nominal 95%). The p-value is two-sided normal, computed directly as erfc so small values keep their digits (`src/meta/sleepers.ts:76`).

Multiplicity. Each scope is one family. Benjamini-Hochberg q (valid under positive dependence) and Benjamini-Yekutieli q (valid under any dependence) are both stored (`src/meta/sleepers.ts:84`). Cards in one deck move together, and two-sided tests do not satisfy the positive-dependence condition, so the gate reads BY at q ≤ 0.10. Verdicts (`src/meta/sleepers.ts:723`): a sleeper passes the gate with its interval above 0 and is played in under half of comparable decks. A proven winner passes the same way and is played in half or more. A card that loses ground passes the gate with its interval below 0.

Skill. A player's skill is estimated leave-one-event-out. It is their wins above their leader-and-base group's average in their other events, per decisive match, shrunk toward 0 (`src/meta/sleepers.ts:341`). The shrinkage prior comes from the covariance of one player's per-match excess at two different events (`src/meta/sleepers.ts:387`). A first version used the spread of single-player rates, but players who drop after early losses compress that spread, and it estimated no skill at all. The cross-event covariance gives a between-player standard deviation of 9.5 matches in 100 and a prior worth 27.7 matches. 27,610 decks have an estimate. Strong means the top third and weak the bottom third (`src/meta/sleepers.ts:448`). The interaction is the card's pooled gap among strong players minus that among weak players, over groups with both, with its own event bootstrap and BY family. `skilledEdge` needs BY q ≤ 0.10 and the interval above 0 (`src/meta/sleepers.ts:749`). Players are linked by the name the event lists; no name or id is written anywhere (`src/meta/sleepers-schema.ts`).

Selection guards (whole-field scope only):
- Same player: players who played the same leader and base aspects with and without the card, compared within themselves, with a bootstrap over players (`src/meta/sleepers.ts:472`, `src/meta/sleepers.ts:680`). This guard needs at least 10 such players.
- Same build style: the gap inside archetype clusters of the same season, leader and base aspects, made by the meta step's own clustering (879 styles; `scripts/meta/sleepers.ts:269`).
- `selectionWarning`: a verdict whose same-player interval includes 0 (`src/meta/sleepers.ts:750`).

Calibration check. Card lists are shuffled among decks of the same season, leader and base aspects, and the whole-field pass is rerun with 200 resamples (`src/meta/sleepers.ts:770`). 0 of 1,058 cards pass BY and 0 pass BH; the smallest p is 0.00025. Synthetic tests plant known effects and check four things: the underplayed winner is found, the null cards are not, a card that strong players pick but that does nothing shows a smaller same-player gap, and the skill spread is recovered (`tests/meta/sleepers.test.ts`).

Rotation. Spark of Rebellion, Shadows of the Galaxy and Twilight of the Republic left Premier when A Lawless Time released. Their 285 whole-field rows are kept in the false-discovery families, which keeps the gate conservative, and marked `rotated` (`scripts/meta/sleepers.ts:302`). The tool hides them unless `includeRotated` is true.

Simulator view (D21's last tier, kept apart). This view reads the pinned owner-deck swap records `data/pinned/sim-ladder-v1/warrior-deck-{rung1,rung1-controls,rung3,rung3v}.json`. Each swap becomes a paired effect: variant wins minus base wins on the same seeds, with a normal interval from the discordant pairs (`src/meta/sleepers-sim.ts:38`). Where the same swap ran under the rules bot and a lookahead bot, their difference is stored as pilot sensitivity. Caveat (`src/meta/sleepers-sim.ts:27`, issue #183): the lookahead bots see the opponent's hidden cards in their trial games, so their figures are biased.

Reproducibility. The step verifies every raw page against the capture manifest before reading (`scripts/meta/sleepers.ts:165`). It runs as `build:data`'s last step (`scripts/build-data.ts:138`) and ships in the release (`scripts/release-data.ts:28`). Two runs on the same inputs gave a byte-identical `sleepers.json` (sha256 a3a84d42148d, 3.8 MB) and identical replay inputs. The data run's nine audit checks pass with the new folder in place (the audit does not read it).

## Findings

Underplayed winners still legal in Premier (26; best lower bound first, gap in matches per 100, play rate in comparable decks):
- Syndicate Spice Runner: +14.8 [7.7, 22.0], played in 25%, 27 decks with it at 22 events. The widest interval in the list: few decks.
- Stolen AT-Hauler: +7.4 [6.4, 8.4], 47%, 4,518 decks; same players -0.9 [-3.6, 1.8].
- Emissary's Sheathipede: +7.3 [5.8, 8.9], 32%, 2,154 decks; same players -1.2 [-4.3, 1.9].
- Blue Ace, Colorful Racer: +5.7 [4.1, 7.2], 47%; Garindan, Information Broker: +5.6 [4.1, 7.2], 30%; Snub Fighter Squadron: +6.8 [4.0, 9.7], 36%.
- Anakin Skywalker, Champion of Mortis: +2.6 [1.7, 3.5], 34%. The only one whose same-player interval is above 0 (+2.1 [0.2, 4.1], 394 players).

Better in skilled hands: Contraband Starhopper, +12.1 [6.6, 17.6] strong minus weak (BY q 0.086), played in 10.5% of comparable decks. Its overall gap does not pass (+2.3 [-0.2, 4.8]): it pays off for the strongest players and costs the weakest. Across the 493 cards with a skill figure, 18 interaction intervals sit above 0 and 29 below. Chance alone predicts about 12 each way, so there is a slight excess, tilted toward cards that help weaker players more (Stolen AT-Hauler -3.3 [-6.1, -0.4]); no card passes the gate on that side.

Selection is the main alternative explanation. Same-player figures exist for 511 current cards; their sign agrees with the deck-level gap for 296 of them (58%). Of the 123 current cards that lose ground, 57 have a same-player figure and only 2 of those confirm below 0. Most deck-level gaps, positive and negative, therefore mark who plays a card and how well the rest of the deck is built more than what the card adds. The same-build figures stay close to the deck-level gaps (every sleeper's same-build interval is above 0), so the gaps are not explained by build style alone.

Simulator cross-check. Neel, The Cutest Boy is a proven tournament winner (+5.7 [2.9, 8.5], played in 59%). Taking it out of the owner's deck costs 2.2 games in 100 [-0.3, +4.7] under the rules bot, and 10.2 [7.5, 12.8] under the lookahead bot (pilot sensitivity -7.9 [-11.6, -4.3]). The lookahead figure carries the #183 caveat.

The owner's leader. The Warrior, Deft Duelist is a Homeworlds card, newer than the last tracked event, so its leader-and-base scope has no measured card. The tool says so and points to the aspect set (Command, Cunning, Heroism: 1,551 decks). There one card passes the gate as a sleeper: Vernestra Rwoh, Precocious Knight, +6.4 [3.0, 9.8], played in 29%, 212 decks.

## What the design cannot separate

- Cause from marker. Decks with and without a card differ in their other cards. The same-player and same-build guards narrow this, but the same-player check is underpowered: its median interval spans 10.9 points over the 511 current cards that have one.
- Timing. Strong players may add a card exactly when the field suits it. That is indistinguishable here from the card helping them more.
- Opponents. Records are against a deck's whole event, never per matchup.
- Identity. Players are linked by listed name, so namesakes merge and respellings split.
- Era. The analysis pools seasons back to 2025-04, weighted by data, and the newest season has none.
- Survivorship in records. A deck that drops early contributes few matches; match weighting follows swumetastats' convention and does not model drops.

Open question: should the tool rank by the same-player figure when it exists, or keep the deck-level lower bound with same-player-confirmed cards first (current)?
