-- Phase 3: campaign plans, the canonical campaign lifecycle, and per-plan budget review. Additive only. campaigns.status (draft | launched_paused) is untouched and
-- keeps its meaning; the executor still writes it. campaign_plans (migration 013) stays what it is: one row per campaign recording the owner's goal for that campaign.
-- A "marketing plan" here is a different thing: a group of separate campaigns with a shared budget, so it gets its own tables.

-- 1. Canonical lifecycle for campaigns. The column is a cache of what the facts say (see src/app/lifecycle.ts); legacy values map as follows:
--      status 'draft'           -> draft (ready_for_approval / approved while a proposal is open or approved)
--      status 'launched_paused' -> executed_simulated (executed_external if a live proposal executed)
ALTER TABLE campaigns ADD COLUMN lifecycle_state TEXT CHECK (lifecycle_state IN ('draft','needs_review','ready_for_approval','approved','ready_for_execution','executed_simulated','executed_external','completed','archived'));
ALTER TABLE campaigns ADD COLUMN completed_at TEXT;
ALTER TABLE campaigns ADD COLUMN archived_at TEXT;
ALTER TABLE campaigns ADD COLUMN plan_id TEXT;   -- the marketing plan this campaign was generated for (NULL for a stand-alone campaign)
CREATE INDEX idx_campaigns_plan ON campaigns(plan_id);

UPDATE campaigns SET lifecycle_state = CASE
  WHEN status = 'launched_paused' THEN CASE WHEN EXISTS (SELECT 1 FROM action_proposals p WHERE p.campaign_id = campaigns.id AND p.status = 'executed' AND p.integration_mode = 'live') THEN 'executed_external' ELSE 'executed_simulated' END
  WHEN EXISTS (SELECT 1 FROM action_proposals p WHERE p.campaign_id = campaigns.id AND p.status IN ('approved','executing')) THEN 'approved'
  WHEN EXISTS (SELECT 1 FROM action_proposals p WHERE p.campaign_id = campaigns.id AND p.status = 'proposed') THEN 'ready_for_approval'
  ELSE 'draft'
END WHERE lifecycle_state IS NULL;

-- 2. Marketing plans: a group of independent campaigns. A plan is never approved as a whole; each campaign keeps its own versions, proposal and approval.
CREATE TABLE marketing_plans (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('recommended','batch')),
  goal TEXT NOT NULL CHECK (goal IN ('lead_generation','promote_service','local_awareness')),
  total_daily_budget_cents INTEGER,            -- the most the plan's campaigns may add up to per day (NULL until set); never above the Business Brain ceiling
  duration_days INTEGER CHECK (duration_days IS NULL OR (duration_days BETWEEN 1 AND 90)),
  version INTEGER NOT NULL DEFAULT 1,          -- bumped by any change to the total, an allocation or which opportunities are selected
  budget_reviewed_fingerprint TEXT,            -- hash of the total, every allocation and every campaign's CURRENT budget as a person reviewed them (NULL: never). Any later change makes it stale
  budget_changed_by TEXT,                      -- who last changed anything the review covers (so the reviewer can be someone else)
  budget_reviewed_by TEXT,
  budget_reviewed_at TEXT,
  budget_separation TEXT,
  basis TEXT NOT NULL,                         -- plain statement of how the opportunities were chosen (rule-based, no forecast)
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_plans_ws ON marketing_plans(workspace_id, archived_at);

CREATE TABLE plan_opportunities (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES marketing_plans(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  focus_service TEXT NOT NULL,
  angle TEXT NOT NULL,
  rationale TEXT NOT NULL,                     -- why this one, and how it differs from the others
  unknowns TEXT NOT NULL DEFAULT '[]',         -- JSON list: what is not known (never "not offered")
  status TEXT NOT NULL CHECK (status IN ('suggested','selected','excluded','saved','generating','generated','failed')),
  allocation_cents INTEGER,                    -- this campaign's share of the plan's daily total
  campaign_id TEXT REFERENCES campaigns(id) UNIQUE,   -- UNIQUE: an opportunity can never produce two campaigns
  duplicate_of TEXT,                           -- an existing campaign or another opportunity this one overlaps with
  duplicate_note TEXT,
  duplicate_acknowledged INTEGER NOT NULL DEFAULT 0,
  similarity REAL,                             -- how alike the generated copy is to a sibling campaign (0 to 1), once generated
  similar_to TEXT,
  error_code TEXT,
  error_message TEXT,
  generation_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, position)
);
CREATE INDEX idx_plan_opps_plan ON plan_opportunities(plan_id, position);
