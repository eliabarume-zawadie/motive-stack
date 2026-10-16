# AI provider verification (Milestone 2.1)

Last updated 2026-10-16. This page separates **what was checked against official documentation**, **what was tested
offline or against a stub**, and **what has been verified against a real provider**. Only the last category is proof
that a live integration works, and it is currently **empty**: see "Live verification status".

## 1. Model IDs and prices (read from official pages on 2026-10-16)

Nothing here is copied from retired models. If a price changes, `config/ai-pricing.json` is wrong until re-verified.

| Provider | Model ID | Lifecycle (source) | Standard price per 1M tokens, input / output | Pricing source |
|---|---|---|---|---|
| Anthropic | `claude-haiku-5-5` | Active; retirement not sooner than Oct 7 2027 ([deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $0.10 / $0.50 for prompts up to 100,000 tokens; **$0.50 / $2.50 above 100,000** | [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Anthropic | `claude-sonnet-5-5` | Active; not sooner than Sep 28 2027 | $2 / $10 (full 1M context at standard pricing) | same |
| Anthropic | `claude-opus-5-5` | Active; not sooner than Sep 22 2027 | $4 / $20 (full 1M context at standard pricing) | same |
| OpenAI | `gpt-6-luna` | Current (listed on the [models page](https://developers.openai.com/api/docs/models)); Responses API supported; `structured_outputs` listed | $0.10 / $0.50 up to 272K input tokens; **above 272K: 2x input, 1.5x output for the whole request** | [pricing](https://developers.openai.com/api/docs/pricing) |
| OpenAI | `gpt-5.5` | Current; default snapshot `gpt-5.5-2026-04-23`; Responses API supported; `structured_outputs` listed; no deprecation notice | $5 / $30 up to 272K input tokens; above 272K: $10 / $45 | same |

Prices assume **standard synchronous requests, global/default routing, no prompt caching, no batch/flex/priority tier**.
These change the price and are deliberately *not* modelled: Anthropic US-only `inference_geo` (1.1x), batch (50% off), cache reads/writes;
OpenAI batch/flex ($2.50 / $15 for gpt-5.5), fast/priority, regional processing (+10%), cached input. Reasoning/thinking tokens bill as output.

### Parameters checked against the docs

| Setting used by the adapters | Anthropic | OpenAI |
|---|---|---|
| Native structured output | `output_config.format = {type: "json_schema", schema}` on Haiku/Sonnet/Opus 5.5; schemas must set `additionalProperties:false` and may not use `minLength/maxLength/maxItems/minimum/maximum` (the app's schema uses none; a test enforces it) | `text.format = {type:"json_schema", name, strict:true, schema}` on the Responses API |
| Bounding hidden reasoning | `output_config.effort` (`low` supported on Haiku 5.5, Sonnet 5.5, Opus 5.5). Thinking counts toward `max_tokens` | `reasoning: {effort}` (`none` is supported on `gpt-6-luna` and `gpt-5.5`). Reasoning tokens count toward `max_output_tokens`; too small a budget returns `status: incomplete` |
| Output cap | `max_tokens` | `max_output_tokens` |
| Request id | `_request_id` | `_request_id` (`x-request-id`) |

**Not confirmed from the docs I could read:** OpenAI's model pages list `structured_outputs` but do not name `json_schema` per
model, and the strict-mode keyword limits were truncated; Anthropic's pages do not state how `output_config.effort` interacts with
`output_config.format` in a single request. The adapters send both, and the live test is what will confirm it. If a provider
rejects the combination, the live run will show it and the adapter must be corrected (with a mocked regression test).

## 2. What changed because of this verification

* `config/ai-pricing.json` now holds **verified** entries (source URL, `asOf`, stated scope). Every rate must be positive: a `0` is rejected, so a typo cannot make a model look free.
* The estimator understands the **long-context tiers** above. Previously a 200K-token Haiku prompt would have been priced at the base rate (5x too low).
* `config/ai-models.json`: added `gpt-6-luna`; every real model has a `reasoningEffort`; IDs marked "verified against docs, not yet exercised live".
* Adapters send the configured effort; a central `AI_MAX_OUTPUT_TOKENS` ceiling (default 2000) clamps every request.
* UI: the usage summary no longer shows "0.0000 USD" when every live request has an unknown cost (it says unknown). Found by the DOM test.

## 3. UI verification

No browser tooling (built-in browser or the Chrome extension) was available in this session, so **no real-browser test was run**.
Instead `test/ui.dom.test.ts` loads the real `index.html`, `app.js` and `ai.js` into jsdom, routes the page's `fetch()` to the real
server code through `inject()` (no network), and drives the screen by filling forms and clicking buttons (10 tests). It does **not** cover layout,
CSS, focus/keyboard behavior or real event timing. Do a visual pass in a browser yourself: `npm start`, open http://localhost:3000.

## 4. Live verification status

| Provider | Model | Status | Evidence |
|---|---|---|---|
| OpenAI | `gpt-6-luna`, `gpt-5.5` | **VERIFIED live, 2026-10-16** (13/13 checks, `verifiedAgainstRealProvider: true`) | `docs/live-verification/openai-2026-10-16T09-40-30-398Z.json` |
| Anthropic | `claude-haiku-5-5`, `claude-sonnet-5-5` | **PENDING** | none |

### OpenAI: what the real run showed (2026-10-16)
* The key (a project key) was accepted; `gpt-6-luna` and `gpt-5.5` were both listed for the account.
* One small structured request through the app's gateway succeeded and passed the app's zod schema: `gpt-6-luna`, 93 input / 17 output tokens, 3.6 s, provider request id recorded, estimated cost 18 micro-USD.
* The cost estimate equals an independent calculation from the provider-reported usage and the price file (`gpt-6-luna` 18, `gpt-5.5` 975 micro-USD). Prices are the ones verified on 2026-10-16 (section 1).
* **Multi-model:** `gpt-6-luna` and `gpt-5.5` both served requests through the same gateway; each was priced from its own entry and attributed to the model that served it in the usage log.
* A real response that violated the app's schema was rejected, with nothing returned (repair disabled for that check).
* The daily-request and monthly-budget limits stopped a request **before** it was sent (the provider request count did not change).
* A deliberately invalid key produced a normalized `auth` error from OpenAI's real 401 and did **not** fall back to another provider; the error text did not contain the key.
* Total spend: about **$0.0011** (4 billable requests, under the $0.05 cap). No key appears in the evidence file or anywhere in the repository.
* The native `text.format` JSON-schema request with `reasoning: {effort: "none"}` was accepted by both models, which settles the combination the docs did not state.

**Not shown by this run:** a real rate-limit (429) response, behavior on large prompts, quality of campaign briefs (the probe is "capital of France"), or any other OpenAI model.

### Anthropic: still pending
**Blocker:** no Anthropic key is present on this machine. Add `ANTHROPIC_API_KEY` to `.env.local` and run
`npm run live:preflight` then `npm run test:live:anthropic` (with the live switches set for the command). Until
`docs/live-verification/anthropic-*.json` exists, Anthropic is **not** verified, and the one thing the docs left open
(how `output_config.effort` combines with `output_config.format`) remains unconfirmed for it.

**What was run instead for Anthropic (clearly not provider verification):** the live test file was dry-run against a local stub that speaks the
OpenAI and Anthropic wire formats (`scripts/stub-provider.ts`): 13/13 checks passed through the real SDKs over real
HTTP. That validates the test's own logic and the adapters' HTTP handling. The evidence it produced is marked
`verifiedAgainstRealProvider: false`, written to a temp directory, and deleted.

## 5. How to run the real verification (one provider at a time)

1. Put the key in `.env.local` (git-ignored; never in chat, shell history or git), plus the two switches:
   ```
   AI_PROVIDER_MODE=live
   ALLOW_LIVE_PROVIDER_CALLS=true
   OPENAI_API_KEY=...          # or ANTHROPIC_API_KEY=...
   ```
2. `npm run live:preflight` must end with "Ready". It prints names and pass/fail only.
3. `npm run test:live:openai`, then separately `npm run test:live:anthropic`.

Each run uses a fixed non-sensitive prompt ("capital of France"), a hard budget (`LIVE_TEST_BUDGET_MICROS`, default 50,000 micro-USD = $0.05),
an output cap (`LIVE_TEST_MAX_OUTPUT_TOKENS`, default 400), at most 1 retry and no repair attempt. It checks, in order:

1. one structured request succeeds and passes the app's schema (provider, model, request id, usage, latency, cost recorded);
2. the cost estimate equals an independent calculation from the provider-reported usage and the price file;
3. a real response that violates the app's schema is rejected (this is the only other billable request);
4. the daily-request and monthly-budget limits stop a request **before** it is sent;
5. an authentication failure (deliberately invalid key, a free 401) is reported as `auth` and does **not** fall back to another provider.

On success it writes `docs/live-verification/<provider>-<time>.json` (no keys, no raw responses). That file is the evidence; until it
exists for a provider, that provider is **not** verified.

Not live-testable on demand: a real **rate-limit** (429) response. It is covered by mocked tests through the real SDKs (status, `retry-after`,
retry limits, no leak of the key) but has not been observed from a real provider.

## 6. Local model (Ollama) verification, measured 2026-10-16

Everything below ran on this PC against the real Ollama server: free, offline, no key, nothing left the machine.
Evidence files are in `docs/live-verification/` (their names say which conditions they were measured under).

**Environment:** Ollama 0.40.3, `llama3.1:latest` (8B, Q4_K_M, 4.9 GB), **CPU only** (Intel UHD 620, 0 GB VRAM), 15.8 GB RAM, served context 4096 tokens.

### What is verified (protocol and plumbing)
* `/v1/responses` works through the unmodified OpenAI SDK adapter: request shape, `text.format` JSON schema accepted, OpenAI-style `usage`, a response `id` (no request-id header), `reasoning.effort` accepted.
* The app's connection test makes a real request to the local model and reports it as connected, "no charge".
* Usage rows are recorded as `local`, `local_no_charge`, with provider-reported token counts.
* Speed: about 2-3 output tokens per second. One attempt takes roughly 1.5-2.5 minutes; first request after idle adds model load time.

### What is NOT achieved: valid campaign briefs from this model
| Run (all temperature 0) | Valid | Why it failed |
|---|---|---|
| Field limits not sent to the model (a bug, now fixed for every provider) | 0/5 | headlines up to 70 chars (limit 40), ad text 184 chars (limit 125) |
| Field limits sent, no repair | 0/5 | same violations: the model sees the limits and ignores them |
| Field limits sent, **one repair attempt** with specific size feedback | **0/3** | violations fall from 5 to 2 after repair (a headline at 41 chars, an ad text at 184), then it stops |

The one valid brief seen came from an earlier ad-hoc run at Ollama's default temperature (not repeatable evidence).
Conclusion: **an 8B model on this CPU does not reliably meet the product's character limits**, even with one repair attempt.
Its briefs are otherwise sensible (right budget, honest open questions). The limits are product rules and were not loosened to pass.

Defects this measurement found and fixed (each has a regression test): the human-readable field limits were not sent to the model
whenever native structured output was on (OpenAI and Anthropic adapters); repair feedback now states the actual size of each
over-limit string or list (sizes only, never the offending text).

### What this means
* Local mode is **working infrastructure** and a free way to exercise real-model plumbing end to end. It is **not yet a way to get usable campaign briefs** on this hardware.
* `npm run test:local:ollama` therefore **fails its 60% bar today, on purpose**. Do not lower the bar to make it pass.
* Options, none attempted: allow a second repair attempt for local models (about 6-7 minutes per brief); try a different or larger model; run on a machine with a GPU; keep using mock mode for development.
