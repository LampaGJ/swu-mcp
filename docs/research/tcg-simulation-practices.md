---
type: research
status: draft
review_by: 2026-12-31
related: ["#104", "#58"]
---

# Simulation practices for TCG deck building

## TL;DR

Eight primary sources were fetched and read on 2026-10-30; everything else in the brief is marked `unverified`. Four findings matter for swu-mcp. The one published simulator-as-fitness method (Garcia-Sanchez et al., Hearthstone) scores a deck by wins against a fixed panel of human decks, with at least 16 games per opponent, and also ranks by spread across opponents. The Legends of Code and Magic competition shows copyable variance controls: identical seeds, mirrored seats, published raw data. 17Lands itself warns that drawn-card win rates are confounded, and a simulator can remove that confound by swapping one card under paired seeds. The SWU Comprehensive Rules allow a 10-card sideboard in Premier and Eternal and use a ban-and-pick best-of-three in Trilogy. Bot choice changes deck results, so every simulated number must name its bot policy.

## Findings

Sub-claims (Step 1): sub-claim 1: per-card evidence metrics; sub-claim 2: simulation engines with AI players; sub-claim 3: research on deck building by simulation; sub-claim 4: statistical practice; sub-claim 5: sideboarding and best-of-three. Wording is paraphrased unless a rule number is given.

### What each source says

- 17Lands defines GIH WR as the win rate when a card was drawn at all (opening hand or later), OH WR as the win rate when it was in the opening hand, and GD WR as the win rate when it was drawn later. The post does not define IWD. https://blog.17lands.com/posts/using-win-rate-data/ [sub-claim 1: per-card evidence metrics]
- The same post lists caveats: cards are not equally good in every archetype, long games let a deck draw more cards (reverse causation), fast losses leave cards undrawn, the data skews to average-to-good players, and a higher win rate for X than Y does not make X better. It states no sample-size rule. https://blog.17lands.com/posts/using-win-rate-data/ [sub-claim 1: per-card evidence metrics]
- An April 2026 statistics paper treats 17Lands data as purely observational and names confounding, selection effects and post-treatment conditioning, while arguing it is still usable for causal estimates. The abstract does not mention GIH WR or IWD. https://arxiv.org/abs/2604.18314 [sub-claim 1: per-card evidence metrics]
- HSReplay defines mulligan winrate as the average winrate of games where the card ended in the opening hand, winrate when drawn as games where it was drawn at any point or started in hand, and kept percentage as how often it was kept when offered. The page states no controls or sample thresholds; mulligan columns are Premium-only. https://articles.hsreplay.net/2020/07/23/card-mulligan-data/ [sub-claim 1: per-card evidence metrics]
- unverified: HSReplay played winrate and deck-winrate-with-card definitions, Untapped.gg, Marvel Snap sites and Legends of Runeterra sites. Only third-party snippets surfaced; no originating methodology page was fetched. [sub-claim 1: per-card evidence metrics]
- Forge documents a `sim` mode that runs AI-versus-AI matches with no GUI, suited to headless servers. Flags cover deck files (`-d`), a deck directory (`-D`), N games (`-n`), best-of-M (`-m`), format (`-f`), result-only output (`-q`), a per-match time cap that calls a draw (`-c`, default 120 s) and tournament type (`-t`: Bracket, RoundRobin, Swiss). The page does not mention random seeds. https://github.com/Card-Forge/forge/wiki/AI [sub-claim 2: simulation engines with AI players]
- The same Forge page says the AI is heuristic, strongest with aggro and midrange, poor to okay with control, and bad with most combo decks, and that its weaknesses are easy to exploit. https://github.com/Card-Forge/forge/wiki/AI [sub-claim 2: simulation engines with AI players]
- MetaStone, an open-source Hearthstone simulator, offers four AI behaviours: random play, greedy per move, greedy per turn (GOT) and flat Monte Carlo (FMC). In an 11,520-game round robin of nine human decks, GOT won 4,320 games and FMC 1,911, so more search did not mean a stronger bot there. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 2: simulation engines with AI players]
- In the same data one deck's result depends on the bot: Oil Rogue won 52 games under FMC and 419 under GOT. A deck result is a deck-plus-bot result. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 2: simulation engines with AI players]
- The Hearthstone AI Competition runs on the community SabberStone simulator. Decks have 30 cards, agents get 60 seconds of compute, games stop at 50 turns as a draw, and agents rank by round-robin average win rate. The paper gives no seeding statement and no games-per-matchup count. https://ar5iv.arxiv.org/html/1906.04238 [sub-claim 2: simulation engines with AI players]
- The Strategy Card Game AI Competition (Legends of Code and Magic) used seeds that fix card order, ten games per deck on the same seed, and mirrored matches for first-player balance. Search agents won every v1.2 edition. https://ar5iv.arxiv.org/html/2305.11814 [sub-claim 2: simulation engines with AI players]
- unverified: XMage, Cockatrice (the brief says it has no AI; no primary was fetched to confirm), Pokemon TCG simulators, and any SWU simulator other than forceteki. [sub-claim 2: simulation engines with AI players]
- García-Sánchez et al. (2018) evolve 30-card Hearthstone decks with the muGP framework. Fitness is lexicographic: fewest rule errors first, then most victories against the target metagame, then lowest standard deviation of victories across opponents as a versatility measure. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 3: research on deck building by simulation]
- Each candidate plays 16 games against each of nine human-designed decks from one season, using the best AI (GOT). The paper says one game is not statistically significant and recommends at least 16 games per opponent, citing an outside reference not followed here. Its abstract reports that evolved decks, checked by an expert, beat human-made decks when the AI played them. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 4: statistical practice]
- A Smart Mutation operator swaps a card for one within one point of its cost, copying how humans edit decks and shrinking the search. The paper adds that a single fitness evaluation vastly dominates the algorithm's cost. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 3: research on deck building by simulation]
- Overfitting control in the competition: in the premade-deck track only three of six decks are known to developers before final submission. https://ar5iv.arxiv.org/html/1906.04238 [sub-claim 3: research on deck building by simulation]
- unverified: Bhatt et al. (Exploring the Hearthstone Deck Space), Fontaine et al. (MAP-Elites), Ward and Cowling, DeckScope, Riot or Blizzard balance talks and AlphaStar self-play caveats. Their pages appeared only as search snippets. [sub-claim 3: research on deck building by simulation]
- Legends of Code and Magic reduces noise with fixed seeds, repeated games and mirroring, reports plain win rates with no confidence intervals or significance tests, and advises publishing code, configs, raw data and aggregation scripts. https://ar5iv.arxiv.org/html/2305.11814 [sub-claim 4: statistical practice]
- unverified: Wilson and Bayesian intervals, common random numbers as a named design, Bradley-Terry or Elo from round robins, Karsten hypergeometric land counts, and the goldfish measure. [sub-claim 4: statistical practice]
- SWU Comprehensive Rules 9.2.2.A to C: a Premier or Eternal deck has exactly 1 leader, exactly 1 base, at least 50 other cards, at most 3 copies of any unit, event or upgrade, and may be accompanied by a sideboard of up to 10 cards. https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf [sub-claim 5: sideboarding and best-of-three]
- SWU Comprehensive Rules 9.3: Trilogy uses three decks and no sideboard (9.3.2.C). Its best-of-three opens with a Ban Phase where each player secretly bans one opposing deck; a winning deck is set aside and the loser may repeat or switch (9.3.3.A to C). This is the ban-and-pick analogue. https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf [sub-claim 5: sideboarding and best-of-three]
- unverified: how sideboard swaps between games work in Premier and Eternal, and how MTG tools or research plan sideboards. CR pages 44 to 50 state the 10-card limit but no swap procedure; no tournament rules document was fetched. [sub-claim 5: sideboarding and best-of-three]

### Practices to adopt or adapt (numbered)

1. Score a deck variant as win rate against a fixed panel of real tournament decklists and report per-opponent spread, not only the mean (adapt: the panel is tournament decks, per the play-data precedence). Epic #104. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 3: research on deck building by simulation]
2. Treat 16 games per opponent as a floor, not a target; run many more and show an interval (interval method unverified). Epic #104. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 4: statistical practice]
3. Compare variants on identical seeds and mirror every pairing so each deck plays both seats (adopt; a paired design in practice). Epic #104. https://ar5iv.arxiv.org/html/2305.11814 [sub-claim 4: statistical practice]
4. Hold out part of the decklist panel (for example whole events) while tuning bot policy or variants, then score on the held-out decks (adapt). Epic #104. https://ar5iv.arxiv.org/html/1906.04238 [sub-claim 3: research on deck building by simulation]
5. Tag every simulated number with its bot policy and report per policy, because one deck's wins moved eightfold between bots. Epic #104. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 2: simulation engines with AI players]
6. Publish per-card splits (opening hand, drawn later, drawn at all) with game counts and a leader or archetype breakdown (adopt). Epic #58. https://blog.17lands.com/posts/using-win-rate-data/ [sub-claim 1: per-card evidence metrics]
7. Replace the observational drawn-minus-not-drawn comparison with a swap test: same seeds, one card swapped, win-rate delta. This sidesteps confounding (adapt; the swap design is our inference, the confounding is the paper's). Epic #58. https://arxiv.org/abs/2604.18314 [sub-claim 1: per-card evidence metrics]
8. Give the batch runner Forge-like controls: deck directory, N games or best-of-M, round-robin mode, result-only output with full decision logs on request, and a per-match time cap that records a draw (adopt). Epic #104. https://github.com/Card-Forge/forge/wiki/AI [sub-claim 2: simulation engines with AI players]
9. Put deck legality ahead of win rate in any search or ranking, using CR 9.2.2 limits (adopt). Epic #58. https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf [sub-claim 5: sideboarding and best-of-three]
10. Generate neighbour decks by swapping cards of similar cost and matching aspect, not any-for-any (adapt). Epic #58. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 3: research on deck building by simulation]
11. Model Trilogy as a match layer above per-game win rates: ban phase, then deck switch after a loss (adapt). Epic #104. https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf [sub-claim 5: sideboarding and best-of-three]

### Practices to skip

1. Skip genetic-algorithm deck search for now: the authors say fitness evaluation dominates cost, and our bots are not yet validated. Revisit once #104 has a bot ladder. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 3: research on deck building by simulation]
2. Skip assuming a deeper-search bot is stronger: in MetaStone's test greedy per-turn beat flat Monte Carlo. Measure bot strength by round robin. https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf [sub-claim 2: simulation engines with AI players]
3. Skip ranking cards by raw drawn-versus-not-drawn gaps without confound handling; 17Lands warns against reading win-rate gaps as quality. https://blog.17lands.com/posts/using-win-rate-data/ [sub-claim 1: per-card evidence metrics]

## Gaps

- unverified: https://www.17lands.com/metrics_definitions (fetch returned only the page title; the IWD definition, and a search snippet claiming a rename to Improvement In Hand in August 2025, are not confirmed).
- unverified: https://www.17lands.com/public_datasets (fetch returned only the page title; dataset field definitions not read).
- unverified: https://projecteuclid.org/journals/statistical-science/volume-16/issue-2/Interval-Estimation-for-a-Binomial-Proportion/10.1214/ss/1009213286.full (fetch returned empty; the Wilson interval is not sourced here).
- Source count is 8 against the aim of 12 to 20: the 12-fetch cap was reached and three fetches yielded no usable text.
- Forceteki seeding and determinism were not checked in this run; see docs/research/forceteki-simulation.md for the repo's own notes.

## Confidence

Low to medium. Hearthstone deck-evolution methods and the SWU rules were read from page images of the originating PDFs. The Forge, HS-AI Competition, Legends of Code and Magic, 17Lands and HSReplay details come from fetch-tool summaries of the pages, so they are paraphrases. Statistics, Untapped, Marvel Snap, Legends of Runeterra, XMage, Cockatrice and Pokemon coverage is missing.

## Verified vs Unverified

Verified: 17 findings bullets and 14 numbered lines (11 adopt, 3 skip), each with one fetched URL. Unverified: 8 bullets (5 in Findings, 3 in Gaps), covering the 3 failed fetches plus 5 sub-claim holes.

## Reproduction

Searches, in order:
- S1: 17Lands metrics definitions GIH WR OH WR GD WR IWD (no useful results)
- S2: HSReplay card statistics mulligan winrate drawn winrate played winrate definition
- S3: Evolving Hearthstone decks evolutionary algorithm simulator fitness Garcia-Sanchez Bhatt Exploring the Hearthstone Deck Space
- S4 (extended): 17Lands improvement when drawn games in hand win rate explained selection bias player skill caveats
- S5: Forge MTG command line sim mode simulate games decks headless wiki Card-Forge
- S6: Hearthstone AI Competition Dockhorn Mostaghim deck building track MCTS agents paper arXiv
- S7: Frank Karsten how many lands do you need hypergeometric distribution Magic article (secondary results only, none cited)

Fetches, in order:
- F1 failed (title only): https://www.17lands.com/metrics_definitions
- F2 ok: https://articles.hsreplay.net/2020/07/23/card-mulligan-data/
- F3 ok (binary PDF, saved and read as page images, Read pages 1-10 and 12-16): https://iris.polito.it/bitstream/11583/2706329/1/2018-kbsys.pdf
- F4 failed (title only): https://www.17lands.com/public_datasets
- F5 ok: https://blog.17lands.com/posts/using-win-rate-data/
- F6 ok: https://arxiv.org/abs/2604.18314
- F7 ok, no relevant content (README only, not cited): https://github.com/Card-Forge/forge
- F8 ok: https://github.com/Card-Forge/forge/wiki/AI
- F9 ok: https://ar5iv.arxiv.org/html/1906.04238
- F10 ok (binary PDF, saved and read as page images, Read pages 44-50): https://cdn.starwarsunlimited.com//SWH_Comp_Rules_v8_0_e26603c6e1.pdf
- F11 ok: https://ar5iv.arxiv.org/html/2305.11814
- F12 failed (empty): https://projecteuclid.org/journals/statistical-science/volume-16/issue-2/Interval-Estimation-for-a-Binomial-Proportion/10.1214/ss/1009213286.full

Local reads: Read of the report path (not found, path free); Glob of docs/research; Read of docs/research/official-rules-sources.md (source of the CR URL).
