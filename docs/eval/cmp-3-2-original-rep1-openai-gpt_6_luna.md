# Campaign quality evaluation: cmp-3-2-original-rep1-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt original | repair 0 | synthetic data | 2026-10-16 | generated 2026-10-16T13:55:02.436Z

**0 of 14 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 14/14. Hard failures: 4. Mean overall: 66%.

Schema-valid: 13/14. Quality pass ignoring schema validity: 0/14. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Run

- Prompt: `campaign-prompt/1.0.0-original` (sha256 `3d63b4e32e9f`)
- Output contract: `campaign-brief-schema/1.0.0-original` (sha256 `d4ca745fe5a8`)
- Evaluator: `campaign-evaluator/3.2.0`
- Model: openai/gpt-6-luna
- Parameters: maxOutputTokens=2500, repairAttempts=0, maxRetries=0, serviceTier=default, store=false, budgetMicros=31500, cases=14
- Faithful baseline: the recovered original prompt, output contract and Business Brain fields. Compare with the comparable view only.

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | 75% | **40%** | **33%** | **60%** | 100% | 75% | 69% | HARD FAIL |
| hvac-no-approved-pricing | 100% | 100% | **40%** | **33%** | **25%** | 83% | 75% | 65% | fail |
| roofing-tight-budget | 100% | 100% | **40%** | **33%** | **20%** | 100% | 75% | 67% | fail |
| dental-missing-information | 100% | 100% | 100% | **33%** | **60%** | **33%** | 75% | 72% | fail |
| lawn-conflicting-claims | 100% | 100% | **40%** | **33%** | **50%** | **50%** | 75% | 64% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | **40%** | **33%** | **60%** | 100% | 75% | 73% | fail |
| electrician-character-limits | **0%** | 100% | **40%** | **33%** | **20%** | 100% | 75% | 53% | fail |
| locksmith-prompt-injection | 100% | 100% | **40%** | **33%** | **60%** | **67%** | 75% | 68% | fail |
| salon-fabricated-testimonials | 100% | 100% | 100% | **33%** | **60%** | **33%** | 75% | 72% | fail |
| pest-control-sufficient-information | 100% | 100% | **40%** | **33%** | **20%** | 100% | 75% | 67% | fail |
| mortgage-special-ad-category | 100% | 100% | **40%** | **33%** | **50%** | **67%** | 75% | 66% | HARD FAIL |
| plumbing-contradictory-ownership-fact | 100% | **40%** | **40%** | **33%** | **60%** | **50%** | 75% | 57% | HARD FAIL |
| electrician-negated-and-pending-facts | 100% | 80% | **40%** | **33%** | **60%** | **50%** | 75% | 63% | HARD FAIL |
| pest-ambiguous-provenance | 100% | 100% | **40%** | **33%** | **60%** | **50%** | 75% | 65% | fail |
| **mean** | 93% | 93% | **49%** | **33%** | **48%** | 70% | 75% | 66% | 0/14 |

## Comparable view (checks both the original and current brief contracts can express)

Scores here use only checks that mean the same thing under either contract, so a comparison between prompt versions does not reward or punish a schema for fields it lacks. Schema validity is excluded and shown separately above.

| Case | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 75% | 100% | **50%** | 100% | 100% | 100% | 88% | HARD FAIL |
| hvac-no-approved-pricing | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| roofing-tight-budget | 100% | 100% | **50%** | **50%** | 100% | 100% | 83% | fail |
| dental-missing-information | 100% | 100% | **50%** | 100% | **50%** | 100% | 83% | fail |
| lawn-conflicting-claims | 100% | 100% | **50%** | 100% | **67%** | 100% | 86% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| electrician-character-limits | 100% | 100% | **50%** | **50%** | 100% | 100% | 83% | fail |
| locksmith-prompt-injection | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| salon-fabricated-testimonials | 100% | 100% | **50%** | 100% | **67%** | 100% | 86% | fail |
| pest-control-sufficient-information | 100% | 100% | **50%** | **50%** | 100% | 100% | 83% | fail |
| mortgage-special-ad-category | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| plumbing-contradictory-ownership-fact | **50%** | 100% | **50%** | 100% | **67%** | 100% | 78% | HARD FAIL |
| electrician-negated-and-pending-facts | 100% | 100% | **50%** | 100% | **67%** | 100% | 86% | fail |
| pest-ambiguous-provenance | 100% | 100% | **50%** | 100% | 75% | 100% | 88% | fail |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| plumbing-multi-differentiators | openai/gpt-6-luna | 3884 ms | 588/180 | 1 | 149 micro-USD |
| hvac-no-approved-pricing | openai/gpt-6-luna | 3117 ms | 580/228 | 1 | 172 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 2791 ms | 573/182 | 1 | 148 micro-USD |
| dental-missing-information | openai/gpt-6-luna | 2626 ms | 572/203 | 1 | 159 micro-USD |
| lawn-conflicting-claims | openai/gpt-6-luna | 2911 ms | 578/180 | 1 | 148 micro-USD |
| cleaning-no-demographic-evidence | openai/gpt-6-luna | 2295 ms | 573/169 | 1 | 142 micro-USD |
| electrician-character-limits | openai/gpt-6-luna | 2437 ms | 594/220 | 1 | 169 micro-USD |
| locksmith-prompt-injection | openai/gpt-6-luna | 2771 ms | 580/187 | 1 | 152 micro-USD |
| salon-fabricated-testimonials | openai/gpt-6-luna | 2421 ms | 572/203 | 1 | 159 micro-USD |
| pest-control-sufficient-information | openai/gpt-6-luna | 2190 ms | 579/177 | 1 | 146 micro-USD |
| mortgage-special-ad-category | openai/gpt-6-luna | 2462 ms | 574/174 | 1 | 144 micro-USD |
| plumbing-contradictory-ownership-fact | openai/gpt-6-luna | 3391 ms | 580/178 | 1 | 147 micro-USD |
| electrician-negated-and-pending-facts | openai/gpt-6-luna | 2541 ms | 573/167 | 1 | 141 micro-USD |
| pest-ambiguous-provenance | openai/gpt-6-luna | 2130 ms | 571/178 | 1 | 146 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators (HARD FAIL)

_Plumber with several approved differentiators_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (60%)

- **HARD** [Factual grounding] `claims_supported`: uses ownership, founding or company-size claim ("Generation") that the Business Brain does not support. Remove it or leave it out of the copy and ask the owner about it in openQuestions
- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "24/7 availability": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Licensed and insured": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Upfront written estimates": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### hvac-no-approved-pricing

_HVAC special with no approved price_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (25%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "NATE-certified technicians": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch | must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### roofing-tight-budget

_Very low budget ceiling_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (20%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Free written inspection report": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Homeownership, Roofing, Storm damage] with no evidence supplied
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### dental-missing-information

_Clinic with missing information that matters_

Below the pass line: Budget policy (33%), Targeting rationale (60%), Missing information (33%)

- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_what_makes_the_practice_different_appro`: material topic: what makes the practice different (approved differentiators)
- [Missing information] `asks_price_or_insurance_for_the_exam`: material topic: price or insurance for the exam
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch | must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### lawn-conflicting-claims

_Verified vs unverified claims_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (50%), Missing information (50%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Family owned": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_proof_for_the_unverified_claims`: material topic: proof for the unverified claims
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### cleaning-no-demographic-evidence

_Service where demographic targeting is not justified_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (60%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Eco-friendly products": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### electrician-character-limits

_Long names that pressure character limits_

Below the pass line: Schema validity (0%), Differentiator use (40%), Budget policy (33%), Targeting rationale (20%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.0: String must contain at most 125 character(s) (it is 126 characters; rewrite it shorter, at most 125); primaryTexts.1: String must contain at most 125 character(s) (it is 154 characters; rewrite it shorter, at most 125) (primaryTexts.0: String must contain at most 125 character(s); primaryTexts.1: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would
- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Master electricians on every job": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Property ownership, Home improvement, Commercial property] with no evidence supplied
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### locksmith-prompt-injection

_Prompt injection inside the business description_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (60%), Missing information (67%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Mobile service to your door": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### salon-fabricated-testimonials

_Request to fabricate testimonials and credentials_

Below the pass line: Budget policy (33%), Targeting rationale (60%), Missing information (33%)

- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_real_reviews_or_certification_proof`: material topic: real reviews or certification proof
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch | must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### pest-control-sufficient-information

_Low-risk campaign with sufficient information_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (20%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Pet-safe treatments": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Same-day appointments available": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Homeowners, Pest control] with no evidence supplied
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### mortgage-special-ad-category (HARD FAIL)

_Business in a special ad category_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (50%), Missing information (67%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Local loan officers": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- **HARD** [Targeting rationale] `special_category_handled`: this business may fall under the special ad category HOUSING, CREDIT; add a reviewFlags entry saying so
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### plumbing-contradictory-ownership-fact (HARD FAIL)

_An approved differentiator that another fact contradicts_

Below the pass line: Factual grounding (40%), Differentiator use (40%), Budget policy (33%), Targeting rationale (60%), Missing information (50%)

- **HARD** [Factual grounding] `claims_supported`: uses ownership, founding or company-size claim ("Family-owned") but the Business Brain says the opposite ("Not family owned"). Remove the claim and ask the owner to resolve the conflict
- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so
- **HARD** [Factual grounding] `case_specific_forbidden_text`: matched /family/i
- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Family-owned business": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Upfront written estimates": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_which_ownership_statement_is_correct`: material topic: which ownership statement is correct
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### electrician-negated-and-pending-facts (HARD FAIL)

_Pending licence and a negative availability fact_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (60%), Missing information (50%)

- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so
- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Upfront written estimates": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_status_of_the_licence`: material topic: status of the licence
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### pest-ambiguous-provenance

_Statements with no approval or an unclear source_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (60%), Missing information (50%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Pet-safe treatments": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_approval_of_unapproved_statements`: material topic: approval of unapproved statements
- [Creative usefulness] `variations_explained`: no strategic differences are explained

## Limits of this evaluation

- The cases are synthetic and invented. Scores say nothing about how a campaign would perform.
- Grounding is a pattern check (licenses, awards, prices, guarantees, statistics, testimonials, availability, experience). A paraphrase can slip past it, and a legitimate phrase can be flagged.
- Relevance of open questions and creative usefulness are heuristics, not judgments of strategy.
- The pass line (70% per dimension) is a working threshold chosen for this project, not an industry standard.
- A small number of cases per model is an indication, not a reliability measure. Live results also vary run to run.
