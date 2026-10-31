---
type: research
status: draft
review_by: 2026-12-31
question: LampaGJ/swu-mcp#104 - how to train local models to play Star Wars: Unlimited better than heuristics alone, within D1/D3 and one Mac Studio
as_of: 2026-10-30
related: ["docs/research/sim-bot-policy-ladder.md", "docs/decisions.md"]
---

# Learned play policies for the sim bot

## TL;DR

Card-game precedent says search plus a good state evaluator wins first, and learned networks win later, at large scale. In Legends of Code and Magic (LOCM) search agents won every version 1.2 contest. Neural agents took over only when the rules randomised card sets, and the winner used a recurrent end-to-end policy. The closest hobby-scale comparables are small: a 15k-parameter PPO agent trained in about four minutes on a laptop, and a Yu-Gi-Oh agent that beat random 98% of the time after three minutes but won 3% of games against a model trained on 100 million games.

For swu-mcp the evidence supports the ladder's rung 4 as written: a value network fitted by regression on rung-2 self-play, used inside rung 3's one-ply search. It does not support starting with AlphaZero-style search distillation or end-to-end RL. LLMs are too slow and costly per decision for the game loop: a 2026 Pokemon TCG benchmark spends about 79 tool calls per game, and its weakest LLM is rated below a simple heuristic bot.

Source coverage is thin. Six primary sources were read as evidence. ReBeL, Player of Games, AlphaZero, DeepNash, Forge and Ward and Cowling are `unverified` here; see Gaps.

## Findings

Sub-claims sourced: sub-claim 1: card-game precedent. sub-claim 2: hobby-scale ladder. sub-claim 3: LLMs as players. sub-claim 4: pitfalls.

### Card-game precedent

- The Hearthstone-AI Competition runs on SabberStone (C#). Agents get a partial observation, with the opponent's hand and deck replaced by dummy cards, and 60 s of compute per turn. The organisers planned to publish submissions after evaluation. https://arxiv.org/pdf/1906.04238 [sub-claim 1: card-game precedent]
- Hearthstone entrants were mostly search: Rolling Horizon Evolution, MCTS, pruned BFS or dynamic lookahead, each with a state evaluation. The 2019 best used Information Set MCTS with sparse sampling. The 2018 runner-up coevolved a heuristic evaluator for a greedy one-step lookahead. The survey gives no scripted-bot win rates. https://arxiv.org/pdf/2305.11814 [sub-claim 1: card-game precedent]
- In the 2017 Hearthstone Data Mining Challenge, entrants predicted first-player win probability from states. The training set held 3,250,000 states from random-AI playouts. All top classifiers were neural networks; the winner was an ensemble of convolutional networks. This is direct precedent for a rung-4 value regression. https://arxiv.org/pdf/2305.11814 [sub-claim 1: card-game precedent]
- The survey reports a Hearthstone system that beat a top-10 human of the official Chinese league (cited as arXiv 2303.05197). Method and compute were not read. https://arxiv.org/pdf/2305.11814 [sub-claim 1: card-game precedent]
- LOCM 1.2: search won every contest. Coac (depth-3 minimax, alpha-beta, fixed draft order) scored 94.22% in CEC 2019 against 25.51% and 37.04% for the two organiser baselines. The first neural entrant, ReinforcedGreediness (CEC 2020), used self-play RL networks for drafting only. Its battle play was best-first search with a linear heuristic tuned by Bayesian optimisation. https://arxiv.org/pdf/2305.11814 [sub-claim 1: card-game precedent]
- LOCM 1.5 (COG 2022) randomised the card set every match, so fixed draft orders broke. Four of six entries were neural, two trained with PPO. ByteRL scored 84.41% and NeteaseOPD 75.00%; a random baseline scored 1.29%. ByteRL used one end-to-end policy with optimistic smooth fictitious play and an LSTM; a version 1.2 variant beat all COG 2021 entries by over 20 points. Organisers publish agents and tooling in one repository. https://arxiv.org/pdf/2305.11814 [sub-claim 1: card-game precedent]
- YGO Agent (Yu-Gi-Oh, JAX, public repo) embeds card text with a language model and stores the vectors. Its observation holds 160 card slots of 41 features. A 3-minute run (204,800 steps, about 1,000 steps/s, GTX 1650) won 98.44% against random. It won 3.125% of 128 games against a model trained on over 100M games (author's estimate: 32 RTX 4090s for 5 days). Only a random baseline is reported. Figures come from a WebFetch summary of the README. https://github.com/sbl1996/ygo-agent [sub-claim 1: card-game precedent]
- In ygoenv a 128-match battle took 16.1 s, of which about 13.2 s was model time and 2.8 s environment time. Model inference, not the simulator, set the speed. Summary-derived. https://github.com/sbl1996/ygo-agent [sub-claim 2: hobby-scale ladder]
- Slay the Spire (mini-spire, public): a 45-float observation (a count per card index), 7 masked actions, maskable PPO from Stable-Baselines3, about 15k parameters. One million steps took about 4 minutes on a 2020 M1 laptop. Random won about 52% of fights; the agent reached about 90% within 50k steps. No heuristic baseline. The author notes the vector grows with the card pool. Summary-derived. https://rhp.bearblog.dev/mini-spire/ [sub-claim 1: card-game precedent]
- MTG-Causal-RL is a May 2026 Magic: The Gathering benchmark (authors Cunha, Mian, French, Liu) with an anonymised code link. Only its metadata was readable. https://arxiv.org/pdf/2605.06066 [sub-claim 1: card-game precedent]
- unverified: ByteRL training compute and the LOCM 1.5 paper's state encoding. The fetch of arxiv.org/pdf/2303.04096 exceeded the size limit. [sub-claim 1: card-game precedent]
- unverified: MTG-Causal-RL win rates and PPO compute. The PDF at arxiv.org/pdf/2605.06066 was unreadable. [sub-claim 1: card-game precedent]
- unverified: why hidden information changes the method (public belief states, regret minimisation) per ReBeL, arxiv.org/pdf/2007.13544; its fetch returned unreadable bytes. [sub-claim 1: card-game precedent]
- unverified: Player of Games results and compute. The PDF at arxiv.org/pdf/2112.03178 was unreadable. [sub-claim 1: card-game precedent]
- unverified: AlphaZero self-play game counts and TPU hours. The PDF at arxiv.org/pdf/1712.01815 was unreadable. [sub-claim 1: card-game precedent]

### Hobby-scale ladder: inference

- onnxruntime-node installs with npm and ships prebuilt CPU binaries for macOS x64 and arm64. Its Node support table does not list CoreML, and the page makes no latency claim. Per-call overhead must be measured here. Summary-derived. https://onnxruntime.ai/docs/get-started/with-javascript/node.html [sub-claim 2: hobby-scale ladder]

### LLMs as players

- PTCG-Bench (Pokemon TCG, custom engine, 5 decks, 10 LLM backbones, 20 games per pair, 1,320 games per tournament) rates agents with Glicko-2. LLMs span 1210 (GPT-5.4 Nano) to 1875 (Gemini 3.1 Pro). A random-legal-action bot scores about 1051 and a heuristic bot about 1248, so the weakest LLM is below the heuristic. Claude Sonnet 4.6 is about 1596 and Claude Haiku 4.5 about 1455. Ratings are read off Figure 4. https://arxiv.org/pdf/2605.29653 [sub-claim 3: LLMs as players]
- Cost per game in PTCG-Bench runs from roughly four cents to roughly two dollars (read off a log axis, approximate), and higher cost did not guarantee a higher rating. The full harness averaged 78.8 tool calls per game. A $1.2 game over 79 calls is about $0.015 per decision (my arithmetic). https://arxiv.org/pdf/2605.29653 [sub-claim 3: LLMs as players]
- Harness matters as much as model: removing legal-action masking cost 118 rating points and raised the invalid-action rate from 3.3% to 15.9%. Five self-evolution schemes (Reflexion, ExpeL, memory, prompt and skill evolution) showed no consistent gain over 8 rounds. Code is public per the paper's footnote. https://arxiv.org/pdf/2605.29653 [sub-claim 3: LLMs as players]

### Pitfalls

- Self-play non-stationarity: PTCG-Bench scores self-evolving agents against frozen anchors, because simultaneous policy updates make a round-robin rating scale drift. https://arxiv.org/pdf/2605.29653 [sub-claim 4: pitfalls]
- Held-out decks have precedent: the Hearthstone premade-deck track gave six decks, and only three were known to developers before the final. https://arxiv.org/pdf/1906.04238 [sub-claim 4: pitfalls]
- Fixed content overfits: LOCM's hardcoded draft collapsed the game to one phase, so version 1.5 generated new cards per match. Evaluation used sampled decks, ten plays per deck on the same seed, with mirrored seats. https://arxiv.org/pdf/2305.11814 [sub-claim 4: pitfalls]
- unverified: how exploitable self-play card agents are (arxiv.org/pdf/2404.16689, an attack on ByteRL). The PDF was unreadable. [sub-claim 4: pitfalls]

### Plan for epic #104

Numbers marked (estimate) are arithmetic on the owner's rates (15 to 36 games/s on 16 threads; 3 to 6 ms per rollback) and ladder-doc counts (`docs/research/sim-bot-policy-ladder.md:147`). Gates cite `:320-346` there.

1. Self-play corpus. Run rung-2 games across the six-deck panel, log features, actor and outcome per main-action state, pin under `data/pinned/sim-selfplay-v1/`. Data: 100,000 games (estimate), 0.8 to 1.9 h at the owner's rates. Comparable: a 3.25M-state challenge set. Gate: replay gate on 50 matches, health gate. https://arxiv.org/pdf/2305.11814 [sub-claim 2: hobby-scale ladder]
2. Logistic baseline. Fit the ladder's L2 regression, split by seed range. Data: held-out log-loss, Brier, ECE. Compute: seconds to minutes (estimate). Gate: ECE at most 0.05 and better than the constant win rate. [sub-claim 2: hobby-scale ladder]
3. MLP value net. Add cardKey embeddings initialised from the pinned nomic vectors (D14). Comparable: a 15k-parameter net, 1M steps, 4 minutes on an M1. Compute: minutes on MPS (estimate). Gate: lower held-out log-loss than step 2 on held-out seeds and held-out decks. https://rhp.bearblog.dev/mini-spire/ [sub-claim 2: hobby-scale ladder]
4. Inference path. Export weights as JSON and run the forward pass in TypeScript. At 15 g/s on 16 threads a game gets about 1.07 s of thread time against 0.26 s of engine time, leaving about 0.8 s. At 500 to 1,000 evaluations per game that is 0.8 to 1.6 ms each, or 0.2 to 0.4 ms at 36 g/s (estimate). A small MLP fits easily. Use ONNX only for a transformer, after measuring call overhead. Gate: parity with PyTorch within 1e-5 on 1,000 states; games/s measured. https://onnxruntime.ai/docs/get-started/with-javascript/node.html [sub-claim 2: hobby-scale ladder]
5. Rung 4 = rung 3 search with the learned V. Rung 3 costs 5 trials times 3 to 6 ms times 50 to 100 main decisions per seat, so 1.5 to 6 s per game (estimate); rollback, not inference, dominates. Comparable: LOCM winners were search plus an evaluator. Gate: ladder test against rung 3, 200 seat-swapped seed pairs, α = 0.01. https://arxiv.org/pdf/2305.11814 [sub-claim 2: hobby-scale ladder]
6. Two or three refit rounds from rung-4 games, 20,000 games each, 0.5 to 2 h per round at 16 threads (estimate). Scale warning: the strongest YGO model used about 100M games, so expect modest gains. Gate: each round beats the previous one against frozen anchors; stop at the first that does not. https://github.com/sbl1996/ygo-agent [sub-claim 4: pitfalls]
7. Optional policy head. Train a small net to imitate rung 4's chosen action, used only to pick the top K and cut rollbacks. Data: root choices from step 6. Gate: no loss against rung 4 in the ladder test, with higher games/s. [sub-claim 2: hobby-scale ladder]
8. Held-out evaluation. Fit Bradley-Terry across rungs 0 to 4 on decks absent from steps 1 to 6. Comparable: PTCG-Bench's 20-game pairs. Gate: held-out share within the panel's interval; no deck wholly below 50%. https://arxiv.org/pdf/2605.29653 [sub-claim 4: pitfalls]
9. External calibration. Spearman at least 0.5 against swumetastats matchups (ladder doc `:340-344`). Gate: pass, or the rung serves logs only. [sub-claim 2: hobby-scale ladder]

Practices to skip:

- unverified: Skip 1, AlphaZero-style MCTS distillation for now. Five trials a decision already costs seconds per game; 50 simulations per move would cost tens of seconds (estimate), and no readable comparable gives a games-needed figure. [sub-claim 2: hobby-scale ladder]
- Skip 2: end-to-end PPO from scratch. ByteRL used a recurrent network, YGO Agent's strongest model used 100M games, and a drifting policy breaks the replay and ladder gates. https://arxiv.org/pdf/2305.11814 [sub-claim 4: pitfalls]
- Skip 3: an LLM in the game loop or as a reward. About 79 calls per game, at 1 to 3 s each (ladder doc `:201`), cannot coexist with 15+ games/s, and D1 and D3 forbid it. Keep LLMs offline. https://arxiv.org/pdf/2605.29653 [sub-claim 3: LLMs as players]

## Gaps

- Source budget: the brief asked for 12 to 20 primary sources, but the 12-fetch cap left six readable ones. Three PDFs that WebFetch could not parse were read from saved copies with Read; six others stayed unreadable.
- unverified: Forge AI, XMage/MageZero, Ward and Cowling MTG MCTS, and any Pokemon TCG reinforcement-learning project. Each surfaced only in search snippets and was never fetched.
- unverified: DeepNash, and Hearthstone entrants' measured strength against scripted bots. Neither was fetched; the Hearthstone survey gives no such numbers.
- unverified: any published count of games needed for a first useful AlphaZero-lite model on a card game. No fetched source states one.
- Inference latency per decision (TypeScript MLP, ONNX call overhead) and the 3 to 6 ms rollback are owner figures or estimates, not measured here.
- The ygo-agent, mini-spire and ONNX figures come from WebFetch summaries, not raw page text. Re-check them before relying on a number.

## Confidence

Medium for the plan's shape and the LLM conclusion (PTCG-Bench and the LOCM survey were read as page text). Low for compute estimates (arithmetic on owner rates, few verified comparables) and for hidden-information theory (no readable source).

## Verified vs Unverified

Six sources verified as evidence. Unverified bullets: 10 (7 under Findings, 3 under Gaps... see the count check in the closing report), covering every failed fetch.

## Reproduction

Searches run, in order:

- Hearthstone AI Competition Dockhorn Mostaghim MCTS agents results scripted bots
- Legends of Code and Magic strategy card game AI competition winning approaches beam search neural network evaluator
- ygo-agent Yu-Gi-Oh reinforcement learning agent EDOPro paper
- Magic: The Gathering reinforcement learning agent Forge XMage self-play
- LLM agents playing card games benchmark Hearthstone Magic the Gathering Pokemon TCG evaluation arXiv
- Slay the Spire reinforcement learning agent arXiv

Fetches, in order:

- https://arxiv.org/pdf/1906.04238 : ok (binary; text read from saved copy with Read, 4 pages)
- https://arxiv.org/pdf/2305.11814 : ok (binary; text read from saved copy with Read, 8 pages)
- https://arxiv.org/pdf/2303.04096 : failed (size limit exceeded)
- https://github.com/sbl1996/ygo-agent : ok (WebFetch summary only)
- https://arxiv.org/pdf/2605.06066 : failed (PDF unreadable; metadata only)
- https://arxiv.org/pdf/2605.29653 : ok (binary; text read from saved copy with Read, 9 pages)
- https://arxiv.org/pdf/2007.13544 : failed (PDF unreadable)
- https://arxiv.org/pdf/2112.03178 : failed (PDF unreadable)
- https://arxiv.org/pdf/1712.01815 : failed (PDF unreadable)
- https://rhp.bearblog.dev/mini-spire/ : ok (WebFetch summary only)
- https://onnxruntime.ai/docs/get-started/with-javascript/node.html : ok (WebFetch summary only)
- https://arxiv.org/pdf/2404.16689 : failed (PDF unreadable)

Local reads: the ladder doc and `docs/decisions.md` (grep) for context.
