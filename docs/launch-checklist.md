# Launch checklist

Status as of 2026-10-29 (Phase 10 baseline). **Not ready for a public launch.** "Done" means verified by a quoted result in `docs/phase-10-acceptance-report.md`; anything not marked Done is open.

## Launch blockers (must be closed first)

| # | Blocker | Why it blocks | Status |
|---|---|---|---|
| B1 | **No browser sign-in; real identity provider never tested** | Production start requires `AUTH_MODE=oidc`, but the UI has no sign-in flow and only a simulated IdP has been used | Open |
| B2 | **High `zod` advisory** (GHSA-mrhx-c7xc-m3w5, memory exhaustion on huge arrays) | Denial of service in a multi-tenant deployment | **Open.** Interim mitigation implemented (list length 200 and depth 12 refused before validation; `allowedProviders` capped at 20; see report section 10). The vulnerable code is still installed: the Zod 4 migration is **mandatory before any public launch** |
| B3 | **Deployment, TLS, monitoring and off-site backups not in the repo** | The app refuses to start without https origins and HSTS, but nothing provisions them; backups are local files | Open |
| B4 | **Single-node SQLite** | No horizontal scale or failover | Open (accepted for a small first launch only if B3 is closed) |
| B5 | **No managed key provider** for stored credentials | Keys live in a local file | Open |
| B6 | **No retention policy and no workspace deletion** | Only per-lead erasure and export exist | Open |
| B7 | **No third-party penetration test** | Internal review only | Open |

## Other open gaps (not launch-stopping alone)

- Suite reliability under heavy load is improved but not proven: a global `testTimeout: 20000` is set, and 5 consecutive full runs passed (1777 tests, 71 files) at 28-57% background CPU; earlier timeouts happened under heavier load that has not been re-tested. Keep watching.
- Browser QA harness lives outside the repo; results cannot be re-run from the repo.
- No screen-reader or full keyboard audit. (Panel redraw and the 4.4:1 contrast are fixed locally, uncommitted; see the Phase 10 report, section 8.)
- Dev-toolchain advisories (vitest, vite, esbuild, tinypool); not shipped to production.
- Live AI, Meta Ads, CRM, email, SMS and image/video providers have never been called; their live paths are Unverified.

## Done and verified (offline)

- [x] Type check clean; 71/71 test files, 1777 passed, 20 skipped by design (5 of 5 latest full runs; see "Other open gaps" on load).
- [x] Zero external network connections and DNS lookups across the whole suite.
- [x] Tenant isolation, default-deny route permissions (139 workspace + 15 organisation routes).
- [x] Audit events append-only (migration 023); export and per-lead erasure; per-workspace quotas.
- [x] Production start guard; readiness endpoint `/api/health/ready`.
- [x] Online backup, verification and restore check (12/12 on a scratch copy).
- [x] Migrations 001-023 forward-only; applied rows match files.
- [x] Real-browser scenarios 5-15 pass (harness fixes noted in the report).

## Before launch, in order

1. Approve the `zod` plan; apply mitigation B, then migrate (A).
2. Build and test browser sign-in against a real IdP (B1).
3. Provision TLS/HSTS, monitoring, log shipping and off-site backups; rehearse a restore from off-site (B3).
4. Decide retention and workspace deletion (B6) and key management (B5).
5. Commit Phases 8-9 (needs explicit approval), move the browser harness into the repo, fix the load-sensitive test and the contrast.
6. Independent security review (B7), then a staged launch with live providers enabled one at a time under separate authorisation.
