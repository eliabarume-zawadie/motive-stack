# Acceptance report (PRD roadmap, Phases 0 to 7)

Date of the final run: 2026-10-27. Mode: mock only. Nothing was committed.

## Evidence

| Check | Result |
| --- | --- |
| `tsc --noEmit` | exit 0, no errors |
| Full offline suite (`vitest run`) | 59 files passed; 1513 tests passed, 20 skipped. The 20 skipped are the opt-in live and local suites (`test/live/*`, `test/local/*`); they are skipped unless fully opted in. No test was removed or weakened (the diff only adds tests and extends pinned lists such as the migration list and the permission table). |
| Real-browser walk (headless Edge, QA server on port 3100 with a temporary database, local fixture website, mock AI) | 24 of 24 checks passed, covering PRD browser steps 1 to 12 and three screen widths (390, 768, 1366 px: no sideways scroll, navigation visible). |
| Browser console | No exceptions, no CSP violations, no console errors. Three network entries were expected refusals that the walk provoked on purpose: one 422 for the over-budget proposal and two 401s for the deliberate no-token probes. They are allowed by name; any other entry fails the check. |
| Outbound network | Every request the page made went to its own host. A snapshot of the app and QA server processes showed no non-loopback connection. This is a point-in-time check, not a continuous capture. |
| Database | Migrations 011 to 014 applied to the real database; all additive, no data dropped. Latest applied: `014_lead_status_job_retries.sql`. |
| Pinned or fingerprinted paths (`scripts/`, `src/eval`, `src/domain`, `src/ai`, `docs/eval`, `package*.json`, `test/setup.ts`, `vitest.config.ts`, `config/`) | Not modified. |

The browser walk script is a scratch file outside the repository, so it is not part of the repeatable suite.

## One live record to know about

The real database holds one live AI usage row: an OpenAI test request at 2026-10-27 11:02 UTC that failed with `auth` (no usage, no cost). It predates the PRD phases and is how the expired key was found. There are no live rows after it, and no live call was made during Phases 0 to 7.

## Acceptance checklist

Legend: **Verified** means shown by the evidence above. **Tests only** means covered by automated tests but not exercised in the browser walk. **Partial** and **Not done** are stated plainly.

| Item | Status |
| --- | --- |
| App starts in mock mode without live credentials | Verified (app and QA server both start in mock mode). |
| Main navigation and pages work | Verified in the browser at three widths. |
| Dashboard uses actual local data | Verified (real counts; no hard-coded metrics). |
| Website and manual onboarding work | Website: verified in the browser. No-website questionnaire: tests only. |
| Website findings have evidence and provenance | Verified (findings name the page; saved items are labelled by source). |
| Owner content survives reanalysis | Tests only (website-analysis and DOM tests). |
| Unsupported claims are not automatically verified | Verified in the browser (held for the owner) and in tests. |
| Marketing goals produce reviewable mock drafts | Verified. The mock draft does not change with the goal; the screen says so. |
| Campaign drafts support edits and versions | Verified (version history with changes). |
| Budget and platform checks block unsafe proposals | Verified (failed checks shown; the server refused the proposal with a plain reason; none was created). |
| Approval binds to the reviewed version | Tests only (the proposal shows the campaign version it covers). |
| Simulated execution is idempotent and clearly labelled | Executed and labelled in the browser; idempotency by tests. |
| Campaign list/detail and lifecycle work | Partial: list, search, filter, detail, propose, approve, reject, simulated run. Pause, resume and archive are **not implemented**. |
| Jobs show persisted status and safe errors | Verified; error text is one redacted line. |
| Leads and duplicate-event handling work in simulation | Verified. |
| Audit and activity history is useful and persisted | Verified. |
| Workspace and role restrictions are server-enforced | Tests only (permission matrix for every route and role; cross-workspace isolation test). The browser can only run as admin in local sign-in; viewer and operator denials are covered in DOM and server tests. |
| Integration state distinguishes mock from verified live | Verified in Settings. No live integration has been verified. |
| Usage, reservations, unknown costs and ceilings are visible | Verified in Settings. Held and unverified amounts show only once a live ceiling is configured. |
| No credentials leak to browser, logs or reports | Tests and scans found none; the git-ignored environment file was never read. This is not a proof of absence. |
| Loading, empty, success, error and permission states work | Tests for each; several seen in the browser walk. |
| Mobile, tablet and desktop layouts are usable | Verified for overflow and navigation visibility only; I did not judge every screen's ergonomics. |
| Full offline suite and typecheck pass | Verified. |
| No unauthorized live provider calls occurred | None during the roadmap. See the one earlier record above. |
| No destructive database operation or unrequested commit | Verified: migrations are additive, nothing was reset, nothing was committed. |
| Documentation and remaining limitations are accurate | Written against the code as run; see the limitations below. |

## Remaining limitations

- Phase 8 (live OpenAI) has not been done. It needs your explicit authorization and a new valid key.
- Pause, resume and archive are not implemented.
- Member management needs real sign-in (`AUTH_MODE=oidc`); its screen has not been exercised with a signed-in owner.
- Lead status changes are free-form (any status to any other).
- The job queue runs in the web process, with a single-instance assumption.
- The mock draft ignores the chosen goal; only a real model would use it, and that has not been tested.
- Production prerequisites are listed in [security-review.md](security-review.md).
