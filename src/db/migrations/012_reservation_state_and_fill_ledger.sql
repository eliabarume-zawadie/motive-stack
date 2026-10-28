-- 1. A reservation whose outcome is UNKNOWN (the request was sent but timed out or was cancelled, so the provider may have billed it and reported nothing)
--    is kept as an 'unverified' hold instead of being released: it keeps counting against the ceiling for the rest of the month.
ALTER TABLE ai_reservations ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','unverified'));

-- 2. Which values in the Business Brain form came from a website (so a later analysis of a different, or the same, website can replace exactly those,
--    and nothing the owner wrote). Only values the fill actually ADDED are recorded, and only values the server itself offered in its brain patch.
CREATE TABLE website_fill_ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  value_key TEXT NOT NULL,                 -- lower-cased, whitespace-collapsed value
  analysis_id TEXT NOT NULL REFERENCES website_analyses(id),
  site TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, field, value_key)
);
CREATE INDEX idx_website_fill_ledger_ws ON website_fill_ledger(workspace_id);
