# MotiveStack (local-first, phase 1)

AI marketing operating system for small local service businesses. This phase runs **entirely on your machine**:
no public domain, no deployment, no Meta App Review, and no provider credentials are needed.

Meta feasibility findings: [docs/meta-feasibility.md](docs/meta-feasibility.md) and [docs/meta-go-no-go.md](docs/meta-go-no-go.md).

## Quick start

Requires Node 22+ and npm.

```
npm install
npm run db:init        # create/upgrade the local SQLite database (./data/motivestack.db)
npm start              # web app + API + background worker on http://localhost:3000
```

Open http://localhost:3000. The server binds to `127.0.0.1` only.

| Task | Command |
|---|---|
| Install | `npm install` |
| Initialize / migrate the database | `npm run db:init` (safe to repeat; never drops data; `npm start` also applies pending migrations) |
| Start app + worker | `npm start` (`npm run dev` restarts on file changes) |
| Start the worker alone | `WORKER_IN_PROCESS=false` for the server, then `npm run worker` in another terminal |
| Run all tests (mock only, offline) | `npm test` |
| Type-check | `npm run typecheck` |
| Opt-in live read-only tests | `npm run test:live` (see "Live mode"; skipped unless fully opted in) |
| Reset local data | stop the app, delete the `data/` folder, run `npm run db:init` |

Optional settings: copy `.env.example` to `.env.local` (git-ignored). With no `.env.local` the app runs in mock mode.

## What the first vertical slice does

1. Create a **workspace** (you get an access token once; only its hash is stored).
2. Fill in and save the **Business Brain** (validated, versioned).
3. Pick an AI provider/model and **generate a campaign brief**. The model returns data only; the server validates it with a schema before storing campaign, version and assets.
4. **Propose** a paused campaign draft on the ad platform. Nothing external happens yet. A planned budget above the Business Brain cap is blocked.
5. **Approve or reject** explicitly. Approval queues a background job.
6. The worker re-checks every condition, creates the **PAUSED** draft on the simulated Meta, reads it back, and records the external ID and verified state. If the platform does not report `PAUSED`, the proposal goes to `needs_review`.
7. **Inject a synthetic lead**. It is stored once (duplicate event IDs are ignored) and synced to the simulated GoHighLevel, which deduplicates contacts by email, then phone.
8. The UI shows campaign state, proposal and attempts, leads and CRM sync, errors, and the activity history. Every simulated result is labelled **SIMULATED**.

## Integration modes

| Mode | When | Behavior |
|---|---|---|
| **mock** (default) | `INTEGRATION_MODE=mock` or unset | Meta, GoHighLevel and AI are simulated and persisted locally. No external calls, no spend, no messages. |
| **live** (opt-in) | `INTEGRATION_MODE=live` **and** a per-provider flag | Only the providers you switch on are real. |

- Meta live switch: `LIVE_META=true` (with `INTEGRATION_MODE=live`). `LIVE_GHL=true` is **rejected at startup**: there is no live GoHighLevel connector yet.
- **AI has its own two switches**: `AI_PROVIDER_MODE=live` **and** `ALLOW_LIVE_PROVIDER_CALLS=true`. Live without the second is a startup error; the second alone does nothing. See "AI models" below.
- Having credentials in the environment never enables live mode. API keys are only read when live AI is on.
- Live Meta needs `META_ACCESS_TOKEN`, the workspace's ad account (`PATCH /api/workspaces/:id {"metaAccountId":"act_..."}`) and the account on `META_WRITE_ALLOWLIST`. Writes remain approval-gated, `PAUSED`-only and verified by read-back. Use the sandbox account first.
- A **mock approval can never authorize a live write**: proposal, approval and connector must all be in the same mode, or execution is refused (`mode_mismatch`). Synthetic leads are refused when Meta is live.
- `npm run test:live` runs read-only checks against real Meta only when `INTEGRATION_MODE=live LIVE_META=true META_ACCESS_TOKEN=...` are all set, and AI contract tests only when `AI_PROVIDER_MODE=live ALLOW_LIVE_PROVIDER_CALLS=true`, the provider key and `*_LIVE_TEST_MODEL` are set. Otherwise those tests are reported as **skipped**, never as passed. The default `npm test` blocks all outbound network and fails if anything tries.
- Secrets live in `.env.local` or your shell, never in source, fixtures or the browser. Use a managed secret store when this is deployed.

## AI models (Milestone 2)

Campaign generation goes through one gateway ([docs/ai-gateway.md](docs/ai-gateway.md)): a deterministic **mock** provider by default, plus **OpenAI** (official SDK, Responses API) and **Anthropic** (official SDK, Messages API with native structured output). The app starts, and the whole test suite passes, with no API keys and no internet.

- **Choose models** in the UI (AI settings): *automatic* (cheapest eligible), *manual*, or *preferred with fallback*. Choices persist per workspace. The same screen shows mock/live mode, the model list with why a model is unusable, recent usage, and an explicit connection test.
- **Model IDs and prices are configuration**: `config/ai-models.json` and `config/ai-pricing.json`. The shipped price list is empty on purpose, so cost shows as *unknown* until you add figures from the provider's pricing page. The shipped model IDs have not been verified against a live account: run the connection test before relying on one.
- **Local model, free (Ollama).** `AI_PROVIDER_MODE=local` makes a model on this computer answer: real output, no key, no billing, and nothing leaves the machine. Run `npm run local:preflight`, then `AI_PROVIDER_MODE=local npm start`. It is slow on a CPU (about 2 minutes per campaign brief on the dev PC) and Ollama does not guarantee schema conformance, so every result is validated and a prompt too large for the model's context is refused rather than silently truncated. Only loopback hosts are accepted for `OLLAMA_BASE_URL`. The three modes never mix: mock, local and live each make exactly one kind of provider eligible. Measure it yourself with `npm run test:local:ollama`. **Measured result on the dev PC (CPU-only, llama3.1 8B): the plumbing works, but 0 of 3 generated briefs passed the schema even with one repair attempt** (the model overshoots the character limits), so local mode is not yet a way to get usable briefs. Details: [docs/ai-verification.md](docs/ai-verification.md) section 6.
- **Safe live setup** (only when you intend billable calls): put the keys in `.env.local`, never in chat or git:
  ```
  AI_PROVIDER_MODE=live
  ALLOW_LIVE_PROVIDER_CALLS=true
  OPENAI_API_KEY=...        # and/or
  ANTHROPIC_API_KEY=...
  ```
  Restart the app, set a daily request limit in AI settings first, then use **Test connection**. A live test makes one small real request and is recorded like any other.
- **Usage**: every attempt is recorded (provider, model, tokens, latency, request id, estimated cost, retries, fallbacks, blocked requests), as metadata only: no prompts or business data. Unknown tokens/cost are shown as unknown, never zero.
- **Live verification status (2026-10-16):** **OpenAI is verified against the real API** (`gpt-6-luna` and `gpt-5.5`, 13/13 checks, about $0.001 spent; evidence in `docs/live-verification/`). **Anthropic is not yet verified** (no key on this machine). Model IDs and prices were checked against the official docs on 2026-10-16. See [docs/ai-verification.md](docs/ai-verification.md) for sources, what was and was not tested, and how to run `npm run live:preflight` and `npm run test:live:openai|anthropic`.
- Mock results are always labelled **SIMULATED**, and a simulated connection test never reports a real connection.

## Campaign quality (Milestone 3)

Briefs are now checked for more than schema validity: the owner's budget is a hard **ceiling** (the brief proposes a separate, lower starting budget with a reason), targeting must explain itself and state its uncertainty, every approved differentiator needs a decision, only owner-approved facts may appear in ad copy, open questions must be material, and special ad categories are never proposed for automated creation. An 11-case synthetic evaluation suite scores quality separately from schema validity: `npm run eval:campaigns` (offline, free). The 11/11 mock result proves the rules and plumbing, **not** that a real model improved or that campaigns will perform; a live comparison is opt-in, budget-limited and has not been run. Milestone 3.1 added contradiction-aware claim grounding (a negative fact can no longer support a positive claim, and conflicting or unclear facts block or flag the brief), fact provenance records, pinned prompt and schema versions recorded with each generation, and the recovered original baseline for a fair comparison. Method, results and limits: [docs/campaign-evaluation.md](docs/campaign-evaluation.md).

## Architecture

```
public/            plain HTML/JS UI (no build step, no secrets)
src/server/        Fastify API (workspace-token auth, schema validation) + main entry
src/app/           domain services: workspaces, campaigns, proposals/approvals, executor, leads, jobs/worker, read views
src/ai/            AI gateway, router, model registry, pricing, mock + OpenAI + Anthropic providers
config/            model registry and price list (no secrets)
src/connector/     Meta connector (verified read + paused-only write) behind AdPlatformConnector
src/integrations/  mode switch, simulated Meta, simulated GoHighLevel CRM
src/db/            SQLite (better-sqlite3), SQL migrations
test/              unit, workflow, HTTP and persistence tests; test/live = opt-in
scripts/           shell scripts used for the original Meta sandbox verification
```

Safety properties (all covered by tests): workspace isolation on every query; approval re-validated immediately before a write (hash, campaign version, expiry, mode, account, budget cap); a persisted `dispatched` flag separates "never sent" from "maybe sent"; unknown outcomes are reconciled by unique name, never re-sent; unique constraints on external resources, lead events and CRM syncs; jobs de-duplicated and recoverable after a restart; models can only return schema-validated data.

## Database

SQLite file at `DATABASE_PATH` (default `./data/motivestack.db`, git-ignored). Migrations are plain SQL in `src/db/migrations/`, applied in order and recorded in `schema_migrations`. The repository layer is SQL-only so a move to PostgreSQL is a contained change; production persistence is not decided yet.

## Verified vs. not verified

- Verified by automated tests (offline): everything above in mock mode, including restarts, retries, duplicates and refusals.
- Verified against the real Meta sandbox earlier (see docs): account/campaign/ad-set reads and paused writes, lead retrieval from your own Page. The `MetaConnector` code is unchanged by this phase.
- **Not verified live:** the OpenAI and Anthropic adapters. They are tested offline by running the real SDKs against a mocked HTTP layer (request shape, response parsing, usage, request ids, error mapping, cancellation), and the live contract tests are skipped unless you opt in. Provider behavior with strict JSON schemas, real rate-limit headers and real model IDs is unproven until a live run. Also not live: the GoHighLevel connector (does not exist) and the Meta write path through the executor in live mode.
- UI: no real-browser test has been run (no browser tooling was available). `test/ui.dom.test.ts` drives the real page in jsdom (forms, clicks, persistence) against the real server code; it does not cover layout or CSS, so give the screen a visual look.

## Known limitations

- Local development auth only: one access token per workspace, a self-reported approver name. No users, roles or password flow yet.
- Only the `create_campaign_draft` action exists. No ad sets, creatives, ads, budgets, optimization, or activation (activation is deliberately not implemented).
- No real Instant Form lead intake, webhook receiver, OAuth flow or token storage/refresh.
- Meta Live mode, App Review and Business Verification blockers are listed in the go/no-go report.
- List endpoints return at most 100 items from Meta; no pagination.

## Next recommended milestone

Real authentication (users, roles, per-workspace membership) and encrypted connection/token storage, followed by the Meta OAuth flow and webhook intake against the sandbox, then ad sets and creatives once the app can go Live.
