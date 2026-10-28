-- Phase 5: team operations. Additive only: no existing table is changed.
-- Coordination records, not authorization: assigning someone as owner or reviewer never grants them any permission and never replaces approval or separation of duties.

-- 1. Who owns a campaign or creative, and who is expected to review it. Only active members of the workspace can be assigned (checked in code).
CREATE TABLE ownerships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('campaign','creative')),
  subject_id TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  reviewer_user_id TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (workspace_id, subject_type, subject_id)
);

-- 2. Work items: a task or a dated milestone tied to the EXACT campaign version (and creative version or proposal when there is one) and a stated action.
--    The due date is a plain calendar date. A 'schedule_proposal' is a date the team proposes to act on: it is never a schedule on any ad platform.
CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  campaign_version INTEGER NOT NULL,
  creative_id TEXT REFERENCES creatives(id),
  creative_version INTEGER,
  proposal_id TEXT REFERENCES action_proposals(id),
  kind TEXT NOT NULL CHECK (kind IN ('draft','review','approval','run','schedule_proposal','other')),
  title TEXT NOT NULL,
  required_action TEXT NOT NULL,
  owner_user_id TEXT REFERENCES users(id),
  reviewer_user_id TEXT REFERENCES users(id),
  due_date TEXT,                                  -- YYYY-MM-DD, no time zone (the workspace has none yet)
  status TEXT NOT NULL CHECK (status IN ('open','done','cancelled')),
  closed_reason TEXT,                             -- why it closed: done by a person, or closed by the decision it was waiting for
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  completed_by TEXT
);
CREATE INDEX idx_work_items_ws ON work_items(workspace_id, status, due_date);
CREATE INDEX idx_work_items_owner ON work_items(workspace_id, owner_user_id, status);

-- 3. In-app notifications for a signed-in person. Nothing here is sent anywhere: email, SMS and push are not implemented.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_notifications_user ON notifications(workspace_id, user_id, read_at, created_at);
