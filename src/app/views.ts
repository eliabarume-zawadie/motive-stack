import type { AppContext } from "./context.js";
import { getCampaignRecord } from "./campaigns.js";
import { getProposalRow, listProposals, type ProposalRow } from "./proposals.js";
import { getBrain, getWorkspace } from "./workspaces.js";
import { APPLICABLE_TARGETING_NOTE, metaValidation, specialAdCategoryHints } from "../domain/briefRules.js";

/** Read models for the UI and API. Everything simulated carries an explicit `simulated` flag. */

export function proposalView(c: AppContext, wsId: string, p: ProposalRow) {
  const approval = c.db
    .prepare("SELECT decision, decided_by, reason, decided_at, expires_at, integration_mode FROM approvals WHERE proposal_id = ?")
    .get(p.id) as Record<string, string> | undefined;
  const attempts = c.db
    .prepare("SELECT attempt_no, status, dispatched, error_kind, error_message, started_at, finished_at FROM execution_attempts WHERE proposal_id = ? ORDER BY attempt_no")
    .all(p.id);
  const external = c.db
    .prepare("SELECT platform, kind, external_id, verified_state, verified_at, simulated FROM external_resources WHERE proposal_id = ?")
    .get(p.id) as { platform: string; kind: string; external_id: string; verified_state: string; verified_at: string; simulated: number } | undefined;
  return {
    id: p.id,
    campaignId: p.campaign_id,
    campaignVersion: p.campaign_version,
    type: p.type,
    status: p.status,
    mode: p.integration_mode,
    plannedDailyBudgetCents: p.daily_budget_cents,
    payload: JSON.parse(p.payload) as unknown,
    lastError: p.last_error,
    createdAt: p.created_at,
    approval: approval ?? null,
    attempts,
    externalResource: external
      ? { platform: external.platform, kind: external.kind, externalId: external.external_id, verifiedState: external.verified_state, verifiedAt: external.verified_at, simulated: external.simulated === 1 }
      : null,
  };
}

export function campaignView(c: AppContext, wsId: string, campaignId: string) {
  const rec = getCampaignRecord(c, wsId, campaignId);
  const brain = getBrain(c, wsId)?.brain;
  return {
    ...rec,
    proposals: listProposals(c, wsId, campaignId).map((p) => proposalView(c, wsId, p)),
    // Computed from the stored brief and the CURRENT Business Brain; never stored and never supplied by a model.
    ceilingCents: brain?.maxDailyBudgetCents ?? null,
    specialAdCategories: brain ? specialAdCategoryHints(brain) : [],
    platformValidation: brain ? metaValidation(rec.brief, brain) : [],
    applicableTargetingNote: APPLICABLE_TARGETING_NOTE,
  };
}

export function leadsView(c: AppContext, wsId: string) {
  return (
    c.db
      .prepare(
        `SELECT l.id, l.campaign_id, l.full_name, l.email, l.phone, l.simulated, l.crm_status, l.crm_error, l.created_at,
                s.contact_id, s.created_contact
         FROM leads l LEFT JOIN crm_syncs s ON s.lead_id = l.id
         WHERE l.workspace_id = ? ORDER BY l.created_at DESC, l.id`,
      )
      .all(wsId) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id,
    campaignId: r.campaign_id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    simulated: r.simulated === 1,
    crmStatus: r.crm_status,
    crmError: r.crm_error,
    crmContactId: r.contact_id ?? null,
    crmContactCreated: r.created_contact === null || r.created_contact === undefined ? null : r.created_contact === 1,
    createdAt: r.created_at,
  }));
}

export function activityView(c: AppContext, wsId: string, limit = 100) {
  return (c.db.prepare("SELECT id, at, actor, type, entity_type, entity_id, detail FROM audit_events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?").all(wsId, limit) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    type: r.type,
    entityType: r.entity_type,
    entityId: r.entity_id,
    detail: JSON.parse(String(r.detail)) as unknown,
  }));
}

export function jobsView(c: AppContext, wsId: string) {
  return c.db.prepare("SELECT id, type, status, attempts, max_attempts, last_error, run_at FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC, id LIMIT 50").all(wsId);
}

export function workspaceView(c: AppContext, wsId: string) {
  const ws = getWorkspace(c, wsId);
  return { ...ws, mode: c.metaFor(wsId).mode, metaAccountId: c.metaFor(wsId).accountId };
}

export { getProposalRow };
