-- Phase 7: experiments, the Marketing Brain (learnings) and recommendation decisions. Additive only: no existing table is changed.
-- Nothing here changes spend, edits a campaign or publishes anything. An experiment records a plan, the exact versions compared, what a person says was actually used,
-- and results that a person entered or imported (each labelled with its source). A learning is a reviewed, traceable note: it is NEVER a Business Brain fact and can
-- never make an ad claim usable. A recommendation is derived from records and only its decision is stored.

CREATE TABLE experiments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','running','concluded','abandoned')),
  hypothesis TEXT NOT NULL,
  principal_variable TEXT NOT NULL CHECK (principal_variable IN ('headline','primary_text','call_to_action','creative_image','audience','placement','offer','other')),
  variable_note TEXT NOT NULL,                 -- the ONE thing that differs between the variants, in words
  audience_note TEXT NOT NULL,
  placement_note TEXT NOT NULL,
  success_metric TEXT NOT NULL CHECK (success_metric IN ('lead_count','qualified_rate','won_rate','cost_per_lead','click_through_rate','conversion_rate','other')),
  duration_days INTEGER NOT NULL CHECK (duration_days BETWEEN 1 AND 365),
  min_sample INTEGER NOT NULL CHECK (min_sample BETWEEN 1 AND 1000000),   -- the least data per variant before any conclusion is worth drawing
  decision_rule TEXT NOT NULL,                 -- written BEFORE the data: what result will lead to what decision
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  started_at TEXT,
  started_by TEXT,
  concluded_at TEXT,
  concluded_by TEXT,
  outcome TEXT CHECK (outcome IN ('variant_better','control_better','inconclusive','abandoned')),
  outcome_rationale TEXT,
  warnings_at_conclusion TEXT                  -- JSON: the data warnings standing when it was concluded, kept with the decision
);
CREATE INDEX idx_experiments_ws ON experiments(workspace_id, status);

-- The things compared, pinned to exact versions so the comparison stays reproducible. Exactly one is the control.
CREATE TABLE experiment_variants (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('control','variant')),
  description TEXT NOT NULL,
  campaign_id TEXT REFERENCES campaigns(id),
  campaign_version INTEGER,
  creative_id TEXT REFERENCES creatives(id),
  creative_version INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (experiment_id, label)
);

-- What a person says was ACTUALLY used, and when. A plan is not a record of use.
CREATE TABLE experiment_usage (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  used_from TEXT NOT NULL,
  used_to TEXT,
  note TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

-- Results a person entered or imported. The app measures none of this itself, and synthetic numbers are labelled so.
CREATE TABLE experiment_observations (
  id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  variant_id TEXT NOT NULL REFERENCES experiment_variants(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  metric TEXT NOT NULL,
  successes INTEGER,                           -- with trials: a count out of a total (e.g. qualified leads out of leads)
  trials INTEGER,
  value REAL,                                  -- a plain number when there is no count out of a total
  source_type TEXT NOT NULL CHECK (source_type IN ('user_entered','imported','synthetic')),
  source_note TEXT NOT NULL,                   -- where the number came from, in the entrant's words
  observed_on TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_experiment_observations ON experiment_observations(experiment_id, variant_id);

-- The Marketing Brain: reviewed, traceable learnings. Not business facts, and they never feed the claim checks.
CREATE TABLE learnings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  statement TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','creative','audience','timing','constraint','unknown','other')),
  source_type TEXT NOT NULL CHECK (source_type IN ('experiment','approved_creative','rejected_creative','campaign_history','human_note','imported')),
  source_ref TEXT,                             -- the experiment, creative or campaign it came from
  observed_on TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  limitations TEXT NOT NULL,                   -- required: what this does NOT show
  origin TEXT NOT NULL CHECK (origin IN ('machine_suggested','human_entered')),
  status TEXT NOT NULL CHECK (status IN ('suggested','confirmed','rejected','retired')),
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  separation TEXT,
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX idx_learnings_ws ON learnings(workspace_id, status);

-- Recommendations are derived from records on every read; only a person's decision about one is stored.
CREATE TABLE recommendation_decisions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  rec_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','dismissed')),
  note TEXT,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, rec_key)
);
