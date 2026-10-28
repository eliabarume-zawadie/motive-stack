-- Live AI spending: money (and one request) is RESERVED before a paid request is sent and released when it finishes, so requests that run at
-- the same time cannot together exceed the server's ceiling (the check and the reservation happen in one write transaction). A reservation older than
-- 15 minutes is ignored, so a crash cannot lock spending forever. Additive only; holds amounts and ids, never prompts or secrets.
CREATE TABLE ai_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  micros INTEGER NOT NULL CHECK (micros >= 0),
  reserved_at TEXT NOT NULL
);
CREATE INDEX idx_ai_reservations_at ON ai_reservations(reserved_at);
