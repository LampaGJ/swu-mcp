---
type: spec
status: active
review_by: 2027-01-31
related: ["docs/research/sim-bot-policy-ladder.md", "docs/verification/2026-10-31-bot-ladder.md", "docs/decisions.md"]
---

# Simulation calibration gate, 2026-10-31

## TL;DR

Both measured bot rungs fail the external calibration gate, so `simulate_matchup` reports no win share yet. Rung 1 ranks the 66 matchups among the 12 largest tournament archetypes with Spearman -0.17 against the tournament results and picks the tournament favourite in 15 of 37 clear matchups; rung 3 top-K (`rung3:k=8`) scores -0.21 and 16 of 37. Both pass the replay, health and ladder gates. The two rungs agree with each other (Spearman 0.83 between their sim shares) and disagree with the tournaments, and their shares sit twice as far from 50% (mean distance 0.26 and 0.20 against 0.11), so the gap is systematic: the bots pilot some archetypes far worse than people do (Krennic most of all), and one list stands for each archetype. The thresholds stay where they were set before the measurement.

Follow-up (#171, D90): the negative correlation is real. A committed test traces three matchups from the raw swumetastats rows to the sim's seat and winner fields and finds no inversion or identity error. Rung 1 on three placement-weighted lists per archetype, none of them a v1 list, scores -0.21 [95% interval -0.43, 0.04]; its shares rank the pairs like the one-list run (0.87). A rung 3 Monte Carlo probe (10 games per pair) scores -0.20 [-0.42, 0.05]. The bots carry a tempo bias: they underrate decks that need lines (Krennic, the Mandalorian, Lando) and overrate proactive ones.

Every sim figure here is bot play (D21's last tier), named with its rung, the engine pin and the seeds. Every tournament figure is swumetastats' melee.gg matchup table. The two sit side by side; they are never pooled. No Karabast data is read (D22).

## What was measured

The gate script is `scripts/sims/calibration-gate.ts`; the statistics and the record schema are in `src/sims/calibration.ts`. It writes one record per rung to `data/pinned/sim-calibration-v1/`, and `simulate_matchup` parses those records before it serves a rung (`choosePilot`, `src/sims/calibration.ts:331`).

- Panel: the 12 tournament archetypes with the largest share whose leader and base aspects differ (the swumetastats table is keyed by leader and base aspects, so a second archetype with the same key is skipped: t011 Cad Bane and t013 Lando). Each archetype plays its highest-placing buildable melee list (the sampler's `deckPanel`, D78). Archetypes and lists come from `data/runs/2026-11-01/meta/archetypes.json` and `data/originals/decks/2026-10-17`.
- Games: all 66 archetype pairs, 40 games each (20 engine seeds, each played twice with the seats swapped), the rung on both seats. Seeds 4,000,000 + 1,000p + q (pair p, q < 20), a range no other sim step uses.
- Tournament side: `data/runs/2026-11-01/meta/winrates.json` (sha256 `383292f2…`, byte-identical to the 2026-10-31 run's), swumetastats matchups per leader and base aspects, 2026-07-20 to 2026-10-17, draws left out. All 66 pairs have at least 10 decisive matches (`minN`); 37 have a Wilson interval that excludes 50% ("clear").
- Pilot tables: `data/runs/2026-10-31` (scores, features, coefficients), the same hashes as every ladder record in `data/pinned/sim-ladder-v1/`. Engine `445792e`, card data `20260423_00`.

## The four gates and their thresholds

The thresholds were fixed in code before the first measurement (`CALIBRATION_THRESHOLDS`, `src/sims/calibration.ts:23`): the research doc's estimates, which D53 adopted as starting values. Neither measurement moved them (D88).

1. Replay: 50 of the calibration matches, spread evenly over the pairs, played again in the main thread. The thread's trace must equal the worker's, the record must replay to the same trace (with its own policies for rung 1; by descriptor, the replay oracle, for a search rung), and for rungs 0 to 2 the match played with undo on must give the same trace. A search rung needs undo, so for rung 3 the rollback-fidelity record `data/pinned/sim-ladder-v1/rung3-fidelity.json` is the evidence for that part, cited by hash.
2. Health: non-decisive share at most 2% and fallback share (decisions the rung handed down to random play) at most 5%, over the calibration games.
3. Ladder: the rung beats rung 0 and its promoted predecessor under the ladder pass rule, read from the pinned ladder records; a record for another candidate, engine or card tables does not count (`ladderStep`, `src/sims/calibration.ts:187`). Rung 2 is not promoted (D79), so rung 3's predecessor is rung 1.
4. External calibration: Spearman rank correlation between sim and tournament win shares over the pairs, oriented from the higher-share archetype, at least 0.5; and the sim favourite agrees with the tournament favourite in the clear matchups significantly more often than half the time (exact one-sided sign test, p < 0.05; a sim share of exactly 50% counts as no agreement) (`externalGate`, `src/sims/calibration.ts:148`).

## Results

### Rung 1 (`rung1`)

- Replay: 50 of 50 thread traces equal the worker's, 50 of 50 replay, 50 of 50 identical with undo on. Pass.
- Health: 2,640 games, 10 not decisive (0.38%, all engine errors), fallback 0.26% of 413,727 decisions. Pass.
- Ladder: `rung1-vs-rung0.json`, 99.75%, discordant 199 to 0. Pass.
- External: Spearman -0.17 over 66 pairs; the favourite agrees in 15 of 37 clear matchups (one-sided p = 0.91). Fail.

Rung 1 fails the external gate. Its shares run from 0% to 100% where the tournaments run from 17% to 80%: the bot amplifies what it can and cannot pilot. It plays Krennic (Vigilance control, the largest archetype) to 0 to 10% against eight of the nine archetypes tournament Krennic beats (Piett, at 30%, is the ninth), and plays Cad Bane to 97% to 100% against Ahsoka, the Mandalorian, Lando and Aurra Sing.

### Rung 3 top-K (`rung3:k=8`)

- Replay: 50 of 50 thread traces equal the worker's, 50 of 50 replay by descriptor; rollback fidelity cited from `data/pinned/sim-ladder-v1/rung3-fidelity.json` (sha256 `8d5a3376…`). Pass.
- Health: 2,640 games, all decisive, fallback 0.34% of 377,383 decisions. Pass.
- Ladder: `rung3-vs-rung0.json` (new, 400 of 400 games, discordant 200 to 0, p = 1.2e-60) and `rung3-vs-rung1.json` (83.0%, 131 to 0). Pass.
- External: Spearman -0.21 over 66 pairs; the favourite agrees in 16 of 37 clear matchups (one-sided p = 0.84). Fail.

Search narrows the bot's extremes (mean distance from 50% falls from 0.26 to 0.20) and lifts Krennic (to 35% to 72.5% in five matchups), but not toward the tournament order: Lando against Darth Maul goes from 30% to 7.5% where tournaments give Lando 59%, and Luke Skywalker, I Can Save Him beats Lando 95% of the time where tournaments give Luke 27%.

### What the two rungs share

The rung 1 and rung 3 sim shares rank the pairs alike (Spearman 0.83), so the disagreement with the tournaments is not sampling noise in 40 games per pair: it is how these bots play these lists. Two causes are open and untested here. First, pilot skill: a deck that needs lines (Krennic's control plan, Lando's Sabacc leader) loses value under a weak pilot, which the ladder doc calls pilot sensitivity. Second, one list per archetype: the highest-placing buildable list stands for an archetype that tournament results aggregate over hundreds of lists. The #171 follow-up below tested both: three lists per archetype change nothing, so the pilot is the cause.

### Side by side

Generated by `scripts/sims/calibration-report.ts` from the four pinned records (command under Reproduce). Tournament share is the first archetype's share of decisive matches with its Wilson 95% interval ("clear" when it excludes 50%); each sim figure is the first archetype's share of its decisive games, labelled with its rung and lists per archetype. Sim figures are bot play, not human results; the tiers are never pooled (D21).

- Director Krennic, Amidst My Achievement vs Cad Bane, Still Faster than You: tournament 41.0% (180-259, [36.5%, 45.7%], clear); rung1, 1 list 0.0% (0 of 40); rung3:k=8, 1 list 7.5% (3 of 40); rung1, 3 lists 2.8% (2 of 72); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Director Krennic, Amidst My Achievement vs Luke Skywalker, Hero of Yavin: tournament 55.9% (213-168, [50.9%, 60.8%], clear); rung1, 1 list 2.5% (1 of 40); rung3:k=8, 1 list 17.5% (7 of 40); rung1, 3 lists 2.8% (2 of 72); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Director Krennic, Amidst My Achievement vs Boba Fett, Any Methods Necessary: tournament 56.0% (136-107, [49.7%, 62.1%]); rung1, 1 list 0.0% (0 of 40); rung3:k=8, 1 list 20.0% (8 of 40); rung1, 3 lists 1.4% (1 of 72); rung3mc:playout=rung1,n=2, 1 list 10.0% (1 of 10)
- Director Krennic, Amidst My Achievement vs Darth Vader, Victor Squadron Leader: tournament 62.7% (224-133, [57.6%, 67.6%], clear); rung1, 1 list 5.0% (2 of 40); rung3:k=8, 1 list 7.5% (3 of 40); rung1, 3 lists 6.9% (5 of 72); rung3mc:playout=rung1,n=2, 1 list 10.0% (1 of 10)
- Director Krennic, Amidst My Achievement vs Ahsoka Tano, Trust in the Force: tournament 57.1% (241-181, [52.3%, 61.8%], clear); rung1, 1 list 5.0% (2 of 40); rung3:k=8, 1 list 37.5% (15 of 40); rung1, 3 lists 1.4% (1 of 72); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Director Krennic, Amidst My Achievement vs Admiral Piett, Commanding the Armada: tournament 67.3% (74-36, [58.1%, 75.3%], clear); rung1, 1 list 30.0% (12 of 40); rung3:k=8, 1 list 27.5% (11 of 40); rung1, 3 lists 18.1% (13 of 72); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Director Krennic, Amidst My Achievement vs The Mandalorian, We Can't Keep Running: tournament 42.7% (61-82, [34.8%, 50.8%]); rung1, 1 list 37.5% (15 of 40); rung3:k=8, 1 list 72.5% (29 of 40); rung1, 3 lists 43.1% (31 of 72); rung3mc:playout=rung1,n=2, 1 list 70.0% (7 of 10)
- Director Krennic, Amidst My Achievement vs Luke Skywalker, I Can Save Him: tournament 68.2% (90-42, [59.8%, 75.5%], clear); rung1, 1 list 5.0% (2 of 40); rung3:k=8, 1 list 40.0% (16 of 40); rung1, 3 lists 1.4% (1 of 72); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Director Krennic, Amidst My Achievement vs Lando Calrissian, Full Sabacc: tournament 55.7% (103-82, [48.5%, 62.6%]); rung1, 1 list 10.0% (4 of 40); rung3:k=8, 1 list 60.0% (24 of 40); rung1, 3 lists 18.1% (13 of 72); rung3mc:playout=rung1,n=2, 1 list 90.0% (9 of 10)
- Director Krennic, Amidst My Achievement vs Darth Maul, Sith Revealed: tournament 60.7% (142-92, [54.3%, 66.7%], clear); rung1, 1 list 2.5% (1 of 40); rung3:k=8, 1 list 20.0% (8 of 40); rung1, 3 lists 4.2% (3 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Director Krennic, Amidst My Achievement vs Aurra Sing, Assassin: tournament 64.3% (45-25, [52.6%, 74.5%], clear); rung1, 1 list 10.0% (4 of 40); rung3:k=8, 1 list 35.0% (14 of 40); rung1, 3 lists 40.3% (29 of 72); rung3mc:playout=rung1,n=2, 1 list 30.0% (3 of 10)
- Cad Bane, Still Faster than You vs Luke Skywalker, Hero of Yavin: tournament 54.5% (278-232, [50.2%, 58.8%], clear); rung1, 1 list 57.5% (23 of 40); rung3:k=8, 1 list 62.5% (25 of 40); rung1, 3 lists 36.1% (26 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Cad Bane, Still Faster than You vs Boba Fett, Any Methods Necessary: tournament 55.9% (224-177, [51.0%, 60.6%], clear); rung1, 1 list 42.5% (17 of 40); rung3:k=8, 1 list 55.0% (22 of 40); rung1, 3 lists 50.0% (36 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- Cad Bane, Still Faster than You vs Darth Vader, Victor Squadron Leader: tournament 60.2% (310-205, [55.9%, 64.3%], clear); rung1, 1 list 42.5% (17 of 40); rung3:k=8, 1 list 42.5% (17 of 40); rung1, 3 lists 48.6% (34 of 70); rung3mc:playout=rung1,n=2, 1 list 11.1% (1 of 9)
- Cad Bane, Still Faster than You vs Ahsoka Tano, Trust in the Force: tournament 58.7% (289-203, [54.3%, 63.0%], clear); rung1, 1 list 97.3% (36 of 37); rung3:k=8, 1 list 90.0% (36 of 40); rung1, 3 lists 63.5% (40 of 63); rung3mc:playout=rung1,n=2, 1 list 100.0% (8 of 8)
- Cad Bane, Still Faster than You vs Admiral Piett, Commanding the Armada: tournament 47.7% (73-80, [40.0%, 55.6%]); rung1, 1 list 82.5% (33 of 40); rung3:k=8, 1 list 82.5% (33 of 40); rung1, 3 lists 87.5% (63 of 72); rung3mc:playout=rung1,n=2, 1 list 55.6% (5 of 9)
- Cad Bane, Still Faster than You vs The Mandalorian, We Can't Keep Running: tournament 55.7% (137-109, [49.4%, 61.8%]); rung1, 1 list 97.5% (39 of 40); rung3:k=8, 1 list 90.0% (36 of 40); rung1, 3 lists 100.0% (72 of 72); rung3mc:playout=rung1,n=2, 1 list 70.0% (7 of 10)
- Cad Bane, Still Faster than You vs Luke Skywalker, I Can Save Him: tournament 62.2% (89-54, [54.1%, 69.8%], clear); rung1, 1 list 62.5% (25 of 40); rung3:k=8, 1 list 75.0% (30 of 40); rung1, 3 lists 52.2% (36 of 69); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Cad Bane, Still Faster than You vs Lando Calrissian, Full Sabacc: tournament 58.9% (146-102, [52.7%, 64.8%], clear); rung1, 1 list 97.5% (39 of 40); rung3:k=8, 1 list 85.0% (34 of 40); rung1, 3 lists 91.7% (66 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- Cad Bane, Still Faster than You vs Darth Maul, Sith Revealed: tournament 58.3% (74-53, [49.6%, 66.5%]); rung1, 1 list 75.0% (30 of 40); rung3:k=8, 1 list 62.5% (25 of 40); rung1, 3 lists 70.8% (51 of 72); rung3mc:playout=rung1,n=2, 1 list 90.0% (9 of 10)
- Cad Bane, Still Faster than You vs Aurra Sing, Assassin: tournament 70.2% (59-25, [59.8%, 79.0%], clear); rung1, 1 list 100.0% (40 of 40); rung3:k=8, 1 list 100.0% (40 of 40); rung1, 3 lists 97.2% (70 of 72); rung3mc:playout=rung1,n=2, 1 list 100.0% (10 of 10)
- Luke Skywalker, Hero of Yavin vs Boba Fett, Any Methods Necessary: tournament 60.1% (155-103, [54.0%, 65.9%], clear); rung1, 1 list 20.0% (8 of 40); rung3:k=8, 1 list 20.0% (8 of 40); rung1, 3 lists 31.9% (23 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Luke Skywalker, Hero of Yavin vs Darth Vader, Victor Squadron Leader: tournament 64.1% (221-124, [58.9%, 68.9%], clear); rung1, 1 list 80.0% (32 of 40); rung3:k=8, 1 list 57.5% (23 of 40); rung1, 3 lists 76.4% (55 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- Luke Skywalker, Hero of Yavin vs Ahsoka Tano, Trust in the Force: tournament 40.1% (156-233, [35.4%, 45.1%], clear); rung1, 1 list 70.0% (28 of 40); rung3:k=8, 1 list 45.0% (18 of 40); rung1, 3 lists 65.3% (47 of 72); rung3mc:playout=rung1,n=2, 1 list 90.0% (9 of 10)
- Luke Skywalker, Hero of Yavin vs Admiral Piett, Commanding the Armada: tournament 42.6% (46-62, [33.7%, 52.0%]); rung1, 1 list 72.5% (29 of 40); rung3:k=8, 1 list 70.0% (28 of 40); rung1, 3 lists 80.6% (58 of 72); rung3mc:playout=rung1,n=2, 1 list 50.0% (5 of 10)
- Luke Skywalker, Hero of Yavin vs The Mandalorian, We Can't Keep Running: tournament 45.6% (68-81, [37.9%, 53.6%]); rung1, 1 list 72.5% (29 of 40); rung3:k=8, 1 list 52.5% (21 of 40); rung1, 3 lists 77.8% (56 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- Luke Skywalker, Hero of Yavin vs Luke Skywalker, I Can Save Him: tournament 43.4% (46-60, [34.4%, 52.9%]); rung1, 1 list 45.0% (18 of 40); rung3:k=8, 1 list 37.5% (15 of 40); rung1, 3 lists 45.8% (33 of 72); rung3mc:playout=rung1,n=2, 1 list 50.0% (5 of 10)
- Luke Skywalker, Hero of Yavin vs Lando Calrissian, Full Sabacc: tournament 35.7% (50-90, [28.3%, 43.9%], clear); rung1, 1 list 77.5% (31 of 40); rung3:k=8, 1 list 60.0% (24 of 40); rung1, 3 lists 90.3% (65 of 72); rung3mc:playout=rung1,n=2, 1 list 90.0% (9 of 10)
- Luke Skywalker, Hero of Yavin vs Darth Maul, Sith Revealed: tournament 60.3% (91-60, [52.3%, 67.7%], clear); rung1, 1 list 62.5% (25 of 40); rung3:k=8, 1 list 60.0% (24 of 40); rung1, 3 lists 47.2% (34 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Luke Skywalker, Hero of Yavin vs Aurra Sing, Assassin: tournament 40.7% (35-51, [30.9%, 51.3%]); rung1, 1 list 52.5% (21 of 40); rung3:k=8, 1 list 62.5% (25 of 40); rung1, 3 lists 73.6% (53 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Boba Fett, Any Methods Necessary vs Darth Vader, Victor Squadron Leader: tournament 55.6% (163-130, [49.9%, 61.2%]); rung1, 1 list 75.0% (30 of 40); rung3:k=8, 1 list 52.5% (21 of 40); rung1, 3 lists 77.1% (54 of 70); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Boba Fett, Any Methods Necessary vs Ahsoka Tano, Trust in the Force: tournament 33.2% (104-209, [28.2%, 38.6%], clear); rung1, 1 list 100.0% (37 of 37); rung3:k=8, 1 list 70.0% (28 of 40); rung1, 3 lists 78.3% (54 of 69); rung3mc:playout=rung1,n=2, 1 list 77.8% (7 of 9)
- Boba Fett, Any Methods Necessary vs Admiral Piett, Commanding the Armada: tournament 40.0% (28-42, [29.3%, 51.7%]); rung1, 1 list 80.0% (32 of 40); rung3:k=8, 1 list 72.5% (29 of 40); rung1, 3 lists 79.2% (57 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Boba Fett, Any Methods Necessary vs The Mandalorian, We Can't Keep Running: tournament 59.6% (81-55, [51.2%, 67.4%], clear); rung1, 1 list 97.5% (39 of 40); rung3:k=8, 1 list 80.0% (32 of 40); rung1, 3 lists 91.7% (66 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Boba Fett, Any Methods Necessary vs Luke Skywalker, I Can Save Him: tournament 52.3% (56-51, [43.0%, 61.6%]); rung1, 1 list 64.1% (25 of 39); rung3:k=8, 1 list 45.0% (18 of 40); rung1, 3 lists 55.7% (39 of 70); rung3mc:playout=rung1,n=2, 1 list 30.0% (3 of 10)
- Boba Fett, Any Methods Necessary vs Lando Calrissian, Full Sabacc: tournament 53.6% (52-45, [43.7%, 63.2%]); rung1, 1 list 92.5% (37 of 40); rung3:k=8, 1 list 82.5% (33 of 40); rung1, 3 lists 87.5% (63 of 72); rung3mc:playout=rung1,n=2, 1 list 66.7% (6 of 9)
- Boba Fett, Any Methods Necessary vs Darth Maul, Sith Revealed: tournament 71.2% (84-34, [62.5%, 78.6%], clear); rung1, 1 list 72.5% (29 of 40); rung3:k=8, 1 list 60.0% (24 of 40); rung1, 3 lists 65.3% (47 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Boba Fett, Any Methods Necessary vs Aurra Sing, Assassin: tournament 35.4% (28-51, [25.8%, 46.4%], clear); rung1, 1 list 77.5% (31 of 40); rung3:k=8, 1 list 57.5% (23 of 40); rung1, 3 lists 84.7% (61 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Darth Vader, Victor Squadron Leader vs Ahsoka Tano, Trust in the Force: tournament 49.9% (183-184, [44.8%, 54.9%]); rung1, 1 list 65.0% (26 of 40); rung3:k=8, 1 list 72.5% (29 of 40); rung1, 3 lists 52.8% (38 of 72); rung3mc:playout=rung1,n=2, 1 list 70.0% (7 of 10)
- Darth Vader, Victor Squadron Leader vs Admiral Piett, Commanding the Armada: tournament 59.8% (52-35, [49.3%, 69.5%]); rung1, 1 list 67.5% (27 of 40); rung3:k=8, 1 list 80.0% (32 of 40); rung1, 3 lists 66.7% (48 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Darth Vader, Victor Squadron Leader vs The Mandalorian, We Can't Keep Running: tournament 40.0% (44-66, [31.3%, 49.3%], clear); rung1, 1 list 62.5% (25 of 40); rung3:k=8, 1 list 55.0% (22 of 40); rung1, 3 lists 73.6% (53 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Darth Vader, Victor Squadron Leader vs Luke Skywalker, I Can Save Him: tournament 54.9% (67-55, [46.1%, 63.5%]); rung1, 1 list 45.0% (18 of 40); rung3:k=8, 1 list 45.0% (18 of 40); rung1, 3 lists 31.9% (23 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Darth Vader, Victor Squadron Leader vs Lando Calrissian, Full Sabacc: tournament 17.1% (22-107, [11.5%, 24.5%], clear); rung1, 1 list 56.4% (22 of 39); rung3:k=8, 1 list 70.0% (28 of 40); rung1, 3 lists 68.1% (49 of 72); rung3mc:playout=rung1,n=2, 1 list 50.0% (5 of 10)
- Darth Vader, Victor Squadron Leader vs Darth Maul, Sith Revealed: tournament 52.9% (73-65, [44.6%, 61.0%]); rung1, 1 list 57.5% (23 of 40); rung3:k=8, 1 list 67.5% (27 of 40); rung1, 3 lists 38.9% (28 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Darth Vader, Victor Squadron Leader vs Aurra Sing, Assassin: tournament 32.1% (18-38, [21.4%, 45.2%], clear); rung1, 1 list 51.3% (20 of 39); rung3:k=8, 1 list 62.5% (25 of 40); rung1, 3 lists 54.2% (39 of 72); rung3mc:playout=rung1,n=2, 1 list 37.5% (3 of 8)
- Ahsoka Tano, Trust in the Force vs Admiral Piett, Commanding the Armada: tournament 75.8% (69-22, [66.1%, 83.5%], clear); rung1, 1 list 55.0% (22 of 40); rung3:k=8, 1 list 47.5% (19 of 40); rung1, 3 lists 72.2% (52 of 72); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Ahsoka Tano, Trust in the Force vs The Mandalorian, We Can't Keep Running: tournament 80.3% (114-28, [73.0%, 86.0%], clear); rung1, 1 list 62.5% (25 of 40); rung3:k=8, 1 list 62.5% (25 of 40); rung1, 3 lists 100.0% (72 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Ahsoka Tano, Trust in the Force vs Luke Skywalker, I Can Save Him: tournament 62.9% (61-36, [52.9%, 71.8%], clear); rung1, 1 list 10.0% (4 of 40); rung3:k=8, 1 list 22.5% (9 of 40); rung1, 3 lists 54.2% (39 of 72); rung3mc:playout=rung1,n=2, 1 list 30.0% (3 of 10)
- Ahsoka Tano, Trust in the Force vs Lando Calrissian, Full Sabacc: tournament 41.2% (61-87, [33.6%, 49.3%], clear); rung1, 1 list 62.5% (25 of 40); rung3:k=8, 1 list 70.0% (28 of 40); rung1, 3 lists 98.6% (71 of 72); rung3mc:playout=rung1,n=2, 1 list 70.0% (7 of 10)
- Ahsoka Tano, Trust in the Force vs Darth Maul, Sith Revealed: tournament 32.3% (54-113, [25.7%, 39.8%], clear); rung1, 1 list 7.5% (3 of 40); rung3:k=8, 1 list 20.0% (8 of 40); rung1, 3 lists 35.7% (25 of 70); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- Ahsoka Tano, Trust in the Force vs Aurra Sing, Assassin: tournament 34.3% (25-48, [24.4%, 45.7%], clear); rung1, 1 list 2.5% (1 of 40); rung3:k=8, 1 list 15.0% (6 of 40); rung1, 3 lists 55.6% (40 of 72); rung3mc:playout=rung1,n=2, 1 list 10.0% (1 of 10)
- Admiral Piett, Commanding the Armada vs The Mandalorian, We Can't Keep Running: tournament 59.0% (23-16, [43.4%, 72.9%]); rung1, 1 list 70.0% (28 of 40); rung3:k=8, 1 list 75.0% (30 of 40); rung1, 3 lists 63.9% (46 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- Admiral Piett, Commanding the Armada vs Luke Skywalker, I Can Save Him: tournament 57.8% (26-19, [43.3%, 71.0%]); rung1, 1 list 35.0% (14 of 40); rung3:k=8, 1 list 52.5% (21 of 40); rung1, 3 lists 29.2% (21 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Admiral Piett, Commanding the Armada vs Lando Calrissian, Full Sabacc: tournament 37.8% (17-28, [25.1%, 52.4%]); rung1, 1 list 45.0% (18 of 40); rung3:k=8, 1 list 67.5% (27 of 40); rung1, 3 lists 51.4% (37 of 72); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Admiral Piett, Commanding the Armada vs Darth Maul, Sith Revealed: tournament 48.0% (24-26, [34.8%, 61.5%]); rung1, 1 list 45.0% (18 of 40); rung3:k=8, 1 list 47.5% (19 of 40); rung1, 3 lists 25.0% (18 of 72); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Admiral Piett, Commanding the Armada vs Aurra Sing, Assassin: tournament 46.7% (7-8, [24.8%, 69.9%]); rung1, 1 list 37.5% (15 of 40); rung3:k=8, 1 list 42.5% (17 of 40); rung1, 3 lists 37.5% (27 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- The Mandalorian, We Can't Keep Running vs Luke Skywalker, I Can Save Him: tournament 50.0% (26-26, [36.9%, 63.1%]); rung1, 1 list 10.0% (4 of 40); rung3:k=8, 1 list 27.5% (11 of 40); rung1, 3 lists 4.2% (3 of 72); rung3mc:playout=rung1,n=2, 1 list 60.0% (6 of 10)
- The Mandalorian, We Can't Keep Running vs Lando Calrissian, Full Sabacc: tournament 52.2% (36-33, [40.6%, 63.5%]); rung1, 1 list 15.0% (6 of 40); rung3:k=8, 1 list 42.5% (17 of 40); rung1, 3 lists 15.3% (11 of 72); rung3mc:playout=rung1,n=2, 1 list 77.8% (7 of 9)
- The Mandalorian, We Can't Keep Running vs Darth Maul, Sith Revealed: tournament 71.0% (44-18, [58.7%, 80.8%], clear); rung1, 1 list 5.0% (2 of 40); rung3:k=8, 1 list 10.0% (4 of 40); rung1, 3 lists 8.5% (6 of 71); rung3mc:playout=rung1,n=2, 1 list 20.0% (2 of 10)
- The Mandalorian, We Can't Keep Running vs Aurra Sing, Assassin: tournament 77.4% (24-7, [60.2%, 88.6%], clear); rung1, 1 list 10.0% (4 of 40); rung3:k=8, 1 list 7.5% (3 of 40); rung1, 3 lists 20.8% (15 of 72); rung3mc:playout=rung1,n=2, 1 list 10.0% (1 of 10)
- Luke Skywalker, I Can Save Him vs Lando Calrissian, Full Sabacc: tournament 27.1% (13-35, [16.6%, 41.0%], clear); rung1, 1 list 92.3% (36 of 39); rung3:k=8, 1 list 95.0% (38 of 40); rung1, 3 lists 85.9% (61 of 71); rung3mc:playout=rung1,n=2, 1 list 80.0% (8 of 10)
- Luke Skywalker, I Can Save Him vs Darth Maul, Sith Revealed: tournament 36.2% (21-37, [25.1%, 49.1%], clear); rung1, 1 list 42.5% (17 of 40); rung3:k=8, 1 list 45.0% (18 of 40); rung1, 3 lists 28.2% (20 of 71); rung3mc:playout=rung1,n=2, 1 list 40.0% (4 of 10)
- Luke Skywalker, I Can Save Him vs Aurra Sing, Assassin: tournament 45.8% (11-13, [27.9%, 64.9%]); rung1, 1 list 75.0% (30 of 40); rung3:k=8, 1 list 65.0% (26 of 40); rung1, 3 lists 76.4% (55 of 72); rung3mc:playout=rung1,n=2, 1 list 30.0% (3 of 10)
- Lando Calrissian, Full Sabacc vs Darth Maul, Sith Revealed: tournament 59.1% (52-36, [48.6%, 68.8%]); rung1, 1 list 30.0% (12 of 40); rung3:k=8, 1 list 7.5% (3 of 40); rung1, 3 lists 11.1% (8 of 72); rung3mc:playout=rung1,n=2, 1 list 0.0% (0 of 10)
- Lando Calrissian, Full Sabacc vs Aurra Sing, Assassin: tournament 65.6% (21-11, [48.3%, 79.6%]); rung1, 1 list 32.5% (13 of 40); rung3:k=8, 1 list 30.0% (12 of 40); rung1, 3 lists 54.2% (39 of 72); rung3mc:playout=rung1,n=2, 1 list 0.0% (0 of 10)
- Darth Maul, Sith Revealed vs Aurra Sing, Assassin: tournament 51.3% (19-18, [35.9%, 66.5%]); rung1, 1 list 67.5% (27 of 40); rung3:k=8, 1 list 80.0% (32 of 40); rung1, 3 lists 81.9% (59 of 72); rung3mc:playout=rung1,n=2, 1 list 90.0% (9 of 10)

## Follow-up: orientation, identity, several lists, Monte Carlo (#171, D90)

The negative Spearman is real. It is not an orientation or identity bug, and it is not the choice of one list per archetype. The bots mis-rank these matchups.

### Orientation audit

The three pinned rows with the most tournament evidence were traced by hand, from the raw swumetastats rows (`data/originals/tournaments/2026-10-17/matchups.json`) through `meta/winrates.json` to the gate's pairing and the sim's seat and winner fields: Cad Bane / Vigilance against Darth Vader / Cunning (515 decisive matches), against Luke Skywalker, Hero of Yavin / Command (510) and against Ahsoka Tano / Vigilance (492).

- Raw rows. Each row carries `leader`, `opponentLeader`, `wins` and `losses`, and every match is listed once from each side: Cad Bane's rows against Vader sum to 310-207 and Vader's rows against Cad Bane to 207-310. The two other pairs mirror the same way (279-234, 289-205).
- The `wins` column belongs to the row's leader. Checked against an independent field, the decklists' own match records (`metadata.matchRecord` in `data/originals/decks/2026-10-17`): per leader, the table's win share and the decklists' win share agree with Spearman 0.91 over 23 leaders with at least 300 matches in both, and -0.91 if the column were the opponent's.
- The fold keeps the row's side: the pair key starts with the row's own leader and base aspects and adds the row's wins (`foldMatchups`, `src/meta/outcomes.ts:78`), so `winrates.json` holds Cad Bane against Vader at 310-205 and the mirror at 205-310. The few matches that differ from the raw sum are rows whose base name resolves to other aspects than the row's aspect word.
- The gate reads the first panel archetype's record (`tournamentRecord`, `src/sims/calibration.ts:109`) and counts the first archetype's sim wins: a seat-1 win counts for it exactly when it sat in seat 1 (`simRecordOf`, `src/sims/calibration.ts:424`).
- Seat and winner. Seat 1 is decks[0] (`src/sims/match.ts:50`) and engine player1, user name `sim1` (`src/sims/engine.ts:249`, `src/sims/engine.ts:276`). forceteki names a player by its user name (forceteki `server/game/core/Player.ts:204`), and the winner is the opponent of the player whose base is destroyed (forceteki `server/game/core/Game.ts:944`). `sim1` maps to seat 1 (`src/sims/session.ts:277`). The pool returns results in input order and throws on a gap (`src/sims/pool.ts:93`).

`tests/sims/calibration-orientation.test.ts` pins every link. The synthetic cases always run. The pinned-data cases (`tests/sims/calibration-orientation.test.ts:160`) assert, for the three rows, that the raw rows mirror, that the gate's tournament record equals the folded pair and sits on the raw favourite's side, that the pinned record's row and panel name the same archetypes in the same order, and that the wins column ranks leaders like the decklists' own records (`tests/sims/calibration-orientation.test.ts:196`). The engine case plays real games on the pinned forceteki in both seat orders; it checks that the seat leaders are the panel's, that the winner's opponent's base is destroyed, and that the win counts for the archetype in the winning seat (`tests/sims/calibration-orientation.test.ts:246`).

The gate's job layout, seat order and win count moved from the script into `src/sims/calibration.ts` (`calibrationJobs`, `src/sims/calibration.ts:387`; `seats`, `src/sims/calibration.ts:405`), so the test runs the gate's own code. A rerun of rung 1 on the refactored gate reproduced the pinned record field for field, apart from the code commit.

### Archetype identity

All 12 panel lists are members of their archetype by the list's own cards, not only by the archetype it was assigned to: each list's leader cardKey and base aspects equal the archetype's (`tests/sims/calibration-orientation.test.ts:185`). Each is a first-place list. The tournament figure is per leader and base aspects, which is the archetype's key. It aggregates over every base with those aspects and over hundreds of lists, so one list can sit far from the aggregate. That is what step 3 measures.

### Several lists per archetype

Rung 1 was rerun with 3 lists per archetype. They are the first 3 distinct buildable lists of the sampler's seeded, placement-weighted draw (`sampleStratified`, sampler seed `calibration-lists-v1`). The panel holds 36 lists, none of them a v1 list. Each pair played 72 games: 36 seeds, each list pairing on 4 seeds, every seed in both seat orders, on the same seed scheme. Record: `data/pinned/sim-calibration-v1/lists3/calibration-rung1.json`. It sits in a subfolder because the tool reads only the top folder (`src/tools/sims.ts:138`) and D88's gate design is one list and 40 games per pair.

- Replay 50 of 50 (thread, replay, undo on). Health: 4,752 games, 26 not decisive (0.55%), fallback 0.28%. Ladder pass.
- External: Spearman -0.21 [95% interval -0.43, 0.04] over 66 pairs; the favourite agrees in 13 of 37 clear matchups, with one sim tie (35.1% [21.8%, 51.2%], one-sided p = 0.98). Fail.
- For comparison, one list: rung 1 -0.17 [-0.40, 0.08], 15 of 37 (40.5% [26.4%, 56.5%]); rung 3 top-K -0.21 [-0.43, 0.04], 16 of 37 (43.2% [28.7%, 59.1%]). The intervals are Fisher's z with the Bonett-Wright variance for Spearman and Wilson for agreement (`spearmanInterval`, `src/sims/calibration.ts:352`). No upper bound reaches the 0.5 bar.
- Rung 1's sim shares on one list and on three different lists rank the pairs alike (Spearman 0.87), so the ranking belongs to the bot, not the list.

### Rung 3 flat Monte Carlo, a probe (`rung3mc:playout=rung1,n=2`)

Step 4 of #171 ran because rung 3 top-K still fails. The panel is the one-list panel, at 10 games per pair (seeds q < 5, a subset of the v1 seeds), because a Monte Carlo game with both seats searching costs about 190 times a rung 1 game (0.25 against 47 games per second on 12 workers). Record: `data/pinned/sim-calibration-v1/mc-probe/calibration-rung3mc-playout-rung1-n-2.json`. It is a probe, not a D88 gate record. It replays 10 matches, not 50, and the thread replay of a Monte Carlo game is a full search game, about a minute each. The rung's own replay fidelity is pinned elsewhere (`docs/verification/2026-10-31-bot-ladder.md:131`), and the record cites `rung3-fidelity.json` by hash.

- Replay 10 of 10 (thread, replay by descriptor). Health: 660 games, 9 engine errors (1.36%), fallback 0.52%. Pass.
- Ladder: fails, because no `rung3mc-vs-rung0.json` record exists; `rung3mc-vs-rung1.json` passes.
- External: Spearman -0.20 [-0.42, 0.05] over 66 pairs; the favourite agrees in 15 of 37 clear matchups, with one sim tie (40.5% [26.4%, 56.5%], one-sided p = 0.91). Fail.
- Its shares rank the pairs like the other rungs' (Spearman 0.59 with rung 1 and 0.66 with rung 3 top-K, lower because 10 games per pair is noisier). Search moves single archetypes, not the ranking: it halves Boba Fett's overrating and most of the Mandalorian's underrating, and makes Lando worse.
- Wall time: 44 minutes of games on 12 workers (0.25 games per second) and 5 minutes of replay.

### Per archetype: pilot or list

Mean signed error is the sim share minus the tournament share, from the archetype's side, over its 11 matchups. The four figures are rung 1 on one list, rung 3 top-K on one list, rung 1 on three lists, and the rung 3 Monte Carlo probe on one list.

- Director Krennic (Vigilance control): -47.6, -26.0, -44.7, -25.6 points. Pilot. The error stays with new lists and halves under either search, so it is the bot's control play.
- The Mandalorian, We Can't Keep Running: -29.8, -24.3, -33.5, -7.3. Pilot. The error persists across lists, and only Monte Carlo search closes most of it.
- Lando Calrissian, Full Sabacc: -21.1, -31.0, -26.1, -37.3. Pilot. Each search makes it worse, consistent with a leader whose choices rest on hidden information.
- Boba Fett (neutral base): +33.4, +17.8, +27.9, +6.9. Pilot. Bots overrate it, and search shrinks the overrating.
- Luke Skywalker, I Can Save Him: +25.1, +18.4, +23.5, +13.0. Pilot.
- Darth Maul, Sith Revealed: +15.1, +16.2, +22.3, +9.0. Pilot.
- Cad Bane: +19.4, +17.8, +14.0, +9.6. Pilot.
- Darth Vader, Victor Squadron Leader: +12.6, +20.8, +10.3, +19.3. Pilot.
- Luke Skywalker, Hero of Yavin: +15.5, +5.7, +20.7, +19.8. Pilot. Top-K search brings it close; Monte Carlo does not.
- Ahsoka Tano: -20.5, -15.0, +6.1, -23.2. List. The single first-place list plays far below the archetype under every rung, and three drawn lists land near the tournament figure.
- Aurra Sing: +4.3, +0.6, -10.2, +7.0. List-sensitive and small.
- Admiral Piett: -6.5, -1.0, -10.3, +8.9. Near calibration under every record.

The pattern is a tempo bias. The bots overrate proactive decks (Boba Fett, both Lukes, Darth Maul, Cad Bane, Vader) and underrate decks that need lines (Krennic, the Mandalorian, Lando). The gate exists to catch exactly that bias.

## Decision

`simulate_matchup` may not show a win share. No rung has a record that passes all four gates, so the tool answers every simulation request with an error that names the failed gate and its figures (`failedGateSentence`, `src/sims/calibration.ts:310`); it still checks the deck and states the plan, and its job machinery, tested on fixtures and on the engine, serves a rung the moment a record for it passes. The thresholds (Spearman 0.5, sign test p < 0.05) were fixed before either measurement and are unchanged; both rungs miss them by a wide margin, so no threshold between the estimate and the measurements would have changed the verdict. #171 (D90) ruled out an orientation or identity bug and the list choice; see the follow-up section. The rung 3 Monte Carlo probe fails the external gate the same way (-0.20) and has no ladder record against rung 0. What remains is the pilot: a bot that plays control and hidden-information decks better, measured with this same gate.

## Why the gate exists: the spike's example

A random-move win share is dominated by how often each deck's cards get played at all. In the forceteki spike (`docs/research/forceteki-simulation.md:121`) a simple policy reversed one of three tested matchup orders: Krennic against Luke went from 56 to 44 with random bots to 33 to 67 with a greedy bot, and Krennic against Cad Bane moved from 41 to 53 to 22 to 78. A win share that a pilot change can flip says nothing about the deck until the pilot's rankings are checked against real results, and that check is this gate.

## Reproduce

    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung1
    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/ladder.ts --mode ladder --candidate rung3:k=8 --baseline rung0 --pairs 200 --step rung3-vs-rung0
    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung3:k=8
    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung1 --lists 3 --games 72 --out data/pinned/sim-calibration-v1/lists3
    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung3mc:playout=rung1,n=2 --games 10 --chunk 4 --replay 10 --out data/pinned/sim-calibration-v1/mc-probe
    node --import tsx scripts/sims/calibration-report.ts data/pinned/sim-calibration-v1/calibration-rung1.json data/pinned/sim-calibration-v1/calibration-rung3-k-8.json data/pinned/sim-calibration-v1/lists3/calibration-rung1.json data/pinned/sim-calibration-v1/mc-probe/calibration-rung3mc-playout-rung1-n-2.json
    TMPDIR="$PWD/tmp" node node_modules/vitest/vitest.mjs run tests/sims/calibration-orientation.test.ts

Each record holds no clock field; the same seeds, code, engine and inputs give the same record.
