# MotiveStack - Meta Integration: Go / No-Go (Deliverable E)

Date: 2026-10-15. Evidence: [meta-feasibility.md](meta-feasibility.md). Code: `src/`, `scripts/`.
No tokens or secrets appear here.

## Decision

| Scope | Decision |
|---|---|
| Read-only: ad accounts, campaigns, lead forms, leads (own assets, app role-holders) | **GO** |
| Paused campaign and ad set creation, sandbox | **GO** |
| Lead retrieval from a Page you control | **GO** |
| Creating ad creatives and ads (any account, including sandbox) | **NO-GO** until the app is Live |
| Onboarding customers' ad accounts and Pages (OAuth for non-role-holders) | **NO-GO** until App Review and Business Verification |
| Webhook-based real-time lead delivery | **NOT YET DECIDED** (untested; needs a public HTTPS endpoint) |
| Creating Instant Forms through the API | **NOT YET DECIDED** (needs a privacy policy URL) |

**Overall: conditional GO for the next stage, a small internal build and test phase. NO-GO for any design-partner use that needs publishing or non-role-holder accounts.**

## What is verified (with evidence)

| Capability | Evidence |
|---|---|
| App configured for Marketing API ("Create & manage ads" use case) | Dashboard, 2026-10-15 |
| Read ad account | Real `act_1722907322150891` and sandbox `act_2327392417830705` both read successfully |
| Read campaigns | Real account: none. Sandbox: campaign `120330000133172415` |
| Create a campaign, paused, and verify it | Sandbox campaign created PAUSED, read back as PAUSED, OUTCOME_LEADS, no budget |
| Create a paused ad set | Sandbox ad set `120330000133173515` (LEAD_GENERATION, ON_AD), read back PAUSED, after the Page accepted the Lead Generation ToS |
| Upload an ad image | Sandbox image hash returned |
| Retrieve a lead | Test lead `1099050259370881` on form `2117893429115072` (Page `1368224686372492`), read via API and via the connector |
| Failure behavior | Typed errors verified live (bad ID, bad token, wrong token type); rate-limit, transient, timeout and retry rules covered by tests |
| No unauthorized activation or spend | All campaign and ad set objects are PAUSED; sandbox `amount_spent` is 0; real account has 0 campaigns |

## What is blocked, and why

| # | Blocker | Evidence | Needed to clear |
|---|---|---|---|
| 1 | **App is in Development mode / Marketing API tier is "Limited"** | Dashboard: higher tier requires a published app and App Review approval | Publish app; request the access tier through App Review |
| 2 | **Ad creative cannot be created** | 400, subcode 1885183: creative post made by an app in development mode "must be in public" | App Live (see 1) |
| 3 | **Business portfolio is Unverified** | Dashboard shows "Unverified" | Business Verification for "Motive stack" (portfolio 2220632158517292) |
| 4 | **No privacy policy URL** | Required by Meta for publishing, review, and API form creation (400 subcode 1892075) | Fill placeholders in `docs/site/privacy.html`, host at an HTTPS URL, enter it in app settings |
| 5 | **Customer authorization untested** | Meta's "add user" feature was disabled when tried | Retry adding a Tester; test the Facebook Login flow |
| 6 | **Webhooks untested** | No subscribed apps on the Page; no public endpoint exists | Public HTTPS endpoint, then subscribe to `leadgen` |
| 7 | **Lead retrieval for customers' Pages** | Meta docs: requires App Review for `leads_retrieval` and `pages_manage_ads`, then Business Verification. Docs disagree on Development-mode behavior; only own-Page retrieval was tested | App Review; test with a second role-holder |

## Risks and unknowns
- **Review outcomes are not in our control.** Meta decides on App Review and verification, with unpredictable timing. I haven't researched current review timelines or screencast requirements.
- **Policy fit.** AI-generated ad content and automated management may attract extra scrutiny. I haven't checked Meta's current rules for apps that manage ads on behalf of others.
- **Sandbox is not production.** It never delivers ads and may differ from live behavior.
- **Token handling is manual.** Tokens used so far were short-lived and pasted into a local file. Per-tenant token storage, refresh and revocation are not built.
- **Tool and dashboard behavior can change.** Several dashboard labels and tester features changed or were disabled during this work.
- **A real token was visible in a screenshot** earlier in the project. Make sure it has been revoked.

## Does the MVP scope change?
Yes, for the first design-partner release:
1. **Defer "publish a lead ad" end to end.** It depends on a Live app. Until then, the product can read performance and leads, and prepare paused campaigns and ad sets.
2. **Limit initial partners to people who can be given an app role**, or defer partners until the app is Live and approved. I haven't verified that partner Pages and ad accounts work with only a Tester role.
3. **Keep human approval on every write**, as already built (approval grant, allow-list, paused-only drafts, read-back verification).
4. **Treat creatives as a manual step** in Ads Manager if you need an interim flow. I haven't tested that this works with an API-created paused campaign and ad set.

## Success criteria from the original brief

| Criterion | Status |
|---|---|
| Developer app configuration verified | Done |
| Required access and permissions documented | Done |
| Authorized ad account read successfully | Done |
| Campaign operations tested to the extent access permits | Done (campaign, ad set, image; creative and ad blocked) |
| Supported lead retrieval path verified | Done for own Page; customers pending |
| Failure and retry behavior understood | Done (tested) |
| No unauthorized activation or spend | Confirmed |
| Unresolved requirements documented | Done (table above) |

The feasibility work is complete for what the current access allows. Items 1-7 above are the remaining gaps, not unknowns in the approach.

## Recommended next actions, in order
1. Complete `docs/site/privacy.html`, buy and set up `motivestack.io`, and host the page.
2. Add the privacy policy URL and data-deletion instructions in the app settings.
3. Start Business Verification for "Motive stack LLC".
4. Check Meta's current Live-mode and App Review requirements, then prepare the review submission (use case descriptions and screencasts).
5. Retry adding a Tester; run the OAuth login test.
6. Build a small webhook endpoint and test `leadgen` delivery.
7. Re-run the creative and ad tests once the app is Live.
