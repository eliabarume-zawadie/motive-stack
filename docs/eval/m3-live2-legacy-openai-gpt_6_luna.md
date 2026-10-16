# Campaign quality evaluation: m3-live2-legacy-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt legacy | repair 0 | synthetic data | 2026-10-16 | generated 2026-10-16T10:51:11.209Z

**1 of 3 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 3/3. Hard failures: 1. Mean overall: 94%.

Schema-valid: 3/3. Quality pass ignoring schema validity: 1/3. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | 75% | **40%** | 100% | 100% | 100% | 100% | 88% | HARD FAIL |
| hvac-no-approved-pricing | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| **mean** | 100% | 92% | **67%** | 100% | 100% | 100% | 100% | 94% | 1/3 |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| plumbing-multi-differentiators | openai/gpt-6-luna | 9024 ms | 1124/988 | 1 | 606 micro-USD |
| hvac-no-approved-pricing | openai/gpt-6-luna | 7001 ms | 1103/631 | 1 | 426 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 6994 ms | 1096/732 | 1 | 476 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators (HARD FAIL)

_Plumber with several approved differentiators_

Below the pass line: Differentiator use (40%)

- **HARD** [Factual grounding] `claims_supported`: uses years or history in business ("Family-owned") that the Business Brain does not support. Remove it or leave it out of the copy and ask the owner about it in openQuestions
- [Differentiator use] `decisions_consistent_with_copy`: says "24/7 availability" is used, but it does not appear in the headlines or primary texts
- [Differentiator use] `used_in_copy`: 0 of 3 approved differentiators appear in the copy (needed 2)

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
