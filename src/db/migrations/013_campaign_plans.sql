-- What the owner asked for when a campaign was generated: the marketing goal, an optional service to focus on, and an optional run length.
-- Kept beside the campaign (the campaign brief schema is unchanged). One row per campaign; additive only.
CREATE TABLE campaign_plans (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  goal TEXT NOT NULL CHECK (goal IN ('lead_generation','promote_service','local_awareness')),
  focus_service TEXT,
  duration_days INTEGER CHECK (duration_days IS NULL OR (duration_days BETWEEN 1 AND 90)),
  created_at TEXT NOT NULL
);
