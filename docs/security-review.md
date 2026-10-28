# Security and operational review (Phase 6)

Scope: the code added or changed in Phases 1 to 5 plus the existing boundaries it touches. Mock mode only; no live calls were made.

## Reviewed and found sound (with the test that pins it)

| Area | Finding | Evidence |
| --- | --- | --- |
| Route permissions | Every route has an entry in the central permission table; a request with no entry is refused (default deny). The two permissions added in Phase 4 (`leads.update`, `jobs.retry`) are in the pinned policy. | `test/authz.test.ts` (matrix for every route and role) |
| Workspace isolation | Every new query filters by the verified workspace id (provenance, plan, version history, lead detail and status, job retry, dashboard job rows). A token for one workspace cannot read or change another's lead, job, campaign or proposal by id. | `test/hardening.test.ts`, `test/leadsJobs.test.ts` |
| Browser output | No `innerHTML` or similar anywhere in `public/`; everything uses `textContent`. Strict CSP (`script-src 'self'`, `frame-ancestors 'none'`); the new scripts are external files only. | `test/securityBoundary.test.ts` (module list includes every new script) |
| CSRF | Credentials travel in the `Authorization` header, never a cookie, so a cross-site page cannot ride a session. Only loopback `Host` values are accepted unless `PUBLIC_ORIGINS` is set. | existing boundary tests |
| Rate limiting | One per-caller API limiter wraps every workspace route, including the new ones. | `src/server/app.ts` |
| Audit | No code path updates or deletes audit rows. New actions (`lead.status_changed`, `job.retried`, `campaign.generated` with the goal) record the server-derived actor. | `test/leadsJobs.test.ts` |
| Job idempotency | Lead jobs store the lead and its CRM sync once; a manual retry cannot duplicate them and is capped at 2. Execution jobs cannot be retried by hand. | `test/leadsJobs.test.ts` |
| Spending | Reservation ledger, daily cap and ceiling unchanged by Phases 1 to 5 (full suite). | `test/liveCeiling.test.ts` |
| Migrations | 011 to 014 are additive and applied to the real database without loss. | migration-list tests |
| Secrets | `.env.local` is git-ignored and untracked; the only key-shaped strings in the repository are obvious test fakes. | `git check-ignore`, `git ls-files` |

## Fixed in this phase

1. **Failure text could carry secret-shaped content or multiple lines into the database and the UI.** Errors from providers or the network are stored for jobs, proposals, execution attempts and CRM sync. They now pass through `safeError` (`src/app/util.ts`): one line, at most 240 to 500 characters, with API-key-, bearer-, JWT- and credential-header-shaped text replaced by `[redacted]`. `GET /jobs` also applies it to rows written before this change.
2. **A service name could close the `<owner_goal>` block in a model prompt.** Angle brackets are removed from the focus service before it is added to the prompt. The focus service was already limited to services in the Business Brain.

No critical or high-severity issue was found in the reviewed code.

## Production prerequisites (not done, and not claimed)

- **Real sign-in.** Production needs `AUTH_MODE=oidc`. The local per-workspace token is an admin-equivalent shared secret with no accounts, and it can never manage people.
- **Credential storage.** Nothing is stored without a managed key provider, which is not configured. Provider keys are read from the server environment only. The expired key in the local environment file should be revoked at the provider.
- **TLS and origin.** Serve behind HTTPS and set `PUBLIC_ORIGINS`. The app listens on loopback only.
- **Rate limiting is per process and in memory.** It resets on restart and is not shared across instances.
- **Background jobs run inside the web process.** There is no separate worker, no leader election and no dead-letter alerting. Run one instance only.
- **Database.** SQLite in one file: no replication. Back up the file (including `-wal`) and test a restore.
- **Dependencies.** Run `npm audit` and review results before deployment. It was not run here because it contacts an external service.
- **Spending ceiling is the app's own estimate**, not the provider's billing limit. Set a limit at the provider too.
- **Self-approval.** A person who proposes a campaign can also approve it if their role allows. Documented, not blocked.
- **Live Meta and live CRM** are not enabled and have not been reviewed for production.
