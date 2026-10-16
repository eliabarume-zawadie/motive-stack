# Campaign quality evaluation: after-2026-10-16-recorded-real-sample

Source: recorded real output openai/gpt-6-luna 2026-10-16 | generated 2026-10-16T10:24:39.283Z

**0 of 1 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 1/1. Hard failures: 0. Mean overall: 67%.

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| recorded-openai-sunrise | 100% | 100% | **0%** | **33%** | **60%** | 100% | 75% | 67% | fail |
| **mean** | 100% | 100% | **0%** | **33%** | **60%** | 100% | 75% | 67% | 0/1 |

## Diagnostics: what failed and why

### recorded-openai-sunrise

_Recorded real output: gpt-6-luna, Sunrise Plumbing (2026-10-16)_

Below the pass line: Differentiator use (0%), Budget policy (33%), Targeting rationale (60%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "24/7 availability": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Licensed and insured": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Differentiator use] `used_in_copy`: 1 of 2 approved differentiators appear in the copy (needed 2)
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Creative usefulness] `variations_explained`: no strategic differences are explained

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.
