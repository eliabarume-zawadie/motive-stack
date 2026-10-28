import { iso, type Core } from "./core.js";
import { AppError } from "./errors.js";
import { getBrain } from "./workspaces.js";

/**
 * The workspace's AGGREGATE daily budget limit.
 *
 * The Business Brain's daily ceiling is the most the owner is willing to have committed per day across the WHOLE workspace: every plan and every stand-alone
 * campaign together. It is not an allowance per campaign or per plan. Each client workspace of an agency has its own limit; nothing is counted across workspaces.
 *
 * What counts as a commitment: a campaign's `plannedDailyBudgetCents` from its latest proposal that is
 *   - approved and the approval has not expired (a lapsed, never-run approval is released), or
 *   - executing, or executed, or "needs review" (the platform outcome is unknown, so it is held conservatively),
 * and only while the campaign is neither archived nor completed. A proposal that is only proposed, stale, rejected or failed commits nothing.
 *
 * Each campaign is counted ONCE, from that one proposal. A plan's total is a cap on its own campaigns and is never added: a campaign in a plan, in the campaign
 * list and in a plan view is still one row. Plans are not a separate pot of money.
 *
 * Normalization: every budget in this release is a positive whole number of cents PER DAY in the workspace's single currency (the campaign brief and the proposal
 * payload have no lifetime budget, schedule or currency field; a plan's duration is descriptive only and is never used to convert a budget). A committed
 * proposal whose budget is not exactly that (a missing or non-positive amount, a different basis, a different currency, or a column that disagrees with the
 * payload) cannot be normalized: it is reported, it blocks new commitments until a person has looked at it, and it is never counted as zero.
 */

export type CommitmentState = "approved" | "executing" | "executed" | "needs_review";

export interface Commitment { campaignId: string; campaignName: string; proposalId: string; cents: number; state: CommitmentState; planId: string | null }
export interface Unnormalizable { campaignId: string; campaignName: string; proposalId: string; reason: string }

export interface BudgetPosition {
  ceilingCents: number | null;
  committedCents: number;
  /** Never negative: when commitments already exceed the limit this is 0 and `overLimitCents` says by how much. */
  availableCents: number | null;
  overLimitCents: number;
  commitments: Commitment[];
  unnormalizable: Unnormalizable[];
}

/** The daily amount of a stored payload, or the reason it cannot be read as one. */
export function normalizeDaily(payloadJson: string, column: number): { ok: true; cents: number } | { ok: false; reason: string } {
  let p: Record<string, unknown>;
  try { p = JSON.parse(payloadJson) as Record<string, unknown>; } catch { return { ok: false, reason: "the stored proposal could not be read" }; }
  const n = p.plannedDailyBudgetCents;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) return { ok: false, reason: "it has no valid daily budget" };
  if (p.budgetBasis !== undefined && p.budgetBasis !== "daily") return { ok: false, reason: `its budget is "${String(p.budgetBasis)}", not daily` };
  if (p.currency !== undefined || p.lifetimeBudgetCents !== undefined || p.totalBudgetCents !== undefined) return { ok: false, reason: "it carries a lifetime, total or currency field this release cannot convert to a daily amount" };
  if (column !== n) return { ok: false, reason: "its recorded budget disagrees with its payload" };
  return { ok: true, cents: n };
}

/** The workspace's current commitments, one per campaign, plus anything that could not be normalized. Read-only. */
export function budgetPosition(c: Core, wsId: string): BudgetPosition {
  const ceiling = getBrain(c, wsId)?.brain.maxDailyBudgetCents ?? null;
  const rows = c.db.prepare(
    `SELECT p.id, p.campaign_id, k.name, k.plan_id, p.status, p.daily_budget_cents, p.payload
     FROM action_proposals p JOIN campaigns k ON k.id = p.campaign_id AND k.workspace_id = p.workspace_id
     WHERE p.workspace_id = ? AND k.archived_at IS NULL AND k.completed_at IS NULL
       AND (p.status IN ('executing','executed','needs_review')
            OR (p.status = 'approved' AND EXISTS (SELECT 1 FROM approvals a WHERE a.proposal_id = p.id AND a.workspace_id = p.workspace_id AND a.decision = 'approve' AND a.expires_at > ?)))
     ORDER BY p.created_at DESC, p.id DESC`,
  ).all(wsId, iso(c)) as Array<{ id: string; campaign_id: string; name: string; plan_id: string | null; status: CommitmentState; daily_budget_cents: number; payload: string }>;
  const seen = new Set<string>();
  const commitments: Commitment[] = [];
  const unnormalizable: Unnormalizable[] = [];
  for (const r of rows) {
    if (seen.has(r.campaign_id)) continue; // a campaign counts once, from its latest committed proposal
    seen.add(r.campaign_id);
    const n = normalizeDaily(r.payload, r.daily_budget_cents);
    if (n.ok) commitments.push({ campaignId: r.campaign_id, campaignName: r.name, proposalId: r.id, cents: n.cents, state: r.status, planId: r.plan_id });
    else unnormalizable.push({ campaignId: r.campaign_id, campaignName: r.name, proposalId: r.id, reason: n.reason });
  }
  const committed = commitments.reduce((s, x) => s + x.cents, 0);
  return {
    ceilingCents: ceiling, committedCents: committed,
    availableCents: ceiling === null ? null : Math.max(0, ceiling - committed),
    overLimitCents: ceiling === null ? 0 : Math.max(0, committed - ceiling),
    commitments, unnormalizable,
  };
}

const money = (cents: number) => `${cents}¢`;
const holders = (p: BudgetPosition) => p.commitments.map((x) => `${x.campaignName} ${money(x.cents)}`).join(", ");

/** The explanation shown when a commitment is refused: what was asked, what is held, by which campaigns, what remains. */
export function limitMessage(p: BudgetPosition, requestedCents: number | null): string {
  const ceiling = p.ceilingCents ?? 0;
  const held = p.commitments.length ? ` (${holders(p)})` : "";
  if (requestedCents === null) {
    return `Your daily limit is ${money(ceiling)} but ${money(p.committedCents)} per day is already committed${held}, which is ${money(p.overLimitCents)} over it. Archive or complete a campaign, or raise the limit in My business, before anything else runs.`;
  }
  return `This would commit ${money(requestedCents)} per day. ${money(p.committedCents)} of your ${money(ceiling)} daily limit is already committed${held}, leaving ${money(p.availableCents ?? 0)}.`;
}

export type CommitStage = "propose" | "approve" | "run";

/**
 * The one check every path that can increase committed spend uses. `requestedCents` is the new commitment being proposed or approved; at the "run" stage the
 * proposal is already committed, so it is null and the check is whether the commitments as a whole still fit.
 *
 * It must be called inside the same write-locked transaction as the change it guards (see decideProposal) so two approvals cannot both pass.
 */
export function assertWithinDailyLimit(c: Core, wsId: string, requestedCents: number | null, stage: CommitStage): BudgetPosition {
  const pos = budgetPosition(c, wsId);
  if (pos.ceilingCents === null) return pos; // no Business Brain, so nothing can be proposed anyway
  if (pos.unnormalizable.length) {
    const u = pos.unnormalizable[0]!;
    throw new AppError(409, "budget_not_normalizable", `A budget already committed for "${u.campaignName}" cannot be read as a daily amount (${u.reason}), so the remaining limit cannot be worked out. Have someone review it before anything else is ${stage === "propose" ? "proposed" : stage === "approve" ? "approved" : "run"}.`);
  }
  const total = pos.committedCents + (requestedCents ?? 0);
  if (total > pos.ceilingCents) throw new AppError(422, "daily_budget_limit_exceeded", limitMessage(pos, requestedCents));
  return pos;
}

/** What approving a given daily budget would do to the position, for display. Never throws. */
export function budgetPreview(c: Core, wsId: string, requestedCents: number) {
  const pos = budgetPosition(c, wsId);
  const fits = pos.ceilingCents === null || (pos.unnormalizable.length === 0 && pos.committedCents + requestedCents <= pos.ceilingCents);
  return {
    requestedCents, ceilingCents: pos.ceilingCents, committedCents: pos.committedCents, availableCents: pos.availableCents,
    wouldFit: fits, blocked: pos.unnormalizable.length > 0 ? "budget_not_normalizable" : null,
    holders: pos.commitments.map((x) => ({ campaignId: x.campaignId, name: x.campaignName, cents: x.cents, state: x.state })),
  };
}
