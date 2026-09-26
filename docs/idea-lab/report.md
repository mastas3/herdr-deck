# Idea lab: finding the recipe for good ideas

The deck's "sparks" and Mixer glued random ingredients together ("What if zdainu and bodygraph-editor were one
product?"): no buyer, no pain, no price, no evidence. This lab replaced that with an engine (`src/ideagen/`) and tested
12 generation strategies against today's output, judged by Jev, a Claude rubric, real demand evidence and a slop gate.

**In one line:** start from *who the user can reach* and *what those people already complain about in public*, give the
writer an owned engine whose capabilities fit and a channel the user controls, force one strict idea schema, gate out
slop, then make every survivor survive a pre-mortem. Today's baselines score 10–15 (raw, 0–100) and all fail the gate;
audience-first and pain-first score 60–70 and pass 60–100% of the time.

- Engine: `src/ideagen/*.ts` (every file under 310 lines). Runner: `scripts/idea-*.ts`. Output: this folder.
- Reproduce: `bun scripts/idea-prep.ts` → `bun scripts/idea-trends.ts` → `bun scripts/idea-experiment.ts
  gen | judge | rejudge | slopjev | calibrate | tournament | premortem | analyze | gallery | kits | archive`.
- Data: `ideas.json` (every idea; briefs as ids), `judgements.json`, `results.json`, `premortem.json`, `tournament.json`,
  `gallery.json` (the output format: 122 cards in 11 lanes), `kits/` (materialized starter kits), `ledger.json` (every
  model call with tokens, cost, latency), `success-patterns.md` (the cited checklist). Inputs (`data/`) are gitignored:
  they hold the user's inventory snapshot.

## The winning recipe

1. **Coherent briefs, not random ingredients.** The sampler builds briefs whose parts fit: a reachable audience (13
   curated from the wiki, each with the accounts/projects that reach it and the capabilities that serve it), a real
   pain cluster from that audience (an anchor post plus up to two related posts, relevance-filtered), an owned engine
   whose *capabilities* match what the audience needs, and a channel the user controls. Candidates are scored
   compatibility × demand × strength and picked with diversity penalties.
2. **Audience-first (C) and pain-first (B)** briefs, plus constraint (G: "$1k in 30 days with ≤3 owned ingredients") and
   trend briefs for the hot lanes. `RECIPE` in `gallery.ts`: C×12, B×10, G×8, T-hot×6, T-early×6, H×6, F×6.
3. **One strict schema with anti-slop rules (prompt v4):** a named buyer and where they are, their pain in their words
   with cited post ids, a priced offer, a first channel with an action count the user controls ("DM 30 coaches…"), the
   owned project that is the moat, an `edge`, no statistics unless they're in the brief, no hype words.
4. **Judging:** Jev p10 ("≥10 paying customers within 60 days") and "ships in 14 days" (4 ideas per call); Jev's slop
   question and the eight success patterns; a Claude rubric (r2: each idea on its own merits, plus "generic"); an
   evidence score from real posts. Quality = 45% rubric + 30% Jev + 25% evidence; the **slop gate** then zeroes
   anything generic (never shown; kept in the archive as dropped).
5. **Pre-mortem:** the best survivors get their three most likely failure reasons, each tied to a success pattern and to
   evidence when there is some (pain posts, trend signals, autoresearch reports, the founder-story library), and a
   rewritten version. The rewrite is judged the same way and replaces the original only if it scores higher. Ideas the
   critic says to abandon leave the gallery.

Why this wins (tables below):
- The **schema alone** (A2: random ingredients + new schema) lifts raw quality from ~14 to ~42, but 92% of those ideas
  fail the gate (no owned project behind them, no evidence). Coherent sampling makes ideas good *and* honest.
- **Audience-first is the most robust**: the highest pass rate across rounds (92–100% in v1/v2) and the best rubric
  "buyer"/"distribution" scores, the two weakest dimensions everywhere. Starting from people the user can actually reach
  fixes exactly those.
- **Pain-first has the highest ceiling and the best evidence** (0.76–0.86) but fails the gate more (it stretches strong
  English-language pains to other markets). The two together, with v4's rules, give gated medians of 60–64 in round 4.
- **The pre-mortem is where ideas get sharp**: 3 of today's top 5 are rewrites (a one-off Telegram card lookup became a
  ₪19/month Hebrew morning practice; a ₪99 couples report became a ₪449 pre-therapy workbook sold through coaches), and
  the critic removed two weak ideas outright (a dev dashboard it judged a tiny market, a tender bot that duplicated a
  better tender idea).

## Rounds

| round | ran | what changed and why |
|---|---|---|
| 1 | 10 arms × 12 ideas: A0 template sparks, A1 today's Mixer, A2 random + new schema (control), B pain, C audience, D asset, E proven-model remix, F gem, G constraint, H boring | Found: the evidence matcher credited "This is the WORST" (now: ≥3 distinctive shared words, no short posts); English App Store reviews were labelled as the Hebrew HD community (relabelled; briefs now show each quote's source); the sampler paired engines by a shared language word (now capability-based `engineFit`). All scores in the tables use the final judge. |
| 2 | B, C, F and W (pain × proven model), prompt v2 (`edge`, sell a result, no duplicates, honest sources) | Rubric scores fell ~5 points; inspection showed rubric r1 docked near-duplicates *inside its batch* — a judge artifact. Added rubric r2 (independent scoring + "generic") and a controlled re-judge in mixed batches (Table B). |
| 3 | B and C with prompt v3 ("a first channel with a number"); T-hot and T-early (new trend input) | v3 backfired: its example "r/humandesign (200k members)" made the model invent member counts. The gate caught it (C-v3 8% pass). |
| 4 | B and C with prompt v4 (action counts the user controls; no stats unless sourced; the owned project must do real work); T-hot/T-early v4 | Pass rate back to 67%, raw quality 64–66, gated medians 60–64. |
| 5 | Pre-mortem of the 16 best distinct survivors, success patterns via Jev | 3 of 16 rewrites won; the critic said to drop 5 more (a dev dashboard, a duplicate tender bot, an English video-reading service, a relocation report, a Pokémon clone), which left the gallery. An autoresearch report on Etsy HD readings appeared during this round; `researchEvidence` feeds such reports to the pre-mortem. |

Table B cells from rounds 1–2 hold only 3 ideas each (a stratified sample for calibration); read them as a check on
Table A, not on their own.

<!-- auto:tables -->
### Table A — as run (rubric r1, rounds 1–2; Q = quality 0–100 after the slop gate)

| round | strategy | prompt | n | median Q | IQR | top-3 Q | median raw Q | slop pass | rubric | Jev p10 | evidence | P(> A1) | Δmedian vs A1 (95% CI) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A0-template | template | 12 | **0.0** | 0.0–0.0 | 0.0 | 10.3 | 0% | 0.08 | 0.130 | 0.00 | 0.50 | 0.0 … 0.0 |
| 1 | B-pain | v1 | 12 | **60.1** | 0.0–73.9 | 74.8 | 70.3 | 58% | 0.50 | 0.415 | 0.79 | 0.79 | 0.0 … 74.0 |
| 1 | A1-mixer | mixer | 12 | **0.0** | 0.0–0.0 | 0.0 | 14.5 | 0% | 0.15 | 0.130 | 0.00 | 0.50 | 0.0 … 0.0 |
| 1 | A2-random-schema | v1 | 12 | **0.0** | 0.0–0.0 | 19.8 | 41.5 | 8% | 0.38 | 0.310 | 0.26 | 0.54 | 0.0 … 0.0 |
| 1 | C-audience | v1 | 12 | **60.2** | 47.3–67.1 | 73.2 | 63.0 | 92% | 0.50 | 0.410 | 0.58 | 0.96 | 44.9 … 67.8 |
| 1 | D-asset | v1 | 12 | **57.8** | 0.0–65.6 | 70.0 | 57.8 | 67% | 0.46 | 0.370 | 0.50 | 0.83 | 0.0 … 65.7 |
| 1 | E-remix | v1 | 12 | **42.9** | 0.0–65.3 | 66.3 | 54.2 | 58% | 0.47 | 0.315 | 0.50 | 0.79 | 0.0 … 65.3 |
| 1 | H-boring | v1 | 10 | **22.4** | 0.0–60.8 | 62.8 | 60.3 | 50% | 0.49 | 0.340 | 0.61 | 0.75 | 0.0 … 61.1 |
| 1 | G-constraint | v1 | 12 | **56.3** | 52.1–66.3 | 78.0 | 56.3 | 100% | 0.49 | 0.410 | 0.59 | 1.00 | 51.9 … 67.9 |
| 1 | F-gem | v1 | 12 | **51.3** | 0.0–67.5 | 68.4 | 65.1 | 67% | 0.46 | 0.350 | 0.77 | 0.83 | 0.0 … 67.5 |
| 2 | W-hybrid | v2 | 12 | **60.1** | 56.9–64.4 | 69.9 | 60.1 | 92% | 0.48 | 0.405 | 0.56 | 0.96 | 56.3 … 65.2 |
| 2 | B-pain | v2 | 12 | **59.4** | 0.0–63.7 | 69.5 | 61.8 | 67% | 0.45 | 0.390 | 0.67 | 0.83 | 0.0 … 64.5 |
| 2 | C-audience | v2 | 12 | **61.8** | 51.2–69.3 | 75.9 | 61.8 | 100% | 0.47 | 0.430 | 0.59 | 1.00 | 50.8 … 70.5 |
| 2 | F-gem | v2 | 12 | **52.9** | 0.0–60.0 | 71.4 | 59.5 | 67% | 0.45 | 0.350 | 0.81 | 0.83 | 0.0 … 62.9 |

| round | strategy | spec | feasible | buyer | distribution | novelty | fun | generic | Claude p10 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A0-template | 1.1 | 1.8 | 1.0 | 1.0 | 1.6 | 1.9 | – | 2% |
| 1 | B-pain | 3.8 | 3.8 | 2.7 | 2.7 | 2.0 | 3.2 | – | 15% |
| 1 | A1-mixer | 1.5 | 2.2 | 1.0 | 1.0 | 2.2 | 2.6 | – | 2% |
| 1 | A2-random-schema | 3.2 | 3.1 | 2.2 | 2.2 | 1.8 | 2.9 | – | 10% |
| 1 | C-audience | 3.7 | 3.7 | 2.8 | 2.7 | 2.2 | 3.1 | – | 16% |
| 1 | D-asset | 3.7 | 3.4 | 2.3 | 2.3 | 2.3 | 3.3 | – | 12% |
| 1 | E-remix | 3.7 | 3.6 | 2.8 | 2.3 | 2.2 | 2.8 | – | 14% |
| 1 | H-boring | 3.9 | 3.1 | 3.3 | 2.7 | 2.1 | 2.3 | – | 16% |
| 1 | G-constraint | 3.9 | 3.7 | 2.7 | 2.4 | 2.2 | 2.8 | – | 15% |
| 1 | F-gem | 3.6 | 3.3 | 2.8 | 2.4 | 1.9 | 2.9 | – | 14% |
| 2 | W-hybrid | 3.7 | 3.8 | 2.7 | 2.2 | 2.5 | 3.1 | – | 12% |
| 2 | B-pain | 3.6 | 4.1 | 2.3 | 2.1 | 2.1 | 2.6 | – | 10% |
| 2 | C-audience | 3.6 | 3.5 | 2.3 | 2.5 | 2.5 | 3.3 | – | 11% |
| 2 | F-gem | 3.5 | 3.3 | 2.5 | 2.3 | 2.3 | 2.9 | – | 12% |

### Table B — controlled re-judge (rubric r2, mixed batches: 3 random ideas from every earlier cell + all of round 3)

| round | strategy | prompt | n | median Q | IQR | top-3 Q | median raw Q | slop pass | rubric | Jev p10 | evidence | P(> A1) | Δmedian vs A1 (95% CI) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A0-template | template | 3 | **0.0** | 0.0–0.0 | 0.0 | 12.5 | 0% | 0.11 | 0.110 | 0.00 | 0.50 | 0.0 … 0.0 |
| 1 | B-pain | v1 | 3 | **68.6** | 65.6–72.7 | 69.3 | 68.6 | 100% | 0.52 | 0.430 | 0.86 | 1.00 | 62.6 … 76.7 |
| 1 | A1-mixer | mixer | 3 | **0.0** | 0.0–0.0 | 0.0 | 14.5 | 0% | 0.14 | 0.130 | 0.00 | 0.50 | 0.0 … 0.0 |
| 1 | A2-random-schema | v1 | 3 | **0.0** | 0.0–0.0 | 0.0 | 43.2 | 0% | 0.40 | 0.300 | 0.19 | 0.50 | 0.0 … 0.0 |
| 1 | C-audience | v1 | 3 | **68.9** | 61.2–71.6 | 65.5 | 68.9 | 100% | 0.59 | 0.410 | 0.53 | 1.00 | 53.4 … 74.2 |
| 1 | D-asset | v1 | 3 | **0.0** | 0.0–33.9 | 22.6 | 51.8 | 33% | 0.36 | 0.350 | 0.67 | 0.67 | 0.0 … 67.8 |
| 1 | E-remix | v1 | 3 | **0.0** | 0.0–0.0 | 0.0 | 35.5 | 0% | 0.32 | 0.300 | 0.27 | 0.50 | 0.0 … 0.0 |
| 1 | H-boring | v1 | 3 | **44.7** | 22.4–52.3 | 34.9 | 59.9 | 67% | 0.50 | 0.290 | 0.53 | 0.83 | 0.0 … 59.9 |
| 1 | G-constraint | v1 | 3 | **53.7** | 26.9–62.8 | 41.8 | 54.6 | 67% | 0.40 | 0.420 | 0.69 | 0.83 | 0.0 … 71.8 |
| 1 | F-gem | v1 | 3 | **0.0** | 0.0–31.9 | 21.3 | 70.8 | 33% | 0.50 | 0.440 | 0.89 | 0.67 | 0.0 … 63.9 |
| 2 | W-hybrid | v2 | 3 | **51.4** | 25.7–59.2 | 39.4 | 51.4 | 67% | 0.43 | 0.320 | 0.40 | 0.83 | 0.0 … 66.9 |
| 2 | B-pain | v2 | 3 | **69.4** | 63.9–73.0 | 68.1 | 69.4 | 100% | 0.50 | 0.420 | 0.78 | 1.00 | 58.4 … 76.6 |
| 2 | C-audience | v2 | 3 | **41.6** | 40.7–50.3 | 46.7 | 41.6 | 100% | 0.41 | 0.390 | 0.27 | 1.00 | 39.7 … 58.9 |
| 2 | F-gem | v2 | 3 | **47.5** | 23.8–58.3 | 38.8 | 67.2 | 67% | 0.50 | 0.380 | 0.74 | 0.83 | 0.0 … 69.0 |
| 3 | T-early | v3 | 10 | **0.0** | 0.0–0.0 | 20.7 | 61.2 | 10% | 0.41 | 0.390 | 0.70 | 0.55 | 0.0 … 0.0 |
| 3 | T-hot | v3 | 10 | **0.0** | 0.0–0.0 | 0.0 | 64.2 | 0% | 0.47 | 0.430 | 0.68 | 0.50 | 0.0 … 0.0 |
| 3 | B-pain | v3 | 12 | **20.8** | 0.0–55.0 | 66.1 | 65.8 | 50% | 0.46 | 0.380 | 0.70 | 0.75 | 0.0 … 58.3 |
| 3 | C-audience | v3 | 12 | **0.0** | 0.0–0.0 | 17.3 | 69.6 | 8% | 0.56 | 0.480 | 0.57 | 0.54 | 0.0 … 0.0 |
| 4 | C-audience | v4 | 12 | **60.4** | 0.0–69.8 | 76.3 | 64.2 | 67% | 0.51 | 0.430 | 0.65 | 0.83 | 0.0 … 70.1 |
| 4 | B-pain | v4 | 12 | **64.0** | 0.0–69.6 | 74.1 | 66.2 | 67% | 0.49 | 0.385 | 0.76 | 0.83 | 0.0 … 70.4 |
| 4 | T-hot | v4 | 6 | **31.9** | 0.0–66.7 | 70.6 | 62.4 | 50% | 0.44 | 0.420 | 0.75 | 0.75 | 0.0 … 74.1 |

| round | strategy | spec | feasible | buyer | distribution | novelty | fun | generic | Claude p10 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A0-template | 1.0 | 2.0 | 1.0 | 1.0 | 2.0 | 2.3 | 4.7 | 2% |
| 1 | B-pain | 4.0 | 3.0 | 2.7 | 2.7 | 3.0 | 3.7 | 2.7 | 13% |
| 1 | A1-mixer | 1.0 | 2.3 | 1.0 | 1.0 | 2.3 | 2.3 | 4.7 | 2% |
| 1 | A2-random-schema | 3.0 | 3.3 | 2.3 | 2.3 | 2.0 | 2.7 | 3.3 | 11% |
| 1 | C-audience | 4.0 | 4.3 | 2.7 | 2.7 | 3.0 | 4.0 | 2.0 | 15% |
| 1 | D-asset | 3.3 | 2.7 | 2.0 | 2.0 | 2.3 | 2.7 | 3.3 | 7% |
| 1 | E-remix | 2.7 | 2.7 | 1.7 | 2.3 | 1.7 | 3.0 | 3.7 | 7% |
| 1 | H-boring | 4.0 | 3.7 | 3.3 | 2.3 | 2.0 | 2.3 | 2.0 | 15% |
| 1 | G-constraint | 3.3 | 3.7 | 2.0 | 2.0 | 2.0 | 3.0 | 3.3 | 8% |
| 1 | F-gem | 3.7 | 3.7 | 3.0 | 2.7 | 2.0 | 2.7 | 2.7 | 14% |
| 2 | W-hybrid | 3.7 | 3.3 | 2.7 | 2.0 | 2.3 | 2.3 | 2.7 | 10% |
| 2 | B-pain | 3.7 | 4.7 | 2.3 | 2.3 | 2.0 | 3.0 | 3.0 | 12% |
| 2 | C-audience | 3.3 | 3.0 | 1.7 | 2.3 | 2.7 | 3.7 | 2.7 | 7% |
| 2 | F-gem | 3.7 | 3.7 | 2.7 | 2.3 | 3.0 | 3.0 | 2.3 | 13% |
| 3 | T-early | 3.2 | 3.1 | 2.2 | 2.4 | 2.1 | 2.9 | 3.4 | 9% |
| 3 | T-hot | 3.5 | 3.4 | 2.4 | 2.4 | 2.6 | 3.4 | 3.0 | 10% |
| 3 | B-pain | 3.6 | 3.5 | 2.4 | 2.4 | 2.4 | 2.9 | 2.8 | 12% |
| 3 | C-audience | 3.9 | 4.1 | 2.8 | 2.8 | 2.7 | 3.3 | 2.4 | 15% |
| 4 | C-audience | 3.8 | 3.8 | 2.6 | 2.4 | 2.7 | 3.3 | 2.7 | 15% |
| 4 | B-pain | 3.8 | 3.8 | 2.4 | 2.3 | 2.4 | 3.2 | 3.1 | 13% |
| 4 | T-hot | 3.7 | 3.3 | 2.2 | 2.3 | 2.3 | 3.2 | 3.3 | 11% |

### Slop gate

Rejected 119 of 256 ideas (46%).

| strategy | ideas | pass | rejected |
|---|---|---|---|
| A0-template | 12 | 0 | 100% |
| B-pain | 51 | 31 | 39% |
| A1-mixer | 12 | 0 | 100% |
| A2-random-schema | 12 | 1 | 92% |
| C-audience | 53 | 37 | 30% |
| D-asset | 13 | 9 | 31% |
| E-remix | 12 | 7 | 42% |
| H-boring | 10 | 5 | 50% |
| G-constraint | 14 | 14 | 0% |
| F-gem | 24 | 16 | 33% |
| W-hybrid | 12 | 11 | 8% |
| T-early | 12 | 2 | 83% |
| T-hot | 19 | 4 | 79% |

Reasons (an idea can have several): unsourced statistic ×49; no linked evidence ×36; no owned project behind it ×30; Jev: a sharp founder would dismiss it as generic ×28; no concrete price ×27; no specific first-customer channel ×27; no named buyer ×25; a clone of existing products with no stated difference ×16; rubric: generic ×14; hype phrase ×8; buyer not tied to a reachable place ×2

### Judge agreement (Spearman ρ)

- As run: rubric vs Jev p10 ρ=**0.71** (n=166); new-schema ideas only ρ=**0.54** (n=142); Claude's own p10 vs Jev p10 (new-schema) ρ=0.51
- Controlled (r2): rubric vs Jev ρ=0.61 (n=116); new-schema only ρ=0.55 (n=110)
- Slop: rubric "generic" vs Jev "would dismiss as generic" ρ=0.55 (n=116)
- Same ideas under rubric r1 vs r2: ρ=0.76, mean shift -0.019 (n=42)
- Evidence vs rubric: ρ=0.49
- Jev batched (4 per call) vs one idea per call: ρ=0.86, mean |Δp|=0.037, mean p 0.291 vs 0.312 (n=16)
- Tournament: 48 Jev pairwise matches; winner had the higher rubric score in 56%; first-listed idea won 35%; Elo vs quality ρ=0.16

### Cost

- Claude: 40 experiment calls + 10 kit calls + 2 pre-mortem calls, $2.594 total, 366684 input / 230580 output tokens
  - gen: 20 calls, $0.957, 117744/145961 tokens, 80 s per call
  - rubric: 11 calls, $0.515, 93456/14121 tokens, 12 s per call
  - rubric2: 9 calls, $0.417, 77392/10766 tokens, 13 s per call
  - kit: 10 calls, $0.499, 53032/28727 tokens, 39 s per call
  - premortem: 2 calls, $0.205, 25060/31005 tokens, 184 s per call
- Jev: 148 calls (jev 61, jev-single 16, generic 40, pairs 8, pm- 12, patterns 11), 465645 input tokens ≈ $0.0196, mean latency 386 ms
- Ideas: 256 (244 from Claude)
<!-- /auto:tables -->
### Reading the agreement numbers

- **Jev agrees with the rubric** at ρ≈0.55–0.61 on new-schema ideas (0.71 including the baselines, which both judges
  reject). That's good enough for Jev to be the everyday judge (≈$0.0001 per idea) with the rubric as a second opinion
  on the daily gallery, not good enough to drop the rubric: they disagree most on dev tools (Jev likes them more).
- **Batching Jev is safe:** four ideas per call vs one per call gives ρ=0.86 and a mean shift of 0.04.
- **Jev's pairwise tournament is not useful for ranking near-equal ideas:** the second-listed idea won 65% (position
  bias) and Elo barely tracks quality (ρ≈0.16). Probabilities per idea are better than pairwise choices here.
- **Two slop detectors agree moderately** (rubric "generic" vs Jev "a founder would dismiss it", ρ≈0.55); the
  deterministic checks catch most rejections on their own (see reasons).

## Cost per 100 ideas

| step | calls per 100 ideas | $ per 100 ideas | time |
|---|---|---|---|
| generation (Haiku, 12 ideas per call) | ~8 | ~$0.39 | ~80 s per call, run 4 in parallel |
| rubric (Sonnet, 15 per call) | ~7 | ~$0.31 | ~13 s per call |
| Jev p10 + ship (4 per call), slop (6), patterns (3) | ~75 | ~$0.01 (≈3.1k input tokens per call) | ~0.4 s per call |
| pre-mortem (Haiku, 16 ideas per call; only the best survivors) | ~1 per 16 survivors | ~$0.10 per 16 | ~3 min per call |
| starter kit (Sonnet, on open) | 1 per kit (+1 to judge it) | ~$0.05 per kit | ~40–90 s |

The daily gallery (`RECIPE`: 54 ideas) is about 7 generation + 4 rubric + 1 pre-mortem Claude calls (~$0.55/day) and
~45 Jev calls (well under the deck's 1,000/day cap). The whole lab spent 52 Claude calls ($2.59) and 148 Jev calls
($0.02). The first 4 kit calls were a first iteration: two of those replies were unreadable to the parser (Hebrew
`ע"י` inside a JSON string; a reply cut off mid-string) — both repairs are now in `json.ts` with tests.

## Top 10 (the gallery's "Top picks" after the gate and the pre-mortem)

| # | Q | Jev p10 | idea | buyer · price · first channel | missing |
|---|---|---|---|---|---|
| 1 | 86.5 | 0.54 | **HD Atlas Daily Tip — Hebrew Morning Authority** (rewrite of "HD Atlas Telegram Bot"): every morning a Hebrew message with your type's strategy, today's authority tip and one real decision to test it on | Hebrew HD fans (HumandesignIsrael group, HD WhatsApp groups) · ₪19/month or ₪180/year · the group + WhatsApp groups with a 3-day sample | — |
| 2 | 82.6 | 0.51 | **HD Couples Coaching Workbook** (rewrite of a ₪99 match report): a pre-session clarity report for couples already in therapy/coaching | couples in coaching, reached through HD coaches and therapists · ₪449 per couple · DM 30 coaches/therapists with a 50% referral | analytics |
| 3 | 81.0 | 0.46 | **TenderAI Alert**: 3 matching Israeli government tenders on WhatsApp each morning, built on gov-tender-sniper | construction/services SMEs · ₪149/month · DM 30 owners in business WhatsApp groups, 7 days free | — |
| 4 | 80.1 | 0.52 | **HD Self-Study Guide — 4-week Hebrew workbook** (rewrite of a ₪49 one-off PDF) | Hebrew HD learners · ₪29/month · the HD group + 3 WhatsApp groups, 50% to coaches who refer | analytics |
| 5 | 79.3 | 0.51 | **Podcast Clip Studio Membership** on yt-transcriber: long videos → 9:16 clips, transcripts, searchable archive | podcasters/YouTubers in r/podcasting, r/NewTubers · $29/month (4 credits) or $79 unlimited · before/after posts | analytics |
| 6 | 75.5 | 0.57 | **HD Atlas Zero-Downtime** — a Hebrew HD reference that works offline | Hebrew HD fans who paid for broken apps · ₪249 one-time · the HD group + DMs to admins | analytics |
| 7 | 74.9 | 0.44 | **Story Reel Premium — shorts studio** | podcasters/YouTubers · $15/month (10 shorts) or $3/short · TikTok before/after | analytics |
| 8 | 74.8 | 0.61 | **HDישראל Quick Read** — a 2-minute Hebrew chart breakdown | the HD group, WhatsApp communities · ₪50 per reading · a WhatsApp link with examples in the group | — |
| 9 | 74.2 | 0.52 | **HD Birth Chart Bot** — exact chart, profile and strategy from a Telegram bot | English HD enthusiasts · $5/month · X + a reliability comparison | — |
| 10 | 74.0 | 0.43 | **Agent Deck — Session Orchestrator** on herdr-deck | developers running many Claude Code sessions · $9/month · Show HN + r/ClaudeAI | analytics |

Honest read: these are specific, priced, reachable, and built on things the user really owns (hd-atlas, bodygraph-3d,
gov-tender-sniper, yt-transcriber, herdr-deck); several quote real posts. They cluster around Human Design and tenders
because that's where the user's assets and reach are strongest. Jev puts even the best at ~50% for 10 paying customers
in 60 days, and the rubric's "distribution" is still ~2.5/5: the next gains are in distribution, not ideas.

## Hot lanes

"Hot right now" and "Just starting to trend" come from `trends.ts` (HN front page + Show/Launch HN of 14 days, GitHub
repos created in the last 30–60 days by star velocity, Product Hunt's feed, Reddit top-of-week for 10 subreddits, tech
Polymarket markets, autoresearch reports): 386 signals → 29 trends today. Trend ideas had the hardest time with the gate
(79–83% rejected, mostly v3's invented member counts), so today's lanes are thin:

1. **RoomSketch Playtests** (Q 62): photo of your room → playable 3D world, on 3d-game-from-video. Trend: AI-generated
   playable games (heat 7.2, earliness 0.71) — [Jev Plays Pokémon Red](https://jev-pokemon.vercel.app/), [a Pokémon battle demo made with Opus 5.5](https://www.reddit.com/r/ClaudeAI/comments/1wqb1ur/i_made_this_playable_pok%C3%A9mon_battle_demo_using/). Free online, ₪29 offline. Pre-mortem: sell room-to-3D to real-estate agents instead.
2. **Agent Session Archive** (Q 63.7): a searchable archive of every Claude Code/Codex session, $19/month. Trend: agent
   proliferation (heat 2.3) — [r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1wprgxw/claude_opus_evolution_is_getting_out_of_hand/). Starter kit in `kits/agent-session-archive/`.
3. **Podcast Clip Librarian** (Q 67.7, below the lanes' heat threshold): $29 per episode; trend: short-form repurposing
   ([hypit-ai/hypit](https://github.com/hypit-ai/hypit), 16k stars in 59 days).

Nothing currently qualifies for "Just starting to trend" after the gate and the pre-mortem (its two candidates were a
relocation report the critic dropped and a duplicate couples report). The daily recipe asks for 12 trend ideas with v4.

## Slop gate: rejection rate and examples

46% of all 256 ideas were rejected (100% of today's baselines; 30–40% of B/C across all prompt versions; 0% of G).
Three examples:

- **"TenderAI: Lead Alerts"** (C, round 3, raw 79 — would have been #3): *"post in 3 Israeli business Facebook groups
  (100k members)"* — an invented member count (unsourced statistic).
- **"WhatsApp Biz Boost"** (C, round 1, raw 69.7): auto-replies with hours and prices for small businesses — no owned
  project behind it (a thin wrapper anyone could build) and Jev: "a sharp founder would dismiss it" (p=0.62).
- **"Clip Autopilot"** (B, round 3, raw 72.1): hype phrase "all in one" plus "(300k members)".
- (and every baseline, e.g. the Mixer's **"Privacy-First Creator Studio"**: no buyer, no price, no channel, no
  evidence, Jev generic p=0.71.)

## Pre-mortem examples

- **HD Atlas Telegram Bot → HD Atlas Daily Tip.** Fails because (1) lookups assume users know which gate to ask about,
  (2) *no repeated job* after the first lookups (pattern 8), (3) bot payments are awkward for Israeli buyers. Fix: a
  daily practice with a price anchored to the habit. Rewrite won 0.806 → 0.837 (Jev + patterns + evidence).
- **herdr Console** — the critic: tiny paying market, stall detection is solved by existing tools, Show HN doesn't
  convert to paid dev tools; *abandon* (removed).
- **TenderAI Alert** (kept): official alert services already exist and ₪149 is anchored to convenience, not to the
  contract value; the suggested rewrite (a pre-screening evaluator for one trade) scored lower, so the original stays
  with its failure list on the card.

## Missing connectors

Every card lists the capabilities it needs and what covers each (the user's services, accounts, MCP servers, projects).
This user owns almost everything, so the common gap is **analytics** (PostHog/Plausible from the deck's catalog, plus
`PostHog/posthog-js`, checked with gh). Libraries are suggested when no owned project in the stack does the job:
canonical repos checked with one gh call each (`grammyjs/grammY`, `remotion-dev/remotion`, `puppeteer/puppeteer`,
`apify/crawlee`, `SYSTRAN/faster-whisper`, `aloistr/swisseph`, …) or a gh search whose results must mention the words
searched. Business partners (a certified HD analyst, a bid-writing consultant, a podcast studio…), prompt packs and
codex-image graphics prompts are suggested per capability.

## Starter kits

`buildStarterKit(ideaId)` runs when a card is opened (cached per idea): spec, architecture, build plan with paste-ready
agent prompts, connectors (repos checked, services, key *names* and where the user already has them, MCP/skills),
scaffold plan, landing copy, pricing, launch posts, outreach (for the user to send), graphics prompts, quests and a
readiness meter. `materializeKit` writes it as a folder only after Play/Begin is confirmed.

Materialized here: `kits/hd-atlas-daily-tip-hebrew-morning-author/` (the pivoted #1), `kits/agent-session-archive/`
(hot lane), and `kits/hd-atlas-telegram-bot/` (the first iteration, kept for comparison). A strict Claude judge
("could an agent start without asking anything?") gave each **2/5**, readiness meter 0.33–0.5. What it still asks is
mostly the user's to answer — WhatsApp sender approval, payment setup, who handles support — plus two things the engine
now fixes for the next kits: it lists each owned project's exported functions and files (so "does bodygraph-3d expose a
chart function?" is answered in the prompt), it states the host's constraints (Netlify Functions are stateless), it
picks one key per capability (Gumroad, not Gumroad and Stripe), and any placeholder the model slips in
(`972500000000`, `<value>`) becomes a readiness to-do.

## The gallery API (`src/ideagen/`)

```ts
// gallery.ts
generateGallery(deps: GalleryDeps, o?: { force?: boolean }): Promise<Gallery>   // today's gallery, cached per day
moreInLane(laneId: string, deps: GalleryDeps, n = 6): Promise<Gallery>            // "more in this lane"
cachedGallery(cacheDir: string, day: string): Gallery | undefined
buildGallery(judged, inv, o): Promise<Gallery>                                     // cards + lanes from judged ideas
type GalleryDeps = { cacheDir; inv: Inventory; corpus: PainCorpus; trends?: TrendSet; claude: ClaudeRunner; jev: JevRunner;
  findRepos?; archive?: IdeaArchive; library?: LibrarySearch; premortems?: number; rubric?: boolean; recipe? }
// kit.ts / kit-files.ts
buildStarterKit(ideaId, { inv, claude, gh, cacheDir, card }): Promise<StarterKit>  // lazy, cached per idea
refreshKit(kit, card, inv): StarterKit                                              // inventory-derived parts, no model call
judgeKit(kit, claude)                                                               // "can an agent start from this?"
materializeKit(kit, name, dir, { overwrite? }): string[]                            // only after Play/Begin
// routes.ts (not wired yet): POST /api/ideas {force?}, /api/ideas/more {lane, n?}, /api/ideas/kit {id, judge?},
// /api/ideas/play {id, confirm: true}
```

Types (`types.ts`): `Gallery { day, at, version, lanes: Lane[], ideas: Record<id, IdeaCard>, stats }`,
`Lane { id, title, subtitle, ideas: id[], more }`, `IdeaCard { name, hook, buyer, pain, evidence[{url,snippet,source}],
offer, price, channel, mvp, stack[{name, role, owned}], connectors: CapNeed[], missing: CapNeed[],
timeToFirstDollarDays, difficulty, quality, jevP10, rubric, evidenceScore, patterns, strategy, topics,
play { quests[{title, verify}] }, trend?, premortem?, ownedRatio }`. Lane ids: top, hot, early, fastest, asking, owned,
hd, weekend, trending-tech, boring, moonshots, jev.

Every idea the gallery generates goes to the deck's idea archive (`openIdeaArchive(...).put/score`, gated ones as
dropped); the lab's 256 are in `~/.config/herdr-deck/ideas.db` with source `idea-lab`. `libraryEvidence(q)` returns []
until the founder-story library exists, then feeds the pre-mortem; `researchEvidence(q)` already reads autoresearch reports.

## Limitations

- The pain corpus is small (≈300 posts; Reddit's keyless limit skipped several searches) and English; evidence is
  topical, not geographic (Indian tender posts backed Israeli tender ideas).
- Quality is a model judgment. Jev's p10 is calibrated in general, not on this user's launches; record outcomes
  (quests) against ideas to calibrate it.
- Kept rewrites have no rubric score of their own in this lab (the budget ran out); they carry their original's quality
  plus the pre-mortem's measured gain. In the live gallery they get the full judging.
