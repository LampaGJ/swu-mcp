# What swu-mcp does

Last updated 2026-10-16.

**TL;DR.** swu-mcp is a free add-on for AI assistants such as Claude. It lets the assistant look up Star Wars: Unlimited (SWU) trading cards, score them, suggest card combinations, check prices and quote the official rules. Every answer comes from saved data and fixed code. No AI guesses a number at the moment you ask.

Related pages: [how it was built](how-we-built-it.md) and [the Claude Code setup behind it](claude-code-setup.md).

## The words you need

- **Star Wars: Unlimited (SWU)** is a trading card game made by Fantasy Flight Games.
- **An AI assistant** here means a chat program such as Claude that can use outside tools.
- **MCP** stands for Model Context Protocol. It is an open standard that lets an assistant call a small program, called a server, and get answers back. swu-mcp is one such server.
- **A tool** is one question the server can answer, such as "show me this card". There are 28.
- **Stdio** (standard input and output) means the assistant starts the server on your own computer and talks to it directly. Nothing runs on a website.
- **Deterministic** means the same input always gives the same output.

## What it lets you do

You ask the assistant a question in plain language. The assistant picks the right tools and reads you the result. The tools fall into groups.

- **Find cards.** Look up one card, search by words in its text, or list every card with a trait, keyword or aspect (a card colour such as Vigilance or Aggression).
- **Judge value.** Each card gets a score from a published rubric, which is a scoring recipe built from cost, stats and abilities. The assistant can rank cards, compare two to five side by side, and explain how a score was made.
- **Read card abilities.** The text of each card is split into triggers, effects and conditions. You can search for cards that do a certain thing, such as drawing a card.
- **Find combos.** The server suggests pairs of cards where one feeds the other, and three-card chains. It can say why they fit, which cards can stand in for each other, and which leader and base colours cost the least aspect penalty.
- **Check the market.** It shows the US price from TCGplayer, how often a card appears in online Premier decks (a deck format) and how often those decks win, and a score per dollar.
- **Check the rules.** It holds the official Comprehensive Rules, the dated rulings for individual cards and the definitions of keywords. The assistant quotes them instead of recalling them.
- **Find look-alikes.** It lists cards whose text reads alike, cards that do the same job under different names, and 32 groups of cards by role.
- **See where data came from.** One tool reports the data date and the code version behind every score.

## One example, start to finish

Say you ask: "I like this card that adds resources. What pairs well with it, and how does the timing work when it triggers?"

1. The assistant calls the card lookup tool and reads the card's text and numbers.
2. It calls the pairing tool. The server returns cards that feed your card and cards it feeds. Each comes with a reason, a score and a note on aspect penalty.
3. It calls the explain tool for the pair you like. The server lists, link by link, why the two cards fit.
4. For the timing question, it reads the rules primer, searches the rules, and quotes the section and any dated ruling word for word.
5. It tells you which data date the answer used.

The results come back in TOON, a compact table format that uses few words, so the assistant spends little of its working memory on them.

## How you install it

You need Node.js 22 or newer. For Claude Code, run `claude mcp add swu -- npx -y github:LampaGJ/swu-mcp`. The [project README](../../README.md) also shows the Claude Desktop setup. The first start builds the server and downloads about 2 MB of card data. The download is checked against a fixed fingerprint (a sha256 checksum, a value that changes if even one byte of a file changes) before the server uses it.

## What it does not do

- It does not build decks or play the game for you.
- It does not use a live AI model to score cards. Scores are fixed arithmetic over saved data.
- It does not change anything. All 28 tools only read.
- It does not cover cards from before the Jump to Lightspeed set unless they were reprinted in it or later.
- It does not give prices outside the US.
- It is not tournament data. The play figures come from online games.
- It is not always right. A check of the combo and ability layers found real mistakes, and the project publishes them. Treat pairings as ideas to test, not facts. See the [verification report](../verification/2026-10-16.md).

## Data and rights

This is an unofficial fan project. Card data is copyright Lucasfilm and Fantasy Flight Games and comes from the official card list. Prices come from TCGplayer through TCGCSV, a public price feed. Play data comes from SWU Stats, a site that counts cards in online games. None of them endorses this project.
