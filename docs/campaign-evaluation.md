# Campaign intelligence and quality evaluation (Milestone 3)

## Why this exists

The first real campaign brief (OpenAI `gpt-6-luna`, 2026-10-16) was valid JSON but weak:

1. **Generic targeting** with no rationale.
2. **The maximum budget** was chosen (the owner's ceiling treated as a target).
3. **An approved differentiator ("Licensed and insured") was ignored.**
4. **Open questions were empty** although material information was missing.

Before changing anything we looked at the prompt, the input, the Business Brain, the schema, the validation and the tests. The causes were mostly ours, not the model's: the prompt never asked for targeting reasoning or a separate starting budget, the schema had nowhere to put either, nothing checked differentiators, and "valid against the schema" was the only quality gate. So the fix is in the instructions, the data model and the validators. We did **not** switch models, replace the gateway or add an agent framework.

## What changed

| Area | Before | Now |
|---|---|---|
| Budget | `dailyBudgetCents` only | The owner's maximum is a **hard ceiling**. `dailyBudgetCents` is the **proposed starting budget**, with `budgetRationale`. Output over the ceiling is rejected; a start equal to the ceiling is rejected unless a review flag explains it. The proposal records both numbers. |
| Targeting | audience only | `targeting`: approach, connection to the service, basis (`owner_provided` / `general_best_practice` / `assumption`), evidence, restrictions, uncertainties, what is needed from the owner. Narrowing by age or interest needs owner evidence or a stated assumption. The UI separates advice from the settings the Meta integration can apply. |
| Facts | free text | Business Brain gains `verifiedFacts`, `approvedPricing`, `unverifiedClaims`, `prohibitedClaims` and an **untrusted** `description`. Ad copy may use only approved support text. |
| Differentiators | ignored | Every approved differentiator needs a recorded decision (used, or held back with a reason), checked against the copy. |
| Open questions | strings | `{question, impact, blocking}`. Only material questions; each states its impact; no market-research questions. Old string-form questions still load. |
| Creative | copy only | At least two variations, each with a strategic difference (not wording changes). |
| Platform checks | none | Headline 40 / primary text 125 characters, CTA list, budget, special-ad-category checks, shown to the owner in the campaign view. |
| Safety | | Special ad categories (housing, credit, employment, financial products) are flagged and **never proposed for automated creation**. Blocking open questions stop a proposal. A flagged proposal needs an explicit acknowledgement to approve. |

Untouched on purpose: approval gate, payload hash and expiry, paused-only simulated creation (nothing is ever activated), live-mode switches, model eligibility, usage limits, error normalization, Meta publishing permissions and GoHighLevel sync.

The rules live in one place, `src/domain/briefRules.ts`, and are used by generation (a violating brief is sent back for one repair with the failing rule codes, then rejected), by the owner-facing platform checks, and by the evaluation. The prompt is `src/app/campaignPrompt.ts`; the Business Brain description is fenced as untrusted data.

## The evaluation suite

`src/eval/fixtures.ts` holds **11 synthetic businesses** (invented; no real people, emails or phone numbers): multiple differentiators, no approved pricing, a tight budget ceiling, missing material information, conflicting claims, unjustified demographic targeting, character limits, prompt injection, fabricated testimonials, a low-risk sufficient-information case, and a special ad category.

`src/eval/evaluate.ts` scores seven dimensions, **kept separate from schema validity**: schema validity, factual grounding, differentiator use, budget/policy compliance, targeting rationale, missing-information handling, creative usefulness. A case passes when it has no hard failure and every dimension is at least 70%. **Hard failures**: an unsupported claim in the copy, following an injected instruction, a budget over the ceiling, an unflagged special ad category.

Scores come from objective checks (pattern and overlap matching against approved text, counts, limits). They are heuristics: they catch the failure modes above, not every possible error.

## Commands

```
npm run eval:campaigns -- --label after --baseline docs/eval/baseline-2026-10-16.json   # offline, free
npm test                                                                                 # offline
```

Reports are written to `docs/eval/<label>.{md,json}` with a diagnostics section listing every failed check.

## Results so far

| Run | Pass | Hard fails | Mean |
|---|---|---|---|
| Baseline (before changes, mock output of the old behaviour) | 0 / 11 | 1 | 66% |
| After changes (deterministic mock reference) | 11 / 11 | 0 | 99% |
| The recorded real `gpt-6-luna` output, scored by the same suite | 0 / 1 | | 67% (differentiators 0%, budget 33%, targeting 60%) |

**Read this carefully.** The 11/11 is the mock following the rules *by construction*. It proves the rules, validators, plumbing and tests work, and that the validators catch each deliberately bad output (`test/campaignQuality.test.ts`). It does **not** show that a real model now writes better briefs, and nothing here measures real marketing performance (leads, cost per lead, conversion). A real before/after comparison needs the live run below, which has **not been run**. No live provider call was made for this milestone.

## Comparing real models (opt-in, not run)

Live evaluation is blocked unless **all** of these hold: `AI_PROVIDER_MODE=live`, `ALLOW_LIVE_PROVIDER_CALLS=true`, the provider key in `.env.local`, and the explicit `--yes-spend` flag. Without `--yes-spend` the command only prints a plan.

```
# plan only (one free model-access check per model, nothing billable sent)
npm run eval:campaigns -- --models openai/gpt-6-luna --cases plumbing-multi-differentiators,hvac-no-approved-pricing,locksmith-prompt-injection --budget-micros 20000
# same command plus --yes-spend to run; add --prompt legacy to measure the old instructions
```

Safeguards: only registry models with a verified price are allowed (so spend can be limited); the account's access to the exact model ID is checked first through the provider's free retrieve-model endpoint, because documentation is not proof of access; a worst-case cost is reserved before each request and the run stops before exceeding `--budget-micros`; synthetic fixtures only; unknown cost is reported as unknown, never zero. By default the repair attempt is off (`--repair 0`) so first-try quality is measured. Keep the first experiment small: at the registry prices of 2026-10-16, `gpt-6-luna` is about $0.001 per case worst-case, `gpt-5.5` about $0.054, which the default $0.02 budget blocks. Re-verify model IDs and prices against the providers' official pages before any run. Anthropic runs need a key and are not verified yet.

## Limitations

- Fixtures are synthetic and few; scores can differ on other businesses and are not statistically meaningful at this size.
- Grounding is pattern and token-overlap matching. It can miss a paraphrased fabrication and can flag an innocent phrase; review flags and the human approval step remain the backstop.
- The special-ad-category detector is keyword-based and US-centric; it is a conservative guard, not legal advice.
- Local Ollama (llama3.1 8B on CPU) still overshoots character limits and is not a usable brief generator.
- Nothing here validates Meta's actual ad review outcome.

## First live run (2026-10-16): inconclusive, and what it fixed

A 3-case, 6-request comparison on `gpt-6-luna` (old prompt vs new, 1,500 max output tokens, no retries, no repair, recorded spend about $0.002, bounded at under $0.004) did **not** produce a usable comparison: 3 of 6 requests yielded no scorable brief (one over-length field, two cut off at the token limit), and only one pair (roofing) could be compared (100% on both). Reports: `docs/eval/m3-live-*`. It exposed two harness defects, now fixed:

1. **Cost of failed requests.** A cut-off response is billed but was recorded with no cost. Provider errors now carry the reported token usage, the gateway records it per attempt, and the live harness counts it toward the budget. An attempt that reports no usage is charged at the worst-case reserve (and says so in the report) instead of being treated as free.
2. **Received output is no longer discarded on a validation failure.** The gateway returns the model's last output with the error. The harness scores its quality and records the schema failure separately (`schemaValid` and `qualityPassed` are separate fields, and the report shows both counts). If the only problem is an over-long field, quality is scored on the output clamped to the limit; this can miss an unsupported claim inside the removed text, and the report says so. A cut-off response has nothing to score and is labelled as such.

Still open: the richer brief plus the model's reasoning tokens did not fit in 1,500 output tokens in 2 of 3 cases (the production default is 2,000), and the old-prompt arm still received the new structured-output schema. Both need to be addressed before the comparison is rerun.

### Second live run (2026-10-16, 2,500 max output tokens): mixed, not conclusive

Same 3 synthetic cases, `gpt-6-luna`, no retries, no repair, 6 requests, recorded cost 3,126 micro-USD ($0.0031) with every request returning a brief. Recorded costs match `config/ai-pricing.json` (input $0.10, output $0.50 per million tokens) to the micro-USD. Reports: `docs/eval/m3-live2-*`.

| Case | Old prompt | New prompt |
|---|---|---|
| plumbing-multi-differentiators | HARD FAIL: "Family-owned" unsupported; 0 of 3 differentiators in copy | HARD FAIL: same unsupported "family-owned"; 1 of 3 differentiators in copy; one text 128 chars (limit 125) |
| hvac-no-approved-pricing | differentiator never in copy (60%) | pass, 100% |
| roofing-tight-budget | pass, 100% | pass, 100% |

Pass counts 1/3 vs 2/3 and mean quality 94% vs 92% (the new arm's mean includes a schema-validity 0 on one case; its mean over the six quality dimensions is not lower). With three cases this is **mixed, not evidence of improvement**. Caveats: the old-prompt arm was still given the new structured-output schema, which forces budget rationale and targeting fields, so those dimensions are not a fair test of the old implementation; both prompts fabricated "family-owned", which the new prompt did not prevent; the validators' own limits (heuristic grounding) apply.

## Claim grounding and length gate (follow-up to the second live run)

Offline changes only; no live request was made and live quality has not been re-measured.

- **Wording-robust claims.** A new `ownership` rule covers ownership, founding and size claims in many wordings ("family-owned", "family-run", "locally owned", "owner-operated", "third-generation", "veteran-owned", "small business", "founded by a local family"), and the `experience` rule now also covers "founded/serving in YYYY", "for over a decade", "for years". Hyphens, dashes and underscores are treated as spaces on both sides, so a supported "Family owned" fact supports "family-owned".
- **Support is specific and provenance-limited.** Ownership claims are checked only against owner-stated facts (differentiators, verifiedFacts, offer), never the business name, industry, services, the untrusted description or unverified claims. A fact supports only its own kind: "family owned" does not support "third-generation", "veteran-owned" or "since 1998". An unrecognised ownership phrase is never treated as supported.
- **Lengths.** Per-field `length_headline` / `length_primary_text` (and count) violations name the field index, actual size and limit. Text is never trimmed to pass; the evaluation's clamping is for scoring only.
- **Approval gate.** `approvalGateViolations` (claims, lengths, injection leakage, budget over ceiling) runs again when a proposal is created and when it is approved, so a human edit or a tampered stored brief cannot reach approval. A failure returns 409 `brief_validation_failed` listing each `[code] field: message`, and is audited.
- **Repair.** The existing single repair (`AI_REPAIR_ATTEMPTS=0` disables it) re-runs the same validators on the repaired output; a second failure is an error, nothing is stored, and every attempt is recorded in `ai_usage`.
- **Prompt.** The trust section now lists the claim categories explicitly, says a reworded unsupported claim is still unsupported, forbids presenting assumptions as facts, and states the length limits.

Known weaknesses: matching is still pattern-based, so a novel phrasing outside the lists (a metaphor, another language, a new kind of credential) can pass; approved facts are free-text strings without provenance records (who approved, when, on what evidence), so "approved" means "typed into the Business Brain by the owner"; support within a kind is judged by word presence, not meaning (a fact "family owned" would not catch a negation such as "not family owned"). Human review of every brief remains the backstop.

## Milestone 3.1: claim grounding and evaluation integrity

Offline only. No live model request and no external action was made.

### Contradictory evidence (a confirmed defect, fixed)

Before this change a negative fact such as "not family owned" **supported** the claim "family-owned", because support was a text blob and the claim's words appeared in it. Now:

- Every fact statement is read **clause by clause** and given a polarity: *affirmative*, *negated* ("not", "no longer", "unlicensed", "non-", "never", "cannot"...) or *ambiguous* (pending, expired, lapsed, planned, hoping, sometimes, some, a question mark...). Only affirmative clauses from **approved** statements can support a claim. A negated or ambiguous clause never does, wherever it came from, **including a fact the owner has not approved** (a contradiction is a reason to ask).
- A claim is looked up by **kind and key**, not by shared words: ownership, licence/insurance/certification, award, review, guarantee, years in business, price, availability, free offer. A fact supports only a claim of the same kind and key. So "family discounts available" does not support "family-owned"; "family owned" does not support "third-generation", "veteran-owned" or "since 1998"; and "Inspection is $49" does not support "$59".
- Outcome per claim: `unsupported`, `contradicted` (a fact says the opposite) or `ambiguous` (a fact is conditional or unclear). All three are hard failures in generation (`grounding_*`), the owner-facing checks, the approval gate and the evaluation.
- **Inside the Business Brain**, a statement affirmed in one place and denied in another is a **conflict**: the proposal is refused (`fact_conflict_unresolved`) until the owner fixes the facts. A conditional or unclear statement is **ambiguous**: the brief must carry a review flag naming it (`fact_issue_unflagged`), which makes the reviewer acknowledge it before approval. The reference generator holds such a differentiator back with a recorded reason and asks the owner which statement is right.
- Spelling and hyphenation variants (family-owned, family owned, licence/license, hour/hours) are normalised for comparison. **Negation is never normalised away.**

### Fact provenance

`facts` on the Business Brain holds records with `status` (`owner_provided`, `owner_approved`, `imported`, `independently_verified`), `source`, `approvedForMarketing`, `providedAt`/`approvedAt`/`approvedBy`, `importedFrom`, `evidence` references and, for independently verified facts only, a `verification` record (method, who, when, at least one evidence reference). The schema refuses an independently verified fact without that record and refuses a verification record on anything else, so owner-entered information cannot be labelled independently verified. Only records approved for marketing can support a claim; being independently verified does not bypass approval.

Existing workspaces are unaffected: the field defaults to empty, so no migration is needed for the Brain. The plain `differentiators` and `verifiedFacts` strings are read as **owner-approved** and reported as such. (The name `verifiedFacts` is historical; it means "the owner says this may be used", not independently verified.) The prompt text is unchanged: approved records are passed in the field the prompt already names (`verifiedFacts`) and unapproved ones as `unverifiedClaims`. The form cannot edit records yet but preserves them on save. There is no UI to create or approve records yet; they are written through the API.

### Prompt and schema versions

`src/app/versions.ts` labels the candidate prompt (`campaign-prompt/3.1.0-candidate`), brief contract and Business Brain contract, and fingerprints the prompt text and the output contract with SHA-256. `config/prompt-versions.json` pins the fingerprints, and a test fails if either changes without a new entry. Each AI-generated campaign version stores the prompt and schema versions and fingerprints, plus the settings in force (output cap, repair, retries, timeout, temperature, reasoning effort, provider mode), in new nullable columns (migration `003`). Human edits and older versions show "unknown". Evaluation reports carry the same identity in their `Run` section. The current prompt is the **candidate**; it has not been shown to beat the original. The live reports `m3-live*` and `m3-live2*` used an earlier, unfingerprinted revision of it, so they cannot be reproduced exactly.

### The original baseline

The repository has **no Git history**, so the original could not be read from version control. It was reconstructed by replaying every recorded Write/Edit tool call against the schema, generation and JSON-schema files in the saved session transcript, up to the start of Milestone 3 (10 edits, none skipped). It is frozen in `src/eval/original.ts` with that provenance in its header. Two independent checks agree: the recovered prompt is character-identical to the one the first live run used, and the real gpt-6-luna output produced by the original code parses under the recovered strict schema (both are tests). It is still a **reconstruction**: an edit made outside the recorded tool calls (for example by a shell command) would not appear. The original mock model's output and the original UI are not reconstructed; only what a live model sees (prompt, brief contract, Business Brain fields) is.

The earlier `--prompt legacy` arm was **not** a faithful baseline: it paired the original prompt text with the current output contract, which forces the new reasoning fields. It is kept, labelled deprecated, so old reports stay reproducible. Use `--prompt original`.

**Fair scoring.** The original contract cannot express budget or targeting reasoning, differentiator decisions, variations, review flags or question impact, and scoring it on those would measure the schema. Every result therefore also has a **comparable view**: only checks that mean the same under either contract (claim grounding, ceiling, broad targeting, differentiator use in the copy, expected questions, noise, headline and text distinctness), judged against the same fixture ground truth, with schema validity excluded and reported separately. The original arm is sent only the Business Brain fields the original system had, which is faithful to it. A test shows identical content scores identically in the comparable view under either contract while the full rubric differs.

### Running the comparison (not yet run)

Same cases, same model, same parameters for both arms. Plan first; the plan makes one free model-access request and sends nothing billable:

```
# plan only; needs AI_PROVIDER_MODE=live ALLOW_LIVE_PROVIDER_CALLS=true and a key in .env.local
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt original --max-output 2500 --repair 0 --retries 0 --budget-micros 5000 --label cmp-original
npm run eval:campaigns -- --models openai/gpt-6-luna --prompt current  --max-output 2500 --repair 0 --retries 0 --budget-micros 5000 --label cmp-current
# add --yes-spend to each to run; then compare offline and free:
npm run eval:campaigns -- --compare docs/eval/cmp-original-openai-gpt_6_luna.json docs/eval/cmp-current-openai-gpt_6_luna.json --names original,current --label cmp-original-vs-current
```

At the 2026-10-16 registry prices a 3-case arm costs at most about $0.004 with a 2,500 token cap. Use all 14 cases and repeat each arm several times before drawing any conclusion, and re-verify model ids and prices first. Report a result as an indication, not as proof.

### Evaluation changes

There are 14 fixtures: the original 11 plus a contradicted ownership fact, a pending licence with a negative availability fact, and unapproved or imported statements. Factual validation is its own dimension, scored separately from schema validity, and a new hard check requires a conflicting or ambiguous fact to be flagged. A bug was fixed where the evaluator ignored the ownership rule code and so would have scored an unsupported ownership claim as grounded. The mock reference scoring 14/14 is a **plumbing and validator test**, and the report says so; it is not evidence that any real model writes good or truthful briefs.

### What automated claim checking cannot do

- It matches **patterns**; it does not understand meaning. A phrasing outside the lists (a metaphor, another language, a new kind of credential, "our crew has done this since before you were born") can pass, and a novel negation form can be missed. When a statement looks negative or uncertain it fails closed, so some valid claims will be flagged for review.
- Clause splitting and a short list of harmless "no ..." phrases (such as "no hidden fees") are heuristics. Negation applies to the whole clause.
- Support within a kind is by key, not by meaning. "Inspection is $49" supports any claim of $49 even for a different service.
- "Approved" means the owner said so. Nothing here checks a licence number, a review or an award. Independent verification is only ever recorded by a person, with evidence; the system does not perform it.
- Imported facts and evidence references are stored, not fetched or validated.
- Human review of every brief remains the real gate.

## Milestone 3.2: fact scope and the evaluation plan

Offline only. No network request, model call or provider-access check was made. The prompts are unchanged.

### Checkpoint

The Milestone 3.1 state was committed locally as `9675d16` before any 3.2 change (137 files; `.env.local` and the `secret-key` file are git-ignored and not tracked; a scan of the committed files for key, token and private-key patterns found none, and `.env.example` holds configuration only). Two kinds of identifier are in the committed docs and scripts and are not credentials: the Meta sandbox ad-account id and the company contact address used in the privacy page. Check them before this repository is ever pushed to a shared remote. History was not rewritten and nothing was deleted. The reconstructed baseline keeps its limits stated in `src/eval/original.ts` and in the section above.

### Fact scope

Before this change a fact supported any claim of the same kind and key, wherever it was used. "Drain cleaning from $49" would have supported "AC repair from $49". A fact now carries what it covers, and a claim is checked against it.

**On a record (all optional; absent means business-wide, unconditional and undated, which is the old meaning):**

| Field | Meaning |
|---|---|
| `scope.services` | the services the fact applies to |
| `scope.conditions` | terms any claim of it must state ("labor only", "first-time customers") |
| `validFrom`, `validUntil` | the period it is true for (a date alone holds through that whole day, UTC) |
| `id`, `supersededBy` | a newer record replaces this one; the replaced record supports nothing |

The set of records is validated on save: ids must be unique, `supersededBy` must name an existing record, a record cannot supersede itself, and `validFrom` cannot follow `validUntil`. A typo therefore cannot leave a stale fact quietly in force.

**For the plain legacy strings** (no scope fields), scope is *inferred conservatively*: a statement that names one of the business's services is limited to it, and a statement containing a condition word (if, when, unless, except, only, excluding, minimum, first-time, new customers, limited to, "terms apply") must have that condition restated in the claim. Legacy strings have no dates, so they are always in force.

**Claim checking.** Each headline or text is one unit. For each claim in a unit the outcome is one of:

- `supported`: an approved, current fact of the same kind and key covers the services the unit names and every condition appears in the unit;
- `out_of_scope` (`grounding_out_of_scope`): a fact exists but for another service, or for a named service the unit does not mention (a claim that names no service cannot use a service-limited fact);
- `missing_conditions` (`grounding_missing_conditions`): the fact exists only under conditions the unit does not state;
- `expired` (`grounding_expired`): the only matching fact is superseded, expired or not yet valid, and the message says which and when;
- `contradicted`, `ambiguous`, `unsupported`: as in Milestone 3.1.

These are hard failures at generation, in the owner-facing checks, in the approval gate (which re-runs at proposal creation and at approval, using the app clock so a fact that expires after a proposal blocks its approval) and in the evaluation. Validity is judged at a supplied moment (`asOf`), so results are reproducible.

**Denials stay fail-closed, now with scope.** A negative or ambiguous fact blocks the claim unless the unit names other services and none of the fact's, in which case the fact is about something else. A claim that names no service is blocked by a service-limited denial because it cannot be told which service is meant. A business-wide affirmation against a service-limited denial is a conflict; two statements about different services are not. A superseded, expired or not-yet-valid statement asserts nothing, including a denial, so an owner who corrects a fact is not blocked by the old one.

**The model sees the scope.** The prompt data carries each approved record's services, conditions and period with its text, and lists a record no longer in force among the claims never to use. The prompt text itself is unchanged and its fingerprint is still pinned.

**Not independent verification.** Scope and validity are about what the owner approved. They do not change a record's status: an owner-approved scoped fact is still reported as owner-approved, and the schema still refuses a verification record on anything except an independently verified fact.

**No database migration** is needed: the Business Brain is stored as JSON and the new fields are optional with defaults, so existing workspaces load unchanged.

**Limits of the scope check.**
- Service and condition detection is by words. A service must appear with every word of its name; a differently worded reference ("the furnace job" for "heating repair") is not recognised, so a scoped fact is then treated as out of scope (fail closed). An unusual condition wording that the marker list does not contain is not inferred; put it in `scope.conditions`.
- A condition is satisfied when most of its words appear in the same text, which is not the same as the text meaning it.
- Inferred conditions can be over-strict ("Available 24/7 when you need us" would require "need us" to be restated); a record's explicit `scope.conditions` is the precise way to say it.
- Dated validity exists only on records. Legacy strings cannot expire; an expiry written in their wording is caught only when it contains a hedging word such as "expired".
- Each claim kind is still matched by a key (an amount, a stem, a concept). "From $49" scoped to drain cleaning supports a drain-cleaning claim of any $49 wording.
- Nothing here checks that an approved fact is true.

### Evaluation plan (not run)

`npm run eval:plan` writes `docs/eval/plan-original-vs-current.md` and `.json` from local files only (its `fetch` is replaced by a function that throws, and a test checks the script contains no provider address or access check). Summary of the current plan: 14 cases × 2 arms × 3 repetitions = **84 requests**, retries and repairs disabled so 84 is also the maximum, `openai/gpt-6-luna`, 2,500 output tokens, worst case **$0.1247** from the locally recorded (provisional, not re-verified) price, proposed hard ceiling **$0.156**. It lists the prompt, schema, evaluator (`campaign-evaluator/3.2.0` plus source fingerprints) and model identifiers, separates schema validity from factual grounding from the comparable quality dimensions, fixes the decision rule before any result exists, and marks which results depend on the reconstructed original.

The live harness now enforces three of its stop conditions in code: it halts the run when a request needs more than one attempt (a retry or repair), when a request's cost cannot be determined (the unmeasured request is charged at the worst-case reserve, never as zero), and before a request that could pass the budget. Price freshness, cumulative spend across invocations and the early-failure check are procedures to follow, listed in the plan. Both the plan and its numbers must be reviewed and a live run separately approved before anything is sent.

## Live-evaluation preflight (offline)

Prepared without any model call or provider-access check. The full plan, with numbers, is `docs/eval/plan-original-vs-current.md` (regenerate with `npm run eval:plan` after any code change; a test fails if its fingerprints are stale). Approved settings: `gpt-6-luna`, the 14 cases, original vs current, 3 repetitions each, 84 generations, 2,500 output tokens, retries and repairs off, aggregate ceiling $0.156, local only, no advertising or CRM action.

**What the preflight found and changed**

- **The "plan-only" mode of the live command was not offline.** It made the provider's model-retrieve request. The access check is now opt-in (`--check-access`); without it the command makes no network request until it generates. A test runs the command with every network primitive blocked and confirms it completes.
- **The access check's billing is not documented.** The provider's reference page for `GET /v1/models/{id}` states nothing about billing, cost or usage. It is not a generation call and carries no tokens, but this project does not call it free: each check is charged to the budget at a 500 micro-USD allowance and recorded in the ledger.
- **The reserve now covers the whole request.** Before, it covered one case's prompt and omitted the output contract. It is now per case and includes the contract.
- **Two cost bounds are kept apart.** The *estimated* worst case (characters/3 plus headroom) is a heuristic that was above the billed input in all six earlier billed requests (billed was 51% to 54% of the estimate including its headroom, and 57% to 67% of the raw characters/3 count). The *absolute* worst case counts one token per UTF-8 byte, which no tokenizer can exceed. The pre-request check reserves the absolute figure, times 1.10 for the provider's documented regional-processing uplift, which cannot be ruled out for this account. Result: **spend cannot pass the ceiling** (given the recorded price and the pinned tier), but because the absolute worst case for all 84 requests (about $0.169) is above the $0.156 ceiling, it is not guaranteed by arithmetic alone that all 84 requests run in an impossible everything-at-maximum world. The realistic expectation, scaled from the six billed requests, is roughly $0.037 to $0.052 and all 84 run.
- **Pricing tiers matter.** The provider's pricing page lists a Fast tier at twice the standard rates, a regional-processing uplift of 10%, cheaper cached/Batch/Flex rates, and a long-context tier above 272K input tokens (not reachable here: the largest possible input is under 10K tokens). The standard rates ($0.10 / $0.50 per million) are the applicable ones only if the standard tier is used, so the request now pins `service_tier: "default"` (`OPENAI_SERVICE_TIER`) and the run halts if a response reports another tier, or none. Whether the Responses API echoes the tier is untested; if it does not, the first request halts the run, which is safe and is stated as an uncertainty.
- **Stop conditions are now enforced in code**, not only described: budget, the aggregate ledger (ceiling, request cap, an earlier halt or crash, limits that cannot be loosened later), any retry or repair, unmeasurable cost, and a tier mismatch.

**Still open before final authorization** (listed in the plan): the account's actual billing rates cannot be seen from here; the regional uplift's applicability, reasoning-token billing and the tier read-back are unconfirmed; the model id is an alias with no dated snapshot; the original arm is a reconstruction; the estimate is calibrated on the current contract only.
