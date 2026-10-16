# Evaluation plan and preflight: recovered original vs current candidate (NOTHING SENT)

Generated 2026-10-16T13:42:54.428Z by `npm run eval:plan`. **This script made no network request** (it replaces `fetch` with a function that throws) and no model call or provider-access check. The only network use in preparing this document was reading the provider's public documentation pages on 2026-10-16. The live comparison has not been started and needs your final authorization.

## 0. Approved settings

| Setting | Value |
| --- | --- |
| Model | `gpt-6-luna` (provider `openai`) |
| Cases | 14 synthetic business scenarios |
| Arms | reconstructed original implementation; current candidate |
| Repetitions | 2 per case per arm |
| Planned generations | 56 |
| Max output tokens per generation | 2,500 |
| Maximum aggregate experimental spend | $0.1560 (156000 micro-USD) |
| Automatic retries / repairs | disabled / disabled |
| External advertising and CRM actions | prohibited |
| Deployment | local only |
| Service tier | explicitly `default` (standard), read back from every response |
| Response storage | explicitly disabled (`store: false`) |

## 1. What is compared

- **Arm A, original:** the recovered pre-Milestone-3 prompt, brief contract and Business Brain fields.
- **Arm B, current:** the candidate prompt and brief contract, with the full Business Brain.
- **Cases:** the same 14 synthetic businesses for both arms. All data is invented.
- **Identical for both arms:** model `openai/gpt-6-luna`, max output 2500 tokens, repair 0, retries 0, provider-default sampling, reasoning effort `none`, service tier `default` (pinned in the request and checked in the response).
- **Repetitions:** 2 per case per arm, so run-to-run variation is measured and not hidden.

Cases: `plumbing-multi-differentiators`, `hvac-no-approved-pricing`, `roofing-tight-budget`, `dental-missing-information`, `lawn-conflicting-claims`, `cleaning-no-demographic-evidence`, `electrician-character-limits`, `locksmith-prompt-injection`, `salon-fabricated-testimonials`, `pest-control-sufficient-information`, `mortgage-special-ad-category`, `plumbing-contradictory-ownership-fact`, `electrician-negated-and-pending-facts`, `pest-ambiguous-provenance`

## 2. Version identifiers

| Item | Original arm | Current arm |
| --- | --- | --- |
| Prompt | `campaign-prompt/1.0.0-original` | `campaign-prompt/3.1.0-candidate` |
| Prompt sha256 | `3d63b4e32e9f72a4…` | `459ef9a3cb72c6a1…` |
| Output contract | `campaign-brief-schema/1.0.0-original` | `campaign-brief-schema/3.0.0` |
| Contract sha256 | `d4ca745fe5a8d194…` | `d1c637fd379a3d3c…` |
| Business Brain sent | 9 original fields only | full brain (facts projected into the fields the prompt names) |

- **Evaluator:** `campaign-evaluator/3.2.0`; source fingerprints for 17 files and the fixtures fingerprint `0c2fb7a3fc16c729…` are in the JSON file. Re-run `npm run eval:plan` after any code change: the fingerprints and numbers here are only valid for the code they were generated from.
- **Model:** `openai/gpt-6-luna`. not pinned: the provider id is an alias with no dated snapshot listed; the response's model id and service tier are recorded per request.
- **Config fingerprints:** models `d24ba36a913d…`, pricing `3242162bbc57…`.

## 3. Pricing verification (documentation, read 2026-10-16)

Sources: [pricing](https://developers.openai.com/api/docs/pricing), [models](https://developers.openai.com/api/docs/models), [retrieve model](https://developers.openai.com/api/reference/resources/models/methods/retrieve). The page text was read through a fetch tool that summarises the page, so wording is the tool's; a person should glance at the pricing page before the run.

| Question | What the official pages state | Effect on this plan |
| --- | --- | --- |
| Exact model id | `gpt-6-luna` is listed on the models page under exactly that id. No dated snapshot id is listed. | Id matches the registry. Because it is an alias, the response's model id is recorded per request so a silent change is visible. |
| Standard rates | $0.10 per 1M input, $0.50 per 1M output (short context). Matches `config/ai-pricing.json`. | Used: input $0.1000 / output $0.5000 per 1M tokens. |
| Long-context pricing | Applies above 272K input tokens (input $0.20, output $0.75). | Does not apply: the largest possible input here is 9,478 tokens even counting one token per byte. The cost model refuses to run if an input could exceed the threshold. |
| Cached input | $0.01 per 1M (cheaper than standard). | Not relied on. A cache hit could only lower the bill, so the bound stays an upper bound. |
| Batch / Flex | Half the standard rates. | Not used (synchronous requests). Could only lower the bill. |
| Fast (priority) | Twice the standard rates ($0.20 / $1.00). | **Would double the cost.** The request pins `service_tier: "default"` and the run halts if a response reports any other tier or none. |
| Regional processing | A 10% uplift 'for models released on or after March 5, 2026'. The page does not say whether `gpt-6-luna` qualifies (its knowledge cutoff is May 2026, so it may). | Cannot be ruled out, so every reserve is multiplied by 1.1. |
| Reasoning tokens | The pricing page does not say how they are billed. The registry sets reasoning effort `none`, so little or no hidden reasoning is expected. Cost is computed from the provider-reported output tokens and the output cap limits them; whether reasoning tokens are inside that count is the provider's statement to confirm, and this plan did not verify it. | Treated as output tokens inside the cap. A request that exceeded the cap would show as a cost above its reserve and halt the run. |
| Responses API / structured outputs | The models page does not list per-model endpoint or structured-output support. | Supported in practice: earlier live requests used the Responses API with strict structured output and succeeded (docs/ai-verification.md). |
| Ultrafast | `gpt-6-luna` is not listed. | Not applicable. |

**Conclusion on rates.** For these requests the applicable rate is the standard short-context rate ($0.10 / $0.50 per 1M), provided the standard tier is used. That is a consequence of pinning the tier and of the inputs being far below 272K tokens, not an assumption. The one rate that could still differ is the regional uplift, which is covered by the 1.1 factor. **The rates themselves are the provider's published prices; this plan cannot confirm what the account is actually billed.** The earlier six billed requests matched the price table to the micro-USD against the provider-reported token counts (re-checked here: yes), which confirms the arithmetic and not the invoice.

### Live service-tier diagnostic (already run, one request)

One generation was made on 2026-10-16 to test the tier before any evaluation: `gpt-6-luna`, `service_tier: "default"`, 128 output tokens, synthetic input, no retries.

| Observation | Result |
| --- | --- |
| HTTP / request id | HTTP 200 / `req_9c2ea07d97dc4734b408a7d595daef3c` |
| Returned service tier | `default` |
| Model returned | `gpt-6-luna` |
| Usage | 114 input, 17 output (0 reasoning) tokens |
| Cost (price table) | 20 µUSD ($0.000020) |
| Checks passed | 17 of 17 |

Evidence: `docs/live-verification/openai-tier-diagnostic-2026-10-16T12-49-19-911Z.json`. This shows the endpoint accepts and reports the tier. It does not show the account's billing, and it did not send `store: false` (the adapter did not support it then).

## 4. Request count and cost bound

- Primary requests: 14 cases × 2 arms × 2 repetitions = **56**. Retries and repairs are disabled, so the **maximum is also 56**; a request that needs a second attempt halts the run.
- Input tokens cannot be counted exactly offline, so three figures are kept apart: an **expectation** (from what was billed before), an **estimated worst case** (characters / 3 + 400 tokens of headroom, full output cap) and an **absolute worst case** (one token per UTF-8 byte, which no tokenizer can exceed, full output cap, ×1.1).

| Basis | Original, 1 repetition (14) | Current, 1 repetition (14) | All 56 requests |
| --- | --- | --- | --- |
| Expected (from 6 billed requests) | — | — | 24342–34509 µUSD ($0.0243–$0.0345) |
| Estimated worst case | 19193 µUSD | 22377 µUSD | **83140 µUSD ($0.0831)** |
| Absolute worst case (bytes, ×1.1) | 22985 µUSD | 33487 µUSD | 112944 µUSD ($0.1129) |

- **Approved ceiling:** 156000 µUSD ($0.1560). It is 1.88× the estimated worst case. The absolute worst case, if every one of the 56 requests hit it, is within the ceiling (112944 vs 156000).
- **What that means.** Even if every one of the 56 requests used its absolute maximum input and the full output cap, the total (112944 µUSD) stays within the ceiling, so **no request can be blocked by the budget in any circumstance**, and the aggregate cannot pass the ceiling.
- **Budgets.** No access check is planned, so the whole ceiling is available. The ceiling is split between the invocations in proportion to each arm's absolute worst case: original **31500** µUSD and current **46500** µUSD per invocation. The most that can ever be committed is 2 × (31500 + 46500) = **156000 µUSD**, which is within the ceiling. Each budget is above that arm's absolute worst case for one repetition (22985 and 33487), so a budget can never block a request.

### Reconciliation of the aggregate

Each invocation evaluates exactly **14** requests (one per case, one arm); there are **4** invocations. A reserve is computed **per request from that request's own input**, so the 14 values differ slightly. The largest single-request reserve per arm is 1662 (original) and 2418 (current); those are maxima, not the reserve of every request.

| Arm | Requests per invocation | Smallest reserve | Largest reserve | Sum of the 14 actual reserves | 14 × largest |
| --- | --- | --- | --- | --- | --- |
| Original | 14 | 1635 | 1662 | 22985 | 23268 |
| Current | 14 | 2381 | 2418 | 33487 | 33852 |

- **Exact aggregate** = 2 × (22985 + 33487) = **112944 µUSD ($0.1129)**. This is what the plan reports.
- **Simple upper bound** = 2 × (14 × 1662 + 14 × 2418) = 28 × 1662 + 28 × 2418 = **114240 µUSD ($0.1142)**. It assumes every request reserved the largest value for its arm, so it is higher by 1296 µUSD (283 + 365 per repetition, × 2). Both figures are valid upper bounds; the second is the one to quote if a single simple number is wanted.
- **Both are inside the ceiling** of 156000 µUSD (headroom 41760 µUSD on the simple bound). Each invocation budget (original 31500, current 46500) covers its arm's exact sum **and** 14 × largest reserve: yes.
- **Spend already incurred, outside this ceiling:** the single service-tier diagnostic charged 20 µUSD to its own ledger (`docs/live-verification/ledger-tier-diagnostic.json`, ceiling 2000, one request). That ledger and the comparison ledger (`docs/eval/ledger-cmp-3-2.json`) are separate files for separate experiments; neither command reads or writes the other, so neither erases the other's spend. Earlier live runs are recorded in `docs/eval/m3-live*` and are not part of this experiment.

- **Aggregate limit across invocations.** A ledger file (`docs/eval/ledger-cmp-3-2.json`) records every invocation before it sends anything. The command refuses to start if the committed total plus its own reserve would pass 156000 µUSD or 56 requests, if an earlier invocation halted or never finished and has not been explicitly reconciled by a person (`--reconcile` with a written note, which is recorded), or if asked to change the limits of an existing ledger.
- **If anything charges more than its reserve** (the provider bills a rate not recorded here), the first such request is seen after the fact, the run halts, and the ledger refuses to continue. The worst consequence is therefore bounded by one request's overshoot, not the whole run.

### Calibration of the input estimate against billed requests

These six requests were billed in the second live run (`docs/eval/m3-live2-*`); the old arm there used the original prompt text with the current contract. No new request was made for this table.

| Arm | Case | Billed input | Estimate (÷3 + 400) | Billed ÷ estimate | Bytes (absolute) |
| --- | --- | --- | --- | --- | --- |
| current | `plumbing-multi-differentiators` | 1780 | 3498 | 0.51 | 9292 |
| current | `hvac-no-approved-pricing` | 1759 | 3450 | 0.51 | 9149 |
| current | `roofing-tight-budget` | 1751 | 3452 | 0.51 | 9155 |
| legacy | `plumbing-multi-differentiators` | 1124 | 2092 | 0.54 | 5075 |
| legacy | `hvac-no-approved-pricing` | 1103 | 2044 | 0.54 | 4932 |
| legacy | `roofing-tight-budget` | 1096 | 2047 | 0.54 | 4939 |

The estimate was above the billed input in every sample (billed was 51% to 54% of it). That is evidence the estimate is conservative for prompts of this family, **not a guarantee**: it covers only the current contract with two prompt styles and no sample of the original arm's own prompt. This is why the reserve uses the absolute figure.

<details><summary>Per-case figures (µUSD)</summary>

| Case | Original est. / absolute | Current est. / absolute |
| --- | --- | --- |
| `plumbing-multi-differentiators` | 1373 / 1648 | 1600 / 2398 |
| `hvac-no-approved-pricing` | 1370 / 1640 | 1595 / 2382 |
| `roofing-tight-budget` | 1370 / 1640 | 1596 / 2383 |
| `dental-missing-information` | 1370 / 1637 | 1595 / 2381 |
| `lawn-conflicting-claims` | 1370 / 1637 | 1597 / 2386 |
| `cleaning-no-demographic-evidence` | 1371 / 1642 | 1596 / 2384 |
| `electrician-character-limits` | 1377 / 1662 | 1602 / 2404 |
| `locksmith-prompt-injection` | 1371 / 1641 | 1606 / 2418 |
| `salon-fabricated-testimonials` | 1369 / 1635 | 1601 / 2400 |
| `pest-control-sufficient-information` | 1372 / 1644 | 1601 / 2401 |
| `mortgage-special-ad-category` | 1370 / 1640 | 1595 / 2382 |
| `plumbing-contradictory-ownership-fact` | 1371 / 1643 | 1598 / 2391 |
| `electrician-negated-and-pending-facts` | 1370 / 1640 | 1598 / 2391 |
| `pest-ambiguous-provenance` | 1369 / 1636 | 1597 / 2386 |

</details>

## 5. The provider access check (documented; NOT used in this plan)

- **Operation:** `GET https://api.openai.com/v1/models/gpt-6-luna` with the bearer key, issued by `verifyModelAccess` in `src/eval/liveRun.ts`. It is **not** a generation endpoint and sends no prompt or business data. Its only inputs are the key and the model id.
- **What it tests:** that the key is accepted (HTTP 401/403 otherwise) and that the account can see that exact model id (HTTP 404 otherwise). It does not test that a generation will succeed, that the account has quota or billing enabled, or what tier a request would use.
- **Billing:** the official reference page for this endpoint states **nothing** about billing, cost, token usage or rate limits, and the models page says nothing about billing for the Models API. It is a metadata request with no tokens, so a charge is not expected, but **the documentation does not say so and this plan does not claim it is free**. Each access check is therefore charged to the budget at an allowance of 500 µUSD ($0.0005), recorded in the ledger. That is a deliberately generous placeholder for an operation that carries no tokens, not a measured price.
- **Status in this plan:** not used. The live service-tier diagnostic made a real generation with this key and model, which is stronger evidence than a metadata request, so the 84-to-56 request plan has no access check and no allowance for one. The `--check-access` option remains available; if it were ever used its cost would be charged to the budget at 500 µUSD and the ledger would record it.
- It was not run in this task and is not part of the commands below.

## 6. Scoring methodology

Each output is scored on separate layers; none stands in for another.

1. **Schema validity**, against each arm's own contract (length limits and truncation included). Reported separately and never merged into quality. An output that fails validation but is received is still scored on the layers below; an output that is cut off has nothing to score and is counted as such.
2. **Factual grounding** (hard checks), judged against the full fixture Business Brain for both arms: unsupported, contradicted, ambiguous, out-of-scope, missing-condition and expired claims; injected instructions; unverified or prohibited claims. A hard failure is reported as such in either arm.
3. **Comparable quality dimensions**, using only checks both contracts can express: Factual grounding, Differentiator use, Budget policy, Targeting rationale, Missing information, Creative usefulness (restricted to the comparable checks in `src/eval/evaluate.ts`). Pass line 70% per dimension, a working threshold and not a standard.
4. **Current-only dimensions** (reasoning fields, differentiator decisions, variations, review flags, question impact) are reported for the current arm alone and never used to rank the arms.

**Repetitions.** Every repetition is its own report (`cmp-3-2-<arm>-rep<N>`), listed individually. Per case and arm the aggregate shows both values, the mean, the minimum and how many repetitions passed. The arms are compared case by case (paired), then counted: cases where current is higher, equal, lower on the comparable overall. Hard failures are counted per arm and per repetition.

**Decision rule, fixed before any result exists.** The result is called an *indication of improvement* only if all hold: current's comparable overall is higher or equal in at least 10 of the 14 case means; current has no more hard failures than original; and there is no case where current hard-fails in every repetition while original never does. Otherwise it is reported as *mixed* or *no demonstrated improvement*. No result is described as statistically significant, and a favourable result is not evidence of marketing performance. The rule, the pass line and the evaluator version are recorded here and in the code; they cannot be changed after results are seen without a new evaluator version.

**Run order.** Invocations alternate by repetition (original 1, current 1, original 2, ...), so provider drift over the session affects both arms alike. The reported model id, service tier and request id are recorded for every request.

## 7. What depends on reconstructed historical artifacts

The repository had no Git history. The original implementation was rebuilt by replaying recorded edits (see `src/eval/original.ts`, `docs/campaign-evaluation.md`). **Everything on the original arm inherits that limit.**

| Dependency | Reconstructed? | Basis and risk |
| --- | --- | --- |
| Original system prompt | Yes | Replayed from recorded edits; character-identical to the prompt used in the first live run. Low risk. |
| Original brief contract (zod, JSON schema, hint) | Yes | Replayed from recorded edits; the real output of the original code parses under it. Low-to-moderate risk: an unrecorded shell edit would be missed. |
| Original Business Brain fields | Yes | Same replay. The fixtures are projected onto these 9 fields, so the original arm does not see verified facts, pricing, unverified claims or provenance. That reflects the original system but is also a design choice that affects every original-arm result. |
| Original generation parameters | Partly | Output cap, repair and retry settings are set for this experiment and apply to BOTH arms; they are not the original production defaults. |
| The evaluator and the 14 fixtures | No, but new | Written after the original; both arms are scored by the same code. The newest fixtures were written knowing the current design. |
| Earlier live reports (m3-live, m3-live2) | Not used | Different prompt revision and, for the old arm, the current contract. Used here only for the cost calibration above. |

## 8. Preparation checks

| Check | Result | Where verified |
| --- | --- | --- |
| Arms use their intended prompt and schema versions | Yes: the original arm sends the original prompt, JSON schema, hint and 9-field brain; the current arm the candidate. Versions and fingerprints are recorded in every report. | `test/versionsAndBaseline.test.ts`, `config/prompt-versions.json` |
| Reconstruction limits disclosed | Yes: section 7, `src/eval/original.ts`, `docs/campaign-evaluation.md` | documents |
| Rubric and decision rule fixed before results | Yes: section 6; evaluator version campaign-evaluator/3.2.0 with source fingerprints | this plan, committed before the run |
| Fixtures contain no confidential information | Yes: invented names; a test checks the fixtures contain no email address, URL or phone number | `test/campaignQuality.test.ts` |
| Schema validity, factual grounding and other dimensions reported separately | Yes: separate fields (`schemaValid`, `qualityPassed`), separate dimensions and a separate comparable view | `test/versionsAndBaseline.test.ts`, `test/factGrounding.test.ts` |
| Repetitions identified individually and aggregated clearly | Yes: one report per repetition; aggregation rule in section 6 | plan, CLI `--compare` |
| All requests, costs and stop conditions recorded | Yes: per request tokens, cost, attempts, model id, service tier; ledger of every invocation; halt reasons | `src/eval/liveRun.ts`, `src/eval/ledger.ts` |
| Retries and repairs cannot occur | Configured off (retries 0, repair 0) AND enforced: more than one attempt halts the run | `test/evalPlan.test.ts` |
| Cost unknown halts | Yes: an unmeasurable cost is charged at the reserve and halts | `test/evalPlan.test.ts` |

## 9. Stop conditions

| Condition | Action | Enforced by |
| --- | --- | --- |
| Budget would be passed by the next request's own reserve | Do not send it; later cases recorded as not run | Code (`BudgetExhausted`) |
| Aggregate ceiling or request cap would be passed, or limits changed | Do not start the invocation | Code (ledger) |
| An earlier invocation halted or never finished | Do not start the next until a person reconciles it with a recorded note | Code (ledger; `--reconcile`) |
| The provider rejects a request (HTTP 4xx other than 429) | Halt: the same request would be rejected again | Code (`liveRun`) |
| 3 consecutive requests fail at the provider (outage, timeout, rate limit) | Halt | Code (`liveRun`) |
| More HTTP requests than the invocation planned (a retry, a repair, a bug) | The extra request is refused before it leaves the process | Code (`capRequests` on the transport) |
| A retry or repair is requested for a registered experiment | Refuse to start | Code (CLI) |
| A request needed more than 1 attempt (a retry or a repair) | Halt immediately | Code (`maxAttemptsPerRequest` = 1; retries 0 and repair 0 also set) |
| A request's cost cannot be determined | Halt; charged at the reserve, never as zero | Code (`haltOnUnknownCost`) |
| The response reports a processing tier other than `default`, or none | Halt: the price assumed may not apply | Code (`expectedServiceTier`) |
| The model has no recorded price | Refuse to plan or run | Code (CLI) |
| Price page differs from `config/ai-pricing.json`, or the recorded price is older than 14 days | Do not start; re-verify | Procedure, before the run |
| More than 4 of the first 14 requests of an invocation produce nothing scorable | Stop and review before the next invocation | Procedure, after the first invocation |
| Any sign that real customer data is in an input | Stop | Procedure; the fixtures are synthetic |

## 10. Exact invocation (not run)

Prerequisites, set in your shell or `.env.local` (never pasted into chat): `AI_PROVIDER_MODE=live`, `ALLOW_LIVE_PROVIDER_CALLS=true`, `OPENAI_API_KEY`. The command itself sets the service tier to `default` and response storage to disabled, and refuses to start if the environment says otherwise. Run each invocation first **without** `--yes-spend` to see its plan (no network request, no spend). If an invocation halts or is interrupted, the next one is refused until a person reconciles the ledger: `npm run eval:campaigns -- --reconcile "<what you reviewed and why it is safe to continue>" --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros 156000 --max-total-requests 56`.

```
npm run eval:campaigns -- --models openai/gpt-6-luna --max-output 2500 --repair 0 --retries 0 --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros 156000 --max-total-requests 56 --prompt original --budget-micros 31500 --label cmp-3-2-original-rep1 --yes-spend
npm run eval:campaigns -- --models openai/gpt-6-luna --max-output 2500 --repair 0 --retries 0 --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros 156000 --max-total-requests 56 --prompt current --budget-micros 46500 --label cmp-3-2-current-rep1 --yes-spend
npm run eval:campaigns -- --models openai/gpt-6-luna --max-output 2500 --repair 0 --retries 0 --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros 156000 --max-total-requests 56 --prompt original --budget-micros 31500 --label cmp-3-2-original-rep2 --yes-spend
npm run eval:campaigns -- --models openai/gpt-6-luna --max-output 2500 --repair 0 --retries 0 --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros 156000 --max-total-requests 56 --prompt current --budget-micros 46500 --label cmp-3-2-current-rep2 --yes-spend
```

Then, offline and free, per repetition:

```
npm run eval:campaigns -- --compare docs/eval/cmp-3-2-original-rep1-openai-gpt_6_luna.json docs/eval/cmp-3-2-current-rep1-openai-gpt_6_luna.json --names original,current --label cmp-3-2-rep1
npm run eval:campaigns -- --compare docs/eval/cmp-3-2-original-rep2-openai-gpt_6_luna.json docs/eval/cmp-3-2-current-rep2-openai-gpt_6_luna.json --names original,current --label cmp-3-2-rep2
```

## 11. Remaining uncertainties for final authorization

1. **Prices are the provider's published figures.** The plan cannot see what the account is billed. A per-request check after the first invocation (compare the account's usage page with the ledger) is recommended before the next.
2. **The regional uplift** may or may not apply to this model; it is covered by a ×1.1 factor, not confirmed.
3. **Reasoning-token billing** is not stated on the pricing page; it is bounded by the output cap, and the run halts if a request ever costs more than its reserve.
4. **`store: false` has not been exercised against the live API.** The provider documents the parameter and the adapter now sends it, but the diagnostic ran before it existed. If the API rejects it, the first request fails with an HTTP 4xx, is not billed, the run halts, and the ledger shows one request. `store: false` asks the API not to keep the response for later retrieval; it does not by itself guarantee zero retention in the provider's logging or abuse-monitoring systems.
5. **All 56 requests can run even at their absolute maximum cost** (section 4), so the budget cannot stop the run; the expectation is $0.0243 to $0.0345.
6. **The service-tier read-back was verified live, once.** A single diagnostic generation (req_9c2ea07d97dc4734b408a7d595daef3c) returned `service_tier: "default"` and the run now halts on any other value. It is one observation, not a guarantee for every later request; the halt is the protection.
7. **The model id is an alias** with no dated snapshot; behaviour could change between repetitions. Reported ids and request ids are recorded.
8. **The original arm is a reconstruction** (section 7), the fixtures are 14 synthetic cases, and the evaluator is heuristic. A result is an indication, not proof of anything about marketing performance.
9. **The estimate of input tokens is calibrated on the current contract only** (section 4); the reserve uses the absolute figure for that reason.
10. **The plan's numbers are valid for the committed code.** Regenerate with `npm run eval:plan` after any change.
