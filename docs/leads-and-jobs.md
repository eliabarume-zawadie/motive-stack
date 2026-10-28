# Leads, background jobs and activity

## Leads

- Every lead in this release is a **synthetic test lead** from the simulator, labelled SIMULATED. The CRM is a built-in stand-in: no real contact is created and no email or text is sent. Having a CRM configured never makes the app claim a real CRM is connected.
- Each inbound event has a stable event id. The same id is stored once and queues one job; every repeat is ignored and counted. `GET /api/workspaces/:wid/leads/:lid` returns `duplicateEventsIgnored`, the source, the capture time, the campaign, the CRM state and the status history.
- **Status** (`new`, `contacted`, `qualified`, `won`, `lost`) is the owner's own view of the lead and is separate from the CRM sync state. `PUT .../leads/:lid/status` (permission `leads.update`, operator and above) records the previous and new status, an optional note (300 characters) and the server-derived actor in `lead_status_history` and in the audit trail (`lead.status_changed`). Setting the same status again is refused (409). Migration 014 is additive: existing leads become `new`.

## Background jobs

The queue is a persisted table (`jobs`) processed by an in-process worker (`WORKER_IN_PROCESS=true`) with bounded automatic retries and backoff. There is no separate worker service.

The operations page shows, per job: what it is, what it is about (a lead name or campaign name, never the raw payload), SIMULATED, status, attempts, the last error as one line, when it was updated, how long it took, and whether it can be retried.

Manual retry (`POST .../jobs/:jid/retry`, permission `jobs.retry`, admin and above):

- only a job that **gave up** and only type `process_lead`. The handler is idempotent: the lead and its CRM sync are stored once, so a retry cannot create a duplicate;
- at most **2** manual retries per job; the response and the page say when the limit is reached;
- an `execute_proposal` job is never retried from here, because its result may be unconfirmed outside the app. The page points to the proposal's own recovery steps;
- every retry is audited (`job.retried`) with the server-derived actor.

## Activity

All of the above appear in Activity with readable sentences and a SIMULATED marker where it applies. Nobody can edit audit history through the API.
