# Phase 10 acceptance report: offline QA baseline

Date: 2026-10-29. Branch `phases-1-4-master-prd`. Phases 8-10 were committed locally as checkpoint `1a07a0b` (52 paths, on top of `c0c0f38`); the follow-up fixes in section 8 are **uncommitted**, awaiting review. Nothing was pushed. This report is evidence, not a launch approval: **MotiveStack is not ready for a public launch** (see `docs/launch-checklist.md` for the blockers).

Statuses: **Verified** (checked by a command or test whose result is quoted), **Unverified** (not checked, or only checked indirectly), **Deferred** (a known gap, justified), **Blocker** (must be closed before public launch).

## 1. Commands and results

| Check | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit -p .` | Exit 0, no output |
| Full offline suite, run A | `npx vitest run` | 70/70 files, 1763 passed, 20 skipped (173 s) |
| Full offline suite, run B (with network audit) | `NODE_OPTIONS=--require netaudit.cjs npx vitest run` | 70/70 files, 1763 passed, 20 skipped |
| Suite history this phase | five complete runs | 1 run with 15 failures (load, fixed or re-pinned), 2 clean, 1 run with **1 timeout** (see 3.2), 1 clean |
| Skipped tests (20) | by design | `test/live/ai.live` 6, `test/local/ollama` 4, `test/ai` 6, `test/live/meta.live` 4: live or local-model tests that need explicit authorisation |
| Network audit | preload hook on every test process | 374 socket events. 359 reached **127.0.0.1**; 15 were refused by the SSRF guard (`blocked_address`) before connecting; **0 external connections, 0 external DNS lookups** |
| Dependency audit | `npm audit --omit=dev` | 1 high: `zod` < 4.6.6 (see 4) |
| Backup | `npm run backup` | 7/7: hash, `integrity_check`, no FK violations, 23 migrations, 58 tables, 0 asset files |
| Restore check | `npm run restore:check -- data/backups/2026-10-29T07-56-50-077Z` | 12/12 on a scratch copy; the live database was not touched |
| Safeguards on a copy of the populated database | `verify-on-copy.mts` (scratchpad) | 15/15 (readiness 200/503, tenant isolation 0 leaks, export, audit immutability, lead erasure, quota, production start refusal) |
| Real-browser scenarios 5-15 | headless Edge via CDP, one fresh server and database per scenario | **First attempt: 8 of 11 passed.** After fixing the harness (3.3 and 3.4), all of 5-15 passed on the first attempt of the re-run (5: 24/24, 8: 12/12, 9: 10/10). See 3 |
| Accessibility scan, scenario 16 | structural probe at 320/390/768/1366 px | No overflow, no heading skips, 1 h1, one labelled nav, no duplicate ids, no positive tabindex. **15 low-contrast elements (4.41:1)**; see 3.5 |

(Superseded by section 8 for the items marked fixed there.) The browser harness lives **outside the repository** (session scratchpad). Its results are real but a reviewer cannot re-run them from the repo. That is listed as a gap.

## 2. Pending changes review (50 paths)

No secrets, generated files, stray dependency changes or out-of-scope edits found. `src/ai`, `src/domain` and `config/prompt-versions.json` are untouched; `PRD.md` and `docs/acceptance-report.md` are unchanged. `package-lock.json` differs only by the `fast-uri` 4.2.3 patch; `package.json` only adds `backup` and `restore:check` scripts. Migrations 022 and 023 are additive; 023 adds append-only triggers on `audit_events`.

## 3. Findings during the baseline

3.1 **Previous cold-start failure (campaign creation).** Reproduced as a *harness* fault: the page's CSS and `scrollIntoView` use smooth scrolling, and the harness clicked at coordinates read mid-scroll, so the click landed on a neighbour. Proven with an instrumented run and cured by a click helper that waits for the scroll to settle and checks what is under the pointer (25/25 under load). Not a product defect, but not "harmless": it had hidden real timing in the page, and a user who clicks while the page is scrolling can hit the wrong control.

3.2 **Intermittent timeout** in `credentialsCloseout44b` (production-mode test, 5 s default, 5885 ms in one of five runs; passes alone 3/3 in ~1.4 s). A load-sensitive test, not a logic failure. **Unresolved:** the fix (a per-test timeout) needs approval because it edits a test.

3.3 **Scenario 5 was stale, not the product.** Phases 1-4 introduced the deliberate "approve, then Run" split ("NOT RUN YET"). The old scenario never pressed Run, and its loose text match let step 7 pass on the word "PAUSED" while the proposal was only approved. Updated to press Run and require an executed, simulated state. This also confirms approval alone runs nothing.

3.4 **Panels are redrawn under the pointer.** Scenarios 8 and 9 failed because the "Propose a paused draft" button was replaced by a background load between being found and clicked (logged 4 times, plus 1 for "Archive this campaign"). The app is unchanged; the harness now retries and logs. For a person this is a real, minor usability risk (a click lost to a redraw). **Not fixed**; recommended follow-up.

3.5 **Accessibility, structural only (not a formal audit).** Real: warning text `#9a6700` on `#fff3d6` was 4.41:1, just under the 4.5:1 AA threshold (15 elements); a wider scan then found the green `ok` pills at 4.43:1 (32 elements). Both are fixed in section 8. The probe's "no focus outline" and "keyboard stuck" readings are artefacts of the probe (script focus does not trigger `:focus-visible`; CSS has a 3 px outline); keyboard order is therefore **Unverified**. No screen-reader testing was done.

## 4. The remaining high `zod` advisory (GHSA-mrhx-c7xc-m3w5)

- Affected: `zod` 3.25.76 (direct dependency, used to validate request bodies and AI output in about 32 source files).
- Exposure measured: memory is exhausted only by very large arrays in a request. The body limit is 256 KB and requests need a verified principal first; the rate limit is 1200 per minute per principal. In a single-user local deployment the exposure is a denial of service by the user against themselves. For a multi-tenant public deployment it is a Blocker until mitigated.
- Options: **A** upgrade to zod >= 4.6.7 (a major migration; touches pinned `src/domain` and `src/ai`, which need approval); **B** add an array-length cap in a pre-validation hook and tighten per-route body limits; **C** accept for local-only use.
- Recommendation: B now, A before any public launch. No upgrade was performed.

## 5. Requirement evidence

### Baseline checklist (26 items)

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Starts in mock mode without credentials | Verified | App started with `INTEGRATION_MODE=mock`; `launchReadiness` and `deployment` tests |
| 2 | Navigation and pages work | Verified | Browser scenarios 5-15 pass |
| 3 | Dashboard uses actual local data | Verified | scenario 6/7, dashboard tests |
| 4 | Website and manual Brain onboarding | Verified | scenario 5, website tests |
| 5 | Findings have evidence and provenance | Verified | scenario 5 (3, 2b) |
| 6 | Owner content survives reanalysis | Verified | tests (`websiteAnalysis`, guided flow) |
| 7 | Unsupported claims not auto-verified | Verified | scenario 5 (2b) |
| 8 | Goals produce reviewable mock drafts | Verified | scenario 5 (4), 8 |
| 9 | Edits and versions | Verified | scenario 5 (5) |
| 10 | Budget and platform checks block unsafe proposals | Verified | scenario 5 (6a-c) |
| 11 | Approval bound to reviewed version | Verified | proposal tests |
| 12 | Simulated execution idempotent and labelled | Verified | scenario 5 (7, now with Run), tests |
| 13 | Campaign list/detail/lifecycle | Verified | scenario 8, lifecycle tests |
| 14 | Jobs show status and safe errors | Verified | scenario 5 (8a), jobs tests |
| 15 | Leads and duplicates in simulation | Verified | lead tests, scenario 11 |
| 16 | Audit/activity history | Verified | activity tests; audit is append-only (023) |
| 17 | Workspace and role restrictions enforced on the server | Verified | 139 workspace routes + 15 organisation routes mapped, default-deny; `authz` and `securityBoundary` tests |
| 18 | Mock vs verified live | Verified | integrations tests (21) |
| 19 | Usage, reservations, ceilings visible | Verified | usage/ceiling tests, `usageView` |
| 20 | No credentials leak | Verified for covered paths | export deny-lists, log and response tests; no real secret store tested |
| 21 | Loading/empty/success/error/permission states | Verified in browser for main screens | scenarios 5-15; not every state of every screen |
| 22 | Mobile/tablet/desktop usable | Verified (reflow) | scenario 16: no overflow at 320/390/768/1366 px; usability not user-tested |
| 23 | Full offline suite and typecheck pass | Verified, with one intermittent timeout | section 1 |
| 24 | No unauthorised live calls | Verified | network audit: 0 external |
| 25 | No destructive DB operation or unrequested commit | Verified | no reset or commit; backups and restore on copies |
| 26 | Documentation and limitations accurate | Verified after this phase's reconciliation | this report, `launch-readiness.md`, `launch-checklist.md` |

### Additional criteria

| Area | Status | Notes |
|---|---|---|
| Agency and permissions (6 items) | Verified in tests; **no browser sign-in** | Cross-client denial: 0 leaks across 15 routes against real workspaces on a copy. Separation of duties tested. Real IdP sign-in never exercised (Blocker) |
| Campaign planning (6 items) | Verified | scenario 8; idempotent batch and duplicate handling in tests |
| Creative Studio (6 items) | Verified with mock images | Live image providers deliberately not enabled |
| Operations and measurement (6 items) | Verified | scenarios 11-15; analytics keeps real, imported, estimated and simulated apart |
| Global rules (4 items) | Verified | offline by default, additive migrations 001-023, no commit/reset/stash |

### Final completion gate (15 items)

14 are Verified in the sense above. Security, privacy and production-readiness gaps are documented rather than closed. Overall: **the target scope is implemented and verified offline; it is not launch-ready.**

## 6. Database and migrations

23 migration files, 23 applied rows in `schema_migrations`, identical schema between a fresh build and the populated database. 011-014 and 023 are represented correctly. `PRAGMA integrity_check` ok; `foreign_key_check` empty. Migration 023 was applied to the populated database earlier under a verified backup; nothing further was applied in Phase 10.

## 7. Changes made during Phase 10

Repository files: this report, `docs/launch-checklist.md`, and one correction in `docs/launch-readiness.md` ("~140" to the exact 139). Nothing else in the repo. All other work (QA scripts, harness fixes, scenario 5 update) is in the session scratchpad, outside the repository. A new backup folder was created under the git-ignored `data/backups/`.

## 8. Follow-up fixes after the checkpoint commit (uncommitted)

Changed files (repository): `public/app.js`, `public/leads.js`, `public/activity.js`, `public/style.css`, `test/ui.dom.test.ts`, `test/credentialsCloseout44b.test.ts`, `test/guidedFlow.dom.test.ts`, and this report and the launch checklist. The browser harness (click helper, scenario 5, retry logging) is **not** in the repository; it lives in the session scratchpad.

| Item | Cause found | Change | Result |
|---|---|---|---|
| Lost clicks (application) | The page re-reads everything every 1.5 s and rebuilt the campaign, proposal, lead-list and activity panels even when nothing had changed, replacing buttons and selects under the pointer, closing opened "Details", and reloading the open lead (wiping what was typed in it). | Each panel is redrawn only when the data it shows, the person's permissions, or a pending action has changed (the same pattern `renderDashboardViews` already used). The `once()` guard still prevents double submits. | New DOM regression test passes, and fails when the guard is removed (checked for the proposal and for the activity guard). Browser scenarios 5-15: 11/11 on the first attempt, **0** redraw retries (before: 5 retries across scenarios 8, 9 and 15) |
| Contrast | `--warn` 4.41:1 and `--ok` 4.43:1 on their tinted backgrounds (light theme) | `--warn` `#9a6700` to `#946200` (4.75:1); `--ok` `#1a7f4b` to `#187a47` (4.74:1). Dark theme already 5.99-7.94:1 | Scenario 16 re-scan: 0 low-contrast elements, 0 horizontal overflow at 320/390/768/1366 px |
| `credentialsCloseout44b` timeout | CPU-bound work with no shared state or leak: each test builds a full server and applies 23 migrations to a fresh in-memory database (about 75 ms per build; 0.5-0.9 s per test alone, 2.9 s under 8 CPU burners) | 20 s timeout on the two production tests only, with the evidence in a comment; assertions unchanged | Passes alone and in full runs (up to 4.1 s under load) |
| `guidedFlow` "same website again" timeout | Two website analyses and waits that sum to 23 s inside a 5 s default; 2.9 s alone, 3.4-5.0 s in full runs; reproduced with the **old** `app.js` too, so not caused by the redraw fix | 30 s timeout, matching the six sibling tests in that file | Passes |

Verification (all offline): `npx tsc --noEmit` clean. Three consecutive full-suite runs: run 2 and run 3 **70/70 files, 1764 passed, 20 skipped, 0 failed**; run 1 (the one with the network audit hook, during heavy unrelated load on the machine: CPU was 65% with nothing of this project running, and Chrome, MetaTrader and OneDrive among the top users) had **12 failures, all "timed out in 5000ms"** across six files (guidedFlow 7, launchReadiness 2, authz, experiments, securityBoundary), each of which passes alone. Network audit over run 1: 358 socket events, 343 to 127.0.0.1, 15 refused by the SSRF guard, **0 external connections or DNS lookups**.

**Not resolved:** the suite is still intermittently timing out under heavy machine load because dozens of heavy tests run close to the 5 s Vitest default (about 30 tests exceed 3 s under full-suite load). Fixing them one by one has not been enough. The proposed fix is a single `testTimeout: 20000` in `vitest.config.ts`; it changes no assertion but would let a hung test run for 20 s before failing, so it needs a decision.

No database was reset or migrated in this follow-up; no commit or push was made; no live provider call occurred.

## 9. Residual advisory: `zod`

Unchanged and still open: `zod` 3.25.76, GHSA-mrhx-c7xc-m3w5 (high). The interim bounded-array mitigation is **proposed, not implemented**; see the plan in the hand-off message. Migrating to Zod 4 remains a **mandatory pre-public-launch task**.
