# MotiveStack — Master Product Requirements Document

**Document status:** Authoritative product and implementation specification  
**Audience:** Claude Code and project maintainers  
**Rule of precedence:** This file is the single source of truth. If older PRDs, notes, prompts, repository comments, or prior plans conflict with this document, follow this document and report the conflict rather than silently choosing another interpretation.

## How Claude Code must use this document

1. Read this entire document before proposing or changing implementation.
2. Inspect the current repository and populated database; do not assume descriptions of prior state are still current.
3. First produce the repository audit and requirement-to-code gap matrix described in the Claude Code workflow section. Do not begin implementation until the user explicitly approves the audit and the next phase.
4. Implement in the dependency order in this document. A phase is not complete until its acceptance criteria, tests, type checks, and offline-safety checks pass.
5. Treat all live integrations and external side effects as disabled unless the user separately authorizes a specific operation, provider, data scope, cost/usage limit, and environment.
6. Preserve the existing working tree and data. Do not perform destructive or history-changing Git/database actions without explicit permission.

**Consolidation note:** This document integrates the baseline PRD and the confirmed Version 2 architecture refinements. It replaces the former appended Version 2 appendix and the earlier roadmap with a unified specification.

## 1. Confirmed product decisions

| Decision | Confirmed direction | Architectural consequence |
|---|---|---|
| Primary market | Both local/small businesses and agencies | Support a business owner’s single workspace and an agency managing multiple client workspaces without mixing their data. |
| Creative approach | Integrated | MotiveStack should own the end-to-end creative workflow, while using replaceable image/video/model providers behind adapters. |
| Campaign creation | All modes | Support one campaign at a time, AI-recommended campaign plans, and batch creation of multiple related campaigns. |
| Team permissions | Custom | Provide useful default roles plus workspace-specific permissions and approval policies. |
| Automation | Approval-first | Consequential actions require explicit approval; low-risk automation can be considered later only as an opt-in, bounded capability. |
| Immediate priority | All-in-one product, delivered in stages | Design the connected product architecture now, but implement it in dependency-aware increments rather than building every module simultaneously. |

## 2. Product definition

MotiveStack is an AI Marketing Operating System: a shared place to understand a business, plan marketing, create and review campaigns and creative assets, coordinate a team, manage leads, track results, and improve future marketing decisions.

It is not merely an ad-copy generator or a collection of disconnected AI tools. The primary user experience should connect the following lifecycle:

**Business context → Marketing plan → Campaigns → Creative production → Human review and approval → Execution or handoff → Leads and performance → Learning and next plan.**

The product must support two starting situations:
- **Direct business:** one business owner or team operating one or more business workspaces.
- **Agency:** an agency workspace/organization coordinating work for multiple client workspaces, with strict client-level separation.

Do not assume that agency users and client users have the same access rights. Agency membership, client-workspace membership, and permissions inside each client workspace are separate authorization decisions.

## 3. Purpose, goals, and baseline requirements

The following baseline requirements remain in force and are incorporated here. They are not superseded unless an explicit requirement elsewhere in this document says so.

### 1. Purpose

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

### 2. Non-negotiable implementation rules

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

### 3. Product goals and completion definition

#### Goals

-   Establish an evidence-grounded Business Brain for each business.
-   Convert business context and a selected goal into useful, reviewable
    campaign drafts.
-   Make approvals, budgets, claims, and execution consequences clear.
-   Provide a functional dashboard, campaign list/detail, jobs, leads,
    activity, settings, and integration status.
-   Maintain workspace isolation, server-side permissions, auditability,
    and conservative spending controls.
-   Keep provider integrations modular, replaceable, and mock-first.

#### Not in scope for this implementation phase

-   Real Meta campaign creation, publishing, or ad spend.
-   Live GoHighLevel messaging or CRM mutations.
-   Live OpenAI smoke tests or real-model website analysis.
-   Autonomous publishing or unsupervised customer outreach.
-   Production-readiness claims for identity, credential storage,
    backups, TLS, or monitoring that have not been verified.

#### Feature-complete means

The complete local mock workflow works end-to-end; every main navigation
item opens a functional page; UI actions connect to real backend
behavior; data persists; authorization and validation are enforced
server-side; simulated actions are clearly labeled; loading, empty,
success, error, and permission-denied states are handled; responsive
layouts work; documentation is accurate; typecheck and the complete
offline suite pass.

### 4. Product and architecture context

The reported existing stack is Node.js 22+, TypeScript ESM, Fastify 5,
SQLite via `better-sqlite3`, SQL migrations, Vitest, and a vanilla
HTML/CSS/JavaScript frontend. AI providers reportedly include OpenAI,
Anthropic, and mock implementations. Meta and CRM integrations should
use provider interfaces and mocks.

**Verify the actual repository before relying on this list.** Preserve
existing architecture unless a concrete problem justifies a change.
Avoid adding a frontend framework, ORM, or unnecessary dependencies.

### 5. Users, workspaces, and permissions

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

### 6. Primary workflow

#### Step 1 --- Understand my business

Offer website-based analysis and a no-website manual path. Show
progress, pages inspected, blocked pages, and useful findings. Website
analysis must not automatically save approved Business Brain facts.

#### Step 2 --- Review my Business Brain

Show editable business name, industry, services, service area, target
customers, main offer, tone, strengths, credentials/verified facts,
pricing when known, summary, and additional context. Show provenance and
review status. Save only after explicit user action.

#### Step 3 --- Choose my marketing goal

Support clear goals such as lead generation, promoting a service/offer,
local awareness, or improving an existing campaign when sufficient data
exists. Ask only necessary questions and explain why missing information
matters. Do not invent forecasts.

#### Step 4 --- Review my campaign

Show objective, rationale, audience, geography, offer, CTA, copy,
creative brief, platform assumptions, budget, duration, claims
used/withheld, source evidence, assumptions, risks, unanswered
questions, validation, and whether the action is simulated or live.
Support editing, saving, version history, and clear differences between
versions. Block proposals with unresolved blocking issues.

#### Step 5 --- Approve and track results

Show exactly what is being approved, the campaign version, budget,
claims, audience, execution mode, approver, time, job status, errors,
and next steps. All execution remains simulated in this phase. Simulated
spend and performance must never be presented as real.

### 7. Required modules

#### 7.1 Application shell, navigation, and dashboard

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

#### 7.2 Business Brain

Provide create, edit, validate, save, reload, and review behavior. Track
provenance for owner-entered, website-derived, imported, and AI-inferred
values. Track source URL/page and evidence when available. Unsupported
claims remain unverified until the owner reviews them. Allow
approve/edit/reject/remove. Avoid duplicate questions for facts already
captured and confirmed. Preserve owner text on later analysis.

The no-website form must populate the same schema and mark its values as
owner-provided.

#### 7.3 Website crawling and analysis

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

#### 7.4 Website refill/provenance ledger

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

#### 7.5 AI provider layer and settings

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

#### 7.6 AI cost and request controls

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

#### 7.7 Marketing strategy and campaign generation

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

#### 7.8 Campaign list, detail, and lifecycle

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

#### 7.9 Approval workflow

Bind approval to the exact campaign version/payload. Show the action,
budget, audience, offer, claims, and execution mode. Require explicit
action and backend permission. Use server-derived actor identity.
Support rejection reason. Prevent approval of invalid or stale versions.
Maintain an auditable chain from draft → proposal → decision →
execution. If proposer self-approval is possible, document it rather
than claiming separation of duties exists.

#### 7.10 Jobs and operations

Provide a page backed by persisted job records showing type, related
entity, status, timestamps/duration, attempts, safe error, retry
eligibility, simulated/live mode, and result/audit reference.

Retries must be bounded and idempotent. Distinguish retryable and
permanent errors. Do not expose stack traces or raw provider error
bodies. If no durable job queue exists, document the limitation and
implement a minimal solution consistent with the current architecture
rather than pretending a worker exists.

#### 7.11 Leads and CRM simulation

Build leads list and detail pages using backend data. Show available
contact fields, source, capture time, status, related campaign,
duplicate/event processing state, and CRM sync state. Provide status
updates and history where supported.

Synthetic leads must be labeled simulated. Deduplicate inbound events
with stable event IDs/idempotency keys. Do not send real email/SMS or
mutate a real CRM in this phase. Keep future GoHighLevel integration
behind a provider interface. Never claim a real CRM is connected based
only on configuration presence.

#### 7.12 Integrations

Provide status for AI, Meta Ads, and GoHighLevel. Each should state
mock/configured-but-unverified/verified/unavailable/disabled, available
capabilities, last test result, setup guidance, and permission
limitations.

A connection test must say whether it is simulated or live. Never show
credentials. Meta account selection must be workspace-authorized and
server-validated. Do not enable live ad creation/publishing. Real GHL
actions remain deferred. Do not imply secure production credential
storage until a managed key provider is available and verified.

#### 7.13 Workspace and member management

Where backend support exists, provide workspace settings, member
list/roles, authorized member changes, and ownership actions. Enforce
permissions server-side. Prevent self-assigned owner/admin roles and
invalid ownership transitions. Do not expose tokens or unnecessary
identifiers. If OIDC/PKCE onboarding is not configured, document the
local-development limitation.

#### 7.14 Activity and audit

Provide persisted activity for Business Brain edits, website
analyses/reviews, campaign changes/versioning, proposals,
approvals/rejections/execution, lead intake/deduplication/status,
integration tests/settings, member/workspace changes, AI
usage/reservations/blocked requests, and job state changes.

Events should include timestamp, workspace, server-derived actor when
known, action, target, result, and safe context. Do not store secrets or
unnecessary personal data. Ordinary users must not be able to edit audit
history. Identify simulated actions.

#### 7.15 Settings and developer mode

Ordinary settings: workspace/business settings, marketing preferences
where supported, integrations, authorized member management, and usage.

Developer mode: AI mode/provider status, safe configuration diagnostics,
mock/live explanation, diagnostic results without secrets, and gated
test controls. Do not clutter the primary workflow with
environment-variable instructions.

#### 7.16 Usage and cost page

Show provider/model, request counts, token counts when reliable, actual
cost when calculable, unknown usage and unverified holds, monthly
ceiling/used/reserved/remaining, daily cap/count, blocked requests, and
reasons. Clearly label estimates and unverified pricing. Never show
unknown cost as zero.

### 8. Data integrity and migrations

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

### 9. Security and privacy

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

### 10. UX and accessibility

Use plain language. Make the five steps visible. Use consistent status
labels: draft, needs review, awaiting approval, approved, simulated,
running, completed, failed. Do not rely on color alone. Support keyboard
access and visible focus. Label form controls. Prevent accidental double
submission. Show pending states and actionable errors. Confirm
destructive/consequential actions. Ensure mobile/tablet/desktop layouts
work without horizontal overflow. Remove dead controls. Explain empty
states. Distinguish generated suggestions from saved facts.

### 11. Testing and QA

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

## 4. Expanded product architecture and capabilities

The following requirements extend and clarify the baseline module specifications. They are mandatory product requirements, not optional ideas. Deliver them in the dependency order in Section 7; staged delivery does not mean removing them from the target product.

### C1. Organization, workspace, membership, and authorization foundation

**Organization/account layer**
- Represent an agency or other organization that can manage multiple workspaces.
- A direct business may begin with a single workspace without having to understand agency terminology.
- Provide a workspace switcher and a clear indication of the active client/business.
- Allow a user to belong to multiple organizations/workspaces with different permissions.
- Prevent data, assets, leads, campaign results, and provider credentials from leaking across workspace boundaries.

**Workspace layer**
- Each client/business workspace owns its Business Brain, Brand Kit, campaigns, creative assets, leads, integrations, calendar, analytics, approvals, usage records, and audit events.
- Shared agency templates may be reused across workspaces only through explicit copy/import or a clearly authorized shared-library mechanism. A client’s private data must not become agency-wide shared data by default.

**Custom permissions**
- Start with editable predefined role templates, then allow authorized owners/admins to customize capabilities.
- Permission dimensions should include: view, create, edit, delete/archive, submit for approval, approve/reject, execute/publish, manage members, manage integrations, manage budgets, access analytics, export data, and manage billing/plan settings if billing is implemented.
- Define scope: organization-wide, selected workspaces, or specific resource/action where justified.
- Keep approval permissions distinct from campaign editing and execution permissions.
- Support optional separation of duties, such as preventing a creator from approving their own campaign.
- Record invitations, membership changes, role/permission changes, approval decisions, and sensitive setting changes in audit history.
- Enforce every permission on the server. UI hiding is not authorization.
- Provide a permission preview or “What can this role do?” explanation before saving custom roles.
- Prevent accidental lockout of the last owner and invalid ownership transitions.

**Dependencies:** authenticated actor identity → organization/workspace membership → server-side authorization policy → audit logging → member-management UI. Custom permissions must not be built only as a frontend feature.

### C2. Business Brain and Brand Kit

Keep the existing evidence-grounded Business Brain, including provenance, explicit owner review, safe website analysis, and preservation of owner-entered content. Extend the model to support a separate **Brand Kit** for repeatable creative production.

Brand Kit should support:
- Logo files and approved logo variants.
- Brand colors, typography guidance, visual style, and image treatment.
- Brand voice, preferred terminology, words/claims to avoid, and CTA style.
- Approved service descriptions, offers, disclaimers, credentials, and proof points.
- Audience profiles and service areas.
- Creative examples, reference assets, and channel-specific requirements.
- Asset source, owner, license/usage rights, approval state, and expiry/review date where relevant.

Business facts and brand preferences are different kinds of information. A visual preference must not be treated as evidence that a business claim is true. Every material business claim used in generated copy or creative must retain its source/review status.

Provide a setup path for users with no website and an agency onboarding path that can reuse a template without copying another client’s private facts.

**Dependencies:** workspace isolation → Business Brain schema/provenance → file/asset storage abstraction → Brand Kit UI and validation → campaign/creative generation context.

### C3. Marketing Planner and multi-campaign engine

Campaign creation must support three first-class modes:

1. **Create one campaign:** the user selects a goal and creates/reviews a single campaign.
2. **Recommend a campaign plan:** MotiveStack proposes a coherent plan containing several distinct campaign opportunities, sequencing, suggested channels, audiences, offers, timing, and budget allocation where the necessary facts are available.
3. **Create campaigns in a batch:** the user selects several approved opportunities or a plan and generates multiple campaign drafts in one operation.

A plan is not itself an approved ad campaign. Each generated campaign must be a separate entity with its own objective, audience, offer, geography, budget, dates, creative assets, versions, status, approvals, execution state, and results. A plan may group campaigns and express dependencies or sequence, but one campaign’s approval must not silently approve the others.

The engine must:
- Support multiple concurrent campaigns per workspace.
- Detect near-duplicate campaign ideas and explain how proposed campaigns differ.
- Distinguish “the website does not mention this” from “the business does not offer this.”
- Ask the owner to confirm new services, offers, prices, discounts, guarantees, service areas, or other material facts before using them as claims.
- Mark missing evidence as unknown; never fill gaps with fabricated facts.
- Allow a plan to contain campaigns that use different messages, audiences, offers, or stages of the funnel.
- Provide plan-level overview and per-campaign detail.
- Support per-campaign and plan-level budget proposals, with hard limits and explicit allocation rules. The system must not multiply a total budget accidentally when generating a batch.
- Require a clear review of the total proposed budget and each campaign’s budget before approval.
- Allow users to exclude an opportunity, edit it, regenerate it, or save it for later.
- Keep batch generation resumable and idempotent so a partial failure does not duplicate campaigns.
- Track campaign status and approval independently, even when grouped under one plan.

Suggested campaign lifecycle:
`idea → brief/draft → needs review → ready for approval → approved → scheduled/ready for execution → simulated or externally executed → completed/paused/archived`.
Use the existing domain vocabulary if it is materially better, but document a single state machine and validate transitions server-side.

**Dependencies:** workspace/permissions → Business Brain/Brand Kit → campaign schema and state machine → versioning and approvals → plan/batch orchestration → creative production → calendar and execution adapters.

### C4. Creative Studio — integrated image, video, and ad production

The Creative Studio is a core product capability, not a link-out-only tool. It should coordinate copy, static images/posters, carousels, and video in one workflow while using external generation providers behind replaceable adapters.

**Creation workflow**
1. Choose a campaign or create a campaign brief.
2. Choose platform, placement, format, objective, audience, and CTA.
3. Generate several distinct creative concepts, not merely superficial rewrites.
4. Review the message, visual direction, storyboard or layout, and required assets.
5. Generate or import the asset through an available provider.
6. Inspect and revise the output; retain versions and provenance.
7. Run technical, brand, policy, and factual quality checks.
8. Submit the exact creative/copy/campaign version for approval.
9. Attach approved assets to the correct campaign version and make them available for simulated execution or later authorized publishing.

**Formats**
- Static ad/poster with relevant aspect-ratio variants.
- Carousel with ordered cards and a coherent narrative.
- Short-form video with storyboard, scene plan, duration, captions/subtitles, CTA, and aspect-ratio variants.
- Copy-only creative when media generation is unavailable.
- Imported assets with source and rights information.

**Provider architecture**
- Define capability-aware adapters for image generation, video generation, editing/variation, and optional voice/audio generation.
- Do not hard-code the product to one vendor/model.
- Track provider capabilities, unsupported formats, limits, job state, failures, estimated/actual cost when known, and output references.
- Use asynchronous, persisted jobs for long-running media generation; support progress, cancellation where safe, bounded retry, and safe failure recovery.
- Never report a render as complete until an output asset has been persisted and validated.
- Keep keys and provider calls server-side. In the current implementation phase, use mocks/fixtures only; do not make live media-generation calls.

**Creative quality gate**
- Check brand consistency, message clarity, offer/CTA alignment, legibility, safe margins, aspect ratio, resolution, text rendering, spelling, factual claims, disclaimers, platform requirements, accessibility (including captions/contrast where relevant), and asset rights.
- Provide specific repair suggestions rather than only a numeric score.
- Distinguish deterministic checks from AI-assisted critique and human approval.
- A quality score is a review aid, not a promise or prediction of conversion.
- Do not invent customer images, testimonials, before/after results, endorsements, or evidence.
- Preserve editable copy and structured creative briefs even if the generated image/video itself is not editable.
- Make it clear when generated media may contain visual errors or require human review.

**Dependencies:** Brand Kit and campaign brief → asset library and storage → provider/job abstraction → technical validation → creative QA → versioned approval → campaign attachment. Implement image support before video if that is the smallest reliable vertical slice, while keeping the interface provider-neutral.

### C5. Asset library and rights management

Provide a workspace-scoped asset library for logos, images, video, posters, carousels, templates, and imported files. Assets should have:
- Type, dimensions/duration, file size, preview, source, provider/model when generated, creation date, creator, and related campaign/version.
- Draft, needs review, approved, rejected, superseded, or archived status.
- Rights/license/source notes and any known usage restrictions.
- Version history and relationships between source asset, edited version, and campaign usage.
- Duplicate detection where practical.
- Clear behavior when an asset used in an approved campaign is replaced: the previous approved campaign version remains reproducible and the replacement requires review.

Do not store large media blobs in SQLite if the existing architecture is unsuitable. Inspect current storage and design a local development abstraction that can later support managed object storage without locking the product to one implementation. No production storage claims until backup, access control, retention, and recovery are tested.

### C6. Marketing calendar and workflow coordination

Provide a calendar/board showing campaign plans, draft milestones, review deadlines, approved content, scheduled items, and results. In mock mode, distinguish a proposed schedule from a real platform schedule. Calendar entries should link to the campaign, creative version, owner, approver, and job status.

Include a shared task/approval inbox with:
- Work needing the current user’s attention.
- Campaigns awaiting review or approval.
- Creative assets awaiting review.
- Failed or blocked jobs and actionable recovery.
- Missing Business Brain facts that block campaign generation.
- Upcoming planned dates and overdue tasks.

Notifications may initially be in-app. Email/SMS/push notifications are future integration work and must not be sent live during this implementation phase.

**Dependencies:** campaign lifecycle → versioned assets → roles/assignments → approval states → jobs → calendar and attention center.

### C7. Leads, funnel, and conversion tracking

Extend leads beyond a simulated CRM list into a measurable path from campaign to business outcome, in staged form:
- Store source campaign, creative variant, landing page/form, UTM parameters, capture time, consent/source metadata where applicable, lead status, and follow-up status.
- Provide deduplication and event idempotency.
- Show whether a lead is synthetic, imported, or real and whether attribution is observed, inferred, or unknown.
- Provide a basic landing-page/form capability only after the campaign and asset foundations are stable; use templates and clear form-field/privacy settings.
- Keep real CRM writes, email/SMS follow-up, tracking pixels, and advertising-platform event transmission disabled unless separately authorized and implemented with privacy controls.
- Support a future closed-loop view: campaign → lead → qualified lead/opportunity → outcome, only where the data is actually available.

Do not claim that a campaign caused a sale merely because a lead arrived after it. Show attribution coverage and uncertainty.

**Dependencies:** campaign identity/versioning → UTM/source schema → lead event processing → analytics definitions → consent/privacy review → optional CRM/landing-page integrations.

### C8. Analytics, experiments, and Marketing Brain

Analytics must distinguish:
- Actual data returned by a verified integration.
- Imported data.
- User-entered data.
- Simulated/demo data.
- Estimates and unknown values.

Never blend simulated and real performance without prominent separation. Do not fabricate impressions, clicks, conversions, ROAS, or campaign success. When no verified performance data exists, show readiness, operational progress, and missing measurement setup—not fake performance charts.

Experiment support should include:
- A hypothesis, the single principal variable being tested, audience/placement, variants, success metric, duration, and decision rule.
- Versioned creative/campaign variants and a record of which variant was actually used.
- Minimum-data and uncertainty warnings.
- No claim of statistical significance unless the method and data support it.
- No automatic budget shift or campaign edit without approval.

Marketing Brain stores reviewed, traceable learnings: past campaigns, approved/rejected messages, used creative concepts, experiments, actual outcomes, audience insights, seasonality, constraints, and known unknowns. Every learning must identify its source, date, confidence/limitations, and whether it is human-confirmed or machine-suggested. Recommendations must not become business facts merely because the AI repeated them.

**Dependencies:** event/metric definitions → verified or explicitly labeled data sources → campaign/creative version lineage → reporting → experiment analysis → Marketing Brain learning records.

### C9. Budget and resource planning

Support a workspace budget and optional plan-level allocation. Display total proposed spend, per-campaign allocation, duration, estimated media spend, estimated generation cost, and known recurring/provider costs separately. Do not combine AI generation costs with advertising spend into one unlabeled figure.

Enforce:
- Workspace and plan ceilings where configured.
- Campaign-specific caps.
- Atomic reservation of provider-generation costs.
- Explicit approval for budget changes that cross configured thresholds.
- Clear treatment of unknown prices and currency.
- No live spend or publishing during this implementation phase.

Agency users need a cross-workspace overview, but totals must respect access permissions and currency boundaries.

### C10. Integrations and execution adapters

Keep Meta Ads and GoHighLevel/CRM simulated during implementation. Model integrations as capability-aware adapters with honest states such as mock, configured-unverified, verified, limited, disabled, or unavailable. Show exactly which actions each adapter supports.

The architecture may prepare future adapters for other channels (for example, Google Ads, TikTok, email/SMS platforms, analytics, and calendar tools), but do not implement all channels before the first end-to-end workflow is reliable. Each future channel must declare its own capabilities, approval requirements, limits, data provenance, and failure behavior.

Publishing/scheduling, real ad spend, real customer outreach, and external CRM mutations remain approval-gated and separately authorized.

### C11. SaaS operational foundations

Before public production launch, evaluate and implement as needed:
- Authentication and secure session lifecycle.
- Tenant/workspace isolation and organization-level access control.
- Managed secret/credential storage.
- File/media storage permissions and backup/retention.
- Usage quotas and cost attribution by workspace and provider.
- Subscription/plan entitlements if the business model requires them.
- Audit export, data export/deletion, recovery, and retention policies.
- Rate limiting, monitoring, alerting, and incident response.
- Time zones, locale/currency handling, and accessibility.
- Clear onboarding, demo data labels, and account/workspace switching.

These are production-readiness requirements, not proof that the current local application already provides them.

## 5. Cross-cutting product rules

1. **Approval-first:** campaign publishing, external spend, CRM mutations, customer messaging, budget increases beyond configured policy, and other consequential actions require explicit authorization. Mock actions must be visibly simulated.
2. **Version-bound approvals:** approvals apply to an exact campaign/creative/plan version and become stale when a material field changes.
3. **Evidence over invention:** unsupported business facts remain unknown or flagged. A missing website statement is not proof that the business does not offer a service.
4. **Workspace and client isolation:** every database query, job, asset, integration, analytics view, and audit record is scoped and authorized server-side.
5. **Cost transparency:** provider, request/job count, estimated/actual/unknown cost, reservation, and limit status are visible where relevant.
6. **Provider-neutrality:** model capabilities are explicit; the app can function with mock providers and graceful fallback when a provider cannot generate a requested format.
7. **Human review:** AI recommendations, generated copy, and generated media are drafts until approved by an authorized person.
8. **Traceability:** retain the chain from source/business fact to plan, campaign, creative asset, approval, execution, lead, and measured result.
9. **No false analytics:** simulated, imported, actual, estimated, and unknown values must never be silently mixed.
10. **Recoverability:** long-running jobs are persisted, bounded, idempotent, and safe to retry.

## 6. Dependency map

The following dependency order should guide implementation. It is a logical dependency map, not an instruction to rewrite existing working code.

| Capability | Must exist first | Enables |
|---|---|---|
| Organization/workspace membership | Verified actor identity and migration-safe data model | Agency/client hierarchy, custom permissions, scoped dashboard |
| Custom authorization | Membership model, policy service, audit events | Team management, approval separation, safe agency access |
| Business Brain and provenance | Workspace scope, source/review model | Reliable plans, claims, campaign briefs, learning records |
| Brand Kit | Workspace scope, asset metadata/storage | Consistent copy, image/video generation, templates |
| Campaign and plan data model | Workspace scope, Business Brain, lifecycle/state rules | Single campaigns, campaign plans, batch generation, calendar |
| Versioning and approvals | Campaign/asset version identity, permissions, audit | Safe batch approval, creative approval, simulated execution |
| Asset library/storage | Workspace scope, file validation, metadata and rights | Integrated Creative Studio, campaign asset linking |
| Provider/job abstraction | Server-side provider boundary, cost controls, durable job state | Async image/video generation, retries, provider switching |
| Creative QA | Structured briefs/assets, platform requirements, Brand Kit | Quality gates and approval-ready ads |
| Calendar/task inbox | Campaign/asset states, assignments, jobs | Team coordination and attention workflow |
| Lead attribution | Campaign/version IDs, source/UTM schema, lead events | Funnel reporting and closed-loop measurement |
| Analytics/experiments | Metric definitions, trustworthy data lineage | Optimization, evidence-backed Marketing Brain |
| Production SaaS readiness | Authentication, isolation, secrets, storage, backup/monitoring | External customer launch and paid plans |

## 7. Authoritative implementation roadmap

This roadmap replaces the earlier Phase 0–8 roadmap. Do not follow an older roadmap where it differs from this one.

**Roadmap principle:** design for the all-in-one destination, but deliver coherent, testable vertical slices. “All-in-one priority” means architecture and navigation should fit together; it does not mean implementing every module in parallel.

### Phase 0 — Repository and data safety baseline
- Inspect branch/HEAD, working-tree changes, database migration state, routes/services, UI, tests, provider modes, and current behavior.
- Map the refined requirements to existing code and tests: complete, partial, missing, unsafe, or deferred.
- Identify data-model conflicts before proposing migrations.
- Do not implement until this gap report is delivered and reviewed.
- No commits, resets, destructive database operations, or live provider calls.

**Exit:** evidence-based feature matrix, dependency plan, migration plan, and risk list.

### Phase 1 — Multi-tenant domain foundation and custom permissions
- Define the organization/account → workspace/client relationship that fits the existing app.
- Audit and strengthen workspace scoping and server-derived actor identity.
- Implement membership, editable role templates/custom permission policies, invitations or the smallest supported local equivalent, and permission/audit tests.
- Preserve direct-business onboarding as a simple single-workspace path.
- Do not add agency-wide sharing until private client isolation is proven.

**Exit:** tests prove allowed and denied access across users, organizations, and client workspaces; migration preserves existing data.

### Phase 2 — Business Brain, Brand Kit, and asset metadata foundation
- Complete evidence/provenance review and no-website onboarding.
- Add Brand Kit data and review workflow.
- Add workspace-scoped asset metadata, upload/import validation, rights/source fields, and version lineage.
- Establish a storage interface without claiming production object storage exists.
- Keep generation mocked.

**Exit:** owner facts and brand preferences are distinct, traceable, editable, and safely scoped.

### Phase 3 — Campaign plans, multi-campaign generation, versioning, and approvals
- Establish or refine campaign, plan, and plan-to-campaign relationships.
- Support single campaign, recommended plan, and batch draft creation.
- Add duplicate-opportunity checks, plan-level budget allocation, per-campaign budgets, partial-failure recovery, and idempotency.
- Enforce a server-side campaign state machine.
- Bind approvals to exact versions and implement optional separation of duties.

**Exit:** a user can generate several distinct campaigns, edit each independently, review total and per-campaign budgets, and approve only the intended versions; all actions are mocked and audited.

### Phase 4 — Integrated Creative Studio, starting with image assets
- Define capability-aware image/video provider interfaces and persisted generation jobs.
- Implement mock image generation and the complete brief → concept → asset → QA → revision → approval → campaign-link flow.
- Add brand/factual/technical checks and human-readable repair guidance.
- Add image format variants and imported assets.
- Keep video provider support in the architecture; implement mock storyboard/video jobs after image flow is stable.

**Exit:** no asset is marked complete without a validated persisted output; versions and approvals remain reproducible.

### Phase 5 — Team operations, calendar, jobs, and attention center
- Assign campaign/creative ownership and reviewers.
- Add task/approval inbox, calendar, job progress/failures, and notifications within the app.
- Ensure every task links to the exact campaign/asset version and required action.
- Keep email/SMS/push notifications disabled.

**Exit:** a team can coordinate drafts, reviews, due dates, and recoverable jobs without relying on external messaging.

### Phase 6 — Leads, funnel foundations, and truthful analytics
- Complete lead list/detail, source campaign/version, UTM metadata, status history, and event deduplication.
- Establish a basic landing-page/form architecture only after campaign and asset lineage are stable.
- Define metric provenance and clearly separate synthetic, imported, actual, estimated, and unknown data.
- Build reporting from available data; do not create fake performance metrics.

**Exit:** users can trace available lead records to their sources and see what is and is not measurable.

### Phase 7 — Experiments, Marketing Brain, and recommendations
- Add experiment plans and variants with explicit hypotheses and decision rules.
- Build evidence-backed learning records from approved messaging, actual data, and human-confirmed findings.
- Generate optimization recommendations with uncertainty and approval requirements.
- Do not automatically change spend or publish.

**Exit:** recommendations can be traced to real or clearly labeled evidence and do not masquerade as verified business facts.

### Phase 8 — Integrations and controlled execution readiness
- Complete adapter capability/status UX and mock Meta/CRM end-to-end tests.
- Review future Meta/GHL/other-channel permission scopes and action contracts.
- Prepare—but do not activate—external publishing and CRM mutation flows.
- Keep all external execution disabled pending separate authorization and integration-specific review.

**Exit:** the system accurately describes available capabilities and cannot accidentally perform an external action in mock mode.

### Phase 9 — Security, reliability, and production-readiness assessment
- Review authentication, organization/workspace isolation, custom permissions, secrets, file access, backup/recovery, quotas, rate limits, monitoring, audit, privacy, export/deletion, and tenant cost attribution.
- Fix critical/high-risk issues before public deployment.
- Document any requirement not implemented.
- Subscription/billing work is only included if the product’s commercial model and requirements are explicitly decided.

**Exit:** an evidence-based launch-readiness report; do not claim production-ready merely because tests pass.

### Phase 10 — Full offline QA and documentation
- Run typecheck, targeted tests, full offline suite, browser workflow, responsive/accessibility checks, migration-upgrade tests, workspace-boundary tests, and network-call audit.
- Test direct-business and agency-with-multiple-clients scenarios.
- Test all three campaign creation modes and multi-asset approval/version behavior.
- Update README, architecture notes, feature matrix, environment guidance, and acceptance report.

**Exit:** all implemented workflows work end-to-end in mock mode; unresolved items are explicitly listed.

### Deferred phase — Live AI/media and external integrations
Live OpenAI, image/video provider calls, Meta Ads, and GoHighLevel operations remain outside the current implementation authorization. Each needs separate approval that identifies provider, operation, data sent, model/capabilities, expected cost, limits, and rollback/stop conditions. Do not infer authorization from this PRD.

## 8. Claude Code implementation workflow and baseline acceptance

### Required workflow for Claude Code

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

### Baseline acceptance checklist

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

### Required first response from Claude Code

Before implementing, report: 1. Current branch and HEAD. 2. Modified and
untracked files. 3. Current migration version and pending migrations. 4.
A feature-to-code/test mapping with evidence. 5. Prioritized gaps,
severity, and dependencies. 6. Proposed phase sequence. 7. Any conflicts
or product decisions required.

Then begin Phase 0. Preserve the working tree and database, remain
offline, and do not commit.

## 9. Additional acceptance criteria

### Agency and permissions
- [ ] A direct business can use one workspace without unnecessary agency setup.
- [ ] An agency can switch among multiple client workspaces.
- [ ] Users can have different permissions in different workspaces.
- [ ] Custom permissions are enforced server-side and have an audit trail.
- [ ] Cross-client access attempts are denied and tested.
- [ ] Optional separation of duties prevents self-approval when configured.

### Campaign planning
- [ ] Users can create a single campaign, request a recommended multi-campaign plan, or batch-create drafts.
- [ ] Each campaign has independent lifecycle, version, budget, assets, and approval.
- [ ] Plan-level budget allocations reconcile with campaign-level amounts.
- [ ] Batch generation is idempotent and recovers safely from partial failure.
- [ ] Duplicate concepts are identified or differentiated.
- [ ] Missing website information is not treated as proof a service is unavailable.

### Creative Studio
- [ ] Copy, static image/poster, carousel, and video/storyboard workflows are represented in the product architecture.
- [ ] Image generation is fully testable with mock providers before any live provider is enabled.
- [ ] Provider capability and failure states are explicit.
- [ ] Asset versions, rights/source, campaign links, and approval status are retained.
- [ ] Technical, brand, and factual QA results are visible and actionable.
- [ ] Generated media is not automatically approved or presented as guaranteed to convert.

### Operations and measurement
- [ ] Calendar and attention inbox are backed by real persisted records.
- [ ] Jobs are bounded, idempotent, recoverable, and safe to retry.
- [ ] Leads carry source/attribution fields where available and preserve unknown attribution honestly.
- [ ] Analytics never silently mix actual, imported, estimated, and simulated data.
- [ ] Experiments record hypotheses, variants, metrics, and decision rules.
- [ ] Marketing Brain learnings are traceable to their source and confidence.

### Global rules
- [ ] The application remains mock/offline by default.
- [ ] No live provider or external execution call is made without separate authorization.
- [ ] Migrations are additive and preserve existing data.
- [ ] No commit, reset, stash, or destructive action occurs unless explicitly requested.

## 10. Final completion gate

MotiveStack is not considered complete merely because pages render or a happy-path demo works. Before calling the target scope complete, Claude Code must demonstrate all of the following:

- Every requirement in this document is mapped to code, a test, and a status; any explicitly deferred item is labelled and justified.
- Organization/workspace boundaries are enforced server-side, including negative tests for cross-tenant access.
- Role templates and custom permissions are enforced on the server, and approval authority is separated from execution authority where configured.
- Business facts and generated recommendations retain provenance, freshness/verification status, and traceable links to source evidence.
- Campaigns remain independent records with their own objective, audience, offer, budget, assets, version, approval state, lifecycle status, and results.
- Campaign and creative approvals are bound to the exact version approved; changing material content invalidates the relevant approval.
- Creative assets have provider/source metadata, versions, workspace ownership, rights/provenance fields, and review status.
- Jobs are persisted, observable, retry-bounded, idempotent where appropriate, and safe to resume after interruption.
- Analytics distinguish real data from simulated/demo data and never imply that mocked execution or fabricated performance is real.
- AI/media/provider usage is bounded by preflight controls, configured limits, usage accounting, and a global hard ceiling.
- Default test, development, and QA workflows run offline with mocked adapters; tests prove that no external calls occur by default.
- Database changes are forward-only and additive unless the user explicitly authorizes a narrowly scoped exception.
- Security, privacy, export/deletion behavior, operational logging, backup/recovery guidance, and production-readiness gaps are documented.
- The full offline test suite and type checks pass, with skipped tests and known limitations explained.
- No unapproved live calls, external publishing, CRM mutations, email/SMS, commits, pushes, destructive Git operations, or database resets have occurred.
