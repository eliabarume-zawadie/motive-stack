-- MotiveStack local schema (SQLite). Every tenant-owned table carries workspace_id.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  meta_account_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE business_brains (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  data TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,            -- draft | launched_paused
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_campaigns_ws ON campaigns(workspace_id);

CREATE TABLE campaign_versions (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL,
  brief TEXT NOT NULL,
  source TEXT NOT NULL,            -- ai | human
  ai_provider TEXT,
  ai_model TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (campaign_id, version)
);

CREATE TABLE campaign_assets (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- headline | primary_text
  position INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE TABLE action_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  campaign_version INTEGER NOT NULL,
  type TEXT NOT NULL,              -- create_campaign_draft
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  daily_budget_cents INTEGER NOT NULL,
  integration_mode TEXT NOT NULL,  -- mock | live (mode the proposal was created for)
  status TEXT NOT NULL,            -- proposed | approved | rejected | stale | executing | executed | failed | needs_review
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_proposals_ws ON action_proposals(workspace_id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
  decision TEXT NOT NULL,          -- approve | reject
  decided_by TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  campaign_version INTEGER NOT NULL,
  integration_mode TEXT NOT NULL,
  reason TEXT,
  decided_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
-- one decision per proposal
CREATE UNIQUE INDEX uq_approval_proposal ON approvals(proposal_id);

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
  attempt_no INTEGER NOT NULL,
  status TEXT NOT NULL,            -- started | succeeded | failed | outcome_unknown
  dispatched INTEGER NOT NULL DEFAULT 0, -- 1 once the external call may have been sent
  error_kind TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (proposal_id, attempt_no)
);

CREATE TABLE external_resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  platform TEXT NOT NULL,          -- meta
  kind TEXT NOT NULL,              -- campaign
  external_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES action_proposals(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  verified_state TEXT NOT NULL,    -- e.g. PAUSED
  verified_at TEXT NOT NULL,
  simulated INTEGER NOT NULL,
  UNIQUE (workspace_id, platform, external_id),
  UNIQUE (proposal_id)
);

CREATE TABLE lead_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  payload TEXT NOT NULL,
  simulated INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (workspace_id, source, event_id)
);

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  lead_event_id TEXT NOT NULL UNIQUE REFERENCES lead_events(id),
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  simulated INTEGER NOT NULL,
  crm_status TEXT NOT NULL DEFAULT 'pending', -- pending | retrying | synced | failed
  crm_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE crm_syncs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id),
  platform TEXT NOT NULL,          -- ghl
  contact_id TEXT NOT NULL,
  created_contact INTEGER NOT NULL,
  simulated INTEGER NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  type TEXT NOT NULL,              -- execute_proposal | process_lead
  payload TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,            -- queued | running | done | dead
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  run_at TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_due ON jobs(status, run_at);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX idx_audit_ws ON audit_events(workspace_id, id);

-- Simulators (mock mode only). These stand in for the ad platform and the CRM.
CREATE TABLE sim_meta_campaigns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE sim_crm_contacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  email TEXT,
  phone TEXT,
  full_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_sim_contact_email ON sim_crm_contacts(workspace_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX uq_sim_contact_phone ON sim_crm_contacts(workspace_id, phone) WHERE phone IS NOT NULL;
