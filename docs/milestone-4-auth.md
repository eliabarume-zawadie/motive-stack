# Milestone 4: authentication, workspace authorization, credentials

Status: **M4.1 (authentication foundation) and M4.2 (workspace membership and authorization) are implemented. M4.3 to M4.5 are plans only.** Nothing here has been run against a real identity provider, and no sign-in flow works end to end yet: that depends on a provider choice (below).

## What M4.1 delivers, and what it does not

Implemented and covered by offline tests (`test/auth.test.ts`, `test/authServer.test.ts`):

- **A provider-agnostic OpenID Connect verifier** (`src/auth/oidc.ts`) built on `node:crypto` only (no new dependency). Order: structure, algorithm, key, **signature**, then claims. It accepts RS256 and ES256 only; rejects `none`, HMAC and anything else; requires a `kid`; rejects `crit`; never uses `jku`, `x5u` or an embedded `jwk`; refuses RSA keys under 2048 bits, keys with private parts, and keys whose `use` or `alg` do not fit. Claims checked: exact `iss`, `aud` (string or list), `exp` (required), `nbf`, `iat`, and a non-empty `sub`. Default clock tolerance is 60 s.
- **Key sets** (`src/auth/jwks.ts`): HTTPS-only, no credentials in the URL, no redirects, size-capped, cached, and refreshed on an unknown key id at most once per cooldown so a flood of bad key ids cannot make the server hammer the provider. If the provider is unreachable, cached keys keep working and anything else fails closed (503), never open.
- **Internal users** (`004_users.sql`, `src/app/users.ts`): keyed by the provider's `(issuer, subject)`. Email is informational, stored only when the provider marks it verified, and never an identity key.
- **Authentication in `onRequest`** (`src/server/auth.ts`), so a request without valid credentials is refused before its body is read. Routes are **default-deny** under `/api/`; the only public ones are `GET|HEAD /api/health`, `GET|HEAD /api/config` and `POST /api/workspaces` (see "Transition"). A test registers an undeclared route and proves it is refused.
- **`GET /api/me`** returns the signed-in person (only when `AUTH_MODE=oidc`; 404 otherwise).
- **Server-derived approval attribution.** `approvals.decided_by` and the audit actor are the authenticated principal (today `workspace-token:<workspaceId>`), not the name typed into the form. The typed name is kept in `approvals.claimed_label` and in the audit detail with `claimedLabelVerified: false`, for people reading the history; nothing authorizes on it.
- **A UI boundary** (`Auth` in `public/app.js`) and `auth` in `/api/config` (mode, issuer, audience, public client id).

Not implemented, on purpose:

- **No sign-in flow in the browser.** No fake login, no client secret in frontend code. Authorization Code with PKCE needs a provider and a registered redirect URI.
- **The workspace token is still stored in `localStorage`.** It cannot be removed until a person can sign in instead; removing it now would lock users out. The removal is part of completing the migration (M4.2).
- *(M4.2 changed this: a verified person now reaches a workspace only through an active membership; see Milestone 4.2 below.)*
- No rate limiting, no CSRF/cookie handling (tokens travel in the `Authorization` header), no security headers or CSP. These are listed under M4.2 and M4.5.
- The client-supplied `decidedBy` field is still required by the approval endpoint (it feeds the unverified label only). Removing it is an API change left for a later cleanup.

## Configuration

| Variable | Meaning |
|---|---|
| `AUTH_MODE` | `workspace_token` (default) or `oidc` |
| `OIDC_ISSUER` | Exact issuer string; https |
| `OIDC_AUDIENCE` | This API's identifier |
| `OIDC_JWKS_URI` | The provider's key-set URL; https |
| `OIDC_CLIENT_ID` | Optional; the public client id the browser will use (no secret) |
| `OIDC_ALGORITHMS` | Optional subset of `RS256,ES256` |

A half-configured `oidc` setup stops the server at startup. There is no mode that skips verification and no test-only mode in production code; tests inject their own in-memory keys.

## Transition from workspace tokens

1. **M4.1:** a workspace token is never a user, and a user token never opens a workspace.
2. **M4.2 (done):** a signed-in person claims an existing workspace by presenting its token once and becomes its **owner**. New workspaces are created by a signed-in person, who becomes owner (`POST /api/workspaces` is public only while no identity provider is configured). An owner can disable a workspace's token.
3. **Still to do:** remove the token path and the `localStorage` copy once people can really sign in in the browser; move remaining machine access to scoped, revocable integration tokens.

*Product decision needed:* whether one person may belong to several workspaces. M4.2 is planned on the assumption that **yes**, so the workspace is always taken from the URL and checked against the user's memberships, never inferred from the user.

## Identity provider: decision deferred (deployment prerequisite)

Pricing, regional availability and feature terms change and cannot be verified offline, so no provider is selected here. The code needs only a standards-compliant OIDC provider that issues signed JWTs (RS256 or ES256) and publishes a JWKS. Criteria to apply when choosing:

| Criterion | What to confirm |
|---|---|
| Flows | Authorization Code with PKCE for the browser; JWT access tokens whose `aud` can be set to this API |
| MFA and recovery | Built-in MFA, email verification, account recovery and user lifecycle (disable, delete) |
| Region and data residency | Available in the intended deployment region |
| Pilot cost | Free or low tier covers the pilot user count; what a user, an MFA factor or a custom domain costs |
| Backend fit | Plain JWKS verification (done); no vendor SDK required |
| Portability | Standard OIDC claims only; users keyed by `(issuer, subject)` so a later migration means re-linking, not a rewrite |

Candidates to evaluate (not verified, not ranked): Auth0, Amazon Cognito, Microsoft Entra External ID, Google Cloud Identity Platform, WorkOS AuthKit, and self-hosted Keycloak (most control, highest operating burden). A password system built in-house is out of scope.

## Plans for the remaining phases (not started)

### M4.2: workspace authorization
Implemented; see the next section.

### M4.3: encrypted per-workspace credentials
- Table `workspace_credentials(id, workspace_id, kind, status, label, last4, key_version, ciphertext, nonce, wrapped_key, created_at, rotated_at, revoked_at)`; kinds `openai`, `anthropic`, `meta`, `ghl` (future), each with its own adapter. AI-provider keys and Meta OAuth tokens never share a code path.
- Authenticated encryption (for example AES-256-GCM) with a per-record data key wrapped by a master key held in a managed key service **outside the database**. The workspace id and credential kind are authenticated data, so a ciphertext copied to another workspace fails to decrypt. Key versions are stored on each record; rotation re-wraps data keys.
- A `KeyService` interface with a fake implementation for offline tests. No real key service is chosen or activated in this phase, and there is no hard-coded production key and no key stored beside the ciphertext.
- Providers are built per workspace at call time (changes to `src/ai/stack.ts` and `src/app/context.ts`), with the current environment variables kept as an explicit operator fallback until M4.4.

### M4.4: credential lifecycle
- Create, replace, masked status, revoke, delete. The API never returns a secret after it is saved (status, label and last four only). Audit events record ids, kinds and actions, never values. Revoke makes the credential unusable immediately (fail closed). Delete removes ciphertext and key references and leaves a tombstone event. Provider-side token revocation is an external action and stays out of scope until separately authorized.

### M4.5: security gates
- Offline regression suite: unauthenticated, cross-workspace, membership revoked, credential encryption boundaries, redaction in logs, errors and API responses, jobs without authorization, approval-first and audit trail regression. Secret scanning and an unscoped-query check in CI. Rate limiting and security headers. Release is blocked unless the suite passes.

## Compatibility and rollback (M4.1)

- Defaults are unchanged: `AUTH_MODE` defaults to `workspace_token`, mock mode stays the default, and no live setting is touched.
- Behavior changes: unauthenticated requests with malformed or oversized bodies now get 401 instead of 400 or 413; the stored and displayed approver is the principal (for example `workspace-token:ws_...`) with the typed name shown as a note; `decided_by` values written by earlier versions stay as they were.
- Rollback: revert the commit. Migration 004 is additive (a `users` table and a nullable `approvals.claimed_label` column); leaving them in place under older code is harmless. No existing table was rewritten and no data was removed.

## Milestone 4.2: workspace membership and authorization (implemented)

Offline tests: `test/authz.test.ts` (33), updated `test/authServer.test.ts`. Product decision applied: **a person may belong to several workspaces**; the workspace always comes from the URL and is checked against that person's memberships, never inferred from the person.

### Model
- `workspace_memberships(workspace_id, user_id, role, status active|revoked, created_by, revoked_by, ...)`, unique per `(workspace_id, user_id)`, role constrained to `owner|admin|operator|viewer`. Removing a member sets `status = 'revoked'` (history stays in `audit_events`); adding them again reactivates the row. A workspace always keeps at least one active owner.
- The role is read from the database on **every** request. Nothing about roles lives in a token, a cookie, a header or a body, and claims such as `role` inside a token are ignored (tested).
- `approvals.approver_kind` (`user`, `legacy_token`, `unverified`) and `approvals.approver_user_id` make the approver checkable later. `decided_by` stays as the readable label.

### Status policy (the same everywhere)
| Status | When |
|---|---|
| 401 | No credentials, or credentials that do not verify (or a disabled workspace token) |
| 404 | Authenticated but not an active member of the workspace: identical to a workspace that does not exist (tested route by route). Also any resource that is not in the workspace named in the URL: services scope every query to it |
| 403 | An active member whose **current** role does not allow the operation, or a workspace route with no declared permission (fail closed) |
| 503 | The identity provider's keys could not be obtained; never a pass |

### Permission matrix (minimum role; each role includes those below it: viewer < operator < admin < owner)
| Permission | Min role | Routes |
|---|---|---|
| workspace.read, brain.read, campaigns.read, proposals.read, leads.read, activity.read, ai.settings.read, ai.usage.read | viewer | the matching GET routes |
| jobs.read | operator | GET jobs |
| campaigns.generate, campaigns.edit, proposals.create, leads.simulate | operator | generate, edit brief, create proposal, simulate lead (mock mode only) |
| proposals.decide | **admin** | approve, reject. **Operators cannot approve** |
| brain.write, workspace.update, ai.settings.write, ai.connection_test | admin | PUT brain, PATCH workspace, PUT AI settings, connection test |
| members.read | admin | GET members |
| meta_accounts.read | admin | GET meta-accounts (added in M4.2.2) |
| credentials.read | admin | `GET /credentials`: masked status only, for a signed-in person (never the legacy token); no secrets or key ids (M4.4a) |
| members.manage, legacy_token.disable | **owner** | add, change role, remove members; disable the workspace token. **Only an owner creates or transfers ownership; an admin cannot** |
| meta_accounts.manage | **owner** | authorize, disable, revoke a Meta ad account (M4.2.2) |
| credentials.manage | **owner** | `PUT /credentials/:kind`, `POST /credentials/:kind/revoke`, `DELETE /credentials/:kind`: owner-only, signed-in person only, `If-Match` for changes, rate-limited (M4.4b); never returns a secret |

The table is code (`PERMISSION_MIN_ROLE`, `ROUTE_PERMISSIONS` in `src/auth/authz.ts`), pinned by a test, and a test proves every workspace route has an entry and every entry is a real route. No permission skips approval-first execution, the budget ceiling, mock/live separation, payload-hash checks or the campaign safety rules; those live in the services and the executor and apply to every role. Credential permissions exist (M4.3) but guard only the vault's service layer; there is deliberately no HTTP route to them until M4.4, so credential management is unreachable over the API for every role.

### The legacy workspace token (transition)
Still accepted on workspace routes while enabled, as an **admin-equivalent principal that is never a user and never an owner, and whose approvals can authorize simulated (mock) actions only, never a live one** (M4.2.1): it cannot manage members or disable itself, cannot call `/api/me*` or claim, and its approvals are recorded as `workspace-token:<id>` with `approver_kind = 'legacy_token'`. An owner can disable it (`POST /api/workspaces/:wid/legacy-token/disable`); a disabled token never authenticates, and an approval it made stops authorizing even a simulated write. Workspaces created by a signed-in person get a random, never-revealed, already-disabled token.

### Migration `005_memberships.sql` and bootstrap
- **Backfill is deliberately empty.** Before this migration nothing links a person to a workspace, so any owner assigned automatically would be invented. Every existing workspace is *unclaimed*: it keeps working through its token and has no memberships.
- **Safe bootstrap:** a signed-in person calls `POST /api/workspaces/claim` with `{ workspaceId, token }`. It succeeds only if the token is valid and enabled **and the workspace has no active owner**; the person becomes its first owner (audited as `workspace.claimed`). The claim is atomic across connections and processes: a read-only pre-check keeps invalid claims off the write lock, then the decisive check and the write run in one `BEGIN IMMEDIATE` transaction, so a rival claim waits for the lock, re-checks, and gets `409 already_claimed`; if the lock is not free within SQLite's busy timeout the answer is a retryable `503 busy` with nothing written. A wrong token, a disabled token and an unknown workspace give the same 404; a second claim gets 409 `already_claimed`, so the token cannot be used to take over or add owners. After claiming, an owner adds colleagues and can disable the token. Operators can list unclaimed workspaces with `SELECT id, name FROM workspaces w WHERE NOT EXISTS (SELECT 1 FROM workspace_memberships m WHERE m.workspace_id = w.id AND m.status = 'active' AND m.role = 'owner')`.
- Existing approvals whose `decided_by` starts with `workspace-token:` are marked `legacy_token`; all others are `unverified`.
- **Database-level integrity** (SQLite cannot add composite foreign keys without rebuilding tables, so triggers do it): 11 insert triggers require a child row to carry the same `workspace_id` as its parent (campaign versions and assets, proposals, approvals, attempts, external resources, lead events, leads, CRM syncs), and 14 triggers forbid changing a row's `workspace_id`. Application queries (campaign children, approvals, attempts, external resources, leads, CRM syncs, status updates, executor updates) now also carry the workspace themselves instead of relying on an earlier scoped fetch.

### New routes
`GET /api/me/workspaces`, `POST /api/workspaces/claim`, `GET|POST /api/workspaces/:wid/members`, `PATCH|DELETE /api/workspaces/:wid/members/:uid`, `POST /api/workspaces/:wid/legacy-token/disable`. With `AUTH_MODE=oidc`, `POST /api/workspaces` needs a signed-in person (who becomes owner, and receives no token). Without an identity provider none of the person-level routes exist (404) and workspace creation stays public, exactly as before.

### Approval attribution and the executor
The approver is the authenticated actor: `user:<id>` (with `approver_user_id`) or `workspace-token:<id>`. The typed name is stored as `claimed_label` and in the audit detail with `claimedLabelVerified: false`. Right before an external write the executor checks the approver **now** (`approverMayAuthorize`, `src/app/memberships.ts`): a `user` approver needs an active membership whose role may approve, in any mode; a `legacy_token` approver counts only for a simulated (mock) action and only while the token is enabled; an `unverified` approver counts only for a simulated action. A **live** write therefore always rests on a signed-in person who still holds an approving role. Otherwise the proposal fails closed with `approver_not_authorized` (audited as `execution.refused`; no attempt, no connector call). The same rule applies when a crashed run is recovered or reconciled: reconciliation talks to the platform, so if the approver no longer qualifies the connector is not touched and the proposal goes to `needs_review`. In live mode an approval by the workspace token is also refused up front (`403 live_requires_signed_in_approver`) so no unusable approval is recorded; rejecting stays possible. The mode and other gates (expiry, payload hash, budget cap, account) are unchanged, and a mode mismatch is still reported first.

### Background jobs
Jobs keep an explicit `workspace_id`; handlers use that, not the payload, and every follow-up read and write is scoped to it. A job naming another workspace's proposal gets "not found" and changes nothing (tested). Automatic maintenance (retries, CRM sync, recovery) is recorded as `system`; human approval identity is never `system`.

### Limits and risks that remain
- No sign-in in the browser yet (no identity provider), so memberships can only be exercised through the API. The UI still uses the workspace token.
- Inviting people who have never signed in is not built: `POST members` takes the internal `userId` of someone who has signed in at least once.
- No separation of duties: the person who creates a proposal may also approve it if their role allows. Worth a product decision.
- User records are written only at person-level routes (`/api/me`, `/api/me/workspaces`, claim, workspace creation), never by a workspace request, so `last_seen_at` is not updated by workspace traffic (M4.2.1). There is still no rate limiting; claim attempts are not throttled (the token is 192-bit random, so guessing is not feasible, but throttling belongs in M4.5).
- Service functions such as `generateCampaign` still take a workspace id rather than an authorization object; the route layer passes only the verified one. Moving the context into the service signatures is a larger refactor not done here.
- The executor trusts `approver_kind`. It is written only by the server from the authenticated actor, and nothing in the API can set it, but a person with direct database access could.

### Rollback
Revert the commit. Migration 005 is additive (a table, three columns, 25 triggers). Older code ignores the new columns, but the triggers stay and would reject a cross-workspace write, which older code never makes. To remove them, drop the `trg_ws_*` triggers and `workspace_memberships`.

### Milestone 4.2.1: targeted authorization fixes
1. **Workspace-token approvals never authorize live writes** (see "Approval attribution and the executor" above).
2. **Atomic claim** (see the claim bullet above). Tested with two independent connections to one database file: an injected rival claim before the transaction, a rival that tries to claim while the first holds the lock, and a lock held by another connection. Real parallel OS processes are not simulated.
3. **No user write before workspace authorization**: the workspace hook now only reads the user table.

Workspace-specific Meta account authorization was left for the next step and is done in Milestone 4.2.2 below.
Also unchanged: membership changes (`addMember`, `changeRole`, `removeMember`) still use a deferred transaction. Under cross-process contention SQLite aborts the loser (the last-owner invariant holds) but the caller sees a generic error rather than a 503.

## Milestone 4.3: encrypted credential foundation

See `docs/credential-security.md` for the design, lifecycle, threat model and the open key-management decision. In short: an encrypted per-workspace vault (`workspace_credentials`, migration 007) exists with authenticated encryption and master keys held outside the database; it has no consumer yet and no route that stores, reveals or deletes (only the read-only masked status list `GET /credentials`, M4.4a), and a stored credential grants no authority over any resource.

## Milestone 4.2.2: workspace-specific Meta ad account authorization

**Problem.** Before this step a workspace admin could set any account id as the workspace's Meta account (`PATCH /`), and the only other control was one write allow-list shared by every customer. Nothing said which workspace was entitled to which account, and the shared Graph token can reach all of them.

**Trust boundary now.** A workspace can use a live Meta account only if (1) an **owner** of that workspace authorized it, (2) the authorization is `active`, (3) no other workspace holds it, and (4) for writes, the operator's global allow-list also includes it. The global allow-list and token remain infrastructure controls; they never authorize a workspace. The permission to operate is the intersection of all of these, plus the actor's role and the existing approval, budget, payload-hash, mode and approver gates. Simulated (mock) mode has no real accounts and is unchanged.

**Data model (migration `006_meta_accounts.sql`).** `workspace_meta_accounts(workspace_id, account_id, status active|disabled|revoked, source, created/updated at and by)`.
- `account_id` is canonical only: `act_` plus digits, no leading zero, at most 20 digits (enforced by a CHECK, by the request schema and in code; nothing is "fixed up").
- Unique per `(workspace_id, account_id)`, and a partial unique index lets only one workspace hold an account while it is `active` or `disabled`; `revoked` frees it and keeps the row for history. `workspace_id` and `account_id` can never change (trigger).
- `source` is `owner_assertion`: an owner states the workspace controls the account. It is **not** proof of ownership.
- No tokens or credentials are stored. **The backfill is empty**: nothing proves an existing `workspaces.meta_account_id` is legitimate, so existing settings stay in place but are inert, and a live workspace has no usable account until an owner acts.

**Who can do what.** Owners authorize, disable and revoke (`POST /api/workspaces/:wid/meta-accounts`, `POST .../meta-accounts/:aid/disable`, `DELETE .../meta-accounts/:aid`; permission `meta_accounts.manage`). Admins can list them (`meta_accounts.read`) and can choose among authorized accounts (`PATCH /`), or clear the choice. Operators, viewers, the legacy workspace token and non-members cannot manage; there is no public route. Authorizing requires the account to be on the operator's global allow-list. A refusal for "held by another workspace", "not on the allow-list" and "not a live setup" is one identical `409 meta_account_unavailable`; managing someone else's account looks exactly like a missing one (404). Every change is audited (`meta_account.authorized|disabled|revoked`, `workspace.meta_account_set`) with the real actor, workspace and account.

**Where it is enforced.**
1. `selectMetaAccount`: choosing an account (live) requires an active authorization.
2. `ctx.metaFor` returns the workspace's account only if it is currently authorized (otherwise `null`, so proposals say `meta_account_not_authorized`).
3. `WorkspaceScopedConnector` wraps the shared-token connector for every live call and checks the database each time, before the platform is touched: reads, listing, writes, status reads (only for campaigns this workspace saw under an authorized account), and the account list (filtered to this workspace's own). Lead-form and lead calls, which cannot be tied to an ad account, are not available to workspaces.
4. Executor: `checkGate` (before any write), crash recovery and reconciliation (`resumeInterrupted`, `reconcileByName`), and the read-back verification after a write (`finalize`). If authorization is withdrawn while a call is in flight, the proposal goes to `needs_review` and nothing more is read from the account; the external id is recorded in the audit event so a person can verify it.

**Deliberately not done, and limits.**
- Ownership of the ad account is **not proven**. Any workspace owner can claim any account the operator put on the allow-list, first come first served. Until Meta OAuth (or an operator-controlled assignment) exists, add an account to the allow-list only when its intended customer's owner is ready to claim it. This needs a product decision.
- The Meta token is still one shared server-side value. A bug or a database edit that bypasses the application could still reach any account the token can see.
- `src/cli.ts` and the `scripts/meta-*.sh` tools use the global token and are operator tools, not workspace-scoped.
- `WorkspaceUpdateSchema` still accepts legacy-looking ids such as `act_0123`; the canonical check then refuses them (409), so nothing unsafe passes.

## Milestone 4.4.1: identity and onboarding hardening

Three findings from the M4.4 identity review, closed for a **closed pilot**. No identity provider is chosen; nothing here contacts one.

### Onboarding is closed by default (AUTH_MODE=oidc)
| Setting | Default | Effect |
|---|---|---|
| `OIDC_ALLOWED_SUBJECTS` | empty | Exact `sub` values (of the one configured issuer; no emails, patterns or wildcards) who may be provisioned as users and create workspaces. Anyone else gets 403 `not_authorized` at `/api/me`, `/api/me/workspaces`, workspace creation and claim, and **nothing is written** (no user row). |
| `OIDC_CLAIM_SUBJECTS` | empty | Who may claim a legacy workspace with its token. Empty disables claiming. Must be a subset of the list above (startup fails otherwise). |

- A person who already has a user row keeps working through their memberships if they leave the list, but cannot create workspaces and their profile is no longer updated. Removing someone from a workspace is still done by an owner.
- **Inviting someone** is: add their subject to `OIDC_ALLOWED_SUBJECTS`, they sign in once, an owner adds them to the workspace. There is no invitation table; the lists are the closed-pilot mechanism and live in server configuration, so nothing in a token or request can add to them.
- **Claiming** was the one path from "holds the legacy token" to **owner**, which includes `credentials.manage`. It now needs the claim list, and the check happens **before** the token is examined: an identity that may not claim gets the same 403 for a right token, a wrong token and an unknown workspace. Wrong token for a listed claimer is unchanged (404).
- The legacy workspace token itself still cannot read or manage credentials (person-only permissions).
- Workspace-token mode (no identity provider) is unchanged.

### Signing keys have a maximum age
`OIDC_JWKS_MAX_AGE_SEC` (default 86400, 600 to 604800) bounds how long cached keys are trusted after the last **successful** fetch. The client now keeps two clocks: the last attempt (paces refreshes) and the last success (the age of the keys). A failed refresh no longer makes old keys look fresh. Within the window an outage is tolerated (cached keys keep verifying); past it every sign-in fails closed with 503 until the provider answers. A key the provider *removes* is therefore trusted for at most this long during an outage, and for at most the cache lifetime (10 minutes) otherwise. The value must not be below the cache lifetime.

### Token lifetime and audience / client
- `OIDC_MAX_TOKEN_LIFETIME_SEC` (**superseded: now required, 60 to 900, see `docs/idp-compatibility.md` section 9**; the original text follows): a token is refused when `exp - iat` exceeds it **or** when `exp - now` does (so a missing or backdated `iat` cannot hide a long life). Both include the 60 s leeway.
- Audience must still include `OIDC_AUDIENCE`. A token with **several audiences must carry `azp` equal to `OIDC_CLIENT_ID`** (refused if no client id is configured). When a client id is configured, any `azp` that is present must equal it. `OIDC_REQUIRE_AZP=true` demands `azp` on every token; it is off by default because providers differ in whether they issue it. **Not verified against any real provider**: which claims your provider emits is a deployment check (see below).
- **Behavior change:** multi-audience tokens without a matching `azp` were accepted before and are refused now.

### Limits that remain
- There is still no token revocation: a removed provider account works until its token expires (now at most `OIDC_MAX_TOKEN_LIFETIME_SEC`). Role and membership changes apply on the next request.
- Allow-lists live in the environment: changing them needs a restart. Their entries are subjects, so an operator needs the provider's stable user ids.
- The lists are enforced per process; they are not audited per change.

### Milestone 4.4.1.1: three narrow follow-ups

- **An unusable key set is a failed fetch.** A successful response with no usable signing key (an empty `keys` array, or no entry with a string `kid`) no longer replaces the cached keys or renews their age. Inside `OIDC_JWKS_MAX_AGE_SEC` the cached keys keep verifying; past it, sign-in fails closed (503). If the very first fetch is unusable the answer is 503 rather than a per-token 401. Cooldown, single-flight refresh, https-only, redirect refusal and the timeout are unchanged.
- **The key-set size limit is enforced while reading, in bytes.** A declared `Content-Length` over the limit is refused before the body is read; otherwise the body is read in chunks, counted in bytes (not characters), and the transfer is cancelled as soon as the limit is passed, so an oversized or endless response is never fully buffered. A missing body, a stream error, invalid UTF-8 or an HTTP error is a failed fetch with a fixed error that repeats nothing from the response. Default limit 100,000 bytes.
- **Workspace claims are rate-limited per verified person.** `CLAIM_RL_MAX` (default 10) attempts per `CLAIM_RL_WINDOW_SEC` (default 3600) for each person, keyed on the verified user id with the same bounded in-process limiter as the credential routes. Only identities already on `OIDC_CLAIM_SUBJECTS` use quota; everyone else is refused first (403) and creates no limiter entry, user row, membership or audit record. Over quota: 429 `rate_limited` with `Retry-After`, the same wording as the credential routes, whatever the token or workspace. Refused or throttled claims are **not audited** (an audit row needs a real workspace id, and the one in the request body is unverified); this is an accepted limit. Counters are per process and reset on restart.

### Milestone 4.4c Package 4: identity-provider compatibility preparation

Offline only; **no provider selected, none contacted**. `docs/idp-compatibility.md` holds the provider-neutral contract (clauses C1 to C17), the checklist for choosing a provider, a staging verification plan, and a review of what a browser PKCE flow would still need from the server. The contract is executable in `test/idpContract.test.ts` against **simulated** token and key-set shapes (`test/support/simulatedIdp.ts`); passing it does not verify any real provider. Three small, stricter verifier corrections came out of it (audience arrays of strings only; `key_ops` must allow `verify`; conflicting duplicate `kid` entries make that id unusable). The intended pilot uses OIDC; the workspace-token flow is kept for offline development.

### Token-type hardening and the pilot identity decisions

Decided for the controlled pilot: OpenID Connect Authorization Code with PKCE (S256) for the browser, **JWT access tokens only** at the API (an ID token is never an API credential), a 10-minute access-token target with a hard 900-second ceiling, redirect-based re-authentication (no refresh tokens yet), controlled subject allow-lists verified by exact issuer and immutable subject, and workspace membership as the only source of roles. Auth0 is the leading candidate and self-hosted Keycloak the fallback, subject to staging; **no provider has been contacted and the browser sign-in is not built.**

What changed in the server: `OIDC_CLIENT_ID` and `OIDC_MAX_TOKEN_LIFETIME_SEC` (60 to 900) are now **required** with no defaults; the header `typ` must be `at+jwt` unless `OIDC_ACCESS_TOKEN_TYPES` names otherwise; bearers carrying `nonce`, `at_hash` or `c_hash`, or naming the client id as an audience, are refused; an audience equal to the client id stops startup. These supersede the earlier 24-hour default. Details, limits, the PKCE implementation plan, the onboarding procedure and the staging evidence still needed are in `docs/idp-compatibility.md` sections 9 to 13.
