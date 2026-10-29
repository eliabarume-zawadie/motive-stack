# Localhost MVP acceptance-test plan

Scope: everything runs on one machine, in **mock mode**, with simulated Meta, CRM and AI. No hosting, cloud identity provider, off-host backup or live integration is involved. This plan says what to run, what each scenario proves, what evidence to keep, and which parts are **not yet covered** (section 5), so that a pass is never claimed for something that was not executed. It does not say MotiveStack is ready for a pilot or a launch.

## 1. Ground rules

- **Disposable data only for anything that changes state.** Retry, erase, import, restore, close, role changes, and every browser scenario run against a **fresh temporary database** (the automated tests use `:memory:`; the browser harness makes a new file per scenario). The real populated database (`data/motivestack.db`) is touched by **no** scenario here. The only operations allowed on it are read-only ones (the inventory and comparison scripts in [move-data-outside-onedrive.md](move-data-outside-onedrive.md)); `npm run backup` against it writes a new folder under `data/backups` and is done only when you ask for it.
- **No external calls.** `test/setup.ts` replaces `fetch` with a stub that throws and fails the test file if anything tries. For the whole suite the stronger check in A12 also records every socket. Live-provider tests (`npm run test:live*`) are never part of this plan.
- **Evidence** means a command and its exact output (counts, exit status), a saved scenario log, or a screenshot path. A scenario is "passed" only if it was executed in the run being reported.

## 2. How to run

**A. Automated (repository, runs anywhere Node 22 is installed)**
```
npx tsc --noEmit -p .                         # type check, must print nothing
npx vitest run                                # whole suite; expect 0 failed
npx vitest run test/<file>.test.ts            # one scenario's tests (files named below)
```
**B. Real-browser scenarios (headless Edge, one fresh server and database per scenario).** The harness is **not in the repository** (it lives in the working session's scratch folder, `...\scratchpad\qa`); run it from there:
```
node runall.cjs 5,6,7,8,9,10,11,12,13,14,15,16     # each scenario's FIRST attempt is reported; a retry never hides a failure
```
Scenario 16 prints an accessibility and responsive report instead of a pass count. Run these on an otherwise idle machine; they are timing sensitive.

**C. Manual walk-through on a disposable database (outside OneDrive)**
```
$S = "$env:TEMP\ms-accept"; New-Item -ItemType Directory -Force "$S\assets" | Out-Null
$env:DATABASE_PATH="$S\accept.db"; $env:ASSET_DIR="$S\assets"; $env:PORT="3390"
$env:INTEGRATION_MODE="mock"; $env:AI_PROVIDER_MODE="mock"; $env:ALLOW_LIVE_PROVIDER_CALLS="false"; $env:LIVE_META="false"
npm start                                      # then open http://127.0.0.1:3390 ; stop with Ctrl+C
```
Open a new shell afterwards so the variables are gone. Delete `$S` only when you have finished with it. (Use `127.0.0.1` for scripted checks: `localhost` stalls in Windows PowerShell because it tries IPv6 first.)

## 3. Scenario summary

| ID | Area | Automated evidence (files in `test/`) | Browser scenario | Manual step needed | Disposable DB |
|---|---|---|---|---|---|
| A1 | Startup and mock safety | `productionSafety`, `integrations`, `launchReadiness` | 14, 5 (step 1) | start-up text and `/api/config` | yes (or in-memory) |
| A2 | Sign-in, roles, permissions, isolation | `auth`, `authServer`, `authz`, `authzFixes`, `organizations`, `securityBoundary`, `workspaces`, `separationOfDuties`, `launchReadiness` | 6, 11 | token of A against B | yes |
| A3 | Business Brain persistence | `ui.dom`, `guidedFlow.dom`, `websiteAnalysis`, `workspaces` | 5 (steps 2-3) | restart then reload | yes |
| A4 | Campaigns: create, validate, edit, versions | `campaigns`, `campaignQuality`, `versionsAndBaseline`, `campaignPlan`, `plans` | 5 (4-6), 8, 9 | none | yes |
| A5 | Mock Creative Studio and asset provenance | `creatives`, `brandKitAssets` | 7, 10 | none | yes |
| A6 | Approval versus execution | `separationOfDuties`, `workflow` | 5 (step 7), 8 | none | yes |
| A7 | Simulated Meta/CRM and labels | `integrations`, `workflow`, `leadsJobs`, `dashboard` | 14, 5, 12 | none | yes |
| A8 | Leads: import, export, erasure, separation | `leadLineage`, `leadsJobs`, `launchReadiness` | 12, 15 | none | yes (erasure is destructive) |
| A9 | Job retry, restart, backup, restore | `workflow`, `leadsJobs`, `launchReadiness` (backup/restore) | 5 (step 8) | `backup` and `restore:check` on a copy | yes |
| A10 | Error logging, redaction, unsafe startup | `errorLog`, `productionSafety`, `launchReadiness`, `securityBoundary` | none | none | yes |
| A11 | Browser usability and responsive layouts | `ui.dom`, `guidedFlow.dom` (jsdom only) | 16 plus every scenario | keyboard and screen-reader pass (not done) | yes |
| A12 | No external provider calls | `test/setup.ts` (every file), `integrations`, `productionSafety` | all | socket audit over a full run | yes |

## 4. Scenarios

### A1. Startup and mock-provider safety
- **Prerequisites:** a disposable database or `:memory:`; `INTEGRATION_MODE`, `AI_PROVIDER_MODE` unset or `mock`.
- **Steps:** (1) start the server as in 2C. (2) `curl.exe -s http://127.0.0.1:3390/api/config`. (3) `curl.exe -s http://127.0.0.1:3390/api/health/ready`. (4) `npx vitest run test/productionSafety.test.ts test/integrations.test.ts`.
- **Expected:** start-up text `Mode: MOCK | Meta: simulated | AI: mock only | CRM: simulated`; config shows `"mode":"mock"` and `"live":{"meta":false,"ai":false,"ghl":false}`; readiness `{"ok":true,...}`; the browser banner says simulated. With `DEPLOYMENT_ENV=production` and any live switch (or a misspelt `DEPLOYMENT_ENV`) the web server **and** the worker exit 1 before creating any file.
- **Evidence:** the start-up text, the two curl outputs, the vitest counts.

### A2. Authentication, roles, permissions, cross-workspace isolation
- **Prerequisites:** two workspaces, each with its own owner. Local mode uses one access token per workspace; the identity-provider path is exercised only with a **simulated** provider in tests.
- **Steps:** `npx vitest run test/auth.test.ts test/authServer.test.ts test/authz.test.ts test/authzFixes.test.ts test/organizations.test.ts test/securityBoundary.test.ts test/workspaces.test.ts test/separationOfDuties.test.ts test/launchReadiness.test.ts`. Manually: create workspaces A and B (2C), then call a B route with A's token.
- **Expected:** every workspace route is in the permission table (default deny); unauthenticated callers get 401; a non-member gets no 2xx and no 5xx on any route; another workspace's ids are not found; operators cannot approve; a person cannot approve their own proposal; the manual cross-token call is refused (401/403/404, never 2xx).
- **Evidence:** vitest counts; the manual call's status line.
- **Not covered:** a real identity provider and browser sign-in (section 5).

### A3. Business Brain persistence
- **Steps:** `npx vitest run test/ui.dom.test.ts test/guidedFlow.dom.test.ts test/websiteAnalysis.test.ts test/workspaces.test.ts`; browser scenario 5. Manually: save a Brain, stop the server, start it again on the **same** disposable database, reload the page.
- **Expected:** facts keep their source and provenance; owner-written lines survive a re-analysis; unsupported claims are not auto-verified; after the restart the saved Brain and its version are still there.
- **Evidence:** scenario 5 log; before/after screenshots or the `/brain` version number.

### A4. Campaign creation, validation, editing, version history
- **Steps:** `npx vitest run test/campaigns.test.ts test/campaignQuality.test.ts test/versionsAndBaseline.test.ts test/campaignPlan.test.ts test/plans.test.ts`; browser scenarios 5, 8, 9.
- **Expected:** a goal produces a reviewable mock draft; an edit creates version 2 and the history shows what changed; an over-budget version fails its platform checks with a plain message and creates no proposal; plan budgets reconcile with campaign budgets.
- **Evidence:** scenario logs; vitest counts.

### A5. Mock Creative Studio and asset provenance
- **Steps:** `npx vitest run test/creatives.test.ts test/brandKitAssets.test.ts`; browser scenarios 7 and 10.
- **Expected:** pictures are placeholders from the mock image provider and are labelled so; asset versions keep source, rights basis and approval status; a generated picture is never auto-approved; changing material content invalidates the approval.
- **Evidence:** scenario logs.

### A6. Approval versus execution separation
- **Steps:** `npx vitest run test/separationOfDuties.test.ts test/workflow.test.ts`; browser scenario 5 step 7.
- **Expected:** approving records a decision and queues **no** job ("NOT RUN YET"); running needs a separate permission and is audited; running twice is idempotent; an approval that no longer counts (expired, approver removed, campaign changed) is refused.
- **Evidence:** vitest counts; scenario 5 shows "NOT RUN YET" after Approve and the executed state only after "Run (simulated)".

### A7. Simulated Meta/CRM flows and labels
- **Steps:** `npx vitest run test/integrations.test.ts test/workflow.test.ts test/leadsJobs.test.ts test/dashboard.test.ts`; browser scenarios 14, 5, 12.
- **Expected:** every integration card states what is real and what is simulated; the execution lock says nothing reaches the outside world; simulated results carry SIMULATED badges everywhere; analytics never mixes simulated with real figures; `LIVE_GHL=true` is rejected.
- **Evidence:** scenario 14 log (registry), screenshots of SIMULATED badges.

### A8. Lead import, export, erasure, workspace separation
- **Prerequisites:** disposable database (erasure is destructive).
- **Steps:** `npx vitest run test/leadLineage.test.ts test/leadsJobs.test.ts test/launchReadiness.test.ts`; browser scenarios 12 and 15.
- **Expected:** exactly 200 rows import and 201 are refused; a duplicate event creates one lead; export contains the workspace's data with every secret removed; erasing a lead removes its name, e-mail and phone from every table and leaves the audit trail free of them; another workspace's leads are unreachable.
- **Evidence:** vitest counts; scenario 15 log.

### A9. Job retry, restart recovery, backup and restore on a copy
- **Prerequisites:** a disposable database with at least one lead and one executed proposal.
- **Steps:** `npx vitest run test/workflow.test.ts test/leadsJobs.test.ts test/launchReadiness.test.ts`. Manually on the disposable database: `$env:BACKUP_DIR="$S\backups"; npm run backup` then `npm run restore:check -- <that folder>`.
- **Expected:** a job orphaned in "running" is re-queued and completes; a crash after dispatch never sends twice (it reconciles, or goes to human review); a failed job is retried a bounded number of times, then shown as "gave up" with a safe message; backup passes 7/7; restore check passes 12/12 and never touches the source database.
- **Evidence:** the two command outputs.
- **Not covered:** a rollback or restore on a different host.

### A10. Error logging, secret redaction, unsafe production and worker startup
- **Steps:** `npx vitest run test/errorLog.test.ts test/productionSafety.test.ts test/securityBoundary.test.ts`.
- **Expected:** one JSON line per server error with request id, route template, status, category and error class; none of the planted secrets (body, query, headers, bearer token, cookie, error message, ids) appears; client-sent request ids are ignored; a repeated-error alert line appears once per window; production refuses live switches, a missing database path and a misspelt `DEPLOYMENT_ENV`, for both the web process and the worker, before any file is created.
- **Evidence:** vitest counts.

### A11. Browser usability and responsive layouts
- **Steps:** browser scenarios 6 to 15 (the real flows) and 16 (report).
- **Expected:** every flow passes on its first attempt; at 320, 390, 768 and 1366 px there is no horizontal overflow, headings do not skip, controls have names, and the status colours meet 4.5:1.
- **Evidence:** scenario logs; scenario 16's report.
- **Not covered:** keyboard-only and screen-reader use; browsers other than Edge; touch devices.

### A12. No external provider calls during the suite
- **Steps:** `npx vitest run` (the stub fails any attempt). Stronger: run it with the socket audit (scratch file `netaudit.cjs`): `NETAUDIT_FILE=<out.jsonl> NODE_OPTIONS="--require <path>\netaudit.cjs" npx vitest run`.
- **Expected:** 0 failed; in the audit every recorded connection is to `127.0.0.1` (or refused by the SSRF guard before connecting), with 0 external connections and 0 external DNS lookups.
- **Evidence:** the run counts and the audit summary.
- **Not covered:** the audit hook is outside the repository.

## 5. Known gaps (nothing here is claimed as passed)

1. **No browser sign-in and no real identity provider.** Sign-in is verified only against a simulated provider in tests. Localhost development uses the per-workspace token.
2. **The browser harness and the socket-audit hook are outside the repository**, so a reviewer cannot re-run A2 to A11 in the browser, or A12's audit, from the repo alone.
3. **No keyboard-only or screen-reader pass**; Edge only.
4. **No test that a stopped-and-restarted server keeps data** beyond the automated recovery tests; A3's restart step is manual.
5. **Backup, restore and rollback are rehearsed on this machine only.**
6. **Suite reliability under heavy CPU load is unproven.** All runs above were at 33% to 63% background CPU.
7. **One dashboard control is smaller than 24 px** (reported by scenario 16, not yet identified).
8. **The manual parts of A2, A3 and A9 were not executed in this record**, so those scenarios are covered by automated tests and browser flows only.

## 6. Execution record (2026-10-29, on the final code of this phase)

Everything below was run on a Windows machine that was also running the person's other programs, against disposable databases only. "Executed" means the command ran in this record; anything marked **Not executed** was not.

**Commands and results**

| Command | Result |
|---|---|
| `npx tsc --noEmit -p .` | clean, no output |
| `npx vitest run` (3 consecutive runs; run 2 with the socket-audit hook) | each run: 73 files, **1800 passed, 0 failed, 20 skipped**; 169 s, 153 s, 155 s; CPU before the runs 41%, 33%, 63% |
| Socket audit (run 2) | 374 events: 359 connections to 127.0.0.1, 15 refused by the SSRF guard before connecting, **0 external connections, 0 external DNS lookups** |
| `node runall.cjs 5,6,7,8,9,10,11,12,13,14,15,16` | first attempts: 5: 24/24, 6: 9/9, 7: 12/12, 8: 12/12, 9: 10/10, 10: 15/15, 11: 12/12, 12: 15/15, 13: 13/13, 14: 12/12, 15: 11/11 (**11 of 11 flows passed first time, 0 redraw retries**); 16 is a report, not a pass count (its "FAIL null/null" line is only the runner finding no count) |
| Scenario 16 report | 0 low-contrast elements; 0 horizontal overflow at 320, 390, 768 and 1366 px; 1 h1; no skipped headings; no duplicate ids; no unnamed controls; **1 control smaller than 24 px on the dashboard (not identified; open)** |

The skipped 20 tests are the live-provider and local-model tests, which this plan never runs.

**By scenario**

| ID | Executed | Result | Not executed |
|---|---|---|---|
| A1 | `productionSafety` (13), `integrations` (21) inside the suite; browser 14, 5 | passed | the manual start-up walk-through of 2C was last done in the previous phase, not repeated here |
| A2 | the nine test files inside the suite; browser 6, 11 | passed | manual cross-token call; a real identity provider (not built) |
| A3 | tests inside the suite; browser 5 | passed | manual stop/start persistence check |
| A4 | tests inside the suite; browser 5, 8, 9 | passed | none |
| A5 | tests inside the suite; browser 7, 10 | passed | none |
| A6 | `separationOfDuties`, `workflow` inside the suite; browser 5 (shows "NOT RUN YET" after Approve), 8 | passed | none |
| A7 | tests inside the suite; browser 14, 5, 12 | passed | none |
| A8 | tests inside the suite; browser 12, 15; the new lead-panel regression test in `ui.dom` | passed | none |
| A9 | `workflow` crash/restart tests and `launchReadiness` backup/restore tests inside the suite; browser 5 step 8 | passed | the manual `npm run backup` / `restore:check` on a disposable database in this record (both were rehearsed on a scratch copy in the previous phase: 7/7 and 12/12) |
| A10 | `errorLog` (9), `productionSafety` (13), `securityBoundary` inside the suite | passed | none |
| A11 | browser 6 to 15, 16 | passed (see the 16 report above) | keyboard-only and screen-reader use; browsers other than headless Edge; touch devices |
| A12 | whole suite with the stub, plus the audited run | 0 failed; 0 external connections | none |

**Defects found by this run, and fixed**

1. A lead's detail panel (and its Erase button) was rebuilt a second time right after opening, because opening a lead changed the list's key. Browser scenario 15 caught it as one redraw retry; a reason typed into the panel could also have been wiped. Fixed in `public/leads.js` (the open lead is reloaded only when the lead data changed or its panel is empty); regression test added to `test/ui.dom.test.ts` (fails without the fix); scenarios 12 and 15 then passed with zero redraw retries, and the whole browser set again with zero.
2. A misspelt `DEPLOYMENT_ENV` (for example `prod`) made the web server and the worker refuse only after creating the database file. Now refused first (two tests added; fail without the fix).
