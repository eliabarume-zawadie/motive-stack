# Campaign quality evaluation: m3-live2-current-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt current | repair 0 | synthetic data | 2026-10-16 | generated 2026-10-16T10:51:35.857Z

**2 of 3 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 3/3. Hard failures: 1. Mean overall: 92%.

Schema-valid: 2/3. Quality pass ignoring schema validity: 2/3. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | **0%** | 75% | **60%** | 100% | 100% | 100% | 100% | 76% | HARD FAIL |
| hvac-no-approved-pricing | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| **mean** | **67%** | 92% | 87% | 100% | 100% | 100% | 100% | 92% | 2/3 |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| plumbing-multi-differentiators | openai/gpt-6-luna | 7960 ms | 1780/819 | 1 | 588 micro-USD |
| hvac-no-approved-pricing | openai/gpt-6-luna | 7162 ms | 1759/753 | 1 | 552 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 5952 ms | 1751/606 | 1 | 478 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators (HARD FAIL)

_Plumber with several approved differentiators_

Below the pass line: Schema validity (0%), Differentiator use (60%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.2: String must contain at most 125 character(s) (it is 128 characters; rewrite it shorter, at most 125) (primaryTexts.2: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would not be seen
- **HARD** [Factual grounding] `claims_supported`: uses years or history in business ("family-owned") that the Business Brain does not support. Remove it or leave it out of the copy and ask the owner about it in openQuestions
- [Differentiator use] `used_in_copy`: 1 of 3 approved differentiators appear in the copy (needed 2)

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.
