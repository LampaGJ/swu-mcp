---
type: spec
status: active
review_by: 2027-01-31
related: ["docs/research/sim-bot-policy-ladder.md", "docs/verification/2026-10-31-bot-ladder.md", "docs/decisions.md"]
---

# Simulation calibration gate, 2026-10-31

## TL;DR

Both measured bot rungs fail the external calibration gate, so `simulate_matchup` reports no win share yet. Rung 1 ranks the 66 matchups among the 12 largest tournament archetypes with Spearman -0.17 against the tournament results and picks the tournament favourite in 15 of 37 clear matchups; rung 3 top-K (`rung3:k=8`) scores -0.21 and 16 of 37. Both pass the replay, health and ladder gates. The two rungs agree with each other (Spearman 0.83 between their sim shares) and disagree with the tournaments, and their shares sit twice as far from 50% (mean distance 0.26 and 0.20 against 0.11), so the gap is systematic: the bots pilot some archetypes far worse than people do (Krennic most of all), and one list stands for each archetype. The thresholds stay where they were set before the measurement.

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

The rung 1 and rung 3 sim shares rank the pairs alike (Spearman 0.83), so the disagreement with the tournaments is not sampling noise in 40 games per pair: it is how these bots play these lists. Two causes are open and untested here. First, pilot skill: a deck that needs lines (Krennic's control plan, Lando's Sabacc leader) loses value under a weak pilot, which the ladder doc calls pilot sensitivity. Second, one list per archetype: the highest-placing buildable list stands for an archetype that tournament results aggregate over hundreds of lists.

### Side by side

Tournament share is the first archetype's share of decisive matches with its Wilson 95% interval ("clear" when it excludes 50%); each sim figure is the first archetype's wins of 40 games' decisive games.

- Director Krennic, Amidst My Achievement / Vigilance vs Cad Bane, Still Faster than You / Vigilance: tournament 41.0% (180-259, [36.5%, 45.7%], clear); rung 1 0.0% (0 of 40); rung 3 top-K 7.5% (3 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Luke Skywalker, Hero of Yavin / Command: tournament 55.9% (213-168, [50.9%, 60.8%], clear); rung 1 2.5% (1 of 40); rung 3 top-K 17.5% (7 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Boba Fett, Any Methods Necessary / neutral: tournament 56.0% (136-107, [49.7%, 62.1%]); rung 1 0.0% (0 of 40); rung 3 top-K 20.0% (8 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Darth Vader, Victor Squadron Leader / Cunning: tournament 62.7% (224-133, [57.6%, 67.6%], clear); rung 1 5.0% (2 of 40); rung 3 top-K 7.5% (3 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Ahsoka Tano, Trust in the Force / Vigilance: tournament 57.1% (241-181, [52.3%, 61.8%], clear); rung 1 5.0% (2 of 40); rung 3 top-K 37.5% (15 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Admiral Piett, Commanding the Armada / Aggression: tournament 67.3% (74-36, [58.1%, 75.3%], clear); rung 1 30.0% (12 of 40); rung 3 top-K 27.5% (11 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 42.7% (61-82, [34.8%, 50.8%]); rung 1 37.5% (15 of 40); rung 3 top-K 72.5% (29 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Luke Skywalker, I Can Save Him / Command: tournament 68.2% (90-42, [59.8%, 75.5%], clear); rung 1 5.0% (2 of 40); rung 3 top-K 40.0% (16 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Lando Calrissian, Full Sabacc / Vigilance: tournament 55.7% (103-82, [48.5%, 62.6%]); rung 1 10.0% (4 of 40); rung 3 top-K 60.0% (24 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Darth Maul, Sith Revealed / Vigilance: tournament 60.7% (142-92, [54.3%, 66.7%], clear); rung 1 2.5% (1 of 40); rung 3 top-K 20.0% (8 of 40)
- Director Krennic, Amidst My Achievement / Vigilance vs Aurra Sing, Assassin / Command: tournament 64.3% (45-25, [52.6%, 74.5%], clear); rung 1 10.0% (4 of 40); rung 3 top-K 35.0% (14 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Luke Skywalker, Hero of Yavin / Command: tournament 54.5% (278-232, [50.2%, 58.8%], clear); rung 1 57.5% (23 of 40); rung 3 top-K 62.5% (25 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Boba Fett, Any Methods Necessary / neutral: tournament 55.9% (224-177, [51.0%, 60.6%], clear); rung 1 42.5% (17 of 40); rung 3 top-K 55.0% (22 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Darth Vader, Victor Squadron Leader / Cunning: tournament 60.2% (310-205, [55.9%, 64.3%], clear); rung 1 42.5% (17 of 40); rung 3 top-K 42.5% (17 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Ahsoka Tano, Trust in the Force / Vigilance: tournament 58.7% (289-203, [54.3%, 63.0%], clear); rung 1 97.3% (36 of 37); rung 3 top-K 90.0% (36 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Admiral Piett, Commanding the Armada / Aggression: tournament 47.7% (73-80, [40.0%, 55.6%]); rung 1 82.5% (33 of 40); rung 3 top-K 82.5% (33 of 40)
- Cad Bane, Still Faster than You / Vigilance vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 55.7% (137-109, [49.4%, 61.8%]); rung 1 97.5% (39 of 40); rung 3 top-K 90.0% (36 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Luke Skywalker, I Can Save Him / Command: tournament 62.2% (89-54, [54.1%, 69.8%], clear); rung 1 62.5% (25 of 40); rung 3 top-K 75.0% (30 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Lando Calrissian, Full Sabacc / Vigilance: tournament 58.9% (146-102, [52.7%, 64.8%], clear); rung 1 97.5% (39 of 40); rung 3 top-K 85.0% (34 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Darth Maul, Sith Revealed / Vigilance: tournament 58.3% (74-53, [49.6%, 66.5%]); rung 1 75.0% (30 of 40); rung 3 top-K 62.5% (25 of 40)
- Cad Bane, Still Faster than You / Vigilance vs Aurra Sing, Assassin / Command: tournament 70.2% (59-25, [59.8%, 79.0%], clear); rung 1 100.0% (40 of 40); rung 3 top-K 100.0% (40 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Boba Fett, Any Methods Necessary / neutral: tournament 60.1% (155-103, [54.0%, 65.9%], clear); rung 1 20.0% (8 of 40); rung 3 top-K 20.0% (8 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Darth Vader, Victor Squadron Leader / Cunning: tournament 64.1% (221-124, [58.9%, 68.9%], clear); rung 1 80.0% (32 of 40); rung 3 top-K 57.5% (23 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Ahsoka Tano, Trust in the Force / Vigilance: tournament 40.1% (156-233, [35.4%, 45.1%], clear); rung 1 70.0% (28 of 40); rung 3 top-K 45.0% (18 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Admiral Piett, Commanding the Armada / Aggression: tournament 42.6% (46-62, [33.7%, 52.0%]); rung 1 72.5% (29 of 40); rung 3 top-K 70.0% (28 of 40)
- Luke Skywalker, Hero of Yavin / Command vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 45.6% (68-81, [37.9%, 53.6%]); rung 1 72.5% (29 of 40); rung 3 top-K 52.5% (21 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Luke Skywalker, I Can Save Him / Command: tournament 43.4% (46-60, [34.4%, 52.9%]); rung 1 45.0% (18 of 40); rung 3 top-K 37.5% (15 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Lando Calrissian, Full Sabacc / Vigilance: tournament 35.7% (50-90, [28.3%, 43.9%], clear); rung 1 77.5% (31 of 40); rung 3 top-K 60.0% (24 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Darth Maul, Sith Revealed / Vigilance: tournament 60.3% (91-60, [52.3%, 67.7%], clear); rung 1 62.5% (25 of 40); rung 3 top-K 60.0% (24 of 40)
- Luke Skywalker, Hero of Yavin / Command vs Aurra Sing, Assassin / Command: tournament 40.7% (35-51, [30.9%, 51.3%]); rung 1 52.5% (21 of 40); rung 3 top-K 62.5% (25 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Darth Vader, Victor Squadron Leader / Cunning: tournament 55.6% (163-130, [49.9%, 61.2%]); rung 1 75.0% (30 of 40); rung 3 top-K 52.5% (21 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Ahsoka Tano, Trust in the Force / Vigilance: tournament 33.2% (104-209, [28.2%, 38.6%], clear); rung 1 100.0% (37 of 37); rung 3 top-K 70.0% (28 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Admiral Piett, Commanding the Armada / Aggression: tournament 40.0% (28-42, [29.3%, 51.7%]); rung 1 80.0% (32 of 40); rung 3 top-K 72.5% (29 of 40)
- Boba Fett, Any Methods Necessary / neutral vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 59.6% (81-55, [51.2%, 67.4%], clear); rung 1 97.5% (39 of 40); rung 3 top-K 80.0% (32 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Luke Skywalker, I Can Save Him / Command: tournament 52.3% (56-51, [43.0%, 61.6%]); rung 1 64.1% (25 of 39); rung 3 top-K 45.0% (18 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Lando Calrissian, Full Sabacc / Vigilance: tournament 53.6% (52-45, [43.7%, 63.2%]); rung 1 92.5% (37 of 40); rung 3 top-K 82.5% (33 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Darth Maul, Sith Revealed / Vigilance: tournament 71.2% (84-34, [62.5%, 78.6%], clear); rung 1 72.5% (29 of 40); rung 3 top-K 60.0% (24 of 40)
- Boba Fett, Any Methods Necessary / neutral vs Aurra Sing, Assassin / Command: tournament 35.4% (28-51, [25.8%, 46.4%], clear); rung 1 77.5% (31 of 40); rung 3 top-K 57.5% (23 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs Ahsoka Tano, Trust in the Force / Vigilance: tournament 49.9% (183-184, [44.8%, 54.9%]); rung 1 65.0% (26 of 40); rung 3 top-K 72.5% (29 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs Admiral Piett, Commanding the Armada / Aggression: tournament 59.8% (52-35, [49.3%, 69.5%]); rung 1 67.5% (27 of 40); rung 3 top-K 80.0% (32 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 40.0% (44-66, [31.3%, 49.3%], clear); rung 1 62.5% (25 of 40); rung 3 top-K 55.0% (22 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs Luke Skywalker, I Can Save Him / Command: tournament 54.9% (67-55, [46.1%, 63.5%]); rung 1 45.0% (18 of 40); rung 3 top-K 45.0% (18 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs Lando Calrissian, Full Sabacc / Vigilance: tournament 17.1% (22-107, [11.5%, 24.5%], clear); rung 1 56.4% (22 of 39); rung 3 top-K 70.0% (28 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs Darth Maul, Sith Revealed / Vigilance: tournament 52.9% (73-65, [44.6%, 61.0%]); rung 1 57.5% (23 of 40); rung 3 top-K 67.5% (27 of 40)
- Darth Vader, Victor Squadron Leader / Cunning vs Aurra Sing, Assassin / Command: tournament 32.1% (18-38, [21.4%, 45.2%], clear); rung 1 51.3% (20 of 39); rung 3 top-K 62.5% (25 of 40)
- Ahsoka Tano, Trust in the Force / Vigilance vs Admiral Piett, Commanding the Armada / Aggression: tournament 75.8% (69-22, [66.1%, 83.5%], clear); rung 1 55.0% (22 of 40); rung 3 top-K 47.5% (19 of 40)
- Ahsoka Tano, Trust in the Force / Vigilance vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 80.3% (114-28, [73.0%, 86.0%], clear); rung 1 62.5% (25 of 40); rung 3 top-K 62.5% (25 of 40)
- Ahsoka Tano, Trust in the Force / Vigilance vs Luke Skywalker, I Can Save Him / Command: tournament 62.9% (61-36, [52.9%, 71.8%], clear); rung 1 10.0% (4 of 40); rung 3 top-K 22.5% (9 of 40)
- Ahsoka Tano, Trust in the Force / Vigilance vs Lando Calrissian, Full Sabacc / Vigilance: tournament 41.2% (61-87, [33.6%, 49.3%], clear); rung 1 62.5% (25 of 40); rung 3 top-K 70.0% (28 of 40)
- Ahsoka Tano, Trust in the Force / Vigilance vs Darth Maul, Sith Revealed / Vigilance: tournament 32.3% (54-113, [25.7%, 39.8%], clear); rung 1 7.5% (3 of 40); rung 3 top-K 20.0% (8 of 40)
- Ahsoka Tano, Trust in the Force / Vigilance vs Aurra Sing, Assassin / Command: tournament 34.3% (25-48, [24.4%, 45.7%], clear); rung 1 2.5% (1 of 40); rung 3 top-K 15.0% (6 of 40)
- Admiral Piett, Commanding the Armada / Aggression vs The Mandalorian, We Can't Keep Running / Vigilance: tournament 59.0% (23-16, [43.4%, 72.9%]); rung 1 70.0% (28 of 40); rung 3 top-K 75.0% (30 of 40)
- Admiral Piett, Commanding the Armada / Aggression vs Luke Skywalker, I Can Save Him / Command: tournament 57.8% (26-19, [43.3%, 71.0%]); rung 1 35.0% (14 of 40); rung 3 top-K 52.5% (21 of 40)
- Admiral Piett, Commanding the Armada / Aggression vs Lando Calrissian, Full Sabacc / Vigilance: tournament 37.8% (17-28, [25.1%, 52.4%]); rung 1 45.0% (18 of 40); rung 3 top-K 67.5% (27 of 40)
- Admiral Piett, Commanding the Armada / Aggression vs Darth Maul, Sith Revealed / Vigilance: tournament 48.0% (24-26, [34.8%, 61.5%]); rung 1 45.0% (18 of 40); rung 3 top-K 47.5% (19 of 40)
- Admiral Piett, Commanding the Armada / Aggression vs Aurra Sing, Assassin / Command: tournament 46.7% (7-8, [24.8%, 69.9%]); rung 1 37.5% (15 of 40); rung 3 top-K 42.5% (17 of 40)
- The Mandalorian, We Can't Keep Running / Vigilance vs Luke Skywalker, I Can Save Him / Command: tournament 50.0% (26-26, [36.9%, 63.1%]); rung 1 10.0% (4 of 40); rung 3 top-K 27.5% (11 of 40)
- The Mandalorian, We Can't Keep Running / Vigilance vs Lando Calrissian, Full Sabacc / Vigilance: tournament 52.2% (36-33, [40.6%, 63.5%]); rung 1 15.0% (6 of 40); rung 3 top-K 42.5% (17 of 40)
- The Mandalorian, We Can't Keep Running / Vigilance vs Darth Maul, Sith Revealed / Vigilance: tournament 71.0% (44-18, [58.7%, 80.8%], clear); rung 1 5.0% (2 of 40); rung 3 top-K 10.0% (4 of 40)
- The Mandalorian, We Can't Keep Running / Vigilance vs Aurra Sing, Assassin / Command: tournament 77.4% (24-7, [60.2%, 88.6%], clear); rung 1 10.0% (4 of 40); rung 3 top-K 7.5% (3 of 40)
- Luke Skywalker, I Can Save Him / Command vs Lando Calrissian, Full Sabacc / Vigilance: tournament 27.1% (13-35, [16.6%, 41.0%], clear); rung 1 92.3% (36 of 39); rung 3 top-K 95.0% (38 of 40)
- Luke Skywalker, I Can Save Him / Command vs Darth Maul, Sith Revealed / Vigilance: tournament 36.2% (21-37, [25.1%, 49.1%], clear); rung 1 42.5% (17 of 40); rung 3 top-K 45.0% (18 of 40)
- Luke Skywalker, I Can Save Him / Command vs Aurra Sing, Assassin / Command: tournament 45.8% (11-13, [27.9%, 64.9%]); rung 1 75.0% (30 of 40); rung 3 top-K 65.0% (26 of 40)
- Lando Calrissian, Full Sabacc / Vigilance vs Darth Maul, Sith Revealed / Vigilance: tournament 59.1% (52-36, [48.6%, 68.8%]); rung 1 30.0% (12 of 40); rung 3 top-K 7.5% (3 of 40)
- Lando Calrissian, Full Sabacc / Vigilance vs Aurra Sing, Assassin / Command: tournament 65.6% (21-11, [48.3%, 79.6%]); rung 1 32.5% (13 of 40); rung 3 top-K 30.0% (12 of 40)
- Darth Maul, Sith Revealed / Vigilance vs Aurra Sing, Assassin / Command: tournament 51.3% (19-18, [35.9%, 66.5%]); rung 1 67.5% (27 of 40); rung 3 top-K 80.0% (32 of 40)

## Decision

`simulate_matchup` may not show a win share. No rung has a record that passes all four gates, so the tool answers every simulation request with an error that names the failed gate and its figures (`failedGateSentence`, `src/sims/calibration.ts:310`); it still checks the deck and states the plan, and its job machinery, tested on fixtures and on the engine, serves a rung the moment a record for it passes. The thresholds (Spearman 0.5, sign test p < 0.05) were fixed before either measurement and are unchanged; both rungs miss them by a wide margin, so no threshold between the estimate and the measurements would have changed the verdict. Rung 3 flat Monte Carlo has no calibration record yet. Open: a stronger pilot, several lists per archetype, or both, measured with this same gate.

## Why the gate exists: the spike's example

A random-move win share is dominated by how often each deck's cards get played at all. In the forceteki spike (`docs/research/forceteki-simulation.md:121`) a simple policy reversed one of three tested matchup orders: Krennic against Luke went from 56 to 44 with random bots to 33 to 67 with a greedy bot, and Krennic against Cad Bane moved from 41 to 53 to 22 to 78. A win share that a pilot change can flip says nothing about the deck until the pilot's rankings are checked against real results, and that check is this gate.

## Reproduce

    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung1
    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/ladder.ts --mode ladder --candidate rung3:k=8 --baseline rung0 --pairs 200 --step rung3-vs-rung0
    node --import tsx --import=./scripts/sims/ladder-preload.ts scripts/sims/calibration-gate.ts --policy rung3:k=8

Each record holds no clock field; the same seeds, code, engine and inputs give the same record.
