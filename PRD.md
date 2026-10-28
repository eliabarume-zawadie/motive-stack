# MotiveStack --- Master Product Requirements Document (PRD)

**Status:** Master implementation specification\
**Product:** MotiveStack --- AI Marketing Operating System for small and
local service businesses\
**Implementation mode:** Local-first, offline/mock by default\
**Audience:** Claude Code and engineering contributors

## 1. Purpose

MotiveStack helps a small business owner turn business information into
a reviewed marketing plan, campaign drafts, approvals, and operational
follow-through. It is more than an AI copy generator: it combines a
Business Brain, website analysis, marketing planning, campaign lifecycle
management, leads, integrations, workspace permissions, usage controls,
jobs, and audit history.

The primary experience must be understandable to a nontechnical business
owner and guide them through five steps:

1.  Understand my business.
2.  Review my Business Brain.
3.  Choose my marketing goal.
4.  Review my campaign.
5.  Approve and track results.

For every recommendation, make clear what is known, what evidence
supports it, what is inferred, what remains unknown, and what will
happen after approval.

## 2. Non-negotiable implementation rules

1.  **Do not make live OpenAI, Meta Ads, or GoHighLevel calls while
    implementing this PRD.** Live OpenAI testing will happen later,
    after feature development, when separately authorized.
2.  Mock mode remains the default. Meta and CRM operations remain
    simulated throughout this implementation phase.
3.  Do not commit, reset, stash, discard, or overwrite user changes
    unless explicitly instructed. Preserve the working tree.
4.  Inspect Git status, HEAD, current code, tests, routes, database
    state, and migration history before editing.
5.  Never reset or reinitialize the user's database. Use additive,
    forward-only migrations and test upgrades safely.
6.  Never expose secrets in browser code, logs, test output,
    screenshots, or reports. API keys remain server-side.
7.  Do not weaken or delete tests to make the suite pass.
8.  Do not claim a feature works because a route exists. Verify the full
    UI → API → service → persistence → UI path.
9.  Do not invent live data, business facts, campaign results, pricing,
    or completed integrations.
10. At each phase boundary, report actual changes, tests run, remaining
    risks, and the next phase. Do not perform risky external actions
    without approval.

## 3. Product goals and completion definition

### Goals

-   Establish an evidence-grounded Business Brain for each business.
-   Convert business context and a selected goal into useful, reviewable
    campaign drafts.
-   Make approvals, budgets, claims, and execution consequences clear.
-   Provide a functional dashboard, campaign list/detail, jobs, leads,
    activity, settings, and integration status.
-   Maintain workspace isolation, server-side permissions, auditability,
    and conservative spending controls.
-   Keep provider integrations modular, replaceable, and mock-first.

### Not in scope for this implementation phase

-   Real Meta campaign creation, publishing, or ad spend.
-   Live GoHighLevel messaging or CRM mutations.
-   Live OpenAI smoke tests or real-model website analysis.
-   Autonomous publishing or unsupervised customer outreach.
-   Production-readiness claims for identity, credential storage,
    backups, TLS, or monitoring that have not been verified.

### Feature-complete means

The complete local mock workflow works end-to-end; every main navigation
item opens a functional page; UI actions connect to real backend
behavior; data persists; authorization and validation are enforced
server-side; simulated actions are clearly labeled; loading, empty,
success, error, and permission-denied states are handled; responsive
layouts work; documentation is accurate; typecheck and the complete
offline suite pass.

## 4. Product and architecture context

The reported existing stack is Node.js 22+, TypeScript ESM, Fastify 5,
SQLite via `better-sqlite3`, SQL migrations, Vitest, and a vanilla
HTML/CSS/JavaScript frontend. AI providers reportedly include OpenAI,
Anthropic, and mock implementations. Meta and CRM integrations should
use provider interfaces and mocks.

**Verify the actual repository before relying on this list.** Preserve
existing architecture unless a concrete problem justifies a change.
Avoid adding a frontend framework, ORM, or unnecessary dependencies.

## 5. Users, workspaces, and permissions

A workspace represents a business. Business Brain data, campaigns,
leads, approvals, integrations, usage, jobs, and audit events must be
scoped to the correct workspace.

Use the existing role and authorization model after inspecting it: -
**Viewer:** permitted read-only access. - **Operator:** permitted draft
creation/editing and routine simulated operations. - **Admin:**
permitted workspace settings, approvals, AI settings, Business Brain
management, integration status/testing, and member visibility. -
**Owner:** authorized ownership and member-management actions.

These are intended capability boundaries; preserve existing project
rules and resolve discrepancies explicitly. Enforce permissions in
backend routes/services, not only by hiding buttons. Derive the actor
from verified server-side identity. Reject cross-workspace access,
client-supplied role escalation, invalid ownership transitions, and
unauthorized approval or execution. Never fabricate an owner.

If browser OIDC/PKCE or production onboarding is not configured,
document the limitation; do not pretend it exists.

## 6. Primary workflow

### Step 1 --- Understand my business

Offer website-based analysis and a no-website manual path. Show
progress, pages inspected, blocked pages, and useful findings. Website
analysis must not automatically save approved Business Brain facts.

### Step 2 --- Review my Business Brain

Show editable business name, industry, services, service area, target
customers, main offer, tone, strengths, credentials/verified facts,
pricing when known, summary, and additional context. Show provenance and
review status. Save only after explicit user action.

### Step 3 --- Choose my marketing goal

Support clear goals such as lead generation, promoting a service/offer,
local awareness, or improving an existing campaign when sufficient data
exists. Ask only necessary questions and explain why missing information
matters. Do not invent forecasts.

### Step 4 --- Review my campaign

Show objective, rationale, audience, geography, offer, CTA, copy,
creative brief, platform assumptions, budget, duration, claims
used/withheld, source evidence, assumptions, risks, unanswered
questions, validation, and whether the action is simulated or live.
Support editing, saving, version history, and clear differences between
versions. Block proposals with unresolved blocking issues.

### Step 5 --- Approve and track results

Show exactly what is being approved, the campaign version, budget,
claims, audience, execution mode, approver, time, job status, errors,
and next steps. All execution remains simulated in this phase. Simulated
spend and performance must never be presented as real.

## 7. Required modules

### 7.1 Application shell, navigation, and dashboard

Implement working navigation for: - Home/dashboard - Business Brain -
Marketing goals/campaigns - Campaign list and detail - Leads -
Jobs/operations - Activity/audit history - Settings/integrations -
Developer diagnostics where appropriate

Dashboard data must come from real local backend records, not hardcoded
counts. Include Business Brain completeness, missing information, claims
needing confirmation, blocking campaign questions, pending approvals,
recent campaign activity, leads, jobs/failures, integration state, and
usage/cost status. "Needs your attention" items should navigate directly
to the relevant task. Every page must have empty, loading, error, and
no-results states.

### 7.2 Business Brain

Provide create, edit, validate, save, reload, and review behavior. Track
provenance for owner-entered, website-derived, imported, and AI-inferred
values. Track source URL/page and evidence when available. Unsupported
claims remain unverified until the owner reviews them. Allow
approve/edit/reject/remove. Avoid duplicate questions for facts already
captured and confirmed. Preserve owner text on later analysis.

The no-website form must populate the same schema and mark its values as
owner-provided.

### 7.3 Website crawling and analysis

Use bounded crawling (the current report says up to eight pages; inspect
and preserve the existing policy unless there is a justified change).
Requirements: - Only public HTTP/HTTPS destinations. - Reject private,
loopback, link-local, reserved, and internal IPv4/IPv6 addresses. -
Revalidate DNS/address safety at connection time and on redirects;
mitigate DNS rebinding. - Reject embedded URL credentials and unsafe
ports. - Enforce page count, per-response and total byte limits,
elapsed-time limits, redirect limits, and timeouts. - Respect
robots.txt; do not bypass login, CAPTCHA, bot protection, or access
restrictions. - Do not execute arbitrary page JavaScript. - Parse HTML
and safe structured data; prioritize relevant internal About, Services,
Contact, and service pages. - Deduplicate URLs, bound recursion,
sanitize extracted content, and treat website content as untrusted data,
never instructions. - Report blocked, empty, unavailable, malformed,
oversized, or JavaScript-only pages honestly.

Each finding should include field/value, source URL, supporting excerpt,
type (extracted fact, AI inference, or unknown), confidence/uncertainty
where available, and review status. Website text is evidence that a site
makes a statement, not proof the statement is true.

Flow: crawl → extract → review → edit/approve/reject → explicitly save.

### 7.4 Website refill/provenance ledger

Record exactly which values the application added to the form. On
reanalysis: - Remove or replace only application-generated values. -
Preserve owner-entered text and owner-created list items. - Clear stale
website-derived values not supported by the new source. - Update source
provenance accurately. - Reset approval for new or materially changed
claims. - Show additions, changes, and removals before saving. - Enforce
the ledger server-side; never trust browser assertions that text is
system-generated.

Test same-site reanalysis, different-site reanalysis, missing fields,
changed claims, and owner-text preservation.

### 7.5 AI provider layer and settings

Retain the existing provider abstraction and mock implementation after
inspecting actual code. Mock mode is default. Live mode must require
explicit server-side configuration. A browser toggle alone must never
enable live calls.

-   Keys remain server-side and are never returned to clients.
-   Use `store:false` for OpenAI requests where supported.
-   Pin a predictable processing tier.
-   Enforce input/output limits, timeouts, retry limits, and
    structured-output validation.
-   Do not expose provider response bodies or secrets in errors/logs.
-   Record provider usage and cost when reliable; unknown usage remains
    unknown, never zero.
-   A present key is not proof that it is valid.
-   Restrict provider base URLs to trusted defaults; prevent accidental
    key exfiltration.
-   Keep model prices in documented central configuration with
    source/date. Do not claim they are current without verification.
-   Do not make live AI calls during this PRD implementation.

### 7.6 AI cost and request controls

-   Atomically enforce persistent monthly budget and daily request
    limits.
-   Reserve worst-case cost before every paid request.
-   Account for initial attempts, retries, repair calls, and
    structured/text paths.
-   Prevent concurrent requests from exceeding the global ceiling.
-   Record reservations, actual usage, unknown usage, releases, and
    unverified holds.
-   Do not release a reservation after timeout/cancellation if billing
    may have occurred and usage is unknown.
-   Survive process restarts safely.
-   Display used/reserved/remaining budget, daily count, unknown usage,
    and blocked reasons.
-   Per-workspace limits must not be described as concurrency-safe
    unless in-flight requests are included and tested.

### 7.7 Marketing strategy and campaign generation

Generate reviewable campaign briefs from Business Brain, user goal,
constraints, and provider abstraction. Include goal/rationale,
platform/objective, audience/geography, offer/CTA, copy/headline,
creative brief, budget/duration, targeting rationale, assumptions,
questions, claims and evidence, withheld claims, risks, and validation.

Rules: - Avoid generic filler; produce clear, specific copy. - Never
invent testimonials, awards, credentials, guarantees, prices,
comparative superiority, customer outcomes, or performance statistics. -
Distinguish recommendations from verified facts. - Flag
unsupported/high-risk claims. - Enforce the hard budget ceiling
server-side. - Explain budget rationale and uncertainty. - Validate
platform constraints. - Show blocking errors near the offending field
and provide a correction path. - Label rule-based mock output honestly;
it is not proof of real-model quality.

### 7.8 Campaign list, detail, and lifecycle

Provide backend-backed campaign list and detail pages with search/filter
where practical. Show goal/name, platform, status, simulated/live mode,
budget/duration, approval/execution state, timestamps, and creator when
supported.

Detail page includes current draft, versions, diffs, review data,
claims/evidence, approval/rejection, jobs, audit history, and
performance data only when it actually exists.

Support editing and versioning, proposal, approval/rejection, and
idempotent simulated execution. Pause/resume/archive may be implemented
only if valid in the domain model and fully validated/audited. Reject
invalid transitions, stale approvals, over-budget proposals, and
duplicate execution. Never invent performance metrics.

### 7.9 Approval workflow

Bind approval to the exact campaign version/payload. Show the action,
budget, audience, offer, claims, and execution mode. Require explicit
action and backend permission. Use server-derived actor identity.
Support rejection reason. Prevent approval of invalid or stale versions.
Maintain an auditable chain from draft → proposal → decision →
execution. If proposer self-approval is possible, document it rather
than claiming separation of duties exists.

### 7.10 Jobs and operations

Provide a page backed by persisted job records showing type, related
entity, status, timestamps/duration, attempts, safe error, retry
eligibility, simulated/live mode, and result/audit reference.

Retries must be bounded and idempotent. Distinguish retryable and
permanent errors. Do not expose stack traces or raw provider error
bodies. If no durable job queue exists, document the limitation and
implement a minimal solution consistent with the current architecture
rather than pretending a worker exists.

### 7.11 Leads and CRM simulation

Build leads list and detail pages using backend data. Show available
contact fields, source, capture time, status, related campaign,
duplicate/event processing state, and CRM sync state. Provide status
updates and history where supported.

Synthetic leads must be labeled simulated. Deduplicate inbound events
with stable event IDs/idempotency keys. Do not send real email/SMS or
mutate a real CRM in this phase. Keep future GoHighLevel integration
behind a provider interface. Never claim a real CRM is connected based
only on configuration presence.

### 7.12 Integrations

Provide status for AI, Meta Ads, and GoHighLevel. Each should state
mock/configured-but-unverified/verified/unavailable/disabled, available
capabilities, last test result, setup guidance, and permission
limitations.

A connection test must say whether it is simulated or live. Never show
credentials. Meta account selection must be workspace-authorized and
server-validated. Do not enable live ad creation/publishing. Real GHL
actions remain deferred. Do not imply secure production credential
storage until a managed key provider is available and verified.

### 7.13 Workspace and member management

Where backend support exists, provide workspace settings, member
list/roles, authorized member changes, and ownership actions. Enforce
permissions server-side. Prevent self-assigned owner/admin roles and
invalid ownership transitions. Do not expose tokens or unnecessary
identifiers. If OIDC/PKCE onboarding is not configured, document the
local-development limitation.

### 7.14 Activity and audit

Provide persisted activity for Business Brain edits, website
analyses/reviews, campaign changes/versioning, proposals,
approvals/rejections/execution, lead intake/deduplication/status,
integration tests/settings, member/workspace changes, AI
usage/reservations/blocked requests, and job state changes.

Events should include timestamp, workspace, server-derived actor when
known, action, target, result, and safe context. Do not store secrets or
unnecessary personal data. Ordinary users must not be able to edit audit
history. Identify simulated actions.

### 7.15 Settings and developer mode

Ordinary settings: workspace/business settings, marketing preferences
where supported, integrations, authorized member management, and usage.

Developer mode: AI mode/provider status, safe configuration diagnostics,
mock/live explanation, diagnostic results without secrets, and gated
test controls. Do not clutter the primary workflow with
environment-variable instructions.

### 7.16 Usage and cost page

Show provider/model, request counts, token counts when reliable, actual
cost when calculable, unknown usage and unverified holds, monthly
ceiling/used/reserved/remaining, daily cap/count, blocked requests, and
reasons. Clearly label estimates and unverified pricing. Never show
unknown cost as zero.

## 8. Data integrity and migrations

Inspect the current schema and migration state before modifying it. Use
additive, forward-only migrations. Never reset or reinitialize the
active database.

Required invariants: - Every read/write is workspace-scoped and
authorized. - Campaign budgets cannot exceed the hard ceiling. -
Campaign transitions are validated. - Approval binds to the reviewed
version. - Execution and lead processing are idempotent. - Business
Brain findings are not approved until explicitly saved. - Provenance
allows website-derived content to be removed without deleting owner
content. - Credentials are encrypted or unavailable, never plaintext. -
Unknown AI usage stays unknown and reservations are conservative. -
Audit records persist and contain no secrets. - Synthetic records are
distinguishable from real records.

For every migration, test migration from an empty database where
appropriate and upgrade from the current version; verify existing data
survives. Do not run destructive commands against the user's database.

## 9. Security and privacy

Preserve and test: - Input validation and safe output rendering. -
CSP/security headers, host/origin checks, and CSRF protections
appropriate to the auth model. - Rate limiting for sensitive actions. -
Workspace isolation and role enforcement. - Server-only secrets. -
SSRF-resistant bounded crawling. - Untrusted website content
isolation. - Bounded model input/output, retries, and cost. - Safe error
messages. - Credential vault readiness and production provider
requirements. - Audit history without secrets.

Do not claim production readiness until identity-provider configuration,
managed key provider, TLS/reverse proxy, backups, monitoring, rate
limiting, and recovery procedures have been evaluated and implemented as
required. Document remaining limitations.

## 10. UX and accessibility

Use plain language. Make the five steps visible. Use consistent status
labels: draft, needs review, awaiting approval, approved, simulated,
running, completed, failed. Do not rely on color alone. Support keyboard
access and visible focus. Label form controls. Prevent accidental double
submission. Show pending states and actionable errors. Confirm
destructive/consequential actions. Ensure mobile/tablet/desktop layouts
work without horizontal overflow. Remove dead controls. Explain empty
states. Distinguish generated suggestions from saved facts.

## 11. Testing and QA

Test: - Domain/services and API schemas. - Workspace isolation, role
permissions, denied access, and actor identity. - Budget ceiling,
campaign transitions, version/approval integrity, and idempotent
execution. - Audit events. - Website crawl bounds, SSRF, redirects, DNS
checks, timeout, content size, robots, extraction, provenance, and
refill cleanup. - AI request/response validation, retries/repair,
timeout/cancellation, unknown usage, reservations, concurrency, caps,
restart behavior, and month rollover. - Leads, event deduplication, and
CRM mocks. - Job retries/idempotency. - UI navigation,
loading/empty/error/permission states, responsive behavior, and browser
console errors. - Migration upgrade and data preservation.

The default suite must never make live provider calls. External-service
tests must be opt-in and skipped by default. Do not weaken tests to get
a green suite.

Browser QA must verify: 1. Open/create a workspace. 2. Analyze a local
fixture website or use manual onboarding. 3. Review and save Business
Brain. 4. Choose a goal and generate a mock campaign. 5. Edit and
version the draft. 6. Confirm invalid/over-budget proposals are blocked.
7. Submit, approve, and execute a simulated campaign. 8. Inspect jobs
and audit history. 9. Create a synthetic lead and test duplicate
handling. 10. Inspect dashboard, campaigns, leads, jobs, settings,
integrations, and usage. 11. Verify denied permissions. 12. Confirm mock
mode and no external provider calls.

A feature is complete only when typecheck, relevant tests, full offline
suite, UI verification where relevant, and documentation pass. Report
actual results.

## 12. Implementation roadmap

### Phase 0 --- Baseline and gap matrix

Inspect Git status/HEAD, changed/untracked files, current database
migration, routes, services, tests, and docs. Map every requirement to
current code/tests and classify it as complete, partial, missing, or
unsafe. Do not repeat completed work. Report dependencies and prioritize
security/data-integrity issues.

### Phase 1 --- App shell and dashboard

Complete navigation, backend-backed dashboard, "Needs your attention,"
responsive layout, and all empty/loading/error states.

### Phase 2 --- Business Brain and website analysis

Complete source evidence, review/edit/approve/reject, no-website path,
SSRF/resource controls, provenance ledger, safe refill, and preservation
of owner content.

### Phase 3 --- Marketing planning and campaigns

Complete goal selection, mock campaign generation, claims/uncertainty,
validation, campaign list/detail/version history, proposal,
approval/rejection, and simulated lifecycle.

### Phase 4 --- Jobs, leads, and activity

Complete operations/job page, leads list/detail/status/deduplication,
and activity/audit page.

### Phase 5 --- Settings, workspaces, and integrations

Complete workspace/member UI where backend support exists, AI provider
status, usage/cost page, and honest Meta/GHL mock status.

### Phase 6 --- Security and operational hardening

Review workspace isolation, roles, origin/CSP, rate limiting, audit,
migrations, job idempotency, spending reservations, safe errors, and
credential boundaries. Fix critical/high issues and document remaining
production prerequisites.

### Phase 7 --- Full QA and documentation

Run full offline tests, typecheck, browser QA, navigation checks,
responsive checks, and no-network verification. Update README and
feature-status/developer documentation. Deliver an evidence-based
acceptance report.

### Phase 8 --- Live OpenAI testing (deferred)

Do not perform this phase now. It requires separate explicit
authorization. When authorized: review exact
request/model/input/attempts/reservation/cost; verify configuration
without revealing the key; run one bounded smoke test; verify
usage/cost/audit/reservation records; restore mock mode; then separately
request authorization before real-model website analysis. Meta and GHL
remain mock unless separately authorized.

## 13. Required workflow for Claude Code

For each phase: 1. Inspect current implementation and tests. 2. State
the specific gaps before editing. 3. Make the smallest coherent changes.
4. Add regression tests. 5. Run targeted tests and typecheck. 6. Run the
full offline suite at phase boundaries. 7. Exercise UI changes in a
browser. 8. Inspect diffs for unrelated edits, secret leakage, unsafe
migrations, and accidental live-mode configuration. 9. Report actual
results, files changed, risks, and next steps. 10. Stop at meaningful
checkpoints. Do not commit.

Do not hardcode fake dashboard metrics or production-looking fake data.
Test fixtures and explicitly labeled demo data are acceptable.

## 14. Acceptance checklist

-   [ ] App starts in mock mode without live credentials.
-   [ ] Main navigation and pages work.
-   [ ] Dashboard uses actual local data.
-   [ ] Website and manual Business Brain onboarding work.
-   [ ] Website findings have evidence and provenance.
-   [ ] Owner content survives reanalysis.
-   [ ] Unsupported claims are not automatically verified.
-   [ ] Marketing goals produce reviewable mock drafts.
-   [ ] Campaign drafts support edits and versions.
-   [ ] Budget and platform checks block unsafe proposals.
-   [ ] Approval binds to the reviewed version.
-   [ ] Simulated execution is idempotent and clearly labeled.
-   [ ] Campaign list/detail and lifecycle work.
-   [ ] Jobs show persisted status and safe errors.
-   [ ] Leads and duplicate-event handling work in simulation.
-   [ ] Audit/activity history is useful and persisted.
-   [ ] Workspace and role restrictions are server-enforced.
-   [ ] Integration state distinguishes mock from verified live.
-   [ ] Usage, reservations, unknown costs, and ceilings are visible.
-   [ ] No credentials leak to browser/logs/reports.
-   [ ] Loading, empty, success, error, and permission states work.
-   [ ] Mobile/tablet/desktop layouts are usable.
-   [ ] Full offline suite and typecheck pass.
-   [ ] No unauthorized live provider calls occurred.
-   [ ] No destructive database operation or unrequested commit
    occurred.
-   [ ] Documentation and remaining limitations are accurate.

## 15. Claude Code's first response

Before implementing, report: 1. Current branch and HEAD. 2. Modified and
untracked files. 3. Current migration version and pending migrations. 4.
A feature-to-code/test mapping with evidence. 5. Prioritized gaps,
severity, and dependencies. 6. Proposed phase sequence. 7. Any conflicts
or product decisions required.

Then begin Phase 0. Preserve the working tree and database, remain
offline, and do not commit.
