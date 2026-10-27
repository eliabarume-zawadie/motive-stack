-- Milestone 4.1: internal users keyed to an identity provider's stable subject. Additive only:
-- no existing table is dropped or rewritten, and existing workspaces keep working with their workspace token.
-- Memberships (which user may act in which workspace) arrive in Milestone 4.2; until then a user row proves WHO someone is
-- and grants access to no workspace.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,                -- exact `iss` of the verified token
  subject TEXT NOT NULL,               -- exact `sub`: the provider's stable id for the person (never an email address)
  email TEXT,                          -- informational; only stored when the provider marks it verified. Never an identity key.
  display_name TEXT,                   -- informational
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (issuer, subject)
);

-- Approvals are attributed to the server-derived principal in decided_by. Whatever name the client typed is kept here,
-- clearly as an UNVERIFIED label for people reading the history; nothing authorizes on it.
ALTER TABLE approvals ADD COLUMN claimed_label TEXT;
