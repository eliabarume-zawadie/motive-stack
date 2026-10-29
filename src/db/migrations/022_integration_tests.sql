-- Phase 8: a record of connection tests. Additive only: no existing table is changed.
-- Only SIMULATED tests exist in this release: they exercise the built-in stand-in on this computer and contact nothing. A test of a LIVE service would make a real
-- request, so it is refused (and not recorded). The `simulated` column is part of every row so a result can never be mistaken for a live one.
CREATE TABLE integration_tests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  adapter_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  simulated INTEGER NOT NULL CHECK (simulated = 1),   -- always 1: a live test is not possible in this release
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX idx_integration_tests ON integration_tests(workspace_id, adapter_id, created_at);
