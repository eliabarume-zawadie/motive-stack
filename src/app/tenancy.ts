import { iso, type Core } from "./core.js";

/**
 * Every workspace belongs to exactly one organization and has a policy row. A direct business gets a "personal" organization it never has to see; the id is
 * derived from the workspace id so repeating this (or running it after migration 015's own backfill) changes nothing and never creates a second one.
 * No other module imports from here except to call these, so there is no import cycle with the workspace and membership services.
 */
export function ensureWorkspaceDefaults(c: Core, workspaceId: string, opts: { organizationId?: string; createdBy?: string | null } = {}): string {
  const at = iso(c);
  const ws = c.db.prepare("SELECT name, organization_id o, created_at FROM workspaces WHERE id = ?").get(workspaceId) as { name: string; o: string | null; created_at: string } | undefined;
  if (!ws) throw new Error("workspace not found");
  let orgId = ws.o;
  if (!orgId) {
    orgId = opts.organizationId ?? `org_${workspaceId}`;
    if (!opts.organizationId) {
      c.db.prepare("INSERT OR IGNORE INTO organizations (id, name, kind, created_at, created_by) VALUES (?,?, 'personal', ?, ?)").run(orgId, ws.name, ws.created_at, opts.createdBy ?? null);
    }
    c.db.prepare("UPDATE workspaces SET organization_id = ? WHERE id = ? AND organization_id IS NULL").run(orgId, workspaceId);
  }
  c.db.prepare("INSERT OR IGNORE INTO workspace_policy (workspace_id, prevent_self_approval, updated_at, updated_by) VALUES (?, 1, ?, 'system')").run(workspaceId, at);
  return orgId;
}

/** Fills in anything missing for workspaces created by an older build. Safe to run on every start: it only touches rows that lack an organization or a policy. */
export function backfillTenancy(c: Core): { organizationsCreated: number; policiesCreated: number } {
  const before = (c.db.prepare("SELECT (SELECT COUNT(*) FROM organizations) o, (SELECT COUNT(*) FROM workspace_policy) p").get() as { o: number; p: number });
  const ids = c.db.prepare("SELECT id FROM workspaces WHERE organization_id IS NULL OR id NOT IN (SELECT workspace_id FROM workspace_policy)").all() as Array<{ id: string }>;
  c.db.transaction(() => { for (const r of ids) ensureWorkspaceDefaults(c, r.id); })();
  const after = (c.db.prepare("SELECT (SELECT COUNT(*) FROM organizations) o, (SELECT COUNT(*) FROM workspace_policy) p").get() as { o: number; p: number });
  return { organizationsCreated: after.o - before.o, policiesCreated: after.p - before.p };
}
