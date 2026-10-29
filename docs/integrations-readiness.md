# Integrations and controlled execution readiness (Master PRD Phase 8)

**Nothing in this phase activates anything.** It describes integrations accurately, prepares the contracts a future live integration would have to meet, and proves that in mock mode nothing can reach the outside world. No setting can be changed from the browser: going live is a server configuration change that needs separate explicit authorization and an integration-specific review.

## The integration registry (Settings, for admins and owners)

`GET /integrations` returns, for every adapter, an honest **state**: `mock` (a built-in stand-in), `configured_unverified` (set up but never tested live), `verified` (a live test passed: impossible in this release), `limited` (works, with stated restrictions), `disabled`, `unavailable`, or `not_built`. Each adapter also states:

- **Exactly which actions it supports**, each marked as reading, changing only this app, or **able to affect the outside world**, with whether it is simulated, available, disabled or not built, and whether it needs approval;
- its **limits**, where its **data comes from** and how that data is labelled, its **failure behaviour**, **setup guidance**, who may change it, and its **last test** (always labelled simulated);
- `canAffectOutsideWorldNow`, which is **false for every adapter** in this release.

| Adapter | State in mock mode | What actually exists |
|---|---|---|
| Meta Ads | simulated | Simulator: authorized accounts, a **paused** draft with no budget, status read-back. Ad sets, ads, budgets, activation, pause/resume, lead retrieval and performance are **not built**. |
| GoHighLevel CRM | simulated | Simulator: create or update a contact, synthetic leads only. Reading contacts, opportunities, messaging and inbound events are **not built**; the live connector is refused at start-up. |
| AI text generation | simulated | Drafts and website reading; settings and the connection test stay in AI settings. |
| Image generation | simulated | An offline placeholder provider; video and any live provider are **not built**. |
| Asset storage | limited | A local development folder with no backup or retention. |
| Sign-in | limited / configured | The shared token (not a person) or an identity provider. |
| Credential vault | disabled without a key provider | Masked status only; a secret is never shown. |
| Google Ads, TikTok Ads, e-mail and SMS, web analytics, calendar tools | **not built** | Declared with their own capabilities, approval requirements, limits, data provenance and failure behaviour **before any code exists**. Nobody can enable them. |

The **execution lock** says why nothing can reach the outside world (Meta simulated, no live GoHighLevel connector, AI simulated or local, offline image provider, no e-mail, SMS, push, tracking pixel or public form) and that it **cannot be changed from the page**. If a server were ever configured live, the registry says at least one integration can reach an outside service, and that every external write still needs an exact, unexpired approval and a separate run step.

## Action contracts

Every action that could ever affect the outside world is listed with what it would do, whether it is reversible, what it **requires** (approval of the exact payload, a separate run step, the daily limit, a signed-in approver, consent verification and a privacy review where relevant), the **data it would send**, its **indicative permission scopes**, the permissions that gate it today, and what enabling it would take. Scopes are a starting point for the future review and **must be checked against each vendor's current documentation**; none is requested today. Only "create a paused draft on Meta" and "create a CRM contact" exist, both simulated.

## Simulated self-tests

An admin can run a **simulated** self-test of the Meta simulator, the CRM simulator and the placeholder image provider. It exercises the stand-in on this computer, records the result with `simulated` always true (a database constraint), and says nothing was contacted. A test of a **live** service would make a real request and is **refused** (`live_test_disabled`), recording nothing. The AI connection keeps its own test in AI settings.

## Read-only previews (dry runs)

- **A proposal's run:** exactly what would be sent (account, name, objective, status paused, **no budget sent**, creatives not sent) and each precondition judged now: approved, campaign unchanged, approval present, payload hash, approval unexpired, same mode, approver still allowed, authorized account, Business Brain ceiling, workspace daily limit, pinned creatives still approved. It changes nothing and queues nothing (a test checks that looking does not alter the proposal, jobs or attempts). It mirrors the executor's gate, and tests check the two agree on an expired approval and a lowered limit.
- **A lead's CRM sync:** only a synthetic lead from the simulator would go anywhere, and only to the simulator; imported leads and form-test leads are never sent. It sends nothing.

## Mock end-to-end and failure tests

The whole mock workflow (propose, approve, run, a synthetic lead, its CRM sync) is tested with a spy on the network, which is **never called**. Failure injection covers: a retried definite Meta failure (exactly one draft, never duplicated), a lost response (goes to needs review and is never re-sent), a permission error (fails at once), a platform that ignores "paused" (not recorded as success), a retried temporary CRM failure, and a CRM permission error.

## Permissions and data

`integrations.read` and `integrations.test` (admin). The dry runs use the existing `proposals.read` and `leads.read`. Migration `022_integration_tests.sql` (additive) records simulated self-tests.

## Known gaps

| Gap | State |
|---|---|
| Any live integration | Not activated and not requested. Needs separate explicit authorization and an integration-specific review. |
| Live connection tests | Refused; they would make a real request. |
| Vendor scopes | Indicative only; to be verified against current vendor documentation. |
| Webhooks and inbound events, performance import | Not built. |
| Registry state `verified` | Cannot occur in this release (it needs a passing live test). |
| Per-workspace enable/disable of an adapter | Not built: nothing can be enabled. |
