-- Milestone 4.3: encrypted per-workspace credential storage. Additive only; nothing existing is read, copied or changed.
--
-- WHAT THIS TABLE HOLDS. Per workspace and per kind of integration (openai, anthropic, meta_graph, ghl), at most one ACTIVE secret,
-- stored ONLY as authenticated ciphertext (AES-256-GCM) under a random per-record data key, which is itself wrapped by a master key
-- that lives OUTSIDE this database (see src/credentials/keys.ts and docs/credential-security.md). There is no plaintext column here
-- and no column that could hold one.
--
-- WHAT IT DOES NOT DO. A stored credential grants NO permission to use anything. Which Meta ad accounts a workspace may use is
-- decided by workspace_meta_accounts (006), independently. Nothing in the application reads this table yet except the vault itself.
--
-- BACKFILL IS EMPTY. Existing credentials live in server environment variables, not in this database; none are imported.

CREATE TABLE workspace_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('openai','anthropic','meta_graph','ghl')),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('active','revoked','deleted')),
  label TEXT CHECK (label IS NULL OR length(label) <= 80),   -- a human-readable name; never a secret
  last4 TEXT CHECK (last4 IS NULL OR length(last4) = 4),     -- shown as "...abcd" so people can tell keys apart
  sealed BLOB,                                               -- nonce | tag | ciphertext of the secret
  wrapped_dek BLOB,                                          -- the data key, wrapped by the master key
  key_id TEXT,                                               -- which master key wrapped it (not the key)
  enc_alg TEXT NOT NULL DEFAULT 'aes-256-gcm/1',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  ended_at TEXT,
  ended_by TEXT,
  UNIQUE (workspace_id, kind, version),
  -- Erased means erased: an ended credential carries no key material, and an active one always does.
  CHECK ((status = 'active' AND sealed IS NOT NULL AND wrapped_dek IS NOT NULL AND key_id IS NOT NULL)
      OR (status <> 'active' AND sealed IS NULL AND wrapped_dek IS NULL AND key_id IS NULL))
);
-- One live credential per workspace and kind.
CREATE UNIQUE INDEX uq_credential_active ON workspace_credentials(workspace_id, kind) WHERE status = 'active';
CREATE INDEX idx_credential_key ON workspace_credentials(key_id) WHERE status = 'active';

CREATE TRIGGER trg_workspace_credentials_fixed BEFORE UPDATE OF workspace_id, kind, version ON workspace_credentials
WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.kind IS NOT OLD.kind OR NEW.version IS NOT OLD.version
BEGIN SELECT RAISE(ABORT, 'workspace, kind and version of a credential cannot change'); END;

CREATE TRIGGER trg_workspace_credentials_no_revival BEFORE UPDATE OF status ON workspace_credentials
WHEN OLD.status <> 'active' AND NEW.status = 'active'
BEGIN SELECT RAISE(ABORT, 'a revoked or deleted credential cannot be reactivated; store a new one'); END;
