import type { z } from "zod";
import { audit, iso } from "./core.js";
import type { AppContext } from "./context.js";
import { conflict, notFound } from "./errors.js";
import { getCampaignRow } from "./campaigns.js";
import { enqueueJob, RetryableError } from "./jobs.js";
import { newId } from "./util.js";
import { CrmError, normalizeEmail, normalizePhone } from "../integrations/crm.js";
import type { SimulatedLeadSchema } from "../domain/schemas.js";

export type SimulatedLead = z.infer<typeof SimulatedLeadSchema>;

const SOURCE = "simulated";

/**
 * Accept a (synthetic) lead event. Idempotent: the same event id is stored once and queues one job.
 * Synthetic events are refused when Meta is live, so simulated data can never be mixed with real leads.
 */
export function ingestLeadEvent(
  c: AppContext,
  wsId: string,
  campaignId: string,
  input: SimulatedLead,
): { duplicate: boolean; eventId: string } {
  getCampaignRow(c, wsId, campaignId);
  if (c.metaFor(wsId).mode !== "mock") throw conflict("simulated_leads_disabled", "Synthetic leads are only allowed in mock mode");
  const launched = c.db.prepare("SELECT 1 FROM external_resources WHERE campaign_id = ? AND workspace_id = ?").get(campaignId, wsId);
  if (!launched) throw conflict("campaign_not_launched", "Create the paused campaign draft before injecting leads");

  const eventId = input.eventId ?? newId("evt");
  const rowId = newId("lev");
  const r = c.db
    .prepare("INSERT OR IGNORE INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES (?,?,?,?,?,?,1,?)")
    .run(rowId, wsId, SOURCE, eventId, campaignId, JSON.stringify({ fullName: input.fullName, email: input.email ?? null, phone: input.phone ?? null }), iso(c));
  if (r.changes === 0) {
    audit(c, wsId, "system", "lead.duplicate_event", "lead_event", eventId, { campaignId });
    return { duplicate: true, eventId };
  }
  audit(c, wsId, "system", "lead.event_received", "lead_event", rowId, { eventId, simulated: true });
  enqueueJob(c, wsId, "process_lead", { leadEventId: rowId }, `lead:${wsId}:${SOURCE}:${eventId}`);
  return { duplicate: false, eventId };
}

interface EventRow {
  id: string;
  campaign_id: string;
  payload: string;
  simulated: number;
}

/** Store the lead once, then sync it to the CRM once. Safe to run any number of times. */
export async function processLeadEvent(
  c: AppContext,
  wsId: string,
  leadEventRowId: string,
  attempt: { attempts: number; maxAttempts: number },
): Promise<void> {
  const ev = c.db.prepare("SELECT id, campaign_id, payload, simulated FROM lead_events WHERE id = ? AND workspace_id = ?").get(leadEventRowId, wsId) as EventRow | undefined;
  if (!ev) throw notFound("Lead event");
  const p = JSON.parse(ev.payload) as { fullName: string; email: string | null; phone: string | null };

  c.db
    .prepare(
      "INSERT OR IGNORE INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(newId("lead"), wsId, ev.campaign_id, ev.id, p.fullName, normalizeEmail(p.email), normalizePhone(p.phone), ev.simulated, iso(c));
  const lead = c.db.prepare("SELECT id FROM leads WHERE lead_event_id = ? AND workspace_id = ?").get(ev.id, wsId) as { id: string };

  if (c.db.prepare("SELECT 1 FROM crm_syncs WHERE lead_id = ? AND workspace_id = ?").get(lead.id, wsId)) return; // already synced

  const crm = c.crmFor(wsId);
  try {
    const out = await crm.upsertContact({ workspaceId: wsId, fullName: p.fullName, email: p.email, phone: p.phone, source: "motivestack" });
    c.db.transaction(() => {
      c.db
        .prepare("INSERT OR IGNORE INTO crm_syncs (id, workspace_id, lead_id, platform, contact_id, created_contact, simulated, synced_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(newId("syn"), wsId, lead.id, crm.platform, out.contactId, out.created ? 1 : 0, crm.simulated ? 1 : 0, iso(c));
      c.db.prepare("UPDATE leads SET crm_status = 'synced', crm_error = NULL WHERE id = ? AND workspace_id = ?").run(lead.id, wsId);
      audit(c, wsId, "system", "lead.crm_synced", "lead", lead.id, { contactId: out.contactId, createdContact: out.created, simulated: crm.simulated });
    })();
  } catch (e) {
    const msg = (e instanceof Error ? e.message : "error").slice(0, 300);
    const transient = e instanceof CrmError && e.kind === "transient";
    const exhausted = attempt.attempts >= attempt.maxAttempts;
    if (transient && !exhausted) {
      c.db.prepare("UPDATE leads SET crm_status = 'retrying', crm_error = ? WHERE id = ? AND workspace_id = ?").run(msg, lead.id, wsId);
      throw new RetryableError(msg);
    }
    c.db.prepare("UPDATE leads SET crm_status = 'failed', crm_error = ? WHERE id = ? AND workspace_id = ?").run(msg, lead.id, wsId);
    audit(c, wsId, "system", "lead.crm_failed", "lead", lead.id, { error: msg, kind: e instanceof CrmError ? e.kind : "unknown" });
  }
}
