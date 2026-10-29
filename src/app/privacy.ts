import { z } from "zod";
import type { AppContext } from "./context.js";
import { audit, iso } from "./core.js";
import { notFound } from "./errors.js";

/**
 * Data export and erasure, the two privacy duties a public launch needs first.
 *  - EXPORT gives a workspace admin everything this workspace holds, as one JSON document, with every secret removed (tokens, credential records, storage keys). Files
 *    themselves (image bytes) are not included: only their records.
 *  - ERASURE removes one lead's personal data (name, e-mail, phone) from every place this app keeps it, and says what it could NOT reach. It never edits the audit trail
 *    (audit rows carry ids, never personal details), and it keeps a scrubbed event record so the same person cannot be silently re-added by re-sending the same event.
 * Not built, and stated in docs/launch-readiness.md: erasing a whole workspace, retention schedules, and deletion in an outside CRM (none is connected).
 */
const TEXT = z.string().trim().min(1).max(300).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
export const EraseSchema = z.object({ reason: TEXT }).strict();

/** Tables never exported: they hold secrets or belong to people, not to the workspace's own work. */
const DENY_TABLES = new Set(["workspace_credentials", "notifications", "schema_migrations"]);
/** Columns never exported, in any table. */
const DENY_COLUMNS = new Set(["token_hash", "storage_key", "ciphertext", "nonce", "key_id", "wrapped_key", "auth_tag"]);
const ROW_CAP = 50_000;
const AUDIT_CAP = 20_000;

export function exportWorkspace(c: AppContext, wsId: string, actor: string) {
  const ws = c.db.prepare("SELECT id, name, created_at FROM workspaces WHERE id = ?").get(wsId) as { id: string; name: string; created_at: string } | undefined;
  if (!ws) throw notFound("Workspace");
  const tables: Record<string, unknown[]> = {};
  const truncated: string[] = [];
  const names = (c.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
  let rows = 0;
  for (const t of names) {
    if (DENY_TABLES.has(t)) continue;
    const cols = (c.db.pragma(`table_info(${t})`) as Array<{ name: string }>).map((x) => x.name);
    if (!cols.includes("workspace_id")) continue;
    const keep = cols.filter((x) => !DENY_COLUMNS.has(x));
    const cap = t === "audit_events" ? AUDIT_CAP : ROW_CAP;
    const order = t === "audit_events" ? "ORDER BY id DESC" : cols.includes("created_at") ? "ORDER BY created_at, rowid" : "ORDER BY rowid";
    const data = c.db.prepare(`SELECT ${keep.map((k) => `"${k}"`).join(", ")} FROM "${t}" WHERE workspace_id = ? ${order} LIMIT ?`).all(wsId, cap + 1) as unknown[];
    if (data.length > cap) { data.length = cap; truncated.push(t); }
    tables[t] = data;
    rows += data.length;
  }
  const members = (c.db.prepare("SELECT m.user_id, m.role, m.status, m.created_at, u.display_name FROM workspace_memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at").all(wsId) as unknown[]);
  audit(c, wsId, actor, "workspace.exported", "workspace", wsId, { tables: Object.keys(tables).length, rows, truncated });
  return {
    format: "motivestack-export-1", exportedAt: iso(c), workspace: { id: ws.id, name: ws.name, createdAt: ws.created_at }, members, tables, truncated,
    notExported: [
      "Secrets: the workspace token hash, stored credentials and file storage keys are never exported.",
      "Image files: only their records (name, size, hash, rights, provenance) are included, not the bytes.",
      "Notifications: they belong to individual people, not to the workspace's work.",
      `The audit trail is limited to the newest ${AUDIT_CAP} events.`,
    ],
  };
}

/** Removes a lead's personal data everywhere this app keeps it. */
export function eraseLead(c: AppContext, wsId: string, leadId: string, input: unknown, actor: string) {
  const b = EraseSchema.parse(input);
  const l = c.db.prepare("SELECT id, campaign_id, lead_event_id, origin FROM leads WHERE id = ? AND workspace_id = ?").get(leadId, wsId) as { id: string; campaign_id: string; lead_event_id: string; origin: string } | undefined;
  if (!l) throw notFound("Lead");
  const removed = { crmContacts: 0, crmSyncs: 0, statusHistory: 0 };
  c.db.transaction(() => {
    const syncs = c.db.prepare("SELECT contact_id FROM crm_syncs WHERE lead_id = ? AND workspace_id = ?").all(leadId, wsId) as Array<{ contact_id: string }>;
    removed.crmSyncs = c.db.prepare("DELETE FROM crm_syncs WHERE lead_id = ? AND workspace_id = ?").run(leadId, wsId).changes;
    // the simulated CRM contact goes too, unless another lead still points at it (one contact can serve several leads matched by e-mail or phone)
    for (const s of syncs) {
      const shared = c.db.prepare("SELECT 1 FROM crm_syncs WHERE contact_id = ? AND workspace_id = ?").get(s.contact_id, wsId);
      if (!shared) removed.crmContacts += c.db.prepare("DELETE FROM sim_crm_contacts WHERE id = ? AND workspace_id = ?").run(s.contact_id, wsId).changes;
    }
    removed.statusHistory = c.db.prepare("DELETE FROM lead_status_history WHERE lead_id = ? AND workspace_id = ?").run(leadId, wsId).changes;
    c.db.prepare("DELETE FROM leads WHERE id = ? AND workspace_id = ?").run(leadId, wsId);
    // keep the event row (so the same event id stays a duplicate) but scrub what it carried
    c.db.prepare("UPDATE lead_events SET payload = ? WHERE id = ? AND workspace_id = ?").run(JSON.stringify({ erased: true }), l.lead_event_id, wsId);
    audit(c, wsId, actor, "lead.erased", "lead", leadId, { origin: l.origin, campaignId: l.campaign_id, reason: b.reason, ...removed });
  })();
  return {
    erased: true, leadId, removed,
    notReached: ["The audit trail is never edited; it holds ids only, never a name, e-mail address or phone number.", "No real CRM is connected, so nothing outside this app held this person's data. If one is connected later, it needs its own deletion.", "A backup taken before the erasure still contains the data until that backup is retired."],
    note: "The same event id stays recorded as a duplicate (with its details scrubbed), so sending the same event again does not bring the person back. An import of the same person under a NEW event id would.",
  };
}
