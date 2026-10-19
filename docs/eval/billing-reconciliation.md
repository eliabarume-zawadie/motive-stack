# Billing reconciliation for the campaign comparison

**Status: UNRESOLVED.** Nothing here has been reconciled against the provider's billing. This file records what is known and what is not, so that no one mistakes the ledger for an invoice.

## What was observed

- The provider dashboard showed **$0.01** for the daily window (2026-10-16).
- The exported CSV aggregates usage across **31 requests** for that window, not per invocation, so invocation-level billing cannot be isolated from it.
- The experiment ledger (`docs/eval/ledger-cmp-3-2.json`) records, from provider-reported token usage and the recorded price ($0.10 / $0.50 per million tokens, standard tier):
  - `cmp-3-2-original-rep1`: 14 requests, 8,087 input and 2,626 output tokens, **2,122 micro-USD**.
  - `cmp-3-2-current-rep1`: 14 requests, 27,663 input and 9,046 output tokens, **7,290 micro-USD**.
  - Committed 9,412 of 156,000 micro-USD, 28 of 56 requests.

## Why it is only "consistent", not reconciled

The requests made on that date, from the committed evidence: 6 in the first live comparison (`m3-live`), 6 in the second (`m3-live2`), 1 service-tier diagnostic, 14 in invocation 1, and (not in the evaluation evidence) the 4-request live verification run, of which one was a deliberately invalid-credential request that is not expected to be billed, and one earlier ad-hoc campaign run. That adds up to about 31 billed requests before invocation 2, which matches the CSV's 31, but this is arithmetic on my own records, not a match against the provider's line items.

The recorded costs of those requests sum to roughly 0.007 to 0.010 USD (including up to about 0.002 USD of cut-off requests whose cost was not recorded and the verification run's larger-model requests). A dashboard figure of $0.01 is consistent with that. It is also consistent with other totals, because the dashboard's granularity and rounding are not known. It does **not** confirm the ledger's per-invocation figures.

## What would reconcile it

- **Invocation 2 onward** record the server request id of every request (`docs/eval/cmp-3-2-current-rep1-openai-gpt_6_luna.md`, "Provider evidence per request"). If the provider's usage export lists request ids, match them one for one and compare tokens and cost per request.
- **Invocation 1 and earlier** recorded no request ids, so they can be matched only by time window (invocation 1 ran 13:54:24 to 13:55:02 UTC) and by totals (14 requests, 8,087 input and 2,626 output tokens).
- Until a person has done this, the ledger remains an estimate from reported usage and a recorded price. The conservative reserves and the aggregate ceiling are the protection, not this reconciliation.

## Assumptions not confirmed by billing

The standard service tier (every returned response said `default`), the absence of a regional-processing uplift, and the recorded rates. Each response reported tier `default`, which is evidence about how the request was served, not about what was charged.
