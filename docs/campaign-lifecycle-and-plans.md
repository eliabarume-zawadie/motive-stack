# Campaign lifecycle, marketing plans and batch drafts (Master PRD Phase 3)

All of this runs in mock mode. Nothing here contacts a model provider, an ad platform or a CRM, and nothing is published or spent.

## The campaign lifecycle

One state machine, enforced on the server (`src/app/lifecycle.ts`):

`idea` (an opportunity in a plan) → **draft** → **needs review** → **awaiting approval** → **approved, not run yet** → **queued to run** → **run (simulated)** or **run (live)** → **completed** → **archived**

| State | What makes it so |
|---|---|
| Draft | The campaign is being written or edited. |
| Needs review | The brief has a blocking question or a review flag. |
| Awaiting approval | A proposal for the current version is open. |
| Approved, not run yet | A person approved it. Approving never runs anything. |
| Queued to run | A run was requested and its job is queued or running. |
| Run (simulated) / Run (live) | A paused draft exists in the simulator, or on a real platform if a live proposal executed. |
| Completed | An admin marked a run campaign completed. |
| Archived | An admin archived it. Final. |

**How it is kept honest.** The state is derived from the facts (the legacy status, the latest proposal and its job, the brief, and two explicit markers) and cached in `campaigns.lifecycle_state`. It is re-derived after every event that can change a campaign (generate, edit, propose, approve or reject, request a run, the executor). **Explicit actions are strict**: archive and complete go through the transition table and an invalid change is refused with `invalid_transition` (for example, archiving while a run is queued, or completing a campaign that was never run). A derived change that the table would not allow is still recorded, flagged `anomaly: true` in the audit entry, so it is never hidden and never blocks a real event.

**Legacy values keep their meaning.** `campaigns.status` (`draft`, `launched_paused`) is untouched and the executor still writes it. The migration maps: `draft` → draft (awaiting approval or approved while a proposal is open); `launched_paused` → run (simulated), or run (live) if a live proposal executed. Nothing is dropped, and the start-up sync re-applies the exact rules without changing a campaign that is already right.

Editing a campaign after approval returns it to draft and makes only its own proposal stale. Pause, resume and "completed by results" are **not implemented**: the domain model has no such actions, and there is no real performance data to complete against.

## Three ways to start

1. **One campaign**: the existing generate route (with an optional goal and focus service).
2. **A recommended plan**: `POST /plans/recommend`. **Rule-based**, from the services you confirmed in the Business Brain: one separate campaign opportunity per service. It is not a model's opinion and not a forecast, and it says so. What the Business Brain does not say is listed as *unknown*, never as "not offered".
3. **A batch**: `POST /plans/:id/generate` makes a draft for every selected opportunity.

A plan is never approved as a whole. Each campaign it produces is an ordinary campaign with its own versions, proposal, approval and lifecycle; approving one never covers another, and editing one makes only its own approval stale.

### Choosing what to make
Opportunities can be kept, left out, saved for later or renamed, and a failed one can be retried. A **duplicate check** flags an opportunity whose service already has a live campaign and will not generate it until the owner confirms it should be separate. After generation, how alike a campaign's copy is to a sibling is reported (not hidden). A model-free rule is used: in mock mode the draft follows the service, not the angle or goal wording, so two angles on one service would look alike and be flagged.

### Resumable and idempotent
An opportunity is *claimed* (`selected`/`failed` → `generating`) before anything is requested, and the campaign and the claim complete in **one transaction**. The database also refuses a second campaign for one opportunity (`campaign_id` is unique). Running the batch again finishes what is left and never duplicates; two at once make one campaign each. A failure marks only that opportunity failed, with a safe one-line message, and the rest continue. A generation left "being made" for over 10 minutes (the server stopped) is released for retry; a recent one is left alone. Batches are synchronous requests with a **hard limit of five drafts per request** (tested); there is no durable background generation yet.

## Plan budgets
- A plan has **one daily total**, never above the Business Brain's ceiling. **The ceiling is a workspace-wide limit across ALL plans and stand-alone campaigns together** (see [daily-budget-limit.md](daily-budget-limit.md)); a plan's total is only a cap for its own campaigns and is never added to the sum of what is committed.
- Each opportunity may have a **planned share**. Shares plus the total are checked on every change (`allocation_exceeds_total`, `budget_exceeds_ceiling`). An equal split rounds down and reports the unassigned remainder; the total is never multiplied by the number of campaigns.
- A campaign in a plan **cannot be proposed** until: the plan has a total; its campaigns (not archived) add up to no more than that total (`plan_budget_exceeded`); it is within its own share (`plan_allocation_exceeded`); and a person has **reviewed the exact current numbers** (`plan_budget_not_reviewed`). The review stores a fingerprint of the total, every share and every campaign's current budget and version. A later change (a budget edit, a share, selecting or leaving out an opportunity, archiving a campaign) makes it stale. With separation of duties on, the reviewer is not the person who last changed those numbers (same rule and same honest "not enforceable with the shared token" record as proposals).
- "Lower campaigns to their shares" applies each over-share campaign's share as a clearly labelled edit by a person (a new version each), never raises a budget, and leaves a run campaign alone.
- The workspace-wide limit is enforced when a campaign is proposed, approved or run, counting everything already approved or running once. A plan view shows what the limit leaves for it and warns when other commitments leave too little.

## Permissions
`plans.read` (viewer), `plans.write` (operator: ask for a plan, edit, generate, regenerate, archive), `plans.review` (admin: review the budget), `campaigns.archive` (admin: archive or complete a campaign). Custom roles may include them. Plans, opportunities and their campaigns are workspace-private.

## Known gaps and where they are tracked

| Gap | State today | Tracked in |
|---|---|---|
| **Batch limit** | Five drafts per request, synchronous. Not to be raised without evidence and approval. | Persisted background jobs: Master **Phase 5** (jobs and operations). |
| **Pause and resume** | **Not implemented.** The campaign lifecycle is an *internal workflow* status. A paused draft on an ad platform is a different thing (the platform's own state); no pause or resume action exists, and no live pause or resume can be done without separate explicit authorization. | An internal workflow pause: Phase 5. Live platform pause/resume: **Phase 8** (controlled execution readiness), after authorization. |
| **Calendar and ownership** | Not built. | **Phase 5.** Data prerequisites that do not exist yet: an owner and reviewer per campaign, due dates, a schedule record linking a campaign version, an asset version and a job, a task/approval inbox, and a workspace time zone. |
| **Sequencing and dependencies** | **Not enforced.** The campaigns in a plan are independent: no order, schedule or dependency between them exists, and the screens say so. | Schedule and order: Phase 5. Execution order: Phase 8. |
| **Creative asset attachment** | Built in Phase 4 as a Creative Studio: an approved creative is linked to its campaign and pinned in the proposal payload; nothing is sent to a platform. See [creative-studio.md](creative-studio.md). | Done (Phase 4) |
| **Plans panel refresh** | The panel refreshes when the workspace opens and after your own actions, not on a timer. Accepted for this phase. | Revisit with background jobs (Phase 5); no timers will be added just to look dynamic. |

## Mock honesty and other notes
- A focus service now narrows what the mock (and a real model) is shown to that one service, so drafts for different services differ; validation still uses the **whole** Business Brain, so a draft can never claim more than the brain allows. The mock still ignores the goal wording, the angle and the planned share (a real model is told the share). This corrects `campaign-planning.md`, which said the mock ignores the focus.
- The plan's campaigns share a budget but are not sequenced; dependencies between campaigns are not modelled (see the table above).
