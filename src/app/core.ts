import type { Db } from "../db/db.js";

/** The minimum every service needs: a database and a clock (injectable for tests). */
export interface Core {
  db: Db;
  now: () => Date;
}

export const iso = (c: Core): string => c.now().toISOString();

export function audit(
  c: Core,
  workspaceId: string,
  actor: string,
  type: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown> = {},
): void {
  c.db
    .prepare(
      "INSERT INTO audit_events (workspace_id, at, actor, type, entity_type, entity_id, detail) VALUES (?,?,?,?,?,?,?)",
    )
    .run(workspaceId, iso(c), actor, type, entityType, entityId, JSON.stringify(detail));
}
