import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { packageDirOf, type CardStore } from "./data.js";
import type { RuleSection } from "./rules/parse-cr.js";
import { rulesFor, type RulesStore } from "./rules/store.js";
import { normalizeSectionId } from "./tools/rules.js";

/**
 * @displayName Resources and prompts
 * @strategicPurpose Gives a host cacheable reference text (rubric, glossary, usage guide, rules sections) and three
 * workflow prompts (rules, deck building, meta defense), so an assistant spends tool calls on questions and not on orientation.
 * @tacticalObjective The rubric and glossary are read from <package>/docs, which ships inside the data package, so an
 * npx install serves them with no repo checkout. The usage guide and prompts are bundled text. Rules sections come from
 * the same rules store the rules tools use.
 */

export const USAGE_GUIDE = `# swu-mcp usage guide

Every tool is read-only. Results are TOON tables. Cite the data version (\`data_version\`) and, for rules, the rules version (\`rules_version\`).

## Find a card
- Rough or misspelled name, voice transcript, scan guess: \`resolve_card_name\`, then use the cardKey.
- Exact title or cardKey: \`get_card\`. Many cards at once, with only the columns you need: \`get_cards_batch\`.
- Filter by type, aspect, trait, keyword, set or cost: \`search_cards\`. Browse a category: \`list_facet\`, then \`cards_by_facet\`.
- Where a card is printed, which sets: \`get_printings\`. All sets and their Premier status: \`list_sets\`.

## Is a card good
- One card with a reason per component: \`score_card\`. Ranked lists with filters: \`rank_cards\`. Side by side: \`compare_cards\`.
- How the score is built: \`explain_rubric\`, or read the swu://rubric resource.
- Parsed triggers and effects: \`card_features\`. Cards that produce an effect: \`find_by_effect\`.

## What goes with it
- Enablers and payoffs: \`find_pairings\`. Three-card combos: \`find_trios\`. Why two cards pair: \`explain_synergy\`.
- Leader and base aspect penalty: \`aspect_cover\`.
- Cards that do the same job: \`fungible_substitutes\`. Cards that read alike: \`similar_cards\`. Same job under different labels: \`kin_cards\`. Role groups: \`cluster\`.

## Price and play
- Price: \`card_price\`. Premier inclusion and win figures: \`play_stats\`. Score per dollar: \`value_vs_price\`.

## Decks and collections
- Whole-deck report under a leader and base: \`deck_audit\`. Construction legality: \`deck_legality_check\`. Best leader and base for a pile of cards: \`suggest_leader_base\`.
- Best cards for a leader and base: \`playable_cards\`. Substitutes for the cards of a deck: \`fungible_in_deck\`. Cheaper substitutes: \`budget_alternatives\`.
- Price a list: \`price_list\`. Compare two lists: \`trade_balance\`. What a deck still needs from a collection: \`owned_vs_needed\`.
- Cards played most or least per dollar: \`play_value_vs_price\`. Cards whose score and play rank disagree: \`score_vs_play\`.

## Rules
- Start with \`rules_core\` for a rules question, then \`rules_search\` and \`get_rule\`. A section is also readable as swu://rules/{section}.
- A keyword: \`keyword_rules\`. One card's rulings: \`card_rulings\`. Rulings by text, keyword or date: \`search_rulings\`.
- Quote a ruling with its date. Say plainly when a ruling is undated.

## Meta defense
- The current archetypes (tournament decklists, placement-weighted; community lists apart): \`meta_archetypes\`. One archetype's key units, curve, keywords and threats: \`meta_threats\`.
- Cards in your aspects that answer the most meta share, with clause evidence and tournament deck evidence: \`meta_answers\` (leader and base, or a decklist). Then check the swaps with \`deck_audit\`.
- Every win rate comes from swumetastats (melee.gg tournaments) with its window, n and a 95% interval. Card evidence compares comparable decks with and without the card; opponents are unknown, so it is not a rate against an archetype.

## Formats
- Is a card legal: \`format_legality\`. It reads set printings only; there is no ban list in the data, so confirm bans on the official site.

## Terms
- The swu://glossary resource defines game terms.
`;

const RULES_QUESTION = (question: string): string => `Answer this Star Wars: Unlimited rules question using only the Comprehensive Rules and official card rulings: ${question}

Work in this order:
1. Call \`rules_core\` once for the core rules, then \`rules_search\` with the key terms of the question.
2. Call \`get_rule\` on the best section ids, and on the sections they cross-reference.
3. If a card is named, call \`resolve_card_name\` to get its cardKey, then \`card_rulings\`. Use \`search_rulings\` for rulings on a keyword.
4. Answer in plain words. Quote the rule text and cite each section id. Quote each ruling with its date, and say when a ruling is undated.
5. End with the Comprehensive Rules version from \`rules_version\`. If the rules do not settle the question, say so instead of guessing.`;

const BUILD_DECK = (leader: string): string => `Help build a Star Wars: Unlimited Premier deck around this leader: ${leader}

Work in this order:
1. Call \`resolve_card_name\` for the leader and \`get_card\` for the full text. Note its aspects and what it offers and wants (\`card_features\`).
2. Pick a base with \`aspect_cover\`, ranking leader and base combinations by aspect penalty for the cards you expect to play.
3. Find the engine: \`find_pairings\` and \`find_trios\` on the leader and its best cards. Explain links with \`explain_synergy\`.
4. Fill each role with the best card for the money: \`rank_cards\` for strength, \`fungible_substitutes\` for cheaper or off-aspect alternates, \`value_vs_price\` for budget.
5. Check every card with \`format_legality\`, and check the evidence with \`play_stats\`.
6. Report the list with a one-line reason per card, the aspect penalty, and the data version from \`data_version\`. Say that bans are not in the data.`;

const META_DEFENSE = (deck: string): string => `Find what this Star Wars: Unlimited Premier deck must include to beat the current top archetypes: ${deck}

Work in this order:
1. Resolve the leader, base and any listed cards with \`resolve_card_name\`. Call \`data_version\` once.
2. Call \`meta_archetypes\` for the largest archetypes. Report each with its share, top-8 share, date window and the population and sources it rests on (tournament decklists first; say when a figure comes from community lists).
3. Call \`meta_threats\` on the three to five archetypes that matter most, and name their key units and threats.
4. Call \`meta_answers\` with the leader and base (or the decklist). Answers are candidates: for each one you keep, read its clause evidence, check it with \`card_features\` or \`explain_synergy\` where useful, and confirm any rules question with \`keyword_rules\` or \`card_rulings\`. Drop an answer the text does not support.
5. Propose swaps (cards out, answers in) and run \`deck_audit\` on the changed list to check curve, aspect penalty and orphan wants. Run \`deck_legality_check\` on the final list.
6. Report each swap with the threats it answers, its coverage, its cost, its tournament deck evidence (with and without the card, n, 95% interval, source and window; opponents unknown) when present, and the data version. Never state a candidate as fact.`;

const docs = new Map<string, string>();

function readDoc(store: CardStore, name: string): string {
  const file = path.join(packageDirOf(store), "docs", name);
  const memo = docs.get(file);
  if (memo !== undefined) return memo;
  try {
    const text = readFileSync(file, "utf8");
    docs.set(file, text);
    return text;
  } catch {
    throw new Error(`${file} is missing; the data package should ship docs/${name}`);
  }
}

function ruleMarkdown(section: RuleSection, rules: RulesStore, depth: number): string {
  const heading = `${"#".repeat(Math.min(section.id.split(".").length + 1, 6))} ${section.id}${section.title === null ? "" : ` ${section.title}`}`;
  const kids = depth === 0 ? [] : (rules.children.get(section.id) ?? []).map((kid) => ruleMarkdown(kid, rules, depth - 1));
  return [heading, section.text, ...kids].filter((part) => part !== "").join("\n\n");
}

export function registerResources(server: McpServer, store: CardStore): void {
  const markdown = (uri: URL, text: string, mimeType = "text/markdown") => ({ contents: [{ uri: uri.href, mimeType, text }] });

  server.registerResource(
    "rules-core-primer",
    "rules://core-primer",
    {
      title: "Core rules primer",
      description: "Verbatim official text of the core Comprehensive Rules sections, each line prefixed by its section id. Read before searching.",
      mimeType: "text/markdown",
    },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: rulesFor(store.dataDir).primer }] }),
  );
  server.registerResource(
    "rubric",
    "swu://rubric",
    { title: "Card value rubric", description: "How card value is scored: the formula, weights and the reasoning behind them.", mimeType: "text/markdown" },
    (uri) => markdown(uri, readDoc(store, "swu-card-value-rubric.md")),
  );
  server.registerResource(
    "glossary",
    "swu://glossary",
    { title: "Glossary", description: "Game terms (keywords, tokens, sets, aspects, formats), as JSON.", mimeType: "application/json" },
    (uri) => markdown(uri, readDoc(store, "swu-glossary.json"), "application/json"),
  );
  server.registerResource(
    "usage-guide",
    "swu://usage-guide",
    { title: "Usage guide", description: "Which tool answers which kind of question, and the order to call them in.", mimeType: "text/markdown" },
    (uri) => markdown(uri, USAGE_GUIDE),
  );
  server.registerResource(
    "rules-section",
    new ResourceTemplate("swu://rules/{section}", {
      list: () => {
        const rules = rulesFor(store.dataDir);
        return {
          resources: rules.coreIds
            .filter((id) => rules.byId.has(id))
            .map((id) => ({ uri: `swu://rules/${id}`, name: `rules-${id}`, title: rules.titlePath(id), mimeType: "text/markdown" })),
        };
      },
    }),
    { title: "Comprehensive Rules section", description: "One rules section by id, for example swu://rules/7.5.11, with its children to two levels.", mimeType: "text/markdown" },
    (uri, variables) => {
      const rules = rulesFor(store.dataDir);
      const id = normalizeSectionId(decodeURIComponent(String(variables.section)));
      const section = rules.byId.get(id);
      if (section === undefined) throw new Error(`no rule section ${id} in Comprehensive Rules v${rules.document.version}`);
      return markdown(uri, `${rules.titlePath(id)}\n\nComprehensive Rules v${rules.document.version}\n\n${ruleMarkdown(section, rules, 2)}`);
    },
  );

  const userMessage = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });
  server.registerPrompt(
    "rules_question",
    { title: "Answer a rules question", description: "Find the rule, find the ruling, answer with citations.", argsSchema: { question: z.string().min(1).describe("The rules question to answer") } },
    ({ question }) => userMessage(RULES_QUESTION(question)),
  );
  server.registerPrompt(
    "build_deck_for_leader",
    { title: "Build a deck for a leader", description: "Choose a base, find the engine, fill each role, then audit legality and play data.", argsSchema: { leader: z.string().min(1).describe("Leader name, for example Iden Versio") } },
    ({ leader }) => userMessage(BUILD_DECK(leader)),
  );
  server.registerPrompt(
    "meta_defense",
    {
      title: "Defend against the meta",
      description: "Archetypes, then their threats, then the answers in our aspects, checked against card text and rulings, then deck_audit with the swaps.",
      argsSchema: { deck: z.string().min(1).describe("Our leader and base, or a decklist, for example Asajj Ventress with Chopper Base") },
    },
    ({ deck }) => userMessage(META_DEFENSE(deck)),
  );
}
