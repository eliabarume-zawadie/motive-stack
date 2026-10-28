import type { Campaign } from "../connector/AdPlatformConnector.js";
import { MetaApiError } from "../connector/meta/errors.js";
import { audit, iso } from "./core.js";
import type { AppContext } from "./context.js";
import { getCampaignRow } from "./campaigns.js";
import { RetryableError } from "./jobs.js";
import { getProposalRow, hashPayload, ProposalPayloadSchema, type ProposalPayload, type ProposalRow } from "./proposals.js";
import { newId, safeError } from "./util.js";
import { syncLifecycle } from "./lifecycle.js";
import { budgetPosition } from "./budgetCommitments.js";
import { liveAccountDenied } from "./metaAccounts.js";
import { approverMayAuthorize } from "./memberships.js";
import { getBrain } from "./workspaces.js";

interface ApprovalRow {
  decision: string;
  decided_by: string;
  approver_kind: string;
  approver_user_id: string | null;
  payload_hash: string;
  campaign_version: number;
  integration_mode: string;
  expires_at: string;
}
interface AttemptRow {
  id: string;
  attempt_no: number;
  dispatched: number;
}

class GateRefusal extends Error {
  constructor(
    readonly reason: string,
    readonly makeStale = false,
  ) {
    super(reason);
  }
}

const setStatus = (c: AppContext, wsId: string, id: string, status: string, error: string | null = null) => {
  c.db.prepare("UPDATE action_proposals SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").run(status, error === null ? null : safeError(error, 300), iso(c), id, wsId);
  const camp = c.db.prepare("SELECT campaign_id FROM action_proposals WHERE id = ? AND workspace_id = ?").get(id, wsId) as { campaign_id: string } | undefined;
  if (camp) syncLifecycle(c, wsId, camp.campaign_id, "system", `proposal ${status}`); // the campaign's lifecycle follows what really happened
};

/**
 * Every precondition for an external write, checked immediately before it happens.
 * Mock approvals can never authorize a live write: the proposal, the approval and the connector must all be the same mode.
 */
function checkGate(c: AppContext, p: ProposalRow): ProposalPayload {
  const campaign = getCampaignRow(c, p.workspace_id, p.campaign_id);
  if (campaign.current_version !== p.campaign_version) throw new GateRefusal("campaign_changed", true);

  const a = c.db.prepare("SELECT * FROM approvals WHERE proposal_id = ? AND workspace_id = ?").get(p.id, p.workspace_id) as ApprovalRow | undefined;
  if (!a || a.decision !== "approve") throw new GateRefusal("no_approval");
  if (a.payload_hash !== p.payload_hash) throw new GateRefusal("approval_mismatch", true);
  if (a.campaign_version !== p.campaign_version) throw new GateRefusal("approval_stale", true);
  if (Date.parse(a.expires_at) <= c.now().getTime()) throw new GateRefusal("approval_expired");

  const payload = ProposalPayloadSchema.parse(JSON.parse(p.payload));
  // Hash the stored JSON itself, not the schema-parsed copy: schema defaults must never change what was approved.
  if (hashPayload(JSON.parse(p.payload)) !== p.payload_hash) throw new GateRefusal("payload_tampered");

  const meta = c.metaFor(p.workspace_id);
  if (meta.mode !== p.integration_mode || meta.mode !== a.integration_mode || meta.mode !== payload.mode) throw new GateRefusal("mode_mismatch");
  // The approver must STILL be allowed to approve, judged now and not when they clicked: a revoked member or a role lowered below
  // admin stops the write. A LIVE write can only rest on a signed-in person: the workspace token and an unverified approver can
  // authorize simulated (mock) actions at most, and a disabled token not even those.
  if (!approverMayAuthorize(c, a, p.workspace_id, meta.mode)) throw new GateRefusal("approver_not_authorized");
  // The account in the approved payload must be one this workspace is authorized for RIGHT NOW, not merely one it once chose.
  if (meta.mode === "live" && liveAccountDenied(c, p.workspace_id, payload.accountId)) throw new GateRefusal("meta_account_not_authorized");
  if (meta.accountId !== payload.accountId) throw new GateRefusal("account_mismatch");

  const brain = getBrain(c, p.workspace_id);
  if (!brain || p.daily_budget_cents > brain.brain.maxDailyBudgetCents) throw new GateRefusal("budget_exceeds_cap");
  // The workspace-wide limit, judged now: everything committed (this proposal included, once) must still fit. This is what catches a limit lowered after approval.
  const pos = budgetPosition(c, p.workspace_id);
  if (pos.unnormalizable.length) throw new GateRefusal("budget_not_normalizable");
  if (pos.ceilingCents !== null && pos.overLimitCents > 0) throw new GateRefusal("daily_budget_limit_exceeded");
  return payload;
}

/**
 * Execute an approved proposal exactly once, safely.
 * - Re-checks authorization right before the write.
 * - Marks the external call as "dispatched" BEFORE sending it, so a crash is distinguishable from a clean failure.
 * - Never re-sends after an unknown outcome: it looks the campaign up by its unique name instead.
 * - Verifies the real platform state (must be PAUSED) before recording success.
 */
export async function executeProposal(c: AppContext, wsId: string, proposalId: string): Promise<void> {
  const p = getProposalRow(c, wsId, proposalId);
  if (p.status === "executing") return resumeInterrupted(c, p);
  if (p.status !== "approved") return; // executed / failed / rejected / stale / needs_review / not yet approved: nothing to do

  let payload: ProposalPayload;
  try {
    payload = checkGate(c, p);
  } catch (e) {
    if (!(e instanceof GateRefusal)) throw e;
    setStatus(c, p.workspace_id, p.id, e.makeStale ? "stale" : "failed", e.reason);
    audit(c, wsId, "system", "execution.refused", "proposal", p.id, { reason: e.reason });
    return;
  }

  // Claim: only one executor may move approved -> executing.
  const claimed = c.db.prepare("UPDATE action_proposals SET status = 'executing', updated_at = ? WHERE id = ? AND workspace_id = ? AND status = 'approved'").run(iso(c), p.id, p.workspace_id);
  if (claimed.changes !== 1) return;

  const attemptNo = (c.db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE proposal_id = ? AND workspace_id = ?").get(p.id, p.workspace_id) as { n: number }).n + 1;
  const attemptId = newId("att");
  c.db
    .prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES (?,?,?,?,'started',0,?)")
    .run(attemptId, wsId, p.id, attemptNo, iso(c));

  const approval = c.db.prepare("SELECT decided_by, expires_at FROM approvals WHERE proposal_id = ? AND workspace_id = ?").get(p.id, p.workspace_id) as { decided_by: string; expires_at: string };
  const meta = c.metaFor(wsId);
  const finishAttempt = (status: string, kind: string | null = null, msg: string | null = null) =>
    c.db.prepare("UPDATE execution_attempts SET status = ?, error_kind = ?, error_message = ?, finished_at = ? WHERE id = ? AND workspace_id = ?").run(status, kind, msg === null ? null : safeError(msg, 300), iso(c), attemptId, wsId);

  try {
    c.db.prepare("UPDATE execution_attempts SET dispatched = 1 WHERE id = ? AND workspace_id = ?").run(attemptId, wsId);
    const created = await meta.connector.createCampaignDraft(
      { workspaceId: wsId, accountId: payload.accountId, name: payload.name, objective: payload.objective },
      { workspaceId: wsId, accountId: payload.accountId, action: "create_campaign_draft", actionVersion: 1, approvedBy: approval.decided_by, expiresAt: approval.expires_at },
    );
    await finalize(c, p, payload, created.id, attemptId);
  } catch (e) {
    if (e instanceof RetryableError) throw e;
    const isMeta = e instanceof MetaApiError;
    const kind = isMeta ? e.kind : "unknown";
    const msg = (e instanceof Error ? e.message : "error").slice(0, 300);

    // Unknown outcome (timeout, lost response, unexpected error after dispatch): reconcile, never re-send.
    if (!isMeta || e.outcomeUnknown) {
      finishAttempt("outcome_unknown", kind, msg);
      await reconcileByName(c, p, payload, attemptId);
      return;
    }
    finishAttempt("failed", kind, msg);
    const retryable = (kind === "transient" || kind === "rate_limit") && attemptNo < c.maxExecutionAttempts;
    if (retryable) {
      setStatus(c, p.workspace_id, p.id, "approved", `${kind}: ${msg}`);
      audit(c, wsId, "system", "execution.retry_scheduled", "proposal", p.id, { attemptNo, kind });
      throw new RetryableError(`${kind}: ${msg}`);
    }
    setStatus(c, p.workspace_id, p.id, "failed", `${kind}: ${msg}`);
    audit(c, wsId, "system", "execution.failed", "proposal", p.id, { attemptNo, kind });
  }
}

/** Read the real state back, verify it is PAUSED, then record the external resource. */
async function finalize(c: AppContext, p: ProposalRow, payload: ProposalPayload, externalId: string, attemptId: string): Promise<void> {
  const meta = c.metaFor(p.workspace_id);
  if (liveAccountDenied(c, p.workspace_id, payload.accountId)) {
    // Authorization was withdrawn after the write was sent. Reading it back would be a call on an account this workspace may no longer use,
    // so a person verifies it instead. The external id is recorded so nothing is lost.
    c.db.prepare("UPDATE execution_attempts SET status = 'outcome_unknown', finished_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), attemptId, p.workspace_id);
    setStatus(c, p.workspace_id, p.id, "needs_review", "meta_account_not_authorized");
    audit(c, p.workspace_id, "system", "execution.refused", "proposal", p.id, { reason: "meta_account_not_authorized", phase: "verify", externalId });
    return;
  }
  const actual = await meta.connector.getCampaignStatus(externalId);
  if (actual.status !== "PAUSED" || actual.name !== payload.name) {
    c.db.prepare("UPDATE execution_attempts SET status = 'failed', error_kind = 'verification_failed', finished_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), attemptId, p.workspace_id);
    setStatus(c, p.workspace_id, p.id, "needs_review", `verification_failed: platform reports status=${actual.status}`);
    audit(c, p.workspace_id, "system", "execution.verification_failed", "proposal", p.id, { externalId, status: actual.status });
    return;
  }
  c.db.transaction(() => {
    c.db
      .prepare(
        `INSERT INTO external_resources (id, workspace_id, platform, kind, external_id, proposal_id, campaign_id, verified_state, verified_at, simulated)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(newId("ext"), p.workspace_id, "meta", "campaign", externalId, p.id, p.campaign_id, actual.status, iso(c), meta.mode === "mock" ? 1 : 0);
    c.db.prepare("UPDATE execution_attempts SET status = 'succeeded', finished_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), attemptId, p.workspace_id);
    c.db.prepare("UPDATE campaigns SET status = 'launched_paused' WHERE id = ? AND workspace_id = ?").run(p.campaign_id, p.workspace_id);
    setStatus(c, p.workspace_id, p.id, "executed");
    audit(c, p.workspace_id, "system", "execution.succeeded", "proposal", p.id, { externalId, verifiedState: actual.status, simulated: meta.mode === "mock" });
  })();
}

/** Find the campaign by its unique, deterministic name. Exactly one match completes; anything else needs a human. */
async function reconcileByName(c: AppContext, p: ProposalRow, payload: ProposalPayload, attemptId: string): Promise<void> {
  const meta = c.metaFor(p.workspace_id);
  if (liveAccountDenied(c, p.workspace_id, payload.accountId)) {
    setStatus(c, p.workspace_id, p.id, "needs_review", "meta_account_not_authorized");
    audit(c, p.workspace_id, "system", "execution.refused", "proposal", p.id, { reason: "meta_account_not_authorized", phase: "reconcile" });
    return;
  }
  let matches: Campaign[] = [];
  try {
    matches = (await meta.connector.listCampaigns(payload.accountId)).filter((x) => x.name === payload.name);
  } catch {
    // Could not even look: leave it for a human rather than guess.
  }
  if (matches.length === 1 && matches[0]) {
    audit(c, p.workspace_id, "system", "execution.reconciled", "proposal", p.id, { externalId: matches[0].id });
    await finalize(c, p, payload, matches[0].id, attemptId);
    return;
  }
  const why = matches.length > 1 ? "duplicate_external_campaigns" : "outcome_unknown";
  setStatus(c, p.workspace_id, p.id, "needs_review", why);
  audit(c, p.workspace_id, "system", "execution.needs_review", "proposal", p.id, { reason: why, matches: matches.length });
}

/** After a crash: if the call was never dispatched it is safe to run again; otherwise reconcile by name. */
async function resumeInterrupted(c: AppContext, p: ProposalRow): Promise<void> {
  const att = c.db.prepare("SELECT id, attempt_no, dispatched FROM execution_attempts WHERE proposal_id = ? AND workspace_id = ? ORDER BY attempt_no DESC LIMIT 1").get(p.id, p.workspace_id) as AttemptRow | undefined;
  if (!att || att.dispatched === 0) {
    if (att) c.db.prepare("UPDATE execution_attempts SET status = 'failed', error_kind = 'interrupted', finished_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), att.id, p.workspace_id);
    setStatus(c, p.workspace_id, p.id, "approved", "interrupted_before_dispatch");
    audit(c, p.workspace_id, "system", "execution.resumed", "proposal", p.id, { dispatched: false });
    return executeProposal(c, p.workspace_id, p.id);
  }
  c.db.prepare("UPDATE execution_attempts SET status = 'outcome_unknown', finished_at = ? WHERE id = ? AND workspace_id = ?").run(iso(c), att.id, p.workspace_id);
  // Reconciling talks to the platform, so it needs the same standing as the original write. If the approver no longer qualifies, the
  // connector is not touched at all and a person reviews it: the write may or may not have happened, and nothing here may guess.
  const approval = c.db.prepare("SELECT approver_kind, approver_user_id FROM approvals WHERE proposal_id = ? AND workspace_id = ?").get(p.id, p.workspace_id) as { approver_kind: string; approver_user_id: string | null } | undefined;
  if (!approverMayAuthorize(c, approval, p.workspace_id, c.metaFor(p.workspace_id).mode)) {
    setStatus(c, p.workspace_id, p.id, "needs_review", "approver_not_authorized");
    audit(c, p.workspace_id, "system", "execution.refused", "proposal", p.id, { reason: "approver_not_authorized", phase: "reconcile" });
    return;
  }
  const payload = ProposalPayloadSchema.parse(JSON.parse(p.payload));
  if (liveAccountDenied(c, p.workspace_id, payload.accountId)) {
    setStatus(c, p.workspace_id, p.id, "needs_review", "meta_account_not_authorized");
    audit(c, p.workspace_id, "system", "execution.refused", "proposal", p.id, { reason: "meta_account_not_authorized", phase: "reconcile" });
    return;
  }
  audit(c, p.workspace_id, "system", "execution.resumed", "proposal", p.id, { dispatched: true });
  await reconcileByName(c, p, payload, att.id);
}
