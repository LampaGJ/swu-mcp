---
type: runbook
status: active
review_by: 2026-12-31
related: ["CLAUDE.md", "docs/decisions.md", "docs/verification/2026-10-30-value-judgments.md"]
---

# Judged deck sessions

What this is: the loop that measures whether a change to an advice tool (synergy, deck, meta) made the server's deck-building ideas better. A scripted builder runs 14 steps against the server on each reference deck. A fresh opus judge scores each step 0 to 3. The loop repeats after every wave of fixes.

The results so far are in `docs/verification/2026-10-30-value-judgments.md`. The rule that triggers this loop is in CLAUDE.md, section "Judged deck sessions".

## The reference decks

- Session 7: the Cad Bane, Still Faster than You / Nevarro City, Restored deck. It has a tournament archetype in the window.
- Session 8: the owner's Warrior deck, The Warrior, Deft Duelist / Origin Tree. It is a newest-set leader with no tournament archetype in the window, so it leans on community lists.

Both decks run the same 14-step shape. Steps 1 to 11 come from the session 7 driver and steps 12 to 14 from its extra-steps script. The steps, by tool:

1. `meta_archetypes`: what is the meta right now.
2. `meta_threats`: what the leader faces.
3. `meta_answers`: what answers the field.
4. `playable_cards`: best cards by cost, with the full decklist.
5. `find_pairings`: three calls (leader, and two key units).
6. `find_trios`: three-card combos, unweighted.
7. `deck_audit`: the full 50-card list.
8. `playable_cards` with `emptyCostsOnly`: fill the costs the 34-card core lacks.
9. `fungible_substitutes`: stand-ins for one card, and a keep-or-cut decision.
10. `budget_alternatives`: swaps under a price cap.
11. `deck_legality_check`: the list and its sideboard.
12. `leader_cards` sorted by lift: what the leader's tournament decks play that others in these colours do not.
13. `find_pairings` unweighted: a control against the leader-weighted call.
14. `find_trios` weighted by the leader's decklists.

## The rubric

Each step gets one score (`docs/verification/2026-10-30-value-judgments.md:10`):

- 0: misleading or empty.
- 1: correct, but nothing new.
- 2: would influence a real card choice.
- 3: a non-obvious idea a strong builder acts on.

The judge is an adversarial opus agent with no stake in the code. It is a fresh agent for every run, so it never sees its own earlier scores.

## The loop, step by step

1. Rebuild the data: `pnpm build:data --date <d>`. The session must read the rebuilt run, not an older one.
2. Check the rebuilt data against the originals: `pnpm verify:audit --run data/runs/<d>`. Stop if it exits 1.
3. Restart the server or the bridge that serves the session, so it loads the new build. A session against an unrestarted server scores the old build. Confirm the served `dataVersion` matches `<d>` before you run anything; the w25 judge saw a frozen `dataVersion 2026-10-16.1/4b25eb4667df`, which is #103.
4. Run the 14-step session once per reference deck. Each run writes a verbatim dump of every call and its output.
5. Dispatch one fresh opus judge per deck, with the `model` parameter set explicitly. Give it the dump, the judge prompt and the previous run's report.
6. The judge scores blind first. It reads the dump end to end and scores every step before it opens the previous report. It records the blind scores in a file of their own.
7. The judge then calibrates by diffing. It splits both dumps by step and diffs them. A step whose output is byte-identical to the previous run keeps the previous run's score unless the judge finds a clear error. A changed step moves only when the judge finds the previous run's named defect fixed, or a new error. The calibrated total is therefore anchored to the previous run.
8. Apply the VALUABLE rule. VALUABLE means a mean of at least 2.0 (28 of 42) with no step at 0. Report the blind and calibrated totals side by side, never one alone. The Warrior judge's blind totals ran 22 to 27 of 42 against calibrated totals of 29 to 31, so its VALUABLE verdicts rest on calibration (`docs/verification/2026-10-30-value-judgments.md:14`). A verdict on the series scale is not a verdict on the judge's blind scale.
9. File each named defect as a wave issue: through `/issues` when there are three or more related defects, otherwise as one issue with a `Target branch:` line.
10. Fix each defect at its cause, behind a failing-first test. Do not patch the tool output.
11. If the fix changes a pairing matcher, run `pnpm verify:pairs` before and after, and re-label only by adding a new fixture version (CLAUDE.md, "Accuracy, honestly").
12. Land the fix, then go back to step 1. Close a wave issue only when the rerun confirms its defects fixed, and put the run id in the closing comment.

## What to keep

Keep and hash the dumps, the judge prompt and the judge reports. They are model output, so D3 applies: a model call is captured once as a pinned, hashed input (`docs/decisions.md:20`). The committed value-judgments doc cites scratchpad judge files as evidence, and those files do not survive a reboot.

Pinning under `data/pinned/judged-sessions/` and committing the harness as `pnpm verify:judged-session` are tracked in #177. Until that issue lands:

- The session driver, the judge prompt and the judge reports live in the git-ignored `tmp/judged-sessions-2026-10-31/`. Copy that folder before any cleanup.
- The driver scripts hardcode the address of the private endpoint, so they must not be committed (D24, `docs/decisions.md:72`). The committed driver will read the endpoint from the environment and default to a local stdio server.
- Do not write the private endpoint address into any committed file, including this runbook.

## Open questions

These sit with the owner:

- Whether VALUABLE gates on the blind total, the calibrated total, or both. The default is to report both and gate on calibrated, as today.
- Whether the Warrior list may be committed as a reference-deck input.
- Whether byte-identical steps carry their score forward, with a full blind rescore every fifth run. That would roughly halve judge input.
- Whether a rerun is required on every advice-tool change or once per wave. The default is once per wave.
