# The Claude Code setup behind swu-mcp

Last updated 2026-10-16.

**TL;DR.** The maintainer built swu-mcp with Claude Code, an AI coding tool that runs in a terminal. A few plain-text rule files told Claude how to work: how to split work, how to use git, how to treat data and how to write. This page explains those files and ends with how you could do the same. Related pages: [what it does](what-it-does.md) and [how it was built](how-we-built-it.md).

## The words you need

- **Claude Code** is Anthropic's coding assistant. It reads and edits files and runs commands on your computer, with your permission.
- **CLAUDE.md** is a text file of standing instructions. Claude Code reads it at the start of every session. One lives in the user's home folder and applies everywhere. Another lives in each project and applies there.
- **A subagent** is a helper that Claude Code starts for one job, with its own fresh working memory.
- **A skill** is a saved set of instructions that Claude loads when a request matches it.
- **A hook** is a small script that runs automatically at a set moment, such as before a command executes.
- **Git** is the program that records every version of the files. **An issue tracker** is the list of tasks on GitHub.

## The project rules

The file `CLAUDE.md` in this repository holds the rules that matter for swu-mcp.

- The data is always rebuilt from saved inputs by committed code. Nobody edits it by hand.
- No AI model sits in the scoring path. Models may only make saved inputs, and fixed code reads those.
- The sister project that downloads the raw card list is read-only from here.
- Stage exact file names in git. Make one logical change per commit. Do not publish changes until the maintainer asks.
- Comment only what the code cannot say.

## The maintainer's personal rules

A second `CLAUDE.md`, in the maintainer's home folder, applies to every project. Its main points, in plain words:

- **Hand work to helpers.** Where a choice exists, Claude uses subagents instead of doing everything in one session. It picks the cheapest model that can do the job: a small model for bulk mechanical work, a mid-size one for well-specified building, and the largest for tricky reasoning.
- **Write a task down first.** Every request is a candidate for a GitHub issue, filed at the start, so nothing is lost.
- **Use git carefully.** Look at the state of the repository before acting. Never rewrite history that others may have. Look before deleting anything.
- **Treat data as reproducible.** Fixed code, saved inputs, identical output, and a check wherever outside data enters.
- **Prefer existing libraries.** Use a well-known framework before writing custom code. This project uses the MCP software kit, a TOON encoder, a schema checker and a search library.
- **Write plainly.** One point per sentence, active voice, short paragraphs.
- **Treat prototypes as prototypes.** A proof of concept shows what is possible. Questions about launch readiness come later.

That file also sets up automatic checks on shell commands, so a mistyped command does not quietly return a false answer. This page names no specific hooks, because this repository's history and docs do not show any in use.

## What the repository shows being used

- **Subagents.** The tool catalogue records that four named specialist agents each wrote one independent branch of ideas (a jobs-to-be-done mentor, a finance instructor, an MCP server builder and an AI-pipeline architect), and a fifth branch was role-played as a card-deck builder. The verification report records that small "haiku" reviewers judged sampled items and a mid-size "sonnet" reviewer adjudicated their flags.
- **A skill.** `.claude/skills/swu-rules` tells Claude how to answer a rules question: read the core primer first, search the rules, quote section numbers and card rulings word for word, say plainly when the rules are silent, and report the rules version.
- **The issue tracker.** Work lives in issues, and commit messages cite them, such as `(#9)`.
- **Tests as proof.** The first complete version includes a test that starts the real server and calls every tool.

## Could you do this too?

Yes. Install Claude Code, open a folder, and write a short `CLAUDE.md` with your own rules. Start with two or three: how to run your tests, and what the assistant must never touch. Add a rule each time you correct the same mistake twice. When you are comfortable, try a subagent for one narrow task. The official guide is at https://code.claude.com/docs.
