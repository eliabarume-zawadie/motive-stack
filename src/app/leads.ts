import type { z } from "zod";
import { audit, iso } from "./core.js";
import type { AppContext } from "./context.js";
import { AppError, conflict, notFound } from "./errors.js";
import { getCampaignRow } from "./campaigns.js";
import { enqueueJob, RetryableError } from "./jobs.js";
import { newId, safeError } from "./util.js";
import { CrmError, normalizeEmail, normalizePhone } from "../integrations/crm.js";
import type { SimulatedLeadSchema } from "../domain/schemas.js";
import { ATTRIBUTION_BASIS_TEXT } from "./leadIntake.js";
import { assertQuota } from "./quotas.js";

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

  assertQuota(c, wsId, "leads");
  const eventId = input.eventId ?? newId("evt");
  const rowId = newId("lev");
  const r = c.db
    .prepare("INSERT OR IGNORE INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES (?,?,?,?,?,?,1,?)")
    .run(rowId, wsId, SOURCE, eventId, campaignId, JSON.stringify({ fullName: input.fullName, email: input.email ?? null, phone: input.phone ?? null, campaignVersion: getCampaignRow(c, wsId, campaignId).current_version }), iso(c));
  if (r.changes === 0) {
    audit(c, wsId, "system", "lead.duplicate_event", "lead_event", eventId, { campaignId });
    return { duplicate: true, eventId };
  }
  audit(c, wsId, "system", "lead.event_received", "lead_event", rowId, { eventId, simulated: true });
  enqueueJob(c, wsId, "process_lead", { leadEventId: rowId }, `lead:${wsId}:${SOURCE}:${eventId}`);
  return { duplicate: false, eventId };
}

export const LEAD_STATUSES = ["new", "contacted", "qualified", "won", "lost"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Where a lead stands with the owner. Any change to a different status is allowed and recorded; setting the same status again is refused (nothing to record). */
export function setLeadStatus(c: AppContext, wsId: string, leadId: string, input: unknown, actor: string): ReturnType<typeof leadDetail> {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const to = o.status;
  const note = typeof o.note === "string" ? o.note.trim().slice(0, 300) : "";
  if (typeof to !== "string" || !(LEAD_STATUSES as readonly string[]).includes(to)) throw new AppError(400, "invalid_status", "Status must be one of: " + LEAD_STATUSES.join(", ") + ".");
  const cur = c.db.prepare("SELECT status FROM leads WHERE id = ? AND workspace_id = ?").get(leadId, wsId) as { status: LeadStatus } | undefined;
  if (!cur) throw notFound("Lead");
  if (cur.status === to) throw conflict("status_unchanged", "This lead is already marked " + to + ".");
  c.db.transaction(() => {
    c.db.prepare("UPDATE leads SET status = ? WHERE id = ? AND workspace_id = ?").run(to, leadId, wsId);
    c.db.prepare("INSERT INTO lead_status_history (id, workspace_id, lead_id, from_status, to_status, note, actor, at) VALUES (?,?,?,?,?,?,?,?)")
      .run(newId("lsh"), wsId, leadId, cur.status, to, note || null, actor, iso(c));
    audit(c, wsId, actor, "lead.status_changed", "lead", leadId, { from: cur.status, to });
  })();
  return leadDetail(c, wsId, leadId);
}

/** One lead with where it came from, how its event was processed, its CRM state and its status history. */
export function leadDetail(c: AppContext, wsId: string, leadId: string) {
  const r = c.db.prepare(
    `SELECT l.id, l.campaign_id, l.full_name, l.email, l.phone, l.simulated, l.status, l.crm_status, l.crm_error, l.created_at,
            e.event_id, e.source, e.received_at, k.name AS campaign_name, s.contact_id, s.created_contact, s.platform,
            l.origin, l.campaign_version, l.creative_id, l.creative_version, l.creative_ratio, l.form_id, l.form_version, l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.utm_term, l.captured_at,
            l.attribution_status, l.attribution_basis, l.consent_status, l.consent_note, l.follow_up_due, l.follow_up_done_at, l.follow_up_note, l.import_batch_id
     FROM leads l JOIN lead_events e ON e.id = l.lead_event_id AND e.workspace_id = l.workspace_id
     LEFT JOIN campaigns k ON k.id = l.campaign_id LEFT JOIN crm_syncs s ON s.lead_id = l.id AND s.workspace_id = l.workspace_id
     WHERE l.id = ? AND l.workspace_id = ?`,
  ).get(leadId, wsId) as Record<string, any> | undefined;
  if (!r) throw notFound("Lead");
  const dup = c.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE workspace_id = ? AND type = 'lead.duplicate_event' AND entity_id = ?").get(wsId, r.event_id) as { n: number };
  const same = c.db.prepare("SELECT id, full_name, origin FROM leads WHERE workspace_id = ? AND id != ? AND ((? IS NOT NULL AND email = ?) OR (? IS NOT NULL AND phone = ?)) ORDER BY created_at LIMIT 10").all(wsId, leadId, r.email, r.email, r.phone, r.phone) as Array<{ id: string; full_name: string; origin: string }>;
  const history = c.db.prepare("SELECT from_status, to_status, note, actor, at FROM lead_status_history WHERE lead_id = ? AND workspace_id = ? ORDER BY at, id").all(leadId, wsId) as Array<Record<string, any>>;
  return {
    id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name ?? null, fullName: r.full_name, email: r.email, phone: r.phone, simulated: r.simulated === 1,
    status: r.status as LeadStatus, source: r.source, eventId: r.event_id, capturedAt: (r.captured_at ?? null) as string | null, storedAt: r.created_at, createdAt: r.created_at, duplicateEventsIgnored: dup.n,
    origin: r.origin as string, campaignVersion: (r.campaign_version ?? null) as number | null,
    creative: r.creative_id ? { id: r.creative_id as string, version: r.creative_version as number | null, ratio: r.creative_ratio as string | null } : null, form: r.form_id ? { id: r.form_id as string, version: r.form_version as number | null } : null,
    utm: { source: r.utm_source ?? null, medium: r.utm_medium ?? null, campaign: r.utm_campaign ?? null, content: r.utm_content ?? null, term: r.utm_term ?? null },
    attribution: { status: r.attribution_status as string, basis: (r.attribution_basis ?? null) as string | null, basisText: r.attribution_basis ? ATTRIBUTION_BASIS_TEXT[r.attribution_basis as string] ?? null : null },
    consent: { status: r.consent_status as string, note: (r.consent_note ?? null) as string | null }, importBatchId: (r.import_batch_id ?? null) as string | null,
    followUp: { dueDate: (r.follow_up_due ?? null) as string | null, done: r.follow_up_done_at != null, doneAt: (r.follow_up_done_at ?? null) as string | null, note: (r.follow_up_note ?? null) as string | null },
    sameContact: same.map((x) => ({ id: x.id, name: x.full_name, origin: x.origin })),
    crm: { status: r.crm_status, error: r.crm_error, platform: r.platform ?? null, contactId: r.contact_id ?? null, contactCreated: r.created_contact == null ? null : r.created_contact === 1, simulated: true },
    history: history.map((h) => ({ from: h.from_status, to: h.to_status, note: h.note, by: h.actor, at: h.at })),
  };
}

interface EventRow {
  id: string;
  campaign_id: string;
  payload: string;
  simulated: number;
  received_at: string;
}

/** Store the lead once, then sync it to the CRM once. Safe to run any number of times. */
export async function processLeadEvent(
  c: AppContext,
  wsId: string,
  leadEventRowId: string,
  attempt: { attempts: number; maxAttempts: number },
): Promise<void> {
  const ev = c.db.prepare("SELECT id, campaign_id, payload, simulated, received_at FROM lead_events WHERE id = ? AND workspace_id = ?").get(leadEventRowId, wsId) as EventRow | undefined;
  if (!ev) throw notFound("Lead event");
  const p = JSON.parse(ev.payload) as { fullName: string; email: string | null; phone: string | null; campaignVersion?: number };

  c.db
    .prepare(
      "INSERT OR IGNORE INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, created_at, origin, campaign_version, captured_at, attribution_status, attribution_basis) VALUES (?,?,?,?,?,?,?,?,?, 'synthetic', ?, ?, 'observed', 'simulator')",
    )
    .run(newId("lead"), wsId, ev.campaign_id, ev.id, p.fullName, normalizeEmail(p.email), normalizePhone(p.phone), ev.simulated, iso(c), p.campaignVersion ?? null, ev.received_at);
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
    const msg = safeError(e, 300);
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
