import { roleAllows, type Permission, type Role } from "../auth/authz.js";
import { getBrain } from "./workspaces.js";
import { usageSummary } from "./aiService.js";
import { iso } from "./core.js";
import { jobRetryState } from "./jobs.js";
import { budgetPosition } from "./budgetCommitments.js";
import { LIFECYCLE_LABEL, type LifecycleState } from "./lifecycle.js";
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

export const lastAiTest = (db: AppContext["db"], wsId: string): { at: string; ok: boolean; provider: string; model: string; simulated: boolean } | null => {
  const r = db.prepare("SELECT at, detail FROM audit_events WHERE workspace_id = ? AND type = 'ai.connection_test' ORDER BY id DESC LIMIT 1").get(wsId) as { at: string; detail: string } | undefined;
  if (!r) return null;
  try { const d = JSON.parse(r.detail) as Record<string, unknown>; return { at: r.at, ok: d.ok === true, provider: String(d.provider ?? ""), model: String(d.model ?? ""), simulated: d.provider === "mock" }; } catch { return null; }
};
const oneLine = (s: string | null | undefined, max = 240): string | null => (s == null ? null : (s.split(/\r?\n/)[0] ?? "").slice(0, max));

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  current_version: number;
  created_at: string;
  lifecycle_state: string | null;
  plan_id: string | null;
  plan_name: string | null;
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

/** `who` is a built-in role, or a function that answers "may this caller do X?" (used for members with a custom role). */
export function dashboardView(c: AppContext, wsId: string, who: Role | ((p: Permission) => boolean)) {
  const may = typeof who === "function" ? who : (p: Permission) => roleAllows(who, p);
  const db = c.db;
  const ceiling = getBrain(c, wsId)?.brain.maxDailyBudgetCents ?? null;
  const meta = c.metaFor(wsId);

  // ---- campaigns (the newest 200), each with its latest proposal and any external (simulated or real) resource
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.status, c.current_version, c.created_at, c.lifecycle_state, c.plan_id, (SELECT name FROM marketing_plans mp WHERE mp.id = c.plan_id AND mp.workspace_id = c.workspace_id) AS plan_name,
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
      lifecycle: r.lifecycle_state ?? "draft",
      lifecycleLabel: LIFECYCLE_LABEL[(r.lifecycle_state ?? "draft") as LifecycleState],
      plan: r.plan_id ? { id: r.plan_id, name: r.plan_name } : null,
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
  if (may("jobs.read")) {
    const counts: Record<string, number> = { queued: 0, running: 0, done: 0, dead: 0 };
    for (const r of db.prepare("SELECT status, COUNT(*) n FROM jobs WHERE workspace_id = ? GROUP BY status").all(wsId) as Array<{ status: string; n: number }>) counts[r.status] = r.n;
    // What the job is about, from names the app already stores (never the raw payload).
    const about = (r: Record<string, unknown>): string | null => {
      try {
        const p = JSON.parse(String(r.payload)) as Record<string, string>;
        if (r.type === "process_lead" && p.leadEventId) {
          const x = db.prepare("SELECT l.full_name n FROM lead_events e LEFT JOIN leads l ON l.lead_event_id = e.id WHERE e.id = ? AND e.workspace_id = ?").get(p.leadEventId, wsId) as { n: string | null } | undefined;
          return x?.n ? "Lead: " + x.n : "A lead event";
        }
        if (p.proposalId) {
          const x = db.prepare("SELECT k.name n FROM action_proposals a JOIN campaigns k ON k.id = a.campaign_id WHERE a.id = ? AND a.workspace_id = ?").get(p.proposalId, wsId) as { n: string } | undefined;
          return x ? "Campaign: " + x.n : "A proposal";
        }
      } catch { /* unknown payload shape */ }
      return null;
    };
    const shape = (r: Record<string, unknown>) => {
      const retry = jobRetryState({ type: String(r.type), status: String(r.status), manual_retries: Number(r.manual_retries) });
      return {
        id: r.id, type: r.type, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, lastError: oneLine(r.last_error as string | null), runAt: r.run_at, updatedAt: r.updated_at,
        createdAt: r.created_at, about: about(r), simulated: true, // every integration in this release is the built-in simulator
        durationMs: r.status === "done" || r.status === "dead" ? Math.max(0, Date.parse(String(r.updated_at)) - Date.parse(String(r.created_at))) : null,
        manualRetries: r.manual_retries, retryable: retry.eligible, retryNote: retry.reason,
      };
    };
    const cols = "id, type, status, attempts, max_attempts, last_error, run_at, updated_at, created_at, payload, manual_retries";
    jobs = {
      counts,
      attention: (db.prepare(`SELECT ${cols} FROM jobs WHERE workspace_id = ? AND (status = 'dead' OR (status = 'queued' AND last_error IS NOT NULL)) ORDER BY updated_at DESC, id LIMIT 20`).all(wsId) as Array<Record<string, unknown>>).map(shape),
      recent: (db.prepare(`SELECT ${cols} FROM jobs WHERE workspace_id = ? ORDER BY updated_at DESC, id LIMIT 15`).all(wsId) as Array<Record<string, unknown>>).map(shape),
    };
  }

  // ---- Business Brain completeness, from the SAVED brain (what the campaign is actually written from)
  const REQUIRED_TOTAL = 6; // name, industry, services, service area, target customer, offer: the schema will not save a Brain without them
  const stored = getBrain(c, wsId);
  const recommended: Array<[string, boolean]> = stored ? [
    ["Strengths ads may use", stored.brain.differentiators.length > 0],
    ["Credentials and verified facts", stored.brain.verifiedFacts.length > 0],
    ["A pricing statement", !!stored.brain.approvedPricing],
    ["A business summary", !!stored.brain.description],
    ["Your tone of voice (beyond the default)", stored.brain.tone !== "friendly and professional"],
  ] : [];
  const brain = {
    saved: !!stored, version: stored?.version ?? 0, requiredFilled: stored ? REQUIRED_TOTAL : 0, requiredTotal: REQUIRED_TOTAL,
    recommendedFilled: recommended.filter(([, ok]) => ok).length, recommendedTotal: 5, missingRecommended: recommended.filter(([, ok]) => !ok).map(([l]) => l),
  };

  // ---- the latest website analysis, and the statements on it that wait for the owner (claims are never confirmed automatically)
  const an = db.prepare("SELECT id, site, status, analysis_mode, completed_at, created_at FROM website_analyses WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(wsId) as { id: string; site: string; status: string; analysis_mode: string | null; completed_at: string | null; created_at: string } | undefined;
  const claimsWaiting = an && an.status === "ready"
    ? (db.prepare("SELECT COUNT(*) n FROM website_insights WHERE analysis_id = ? AND workspace_id = ? AND status = 'proposed' AND basis = 'found_on_site' AND flags LIKE '%risky_claim%'").get(an.id, wsId) as { n: number }).n
    : 0;
  const analysis = an ? { id: an.id, site: an.site, status: an.status, mode: an.analysis_mode, at: an.completed_at ?? an.created_at, claimsWaiting } : null;

  // ---- campaign questions that BLOCK launch (from each draft campaign's current version)
  const blockingQuestions = (db.prepare(
    `SELECT c.id, c.name, v.brief FROM campaigns c JOIN campaign_versions v ON v.campaign_id = c.id AND v.workspace_id = c.workspace_id AND v.version = c.current_version
     WHERE c.workspace_id = ? AND c.status = 'draft' ORDER BY c.created_at DESC`,
  ).all(wsId) as Array<{ id: string; name: string; brief: string }>).flatMap((r) => {
    try {
      const qs = (JSON.parse(r.brief) as { openQuestions?: Array<{ blocking?: boolean }> }).openQuestions ?? [];
      const n = qs.filter((q) => typeof q === "object" && q !== null && q.blocking === true).length;
      return n ? [{ campaignId: r.id, campaignName: r.name, count: n }] : [];
    } catch { return []; }
  });

  // ---- leads
  const lead = db
    .prepare("SELECT COUNT(*) total, COALESCE(SUM(simulated = 1), 0) simulated, COALESCE(SUM(crm_status = 'synced'), 0) synced, COALESCE(SUM(crm_status = 'failed'), 0) failed FROM leads WHERE workspace_id = ?")
    .get(wsId) as { total: number; simulated: number; synced: number; failed: number };

  // ---- "Needs your attention": one list, built here from the figures above, each item saying why it matters and where to go
  type Attention = { kind: string; text: string; why: string; target: string; campaignId?: string };
  const attention: Attention[] = [];
  const budgetNow = budgetPosition(c, wsId);
  const mayDecide = may("proposals.decide");
  const approvedWaiting = (c.db.prepare("SELECT COUNT(*) n FROM action_proposals WHERE workspace_id = ? AND status = 'approved'").get(wsId) as { n: number }).n;
  if (!brain.saved) attention.push({ kind: "brain_not_saved", text: "Your Business Brain is not saved yet.", why: "Campaigns are written from it, so nothing can be drafted until it is saved.", target: "s-brain" });
  if (claimsWaiting) attention.push({ kind: "claims_waiting", text: `${claimsWaiting} statement${claimsWaiting === 1 ? "" : "s"} from your website need your confirmation (guarantees, credentials, numbers, results).`, why: "Ads may only repeat what you confirm is true and can prove, so these stay out until you decide.", target: "s-brain" });
  for (const b of blockingQuestions) attention.push({ kind: "blocking_questions", text: `“${b.campaignName}” has ${b.count} question${b.count === 1 ? "" : "s"} that must be answered before launch.`, why: "The draft cannot be proposed for approval until they are answered.", target: "s-campaigns", campaignId: b.campaignId });
  if (pendingApprovals.length) attention.push({ kind: "approvals_waiting", text: `${pendingApprovals.length} campaign${pendingApprovals.length === 1 ? " is" : "s are"} waiting for ${mayDecide ? "your decision" : "an admin's decision"}.`, why: "Nothing is created on an ad platform until it is approved.", target: "s-launch" });
  if (approvedWaiting) attention.push({ kind: "approved_not_run", text: `${approvedWaiting} approved campaign${approvedWaiting === 1 ? " has" : "s have"} not been run yet.`, why: `Approving does not run anything. ${may("proposals.execute") ? "Open it and press Run (simulated)." : "Someone allowed to run approved actions has to start it."}`, target: "s-launch" });
  if (budgetNow.overLimitCents > 0) attention.push({ kind: "budget_over_limit", text: `Your committed daily budget is ${budgetNow.committedCents}¢, which is ${budgetNow.overLimitCents}¢ over your daily limit of ${budgetNow.ceilingCents}¢.`, why: "Nothing new can be approved or run until a campaign is archived or completed, or the limit is raised in My business.", target: "s-launch" });
  if (budgetNow.unnormalizable.length) attention.push({ kind: "budget_not_normalizable", text: `A committed budget for "${budgetNow.unnormalizable[0]!.campaignName}" cannot be read as a daily amount.`, why: "The remaining limit cannot be worked out, so nothing new can be approved until it is reviewed.", target: "s-launch" });
  if (needsAttention.length) attention.push({ kind: "proposals_failed", text: `${needsAttention.length} proposal${needsAttention.length === 1 ? "" : "s"} failed, went stale or need a check.`, why: "The platform did not confirm the draft, so nothing can be assumed.", target: "s-ops" });
  if (jobs && jobs.attention.length) attention.push({ kind: "jobs_failed", text: `${jobs.attention.length} background job${jobs.attention.length === 1 ? "" : "s"} failed or are retrying.`, why: "Work that did not finish may need a person.", target: "s-ops" });
  if (lead.failed) attention.push({ kind: "crm_failed", text: `${lead.failed} lead${lead.failed === 1 ? "" : "s"} could not be synced to the (simulated) CRM.`, why: "The lead is saved, but its contact was not created.", target: "s-leads" });
  if (brain.saved && brain.missingRecommended.length) attention.push({ kind: "brain_more_detail", text: `Optional: add ${brain.missingRecommended.join(", ").toLowerCase()}.`, why: "More detail lets campaigns say more that is true and specific.", target: "s-brain" });

  return {
    generatedAt: iso(c),
    mode: c.integrations.mode,
    brain,
    analysis,
    blockingQuestions,
    attention,
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
    /** The workspace-wide daily limit: what is committed, by which campaigns, and what is left. Each campaign appears once. */
    budget: { ceilingCents: budgetNow.ceilingCents, committedCents: budgetNow.committedCents, availableCents: budgetNow.availableCents, overLimitCents: budgetNow.overLimitCents, commitments: budgetNow.commitments, unnormalizable: budgetNow.unnormalizable },
    recentActivity: activityView(c, wsId, 8),
    usage: usageSummary(c, wsId),
    integrations: {
      mode: c.integrations.mode,
      meta: { mode: meta.mode, simulated: meta.mode === "mock", accountId: meta.configuredAccountId, accountAuthorized: meta.mode === "mock" ? null : meta.accountId !== null },
      crm: { simulated: true, live: false },
      // The most recent explicit connection test (and nothing else): the app never tests an integration on its own.
      lastAiTest: lastAiTest(db, wsId),
      ai: { mode: c.integrations.aiMode, live: c.integrations.liveAi, local: c.integrations.localAi, providers: c.ai.list().map((p) => ({ id: p.id, label: p.label, available: p.available, simulated: p.simulated, local: p.local })) },
    },
  };
}
