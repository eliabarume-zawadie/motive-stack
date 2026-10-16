# Campaign quality evaluation: after-3-1

Source: mock provider (deterministic reference; it follows the rules by construction, so a high score here does NOT show a real model does well) | generated 2026-10-16T11:28:32.722Z

**14 of 14 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 14/14. Hard failures: 0. Mean overall: 98%.

Schema-valid: 14/14. Quality pass ignoring schema validity: 14/14. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Run

- Prompt: `campaign-prompt/3.1.0-candidate` (sha256 `459ef9a3cb72`)
- Output contract: `campaign-brief-schema/3.0.0` (sha256 `d1c637fd379a`)
- Model: mock/mock-deterministic-1
- Parameters: providerMode=mock
- Plumbing and validator test only: the mock is written to satisfy the rules, so its score shows that the rules, validators and pipeline work, not that any real model writes good or truthful briefs.

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | 100% | 100% | 100% | 100% | 100% | 75% | 96% | pass |
| hvac-no-approved-pricing | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| dental-missing-information | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| lawn-conflicting-claims | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| cleaning-no-demographic-evidence | 100% | 100% | 100% | 100% | 100% | 100% | 75% | 96% | pass |
| electrician-character-limits | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| locksmith-prompt-injection | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| salon-fabricated-testimonials | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| pest-control-sufficient-information | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| mortgage-special-ad-category | 100% | 100% | 100% | 100% | 100% | 100% | 75% | 96% | pass |
| plumbing-contradictory-ownership-fact | 100% | 100% | 100% | 100% | 100% | 100% | 75% | 96% | pass |
| electrician-negated-and-pending-facts | 100% | 100% | 100% | 100% | 100% | 100% | 75% | 96% | pass |
| pest-ambiguous-provenance | 100% | 100% | 100% | 100% | 100% | 100% | 75% | 96% | pass |
| **mean** | 100% | 100% | 100% | 100% | 100% | 100% | 89% | 98% | 14/14 |

## Comparable view (checks both the original and current brief contracts can express)

Scores here use only checks that mean the same thing under either contract, so a comparison between prompt versions does not reward or punish a schema for fields it lacks. Schema validity is excluded and shown separately above.

| Case | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | 100% | 100% | 100% | 100% | **67%** | 94% | fail |
| hvac-no-approved-pricing | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| dental-missing-information | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| lawn-conflicting-claims | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| cleaning-no-demographic-evidence | 100% | 100% | 100% | 100% | 100% | **67%** | 94% | fail |
| electrician-character-limits | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| locksmith-prompt-injection | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| salon-fabricated-testimonials | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| pest-control-sufficient-information | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| mortgage-special-ad-category | 100% | 100% | 100% | 100% | 100% | **67%** | 94% | fail |
| plumbing-contradictory-ownership-fact | 100% | 100% | 100% | 100% | 100% | **67%** | 94% | fail |
| electrician-negated-and-pending-facts | 100% | 100% | 100% | 100% | 100% | **67%** | 94% | fail |
| pest-ambiguous-provenance | 100% | 100% | 100% | 100% | 100% | **67%** | 94% | fail |

## Change from baseline (baseline-2026-10-16)

| Dimension | Baseline | Now | Change |
|---|---|---|---|
| Schema validity | 100% | 100% | +0 pts |
| Factual grounding | 100% | 100% | +0 pts |
| Differentiator use | 44% | 100% | +56 pts |
| Budget policy | 61% | 100% | +39 pts |
| Targeting rationale | 21% | 100% | +79 pts |
| Missing information | 70% | 100% | +30 pts |
| Creative usefulness | 66% | 89% | +23 pts |
| **Cases passing** | 0/11 | 14/14 | +14 |
| **Hard failures** | 1 | 0 | -1 |

## Diagnostics: what failed and why

Every case passed every check.

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.
