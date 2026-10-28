-- Phase 6: lead lineage, imports, form definitions. Additive only: columns are ADDED to leads (existing values are untouched) and new tables are created.
-- A lead's campaign link stays required by the existing schema (leads.campaign_id and lead_events.campaign_id are NOT NULL), so a lead with no campaign at all
-- cannot be stored yet. That is a tracked gap (it needs a table rebuild, which is not done in this release).

-- 1. What a lead IS and where it came from.
--    origin: synthetic = made by this app's simulator or a form test; imported = a person brought it in from elsewhere; real = captured by a verified integration
--    (nothing creates 'real' yet); unknown = a row from before origin was recorded that cannot be classified.
--    attribution: observed = a verified integration reported the campaign (none exists yet, except the simulator's own knowledge of what it generated, marked synthetic);
--    inferred = the campaign was assigned or matched by a rule (the basis says which); unknown = the evidence does not support the link.
ALTER TABLE leads ADD COLUMN origin TEXT NOT NULL DEFAULT 'synthetic' CHECK (origin IN ('synthetic','imported','real','unknown'));
ALTER TABLE leads ADD COLUMN campaign_version INTEGER;            -- the campaign version in force when the lead was captured, when known (NULL: not recorded)
ALTER TABLE leads ADD COLUMN creative_id TEXT;                     -- the creative and format the lead came through, when known
ALTER TABLE leads ADD COLUMN creative_version INTEGER;
ALTER TABLE leads ADD COLUMN creative_ratio TEXT;
ALTER TABLE leads ADD COLUMN form_id TEXT;
ALTER TABLE leads ADD COLUMN form_version INTEGER;
ALTER TABLE leads ADD COLUMN utm_source TEXT;
ALTER TABLE leads ADD COLUMN utm_medium TEXT;
ALTER TABLE leads ADD COLUMN utm_campaign TEXT;
ALTER TABLE leads ADD COLUMN utm_content TEXT;
ALTER TABLE leads ADD COLUMN utm_term TEXT;
ALTER TABLE leads ADD COLUMN captured_at TEXT;                     -- when the lead was captured at its source (an import may carry its own); created_at is when THIS app stored it
ALTER TABLE leads ADD COLUMN attribution_status TEXT NOT NULL DEFAULT 'unknown' CHECK (attribution_status IN ('observed','inferred','unknown'));
ALTER TABLE leads ADD COLUMN attribution_basis TEXT;
ALTER TABLE leads ADD COLUMN consent_status TEXT NOT NULL DEFAULT 'not_recorded' CHECK (consent_status IN ('given','not_recorded'));
ALTER TABLE leads ADD COLUMN consent_note TEXT;
ALTER TABLE leads ADD COLUMN follow_up_due TEXT;                   -- YYYY-MM-DD; a reminder for the team only, nothing is sent
ALTER TABLE leads ADD COLUMN follow_up_done_at TEXT;
ALTER TABLE leads ADD COLUMN follow_up_note TEXT;
ALTER TABLE leads ADD COLUMN import_batch_id TEXT;

-- Existing rows: classify only what is certain. Every lead so far was made by the simulator, which knows what it generated.
UPDATE leads SET origin = CASE WHEN simulated = 1 THEN 'synthetic' ELSE 'unknown' END,
                 attribution_status = CASE WHEN simulated = 1 THEN 'observed' ELSE 'unknown' END,
                 attribution_basis = CASE WHEN simulated = 1 THEN 'simulator' ELSE NULL END,
                 captured_at = (SELECT e.received_at FROM lead_events e WHERE e.id = leads.lead_event_id)
 WHERE captured_at IS NULL;

CREATE INDEX idx_leads_origin ON leads(workspace_id, origin, campaign_id);
CREATE INDEX idx_leads_email ON leads(workspace_id, email);

-- 2. A record of each import, so every imported lead can be traced to who brought it in, when, and what the importer said about its source.
CREATE TABLE lead_import_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  source_note TEXT NOT NULL,
  consent_status TEXT NOT NULL CHECK (consent_status IN ('given','not_recorded')),
  rows_received INTEGER NOT NULL,
  rows_imported INTEGER NOT NULL,
  rows_duplicate INTEGER NOT NULL,
  rows_rejected INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

-- 3. Lead form DEFINITIONS (architecture only). A form says which fields it asks for, what the privacy notice and consent wording are, and why the data is collected.
--    No form is published or hosted: there is no public endpoint, no tracking pixel and nothing is sent. The only way to submit is a clearly labelled test submission.
CREATE TABLE lead_forms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_lead_forms_campaign ON lead_forms(workspace_id, campaign_id, archived_at);

CREATE TABLE lead_form_versions (
  form_id TEXT NOT NULL REFERENCES lead_forms(id),
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_version INTEGER NOT NULL,
  fields TEXT NOT NULL,                 -- JSON: the fields asked for (name is always required; email and phone each required, optional or not asked)
  privacy_notice TEXT NOT NULL,
  consent_text TEXT NOT NULL,
  purpose TEXT NOT NULL,
  retention_note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (form_id, version)
);
