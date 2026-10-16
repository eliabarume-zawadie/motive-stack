# Evaluation plan: recovered original vs current candidate (DRY RUN, nothing sent)

Generated 2026-10-16T11:54:02.207Z by `npm run eval:plan`. **No network request, model call or provider-access check was made** (the script replaces `fetch` with a function that throws). This is a plan for review; the live comparison has not been started and needs separate approval.

## 1. What is compared

- **Arm A, original:** the recovered pre-Milestone-3 prompt, brief contract and Business Brain fields.
- **Arm B, current:** the candidate prompt and brief contract, with the full Business Brain.
- **Cases:** the same 14 synthetic businesses for both arms (ids below). All data is invented.
- **Model and parameters (identical for both arms):** openai/gpt-6-luna, max output 2500 tokens, repair 0, retries 0, provider-default sampling, reasoning effort `none`.
- **Repetitions:** 3 per case per arm. Repetition measures run-to-run variation; with sampling left at provider defaults, one run per case would hide it.

Cases: `plumbing-multi-differentiators`, `hvac-no-approved-pricing`, `roofing-tight-budget`, `dental-missing-information`, `lawn-conflicting-claims`, `cleaning-no-demographic-evidence`, `electrician-character-limits`, `locksmith-prompt-injection`, `salon-fabricated-testimonials`, `pest-control-sufficient-information`, `mortgage-special-ad-category`, `plumbing-contradictory-ownership-fact`, `electrician-negated-and-pending-facts`, `pest-ambiguous-provenance`

## 2. Version identifiers

| Item | Original arm | Current arm |
| --- | --- | --- |
| Prompt | `campaign-prompt/1.0.0-original` | `campaign-prompt/3.1.0-candidate` |
| Prompt sha256 | `3d63b4e32e9f72a4…` | `459ef9a3cb72c6a1…` |
| Output contract | `campaign-brief-schema/1.0.0-original` | `campaign-brief-schema/3.0.0` |
| Contract sha256 | `d4ca745fe5a8d194…` | `d1c637fd379a3d3c…` |
| Business Brain sent | 9 original fields only | full brain (facts projected into the fields the prompt names) |

- **Evaluator:** `campaign-evaluator/3.2.0`. Source fingerprints (sha256, line-ending-normalised) are in the JSON file for 10 files; fixtures fingerprint `0c2fb7a3fc16c729…`.
- **Model:** `openai/gpt-6-luna` (registry entry fingerprint `9df9a267cfd65edf…`). not pinned: the provider id is an alias; the response's model id must be recorded per request.
- **Config fingerprints:** `config/ai-models.json` `d24ba36a913d…`, `config/ai-pricing.json` `3242162bbc57…`.

## 3. Request count and cost bound

- Primary requests: 14 cases × 2 arms × 3 repetitions = **84**.
- Retries and repairs are disabled, so the **maximum is also 84 requests**. If any request needs a second attempt the run halts (section 6), so the count cannot grow unnoticed.
- Price used (local, provisional): input $0.1000 and output $0.5000 per million tokens, recorded 2026-10-16 from https://developers.openai.com/api/docs/pricing. The registry notes that regional processing (+10%) and cached or batch tiers are not modelled, hence the margin below. **Not re-verified in this task.**
- Worst case per request = (estimated input tokens + 400 headroom) × input rate + the full 2500-token output cap × output rate. Input includes the prompt, the data and the JSON schema and hint. Reasoning tokens bill as output and are inside the cap.

| Arm | Worst case, one repetition (14 requests) | Worst case, 3 repetitions |
| --- | --- | --- |
| Original | 19192 µUSD ($0.0192) | 57576 µUSD ($0.0576) |
| Current | 22377 µUSD ($0.0224) | 67131 µUSD ($0.0671) |
| **Total** | 41569 µUSD | **124707 µUSD ($0.1247)** |

- **Proposed hard ceiling: 156000 µUSD ($0.1560)** = worst case × 1.25 provisional-price margin, rounded up. It is a stop line, not an expected cost. Earlier runs on this model recorded roughly 30% to 45% of the per-request worst case, so the expected spend is well below the ceiling.
- **Per-invocation budgets** (each invocation runs one arm over the 14 cases once): original 24000 µUSD, current 28000 µUSD. Their sum over 3 repetitions is 156000 µUSD, which is the most the plan can authorise in total.

<details><summary>Per-case worst case (µUSD) and estimated input tokens</summary>

| Case | Original in-tokens | Original µUSD | Current in-tokens | Current µUSD |
| --- | --- | --- | --- | --- |
| `plumbing-multi-differentiators` | 1225 | 1373 | 3497 | 1600 |
| `hvac-no-approved-pricing` | 1197 | 1370 | 3449 | 1595 |
| `roofing-tight-budget` | 1200 | 1370 | 3451 | 1596 |
| `dental-missing-information` | 1192 | 1370 | 3444 | 1595 |
| `lawn-conflicting-claims` | 1193 | 1370 | 3463 | 1597 |
| `cleaning-no-demographic-evidence` | 1204 | 1371 | 3456 | 1596 |
| `electrician-character-limits` | 1264 | 1377 | 3516 | 1602 |
| `locksmith-prompt-injection` | 1200 | 1370 | 3559 | 1606 |
| `salon-fabricated-testimonials` | 1185 | 1369 | 3501 | 1601 |
| `pest-control-sufficient-information` | 1213 | 1372 | 3506 | 1601 |
| `mortgage-special-ad-category` | 1197 | 1370 | 3449 | 1595 |
| `plumbing-contradictory-ownership-fact` | 1208 | 1371 | 3476 | 1598 |
| `electrician-negated-and-pending-facts` | 1199 | 1370 | 3475 | 1598 |
| `pest-ambiguous-provenance` | 1189 | 1369 | 3462 | 1597 |

</details>

## 4. Scoring methodology

Each output is scored on separate layers; none is allowed to stand in for another.

1. **Schema validity**, against each arm's own contract (including length limits and truncation). Reported separately and never merged into quality. An output that fails validation but is received is still scored on the layers below; an output that is cut off has nothing to score and is counted as such.
2. **Factual grounding** (hard checks), judged against the full fixture Business Brain for both arms: unsupported, contradicted, ambiguous, out-of-scope, missing-condition and expired claims; injected instructions; unverified or prohibited claims. This is the safety layer, and a hard failure is reported as such in either arm.
3. **Comparable quality dimensions**, using only checks both contracts can express: Factual grounding, Differentiator use, Budget policy, Targeting rationale, Missing information, Creative usefulness (restricted to the comparable checks listed in `src/eval/evaluate.ts`). Pass line 70% per dimension (a working threshold, not a standard).
4. **Current-only dimensions** (reasoning fields, differentiator decisions, variations, review flags, question impact) are reported for the current arm alone and are never used to rank the arms.

**Aggregation.** Per case and arm, all repetitions are listed, with the mean, the minimum and the number of repetitions that passed. The arms are compared case by case (paired), then counted: cases where current is higher, equal, lower on the comparable overall. Hard failures are counted per arm.

**Decision rule, fixed in advance.** The result is called an *indication of improvement* only if all hold: current's comparable overall is higher or equal in at least 10 of the 14 case means; current has no more hard failures than original; and there is no case where current hard-fails in every repetition while original never does. Otherwise it is reported as *mixed* or *no demonstrated improvement*. No result is described as statistically significant, and a favourable result is not evidence of marketing performance.

**Run order.** Invocations alternate by repetition (original 1, current 1, original 2, current 2, ...), so a drift in the provider over the session affects both arms alike. The model's reported id and the request id are recorded for every request.

## 5. Which results depend on reconstructed historical artifacts

The repository had no Git history. These depend on a reconstruction (see `src/eval/original.ts` and `docs/campaign-evaluation.md`):

| Dependency | Reconstructed? | Basis and risk |
| --- | --- | --- |
| Original system prompt | Yes | Replayed from recorded edits; character-identical to the prompt used in the first live run. Low risk. |
| Original brief contract (zod + JSON schema + hint) | Yes | Replayed from recorded edits; the real output of the original code parses under it. Low-to-moderate risk: an unrecorded shell edit would be missed. |
| Original Business Brain fields | Yes | Same replay. The 14 fixtures are projected onto these 9 fields, so the original arm does not see verified facts, pricing, unverified claims or provenance. That reflects the original system but is also a design choice that affects every original-arm result. |
| Original generation parameters | Partly | Output cap, repair and retry settings are chosen for this experiment and applied to BOTH arms; they are not the original production defaults. |
| The evaluator and the 14 fixtures | No, but new | Written after the original; both arms are scored by the same code. Scores are heuristics (see limits). The 3 newest fixtures were written knowing the current design. |
| Earlier live reports (m3-live, m3-live2) | Not used | They used an unfingerprinted revision of the prompt and, for the old arm, the current contract. They are not part of this comparison. |

## 6. Stop conditions

| Condition | Action | Enforced by |
| --- | --- | --- |
| Budget exhaustion | Stop before a request whose worst case would pass the invocation budget; later cases are recorded as not run, never guessed | Implemented (`BudgetExhausted`, reserve check before each request) |
| Any retry or repair attempt (a request needing more than 1 attempt) | Halt the whole invocation immediately; send nothing more until reviewed | Implemented (`maxAttemptsPerRequest` = 1; retries 0 and repair 0 are also set in configuration) |
| Unknown or unmeasurable cost (no usage reported, no price) | Halt; the failed or unpriced request is charged at the worst-case reserve, never as zero | Implemented (`haltOnUnknownCost`; the CLI also refuses a model with no recorded price) |
| Price record older than 14 days, a price page that disagrees with `config/ai-pricing.json`, or model access unconfirmed | Do not start; re-verify first (needs the network and your approval) | Procedure, before any live run |
| Cumulative recorded spend reaching the hard ceiling across invocations | Stop; do not start the next invocation | Procedure: add the invocation totals after each one |
| More than 4 of the first 14 requests of an invocation produce nothing scorable (cut off or invalid) | Stop and review the output cap and the failures before continuing | Procedure: check after the first invocation |
| Any request that appears to use real customer data or private content | Stop; fixtures are synthetic only | Procedure; no such input exists in the fixtures |

## 7. Commands (not run)

Each invocation is one arm over the 14 cases, once. Each starts with a plan-only run (it makes one free model-access request and sends nothing billable). **Do not run these without approval:**

```
# prerequisites: AI_PROVIDER_MODE=live  ALLOW_LIVE_PROVIDER_CALLS=true  key in .env.local
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt original --max-output 2500 --repair 0 --retries 0 --budget-micros 24000 --label cmp-original-rep1   # add --yes-spend to run
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt current --max-output 2500 --repair 0 --retries 0 --budget-micros 28000 --label cmp-current-rep1   # add --yes-spend to run
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt original --max-output 2500 --repair 0 --retries 0 --budget-micros 24000 --label cmp-original-rep2   # add --yes-spend to run
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt current --max-output 2500 --repair 0 --retries 0 --budget-micros 28000 --label cmp-current-rep2   # add --yes-spend to run
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt original --max-output 2500 --repair 0 --retries 0 --budget-micros 24000 --label cmp-original-rep3   # add --yes-spend to run
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt current --max-output 2500 --repair 0 --retries 0 --budget-micros 28000 --label cmp-current-rep3   # add --yes-spend to run
# then, offline and free, per repetition:
npm run eval:campaigns -- --compare docs/eval/cmp-original-rep1-openai-gpt_6_luna.json docs/eval/cmp-current-rep1-openai-gpt_6_luna.json --names original,current --label cmp-rep1
```

## 8. Limits of this plan

- The cost bound rests on locally recorded prices that were not re-verified here, on a character-based token estimate, and on the output cap being enforced by the provider. The margin and the halt rules are the protection if any of them is wrong.
- 14 cases, even repeated, are an indication and not a reliability measure. Repeating a case reduces noise in that case; it does not add independent cases.
- The evaluator's checks are pattern based (see `docs/campaign-evaluation.md`). A pass is not proof a claim is true, and a fail may be a false alarm.
- Nothing here measures marketing performance. Synthetic fixtures cannot.
- The plan is only as faithful to the original as the reconstruction (section 5).
