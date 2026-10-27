-- Milestone 4.2.2: workspace-specific authorization for Meta ad accounts. Additive only.
--
-- BEFORE THIS MIGRATION the only thing tying a workspace to an ad account was workspaces.meta_account_id, a free-text setting any
-- admin could change, checked against one GLOBAL write allow-list shared by every customer. Nothing said which workspace was
-- entitled to which account. This table says so, explicitly.
--
-- BACKFILL IS DELIBERATELY EMPTY. No existing row proves that a workspace is entitled to the account in its setting, so none is
-- assumed. Until an owner authorizes an account, a LIVE workspace has no usable Meta account: it fails closed. Simulated (mock)
-- mode never touches this table. Existing values in workspaces.meta_account_id are left alone and are inert.
--
-- NO CREDENTIALS are stored here. The Meta token is still a single server-side environment value (per-workspace credentials and
-- OAuth are a later milestone). This table only records which workspace may USE which account through that shared token.

CREATE TABLE workspace_meta_accounts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  -- canonical form only: "act_" followed by digits with no leading zero (at most 20 of them)
  account_id TEXT NOT NULL CHECK (account_id GLOB 'act_[1-9]*' AND account_id NOT GLOB 'act_*[^0-9]*' AND length(account_id) BETWEEN 5 AND 24),
  status TEXT NOT NULL CHECK (status IN ('active','disabled','revoked')),
  -- how this authorization came about. 'owner_assertion' = a workspace owner stated that the workspace controls the account; it is
  -- NOT proof of ownership. A stronger source (Meta OAuth) is a later milestone.
  source TEXT NOT NULL CHECK (source IN ('owner_assertion')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,          -- server-derived actor label
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  UNIQUE (workspace_id, account_id)
);
-- One workspace at a time may hold an account (active or disabled). A revoked row frees it, and the history stays in this table
-- and in audit_events.
CREATE UNIQUE INDEX uq_meta_account_holder ON workspace_meta_accounts(account_id) WHERE status IN ('active','disabled');
CREATE INDEX idx_meta_accounts_ws ON workspace_meta_accounts(workspace_id, status);

CREATE TRIGGER trg_ws_workspace_meta_accounts_immutable BEFORE UPDATE OF workspace_id, account_id ON workspace_meta_accounts
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.account_id IS NOT OLD.account_id
BEGIN SELECT RAISE(ABORT, 'workspace_id and account_id of workspace_meta_accounts cannot change'); END;
