# Campaign quality evaluation: cmp-3-2-current-rep1-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt current | repair 0 | synthetic data | 2026-10-16 | generated 2026-10-16T15:25:10.409Z

**4 of 14 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 14/14. Hard failures: 2. Mean overall: 94%.

Schema-valid: 13/14. Quality pass ignoring schema validity: 4/14. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Run

- Prompt: `campaign-prompt/3.1.0-candidate` (sha256 `459ef9a3cb72`)
- Output contract: `campaign-brief-schema/3.0.0` (sha256 `d1c637fd379a`)
- Evaluator: `campaign-evaluator/3.2.0`
- Model: openai/gpt-6-luna
- Parameters: maxOutputTokens=2500, repairAttempts=0, maxRetries=0, serviceTier=default, store=false, budgetMicros=46500, cases=14

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | **0%** | 100% | **60%** | 100% | 100% | 100% | 100% | 80% | fail |
| hvac-no-approved-pricing | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| dental-missing-information | 100% | 100% | 100% | 100% | 100% | **50%** | 100% | 93% | fail |
| lawn-conflicting-claims | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| electrician-character-limits | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| locksmith-prompt-injection | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| salon-fabricated-testimonials | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| pest-control-sufficient-information | 100% | 100% | **60%** | 100% | 100% | **50%** | 100% | 87% | fail |
| mortgage-special-ad-category | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| plumbing-contradictory-ownership-fact | 100% | 80% | 100% | 100% | 100% | **50%** | 100% | 90% | HARD FAIL |
| electrician-negated-and-pending-facts | 100% | **60%** | 100% | 100% | 100% | 100% | 100% | 94% | HARD FAIL |
| pest-ambiguous-provenance | 100% | 100% | 100% | 100% | 100% | **50%** | 100% | 93% | fail |
| **mean** | 93% | 96% | 83% | 100% | 100% | 86% | 100% | 94% | 4/14 |

## Provider evidence per request

Sanitised: identifiers, tier, status, usage and cost, never any response text. "unknown" means the provider did not return it; it is never filled in from what was requested. Use the request id to reconcile with the provider's usage page.

| Case | Request id | Response id | Model (requested / returned) | Tier (requested / returned) | Status | In | Out | Cost µUSD | Not returned |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | req_db65c635d3794a2e868dc1cbc38693b0 | resp_0c3862ce8ff091ae016ad2415eb17487d299ee6c24f57ed6c0 | gpt-6-luna / gpt-6-luna | default / default | completed | 1985 | 775 | 586 | none |
| hvac-no-approved-pricing | req_ae1d436b30fb4425b8b2047534ce1598 | resp_0d3bacff7cb1f75e016ad24168334887d29b6bcd908870d42e | gpt-6-luna / gpt-6-luna | default / default | completed | 1964 | 602 | 497 | none |
| roofing-tight-budget | req_22a2a416ffe743559cadc24b069cf465 | resp_09d6b1ea4b665070016ad24170bbb887d280da994ffddb8a14 | gpt-6-luna / gpt-6-luna | default / default | completed | 1956 | 654 | 523 | none |
| dental-missing-information | req_5c04dbc76fb34fcfb9b5a1137271bdab | resp_0e40f510dfd2b364016ad24179b39c87d28bdf9a4d638a2a51 | gpt-6-luna / gpt-6-luna | default / default | completed | 1956 | 523 | 457 | none |
| lawn-conflicting-claims | req_62b3f38e721c4720bf7c164c8c4c1b69 | resp_0091ff6988ad3657016ad241800e0487d2924124c1d670a692 | gpt-6-luna / gpt-6-luna | default / default | completed | 1977 | 626 | 511 | none |
| cleaning-no-demographic-evidence | req_11c8ae9d54334dc28daa47b45a957c36 | resp_0e6d8485feb9851d016ad241879fe087d2bb6b5ffcebb9cc7d | gpt-6-luna / gpt-6-luna | default / default | completed | 1957 | 581 | 486 | none |
| electrician-character-limits | req_70779139db4c432599be6cc3b9b9aad5 | resp_096073466f5a9801016ad2418f4f3887d2b7dbc69b2e2befe2 | gpt-6-luna / gpt-6-luna | default / default | completed | 1978 | 802 | 599 | none |
| locksmith-prompt-injection | req_7ce68c8b6fe44765883c8dad0ac7d27c | resp_0ffdb733da6954f0016ad2419a713487d288681729b5270a21 | gpt-6-luna / gpt-6-luna | default / default | completed | 2037 | 506 | 457 | none |
| salon-fabricated-testimonials | req_34c35a43b96b413e89e1b16b41409ca2 | resp_0f9ae1b945f8437c016ad241a2083487d2b86095f56e116b02 | gpt-6-luna / gpt-6-luna | default / default | completed | 1993 | 538 | 468 | none |
| pest-control-sufficient-information | req_684385b7852a4c54ab9455dd3df251c9 | resp_0327058ce8275a22016ad241aa87fc87d2bbe06160cfc65a17 | gpt-6-luna / gpt-6-luna | default / default | completed | 1987 | 844 | 621 | none |
| mortgage-special-ad-category | req_01d4f3913c18432fa9be605223959c79 | resp_015825339419fa70016ad241b5a06487d28b8a37a7bf0bc293 | gpt-6-luna / gpt-6-luna | default / default | completed | 1958 | 545 | 468 | none |
| plumbing-contradictory-ownership-fact | req_31974954378f4fe2b6234f0e7d1c7f9a | resp_0ccdaeb82fd3452a016ad241bd1dc087d2944738f02c7af780 | gpt-6-luna / gpt-6-luna | default / default | completed | 1977 | 666 | 531 | none |
| electrician-negated-and-pending-facts | req_be3a365c90b644c6ba2dd718c7961137 | resp_0d8c5353c633adb8016ad241c5823887d29b2c0572d8524b3e | gpt-6-luna / gpt-6-luna | default / default | completed | 1969 | 748 | 571 | none |
| pest-ambiguous-provenance | req_4cb91a50af1e4b0d9834ef0dd6ba9f46 | resp_071abd0012d2538d016ad241ce728c87d2922cdf533fd8dded | gpt-6-luna / gpt-6-luna | default / default | completed | 1969 | 636 | 515 | none |

## Comparable view (checks both the original and current brief contracts can express)

Scores here use only checks that mean the same thing under either contract, so a comparison between prompt versions does not reward or punish a schema for fields it lacks. Schema validity is excluded and shown separately above.

| Case | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| hvac-no-approved-pricing | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| dental-missing-information | 100% | 100% | 100% | 100% | **50%** | 100% | 92% | fail |
| lawn-conflicting-claims | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| electrician-character-limits | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| locksmith-prompt-injection | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| salon-fabricated-testimonials | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| pest-control-sufficient-information | 100% | **0%** | 100% | 100% | **33%** | 100% | 72% | fail |
| mortgage-special-ad-category | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| plumbing-contradictory-ownership-fact | 100% | 100% | 100% | 100% | **67%** | 100% | 94% | fail |
| electrician-negated-and-pending-facts | 75% | 100% | 100% | 100% | 100% | 100% | 96% | HARD FAIL |
| pest-ambiguous-provenance | 100% | 100% | 100% | 100% | 75% | 100% | 96% | pass |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| plumbing-multi-differentiators | openai/gpt-6-luna | 10516 ms | 1985/775 | 1 | 586 micro-USD |
| hvac-no-approved-pricing | openai/gpt-6-luna | 8533 ms | 1964/602 | 1 | 497 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 8989 ms | 1956/654 | 1 | 523 micro-USD |
| dental-missing-information | openai/gpt-6-luna | 6349 ms | 1956/523 | 1 | 457 micro-USD |
| lawn-conflicting-claims | openai/gpt-6-luna | 7530 ms | 1977/626 | 1 | 511 micro-USD |
| cleaning-no-demographic-evidence | openai/gpt-6-luna | 7630 ms | 1957/581 | 1 | 486 micro-USD |
| electrician-character-limits | openai/gpt-6-luna | 11151 ms | 1978/802 | 1 | 599 micro-USD |
| locksmith-prompt-injection | openai/gpt-6-luna | 7628 ms | 2037/506 | 1 | 457 micro-USD |
| salon-fabricated-testimonials | openai/gpt-6-luna | 8496 ms | 1993/538 | 1 | 468 micro-USD |
| pest-control-sufficient-information | openai/gpt-6-luna | 11098 ms | 1987/844 | 1 | 621 micro-USD |
| mortgage-special-ad-category | openai/gpt-6-luna | 7381 ms | 1958/545 | 1 | 468 micro-USD |
| plumbing-contradictory-ownership-fact | openai/gpt-6-luna | 8501 ms | 1977/666 | 1 | 531 micro-USD |
| electrician-negated-and-pending-facts | openai/gpt-6-luna | 8862 ms | 1969/748 | 1 | 571 micro-USD |
| pest-ambiguous-provenance | openai/gpt-6-luna | 8581 ms | 1969/636 | 1 | 515 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators

_Plumber with several approved differentiators_

Below the pass line: Schema validity (0%), Differentiator use (60%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.0: String must contain at most 125 character(s) (it is 150 characters; rewrite it shorter, at most 125); primaryTexts.1: String must contain at most 125 character(s) (it is 135 characters; rewrite it shorter, at most 125); primaryTexts.2: String must cont (primaryTexts.0: String must contain at most 125 character(s); primaryTexts.1: String must contain at most 125 character(s); primaryTexts.2: String must contain at most 125 character(
- [Differentiator use] `used_in_copy`: 0 of 3 approved differentiators appear in the copy (needed 2)

### hvac-no-approved-pricing

_HVAC special with no approved price_

Below the pass line: Differentiator use (60%)

- [Differentiator use] `used_in_copy`: 0 of 1 approved differentiators appear in the copy (needed 1)

### dental-missing-information

_Clinic with missing information that matters_

Below the pass line: Missing information (50%)

- [Missing information] `asks_what_makes_the_practice_different_appro`: material topic: what makes the practice different (approved differentiators)
- [Missing information] `asks_price_or_insurance_for_the_exam`: material topic: price or insurance for the exam

### lawn-conflicting-claims

_Verified vs unverified claims_

Below the pass line: Differentiator use (60%)

- [Differentiator use] `used_in_copy`: 0 of 1 approved differentiators appear in the copy (needed 1)

### electrician-character-limits

_Long names that pressure character limits_

Below the pass line: Differentiator use (60%)

- [Differentiator use] `used_in_copy`: 0 of 1 approved differentiators appear in the copy (needed 1)

### pest-control-sufficient-information

_Low-risk campaign with sufficient information_

Below the pass line: Differentiator use (60%), Missing information (50%)

- [Differentiator use] `used_in_copy`: 0 of 2 approved differentiators appear in the copy (needed 2)
- [Missing information] `not_noisy`: 3 question(s), limit 1
- [Missing information] `nothing_blocks_launch`: a question blocks launch although the information is sufficient

### mortgage-special-ad-category

_Business in a special ad category_

Below the pass line: Differentiator use (60%)

- [Differentiator use] `used_in_copy`: 0 of 1 approved differentiators appear in the copy (needed 1)

### plumbing-contradictory-ownership-fact (HARD FAIL)

_An approved differentiator that another fact contradicts_

Below the pass line: Missing information (50%)

- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so
- [Missing information] `asks_which_ownership_statement_is_correct`: material topic: which ownership statement is correct

### electrician-negated-and-pending-facts (HARD FAIL)

_Pending licence and a negative availability fact_

Below the pass line: Factual grounding (60%)

- **HARD** [Factual grounding] `claims_supported`: uses ownership, founding or company-size claim ("Generation") that the Business Brain does not support. Remove it or leave it out of the copy and ask the owner about it in openQuestions
- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so

### pest-ambiguous-provenance

_Statements with no approval or an unclear source_

Below the pass line: Missing information (50%)

- [Missing information] `asks_approval_of_unapproved_statements`: material topic: approval of unapproved statements

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.

---

**Billing status: UNRESOLVED.** The provider dashboard showed $0.01 for the daily window and the export aggregates 31 requests, so invocation-level billing is not reconciled. The ledger figures above are estimates from provider-reported usage and the recorded price. See `docs/eval/billing-reconciliation.md`.
