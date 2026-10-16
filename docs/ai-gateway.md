# AI gateway (Milestone 2)

One gateway, many providers. Campaign generation (and any future AI task) goes through it; nothing calls a
provider directly.

```
runAiTask (src/app/aiService.ts)        workspace settings, routing, usage limits, usage records, fallback
   |-- route()  (src/ai/router.ts)      pure, deterministic eligibility + selection
   `-- AiGateway (src/ai/gateway.ts)    retries, timeout, cancellation, repair, schema validation, latency, cost
         |-- MockAiProvider             deterministic, offline, always "simulated"
         |-- OpenAIProvider             official `openai` SDK, Responses API
         |-- OllamaProvider             the same adapter pointed at Ollama on this machine (/v1/responses), loopback only
         `-- AnthropicProvider          official `@anthropic-ai/sdk`, Messages API (native structured output)
```

The gateway **generates**. It never authorizes or executes anything: no proposal, approval, ad-platform or CRM
action can be triggered by a model response (covered by tests).

## Modes

| `AI_PROVIDER_MODE` | Eligible providers | Cost | Needs |
|---|---|---|---|
| `mock` (default) | the deterministic simulated model | none; `not_applicable` | nothing |
| `local` | Ollama on this machine only | none; `local_no_charge` | Ollama running; no key |
| `live` | OpenAI and Anthropic only | billed; estimated from the price file | `ALLOW_LIVE_PROVIDER_CALLS=true` and a key |

Each mode makes exactly one kind of provider eligible; kinds are never mixed. `OLLAMA_BASE_URL` must be loopback: a remote host would
mean data leaving the machine under a "local" label, so it stops the app at startup. Local requests are not billable, so usage limits do not apply to them.
Ollama silently truncates prompts beyond its served context window, so a model with `contextTokens` configured refuses an oversized request instead.

Live (paid) AI needs **both** `AI_PROVIDER_MODE=live` and `ALLOW_LIVE_PROVIDER_CALLS=true`; `live` without the second
switch is a startup error, and the allow flag alone does nothing. API keys are read **only** in live mode, so keys
sitting in your environment never cause a real provider to be selected. In mock mode real providers are not
eligible even if requested explicitly; in live mode the mock provider is not eligible (no silent mixing).

## Request/response contract

`AiProvider` (`src/ai/types.ts`): `id`, `label`, `models`, `simulated`, `isAvailable()`, `generateObject()`,
`generateText()`. Adapters return raw results; the **gateway** validates against the caller's zod schema and
returns a `GatewayResult`: `provider`, `model`, `simulated`, `text` / `structuredOutput`, `usage`
(`inputTokens`, `outputTokens`, `source: provider|simulated`), `latencyMs`, `requestId`, `status`,
`estimatedCostMicros`, `costStatus`, and every `attempt` (retry/repair) with its own outcome.

Unknown is not zero: missing token counts are `undefined` (stored as `NULL`), and cost is `null` with a
`costStatus` of `unknown_no_pricing` or `unknown_no_usage`. Simulated results are `not_applicable`.

## Errors (normalized, no secrets, no provider message text)

`auth`, `insufficient_balance`, `rate_limit`, `timeout`, `provider_unavailable`, `invalid_request`,
`invalid_output`, `cancelled`, `budget_exhausted`, `budget_unverifiable`, `not_eligible`, `live_disabled`,
`unknown_provider`, `unknown_model`. Only `rate_limit`, `timeout` and `provider_unavailable` are retried or
eligible for fallback. Error messages are built from HTTP status and error type only; provider message text is
never copied because it can echo prompt content.

## Routing

* **manual**: exactly the chosen model; no fallback.
* **automatic**: lowest `costTier`, then provider id, then model id. Deterministic; no fallback.
* **preferred_with_fallback**: preferred first; one configured fallback used only after a fallback-eligible error.

Eligibility is checked **before** selection: enabled in the registry, task supported, structured-output
capability, provider available, mode (mock vs live), and the workspace **data-policy allow-list**. A fallback that
the policy forbids is never routed to. No fallback happens for `auth`, `insufficient_balance`, budget errors,
`invalid_request` or `invalid_output`.

## Usage, cost and limits

Every provider attempt (including retries, repairs, fallbacks and blocked requests) is one row in `ai_usage`
(metadata only: never prompts, business data or response bodies). Limits are per workspace and enforced
**before** any billable (live) request: `max_requests_per_day` and `monthly_budget_micros`. A monthly budget cannot be
verified for a model with no configured price, so such a request is refused (`budget_unverifiable`) rather than guessed.
Mock requests are never billable and never blocked.

Pricing lives in `config/ai-pricing.json`: only entries read from the providers' official pages (with source URL and date) are present, including long-context tiers; a model without an entry has an unknown cost. See [ai-verification.md](ai-verification.md).

## Adding a provider (e.g. Meta Llama)

1. Implement `AiProvider` (copy `src/ai/openaiProvider.ts`). Map its errors with `mapSdkError`, return raw JSON
   plus provider-reported `usage` and `requestId`, and honor `signal`.
2. Add its models to `config/ai-models.json` with `tasks`, `capabilities` and `costTier`.
3. Register it in `buildContext` (`src/app/context.ts`), reading its key only when live AI is enabled.
4. Add prices to `config/ai-pricing.json` if you want cost estimates.
5. Run it through the shared contract in `test/ai.test.ts` and the adapter tests in `test/aiProviders.test.ts`.

Meta's advertising developer app does **not** provide Llama inference. Llama models are available here **locally**, through
Ollama in `local` mode (`llama3.1:latest`, an 8B Llama model, is what the dev PC has installed). Any other model Ollama serves
works the same way: `ollama pull <name>`, then add an `ollama` entry to `config/ai-models.json` (with `timeoutMs`, `temperature`
and `contextTokens`). Hosted Llama inference from a third party is not built; it would need an explicitly chosen provider and its own mode.
