# Campaign quality evaluation: m3-live-legacy-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt legacy | repair 0 | synthetic data | 2026-10-16 | generated 2026-10-16T10:36:46.551Z

**1 of 3 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 2/3. Hard failures: 0. Mean overall: 65%.

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | **0%** | **0%** | **0%** | **0%** | **0%** | **0%** | **0%** | 0% | fail |
| hvac-no-approved-pricing | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| **mean** | **67%** | **67%** | **53%** | **67%** | **67%** | **67%** | **67%** | 65% | 1/3 |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| hvac-no-approved-pricing | openai/gpt-6-luna | 7570 ms | 1103/713 | 1 | 467 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 7794 ms | 1096/765 | 1 | 492 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators

_Plumber with several approved differentiators_

- **No brief obtained:** invalid_output: Model output failed validation: primaryTexts.3: String must contain at most 125 character(s) (it is 138 characters; rewrite it shorter, at most 125)

### hvac-no-approved-pricing

_HVAC special with no approved price_

Below the pass line: Differentiator use (60%)

- [Differentiator use] `used_in_copy`: 0 of 1 approved differentiators appear in the copy (needed 1)

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.
