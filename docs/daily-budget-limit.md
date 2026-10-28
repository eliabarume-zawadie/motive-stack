# The workspace-wide daily budget limit

The Business Brain's daily ceiling ("Max daily budget") is an **aggregate** limit: the most the owner is willing to have committed per day across the **whole workspace**, every plan and every stand-alone campaign together. It is not an allowance per campaign or per plan. Each client workspace of an agency has its own limit; nothing is counted across workspaces, and there is no organization-wide cap (the Master PRD does not require one).

Nothing here spends money. In this release every action is simulated and the platform draft is created paused with no budget; the limit describes what the owner has committed to, so it already holds in mock mode and is ready for a live release.

## What counts as a commitment

A campaign's **daily commitment** is the `plannedDailyBudgetCents` of its latest proposal that is in one of these states:

| Proposal state | Counts? |
|---|---|
| Approved, approval not expired | Yes |
| Executing | Yes |
| Executed (a paused draft exists) | Yes, until the campaign is completed or archived |
| Needs review (the platform outcome is unknown) | Yes: held conservatively until a person resolves it |
| Approved but the approval expired without a run | No: released |
| Proposed (waiting), stale, rejected, failed | No |

A campaign that is **archived or completed** holds nothing. Each campaign is counted **once**, from its single latest committed proposal. A plan's total is a cap on its own campaigns and is **never added** to the sum, so a campaign that appears in a plan, in the campaign list and in a plan view is still one row. `available = limit - committed` (never below zero; if commitments already exceed the limit the dashboard shows by how much).

## Where it is enforced (all on the server)

1. **Proposing**: an early refusal when the committed amount plus this campaign's budget would exceed the limit, so reviewers do not spend effort on something that cannot be approved.
2. **Approving**: the authoritative check. The proposal is re-read and the commitments are counted **inside one `BEGIN IMMEDIATE` transaction**, together with writing the approval. Two approvals cannot both pass on the same numbers: the second cannot start until the first has committed, and then it sees the first's commitment. If another connection holds the write lock the answer is `503 busy, try again`, never a guess.
3. **Requesting a run, and the executor's own gate**: the commitments as a whole must still fit. This catches a limit that was lowered after approval; the queued proposal fails safely with `daily_budget_limit_exceeded`, nothing is created, and its commitment is released.
4. **Editing** a committed campaign makes its approval stale (releasing it), so a larger budget must fit on its own when proposed again. A campaign that was run cannot be edited.
5. **Lowering the limit** in My business below what is committed is **allowed but flagged**: the save succeeds with a `budget` warning, an audit entry (`budget.over_limit`) and a Home attention item. New approvals and runs are refused until archiving or completing campaigns, or raising the limit, makes the commitments fit again. Campaigns that already ran are not touched.

A refusal explains itself, for example: *"This would commit 800¢ per day. 1600¢ of your 2000¢ daily limit is already committed (A 800¢, B 800¢), leaving 400¢."*

## Budgets that cannot be normalized

Every budget in this release is a positive whole number of cents **per day** in the workspace's single currency. The campaign brief and the proposal payload have no lifetime budget, schedule or currency field, and a plan's `durationDays` is descriptive only: it is never used to convert or multiply a budget. New proposals carry `budgetBasis: "daily"`.

A committed proposal whose budget is not exactly that (a non-daily basis, a lifetime/total/currency field, a missing amount, or a recorded amount that disagrees with its payload) is **flagged, never counted as zero**. While one exists, no new commitment can be proposed, approved or run (`budget_not_normalizable`), and Home says why.

## Plans and the limit

A plan's daily total is a cap for its own campaigns (never above the limit). The plan view also shows what the limit leaves for it after everything committed elsewhere, and warns when that is less than the plan's total ("not every campaign in it can be approved"). The warning does not block anything by itself; the approval check does.

## Limits of this design

- The limit is per workspace and daily. There is no weekly or monthly limit, no per-channel limit, and no organization-wide limit.
- Currency is not modelled: a workspace has one ad account and one currency.
- A paused simulated draft counts until its campaign is completed or archived, which is deliberately conservative.
- It is a spending-intent limit, not the ad platform's own limit; set a limit at the platform too when live execution is ever authorized.
