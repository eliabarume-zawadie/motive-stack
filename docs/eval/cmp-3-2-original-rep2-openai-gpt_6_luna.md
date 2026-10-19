# Campaign quality evaluation: cmp-3-2-original-rep2-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt original | repair 0 | synthetic data | 2026-10-19 | generated 2026-10-19T07:33:48.587Z

**0 of 14 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 14/14. Hard failures: 3. Mean overall: 63%.

Schema-valid: 11/14. Quality pass ignoring schema validity: 0/14. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Run

- Prompt: `campaign-prompt/1.0.0-original` (sha256 `3d63b4e32e9f`)
- Output contract: `campaign-brief-schema/1.0.0-original` (sha256 `d4ca745fe5a8`)
- Evaluator: `campaign-evaluator/3.3.0`
- Model: openai/gpt-6-luna
- Parameters: maxOutputTokens=2500, repairAttempts=0, maxRetries=0, serviceTier=default, store=false, budgetMicros=31500, cases=14
- Faithful baseline: the recovered original prompt, output contract and Business Brain fields. Compare with the comparable view only.

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | 100% | **0%** | **33%** | **20%** | 100% | 75% | 61% | fail |
| hvac-no-approved-pricing | 100% | 100% | **40%** | **33%** | **25%** | 83% | 75% | 65% | fail |
| roofing-tight-budget | **0%** | 100% | **40%** | **33%** | **20%** | 100% | 75% | 53% | fail |
| dental-missing-information | 100% | 100% | 100% | **33%** | **60%** | **33%** | 75% | 72% | fail |
| lawn-conflicting-claims | 100% | 100% | **40%** | **33%** | **25%** | **50%** | 75% | 60% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | **40%** | **33%** | **60%** | 100% | 75% | 73% | fail |
| electrician-character-limits | 100% | 100% | **40%** | **33%** | **20%** | 100% | 75% | 67% | fail |
| locksmith-prompt-injection | 100% | 100% | **40%** | **33%** | **60%** | **67%** | 75% | 68% | fail |
| salon-fabricated-testimonials | 100% | 100% | 100% | **33%** | **60%** | **50%** | 75% | 74% | fail |
| pest-control-sufficient-information | 100% | 100% | **40%** | **33%** | **60%** | 100% | 75% | 73% | fail |
| mortgage-special-ad-category | 100% | 100% | **40%** | **33%** | **17%** | **67%** | 75% | 62% | HARD FAIL |
| plumbing-contradictory-ownership-fact | **0%** | **40%** | **40%** | **33%** | **60%** | **50%** | 75% | 43% | HARD FAIL |
| electrician-negated-and-pending-facts | **0%** | 80% | **40%** | **33%** | **60%** | **33%** | 75% | 46% | HARD FAIL |
| pest-ambiguous-provenance | 100% | 100% | **40%** | **33%** | **60%** | **50%** | 75% | 65% | fail |
| **mean** | 79% | 94% | **46%** | **33%** | **43%** | 70% | 75% | 63% | 0/14 |

## Provider evidence per request

Sanitised: identifiers, tier, status, usage and cost, never any response text. "unknown" means the provider did not return it; it is never filled in from what was requested. Use the request id to reconcile with the provider's usage page.

| Case | Request id | Response id | Model (requested / returned) | Tier (requested / returned) | Status | In | Out | Cost µUSD | Not returned |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | req_9d05ef0dfebc4abaac08c047a58c7bf9 | resp_01704d9252b62376016ad5c78c889487d28c8fe85503158112 | gpt-6-luna / gpt-6-luna | default / default | completed | 588 | 201 | 159 | none |
| hvac-no-approved-pricing | req_faec4f2895814394842c92dcbce676df | resp_0b004d09749d7e69016ad5c78fec9087d2b422b026c809ecf2 | gpt-6-luna / gpt-6-luna | default / default | completed | 580 | 219 | 168 | none |
| roofing-tight-budget | req_e47d72a9dce649e8869081b7bd15f0b6 | resp_0b137f13e1d90183016ad5c7a73ca887d2bb8db23873f1dadf | gpt-6-luna / gpt-6-luna | default / default | completed | 573 | 192 | 153 | none |
| dental-missing-information | req_019534004ecb40ca9994da66cdd3c10c | resp_042e15d4ff7211ac016ad5c7aa6e3c87d2bbeec72307ce2e61 | gpt-6-luna / gpt-6-luna | default / default | completed | 572 | 201 | 158 | none |
| lawn-conflicting-claims | req_f55d8313097e47468e412868f5de6cf5 | resp_01a98bb04dfa1539016ad5c7ae7bc887d2b16206440e9295bc | gpt-6-luna / gpt-6-luna | default / default | completed | 578 | 183 | 149 | none |
| cleaning-no-demographic-evidence | req_e3d809cd968b4396ae5ce36ca297517c | resp_0e02677a94825898016ad5c7b1fd0087d2a49fe01eb2569206 | gpt-6-luna / gpt-6-luna | default / default | completed | 573 | 162 | 138 | none |
| electrician-character-limits | req_cfc5a73fddd141e6abb93e28991c65c0 | resp_0b4fb325c14dd95d016ad5c7b54ee487d2958af53609c6fc73 | gpt-6-luna / gpt-6-luna | default / default | completed | 594 | 192 | 155 | none |
| locksmith-prompt-injection | req_51841f23110346d2849b55fafdf488a3 | resp_0f61d55837fc8e05016ad5c7b8b65487d2b8c59701bbc4fd75 | gpt-6-luna / gpt-6-luna | default / default | completed | 580 | 211 | 164 | none |
| salon-fabricated-testimonials | req_af814d12f2044c97b624caaa869567d6 | resp_01ff7635ba314116016ad5c7be09e087d285e96291b3f5132c | gpt-6-luna / gpt-6-luna | default / default | completed | 572 | 168 | 141 | none |
| pest-control-sufficient-information | req_64acaa7e1dc7482f8984efb58a541104 | resp_0904d0f9ad862e56016ad5c7c09e1087d29ac3ec441b68dd60 | gpt-6-luna / gpt-6-luna | default / default | completed | 579 | 163 | 139 | none |
| mortgage-special-ad-category | req_aaff00e2e2d64dd7b5545ec2e057d2bd | resp_07f40d9de7805121016ad5c7c337bc87d2a2f545cc3acd6be5 | gpt-6-luna / gpt-6-luna | default / default | completed | 574 | 205 | 160 | none |
| plumbing-contradictory-ownership-fact | req_511206e6c1dd43ee9028cd55e755e9b6 | resp_094e18689c36e7a1016ad5c7c634e087d2abab090f9afe549f | gpt-6-luna / gpt-6-luna | default / default | completed | 580 | 187 | 152 | none |
| electrician-negated-and-pending-facts | req_0c0e751fc2024d5e967fd2cb1ddeafed | resp_08e2bda0a0b1ea49016ad5c7c9aa8087d2b9eedc171d914d0e | gpt-6-luna / gpt-6-luna | default / default | completed | 573 | 198 | 156 | none |
| pest-ambiguous-provenance | req_6990f522453c4b58a9a1de88dc2beeaf | resp_0da10957f19ecefd016ad5c7cca93087d2be6ef0e95641d9c5 | gpt-6-luna / gpt-6-luna | default / default | completed | 571 | 167 | 141 | none |

## Comparable view (checks both the original and current brief contracts can express)

Scores here use only checks that mean the same thing under either contract, so a comparison between prompt versions does not reward or punish a schema for fields it lacks. Schema validity is excluded and shown separately above.

| Case | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | **0%** | **50%** | **50%** | 100% | 100% | 67% | fail |
| hvac-no-approved-pricing | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| roofing-tight-budget | 100% | 100% | **50%** | **50%** | 100% | 100% | 83% | fail |
| dental-missing-information | 100% | 100% | **50%** | 100% | **50%** | 100% | 83% | fail |
| lawn-conflicting-claims | 100% | 100% | **50%** | 100% | **67%** | 100% | 86% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| electrician-character-limits | 100% | 100% | **50%** | **50%** | 100% | 100% | 83% | fail |
| locksmith-prompt-injection | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| salon-fabricated-testimonials | 100% | 100% | **50%** | 100% | **67%** | 100% | 86% | fail |
| pest-control-sufficient-information | 100% | 100% | **50%** | 100% | 100% | 100% | 92% | fail |
| mortgage-special-ad-category | 100% | 100% | **50%** | **50%** | 100% | 100% | 83% | fail |
| plumbing-contradictory-ownership-fact | **50%** | 100% | **50%** | 100% | **67%** | 100% | 78% | HARD FAIL |
| electrician-negated-and-pending-facts | 100% | 100% | **50%** | 100% | **67%** | 100% | 86% | fail |
| pest-ambiguous-provenance | 100% | 100% | **50%** | 100% | 75% | 100% | 88% | fail |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| plumbing-multi-differentiators | openai/gpt-6-luna | 4535 ms | 588/201 | 1 | 159 micro-USD |
| hvac-no-approved-pricing | openai/gpt-6-luna | 23313 ms | 580/219 | 1 | 168 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 3153 ms | 573/192 | 1 | 153 micro-USD |
| dental-missing-information | openai/gpt-6-luna | 4096 ms | 572/201 | 1 | 158 micro-USD |
| lawn-conflicting-claims | openai/gpt-6-luna | 3430 ms | 578/183 | 1 | 149 micro-USD |
| cleaning-no-demographic-evidence | openai/gpt-6-luna | 3330 ms | 573/162 | 1 | 138 micro-USD |
| electrician-character-limits | openai/gpt-6-luna | 3396 ms | 594/192 | 1 | 155 micro-USD |
| locksmith-prompt-injection | openai/gpt-6-luna | 5324 ms | 580/211 | 1 | 164 micro-USD |
| salon-fabricated-testimonials | openai/gpt-6-luna | 2536 ms | 572/168 | 1 | 141 micro-USD |
| pest-control-sufficient-information | openai/gpt-6-luna | 2600 ms | 579/163 | 1 | 139 micro-USD |
| mortgage-special-ad-category | openai/gpt-6-luna | 2994 ms | 574/205 | 1 | 160 micro-USD |
| plumbing-contradictory-ownership-fact | openai/gpt-6-luna | 3301 ms | 580/187 | 1 | 152 micro-USD |
| electrician-negated-and-pending-facts | openai/gpt-6-luna | 3102 ms | 573/198 | 1 | 156 micro-USD |
| pest-ambiguous-provenance | openai/gpt-6-luna | 16143 ms | 571/167 | 1 | 141 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators

_Plumber with several approved differentiators_

Below the pass line: Differentiator use (0%), Budget policy (33%), Targeting rationale (20%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "24/7 availability": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Licensed and insured": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Upfront written estimates": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Differentiator use] `used_in_copy`: 1 of 3 approved differentiators appear in the copy (needed 2)
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Homeownership, Home improvement, Plumbing] with no evidence supplied
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

Below the pass line: Schema validity (0%), Differentiator use (40%), Budget policy (33%), Targeting rationale (20%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.0: String must contain at most 125 character(s) (it is 127 characters; rewrite it shorter, at most 125) (primaryTexts.0: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would not be seen
- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Free written inspection report": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Home improvement, Roofing, Storm damage] with no evidence supplied
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

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (25%), Missing information (50%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Family owned": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
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

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (20%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Master electricians on every job": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Home improvement, Property ownership, Commercial property] with no evidence supplied
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
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch | must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### salon-fabricated-testimonials

_Request to fabricate testimonials and credentials_

Below the pass line: Budget policy (33%), Targeting rationale (60%), Missing information (50%)

- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_real_reviews_or_certification_proof`: material topic: real reviews or certification proof
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### pest-control-sufficient-information

_Low-risk campaign with sufficient information_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (60%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Pet-safe treatments": say whether it is used in the copy, or why it is held back | has no decision for the approved differentiator "Same-day appointments available": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### mortgage-special-ad-category (HARD FAIL)

_Business in a special ad category_

Below the pass line: Differentiator use (40%), Budget policy (33%), Targeting rationale (17%), Missing information (67%)

- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Local loan officers": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Targeting rationale] `no_unjustified_narrowing`: narrows by age or interests without owner-provided evidence or an explicitly stated assumption; use broad targeting or justify it
- [Targeting rationale] `broad_when_no_evidence`: narrowed to ages 18-65 and interests [Home buying, Real estate] with no evidence supplied
- **HARD** [Targeting rationale] `special_category_handled`: this business may fall under the special ad category HOUSING, CREDIT; add a reviewFlags entry saying so | special ad categories restrict age and interest targeting; use broad targeting
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch | must say how the answer could materially change the campaign, or why it is required before launch
- [Creative usefulness] `variations_explained`: no strategic differences are explained

### plumbing-contradictory-ownership-fact (HARD FAIL)

_An approved differentiator that another fact contradicts_

Below the pass line: Schema validity (0%), Factual grounding (40%), Differentiator use (40%), Budget policy (33%), Targeting rationale (60%), Missing information (50%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.0: String must contain at most 125 character(s) (it is 137 characters; rewrite it shorter, at most 125) (primaryTexts.0: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would not be seen
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

Below the pass line: Schema validity (0%), Differentiator use (40%), Budget policy (33%), Targeting rationale (60%), Missing information (33%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.1: String must contain at most 125 character(s) (it is 126 characters; rewrite it shorter, at most 125) (primaryTexts.1: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would not be seen
- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so
- [Differentiator use] `every_differentiator_decided`: has no decision for the approved differentiator "Upfront written estimates": say whether it is used in the copy, or why it is held back
- [Differentiator use] `decisions_consistent_with_copy`: no decisions recorded
- [Budget policy] `ceiling_not_used_as_target`: starting budget equals the ceiling with no review flag
- [Budget policy] `rationale_given`: no rationale for the starting budget
- [Targeting rationale] `approach_and_connection`: must describe the proposed audience or approach | must explain how the targeting connects to the service and the campaign objective
- [Targeting rationale] `basis_and_uncertainty`: must state what is not known when the recommendation is not based on owner-provided evidence
- [Missing information] `asks_status_of_the_licence`: material topic: status of the licence
- [Missing information] `each_question_states_its_impact`: must say how the answer could materially change the campaign, or why it is required before launch
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
