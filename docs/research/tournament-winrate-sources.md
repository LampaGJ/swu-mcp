---
type: report
status: active
review_by: 2027-01-17
question: LampaGJ/swu-mcp#26 - public sources of SWU tournament results (match/deck level) and how to access them
as_of: 2026-10-17
---

# SWU tournament win-rate sources

## TL;DR

Best tournament source today is swumetastats.com. It has a documented, unauthenticated API over melee.gg tournament data, with leader+base matchup win-rates, standings joined to full decklists, and tournament metadata. In the last 90 days (2026-07-19 to 2026-10-17) it lists 177 Premier tournaments, one with 1,485 players. Its limit: it exposes matchups as aggregate wins/losses/draws per leader-base pair and exposes no round-by-round records. Round-level pairings with both players' decks are the owner's top priority. The one candidate found is SWU Stats' `GetMeleeTournament.php` with an `include_matchups` option. I could not probe it (fetch budget spent), so what it returns is unverified. melee.gg itself returned HTTP 403 to my fetches, so the raw pairings endpoints are also unverified.

Ranking, tournament first:
1. swumetastats.com API (tournament only; aggregate matchups + decklists with standing).
2. SWU Stats `GetMeleeTournament.php` (tournament only; possible round matchups; unverified).
3. melee.gg direct (tournament only; blocked to my client; unverified).
Fallback labelled casual online play: SWU Stats `MetaMatchupStatsAPI.php` and Karabast-style game results.

Local context (read, not cited as web evidence): the fresh deck fetch manifest at `/Volumes/Local Files/Projects/swu-mcp/data/originals/decks/2026-10-17/manifest.json` shows the swumetastats API already used (22,851 accepted decks), with monthly accepted counts of 1,599 (Jul), 4,259 (Aug) and 3,708 (Sep). The older scrapers documented at `/Volumes/Models/swu-data/docs/DECK_DATA_SOURCES.md` took decklists only, via swu-competitivehub and the melee.gg deck page HTML.

## Findings

Sub-claims: (1) "round-level results with both players' decks"; (2) "aggregate leader-vs-leader sources and access"; (3) "tournament vs casual"; (4) "other platforms"; (5) "ranking, sample size, join keys".

- swumetastats.com publishes an OpenAPI 3.1 spec: no authentication, rate limits not documented, license line says data is sourced from Melee.gg tournament results, contact listed. Eleven endpoints: meta-boundaries, archetypes, archetype detail, archetype-trends, tournaments, decklists, cards, matchups, tierlist, leader-trends, players/search. Parameters are `format` (Premier/Eternal), `startDate`, `endDate`, `skip`, `take`. [sub-claim 2: aggregate leader-vs-leader sources and access] https://swumetastats.com/openapi.json
- `GET /api/matchups` returned rows per leader+base against opponent leader+base, each with `wins`, `losses`, `draws`, `games`, `winRate`, `gameWins`, `gameLosses`, `gameDraws`, `totalGames`, `gameWinRate`, plus aspects and base groups. Sample (window 2026-07-19 to 2026-10-17, `minPlayers=5`): Admiral Piett / Nevarro City, Restored versus Luke Skywalker / Data Vault, 38 wins, 9 losses, 3 draws over 50 matches, game record 80-28-9. The full response is about 6.9 million characters, so cache it locally. [sub-claim 2: aggregate leader-vs-leader sources and access] https://swumetastats.com/api/matchups?format=Premier&startDate=2026-07-19&endDate=2026-10-17&minPlayers=5
- Coverage notes derived from the spec: matchups are aggregate counts; no endpoint exposes rounds or individual games; the players endpoint gives only totals. So swumetastats alone cannot supply round-level results. [sub-claim 1: round-level results with both players' decks] https://swumetastats.com/openapi.json
- `GET /api/tournaments` returned `totalCount` 177 for Premier events in 2026-07-19 to 2026-10-17. Each event has `id`, `meleeId`, `name`, `startDate`, `playerCount`, `type` (for example Planetary Qualifier, Galactic Last Chance Qualifier), `official`, `status`, location fields and `_count` of `decklists` and `standings`. Sample: the 2026-10-06 Galactic Championship Last Chance Qualifier had 1,485 players, 1,450 decklists, `meleeId` 403891. A small Planetary Qualifier with 18 players had 0 decklists, so deck coverage varies by event. [sub-claim 5: ranking, sample size, join keys] https://swumetastats.com/api/tournaments?format=Premier&startDate=2026-07-19&endDate=2026-10-17&skip=0&take=5
- Filtering the same endpoint by `meleeId` returns standings entries with `id`, a `player` object, and a `decklist` object holding `guid`, `leaderName`, `baseName`, `leaderCard` and `baseCard`. The standing entries carry no rank, points, record or per-opponent data in what the fetch returned. This gives the join: tournament `meleeId` + player + decklist `guid`. [sub-claim 5: ranking, sample size, join keys] https://swumetastats.com/api/tournaments?meleeId=468379
- `GET /api/decklists` returns `id`, `guid`, `standing` (placement), leader and base cards, `tournament{name,startDate}`, `player{name}` and card lines with `section` (Leader, Base, MainBoard, SideBoard) and `count`; filters include `placement` and `tournamentId`. Use `guid` as the deck key. [sub-claim 5: ranking, sample size, join keys] https://swumetastats.com/openapi.json
- robots.txt on swumetastats.com allows all paths except two test paths; no crawl delay; sitemap listed. [sub-claim 2: aggregate leader-vs-leader sources and access] https://swumetastats.com/robots.txt
- The site snapshot page says its source is tournament results from all tracked Melee.gg events, with archetype win rate, Top 8 conversion and meta share, and a matchup matrix view; page last updated 2026-10-17 (fresh). It is tournament play, not casual. [sub-claim 3: tournament vs casual] https://www.swumetastats.com/meta/snapshot
- SWU Stats documents (APIs page) endpoints with no auth stated for the stats ones: `MetaMatchupStatsAPI.php` (whole-meta matchup grid, optional week range, `groupByWeek`, `format`), `DeckMetaMatchupStatsAPI.php` (one `leaderID`+`baseID` against others), `DeckMetaStatsAPI.php`, `CardMetaStatsAPI.php`. These are game results written by `SubmitGameResult.php` with an API key, so they are online-game data (casual or untagged), not tournament. The page does not name Karabast or Petranaki. Terms: free use with visible credit to SWU Stats; high-volume users should contact the site. [sub-claim 3: tournament vs casual] https://swustats.net/TCGEngine/Stats/APIs.php
- The same SWU Stats page documents `APIs/GetMeleeTournaments.php` (list, `limit` default 50, `offset`, date range, `format`) and `APIs/GetMeleeTournament.php` (needs `id`; optional `include_matchups`), described as returning standings, tiebreakers and matchups. This is the only candidate found for round-level tournament matchups. Response shape, round granularity and whether decks are attached were not probed. [sub-claim 1: round-level results with both players' decks] https://swustats.net/TCGEngine/Stats/APIs.php
- The SWU Stats home page has Deck Stats, Card Stats and Melee Tournaments sections and says it is open source on a generic TCG engine; it does not state whether its deck stats come from tournaments or online games. [sub-claim 3: tournament vs casual] https://swustats.net
- Limitless organizer docs list Star Wars: Unlimited among 12 integrated games and say tournament metagame analysis tracks archetype performance, matchups and card counts from submitted decklists. No public API or export was described on that page. Whether Limitless hosts public SWU event data was not checked. [sub-claim 4: other platforms] https://docs.limitlesstcg.com/organizer
- unverified: melee.gg tournament page (melee.gg/Tournament/View/403891) returned HTTP 403 to my fetch, so round list, pairings endpoints, decklist links and field names on melee.gg are not confirmed. [sub-claim 1: round-level results with both players' decks]
- unverified: melee.gg robots.txt (melee.gg/robots.txt) returned HTTP 403, so its crawl rules and terms are not confirmed. [sub-claim 1: round-level results with both players' decks]
- unverified: swu-competitivehub.com (Meta set 2 page and decklists listing) was not fetched this run; only a search-result pointer exists, so its data fields, update date and access terms are not confirmed. [sub-claim 4: other platforms]
- unverified: SWUDB meta pages, official FFG/Asmodee event locator or Organized Play results, Garbage Rollers or Discord-published spreadsheets, Karabast/Petranaki data exports, and Bandai TCG+-style store apps were not fetched this run; no primary source for them was reached. [sub-claim 4: other platforms]

## Gaps

- Round-by-round pairings with both players' decks: not confirmed from any fetched source. Test `GetMeleeTournament.php?id=<meleeId>&include_matchups=1` on swustats.net, and melee.gg's own pairing endpoints seen in browser network calls. Needs a browser session or different client because melee.gg returned 403.
- 90-day deck count: only the monthly manifest counts above (Jul 1,599; Aug 4,259; Sep 3,708 accepted decks) and 177 tournaments are known; October partial count and exact 90-day deck total were not computed.
- Match volume for the 90-day matrix was not summed (response too large to read).
- Rate limits for swumetastats and SWU Stats are undocumented; the earlier fetch used at least 1.1 s between requests per host.
- The fetch budget (12) was exhausted, which blocked probing `GetMeleeTournament.php`.
- No personal data beyond schema field names is included here.

## Confidence

Medium for swumetastats (spec and live samples read directly). Low for round-level results (nothing confirmed). Low for the other sources (not reached).

## Recommendation

(a) Leader-vs-leader matchup win rates: 1) swumetastats `/api/matchups` (tournament, aggregate, fresh to 2026-10-17); 2) SWU Stats `MetaMatchupStatsAPI.php`, labelled casual online-game fallback; 3) Limitless metagame pages if public SWU events exist (unchecked).

(b) Per-deck results with full decklists: 1) swumetastats `/api/decklists` (card lines, placement, tournament, player); 2) swumetastats tournaments-by-`meleeId` standings for the event join; 3) swu-competitivehub / melee.gg deck page (already scraped by the older pipeline).

Round-level results, exactly: list events via swumetastats `/api/tournaments` for the last 90 days to get `meleeId`; for each, call SWU Stats `GetMeleeTournament.php?id=<meleeId>&include_matchups=1` and check whether rows carry both players and rounds; join to decks through the swumetastats standings entry (player + decklist `guid`). If that returns only aggregates, the fallback is melee.gg's own round pairing JSON from a browser-captured session, paired to decks by the same `meleeId` and `guid`. Realistic sample: 177 tournaments in the last 90 days, but only events with decklists count (the 1,485-player event has 1,450 decks; small events can have none). Expect roughly 9,500 or more decklists for July to September combined, pending a clean 90-day recount.

Join keys: event = `meleeId` (also swumetastats `id`); deck = `guid`; player = `player` object on the standing entry (name/username, not reproduced here).

## Verified vs Unverified

Verified findings bullets: 11. Unverified bullets: 4 (melee.gg tournament page, melee.gg robots.txt, swu-competitivehub, and the grouped not-fetched sources).

## Reproduction

Searches, in order:
1. Star Wars Unlimited tournament results melee.gg matchup win rates leader metagame
2. swu-competitivehub.com metastats leader win rate tournaments
3. melee.gg API Match/GetRoundMatches round pairings JSON endpoint scraper tournament
4. Star Wars Unlimited Karabast swustats.net stats API online games Petranaki leader win rate
5. Limitless TCG Star Wars Unlimited OR "Garbage Rollers" SWU tournament data spreadsheet matchup

Local reads: output path (not found, free); /Volumes/Models/swu-data/docs/DECK_DATA_SOURCES.md (ok); manifest.json (ok, first 60 lines; first read too large).

Fetch log, in order:
1. https://www.swumetastats.com/meta/snapshot - ok
2. https://swumetastats.com/openapi.json - ok
3. https://swumetastats.com/llms.txt - ok (index only)
4. https://swumetastats.com/api/matchups?format=Premier&startDate=2026-07-19&endDate=2026-10-17&minPlayers=5 - ok (truncated at 100,000 of 6.9M characters)
5. https://swumetastats.com/api/tournaments?format=Premier&startDate=2026-07-19&endDate=2026-10-17&skip=0&take=5 - ok
6. https://swumetastats.com/robots.txt - ok
7. https://melee.gg/Tournament/View/403891 - failed (403)
8. https://melee.gg/robots.txt - failed (403)
9. https://swumetastats.com/api/tournaments?meleeId=468379 - ok
10. https://swustats.net - ok (truncated)
11. https://docs.limitlesstcg.com/organizer - ok
12. https://swustats.net/TCGEngine/Stats/APIs.php - ok

Notes: WebFetch returns model summaries, so no verbatim quotes are used; probes were few and sequential via WebFetch, whose user agent I cannot set.
