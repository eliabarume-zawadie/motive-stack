import { z } from "zod";
import { audit, iso } from "./core.js";
import type { AppContext } from "./context.js";
import { AppError, conflict, forbidden, notFound } from "./errors.js";
import { enqueueJob } from "./jobs.js";
import { approverMayAuthorize } from "./memberships.js";
import { syncLifecycle } from "./lifecycle.js";
import { planGate } from "./planBudget.js";
import { assertWithinDailyLimit, budgetPreview, limitMessage, budgetPosition } from "./budgetCommitments.js";
import { separationOutcome, type SeparationOutcome } from "./workspacePolicy.js";
import { getCampaignRecord, getCampaignRow } from "./campaigns.js";
import { closeWorkItemsFor } from "./teamOps.js";
import { approvedCreativesFor, assertCreativesStillApproved } from "./creatives.js";
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
  /** Every budget in this release is per day. The marker lets a future non-daily budget be recognised and refused rather than counted as if it were daily. */
  budgetBasis: z.literal("daily").default("daily"),
  campaignVersion: z.number().int().positive(),
  mode: z.enum(["mock", "live"]),
  /** The owner's hard ceiling at proposal time. plannedDailyBudgetCents is the proposed STARTING budget, never the ceiling by default. */
  budgetCeilingCents: z.number().int().positive().optional(),
  /** Reasons a human must review before this is approved. Non-empty requires an explicit acknowledgement. */
  reviewFlags: z.array(z.string()).default([]),
  /** The approved creative versions (and exact picture hashes) this proposal covers. Absent when the campaign has none. NOTHING is sent to the platform with them in this release. */
  creatives: z.array(z.object({ creativeId: z.string(), version: z.number().int().positive(), pictures: z.array(z.object({ ratio: z.string(), assetId: z.string(), assetVersion: z.number().int().positive(), sha256: z.string() })) })).optional(),
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
  /** Who proposed it (the actor label) and what kind of caller that was. NULL for proposals older than this was recorded and absent from the audit trail. */
  proposed_by: string | null;
  proposed_by_kind: "user" | "legacy_token" | "unverified" | null;
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

  assertWithinDailyLimit(c, wsId, rec.brief.dailyBudgetCents, "propose"); // the workspace-wide daily limit, with everything already approved or running counted once
  planGate(c, wsId, campaignId, actor); // a campaign in a plan also needs the plan's total, its own share and a current budget review

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

  const creativeRefs = approvedCreativesFor(c, wsId, campaignId);
  const id = newId("prp");
  const payload: ProposalPayload = {
    action: "create_campaign_draft",
    accountId: meta.accountId,
    name: `MS-${id.slice(-8)}-${slug(rec.name)}`,
    objective: "OUTCOME_LEADS",
    plannedDailyBudgetCents: rec.brief.dailyBudgetCents,
    budgetBasis: "daily",
    campaignVersion: rec.currentVersion,
    mode: meta.mode,
    budgetCeilingCents: stored.brain.maxDailyBudgetCents,
    reviewFlags: rec.brief.reviewFlags,
    ...(creativeRefs.length ? { creatives: creativeRefs } : {}),
  };
  const at = iso(c);
  c.db
    .prepare(
      `INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at, proposed_by, proposed_by_kind)
       VALUES (?,?,?,?,?,?,?,?,?,'proposed',?,?,?,?)`,
    )
    .run(id, wsId, campaignId, rec.currentVersion, payload.action, JSON.stringify(payload), hashPayload(payload), rec.brief.dailyBudgetCents, meta.mode, at, at, actor, kindOfActor(actor));
  audit(c, wsId, actor, "proposal.created", "proposal", id, { campaignId, version: rec.currentVersion, mode: meta.mode });
  syncLifecycle(c, wsId, campaignId, actor, "proposed");
  return getProposalRow(c, wsId, id);
}

/** The kind of caller behind an actor label. Labels are derived on the server (user:<id>, workspace-token:<id>); anything else was supplied by trusted code. */
export const kindOfActor = (label: string): "user" | "legacy_token" | "unverified" => (label.startsWith("user:") ? "user" : label.startsWith("workspace-token:") ? "legacy_token" : "unverified");

/**
 * Separation of duties. With the workspace policy on (the default) the proposer of an action may not approve it. The decision is made on server-derived
 * identities only. One honest exception: every caller using the single workspace token is the SAME identity, so the token cannot be told apart from itself.
 * There the approval is allowed but recorded as "not_enforceable_token_mode", never as separation. Where the proposer is unknown the rule cannot be proven
 * for a person, so it refuses.
 */
export function checkSeparation(c: AppContext, wsId: string, p: ProposalRow, by: { decidedBy: string; approver?: { kind: string } }): SeparationOutcome {
  return separationOutcome(c, wsId, p.proposed_by, by, "proposal");
}

/** Record an explicit human decision. Approving does NOT run anything: it only records the approval. Running is a separate step (executeProposal). */
const isBusy = (e: unknown): boolean => typeof (e as { code?: unknown })?.code === "string" && (e as { code: string }).code.startsWith("SQLITE_BUSY");

/** Record an explicit decision. If another connection holds the database write lock the answer is "busy, try again", never a guess made on stale numbers. */
export function decideProposal(c: AppContext, wsId: string, proposalId: string, decision: "approve" | "reject", by: Parameters<typeof decideProposalNow>[4]): ProposalRow {
  try { return decideProposalNow(c, wsId, proposalId, decision, by); } catch (e) {
    if (isBusy(e)) throw new AppError(503, "busy", "Another approval is being recorded; try again in a moment");
    throw e;
  }
}

function decideProposalNow(
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
    const parsed = ProposalPayloadSchema.parse(JSON.parse(p.payload));
    assertCreativesStillApproved(c, wsId, parsed.creatives); // the approval must cover pictures that are still approved and unchanged
    const flags = parsed.reviewFlags;
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
  const separation: SeparationOutcome | null = decision === "approve" ? checkSeparation(c, wsId, p, by) : null;

  const at = iso(c);
  const write = c.db.transaction(() => {
    if (decision === "approve") {
      // Inside the write lock: re-read the proposal and count what is committed RIGHT NOW. Two approvals cannot both pass on stale numbers, because the second
      // cannot start its transaction until the first has committed, and then it sees the first's commitment.
      const fresh = getProposalRow(c, wsId, proposalId);
      if (fresh.status !== "proposed") throw conflict("not_pending", `Proposal is ${fresh.status}, not awaiting a decision`);
      assertWithinDailyLimit(c, wsId, fresh.daily_budget_cents, "approve");
    }
    c.db
      .prepare(
        `INSERT INTO approvals (id, workspace_id, proposal_id, decision, decided_by, payload_hash, campaign_version, integration_mode, reason, decided_at, expires_at, claimed_label, approver_kind, approver_user_id, separation)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(newId("apr"), wsId, p.id, decision, by.decidedBy, p.payload_hash, p.campaign_version, mode, by.reason ?? null, at, new Date(c.now().getTime() + APPROVAL_TTL_MS).toISOString(), by.claimedLabel ?? null, by.approver?.kind ?? "unverified", by.approver?.kind === "user" ? by.approver.userId : null, separation);
    c.db.prepare("UPDATE action_proposals SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(decision === "approve" ? "approved" : "rejected", at, p.id, wsId);
    audit(c, wsId, by.decidedBy, decision === "approve" ? "proposal.approved" : "proposal.rejected", "proposal", p.id, { mode, reason: by.reason ?? null, ...(separation ? { separation, separationEnforced: separation === "enforced" } : {}), ...(by.claimedLabel ? { claimedLabel: by.claimedLabel, claimedLabelVerified: false } : {}) });
  });
  try {
    write.immediate(); // BEGIN IMMEDIATE: take the database write lock before reading anything
  } catch (e) {
    if (e instanceof AppError && (e.code === "daily_budget_limit_exceeded" || e.code === "budget_not_normalizable")) audit(c, wsId, by.decidedBy, "proposal.approval_blocked", "proposal", p.id, { reason: e.code, requestedCents: p.daily_budget_cents });
    if (typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code.startsWith("SQLITE_BUSY")) throw new AppError(503, "busy", "Another approval is being recorded; try again in a moment");
    throw e;
  }
  closeWorkItemsFor(c, wsId, { kind: "approval", proposalId: p.id }, decision === "approve" ? "closed_by_approval" : "closed_by_rejection"); // the task that was waiting for this decision is done
  syncLifecycle(c, wsId, p.campaign_id, by.decidedBy, decision === "approve" ? "approved" : "rejected");
  return getProposalRow(c, wsId, p.id);
}

/**
 * Run an APPROVED action. This is the only thing that queues execution (approval alone never does), it needs its own permission, and it is idempotent: asking
 * twice queues one job. The executor still re-checks everything before doing anything (approval still valid, version and payload unchanged, approver still
 * allowed, account authorized, mode). Live (external) execution stays off unless the server is configured for it, exactly as before.
 */
export function requestExecution(c: AppContext, wsId: string, proposalId: string, actor: string): ProposalRow {
  const p = getProposalRow(c, wsId, proposalId);
  if (p.status === "executing" || p.status === "executed") return p; // already running or done: nothing more to queue
  if (p.status !== "approved") throw conflict("not_approved", p.status === "proposed" ? "This proposal has not been approved yet" : `This proposal is ${p.status}, so it cannot be run`);
  const approval = c.db.prepare("SELECT decision, expires_at, approver_kind, approver_user_id FROM approvals WHERE proposal_id = ? AND workspace_id = ? ORDER BY decided_at DESC LIMIT 1").get(p.id, wsId) as
    { decision: string; expires_at: string; approver_kind: string; approver_user_id: string | null } | undefined;
  if (!approval || approval.decision !== "approve") throw conflict("not_approved", "There is no approval to run");
  if (Date.parse(approval.expires_at) <= c.now().getTime()) throw conflict("approval_expired", "The approval has expired; create a new proposal");
  if (!approverMayAuthorize(c, approval, wsId, p.integration_mode)) throw forbidden("approver_not_valid", "The approval no longer counts (the approver's access changed). Create a new proposal.");
  assertCreativesStillApproved(c, wsId, ProposalPayloadSchema.parse(JSON.parse(p.payload)).creatives);
  const pos = budgetPosition(c, wsId);
  if (pos.ceilingCents !== null && pos.overLimitCents > 0) throw new AppError(422, "daily_budget_limit_exceeded", limitMessage(pos, null));
  if (pos.unnormalizable.length) throw new AppError(409, "budget_not_normalizable", "A committed budget could not be read as a daily amount, so nothing can run until it has been reviewed");
  const queued = enqueueJob(c, wsId, "execute_proposal", { proposalId: p.id }, `exec:${p.id}`);
  audit(c, wsId, actor, "proposal.execution_requested", "proposal", p.id, { mode: p.integration_mode, queued });
  closeWorkItemsFor(c, wsId, { kind: "run", proposalId: p.id }, "closed_by_run_request");
  syncLifecycle(c, wsId, p.campaign_id, actor, "run requested");
  return getProposalRow(c, wsId, p.id);
}

export function listProposals(c: { db: AppContext["db"] }, wsId: string, campaignId?: string): ProposalRow[] {
  return campaignId
    ? (c.db.prepare("SELECT * FROM action_proposals WHERE workspace_id = ? AND campaign_id = ? ORDER BY created_at DESC, id").all(wsId, campaignId) as ProposalRow[])
    : (c.db.prepare("SELECT * FROM action_proposals WHERE workspace_id = ? ORDER BY created_at DESC, id").all(wsId) as ProposalRow[]);
}
