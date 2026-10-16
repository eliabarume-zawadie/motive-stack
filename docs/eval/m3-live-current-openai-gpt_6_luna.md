# Campaign quality evaluation: m3-live-current-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt current | repair 0 | synthetic data | 2026-10-16 | generated 2026-10-16T10:37:20.338Z

**1 of 3 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 1/3. Hard failures: 0. Mean overall: 33%.

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | **0%** | **0%** | **0%** | **0%** | **0%** | **0%** | **0%** | 0% | fail |
| hvac-no-approved-pricing | **0%** | **0%** | **0%** | **0%** | **0%** | **0%** | **0%** | 0% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| **mean** | **33%** | **33%** | **33%** | **33%** | **33%** | **33%** | **33%** | 33% | 1/3 |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| roofing-tight-budget | openai/gpt-6-luna | 4959 ms | 1751/457 | 1 | 404 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators

_Plumber with several approved differentiators_

- **No brief obtained:** invalid_output: Model output failed validation: OpenAI output was cut off (max_output_tokens)

### hvac-no-approved-pricing

_HVAC special with no approved price_

- **No brief obtained:** invalid_output: Model output failed validation: OpenAI output was cut off (max_output_tokens)

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.
