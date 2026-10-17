# How swu-mcp was built

Last updated 2026-10-17.

**TL;DR.** swu-mcp was built in about one day by one maintainer working with Claude Code, an AI coding tool. The work ran from small written tasks, through fixed-rule code, to a check of the finished data against its sources. That check found real errors, and the project reports them openly. Related pages: [what it does](what-it-does.md) and [the Claude Code setup](claude-code-setup.md).

## The words you need

- **MCP** (Model Context Protocol) is an open standard for giving AI assistants outside tools.
- **Deterministic** means the same input always gives the same output.
- **Replay** means running a step again from the same saved input and getting the same bytes.
- **A hash** (sha256) is a fingerprint of a file. If one byte changes, the fingerprint changes.
- **A subagent** is a second AI helper that Claude Code starts for one task.
- **SWU** is Star Wars: Unlimited, the card game.

## Starting point

A sister project already held SWU card work: a downloader for the official card list, the price import, and early scoring experiments. The first commits of this repository copy that work in, with its notes, and add a small server. After that, each piece of work began as an issue on GitHub's tracker. The commit messages carry the issue number, for example `(#7)`.

## The sequence

The issues show the order of work.

- **Bootstrap (#4).** Set up a TypeScript project with tests, strict type checks and the MCP software kit.
- **Value rubric (#1).** Fit a scoring recipe to the cards. The research note reports that a card's cost-to-stats efficiency did not predict how often players used it, so the final score is fitted to play data from 637,162 player-games.
- **Embeddings (#2).** Turn each card's text into a list of numbers so similar cards can be found. One local model call produced the numbers. The output is saved with its hash, and all later steps only read it.
- **Combos (#3).** Build "this card feeds that card" links from the parsed ability text.
- **Tool catalogue (#5).** Five separate reviewers each listed players and tool ideas without seeing the others. The catalogue merged them: 360 listed tool lines became 112 distinct candidates, ranked by priority.
- **Rules (#6).** Parse the official Comprehensive Rules PDF into searchable sections, dated card rulings and keyword links.
- **First complete version (#7).** All 28 tools served, one command to rebuild all data, and a test that starts the real server and calls every tool.
- **Verification (#9).** Check the data against its sources, described below.
- **Hosting from GitHub (#8).** Make the server start with one command from GitHub, with the data as a download that the server checks.

## The rules the code follows

The project keeps these rules in a file called `CLAUDE.md`, which Claude Code reads at the start of every session.

- Every data step is a replay: deterministic code, saved inputs, identical output.
- Nobody edits data by hand. If a file needs fixing, the fix becomes a committed step.
- No model decides a score. A model may only produce a saved, hashed input that fixed code then reads.
- Files from outside are checked with a schema (a written description of the allowed shape) before use.
- Each commit makes one logical change, and each lists exactly the files it changes.

A build record, `build.json`, lists the fingerprint of every output file. Two builds from the same inputs give the same overall build hash.

## What the check found

The verification report is in [docs/verification](../verification/2026-10-16.md). It has two parts.

First, a fixed-rule audit ran nine checks over every record. It passed all nine, with 146,827 individual assertions. This proves the data matches the original card list, prices, rulings and rules text.

Second, a sampled review looked at the parts that carry meaning, such as parsed abilities and combos. Of 295 sampled items, small AI reviewers flagged 87 as wrong or unsure. A second, stronger reviewer re-checked each flag against the sources. It kept 46 as wrong and overturned 39. A spot check of 15 items marked correct overturned one. That puts the error rate at 15.8 percent of 292 judged items, and the report says it is a floor, not a ceiling.

The errors cluster in combos (35.9 percent of sampled pairs) and parsed abilities (22.5 and 27.5 percent in two samples). The rules text had no errors in 40 sampled sections. The two main causes are conditions that the parser dropped and a combo step that ignored limits such as trait or arena. Follow-up issues (#11, #12 and #13) track the fixes.

## Update, 2026-10-17: a second wave

The first version was fast and rough, so the next wave went back and fixed what the review found. It had four parts.

- **Card-text fixes.** The maintainer corrected the parser that reads each card's abilities, so fewer conditions get dropped.
- **Pairing coverage (#14).** More cards now receive combo suggestions, so fewer cards come back empty.
- **Evidence (#15).** Each pairing, three-card chain and substitute now carries the short piece of card text behind it, and a `status: candidate` label. Anyone can check a claim against the words on the cards.
- **17 new tools (#5).** The server grew from 28 tools to 45. The new ones cover deck checks, collection and trade value, fuzzy name lookup, set and format lists, and ruling search. It also gained reference pages and two prompts. Each new tool got a test that calls it through the real server.

The honest limit is the same. The combos are still candidates, but they now show their work.

## Rough numbers

- About 60 commits at the time of writing, from the git history.
- 13 issues, 5 of them closed.
- 28 tools, and one test that calls each.
- Nearly 400 automated tests. One test needs a rules PDF that is kept out of the repository, so it fails on a fresh checkout without it.

## Honest trade-offs

- Speed came before depth. The maintainer shipped a full set of tools first and measured accuracy second.
- The tag layer is a grammar plus a hand-reviewed table. Nobody has measured its precision on a labelled test set.
- Play data is thin: online games, not tournaments.
- The score is fitted to play data and then compared with play data, so part of the match is circular.
- The small reviewers were unreliable on their own: 44.8 percent of their flags were wrong, which is why a second pass was needed.
