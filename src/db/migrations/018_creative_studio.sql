-- Phase 4: Creative Studio (image first). Additive only: no existing table is changed.
-- A creative belongs to one campaign. Each save is an immutable VERSION (brief + concept + copy + alt text). A version has one VARIANT per aspect ratio
-- (a generated render or an imported, already-approved asset). Renders are persisted jobs; a variant exists only after its bytes were validated and stored.
-- The image files themselves are assets (assets / asset_versions, Phase 2), so storage, rights, provenance and quotas are shared.

CREATE TABLE creatives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  kind TEXT NOT NULL CHECK (kind IN ('static_image')),   -- carousel and video storyboards are declared in code (src/creative/video.ts) but not built, so not allowed yet
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_creatives_campaign ON creatives(workspace_id, campaign_id, archived_at);

CREATE TABLE creative_versions (
  creative_id TEXT NOT NULL REFERENCES creatives(id),
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL CHECK (status IN ('draft','needs_review','approved','rejected','superseded')),
  campaign_version INTEGER NOT NULL,       -- the campaign version this was made for (the campaign may move on; this is recorded, not enforced)
  brief TEXT NOT NULL,                     -- JSON: objective, key message, audience note, visual direction (structured, editable)
  concept TEXT NOT NULL,                   -- JSON: headline, subline, call to action, visual description, palette
  alt_text TEXT NOT NULL,
  ratios TEXT NOT NULL,                    -- JSON array of aspect-ratio ids this version needs
  qa TEXT,                                 -- JSON: the deterministic checks as last run (at submit and approval), with repair guidance
  parent_version INTEGER,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  separation TEXT,
  PRIMARY KEY (creative_id, version)
);

CREATE TABLE creative_renders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  creative_id TEXT NOT NULL REFERENCES creatives(id),
  creative_version INTEGER NOT NULL,
  ratio TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  stage TEXT NOT NULL DEFAULT 'queued',    -- queued | generating | validating | storing | done: what the job is doing, for the screen
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  manual_retries INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,                      -- safe, one line (secrets redacted); repair guidance is derived from the code
  asset_id TEXT,
  asset_version INTEGER,
  sha256 TEXT,
  simulated_cost_cents INTEGER NOT NULL DEFAULT 0,   -- always 0 in mock mode: a mock render costs nothing and is labelled so
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_creative_renders_ws ON creative_renders(workspace_id, creative_id, creative_version);
CREATE INDEX idx_creative_renders_day ON creative_renders(workspace_id, created_at);

CREATE TABLE creative_variants (
  creative_id TEXT NOT NULL REFERENCES creatives(id),
  creative_version INTEGER NOT NULL,
  ratio TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source TEXT NOT NULL CHECK (source IN ('generated','imported')),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  asset_version INTEGER NOT NULL,
  render_id TEXT REFERENCES creative_renders(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (creative_id, creative_version, ratio)
);
