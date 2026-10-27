-- Milestone 4.2: workspace memberships, roles, and database-level workspace integrity. Additive only.
--
-- MEMBERSHIPS. One row per (workspace, user). A user may belong to many workspaces and a workspace may have many users.
-- A removed member keeps their row with status 'revoked' (history stays in audit_events); adding them again reactivates it.
--
-- BACKFILL STRATEGY (deterministic, and deliberately EMPTY). Before this migration no table links a person to a workspace:
-- workspaces were reachable by a bearer token and the users table (004) holds identities, not ownership. Assigning an owner
-- now would mean inventing one, so NO membership rows are created. Every existing workspace is "unclaimed": it keeps working
-- through its legacy workspace token, and a signed-in person becomes its first owner with POST /api/workspaces/claim
-- (proves possession of the token once, allowed only while the workspace has no active owner). See docs/milestone-4-auth.md.

CREATE TABLE workspace_memberships (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','admin','operator','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,        -- server-derived actor label of whoever added the member
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX idx_memberships_user ON workspace_memberships(user_id, status);
CREATE INDEX idx_memberships_ws ON workspace_memberships(workspace_id, status, role);

-- LEGACY WORKSPACE TOKEN. It keeps working during the transition, as an 'admin'-equivalent principal that is never a user and
-- never an owner. An owner can switch it off; workspaces created by a signed-in user never have a usable one.
ALTER TABLE workspaces ADD COLUMN legacy_token_disabled_at TEXT;

-- APPROVER. decided_by stays the human-readable label; these two make it checkable. 'user' = a signed-in member (approver_user_id),
-- 'legacy_token' = the workspace token, 'unverified' = recorded before this migration or by trusted code without an identity.
ALTER TABLE approvals ADD COLUMN approver_kind TEXT NOT NULL DEFAULT 'unverified' CHECK (approver_kind IN ('user','legacy_token','unverified'));
ALTER TABLE approvals ADD COLUMN approver_user_id TEXT REFERENCES users(id);
UPDATE approvals SET approver_kind = 'legacy_token' WHERE decided_by LIKE 'workspace-token:%';

-- WORKSPACE INTEGRITY IN THE DATABASE. SQLite cannot add composite foreign keys to existing tables without rebuilding them,
-- so these triggers enforce the same rule: a child row must carry the same workspace_id as its parent, and a row's workspace_id
-- can never change. Application queries are also scoped; this is the second layer.
CREATE TRIGGER trg_ws_campaign_versions_campaign_id_insert BEFORE INSERT ON campaign_versions
WHEN (SELECT workspace_id FROM campaigns WHERE id = NEW.campaign_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: campaign_versions.campaign_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_campaign_assets_campaign_id_insert BEFORE INSERT ON campaign_assets
WHEN (SELECT workspace_id FROM campaigns WHERE id = NEW.campaign_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: campaign_assets.campaign_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_action_proposals_campaign_id_insert BEFORE INSERT ON action_proposals
WHEN (SELECT workspace_id FROM campaigns WHERE id = NEW.campaign_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: action_proposals.campaign_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_approvals_proposal_id_insert BEFORE INSERT ON approvals
WHEN (SELECT workspace_id FROM action_proposals WHERE id = NEW.proposal_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: approvals.proposal_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_execution_attempts_proposal_id_insert BEFORE INSERT ON execution_attempts
WHEN (SELECT workspace_id FROM action_proposals WHERE id = NEW.proposal_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: execution_attempts.proposal_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_external_resources_proposal_id_insert BEFORE INSERT ON external_resources
WHEN (SELECT workspace_id FROM action_proposals WHERE id = NEW.proposal_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: external_resources.proposal_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_external_resources_campaign_id_insert BEFORE INSERT ON external_resources
WHEN (SELECT workspace_id FROM campaigns WHERE id = NEW.campaign_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: external_resources.campaign_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_lead_events_campaign_id_insert BEFORE INSERT ON lead_events
WHEN (SELECT workspace_id FROM campaigns WHERE id = NEW.campaign_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: lead_events.campaign_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_leads_campaign_id_insert BEFORE INSERT ON leads
WHEN (SELECT workspace_id FROM campaigns WHERE id = NEW.campaign_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: leads.campaign_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_leads_lead_event_id_insert BEFORE INSERT ON leads
WHEN (SELECT workspace_id FROM lead_events WHERE id = NEW.lead_event_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: leads.lead_event_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_crm_syncs_lead_id_insert BEFORE INSERT ON crm_syncs
WHEN (SELECT workspace_id FROM leads WHERE id = NEW.lead_id) IS NOT NEW.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace mismatch: crm_syncs.lead_id belongs to another workspace'); END;
CREATE TRIGGER trg_ws_campaigns_immutable BEFORE UPDATE OF workspace_id ON campaigns
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of campaigns cannot change'); END;
CREATE TRIGGER trg_ws_campaign_versions_immutable BEFORE UPDATE OF workspace_id ON campaign_versions
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of campaign_versions cannot change'); END;
CREATE TRIGGER trg_ws_campaign_assets_immutable BEFORE UPDATE OF workspace_id ON campaign_assets
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of campaign_assets cannot change'); END;
CREATE TRIGGER trg_ws_action_proposals_immutable BEFORE UPDATE OF workspace_id ON action_proposals
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of action_proposals cannot change'); END;
CREATE TRIGGER trg_ws_approvals_immutable BEFORE UPDATE OF workspace_id ON approvals
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of approvals cannot change'); END;
CREATE TRIGGER trg_ws_execution_attempts_immutable BEFORE UPDATE OF workspace_id ON execution_attempts
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of execution_attempts cannot change'); END;
CREATE TRIGGER trg_ws_external_resources_immutable BEFORE UPDATE OF workspace_id ON external_resources
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of external_resources cannot change'); END;
CREATE TRIGGER trg_ws_lead_events_immutable BEFORE UPDATE OF workspace_id ON lead_events
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of lead_events cannot change'); END;
CREATE TRIGGER trg_ws_leads_immutable BEFORE UPDATE OF workspace_id ON leads
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of leads cannot change'); END;
CREATE TRIGGER trg_ws_crm_syncs_immutable BEFORE UPDATE OF workspace_id ON crm_syncs
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of crm_syncs cannot change'); END;
CREATE TRIGGER trg_ws_jobs_immutable BEFORE UPDATE OF workspace_id ON jobs
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of jobs cannot change'); END;
CREATE TRIGGER trg_ws_audit_events_immutable BEFORE UPDATE OF workspace_id ON audit_events
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of audit_events cannot change'); END;
CREATE TRIGGER trg_ws_ai_usage_immutable BEFORE UPDATE OF workspace_id ON ai_usage
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of ai_usage cannot change'); END;
CREATE TRIGGER trg_ws_workspace_memberships_immutable BEFORE UPDATE OF workspace_id ON workspace_memberships
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN SELECT RAISE(ABORT, 'workspace_id of workspace_memberships cannot change'); END;
