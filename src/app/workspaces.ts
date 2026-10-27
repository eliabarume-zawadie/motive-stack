import { audit, iso, type Core } from "./core.js";
import { notFound } from "./errors.js";
import { newId, newToken, safeEqual, sha256 } from "./util.js";
import { BusinessBrainSchema, type BusinessBrain } from "../domain/schemas.js";

export interface Workspace {
  id: string;
  name: string;
  metaAccountId: string | null;
  createdAt: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  token_hash: string;
  meta_account_id: string | null;
  created_at: string;
}

const toWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  metaAccountId: r.meta_account_id,
  createdAt: r.created_at,
});

/** Creates a workspace and returns its access token ONCE. Only a hash is stored. */
export function createWorkspace(c: Core, name: string): { workspace: Workspace; token: string } {
  const id = newId("ws");
  const token = newToken();
  c.db
    .prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES (?,?,?,?)")
    .run(id, name, sha256(token), iso(c));
  audit(c, id, "system", "workspace.created", "workspace", id, { name });
  return { workspace: getWorkspace(c, id), token };
}

export function getWorkspace(c: Core, id: string): Workspace {
  const r = c.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as WorkspaceRow | undefined;
  if (!r) throw notFound("Workspace");
  return toWorkspace(r);
}

/** True only if the token belongs to exactly this workspace. */
export function authenticate(c: Core, workspaceId: string, token: string | undefined): boolean {
  if (!token) return false;
  const r = c.db.prepare("SELECT token_hash, legacy_token_disabled_at d FROM workspaces WHERE id = ?").get(workspaceId) as
    | { token_hash: string; d: string | null }
    | undefined;
  return !!r && r.d === null && safeEqual(r.token_hash, sha256(token)); // a disabled token never authenticates
}

export function setMetaAccount(c: Core, workspaceId: string, accountId: string | null, actor = "owner"): Workspace {
  getWorkspace(c, workspaceId);
  c.db.prepare("UPDATE workspaces SET meta_account_id = ? WHERE id = ?").run(accountId, workspaceId);
  audit(c, workspaceId, actor, "workspace.meta_account_set", "workspace", workspaceId, { accountId });
  return getWorkspace(c, workspaceId);
}

export function getBrain(c: Core, workspaceId: string): { brain: BusinessBrain; version: number } | null {
  const r = c.db.prepare("SELECT data, version FROM business_brains WHERE workspace_id = ?").get(workspaceId) as
    | { data: string; version: number }
    | undefined;
  if (!r) return null;
  return { brain: BusinessBrainSchema.parse(JSON.parse(r.data)), version: r.version };
}

/** Validates and stores the Business Brain; each save bumps the version. */
export function putBrain(c: Core, workspaceId: string, input: unknown, actor = "owner"): { brain: BusinessBrain; version: number } {
  getWorkspace(c, workspaceId);
  const brain = BusinessBrainSchema.parse(input);
  const existing = getBrain(c, workspaceId);
  const version = (existing?.version ?? 0) + 1;
  c.db
    .prepare(
      `INSERT INTO business_brains (workspace_id, data, version, updated_at) VALUES (?,?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
    )
    .run(workspaceId, JSON.stringify(brain), version, iso(c));
  audit(c, workspaceId, actor, "brain.saved", "business_brain", workspaceId, { version });
  return { brain, version };
}
