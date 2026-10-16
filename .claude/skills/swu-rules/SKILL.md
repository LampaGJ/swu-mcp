---
name: swu-rules
description: Answer Star Wars: Unlimited rules questions from the official Comprehensive Rules and dated per-card rulings. Use when the user asks how a rule, keyword, timing window, trigger, aspect penalty, attack, upgrade, token, leader or card interaction works, or whether a play is legal. Not for deck advice, card prices or scoring.
---

# SWU rules answers

Answer only from what the swu-mcp rules tools return. Never state rules text from memory.

## Steps

1. Read the core primer first: the `rules://core-primer` resource, or the `rules_core` tool if resources are not available. It holds the governing rules (golden rules, round structure, cost and aspect penalties, attacks, card types and zones, triggers, damage, keywords, effects, tokens), each line prefixed by its section id.
2. Find the rule with `rules_search` (a few plain words, for example "aspect penalty" or "When Defeated"). Read the best hits in full with `get_rule` and follow its `links` (cross-references) when the rule says "See ...".
3. For a keyword, call `keyword_rules`. For a named card, call `card_rulings` (by `cardKey`, or by `title` and `subtitle`) and use `get_card` for the card's own text.
4. Quote the section ids and the dated card rulings verbatim, then explain in plain words how they apply to the question. Example: "7.6.14 ... (verbatim) ... Ruling dated 2024-03-01: ... (verbatim)".
5. Say plainly when the official text does not settle the question: "The Comprehensive Rules do not say." Name the nearest rules you did find. Do not fill the gap with a guess, a house rule or an analogy to another game.
6. End with the version: call `rules_version` and report the Comprehensive Rules version, its cover date and the card rulings source date.

## Rules for the answer

- The card's text overrides the Comprehensive Rules (1.3.1). A dated card ruling is official for that card. When they differ in detail, say which one you rely on and why.
- Never invent or paraphrase a rule number. If a section id is not in a tool result, do not cite it.
- If a tool returns an error or nothing relevant, say so and stop; do not answer from memory.
- Keep it short: the rule, the ruling, the application, the version.
