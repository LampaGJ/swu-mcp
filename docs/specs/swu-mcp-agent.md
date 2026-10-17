---
type: spec
status: active
title: SWU strategist agent that fully uses swu-mcp
goal: A Fable-model agent template, built with the llm-agent-maker (/birth), that answers Star Wars Unlimited deckbuilding, rules, synergy, collecting and trading questions by driving every swu-mcp tool, resource and prompt correctly, and never claims more than the data supports.
items:
  - id: capability-map
    title: Runtime map of tools, resources and prompts
    tier: architecture
    needs: []
  - id: trust-model
    title: Accuracy tiers and the evidence-confirmation protocol
    tier: architecture
    needs: []
  - id: rules-protocol
    title: Rules and rulings answering protocol
    tier: feature
    needs: [capability-map, trust-model]
  - id: synergy-discovery
    title: Pairings, trios, kin and overlooked-card discovery
    tier: feature
    needs: [capability-map, trust-model]
  - id: deckbuilding-workflows
    title: Deck building, audit and legality workflows
    tier: feature
    needs: [capability-map, trust-model, synergy-discovery]
  - id: meta-defense
    title: Meta archetypes, threats and answers
    tier: feature
    needs: [capability-map, trust-model, synergy-discovery]
  - id: collector-market-workflows
    title: Prices, value, trades and collection gaps
    tier: feature
    needs: [capability-map, trust-model]
  - id: limits-and-degradation
    title: Data limits, missing tools and version drift
    tier: feature
    needs: [capability-map, trust-model]
  - id: validation-suite
    title: Scenario suite the template is validated against
    tier: feature
    needs: [rules-protocol, synergy-discovery, deckbuilding-workflows, meta-defense, collector-market-workflows, limits-and-degradation]
  - id: answer-style
    title: Answer format for players and for other agents
    tier: polish
    needs: [validation-suite]
constraints:
  - swu-mcp is read-only; the agent never claims to change data, decks or prices.
  - Scores are deterministic outputs of the rubric; the agent reports them and never re-scores cards by its own judgment.
  - Card text, rulings and rule sections are quoted from tool output, never recalled from memory.
  - Every pairing, trio and substitute is presented as a candidate until its clause evidence has been checked.
  - Every substantive answer names the data version (data_version tool) it rests on.
  - The agent reads its tool guidance at runtime (swu://usage-guide, tools/list) instead of baking tool names into its prompt, so it does not drift as the server grows.
  - Model is Fable, by the owner's request for this agent.
tracker: github
related: ["#5", "#16", "#18", "#19", "#20", "#25"]
review_by: 2027-01-17
---

# SWU strategist agent that fully uses swu-mcp

Context for /birth: swu-mcp (github.com/LampaGJ/swu-mcp, site https://lampagj.github.io/swu-mcp/) is a public, read-only MCP server for Star Wars: Unlimited (SWU). It serves 48 tools (cards and search, value, text features, synergy, substitutes, market and play data, rules, similarity, sets and legality, decks and trades, meta defense, provenance), resources (`rules://core-primer`, `swu://rubric`, `swu://glossary`, `swu://usage-guide`, `swu://rules/{section}`) and prompts (`rules_question`, `build_deck_for_leader`, `meta_defense`). Results are TOON tables. The README tool list and `swu://usage-guide` are the authoritative catalogue. Measured accuracy is in `docs/verification/`.

## capability-map — Runtime map of tools, resources and prompts

**Goal**: The agent knows which tool answers which question, in what order to call them and what each costs in tokens. It learns this from the live server at session start, not from a frozen list, so new tools (#19 `leader_cards`, #20 `overlooked_cards`, #16 remote endpoint) are picked up without a rebuild.

**Acceptance**:
- At the start of a task the agent reads `swu://usage-guide` and the tools list, and states which tool families are present.
- For each of these question types the template names the first tool to call and the follow-ups: card lookup by fuzzy name, card value, rules question, combo search, deck check, price or trade, set or format legality, "what else does this".
- It resolves names with `resolve_card_name` or `get_cards_batch` before any card-specific call, and passes cardKeys after that.
- It uses `limit`, `fields` and `evidence: false` to keep responses small when evidence is not needed. It never calls one tool per card where a batch tool exists.

**Touches**: agent template (Instructions and Tools sections); reads `swu://usage-guide`, README tool list.

**Open gaps**: whether /birth should embed a static fallback map for clients that cannot read MCP resources.

## trust-model — Accuracy tiers and the evidence-confirmation protocol

**Goal**: The agent weighs each kind of output by how accurate it has been measured to be, and confirms model-shaped claims against quoted card text before presenting them as advice.

**Acceptance**:
- The template encodes four tiers:
  - **Exact:** card fields, prices, play statistics, rulings and rule sections. These are audited byte for byte against the originals.
  - **Deterministic:** rubric scores. They are reproducible, but they rank cards only within a card type.
  - **Parsed:** card features. About 1 card in 5 has an error.
  - **Candidate:** pairings, trios and substitutes. About 74% are precise on the pairs-v1 benchmark: about 70% for mechanical links and about 94% for obvious trait-only (tribal) links. Some rows are weaker (draw, discard, ramp).
- For every candidate it shows, the agent reads both clause texts in the evidence and drops or flags any link the text does not support.
- When a pairing row's measured precision is available (pairs-v1, and the real-play benchmark from #18), the agent mentions weak rows.
- The agent does not repeat a candidate's `reason` string as fact without the evidence check.

**Touches**: agent template (trust and verification section); `docs/verification/2026-10-17-pair-fixture.md`, `docs/verification/2026-10-17-round2.md`.

**Open gaps**: real-play numbers (#18) are not landed yet; the template should read them from the server or docs once they exist rather than hard-coding them.

## rules-protocol — Rules and rulings answering protocol

**Goal**: Rules answers are correct, cited and quoted. Ambiguity is stated rather than resolved by guesswork.

**Acceptance**:
- The agent reads `rules_core` (or `rules://core-primer`) before its first rules answer in a session, then uses `rules_search`, `get_rule`, `keyword_rules`, `card_rulings` and `search_rulings`.
- Every rules answer cites section ids, and the dates of any rulings used, and quotes the deciding sentence.
- It reports `rules_version` and says when a newer Comprehensive Rules release may exist (`rules:check` is manual).
- When the rules do not settle a question, it says so and names the nearest sections, and does not invent a ruling.

**Touches**: agent template (rules section); `.claude/skills/swu-rules/SKILL.md` as prior art; prompt `rules_question`.

**Open gaps**: none

## synergy-discovery — Pairings, trios, kin and overlooked-card discovery

**Goal**: The agent finds non-obvious, real interactions: enabler-to-payoff pairs, low-cost trios, cards that do the same job under different names, and cards that are rarely played but should be because of an interaction.

**Acceptance**:
- It combines `find_pairings`, `find_trios`, `explain_synergy`, `kin_cards`, `similar_cards`, `cluster` and `fungible_substitutes`. It knows that kin is surface-blind, which makes it good for non-obvious substitutes, and that similar is literal.
- When `leader_cards` and `overlooked_cards` exist (#19, #20), it uses them for "what am I missing with leader X". Each suggestion shows the interaction evidence, how often the card is played, and the row precision.
- Each recommended combo lists its cards, the link, both quoted clauses, the aspect penalty and the total cost.
- It never presents more than the user asked for, and ranks by the tool's score, not its own taste.

**Touches**: agent template (synergy section); tools in `src/tools/synergy.ts` and `src/tools/similarity.ts`; #19, #20.

**Open gaps**: `leader_cards` and `overlooked_cards` are not built yet; the template must work without them and use them when tools/list shows them.

## deckbuilding-workflows — Deck building, audit and legality workflows

**Goal**: The agent helps build, check and improve a Premier deck end to end, starting from a leader or from a pasted decklist.

**Acceptance**:
- It parses a pasted decklist into `{card, count}` and resolves names. Unresolved or ambiguous names are reported back to the user, not guessed.
- It runs `deck_legality_check` and cites the CR sections it returns. It runs `deck_audit` for the curve, aspect penalties, orphan wants and role gaps.
- It suggests changes with `suggest_leader_base`, `playable_cards`, `fungible_in_deck` and `budget_alternatives`, each change with its reason and evidence.
- It follows the `build_deck_for_leader` prompt when asked to build from a leader.
- It states the legality limits the tool reports: no ban list, no sideboard check, no date-specific legality.

**Touches**: agent template (deckbuilding section); `src/tools/deck.ts`; prompt `build_deck_for_leader`.

**Open gaps**: none

## meta-defense — Meta archetypes, threats and answers

**Goal**: Whatever the user's deck does, the agent finds what it must include to beat the archetypes people are winning with now, and says which population and outcome source each figure rests on.

**Acceptance**:
- It follows the `meta_defense` prompt (or the `.claude/skills/swu-meta-defense` skill): `meta_archetypes`, then `meta_threats` on the archetypes that matter, then `meta_answers` for the user's leader and base or decklist, then checks each kept answer's clause evidence (`card_features`, `keyword_rules`, `card_rulings`), then `deck_audit` and `deck_legality_check` with the proposed swaps.
- It names the population: tournament decklists weighted by placement are primary; community lists are a separate, labelled view or fallback. Every win rate comes from swumetastats (melee.gg tournaments): leader and base-aspect matchups for archetype strength, and deck evidence (comparable decks with and without the card) for answers. It never presents deck evidence as a rate against an archetype, because opponents are not known per match.
- Every answer is a candidate until its clause is checked; every win rate carries its source, window, n and 95% interval.
- It reports coverage as share of the meta reached, never as a win probability, and, when asked how far the answers can be trusted, says the outcome benchmark is local-only (`docs/verification/meta-defense-2026-10-17.md` describes its method; its numbers are not published, decision D22).

**Touches**: agent template (meta section); `src/tools/meta.ts`, `data/counters.json`, prompt `meta_defense`, `.claude/skills/swu-meta-defense/SKILL.md`.

**Open gaps**: swumetastats publishes no per-match pairings, so card-against-archetype rates are not available; answer evidence stays deck-level until a public round-level source with decklists exists (#26).

## collector-market-workflows — Prices, value, trades and collection gaps

**Goal**: Collectors and traders get price-grounded answers: what a card or list is worth, whether a trade is fair, what is missing from a collection, and which cards give the most value per dollar.

**Acceptance**:
- It uses `card_price`, `price_list`, `trade_balance`, `owned_vs_needed`, `value_vs_price`, `play_value_vs_price` and `score_vs_play`.
- It always states that prices are a single US TCGplayer import with a date, that cheap commons dominate value-per-dollar, and that `playCalibrated` is fitted to the same play data, so comparing the two is partly circular.
- It never predicts future prices.

**Touches**: agent template (market section); `src/tools/market.ts`, `src/tools/deck.ts`.

**Open gaps**: none

## limits-and-degradation — Data limits, missing tools and version drift

**Goal**: The agent is honest about what the data cannot answer, and keeps working when tools, data or connectivity differ from what it expects.

**Acceptance**:
- It names these known gaps when they matter:
  - No ban or suspension list.
  - No per-printing rows.
  - Cards newer than the data release.
  - Play data from online Karabast and Petranaki games only.
  - Homeworlds outside the play fit.
- If a tool is missing or errors, the agent says which, falls back to the next-best tool from the capability map, and does not fabricate the missing output.
- It calls `data_version` once per task and includes the data date in its answer.
- It works the same over a local stdio install (`npx -y github:LampaGJ/swu-mcp`) and a remote URL endpoint once #16 exists.

**Touches**: agent template (limits section); README "Honest limits".

**Open gaps**: remote endpoint (#16) not yet deployed; host not chosen.

## validation-suite — Scenario suite the template is validated against

**Goal**: /birth Phase 5 validates the template against concrete scenarios whose correct tool use and answer facts can be checked against live swu-mcp output.

**Acceptance**:
- At least 22 scenarios, spread across the families: rules (4), synergy and overlooked (4), deckbuilding (4), meta defense (2), market and trade (3), limits and degradation (3), name resolution (2).
- Each scenario states the user prompt, the tool calls it must include, facts the answer must contain (cardKeys, section ids, data version), and forbidden behaviours (an invented ruling, an unconfirmed candidate stated as fact, a guessed name).
- Among them:
  - A misspelled card name.
  - A decklist with an ambiguous title.
  - A rules question the CR does not settle.
  - A pairing whose evidence does not support it, taken from pairs-v1 "wrong" labels.
  - A banned-card legality question.
  - A card newer than the data.
- Pass bar: every scenario's required calls and facts present, zero forbidden behaviours.

**Touches**: llm-agent-maker validation inputs; `data/fixtures/pairs-v1.json` for wrong-pair cases.

**Open gaps**: scenario answers must be generated against a pinned data version (currently data-2026-10-17) so the suite stays checkable.

## answer-style — Answer format for players and for other agents

**Goal**: Answers are short, checkable and easy for a player to read. A calling agent can parse them too.

**Acceptance**:
- Answers lead with the answer. Each card appears once with its title and cardKey. Quotes go in quotation marks, with their source (tool and section or clause).
- Uncertainty is stated in one line ("candidate, confirmed against text" or "unconfirmed"), not hedged throughout.
- When the caller is an agent, the answer can include a compact structured block: cards, claims, evidence, data version.
- No markdown tables unless the client asks for them.

**Touches**: agent template (output section).

**Open gaps**: none

## Non-goals

- No write actions: the agent does not edit decks, collections, prices or the swu-mcp data, and it does not play games.
- No changes to swu-mcp itself: new tools, data or benchmarks are tracked in the swu-mcp issues (#5, #16, #18, #19, #20), not built by this agent.
- No price forecasting or investment advice.
- No rules adjudication beyond quoting and applying the Comprehensive Rules and official rulings.
- Hosting the remote endpoint (#16) is out of scope here.
