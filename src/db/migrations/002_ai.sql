-- Milestone 2: per-workspace AI settings and per-attempt usage records.

CREATE TABLE ai_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  routing_mode TEXT NOT NULL DEFAULT 'automatic',   -- manual | automatic | preferred_with_fallback
  provider TEXT,                                     -- preferred/manual provider
  model TEXT,
  fallback_provider TEXT,
  fallback_model TEXT,
  allowed_providers TEXT,                            -- JSON array of provider ids; NULL = all (data-policy allow-list)
  max_requests_per_day INTEGER,                      -- live (billable) requests; NULL = no limit
  monthly_budget_micros INTEGER,                     -- estimated cost ceiling in pricing-currency micro-units; NULL = none
  updated_at TEXT NOT NULL
);

-- One row per provider ATTEMPT (including retries, repairs, fallbacks and blocked requests).
-- Stores metadata only: never prompts, business data or provider response bodies.
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,                                -- mock | live
  simulated INTEGER NOT NULL,
  attempt_no INTEGER NOT NULL,
  attempt_kind TEXT NOT NULL,                        -- initial | retry | repair | fallback | blocked
  outcome TEXT NOT NULL,                             -- ok | an AiErrorKind
  started_at TEXT NOT NULL,
  latency_ms INTEGER,
  input_tokens INTEGER,                              -- NULL = unknown (not zero)
  output_tokens INTEGER,                             -- NULL = unknown (not zero)
  usage_source TEXT,                                 -- provider | simulated | NULL when unreported
  estimated_cost_micros INTEGER,                     -- NULL = unknown
  currency TEXT,
  cost_status TEXT NOT NULL,                         -- estimated | unknown_no_pricing | unknown_no_usage | not_applicable
  request_id TEXT,
  fallback_from TEXT,                                -- "provider/model" this attempt replaced
  error_message TEXT                                 -- sanitized, never contains prompts or secrets
);
CREATE INDEX idx_ai_usage_ws ON ai_usage(workspace_id, started_at);
