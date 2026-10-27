import { roleAllows, type Role } from "../auth/authz.js";
import { getBrain } from "./workspaces.js";
import { usageSummary } from "./aiService.js";
import { iso } from "./core.js";
import type { AppContext } from "./context.js";
import { activityView } from "./views.js";

/**
 * The dashboard read model: one workspace-scoped, read-only summary assembled from what the application already stores. Nothing here is
 * estimated or invented: every number is a count or a value read from a table, and anything simulated says so.
 *
 *   - Every query filters by the verified workspace id.
 *   - Jobs are included only for roles that may already read them (jobs.read), exactly as GET /jobs.
 *   - Error text is reduced to its first line and a fixed length, so no stack trace or long provider message reaches a browser.
 */

const oneLine = (s: string | null | undefined, max = 240): string | null => (s == null ? null : (s.split(/\r?\n/)[0] ?? "").slice(0, max));

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  current_version: number;
  created_at: string;
  last_version_at: string | null;
  budget: number | null;
  p_id: string | null;
  p_status: string | null;
  p_mode: string | null;
  p_version: number | null;
  p_updated: string | null;
  e_sim: number | null;
  e_platform: string | null;
  e_state: string | null;
}

const latest = (...ts: Array<string | null | undefined>): string => ts.filter((t): t is string => !!t).sort().at(-1) ?? "";

export function dashboardView(c: AppContext, wsId: string, role: Role) {
  const db = c.db;
  const ceiling = getBrain(c, wsId)?.brain.maxDailyBudgetCents ?? null;
  const meta = c.metaFor(wsId);

  // ---- campaigns (the newest 200), each with its latest proposal and any external (simulated or real) resource
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.status, c.current_version, c.created_at,
              (SELECT MAX(v.created_at) FROM campaign_versions v WHERE v.campaign_id = c.id AND v.workspace_id = c.workspace_id) AS last_version_at,
              (SELECT json_extract(v.brief, '$.dailyBudgetCents') FROM campaign_versions v WHERE v.campaign_id = c.id AND v.workspace_id = c.workspace_id AND v.version = c.current_version) AS budget,
              p.id AS p_id, p.status AS p_status, p.integration_mode AS p_mode, p.campaign_version AS p_version, p.updated_at AS p_updated,
              e.simulated AS e_sim, e.platform AS e_platform, e.verified_state AS e_state
       FROM campaigns c
       LEFT JOIN action_proposals p ON p.id = (SELECT id FROM action_proposals WHERE campaign_id = c.id AND workspace_id = c.workspace_id ORDER BY created_at DESC, id DESC LIMIT 1)
       LEFT JOIN external_resources e ON e.proposal_id = p.id AND e.workspace_id = c.workspace_id
       WHERE c.workspace_id = ? ORDER BY c.created_at DESC, c.id LIMIT 200`,
    )
    .all(wsId) as CampaignRow[];

  const campaigns = rows.map((r) => {
    const simulated = r.e_state !== null ? r.e_sim === 1 : r.p_mode !== null ? r.p_mode === "mock" : null; // null: nothing external exists
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      currentVersion: r.current_version,
      createdAt: r.created_at,
      updatedAt: latest(r.created_at, r.last_version_at, r.p_updated),
      budgetCents: r.budget,
      overCeiling: ceiling !== null && r.budget !== null && r.budget > ceiling,
      latestProposal: r.p_id ? { id: r.p_id, status: r.p_status, mode: r.p_mode, campaignVersion: r.p_version, updatedAt: r.p_updated } : null,
      external: r.e_state !== null ? { platform: r.e_platform, simulated: r.e_sim === 1, verifiedState: r.e_state } : null,
      simulated,
    };
  });

  const count = (status: string) => campaigns.filter((x) => x.status === status).length;
  const launched = campaigns.filter((x) => x.status === "launched_paused");

  // ---- proposals that need a person, and ones that need attention
  const proposalRows = (statuses: string[], limit: number) =>
    db
      .prepare(
        `SELECT p.id, p.campaign_id, c.name AS campaign_name, p.status, p.daily_budget_cents, p.integration_mode, p.last_error, p.created_at, p.updated_at,
                COALESCE(json_array_length(json_extract(p.payload, '$.reviewFlags')), 0) AS flags
         FROM action_proposals p JOIN campaigns c ON c.id = p.campaign_id AND c.workspace_id = p.workspace_id
         WHERE p.workspace_id = ? AND p.status IN (${statuses.map(() => "?").join(",")}) ORDER BY p.updated_at DESC, p.id LIMIT ?`,
      )
      .all(wsId, ...statuses, limit) as Array<Record<string, unknown>>;

  const pendingApprovals = proposalRows(["proposed"], 20).map((r) => ({
    proposalId: r.id,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    plannedDailyBudgetCents: r.daily_budget_cents,
    mode: r.integration_mode,
    reviewFlags: r.flags,
    createdAt: r.created_at,
  }));
  const needsAttention = proposalRows(["failed", "needs_review", "stale"], 20).map((r) => ({
    proposalId: r.id,
    campaignId: r.campaign_id,
    campaignName: r.campaign_name,
    status: r.status,
    mode: r.integration_mode,
    lastError: oneLine(r.last_error as string | null),
    updatedAt: r.updated_at,
  }));

  // ---- things that were refused (budget ceiling, unsupported category, blocking questions, AI limits)
  const recentBlocked = (db.prepare("SELECT at, type, entity_id, detail FROM audit_events WHERE workspace_id = ? AND type IN ('proposal.blocked','ai.blocked','execution.refused') ORDER BY id DESC LIMIT 5").all(wsId) as Array<Record<string, string>>).map((r) => {
    let d: Record<string, unknown> = {};
    try { d = JSON.parse(String(r.detail)) as Record<string, unknown>; } catch { /* keep empty */ }
    const reason = typeof d.reason === "string" ? d.reason : typeof d.kind === "string" ? d.kind : "refused";
    return { at: r.at, type: r.type, entityId: r.entity_id, reason: reason.slice(0, 80) };
  });

  // ---- background jobs: only for roles that may already read them
  let jobs: null | {
    counts: Record<string, number>;
    attention: Array<Record<string, unknown>>;
    recent: Array<Record<string, unknown>>;
  } = null;
  if (roleAllows(role, "jobs.read")) {
    const counts: Record<string, number> = { queued: 0, running: 0, done: 0, dead: 0 };
    for (const r of db.prepare("SELECT status, COUNT(*) n FROM jobs WHERE workspace_id = ? GROUP BY status").all(wsId) as Array<{ status: string; n: number }>) counts[r.status] = r.n;
    const shape = (r: Record<string, unknown>) => ({
      id: r.id, type: r.type, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, lastError: oneLine(r.last_error as string | null), runAt: r.run_at, updatedAt: r.updated_at,
    });
    const cols = "id, type, status, attempts, max_attempts, last_error, run_at, updated_at";
    jobs = {
      counts,
      attention: (db.prepare(`SELECT ${cols} FROM jobs WHERE workspace_id = ? AND (status = 'dead' OR (status = 'queued' AND last_error IS NOT NULL)) ORDER BY updated_at DESC, id LIMIT 20`).all(wsId) as Array<Record<string, unknown>>).map(shape),
      recent: (db.prepare(`SELECT ${cols} FROM jobs WHERE workspace_id = ? ORDER BY updated_at DESC, id LIMIT 15`).all(wsId) as Array<Record<string, unknown>>).map(shape),
    };
  }

  // ---- leads
  const lead = db
    .prepare("SELECT COUNT(*) total, COALESCE(SUM(simulated = 1), 0) simulated, COALESCE(SUM(crm_status = 'synced'), 0) synced, COALESCE(SUM(crm_status = 'failed'), 0) failed FROM leads WHERE workspace_id = ?")
    .get(wsId) as { total: number; simulated: number; synced: number; failed: number };

  return {
    generatedAt: iso(c),
    mode: c.integrations.mode,
    campaigns: {
      total: campaigns.length,
      byStatus: { draft: count("draft"), launched_paused: count("launched_paused") },
      launchedSimulated: launched.filter((x) => x.simulated === true).length,
      launchedLive: launched.filter((x) => x.simulated === false).length,
      list: campaigns,
    },
    pendingApprovals,
    needsAttention,
    recentBlocked,
    jobs,
    leads: { total: lead.total, simulated: lead.simulated, crmSynced: lead.synced, crmFailed: lead.failed, crmPending: lead.total - lead.synced - lead.failed },
    recentActivity: activityView(c, wsId, 8),
    usage: usageSummary(c, wsId),
    integrations: {
      mode: c.integrations.mode,
      meta: { mode: meta.mode, simulated: meta.mode === "mock", accountId: meta.configuredAccountId, accountAuthorized: meta.mode === "mock" ? null : meta.accountId !== null },
      crm: { simulated: true, live: false },
      ai: { mode: c.integrations.aiMode, live: c.integrations.liveAi, local: c.integrations.localAi, providers: c.ai.list().map((p) => ({ id: p.id, label: p.label, available: p.available, simulated: p.simulated, local: p.local })) },
    },
  };
}
