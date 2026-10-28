-- Phase 2: Brand Kit and asset metadata. Additive only. Files live outside the database (see src/storage/assetStore.ts); only metadata and provenance are stored here.

-- 1. Brand Kit: the workspace's brand PREFERENCES (voice, look, audiences, disclaimer wording). It is deliberately a separate document from the Business
--    Brain: a preference is not evidence that a business claim is true, and nothing in here can make an ad claim usable.
--    Every save is a new immutable version. Approval is bound to one version: editing after approval creates a newer draft and the approval no longer covers it.
CREATE TABLE brand_kits (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  current_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','needs_review','approved','rejected')),
  submitted_by TEXT,
  submitted_at TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  approved_version INTEGER,            -- the version the last approval covered (NULL if never approved)
  separation TEXT,                     -- how separation of duties stood at the last decision: enforced | not_enforceable_token_mode | policy_off
  updated_at TEXT NOT NULL
);

CREATE TABLE brand_kit_versions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  version INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version)
);

-- 2. Assets: a logical asset (a logo, a poster...) with immutable versions. A version points at a stored file by key and carries its own provenance, rights and
--    review status. A new version never changes an old one, so an approved version stays reproducible.
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('logo','image','poster','template','reference')),
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  archived_at TEXT,
  archived_by TEXT
);
CREATE INDEX idx_assets_ws ON assets(workspace_id, archived_at);

CREATE TABLE asset_versions (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  version INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  status TEXT NOT NULL CHECK (status IN ('draft','needs_review','approved','rejected','superseded')),
  storage_key TEXT NOT NULL UNIQUE,
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('uploaded','imported','generated','derived')),
  provider TEXT,                       -- for generated assets (a later phase); NULL for uploads
  model TEXT,
  rights_basis TEXT NOT NULL CHECK (rights_basis IN ('owned','licensed','stock','client_supplied','generated','unknown')),
  license_note TEXT,
  usage_restrictions TEXT,
  source_note TEXT,
  rights_expires_at TEXT,
  parent_version INTEGER,              -- the version of the same asset this one replaces or derives from
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  submitted_by TEXT,
  submitted_at TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  separation TEXT,
  PRIMARY KEY (asset_id, version)
);
CREATE INDEX idx_asset_versions_ws_sha ON asset_versions(workspace_id, sha256);
