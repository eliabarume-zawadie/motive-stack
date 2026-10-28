-- Phase 1 (multi-tenant foundation). Additive only: nothing is dropped, renamed or rewritten, and every existing id is kept.

-- 1. Organizations. A direct business gets a "personal" organization it never has to think about; an agency is an "agency" organization that owns many
--    client workspaces. Organization membership grants NO access to any workspace by itself (workspace access stays an explicit workspace membership).
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal','agency')),
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id)
);

CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('member','admin','owner')),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  UNIQUE (organization_id, user_id)
);
CREATE INDEX idx_org_memberships_user ON organization_memberships(user_id, status);

ALTER TABLE workspaces ADD COLUMN organization_id TEXT REFERENCES organizations(id);
CREATE INDEX idx_workspaces_org ON workspaces(organization_id);

-- Organization-level changes (members, role templates) have no single workspace, so they get their own append-only trail. Nothing in the API edits it.
CREATE TABLE organization_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX idx_org_audit ON organization_audit_events(organization_id, id);

-- 2. Backfill: one personal organization per existing workspace. The id is derived from the workspace id and every statement is guarded, so running
--    this again (or the application's own backfill) changes nothing.
INSERT OR IGNORE INTO organizations (id, name, kind, created_at, created_by)
  SELECT 'org_' || id, name, 'personal', created_at, NULL FROM workspaces WHERE organization_id IS NULL;
UPDATE workspaces SET organization_id = 'org_' || id WHERE organization_id IS NULL;

-- 3. Custom permissions. A role template belongs to one organization and lists exactly the permissions it grants. A workspace member either has one of the
--    built-in roles (viewer, operator, admin, owner: unchanged) or a custom role from their workspace's organization, which then replaces the built-in set.
CREATE TABLE role_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (organization_id, name)
);

CREATE TABLE role_template_permissions (
  template_id TEXT NOT NULL REFERENCES role_templates(id),
  permission TEXT NOT NULL,
  PRIMARY KEY (template_id, permission)
);

ALTER TABLE workspace_memberships ADD COLUMN custom_role_id TEXT REFERENCES role_templates(id);

-- 4. Workspace policy. Separation of duties is ON by default: a person may not approve a proposal they made themselves.
CREATE TABLE workspace_policy (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  prevent_self_approval INTEGER NOT NULL DEFAULT 1 CHECK (prevent_self_approval IN (0,1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
INSERT OR IGNORE INTO workspace_policy (workspace_id, prevent_self_approval, updated_at, updated_by)
  SELECT id, 1, created_at, 'system' FROM workspaces;

-- 5. Who proposed an action (needed to enforce separation of duties) and whether separation was actually enforced at the decision. Existing
--    proposals are backfilled from the audit trail; where no record exists the proposer stays NULL, meaning "unknown, cannot be proven".
ALTER TABLE action_proposals ADD COLUMN proposed_by TEXT;
ALTER TABLE action_proposals ADD COLUMN proposed_by_kind TEXT;
UPDATE action_proposals SET proposed_by = (
  SELECT e.actor FROM audit_events e WHERE e.type = 'proposal.created' AND e.entity_id = action_proposals.id AND e.workspace_id = action_proposals.workspace_id ORDER BY e.id LIMIT 1
) WHERE proposed_by IS NULL;
UPDATE action_proposals SET proposed_by_kind = CASE
  WHEN proposed_by LIKE 'user:%' THEN 'user'
  WHEN proposed_by LIKE 'workspace-token:%' THEN 'legacy_token'
  WHEN proposed_by IS NOT NULL THEN 'unverified'
END WHERE proposed_by_kind IS NULL;

ALTER TABLE approvals ADD COLUMN separation TEXT;  -- enforced | not_enforceable_token_mode | policy_off | unknown (NULL for decisions made before this column existed)
