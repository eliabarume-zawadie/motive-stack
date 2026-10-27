-- Business Brain website analysis. Additive only.
--
-- website_analyses: one row per time a business website was read and analysed. It keeps the PROPOSED findings' source material (the
-- readable text of the pages that were read, never raw HTML) so a quote can be re-checked and the AI step can be retried without
-- fetching the site again. Nothing here is a confirmed Business Brain fact: findings become part of the Business Brain only after the
-- owner approves them and saves the Brain.
CREATE TABLE website_analyses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  url TEXT NOT NULL,                       -- the validated address the owner asked for
  site TEXT NOT NULL,                      -- host without a leading "www."
  status TEXT NOT NULL CHECK (status IN ('running','ready','failed')),
  step TEXT NOT NULL,                      -- plain-language progress shown to the owner
  error_code TEXT,
  error_message TEXT,                      -- plain language; never a stack trace or a secret
  robots TEXT,                             -- allowed | no_robots_file | restricted | unavailable
  pages TEXT NOT NULL DEFAULT '[]',        -- JSON: [{url,title,status,reason,bytes,chars,looksLikeInstructions}]
  page_text TEXT,                          -- JSON: [{url,text}] readable text used for the analysis (size-capped)
  notes TEXT NOT NULL DEFAULT '[]',        -- JSON: plain-language notes about limits that applied
  analysis_mode TEXT CHECK (analysis_mode IN ('simulated','ai')),
  provider TEXT,
  model TEXT,
  task_id TEXT,                            -- the ai_usage task that produced the findings (live or simulated)
  usage TEXT,                              -- JSON: {inputTokens,outputTokens,costMicros,costStatus,currency}; absent values are unknown, never 0
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_website_analyses_ws ON website_analyses(workspace_id, created_at);

-- website_insights: the proposed findings. basis says how each one is supported:
--   found_on_site       the text appears on a page that was read (evidence holds the verified quotes)
--   ai_interpretation   a conclusion or recommendation drawn by the AI; not a fact about the business
--   needs_confirmation  something not found / unknown that only the owner can answer
CREATE TABLE website_insights (
  id TEXT PRIMARY KEY,
  analysis_id TEXT NOT NULL REFERENCES website_analyses(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  position INTEGER NOT NULL,
  category TEXT NOT NULL,
  text TEXT NOT NULL,
  original_text TEXT NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('found_on_site','ai_interpretation','needs_confirmation')),
  evidence TEXT NOT NULL DEFAULT '[]',     -- JSON: [{url,quote}] only quotes that were verified against the page text
  flags TEXT NOT NULL DEFAULT '[]',        -- JSON: strings such as "risky_claim", "no_verified_evidence"
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected')),
  edited INTEGER NOT NULL DEFAULT 0,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX idx_website_insights_analysis ON website_insights(analysis_id, position);
