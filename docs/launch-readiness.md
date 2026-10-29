# Launch-readiness assessment (Master PRD Phase 9)

## Verdict

**MotiveStack is not ready for a public production launch.** Tests passing is not evidence of readiness, and this report does not claim it. The application is sound for local use in mock mode, and this phase closed the privacy, audit, quota, backup and start-up gaps that could be closed in code. But several launch blockers remain that are not code changes (a real sign-in flow in the browser, a managed deployment, monitoring, a reviewed identity provider) or need decisions (retention, billing, a major dependency upgrade). They are listed under **Open items**, and the **Pre-launch checklist** is the order to work through them.

Everything was assessed on this computer, in mock mode, with the identity provider simulated. No live provider, ad platform or CRM was contacted. The one outside lookup was `npm audit`, which asks the public advisory database about the dependency list.

## How this was assessed

Evidence is a command or a test that can be re-run, not a statement. The assessment tests live in `test/launchReadiness.test.ts` (25 tests); the rest are existing suites. Run everything with `npm test`, the type-check with `npm run typecheck`, and the backup proof with `npm run backup` and `npm run restore:check`.

| Area | What was checked | Evidence |
|---|---|---|
| Authorization coverage | Every registered route was read from the server's own route tree. Each workspace route has a permission-table entry, each table entry is a real route (no stale entry can hide a missing one), and the only unmapped routes are the account and organization routes. A new route nobody had marked public was refused by default (the readiness route was found this way). | `test/launchReadiness.test.ts` “every route is accounted for”; `test/authz.test.ts` |
| Workspace isolation | For all 139 workspace routes: unauthenticated callers get 401; a signed-in non-member gets no 2xx and no 5xx using real ids from the target workspace; another workspace's resource ids are not found in your own workspace on every route that takes one (more than 60); no list route showed another workspace's marker data. | “workspace isolation holds on every route” |
| Hostile input | Path parameters carrying SQL, traversal, NUL, a 4,000-character string, bidirectional unicode and template syntax were sent to every parameterised route (over 500 requests): no unintended 5xx, no stack trace, no file path in any response. Malformed JSON, wrong types, unknown fields and a body over the limit are refused cleanly. | “hostile input never reaches a server error” |
| Security headers, CSRF | CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff` on API and page responses. Credentials travel in a header, never a cookie. | existing `test/securityBoundary.test.ts` plus the new header test |
| Rate limiting, concurrency | A per-verified-caller limit covers the newest routes and returns `Retry-After`. A burst of 200 concurrent mixed reads and writes produced no server error and an intact database (`integrity_check`, `foreign_key_check`). | “rate limits and reliability” |
| Audit | No code path edits or deletes audit rows, and as of this phase the database itself refuses it. Audit rows carry ids and actor kinds, never a name, e-mail address or phone number (tested after creating a lead with all three). | “the audit trail cannot be changed” |
| Privacy | Export and erasure work, and keep secrets and personal data where they belong (details below). | “privacy: export and erasure” |
| Quotas and cost attribution | Row quotas refuse over-limit records with a plain message and store nothing from a refused batch. A usage view attributes AI cost to this workspace by provider and model, plus storage, pictures and lead counts, and never includes another workspace. | “quotas and cost attribution” |
| Secrets and logs | No key-, token- or private-key-shaped string in any repository file (only labelled test fakes), `.env` files are ignored, the server logger is off (so request bodies, which carry secrets on credential routes, are never logged), and only start-up code prints. | “secrets and logging” |
| Backup and restore | A consistent online copy of the database and every asset file, verified against a manifest, restored into a scratch folder, with damage and tampering detected. The live database is read, never changed. | “backup and restore are proven, not assumed” |
| Start-up safety | A production start refuses the shared-token mode and other unsafe settings, before opening the database. | “a production start refuses what is unsafe” |
| Dependencies | `npm audit` (see Open items). | command output recorded below |

## Findings fixed in this phase

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | **High** | There was no way to export a workspace's data or to erase a person's data. A public launch holding leads' names, e-mail addresses and phone numbers cannot ship without both. | `GET /export` (admin) returns everything the workspace holds with every secret removed, and records that it happened. `POST /leads/:lid/erase` (admin, reason required) removes a lead's personal data from the lead, its status history, the simulated CRM copy and the event payload, keeps a scrubbed event so the same event id cannot silently re-add the person, and records only ids in the audit trail. The response lists what it could not reach (the audit trail by design, any real CRM, older backups). |
| F2 | **High** | Nothing stopped a production deployment from running `AUTH_MODE=workspace_token`, a shared, admin-equivalent secret with no accounts. | A start with `DEPLOYMENT_ENV=production` now refuses to start unless `AUTH_MODE=oidc`, an https `PUBLIC_ORIGINS` and `HSTS_MAX_AGE_SEC` are set and `DATABASE_PATH` is explicit. Each problem names the variable, never a value. Development and test are unaffected. |
| F3 | Medium | Audit immutability was by convention only: nothing stopped a bug or a hand-typed statement from changing history. | Migration 023 adds database triggers that abort any `UPDATE` or `DELETE` of an audit row. |
| F4 | Medium | Files, daily pictures and AI spend had limits; leads, tasks, learnings, experiments, creatives, campaigns and forms did not, so one workspace could grow the shared database without bound. | Per-workspace quotas, checked before the record is written, with a plain message and `413 quota_exceeded`. They are the app's own safety limits, not plan entitlements. |
| F5 | Medium | The backup scripts lived outside the repository, and nothing proved a backup could be restored. | `src/ops/backup.ts`, `npm run backup` and `npm run restore:check`, tested, with `docs/operations-runbook.md`. |
| F6 | Low | No readiness endpoint for a monitor or load balancer. | `GET /api/health/ready` (public, says yes or no and which check failed, nothing about the system): the database answers and every migration is applied. |
| F7 | Low | `GET /ownerships/:type/:id` answered 200 with an empty record for another workspace's campaign id. It revealed nothing, but it should not answer as if the id existed. | It now returns 404, like every other route. The route-wide isolation test found it. |
| F8 | Moderate (dependency) | `fast-uri` (a transitive dependency of the web framework) had a URI-scheme spoofing advisory. | Updated to the patched release (lockfile only). |

A usage view (`GET /usage`, admin) and a Settings panel were added so usage against limits and AI cost per provider are visible.

**A mistake made while fixing F8, stated plainly.** Running `npm audit fix --omit=dev` also removed the development dependencies (TypeScript, vitest, tsx, jsdom) from `node_modules`. It was noticed when the type-check tried to download an unrelated package, and fixed by a plain `npm install`, which restored the same locked versions (vitest 2.1.9, TypeScript 5.9.3). The running app was never affected. The only lasting change is the `fast-uri` patch in `package-lock.json`. Future dependency fixes should use `npm audit fix` without `--omit=dev`.

## Open items

Severity is the risk **for a public launch**, not for local use.

| # | Severity | Open item | What it needs |
|---|---|---|---|
| O1 | **Blocker** | **No sign-in in the browser.** OIDC verification is implemented and tested with a simulated identity provider, but the browser UI has no sign-in flow and the real provider path has never been run against a real provider. Without it, only the local shared-token mode is usable in a browser, and F2 forbids that in production. | A browser sign-in flow, and a test against a real identity provider (`docs/idp-compatibility.md` lists what to check). |
| O2 | **Blocker** | **Operational foundations are not in the repository:** TLS termination and a proxy, alerting, log collection and monitoring, an on-call and incident process, automated and off-site backups, and a deployment pipeline. The server listens on loopback only, by design. | A deployment design and its review. `docs/operations-runbook.md` covers backup, restore, upgrade and incidents, but it is a runbook, not a platform. |
| O3 | **High** | **`zod` 3.x has a published advisory** (memory exhaustion validating oversized constrained collections), a production dependency. The fix is `zod` 4, a major migration across the codebase. It is bounded here in two ways. The server's body limit is 256 KB. And, since the Phase 10 follow-up, a structural guard in the JSON parser (`src/server/bodyShape.ts`, called from `src/server/app.ts`) refuses any request whose JSON has a list of more than 200 items or nesting deeper than 12 levels, with the fixed answer `400 body_too_complex`, before any zod schema or business code runs (`test/arrayBounds.test.ts`, 13 tests). The limits were set from measurement: across 11,382 request bodies in the test suite the largest list was 40 items and the deepest nesting 5. `allowedProviders` is also capped at 20. **This is an interim mitigation, not a fix**: the vulnerable zod 3 code is still installed and still validates the (now bounded) data, other shapes of input that fit under the limits are not proven harmless, and unauthenticated callers never reach it only because sign-in runs first. | **Migrate to zod 4 before any public launch (mandatory).** Plan the migration (about 32 source files; the pinned `src/domain` and `src/ai` need approval), then retest. |
| O4 | **High** | **Single-node, single-process design.** SQLite in one file, background jobs inside the web process, an in-memory rate limiter that resets on restart and is not shared. There is no replication, no leader election and no dead-letter alerting. | Run exactly one instance, or redesign (a server database, a separate worker, a shared limiter). Unauthenticated request volume is the proxy's job. |
| O5 | **High** | **Identity and secrets in production.** The credential vault is disabled without a managed key provider, and none is integrated. | A managed key service and a rotation procedure. |
| O6 | Medium | **Privacy scope.** Erasure covers one lead, not a whole workspace or a staff member. There is no retention schedule, no automated deletion, no verified-consent model (consent is recorded text), and an imported lead's event id is a hash of its contact details, so it is pseudonymous rather than erased. A backup restored after an erasure brings the person back (the runbook says to re-apply erasures from the audit trail). | A retention and privacy policy, then code to match. |
| O7 | Medium | **Audit export** exists only inside the workspace export (newest 20,000 events); there is no dedicated, filterable audit export or retention policy. | Decide the requirement. |
| O8 | Medium | **Locale, time zones, currency and accessibility.** Dates are plain calendar dates with no time zone, there is one currency, and accessibility has had care (labels, roles, keyboard-reachable controls) but no formal audit. | An accessibility audit and a time-zone design. |
| O9 | Medium | **Dev toolchain advisories** (`vitest`, `vite`, `esbuild`, `tinypool`; two critical, one high). They affect developer machines that run the test UI or a vite dev server, neither of which this project does, and none ships to or runs in production. Fixing them needs `vitest` 5 (a major upgrade). | Upgrade in a CI-first change; do not run the vitest UI meanwhile. |
| O10 | Medium | **No third-party review.** No penetration test, DAST, dependency-license review or load test beyond the 200-request in-process burst. | Commission them before launch. |
| O11 | Low | **Product gaps recorded earlier:** a lead with no campaign cannot be stored (needs a table rebuild); no live integration has been reviewed (by design); billing and plan entitlements are undecided, so quotas are safety limits only. | Decisions, then work. |

## `npm audit` as run

Production dependencies: 1 high (`zod`, O3). The moderate `fast-uri` finding was fixed (F8). Including development tools: 2 critical, 2 high and 3 moderate, all in the test toolchain (O9).

## Pre-launch checklist

1. Build and test the browser sign-in against a real identity provider (O1).
2. Design and review the deployment: TLS, proxy, single instance or a server database, monitoring, alerting, log collection, off-site backups on a schedule, and a restore drill (O2, O4).
3. Migrate to `zod` 4 (O3) and upgrade the test toolchain (O9).
4. Integrate a managed key provider for credentials (O5).
5. Decide and implement retention, workspace deletion and the privacy policy (O6, O7).
6. Run an accessibility audit and decide time-zone handling (O8).
7. Commission a penetration test and a load test (O10).
8. Only then review any live integration, each separately (`docs/integrations-readiness.md`).
9. Set `DEPLOYMENT_ENV=production`; the start-up refuses unsafe settings (F2).
