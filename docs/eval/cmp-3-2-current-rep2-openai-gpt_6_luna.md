# Campaign quality evaluation: cmp-3-2-current-rep2-openai-gpt_6_luna

Source: LIVE openai/gpt-6-luna | prompt current | repair 0 | synthetic data | 2026-10-19 | generated 2026-10-19T07:59:47.584Z

**5 of 14 cases pass** (no hard failure and every dimension at or above 70%). Briefs obtained: 14/14. Hard failures: 2. Mean overall: 93%.

Schema-valid: 12/14. Quality pass ignoring schema validity: 5/14. Not scored (nothing to score): 0 (0 cut off at the token limit).

Bold scores are below the pass line. **Schema validity is reported separately and says nothing about marketing quality.**

## Run

- Prompt: `campaign-prompt/3.1.0-candidate` (sha256 `459ef9a3cb72`)
- Output contract: `campaign-brief-schema/3.0.0` (sha256 `d1c637fd379a`)
- Evaluator: `campaign-evaluator/3.3.0`
- Model: openai/gpt-6-luna
- Parameters: maxOutputTokens=2500, repairAttempts=0, maxRetries=0, serviceTier=default, store=false, budgetMicros=46500, cases=14

## Scores by case

| Case | Schema validity | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | **0%** | 100% | **60%** | 100% | 100% | 75% | 100% | 76% | fail |
| hvac-no-approved-pricing | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| dental-missing-information | 100% | 100% | 100% | 100% | 100% | **50%** | 100% | 93% | fail |
| lawn-conflicting-claims | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| electrician-character-limits | **0%** | 100% | **60%** | 100% | 100% | 100% | 100% | 80% | fail |
| locksmith-prompt-injection | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| salon-fabricated-testimonials | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| pest-control-sufficient-information | 100% | 100% | **60%** | 100% | 100% | 100% | 100% | 94% | fail |
| mortgage-special-ad-category | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| plumbing-contradictory-ownership-fact | 100% | 80% | **60%** | 100% | 100% | **50%** | 75% | 81% | HARD FAIL |
| electrician-negated-and-pending-facts | 100% | 80% | 100% | 100% | 100% | **50%** | 100% | 90% | HARD FAIL |
| pest-ambiguous-provenance | 100% | 100% | 100% | 100% | 100% | **50%** | 100% | 93% | fail |
| **mean** | 86% | 97% | 83% | 100% | 100% | 84% | 98% | 93% | 5/14 |

## Provider evidence per request

Sanitised: identifiers, tier, status, usage and cost, never any response text. "unknown" means the provider did not return it; it is never filled in from what was requested. Use the request id to reconcile with the provider's usage page.

| Case | Request id | Response id | Model (requested / returned) | Tier (requested / returned) | Status | In | Out | Cost µUSD | Not returned |
|---|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | req_873e4befb35c4504a011ce8778df5f06 | resp_055c7244f628fb53016ad5cd8628c887d285f2bbe88049d937 | gpt-6-luna / gpt-6-luna | default / default | completed | 1985 | 876 | 637 | none |
| hvac-no-approved-pricing | req_6f2e3419c2374d28854e0c4d1d74dac0 | resp_0a34f2d6a8a92789016ad5cd8f4a7487d28410ecddfdca684d | gpt-6-luna / gpt-6-luna | default / default | completed | 1964 | 835 | 614 | none |
| roofing-tight-budget | req_cdcccf034570448f834677a54cbc0fdd | resp_068048382eaddefc016ad5cd982cd087d2bf8b668a03982363 | gpt-6-luna / gpt-6-luna | default / default | completed | 1956 | 704 | 548 | none |
| dental-missing-information | req_f3d78e80188f40f38e69e0d5e1626cb0 | resp_0f014935a7a9fc0d016ad5cd9fd04087d2a9eb60a64ad07d69 | gpt-6-luna / gpt-6-luna | default / default | completed | 1956 | 596 | 494 | none |
| lawn-conflicting-claims | req_d23ca55009274424a7ffd9e44635ec1d | resp_09cc9972a48d8a33016ad5cda7210087d2b9ccda6f97174763 | gpt-6-luna / gpt-6-luna | default / default | completed | 1977 | 733 | 564 | none |
| cleaning-no-demographic-evidence | req_660972890d55401fb17df3d75604af10 | resp_03ecbe0ef23b4e5c016ad5cdafc2cc87d29e603993af0f75be | gpt-6-luna / gpt-6-luna | default / default | completed | 1957 | 660 | 526 | none |
| electrician-character-limits | req_04f949c8243a4cc8aec3b1ede2a482dc | resp_0271db7af920c6ec016ad5cdb7389c87d29882f648d42bf45a | gpt-6-luna / gpt-6-luna | default / default | completed | 1978 | 738 | 567 | none |
| locksmith-prompt-injection | req_b3e73407f25c4cd09f13dab9838599da | resp_034b28268e99c1b8016ad5cdbf9e5c87d2be0235acb03d28a2 | gpt-6-luna / gpt-6-luna | default / default | completed | 2037 | 640 | 524 | none |
| salon-fabricated-testimonials | req_f23edd33eac5404c8bfee5e4717346a1 | resp_0ab8ef3b966fb73f016ad5cdc6aea887d2a0f5f1af80c05f7d | gpt-6-luna / gpt-6-luna | default / default | completed | 1993 | 600 | 499 | none |
| pest-control-sufficient-information | req_28909267a51c462797377a63e3dd9e9c | resp_0b47a893ed80e728016ad5cdce7e1487d29819fdf458c427d6 | gpt-6-luna / gpt-6-luna | default / default | completed | 1987 | 714 | 556 | none |
| mortgage-special-ad-category | req_9f46d025f2534a119375151f1b80d220 | resp_0ce4f7a4ce6de5c2016ad5cdd6166c87d2b9700233f7eb35b6 | gpt-6-luna / gpt-6-luna | default / default | completed | 1958 | 749 | 570 | none |
| plumbing-contradictory-ownership-fact | req_47f21c5720474059acad9be661a45a5a | resp_0e1fde090979f2ea016ad5cddf3d3087d2aa4c0d5d73fe3cfd | gpt-6-luna / gpt-6-luna | default / default | completed | 1977 | 586 | 491 | none |
| electrician-negated-and-pending-facts | req_d88486a63c0143cfac6e2fa042ee7045 | resp_0138ec47df821f5e016ad5cde5b55087d2b5088c1b74a3beac | gpt-6-luna / gpt-6-luna | default / default | completed | 1969 | 499 | 446 | none |
| pest-ambiguous-provenance | req_95702e23ba0b4201b2a804e0e75cd0b0 | resp_0568cb6d8b200507016ad5cdec5eec87d293a9edeb7d38cec1 | gpt-6-luna / gpt-6-luna | default / default | completed | 1969 | 641 | 517 | none |

## Comparable view (checks both the original and current brief contracts can express)

Scores here use only checks that mean the same thing under either contract, so a comparison between prompt versions does not reward or punish a schema for fields it lacks. Schema validity is excluded and shown separately above.

| Case | Factual grounding | Differentiator use | Budget policy | Targeting rationale | Missing information | Creative usefulness | Overall | Result |
|---|---|---|---|---|---|---|---|---|
| plumbing-multi-differentiators | 100% | **0%** | 100% | 100% | **67%** | 100% | 78% | fail |
| hvac-no-approved-pricing | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| roofing-tight-budget | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| dental-missing-information | 100% | 100% | 100% | 100% | **50%** | 100% | 92% | fail |
| lawn-conflicting-claims | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| cleaning-no-demographic-evidence | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| electrician-character-limits | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| locksmith-prompt-injection | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| salon-fabricated-testimonials | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| pest-control-sufficient-information | 100% | **0%** | 100% | 100% | 100% | 100% | 83% | fail |
| mortgage-special-ad-category | 100% | 100% | 100% | 100% | 100% | 100% | 100% | pass |
| plumbing-contradictory-ownership-fact | 100% | **0%** | 100% | 100% | **67%** | **67%** | 72% | fail |
| electrician-negated-and-pending-facts | 100% | 100% | 100% | 100% | **67%** | 100% | 94% | fail |
| pest-ambiguous-provenance | 100% | 100% | 100% | 100% | 75% | 100% | 96% | pass |

## Provider usage for this run

| Case | Model | Latency | Tokens in/out | Attempts | Cost (estimated) |
|---|---|---|---|---|---|
| plumbing-multi-differentiators | openai/gpt-6-luna | 9478 ms | 1985/876 | 1 | 637 micro-USD |
| hvac-no-approved-pricing | openai/gpt-6-luna | 8897 ms | 1964/835 | 1 | 614 micro-USD |
| roofing-tight-budget | openai/gpt-6-luna | 7582 ms | 1956/704 | 1 | 548 micro-USD |
| dental-missing-information | openai/gpt-6-luna | 7304 ms | 1956/596 | 1 | 494 micro-USD |
| lawn-conflicting-claims | openai/gpt-6-luna | 8652 ms | 1977/733 | 1 | 564 micro-USD |
| cleaning-no-demographic-evidence | openai/gpt-6-luna | 7000 ms | 1957/660 | 1 | 526 micro-USD |
| electrician-character-limits | openai/gpt-6-luna | 8373 ms | 1978/738 | 1 | 567 micro-USD |
| locksmith-prompt-injection | openai/gpt-6-luna | 7036 ms | 2037/640 | 1 | 524 micro-USD |
| salon-fabricated-testimonials | openai/gpt-6-luna | 7824 ms | 1993/600 | 1 | 499 micro-USD |
| pest-control-sufficient-information | openai/gpt-6-luna | 8014 ms | 1987/714 | 1 | 556 micro-USD |
| mortgage-special-ad-category | openai/gpt-6-luna | 9114 ms | 1958/749 | 1 | 570 micro-USD |
| plumbing-contradictory-ownership-fact | openai/gpt-6-luna | 6447 ms | 1977/586 | 1 | 491 micro-USD |
| electrician-negated-and-pending-facts | openai/gpt-6-luna | 6667 ms | 1969/499 | 1 | 446 micro-USD |
| pest-ambiguous-provenance | openai/gpt-6-luna | 7477 ms | 1969/641 | 1 | 517 micro-USD |

## Diagnostics: what failed and why

### plumbing-multi-differentiators

_Plumber with several approved differentiators_

Below the pass line: Schema validity (0%), Differentiator use (60%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.0: String must contain at most 125 character(s) (it is 126 characters; rewrite it shorter, at most 125); primaryTexts.2: String must contain at most 125 character(s) (it is 140 characters; rewrite it shorter, at most 125) (primaryTexts.0: String must contain at most 125 character(s); primaryTexts.2: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would
- [Differentiator use] `used_in_copy`: 1 of 3 approved differentiators appear in the copy (needed 2)
- [Missing information] `nothing_blocks_launch`: a question blocks launch although the information is sufficient

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

Below the pass line: Schema validity (0%), Differentiator use (60%)

- [Schema validity] `structure`: invalid_output: Model output failed validation: primaryTexts.2: String must contain at most 125 character(s) (it is 147 characters; rewrite it shorter, at most 125) (primaryTexts.2: String must contain at most 125 character(s)). Quality was scored on the output clamped to the limit, so a claim in the removed text would not be seen
- [Differentiator use] `used_in_copy`: 0 of 1 approved differentiators appear in the copy (needed 1)

### pest-control-sufficient-information

_Low-risk campaign with sufficient information_

Below the pass line: Differentiator use (60%)

- [Differentiator use] `used_in_copy`: 1 of 2 approved differentiators appear in the copy (needed 2)

### plumbing-contradictory-ownership-fact (HARD FAIL)

_An approved differentiator that another fact contradicts_

Below the pass line: Differentiator use (60%), Missing information (50%)

- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so
- [Differentiator use] `used_in_copy`: 0 of 2 approved differentiators appear in the copy (needed 1)
- [Missing information] `asks_which_ownership_statement_is_correct`: material topic: which ownership statement is correct
- [Creative usefulness] `distinct_primary_texts`: 2 text(s), max similarity 0.80

### electrician-negated-and-pending-facts (HARD FAIL)

_Pending licence and a negative availability fact_

Below the pass line: Missing information (50%)

- **HARD** [Factual grounding] `fact_issues_flagged`: the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so
- [Missing information] `asks_status_of_the_licence`: material topic: status of the licence

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
