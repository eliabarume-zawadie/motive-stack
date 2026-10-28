# Team operations: inbox, calendar, owners and notifications (Master PRD Phase 5)

Everything here is internal coordination. Nothing is sent by e-mail, text message or push, nothing is scheduled on any ad platform, and no external service is contacted.

## What exists

| Piece | What it is |
|---|---|
| **Owners and reviewers** | Who owns a campaign or creative and who is expected to review it. Only active members of the workspace can be assigned. **Coordination only:** it grants no permission and never replaces approval, the second-person rule or any check. An operator made reviewer still cannot approve. |
| **Tasks and dated milestones** | A work item records the campaign **version** it was made for, the creative **version** or proposal when it has one, a title, a stated **required action**, an owner, a reviewer and an optional due date. A review task needs a creative; an approval or run task needs a proposal. Kinds: finish the draft, review, approve or reject, run (simulated), proposed date, other. |
| **Inbox** | Built from real records, not stored copies: *assigned to you*; *waiting for a decision* (proposals, creative versions, the Brand Kit, asset versions, approved-not-run proposals), each naming the exact version and whether **you** can act; *problems* (failed pictures, dead jobs, a missing Business Brain, blocking questions) with the action that exists; *dated work* (overdue and the next 14 days). |
| **Calendar** | An agenda of dated work plus real dates already in the records (the day an approval stops counting). Four weeks at a time, at most 62 days per request. Each entry links the campaign version, creative version, owner, reviewer and the run job's state. |
| **Notifications** | In-app only, for signed-in people: assigned as owner or reviewer or task owner, a creative sent for review (to its reviewer), a creative approved or rejected (to the submitter and owners). Private to the person; mark one or all read. |

## How the inbox stays true

A task waiting for a decision closes itself when the decision is made: approving or rejecting a creative version closes its review tasks; approving or rejecting a proposal closes its approval tasks; requesting a run closes its run tasks. A task that points at a replaced creative version, or a moved-on campaign, says so ("Creative version 1 has been replaced by version 2") and keeps naming the version it was made for. Derived inbox items disappear as soon as the underlying record changes.

## Limits that are stated on the screens

- **The shared workspace token is not a person.** It can have no assignments, no "assigned to you" list and no notifications; the inbox says so and shows everything else.
- **Dates are plain calendar dates.** No workspace time zone is modelled; "overdue" compares with today's UTC date.
- **A proposed date is the team's own plan.** It is labelled "not a platform schedule" everywhere, and no schedule exists on any ad platform.
- **Notifications are polled when the section opens or after your own action**, not pushed in real time. No timer was added to look live.

## Permissions and data

`tasks.read` (viewer: inbox, calendar, tasks, owners), `tasks.write` (operator: create and update tasks), `assignments.manage` (admin: set owners and reviewers), and notifications need only workspace access and show only your own. Custom roles may include them. Everything is workspace-private; another workspace sees no task, owner, notification, inbox or calendar entry.

Migration `019_team_operations.sql` (additive): `ownerships`, `work_items`, `notifications`. No existing table changed.

## Known gaps

| Gap | State |
|---|---|
| E-mail, SMS, push notifications | Not built and disabled by design in this phase. |
| Real-time updates | Not built; the inbox refreshes on opening the section and after your own actions. |
| Time zones, times of day, recurring tasks | Not modelled. |
| Month grid | The calendar is an agenda list. |
| Pause/resume, dependencies and sequencing between campaigns | Still not built or enforced; an internal workflow pause, if added, must not be confused with a platform pause. |
| Calendar entries for plan durations | A plan's duration is descriptive only and is not placed on the calendar. |
| Assigning someone to a proposal or asset | Owners are set on campaigns and creatives; a proposal's reviewer is its campaign's reviewer. |
| Bulk reassignment, workload view | Not built. |
