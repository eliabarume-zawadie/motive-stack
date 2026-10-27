import { z } from "zod";
import { audit, iso } from "./core.js";
import type { AppContext } from "./context.js";
import { AppError, conflict, forbidden, notFound } from "./errors.js";
import { enqueueJob } from "./jobs.js";
import { getCampaignRecord, getCampaignRow } from "./campaigns.js";
import { newId, sha256, stableStringify } from "./util.js";
import { getBrain } from "./workspaces.js";
import { approvalGateViolations, specialAdCategoryHints } from "../domain/briefRules.js";
import type { IntegrationMode } from "../integrations/mode.js";

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export const ProposalPayloadSchema = z.object({
  action: z.literal("create_campaign_draft"),
  accountId: z.string().regex(/^act_\d+$/),
  name: z.string().min(1),
  objective: z.literal("OUTCOME_LEADS"),
  /** Planned budget for the ad set that comes later. It is NOT sent when creating the campaign. */
  plannedDailyBudgetCents: z.number().int().positive(),
  campaignVersion: z.number().int().positive(),
  mode: z.enum(["mock", "live"]),
  /** The owner's hard ceiling at proposal time. plannedDailyBudgetCents is the proposed STARTING budget, never the ceiling by default. */
  budgetCeilingCents: z.number().int().positive().optional(),
  /** Reasons a human must review before this is approved. Non-empty requires an explicit acknowledgement. */
  reviewFlags: z.array(z.string()).default([]),
});
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;

export interface ProposalRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  campaign_version: number;
  type: string;
  payload: string;
  payload_hash: string;
  daily_budget_cents: number;
  integration_mode: IntegrationMode;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export const hashPayload = (p: unknown): string => sha256(stableStringify(p));

export function getProposalRow(c: { db: AppContext["db"] }, wsId: string, id: string): ProposalRow {
  const r = c.db.prepare("SELECT * FROM action_proposals WHERE id = ? AND workspace_id = ?").get(id, wsId) as ProposalRow | undefined;
  if (!r) throw notFound("Proposal");
  return r;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Propose creating a PAUSED campaign draft on the ad platform. Nothing external happens here.
 * Blocked outright if the planned budget exceeds the workspace's cap.
 */
/**
 * The last check before a human is asked to approve: the CURRENT version of the brief (which may have been edited by a
 * person after generation) must still pass the claim, length and budget rules. A failure blocks the proposal and names
 * each field and failure type; nothing is sent anywhere.
 */
function assertBriefPassesGate(c: AppContext, wsId: string, campaignId: string, actor: string, phase: "proposal" | "approval"): void {
  const rec = getCampaignRecord(c, wsId, campaignId);
  const stored = getBrain(c, wsId);
  if (!stored) throw conflict("brain_required", "Business Brain is required");
  const bad = approvalGateViolations(rec.brief, stored.brain, { asOf: c.now() });
  if (bad.length === 0) return;
  audit(c, wsId, actor, "proposal.blocked", "campaign", campaignId, { reason: "brief_validation_failed", phase, codes: bad.map((v) => v.code) });
  throw new AppError(409, "brief_validation_failed", `This brief cannot be approved yet: ${bad.map((v) => `[${v.code}] ${v.path.join(".")}: ${v.message}`).join(" | ")}`);
}

export function createProposal(c: AppContext, wsId: string, campaignId: string, actor = "owner"): ProposalRow {
  const row = getCampaignRow(c, wsId, campaignId);
  if (row.status !== "draft") throw conflict("already_launched", "This campaign already has an external draft");
  const rec = getCampaignRecord(c, wsId, campaignId);
  const stored = getBrain(c, wsId);
  if (!stored) throw conflict("brain_required", "Business Brain is required");

  if (rec.brief.dailyBudgetCents > stored.brain.maxDailyBudgetCents) {
    audit(c, wsId, actor, "proposal.blocked", "campaign", campaignId, { reason: "budget_exceeds_cap", planned: rec.brief.dailyBudgetCents, cap: stored.brain.maxDailyBudgetCents });
    throw new AppError(422, "budget_exceeds_cap", `Planned daily budget (${rec.brief.dailyBudgetCents}¢) exceeds the cap (${stored.brain.maxDailyBudgetCents}¢)`);
  }

  // The integration declares no special ad category (it always sends an empty list), so a campaign that may need one
  // must be handled by a person instead of being proposed for automated creation.
  const cats = specialAdCategoryHints(stored.brain);
  if (cats.length > 0) {
    audit(c, wsId, actor, "proposal.blocked", "campaign", campaignId, { reason: "special_ad_category_unsupported", categories: cats });
    throw new AppError(409, "special_ad_category_unsupported", `This business may fall under a Meta special ad category (${cats.join(", ")}). The integration cannot declare special ad categories, so MotiveStack will not create this campaign automatically.`);
  }

  // A question marked blocking means launch must wait for the owner's answer.
  const blocking = rec.brief.openQuestions.filter((q) => q.blocking);
  if (blocking.length > 0) {
    audit(c, wsId, actor, "proposal.blocked", "campaign", campaignId, { reason: "blocking_questions", count: blocking.length });
    throw new AppError(409, "blocking_questions", `Answer these before launch: ${blocking.map((q) => q.question).join(" | ")}`);
  }

  assertBriefPassesGate(c, wsId, campaignId, actor, "proposal");

  const open = c.db
    .prepare("SELECT id FROM action_proposals WHERE campaign_id = ? AND workspace_id = ? AND status IN ('proposed','approved','executing')")
    .get(campaignId, wsId);
  if (open) throw conflict("proposal_exists", "There is already an open proposal for this campaign");

  const meta = c.metaFor(wsId);
  if (!meta.accountId) {
    if (meta.configuredAccountId) throw conflict("meta_account_not_authorized", "The workspace's Meta ad account is not currently authorized; an owner must authorize it before proposing a live action");
    throw conflict("meta_account_required", "Set the workspace's Meta ad account before proposing a live action");
  }

  const id = newId("prp");
  const payload: ProposalPayload = {
    action: "create_campaign_draft",
    accountId: meta.accountId,
    name: `MS-${id.slice(-8)}-${slug(rec.name)}`,
    objective: "OUTCOME_LEADS",
    plannedDailyBudgetCents: rec.brief.dailyBudgetCents,
    campaignVersion: rec.currentVersion,
    mode: meta.mode,
    budgetCeilingCents: stored.brain.maxDailyBudgetCents,
    reviewFlags: rec.brief.reviewFlags,
  };
  const at = iso(c);
  c.db
    .prepare(
      `INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?)`,
    )
    .run(id, wsId, campaignId, rec.currentVersion, payload.action, JSON.stringify(payload), hashPayload(payload), rec.brief.dailyBudgetCents, meta.mode, at, at);
  audit(c, wsId, actor, "proposal.created", "proposal", id, { campaignId, version: rec.currentVersion, mode: meta.mode });
  return getProposalRow(c, wsId, id);
}

/** Record an explicit human decision. Approving queues execution; it does not execute inline. */
export function decideProposal(
  c: AppContext,
  wsId: string,
  proposalId: string,
  decision: "approve" | "reject",
  by: {
    /** The server-derived actor label ("user:<id>" or "workspace-token:<id>"). Trusted callers (tests, system) may pass any label; it is then recorded as 'unverified'. */
    decidedBy: string;
    /** Who signed this decision. Absent = 'unverified'. The executor refuses to rely on an unverified approver for a live write. */
    approver?: { kind: "user"; userId: string } | { kind: "legacy_token" };
    claimedLabel?: string;
    reason?: string;
    acknowledgedReview?: boolean;
  },
): ProposalRow {
  const p = getProposalRow(c, wsId, proposalId);
  if (p.status === "stale") throw conflict("stale", "The campaign changed after this proposal; create a new proposal");
  if (p.status !== "proposed") throw conflict("not_pending", `Proposal is ${p.status}, not awaiting a decision`);

  // A proposal marked "needs review" cannot be approved without the reviewer explicitly saying they read the reasons.
  if (decision === "approve") {
    const flags = ProposalPayloadSchema.parse(JSON.parse(p.payload)).reviewFlags;
    if (flags.length > 0 && !by.acknowledgedReview) {
      throw conflict("review_required", `This proposal needs review before approval: ${flags.join(" | ")}. Approve again with acknowledgedReview set to confirm you read this.`);
    }
  }

  const campaign = getCampaignRow(c, wsId, p.campaign_id);
  const mode = c.metaFor(wsId).mode;
  if (campaign.current_version !== p.campaign_version || mode !== p.integration_mode) {
    c.db.prepare("UPDATE action_proposals SET status = 'stale', updated_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), p.id, wsId);
    audit(c, wsId, by.decidedBy, "proposal.stale", "proposal", p.id, { campaignChanged: campaign.current_version !== p.campaign_version, modeChanged: mode !== p.integration_mode });
    throw conflict("stale", "The proposal is out of date; create a new proposal");
  }

  // A live (real, external) action can only be approved by a signed-in person; the executor enforces the same rule again at execution time.
  if (decision === "approve" && mode === "live" && by.approver?.kind !== "user") {
    throw forbidden("live_requires_signed_in_approver", "A real (live) action must be approved by a signed-in person; the workspace token can only approve simulated actions");
  }

  if (decision === "approve") assertBriefPassesGate(c, wsId, p.campaign_id, by.decidedBy, "approval");

  const at = iso(c);
  c.db.transaction(() => {
    c.db
      .prepare(
        `INSERT INTO approvals (id, workspace_id, proposal_id, decision, decided_by, payload_hash, campaign_version, integration_mode, reason, decided_at, expires_at, claimed_label, approver_kind, approver_user_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(newId("apr"), wsId, p.id, decision, by.decidedBy, p.payload_hash, p.campaign_version, mode, by.reason ?? null, at, new Date(c.now().getTime() + APPROVAL_TTL_MS).toISOString(), by.claimedLabel ?? null, by.approver?.kind ?? "unverified", by.approver?.kind === "user" ? by.approver.userId : null);
    c.db.prepare("UPDATE action_proposals SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(decision === "approve" ? "approved" : "rejected", at, p.id, wsId);
    audit(c, wsId, by.decidedBy, decision === "approve" ? "proposal.approved" : "proposal.rejected", "proposal", p.id, { mode, reason: by.reason ?? null, ...(by.claimedLabel ? { claimedLabel: by.claimedLabel, claimedLabelVerified: false } : {}) });
    if (decision === "approve") enqueueJob(c, wsId, "execute_proposal", { proposalId: p.id }, `exec:${p.id}`);
  })();
  return getProposalRow(c, wsId, p.id);
}

export function listProposals(c: { db: AppContext["db"] }, wsId: string, campaignId?: string): ProposalRow[] {
  return campaignId
    ? (c.db.prepare("SELECT * FROM action_proposals WHERE workspace_id = ? AND campaign_id = ? ORDER BY created_at DESC, id").all(wsId, campaignId) as ProposalRow[])
    : (c.db.prepare("SELECT * FROM action_proposals WHERE workspace_id = ? ORDER BY created_at DESC, id").all(wsId) as ProposalRow[]);
}
