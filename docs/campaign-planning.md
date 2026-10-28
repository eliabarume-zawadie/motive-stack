# Campaign planning: goal, version history and the list

## The goal (Step 3)

`POST /api/workspaces/:wid/campaigns/generate` accepts, besides the optional model choice:

- `goal`: `lead_generation` (default), `promote_service` or `local_awareness`
- `focusService`: one of the services in the saved Business Brain (required for `promote_service`; matched ignoring case and spacing)
- `durationDays`: a whole number from 1 to 90

A bad plan is refused with `400 invalid_plan` before any model request, so it costs nothing. The plan is stored in `campaign_plans` (migration 013), is returned as `plan` with the campaign, and is written to the audit entry `campaign.generated`.

What the goal does and does not do:

- The Meta objective stays **lead generation** in every case. The campaign brief schema and prompt/schema hashes are unchanged.
- For a real model the goal, focus service and run length are appended to the user prompt inside `<owner_goal>` tags, as the owner's note. They add no fact about the business, and the model is told not to predict results.
- The rule-based **mock** draft does not change with the goal wording. **Update (Phase 3):** a focus service now narrows what the model (and the mock) is shown to that one service, so drafts for different services differ; validation still uses the whole Business Brain. Nothing is forecast. See [campaign-lifecycle-and-plans.md](campaign-lifecycle-and-plans.md).

## Version history

`versionHistory` on the campaign view lists every version and, for each after the first, the fields that changed (`label`, `from`, `to`), computed from the stored briefs. A person's edit always creates a new version and makes open proposals for older versions stale (existing behaviour).

## Campaign list

The list on the Campaigns page can be searched by name or the last characters of the campaign number, and filtered to drafts, waiting for approval, approved, or run (simulated). This is done in the browser over the dashboard summary.

## Not in this phase

Pause, resume and archive are not implemented: the domain model has no such transition, and they would need their own validated, audited path.
