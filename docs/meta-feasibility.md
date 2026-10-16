# MotiveStack - Meta Ads Feasibility (working report)

Last updated: 2026-10-15. No tokens or secrets appear in this file.
Graph API version used in tests: v25.0 (Graph API Explorer offers v26.0; confirm the current version before coding).

## Deliverable A - Setup verification

| Item | Value / status | Evidence |
|---|---|---|
| Use case | "Create & manage ads" configured | Dashboard screenshot |
| App mode | Development (not published) | Dashboard: tier requires "App must be published" |
| Marketing API access tier | **Limited** (`development_access`) | Dashboard Settings + Tools |
| Business portfolio | "Motive stack", ID 2220632158517292, **Unverified** | Dashboard Settings |
| Real ad account | `act_1722907322150891`, "Elia Barume", active, USD, America/Los_Angeles, $0 spent, 0 campaigns | API read |
| Facebook Page | "Motivestack", `1368224686372492`; tasks include MANAGE_LEADS, ADVERTISE | API read |
| Sandbox ad account | `act_2327392417830705`, "MotiveStack Sandbox", USD, Page associated | API read + dashboard |
| Required Actions tab | Empty | User report |

### Permissions (all "Ready for testing", i.e. usable by app role-holders only)
- Granted on a real-user token: `ads_read`, `ads_management`, `business_management`, `pages_read_engagement`, `pages_show_list`, `public_profile`.
- Granted on the sandbox token: `ads_management`, `pages_read_engagement`, `pages_manage_metadata`, `pages_read_user_content`, `pages_manage_ads`, `public_profile`.
- Not available in this use case: `leads_retrieval` (not listed in Permissions and features).

### Token behavior learned
- Real-account tokens (Tools > Get Token or Graph Explorer) and the sandbox token (Tools > sandbox row > "Get access token") are different. Real tokens get error #200 on the sandbox account; the sandbox token acts as a separate "Sandbox Ad Account Owner" user.
- Tokens must live only in a git-ignored file / secret store. `secret-key` is ignored via `.gitignore`.

## Deliverable B - API feasibility

| # | Operation | Required access | Result | Evidence | Blocker |
|---|---|---|---|---|---|
| 1 | Read ad account info | `ads_read` | PASS (real + sandbox) | Account fields returned | None for role-holders |
| 2 | Read campaigns / performance | `ads_read` | PARTIAL | Campaign list works (empty). Insights untested: no data | Needs a campaign with delivery; real data needs tier/review |
| 3 | Create campaign | `ads_management` | PASS in sandbox | Campaign `120330000133172415` created PAUSED, read back: PAUSED, OUTCOME_LEADS | Real-account write not tested (deliberately) |
| 3a | Create ad set / creative / ad | `ads_management`, Page permissions | NOT TESTED | - | Next sandbox test |
| 4 | Retrieve Instant Form leads | `leads_retrieval`, `pages_manage_ads`, `pages_read_engagement`, `pages_show_list`; `pages_manage_metadata` for webhooks | PASS (Development mode, role-holder, Page token) | Form `2117893429115072` ("Ms Test Form", created in Meta UI). Test lead `1099050259370881` created via `POST /{form_id}/test_leads`, read back via `GET /{form_id}/leads` (FULL_NAME, EMAIL fields; leads_count 1) | Customer Pages: App Review + Business Verification. Webhook delivery untested (no endpoint) |
| 4a | Create Instant Form via API | `ads_management`, `pages_manage_ads`, Page token | BLOCKED (input) | POST returned 400 subcode 1892075: `legal_content_id` or `privacy_policy` required | Supply a privacy policy URL; retry |
| 3b | Create paused ad set (sandbox) | `ads_management`; Page must accept Lead Generation ToS | PASS (after ToS accepted) | Ad set `120330000133173515` created PAUSED (LEAD_GENERATION, ON_AD, $10/day budget in sandbox). Earlier 400 subcode 1815089 until the Page accepted the Lead Gen ToS | None |
| 3c | Upload ad image (sandbox) | `ads_management` | PASS | Image hash `3b31846928df3d270983ad4e1499c035` | None |
| 3d | Create ad creative (sandbox) | `ads_management`, `pages_manage_ads`; app must be Live | BLOCKED | 400 subcode 1885183: "Ads creative post was created by an app that is in development mode. It must be in public to create this ad." | Publish app (needs privacy policy URL, app settings, possibly review) |
| 3e | Create ad | needs a creative | NOT TESTED | - | Depends on 3d |
| 5 | Authorize customer ad accounts (OAuth) | Higher Marketing API tier, published app | BLOCKED | Dashboard: tier needs published app + App Review | App Review, Business Verification |
| 5a | OAuth flow with a second user | App role (Tester) | NOT TESTED | Meta UI: "adding user feature is disabled temporarily" (user report) | Retry later; or test the flow with the owner account only |

### Findings that affect the connector design
- Campaign create requires `special_ad_categories` and, without a campaign budget, `is_adset_budget_sharing_enabled` (first attempt failed with HTTP 400, subcode 4834011; nothing was created).
- A timed-out create must never be retried blindly: list campaigns by name first, or use an idempotency strategy.
- Meta docs conflict on whether Development-mode apps can retrieve leads. Unresolved; test with role-holders.
- A tool-permission block prevented extracting a Page access token locally, so Page-level lead-form probes are untested.

## Open items
1. Graph Explorer: add `leads_retrieval` if offered; run `GET /1368224686372492/leadgen_forms`.
2. Decide whether lead retrieval needs an additional use case.
3. Business Verification for portfolio 2220632158517292.
4. Sandbox: create ad set, creative and ad (paused) and read back.
5. Confirm current Graph API version.
6. Clean stale tokens from `secret-key`; revoke the token exposed in the Graph Explorer screenshot.
