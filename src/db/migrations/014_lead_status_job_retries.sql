-- Where a lead stands with the owner (separate from whether it reached the CRM), with a history of who changed it and when. Additive only.
ALTER TABLE leads ADD COLUMN status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','won','lost'));

CREATE TABLE lead_status_history (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_lead_status_history ON lead_status_history(lead_id, at);

-- How many times a person has re-queued a job that gave up. Bounded in code (see jobs.retryDeadJob).
ALTER TABLE jobs ADD COLUMN manual_retries INTEGER NOT NULL DEFAULT 0;
