import { audit, iso, type Core } from "./core.js";
import { conflict, notFound } from "./errors.js";
import { touchPlanBudget } from "./planBudget.js";

/**
 * The canonical campaign lifecycle (Master PRD): idea -> draft -> needs review -> awaiting approval -> approved -> queued to run -> run -> completed / archived.
 *
 * "idea" is an OPPORTUNITY in a plan, before any campaign exists, so a campaign row starts at "draft". The legacy column campaigns.status is untouched and keeps its
 * meaning (draft | launched_paused: a paused draft exists on the platform). The lifecycle is derived from the facts (the legacy status, the latest proposal and its
 * job, the brief's open issues, and two explicit markers) and cached in campaigns.lifecycle_state:
 *
 *   explicit markers: archived_at, completed_at  (set only by archiveCampaign / completeCampaign, which are validated against the table below)
 *   legacy 'launched_paused'            -> executed_simulated (executed_external if a live proposal executed)
 *   open proposal 'executing'           -> queued to run
 *   open proposal 'approved'            -> queued to run if its execution job exists, otherwise approved
 *   open proposal 'proposed'            -> awaiting approval
 *   otherwise                           -> needs review if the brief has blocking questions or review flags, else draft
 *
 * Explicit actions are strict: an invalid transition is refused. Derived changes follow real events (a person edits, proposes, approves, runs) and are never
 * allowed to block them; if one would not be allowed by the table it is still recorded, flagged as an anomaly in the audit trail, so nothing is hidden.
 */
export const LIFECYCLE_STATES = ["draft", "needs_review", "ready_for_approval", "approved", "ready_for_execution", "executed_simulated", "executed_external", "completed", "archived"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const LIFECYCLE_LABEL: Record<LifecycleState, string> = {
  draft: "Draft", needs_review: "Needs review", ready_for_approval: "Awaiting approval", approved: "Approved, not run yet", ready_for_execution: "Queued to run",
  executed_simulated: "Run (simulated)", executed_external: "Run (live)", completed: "Completed", archived: "Archived",
};

export const TRANSITIONS: Readonly<Record<LifecycleState, readonly LifecycleState[]>> = {
  draft: ["needs_review", "ready_for_approval", "archived"],
  needs_review: ["draft", "ready_for_approval", "archived"],
  ready_for_approval: ["draft", "needs_review", "approved", "archived"],
  approved: ["draft", "needs_review", "ready_for_execution", "archived"],
  ready_for_execution: ["approved", "draft", "executed_simulated", "executed_external"], // never archived while a run is queued
  executed_simulated: ["completed", "archived"],
  executed_external: ["completed", "archived"],
  completed: ["archived"],
  archived: [],
};
export const canTransition = (from: LifecycleState, to: LifecycleState): boolean => from === to || TRANSITIONS[from].includes(to);

interface CampRow { id: string; status: string; current_version: number; lifecycle_state: LifecycleState | null; completed_at: string | null; archived_at: string | null }

function openIssues(c: Core, wsId: string, row: CampRow): boolean {
  const v = c.db.prepare("SELECT brief FROM campaign_versions WHERE campaign_id = ? AND version = ? AND workspace_id = ?").get(row.id, row.current_version, wsId) as { brief: string } | undefined;
  if (!v) return false;
  try {
    const b = JSON.parse(v.brief) as { reviewFlags?: unknown[]; openQuestions?: Array<{ blocking?: boolean }> };
    return (b.reviewFlags?.length ?? 0) > 0 || (b.openQuestions ?? []).some((q) => q.blocking === true);
  } catch { return false; }
}

export function deriveLifecycle(c: Core, wsId: string, row: CampRow): LifecycleState {
  if (row.archived_at) return "archived";
  if (row.completed_at) return "completed";
  if (row.status === "launched_paused") {
    const live = c.db.prepare("SELECT 1 FROM action_proposals WHERE campaign_id = ? AND workspace_id = ? AND status = 'executed' AND integration_mode = 'live'").get(row.id, wsId);
    return live ? "executed_external" : "executed_simulated";
  }
  const open = c.db.prepare("SELECT id, status FROM action_proposals WHERE campaign_id = ? AND workspace_id = ? AND status IN ('proposed','approved','executing') ORDER BY created_at DESC LIMIT 1").get(row.id, wsId) as { id: string; status: string } | undefined;
  if (open?.status === "executing") return "ready_for_execution";
  if (open?.status === "approved") {
    const job = c.db.prepare("SELECT 1 FROM jobs WHERE dedupe_key = ? AND workspace_id = ? AND status IN ('queued','running')").get(`exec:${open.id}`, wsId);
    return job ? "ready_for_execution" : "approved";
  }
  if (open?.status === "proposed") return "ready_for_approval";
  return openIssues(c, wsId, row) ? "needs_review" : "draft";
}

/** Brings the cached state in line with the facts. Cheap, idempotent, and safe to call after any event that could change a campaign. */
export function syncLifecycle(c: Core, wsId: string, campaignId: string, actor = "system", why = "event"): LifecycleState | null {
  const row = c.db.prepare("SELECT id, status, current_version, lifecycle_state, completed_at, archived_at FROM campaigns WHERE id = ? AND workspace_id = ?").get(campaignId, wsId) as CampRow | undefined;
  if (!row) return null;
  const next = deriveLifecycle(c, wsId, row);
  if (row.lifecycle_state === next) return next;
  if (row.lifecycle_state === null) { c.db.prepare("UPDATE campaigns SET lifecycle_state = ? WHERE id = ? AND workspace_id = ?").run(next, campaignId, wsId); return next; } // first value: nothing changed, so nothing to audit
  const from = row.lifecycle_state;
  c.db.prepare("UPDATE campaigns SET lifecycle_state = ? WHERE id = ? AND workspace_id = ?").run(next, campaignId, wsId);
  audit(c, wsId, actor, "campaign.lifecycle_changed", "campaign", campaignId, { from, to: next, why, ...(canTransition(from, next) ? {} : { anomaly: true }) });
  return next;
}

/** On start: fill in the cache for every campaign (the migration's backfill is coarse; this applies the exact rules). Records nothing for a campaign already correct. */
export function syncAllLifecycles(c: Core): number {
  const rows = c.db.prepare("SELECT id, workspace_id w FROM campaigns").all() as Array<{ id: string; w: string }>;
  let changed = 0;
  for (const r of rows) {
    const before = (c.db.prepare("SELECT lifecycle_state s FROM campaigns WHERE id = ?").get(r.id) as { s: string | null }).s;
    const after = syncLifecycle(c, r.w, r.id, "system", "start-up sync");
    if (after !== before) changed++;
  }
  return changed;
}

function strict(c: Core, wsId: string, campaignId: string): { row: CampRow; state: LifecycleState } {
  const row = c.db.prepare("SELECT id, status, current_version, lifecycle_state, completed_at, archived_at FROM campaigns WHERE id = ? AND workspace_id = ?").get(campaignId, wsId) as CampRow | undefined;
  if (!row) throw notFound("Campaign");
  return { row, state: deriveLifecycle(c, wsId, row) };
}

/** Archive a campaign (an explicit, audited action). Refused while a run is queued; a campaign that was run stays reproducible. */
export function archiveCampaign(c: Core, wsId: string, campaignId: string, actor: string): LifecycleState {
  const { state } = strict(c, wsId, campaignId);
  if (state === "archived") return state;
  if (!canTransition(state, "archived")) throw conflict("invalid_transition", `A campaign that is "${LIFECYCLE_LABEL[state]}" cannot be archived`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE campaigns SET archived_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), campaignId, wsId);
    // an open proposal for an archived campaign can never be approved or run
    c.db.prepare("UPDATE action_proposals SET status = 'stale', updated_at = ? WHERE campaign_id = ? AND workspace_id = ? AND status IN ('proposed','approved')").run(iso(c), campaignId, wsId);
    syncLifecycle(c, wsId, campaignId, actor, "archived");
    const planId = (c.db.prepare("SELECT plan_id p FROM campaigns WHERE id = ? AND workspace_id = ?").get(campaignId, wsId) as { p: string | null }).p;
    if (planId) touchPlanBudget(c, wsId, planId, actor); // an archived campaign no longer counts toward its plan
  })();
  return "archived";
}

/** Mark a campaign that was run as completed (an explicit, audited action). Only a campaign that was actually run can complete. */
export function completeCampaign(c: Core, wsId: string, campaignId: string, actor: string): LifecycleState {
  const { state } = strict(c, wsId, campaignId);
  if (state === "completed") return state;
  if (!canTransition(state, "completed")) throw conflict("invalid_transition", `Only a campaign that was run can be completed (this one is "${LIFECYCLE_LABEL[state]}")`);
  c.db.transaction(() => {
    c.db.prepare("UPDATE campaigns SET completed_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), campaignId, wsId);
    syncLifecycle(c, wsId, campaignId, actor, "completed");
  })();
  return "completed";
}
