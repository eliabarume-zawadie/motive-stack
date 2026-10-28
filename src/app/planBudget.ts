import { createHash } from "node:crypto";
import { audit, iso, type Core } from "./core.js";
import { AppError } from "./errors.js";

/**
 * Budget rules for a marketing plan. Kept apart from plans.ts so campaigns.ts and proposals.ts can use them without an import cycle.
 *
 * A plan has ONE daily total (never above the Business Brain's ceiling). The ceiling itself is a WORKSPACE-WIDE limit across all plans and stand-alone campaigns
 * (see budgetCommitments.ts); a plan's total only caps its own campaigns. Its campaigns must add up to no more than that total, each within its own planned
 * share when one is set, and a person must have reviewed exactly the current numbers before any of its campaigns can be proposed. Changing the total, a share,
 * which opportunities are selected, or any campaign's budget after the review makes the review stale. A total is never multiplied by the number of campaigns.
 */
export interface PlanOpportunityBudget {
  opportunityId: string; status: string; allocationCents: number | null; campaignId: string | null; campaignVersion: number | null; campaignBudgetCents: number | null; campaignArchived: boolean;
}

export function planBudgets(c: Core, wsId: string, planId: string): PlanOpportunityBudget[] {
  const rows = c.db.prepare(
    `SELECT o.id, o.status, o.allocation_cents, o.campaign_id, k.current_version, k.archived_at,
            (SELECT v.brief FROM campaign_versions v WHERE v.campaign_id = k.id AND v.version = k.current_version AND v.workspace_id = k.workspace_id) AS brief
     FROM plan_opportunities o LEFT JOIN campaigns k ON k.id = o.campaign_id AND k.workspace_id = o.workspace_id
     WHERE o.plan_id = ? AND o.workspace_id = ? ORDER BY o.position`,
  ).all(planId, wsId) as Array<{ id: string; status: string; allocation_cents: number | null; campaign_id: string | null; current_version: number | null; archived_at: string | null; brief: string | null }>;
  return rows.map((r) => {
    let budget: number | null = null;
    if (r.brief) { try { const n = (JSON.parse(r.brief) as { dailyBudgetCents?: unknown }).dailyBudgetCents; budget = typeof n === "number" ? n : null; } catch { budget = null; } }
    return { opportunityId: r.id, status: r.status, allocationCents: r.allocation_cents, campaignId: r.campaign_id, campaignVersion: r.current_version, campaignBudgetCents: budget, campaignArchived: r.archived_at !== null };
  });
}

/** The budgets that count toward the plan's total: campaigns that exist and are not archived. */
export const liveCampaignBudgetSum = (rows: PlanOpportunityBudget[]): number => rows.filter((r) => r.campaignId && !r.campaignArchived).reduce((n, r) => n + (r.campaignBudgetCents ?? 0), 0);

/** A hash of everything a budget review covers. Equal now and at review time means nothing the reviewer looked at has changed. */
export function planFingerprint(c: Core, wsId: string, planId: string): string {
  const plan = c.db.prepare("SELECT total_daily_budget_cents t FROM marketing_plans WHERE id = ? AND workspace_id = ?").get(planId, wsId) as { t: number | null } | undefined;
  const rows = planBudgets(c, wsId, planId).map((r) => [r.opportunityId, r.status, r.allocationCents, r.campaignId, r.campaignVersion, r.campaignBudgetCents, r.campaignArchived]);
  return createHash("sha256").update(JSON.stringify([plan?.t ?? null, rows])).digest("hex");
}

/** Records who last changed something a budget review covers, and counts the change. Called by every path that can change it. */
export function touchPlanBudget(c: Core, wsId: string, planId: string, actor: string): void {
  c.db.prepare("UPDATE marketing_plans SET budget_changed_by = ?, version = version + 1, updated_at = ? WHERE id = ? AND workspace_id = ?").run(actor, iso(c), planId, wsId);
}

/**
 * Called before a campaign that belongs to a plan can be proposed. Refuses, with the root cause first, when the plan has no total, its campaigns add up to more
 * than the total, this campaign exceeds its share, or nobody has reviewed the current numbers.
 */
export function planGate(c: Core, wsId: string, campaignId: string, actor: string): void {
  const camp = c.db.prepare("SELECT plan_id FROM campaigns WHERE id = ? AND workspace_id = ?").get(campaignId, wsId) as { plan_id: string | null } | undefined;
  if (!camp?.plan_id) return; // a stand-alone campaign: the Business Brain ceiling is checked by the proposal itself
  const plan = c.db.prepare("SELECT id, name, total_daily_budget_cents t, budget_reviewed_fingerprint f, archived_at FROM marketing_plans WHERE id = ? AND workspace_id = ?").get(camp.plan_id, wsId) as { id: string; name: string; t: number | null; f: string | null; archived_at: string | null } | undefined;
  if (!plan) return;
  const block = (code: string, status: number, message: string, extra: Record<string, unknown> = {}): never => {
    audit(c, wsId, actor, "proposal.blocked", "campaign", campaignId, { reason: code, planId: plan.id, ...extra });
    throw new AppError(status, code, message);
  };
  if (plan.archived_at) block("plan_archived", 409, `The plan "${plan.name}" is archived, so its campaigns cannot be proposed`);
  if (plan.t === null) block("plan_total_missing", 409, `Set the daily total for the plan "${plan.name}" before proposing its campaigns`);
  const rows = planBudgets(c, wsId, plan.id);
  const sum = liveCampaignBudgetSum(rows);
  if (sum > plan.t!) block("plan_budget_exceeded", 422, `The campaigns in "${plan.name}" add up to ${sum}¢ per day, which is more than the plan's total of ${plan.t}¢. Lower a campaign's budget or raise the total.`, { sum, total: plan.t });
  const mine = rows.find((r) => r.campaignId === campaignId);
  if (mine && mine.allocationCents !== null && (mine.campaignBudgetCents ?? 0) > mine.allocationCents) block("plan_allocation_exceeded", 422, `This campaign's budget (${mine.campaignBudgetCents}¢) is above its planned share of ${mine.allocationCents}¢ in "${plan.name}"`, { budget: mine.campaignBudgetCents, allocation: mine.allocationCents });
  if (plan.f !== planFingerprint(c, wsId, plan.id)) block("plan_budget_not_reviewed", 409, `Someone with permission has to review the total and each campaign's budget for "${plan.name}" before its campaigns can be proposed. The numbers changed since the last review, or it never happened.`);
}


