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

## Current feature status (mock mode)

Everything below runs locally and offline. Nothing here uses a real AI provider, Meta account or CRM.

| Area | Status | Details |
|---|---|---|
| Home dashboard | working | Real local counts, a server-built "Needs your attention" list, loading, empty and error states. |
| Business Brain | working | Website analysis (bounded, SSRF-safe reader, evidence per finding) or a no-website questionnaire; review, edit, approve or reject each finding; owner wording survives re-analysis; each saved item is labelled with where it came from. [docs/website-analysis.md](docs/website-analysis.md) |
| Daily budget limit | working | The Business Brain's daily ceiling is one limit for the whole workspace: every plan and stand-alone campaign together, counting what is approved or running once. Enforced on the server when proposing, approving (race-safe, in one write-locked transaction) and running; a lowered limit is flagged and blocks new approvals. [docs/daily-budget-limit.md](docs/daily-budget-limit.md) |
| Plans and lifecycle | working | A canonical campaign lifecycle enforced on the server (draft, needs review, awaiting approval, approved, queued, run, completed, archived). Rule-based plans of separate campaigns that share one daily budget, resumable idempotent batch drafts, duplicate checks, and a budget review that goes stale when any number changes. A plan is never approved as a whole. [docs/campaign-lifecycle-and-plans.md](docs/campaign-lifecycle-and-plans.md) |
| Marketing goal and campaigns | working | Goal choice, mock draft with claims, assumptions, questions and platform checks, edits with version history, search and filter. The mock draft does not change with the goal. [docs/campaign-planning.md](docs/campaign-planning.md) |
| Approval and simulated execution | working | Approval binds to the reviewed version and **never runs anything**: running is a separate step needing its own `proposals.execute` permission. Over-budget proposals are refused; execution is idempotent and always labelled SIMULATED. A person cannot approve their own proposal (default on; not enforceable with the shared local token, and recorded as such). |
| Brand Kit and assets | working (local files) | A versioned Brand Kit (voice, look, audiences, disclaimer wording: preferences, never business facts) with version-bound review, and an asset library with validated PNG/JPEG/WebP files, provenance, rights, immutable versions and review. Files are stored in `data/assets/` (git-ignored, development only). Not used in generation yet. [docs/brand-kit-and-assets.md](docs/brand-kit-and-assets.md) |
| Creative Studio | working (mock only) | Still-image creatives per campaign: structured brief, editable copy, placeholder pictures from an offline mock made by persisted, cancellable, retryable jobs, deterministic checks with repair guidance (AI critique is shown as not performed), version-bound approval and a hash-pinned link to the campaign proposal. No live image service; video is planned, not built. See [docs/creative-studio.md](docs/creative-studio.md). |
| Team operations | working (in-app only) | Owners and reviewers (coordination only: they grant nothing), dated tasks tied to the exact campaign and creative version, an inbox built from real records (decisions waiting, problems, dates), an agenda calendar that never claims a platform schedule, and in-app notifications. No e-mail, SMS or push. See [docs/team-operations.md](docs/team-operations.md). |
| Leads, forms and reporting | working (mock only) | Every lead says what it is (synthetic, imported, real) and how sure its campaign link is (observed, inferred, unknown, with the basis), with campaign version, UTM tags, consent and a team-only follow-up reminder. Import a list as IMPORTED leads (never sent to a CRM). Lead form definitions with test submissions (nothing published). A Results view that counts each kind of data separately and shows cost per lead, impressions, clicks and ROAS as not measured. See [docs/leads-funnel-analytics.md](docs/leads-funnel-analytics.md). |
| Experiments, learnings and recommendations | working (records only) | Experiment plans with one principal variable, exact-version variants, a decision rule written before the data and a frozen plan; recorded use and results labelled by source (synthetic never counts); an honest analysis that blocks conclusions on thin data and never claims significance. A Marketing Brain of traceable, human-confirmed learnings that are never business facts, and recommendations derived from records with their evidence and uncertainty. Nothing changes spend, edits a campaign or publishes. See [docs/experiments-and-learning.md](docs/experiments-and-learning.md). |
| Organizations and custom roles | API only | Every workspace belongs to an organization (personal ones are automatic). Agencies, client workspaces and custom roles work through the API for signed-in people; the browser cannot sign in yet, so there is no role editor. [docs/organizations-and-permissions.md](docs/organizations-and-permissions.md) |
| Leads and jobs | working | Synthetic leads only, duplicate events ignored, owner-set status with history; persisted jobs with safe errors and a bounded retry. [docs/leads-and-jobs.md](docs/leads-and-jobs.md) |
| Settings | working | Workspace and role, people (needs real sign-in), AI status and estimated usage, integrations with last test. [docs/settings-and-integrations.md](docs/settings-and-integrations.md) |
| Security review | done for Phases 1 to 5 | Findings, fixes and production prerequisites: [docs/security-review.md](docs/security-review.md) |
| Live OpenAI | **not tested** | Deferred. Needs explicit authorization and a new valid key. The one-request plan is in [docs/website-analysis.md](docs/website-analysis.md). |
| Live Meta, live CRM | **not implemented / not enabled** | Real GoHighLevel actions are deferred; live Meta creation is not enabled in this release. |

Acceptance evidence for the whole roadmap: [docs/acceptance-report.md](docs/acceptance-report.md).

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
