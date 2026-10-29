import { createHash } from "node:crypto";
import { z } from "zod";
import { getCampaignRow } from "./campaigns.js";
import type { AppContext } from "./context.js";
import { audit, iso, type Core } from "./core.js";
import { AppError, conflict, notFound } from "./errors.js";
import { newId } from "./util.js";
import { assertQuota } from "./quotas.js";
import { normalizeEmail, normalizePhone } from "../integrations/crm.js";

/**
 * How leads get in beyond the simulator, and how they are labelled. Rules this file keeps:
 *  - ORIGIN says what a lead is: synthetic (made by this app), imported (a person brought it in), real (captured by a verified integration: nothing creates these yet);
 *  - ATTRIBUTION says how sure the campaign link is: observed (a verified integration reported it: none exists), inferred (assigned or matched by a stated rule) or
 *    unknown (the evidence does not support it). Arriving after a campaign is never treated as proof the campaign caused it;
 *  - an imported lead is never sent to any CRM, never messaged, and never counted as real; the importer says where it came from;
 *  - a lead form here is a DEFINITION plus a clearly labelled TEST submission. Nothing is published or hosted, there is no public endpoint and no tracking pixel.
 */

const text = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const optText = (max: number) => z.string().trim().max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "No control characters");
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").refine((s) => { const d = new Date(`${s}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; }, "That is not a real date");
const kindOf = (label: string | null): "person" | "shared_token" | "system" | null => (label === null ? null : label.startsWith("user:") ? "person" : label.startsWith("workspace-token:") ? "shared_token" : "system");

export const UtmSchema = z.object({ source: optText(100).optional(), medium: optText(100).optional(), campaign: optText(100).optional(), content: optText(100).optional(), term: optText(100).optional() }).strict();
type Utm = z.infer<typeof UtmSchema>;
const utmCols = (u: Utm | undefined) => [u?.source || null, u?.medium || null, u?.campaign || null, u?.content || null, u?.term || null] as const;

/** The tag a campaign's ads would carry in utm_campaign. It is the campaign's own id: stable, never guessed from a name. */
export const utmCampaignFor = (campaignId: string): string => campaignId;

/** Decides how sure the campaign link of an IMPORTED lead is, from the evidence it carries. */
export function importedAttribution(campaignId: string, utm: Utm | undefined): { status: "inferred" | "unknown"; basis: string } {
  const tag = utm?.campaign?.trim();
  if (!tag) return { status: "inferred", basis: "assigned_by_importer" };
  if (tag === utmCampaignFor(campaignId)) return { status: "inferred", basis: "utm_matches_campaign" };
  return { status: "unknown", basis: "utm_names_another_campaign" };
}
export const ATTRIBUTION_BASIS_TEXT: Record<string, string> = {
  simulator: "Made by this app's simulator for this campaign (synthetic)",
  form_test: "A test submission of a form for this campaign (synthetic)",
  assigned_by_importer: "The person who imported it chose this campaign; no tracking evidence came with it",
  utm_matches_campaign: "Its utm_campaign tag names this campaign; still an inference, not proof the campaign caused it",
  utm_names_another_campaign: "Its utm_campaign tag names a different campaign, so the link is not supported",
};

/* ------------------------------------------------------------------------------------------------ import */

const RowSchema = z.object({
  fullName: text(100), email: z.string().trim().toLowerCase().email().max(200).optional(), phone: z.string().trim().min(7).max(25).optional(),
  externalId: text(100).optional(), capturedAt: DATE.optional(), utm: UtmSchema.optional(),
}).strict().refine((r) => normalizeEmail(r.email) || normalizePhone(r.phone), { message: "email or phone is required" });
export const LeadImportSchema = z.object({
  campaignId: z.string().regex(/^[a-z0-9_]{1,64}$/), campaignVersion: z.number().int().min(1).max(99999).optional(), sourceNote: text(300), consent: z.enum(["given", "not_recorded"]).default("not_recorded"), rows: z.array(z.unknown()).min(1).max(200),
}).strict();
export const MAX_IMPORT_ROWS = 200;

export function importLeads(c: AppContext, wsId: string, actor: string, input: unknown) {
  const b = LeadImportSchema.parse(input);
  getCampaignRow(c, wsId, b.campaignId);
  // The importer may say which campaign VERSION the leads were captured under (their statement; it must be a version that exists). Without it a lead cannot be assigned to an experiment variant.
  if (b.campaignVersion !== undefined && !c.db.prepare("SELECT 1 FROM campaign_versions WHERE campaign_id = ? AND version = ? AND workspace_id = ?").get(b.campaignId, b.campaignVersion, wsId)) throw notFound("Campaign version");
  assertQuota(c, wsId, "leads", b.rows.length); // the whole batch must fit: nothing is half-imported
  const batchId = newId("imp");
  const rejected: Array<{ row: number; reason: string }> = [];
  let imported = 0, duplicates = 0;
  c.db.transaction(() => {
    b.rows.forEach((raw, i) => {
      const p = RowSchema.safeParse(raw);
      if (!p.success) { rejected.push({ row: i + 1, reason: p.error.issues.map((x) => `${x.path.join(".") || "row"}: ${x.message}`).join("; ").slice(0, 200) }); return; }
      const r = p.data;
      const email = normalizeEmail(r.email), phone = normalizePhone(r.phone);
      const eventId = r.externalId ?? `imp_${createHash("sha256").update(`${email ?? ""}|${phone ?? ""}|${r.fullName.toLowerCase()}`).digest("hex").slice(0, 32)}`;
      const evId = newId("lev");
      const ins = c.db.prepare("INSERT OR IGNORE INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES (?,?,?,?,?,?,0,?)")
        .run(evId, wsId, "import", eventId, b.campaignId, JSON.stringify({ fullName: r.fullName, email, phone }), iso(c));
      if (ins.changes === 0) { duplicates++; return; }
      const attr = importedAttribution(b.campaignId, r.utm);
      c.db.prepare(`INSERT INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, crm_status, created_at, origin, campaign_version, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                                       captured_at, attribution_status, attribution_basis, consent_status, consent_note, import_batch_id)
                    VALUES (?,?,?,?,?,?,?,0,'not_synced',?, 'imported', ?, ?,?,?,?,?, ?,?,?,?,?,?)`)
        .run(newId("lead"), wsId, b.campaignId, evId, r.fullName, email, phone, iso(c), b.campaignVersion ?? null, ...utmCols(r.utm), r.capturedAt ? `${r.capturedAt}T00:00:00.000Z` : null, attr.status, attr.basis, b.consent, b.consent === "given" ? `Stated by the importer: ${b.sourceNote}`.slice(0, 300) : null, batchId);
      imported++;
    });
    c.db.prepare("INSERT INTO lead_import_batches (id, workspace_id, campaign_id, source_note, consent_status, rows_received, rows_imported, rows_duplicate, rows_rejected, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(batchId, wsId, b.campaignId, b.sourceNote, b.consent, b.rows.length, imported, duplicates, rejected.length, iso(c), actor);
    audit(c, wsId, actor, "lead.imported", "lead_import", batchId, { campaignId: b.campaignId, received: b.rows.length, imported, duplicates, rejected: rejected.length, consent: b.consent });
  })();
  return { batchId, received: b.rows.length, imported, duplicates, rejected, note: "Imported leads are labelled IMPORTED. They are not sent to any CRM and nothing is sent to them." };
}

export function listImportBatches(c: Core, wsId: string) {
  return { batches: (c.db.prepare("SELECT b.*, k.name AS campaign_name FROM lead_import_batches b LEFT JOIN campaigns k ON k.id = b.campaign_id WHERE b.workspace_id = ? ORDER BY b.created_at DESC, b.id LIMIT 50").all(wsId) as Array<Record<string, any>>)
    .map((r) => ({ id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, sourceNote: r.source_note, consent: r.consent_status, received: r.rows_received, imported: r.rows_imported, duplicates: r.rows_duplicate, rejected: r.rows_rejected, at: r.created_at, byKind: kindOf(r.created_by) })) };
}

/* ------------------------------------------------------------------------------------------------ follow-up */

export const FollowUpSchema = z.object({ dueDate: DATE.nullable().optional(), note: optText(300).optional(), done: z.boolean().optional() }).strict();
/** A reminder for the team. Nothing is sent: this app has no e-mail, text or call capability. */
export function setFollowUp(c: Core, wsId: string, leadId: string, input: unknown, actor: string) {
  const b = FollowUpSchema.parse(input);
  const l = c.db.prepare("SELECT follow_up_due, follow_up_done_at, follow_up_note FROM leads WHERE id = ? AND workspace_id = ?").get(leadId, wsId) as { follow_up_due: string | null; follow_up_done_at: string | null; follow_up_note: string | null } | undefined;
  if (!l) throw notFound("Lead");
  const due = b.dueDate === undefined ? l.follow_up_due : b.dueDate;
  const note = b.note === undefined ? l.follow_up_note : b.note || null;
  if (b.done && !due) throw new AppError(400, "no_follow_up", "There is no follow-up to mark done. Set a date first.");
  const doneAt = b.done === true ? iso(c) : b.dueDate !== undefined && b.dueDate !== l.follow_up_due ? null : b.done === false ? null : l.follow_up_done_at;
  c.db.transaction(() => {
    c.db.prepare("UPDATE leads SET follow_up_due = ?, follow_up_note = ?, follow_up_done_at = ? WHERE id = ? AND workspace_id = ?").run(due, note, doneAt, leadId, wsId);
    audit(c, wsId, actor, "lead.follow_up_set", "lead", leadId, { due, done: doneAt !== null });
  })();
  return { followUp: { dueDate: due, done: doneAt !== null, doneAt, note } };
}

/* ------------------------------------------------------------------------------------------------ forms (definitions and test submissions only) */

const FIELD_MODE = z.enum(["required", "optional", "off"]);
const FormBody = {
  fields: z.object({ email: FIELD_MODE, phone: FIELD_MODE }).strict().refine((f) => f.email === "required" || f.phone === "required", { message: "A form must require an email, a phone number, or both" }),
  privacyNotice: text(600), consentText: text(300), purpose: text(300), retentionNote: text(300),
};
export const FormCreateSchema = z.object({ name: text(80), ...FormBody }).strict();
export const FormReviseSchema = z.object({ ...FormBody }).strict();
export const TestSubmissionSchema = z.object({
  fullName: text(100), email: z.string().trim().toLowerCase().email().max(200).optional(), phone: z.string().trim().min(7).max(25).optional(), consent: z.boolean(),
  utm: UtmSchema.optional(), creativeId: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(), creativeVersion: z.number().int().min(1).optional(), ratio: z.enum(["1:1", "4:5", "9:16", "1.91:1"]).optional(), eventId: text(100).optional(),
}).strict();

interface FormRow { id: string; campaign_id: string; name: string; current_version: number; created_at: string; created_by: string; archived_at: string | null }
interface FormVerRow { form_id: string; version: number; campaign_version: number; fields: string; privacy_notice: string; consent_text: string; purpose: string; retention_note: string; created_at: string; created_by: string }
const getForm = (c: Core, wsId: string, id: string): FormRow => {
  const r = c.db.prepare("SELECT * FROM lead_forms WHERE id = ? AND workspace_id = ?").get(id, wsId) as FormRow | undefined;
  if (!r) throw notFound("Form");
  return r;
};

export function formDetail(c: Core, wsId: string, formId: string) {
  const f = getForm(c, wsId, formId);
  const versions = (c.db.prepare("SELECT * FROM lead_form_versions WHERE form_id = ? AND workspace_id = ? ORDER BY version").all(formId, wsId) as FormVerRow[]).map((v) => ({
    version: v.version, campaignVersion: v.campaign_version, fields: JSON.parse(v.fields) as { email: string; phone: string }, privacyNotice: v.privacy_notice, consentText: v.consent_text, purpose: v.purpose, retentionNote: v.retention_note, createdAt: v.created_at, createdByKind: kindOf(v.created_by),
  }));
  return {
    id: f.id, campaignId: f.campaign_id, name: f.name, currentVersion: f.current_version, versions, archived: f.archived_at !== null,
    published: false, publishNote: "This form is a definition. It is not published or hosted anywhere: there is no public page, no tracking pixel and no way for a visitor to submit it. Use the test submission to see how a lead would be recorded.",
  };
}
export function listForms(c: Core, wsId: string, campaignId: string) {
  getCampaignRow(c, wsId, campaignId);
  return { forms: (c.db.prepare("SELECT id FROM lead_forms WHERE workspace_id = ? AND campaign_id = ? AND archived_at IS NULL ORDER BY created_at DESC, id").all(wsId, campaignId) as Array<{ id: string }>).map((r) => formDetail(c, wsId, r.id)) };
}

export function createForm(c: AppContext, wsId: string, actor: string, campaignId: string, input: unknown) {
  const b = FormCreateSchema.parse(input);
  const camp = getCampaignRow(c, wsId, campaignId);
  assertQuota(c, wsId, "forms");
  const id = newId("frm");
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO lead_forms (id, workspace_id, campaign_id, name, current_version, created_at, created_by) VALUES (?,?,?,?,1,?,?)").run(id, wsId, campaignId, b.name, iso(c), actor);
    c.db.prepare("INSERT INTO lead_form_versions (form_id, version, workspace_id, campaign_version, fields, privacy_notice, consent_text, purpose, retention_note, created_at, created_by) VALUES (?,1,?,?,?,?,?,?,?,?,?)")
      .run(id, wsId, camp.current_version, JSON.stringify(b.fields), b.privacyNotice, b.consentText, b.purpose, b.retentionNote, iso(c), actor);
    audit(c, wsId, actor, "lead_form.created", "lead_form", id, { campaignId, fields: b.fields });
  })();
  return formDetail(c, wsId, id);
}
export function reviseForm(c: Core, wsId: string, actor: string, formId: string, input: unknown) {
  const b = FormReviseSchema.parse(input);
  const f = getForm(c, wsId, formId);
  if (f.archived_at) throw conflict("form_archived", "This form is archived");
  const camp = getCampaignRow(c, wsId, f.campaign_id);
  const v = f.current_version + 1;
  c.db.transaction(() => {
    c.db.prepare("INSERT INTO lead_form_versions (form_id, version, workspace_id, campaign_version, fields, privacy_notice, consent_text, purpose, retention_note, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(formId, v, wsId, camp.current_version, JSON.stringify(b.fields), b.privacyNotice, b.consentText, b.purpose, b.retentionNote, iso(c), actor);
    c.db.prepare("UPDATE lead_forms SET current_version = ? WHERE id = ? AND workspace_id = ?").run(v, formId, wsId);
    audit(c, wsId, actor, "lead_form.revised", "lead_form", formId, { version: v });
  })();
  return formDetail(c, wsId, formId);
}

/** A TEST submission: validated against the form's current version, recorded as a SYNTHETIC lead, never sent anywhere. Mock mode only. */
export function testSubmit(c: AppContext, wsId: string, actor: string, formId: string, input: unknown) {
  const b = TestSubmissionSchema.parse(input);
  const f = getForm(c, wsId, formId);
  if (f.archived_at) throw conflict("form_archived", "This form is archived");
  if (c.metaFor(wsId).mode !== "mock") throw conflict("test_submissions_disabled", "Test submissions are only allowed in mock mode, so test data can never mix with real leads");
  const v = c.db.prepare("SELECT * FROM lead_form_versions WHERE form_id = ? AND version = ? AND workspace_id = ?").get(formId, f.current_version, wsId) as FormVerRow;
  const fields = JSON.parse(v.fields) as { email: "required" | "optional" | "off"; phone: "required" | "optional" | "off" };
  const email = fields.email === "off" ? null : normalizeEmail(b.email), phone = fields.phone === "off" ? null : normalizePhone(b.phone);
  if (fields.email === "required" && !email) throw new AppError(400, "email_required", "This form requires an email address");
  if (fields.phone === "required" && !phone) throw new AppError(400, "phone_required", "This form requires a phone number");
  if (!b.consent) throw new AppError(400, "consent_required", "The visitor must agree to the consent wording before the form can be submitted");
  let cv: number | null = null;
  if (b.creativeId) {
    const cr = c.db.prepare("SELECT campaign_id, current_version FROM creatives WHERE id = ? AND workspace_id = ?").get(b.creativeId, wsId) as { campaign_id: string; current_version: number } | undefined;
    if (!cr) throw notFound("Creative");
    if (cr.campaign_id !== f.campaign_id) throw new AppError(400, "creative_not_in_campaign", "That creative belongs to a different campaign");
    cv = b.creativeVersion ?? cr.current_version;
    if (!c.db.prepare("SELECT 1 FROM creative_versions WHERE creative_id = ? AND version = ? AND workspace_id = ?").get(b.creativeId, cv, wsId)) throw notFound("Creative version");
  }
  const camp = getCampaignRow(c, wsId, f.campaign_id);
  assertQuota(c, wsId, "leads");
  const eventId = b.eventId ?? newId("evt");
  const evId = newId("lev");
  const ins = c.db.prepare("INSERT OR IGNORE INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES (?,?,?,?,?,?,1,?)")
    .run(evId, wsId, "form_test", eventId, f.campaign_id, JSON.stringify({ fullName: b.fullName, email, phone }), iso(c));
  if (ins.changes === 0) { audit(c, wsId, actor, "lead.duplicate_event", "lead_event", eventId, { campaignId: f.campaign_id }); return { duplicate: true, eventId, leadId: null }; }
  const leadId = newId("lead");
  c.db.transaction(() => {
    c.db.prepare(`INSERT INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, crm_status, created_at, origin, campaign_version, creative_id, creative_version, creative_ratio, form_id, form_version,
                                     utm_source, utm_medium, utm_campaign, utm_content, utm_term, captured_at, attribution_status, attribution_basis, consent_status, consent_note)
                  VALUES (?,?,?,?,?,?,?,1,'not_synced',?, 'synthetic', ?,?,?,?,?,?, ?,?,?,?,?, ?, 'observed','form_test','given',?)`)
      .run(leadId, wsId, f.campaign_id, evId, b.fullName, email, phone, iso(c), camp.current_version, b.creativeId ?? null, cv, b.ratio ?? null, formId, f.current_version, ...utmCols(b.utm), iso(c), `Test consent to: ${v.consent_text}`.slice(0, 300));
    audit(c, wsId, actor, "lead.form_test_submitted", "lead", leadId, { formId, formVersion: f.current_version, campaignVersion: camp.current_version, creativeId: b.creativeId ?? null });
  })();
  return { duplicate: false, eventId, leadId };
}
