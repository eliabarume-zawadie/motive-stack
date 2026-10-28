import { describe, expect, it } from "vitest";
import { updateBrief, getCampaignRow } from "../src/app/campaigns.js";
import { executeProposal } from "../src/app/executor.js";
import { claimJob, enqueueJob, recoverOrphanedJobs } from "../src/app/jobs.js";
import { ingestLeadEvent } from "../src/app/leads.js";
import { createProposal, decideProposal, getProposalRow, requestExecution } from "../src/app/proposals.js";
import { proposalView, leadsView } from "../src/app/views.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { BRAIN, draftCampaign, makeApp, type App } from "./fixtures.js";

const simCampaigns = (a: App, wsId: string) =>
  a.ctx.db.prepare("SELECT id, name, status FROM sim_meta_campaigns WHERE workspace_id = ?").all(wsId) as Array<{ id: string; name: string; status: string }>;
const contacts = (a: App, wsId: string) => a.ctx.db.prepare("SELECT * FROM sim_crm_contacts WHERE workspace_id = ?").all(wsId) as Array<{ id: string }>;
const status = (a: App, ws: string, id: string) => getProposalRow(a.ctx, ws, id).status;

/** Propose + approve, leaving execution to the worker. */
async function approved(a: App) {
  const d = await draftCampaign(a);
  const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
  decideProposal(a.ctx, d.ws.id, p.id, "approve", { decidedBy: "elia" });
  requestExecution(a.ctx, d.ws.id, p.id, "test");
  return { ...d, p };
}

describe("happy path: brief -> proposal -> approval -> paused simulated campaign -> lead -> CRM", () => {
  it("runs end to end and records verified, simulated state", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
    expect(p.status).toBe("proposed");
    expect(simCampaigns(a, d.ws.id)).toHaveLength(0); // proposing writes nothing externally

    decideProposal(a.ctx, d.ws.id, p.id, "approve", { decidedBy: "elia" });
    requestExecution(a.ctx, d.ws.id, p.id, "test");
    await a.worker.runUntilIdle();

    const v = proposalView(a.ctx, d.ws.id, getProposalRow(a.ctx, d.ws.id, p.id));
    expect(v.status).toBe("executed");
    expect(v.externalResource).toMatchObject({ platform: "meta", verifiedState: "PAUSED", simulated: true });
    expect(simCampaigns(a, d.ws.id)).toEqual([expect.objectContaining({ status: "PAUSED" })]);
    expect(getCampaignRow(a.ctx, d.ws.id, d.campaign.id).status).toBe("launched_paused");

    const r = ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Pat", email: "pat@example.com", eventId: "e1" });
    expect(r.duplicate).toBe(false);
    await a.worker.runUntilIdle();
    expect(leadsView(a.ctx, d.ws.id)).toEqual([expect.objectContaining({ crmStatus: "synced", simulated: true, crmContactCreated: true })]);
    expect(contacts(a, d.ws.id)).toHaveLength(1);
  });
});

describe("approval is required", () => {
  it("does nothing for a proposal that was never approved", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
    await executeProposal(a.ctx, d.ws.id, p.id);
    expect(status(a, d.ws.id, p.id)).toBe("proposed");
    expect(simCampaigns(a, d.ws.id)).toHaveLength(0);
  });

  it("a rejected proposal never executes and cannot be approved later", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
    decideProposal(a.ctx, d.ws.id, p.id, "reject", { decidedBy: "elia", reason: "not now" });
    await a.worker.runUntilIdle();
    expect(status(a, d.ws.id, p.id)).toBe("rejected");
    expect(simCampaigns(a, d.ws.id)).toHaveLength(0);
    expect(() => decideProposal(a.ctx, d.ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/not awaiting/);
  });

  it("refuses a forged approval whose hash does not match the proposal", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
    a.ctx.db.prepare("UPDATE action_proposals SET status = 'approved' WHERE id = ?").run(p.id);
    a.ctx.db
      .prepare("INSERT INTO approvals (id, workspace_id, proposal_id, decision, decided_by, payload_hash, campaign_version, integration_mode, decided_at, expires_at) VALUES ('x',?,?,'approve','mallory','WRONG',1,'mock',?,?)")
      .run(d.ws.id, p.id, "2026-10-15T12:00:00Z", "2026-10-16T12:00:00Z");
    await executeProposal(a.ctx, d.ws.id, p.id);
    expect(simCampaigns(a, d.ws.id)).toHaveLength(0);
    expect(status(a, d.ws.id, p.id)).toBe("stale");
  });

  it("an expired approval cannot be used", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.setNow("2026-10-16T13:00:00Z"); // > 24h later
    await a.worker.runUntilIdle();
    expect(getProposalRow(a.ctx, ws.id, p.id)).toMatchObject({ status: "failed", last_error: "approval_expired" });
    expect(simCampaigns(a, ws.id)).toHaveLength(0);
  });

  it("a MOCK approval can never authorize a LIVE write (mode mismatch)", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.db.prepare("UPDATE action_proposals SET integration_mode = 'live' WHERE id = ?").run(p.id); // tampering / mode drift
    await a.worker.runUntilIdle();
    expect(getProposalRow(a.ctx, ws.id, p.id)).toMatchObject({ status: "failed", last_error: "mode_mismatch" });
    expect(simCampaigns(a, ws.id)).toHaveLength(0);
  });
});

describe("stale approvals", () => {
  it("editing the campaign makes an open proposal stale and blocks approval", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
    updateBrief(a.ctx, d.ws.id, d.campaign.id, { ...d.campaign.brief, name: "Changed" });
    expect(status(a, d.ws.id, p.id)).toBe("stale");
    expect(() => decideProposal(a.ctx, d.ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/changed after/);
  });

  it("editing after approval but before execution prevents execution", async () => {
    const a = makeApp();
    const { ws, campaign, p } = await approved(a);
    updateBrief(a.ctx, ws.id, campaign.id, { ...campaign.brief, name: "Changed after approval" });
    await a.worker.runUntilIdle();
    expect(status(a, ws.id, p.id)).toBe("stale");
    expect(simCampaigns(a, ws.id)).toHaveLength(0);
  });
});

describe("budget limits", () => {
  it("a model that picks a budget above the owner's ceiling is rejected at generation: no campaign is stored", async () => {
    const a = makeApp("over_budget");
    await expect(draftCampaign(a)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(a.ctx.db.prepare("SELECT COUNT(*) n FROM campaigns").get()).toEqual({ n: 0 });
  });

  it("defense in depth: lowering the ceiling after generation still blocks the proposal, with no proposal row", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    putBrain(a.ctx, d.ws.id, { ...BRAIN, maxDailyBudgetCents: 300 }); // the starting budget is now above the ceiling
    expect(() => createProposal(a.ctx, d.ws.id, d.campaign.id)).toThrow(/exceeds the cap/);
    expect(a.ctx.db.prepare("SELECT COUNT(*) n FROM action_proposals").get()).toEqual({ n: 0 });
  });

  it("re-checks the cap at execution: lowering it after approval blocks the write", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    putBrain(a.ctx, ws.id, { ...BRAIN, maxDailyBudgetCents: 100 });
    await a.worker.runUntilIdle();
    expect(getProposalRow(a.ctx, ws.id, p.id)).toMatchObject({ status: "failed", last_error: "budget_exceeds_cap" });
    expect(simCampaigns(a, ws.id)).toHaveLength(0);
  });
});

describe("paused-only", () => {
  it("flags for review if the platform reports anything other than PAUSED", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.faults.meta.createActive = true;
    await a.worker.runUntilIdle();
    expect(getProposalRow(a.ctx, ws.id, p.id).status).toBe("needs_review");
    expect(a.ctx.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 0 });
  });
});

describe("idempotency, retries and recovery", () => {
  it("running the executor twice creates exactly one external campaign", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    await executeProposal(a.ctx, ws.id, p.id);
    await executeProposal(a.ctx, ws.id, p.id);
    expect(simCampaigns(a, ws.id)).toHaveLength(1);
    expect(enqueueJob(a.ctx, ws.id, "execute_proposal", { proposalId: p.id }, `exec:${p.id}`)).toBe(false); // deduped
  });

  it("retries transient failures with a fresh attempt each time, then succeeds once", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.faults.meta.transientFailuresRemaining = 2;
    await a.worker.runUntilIdle();
    const v = proposalView(a.ctx, ws.id, getProposalRow(a.ctx, ws.id, p.id));
    expect(v.status).toBe("executed");
    expect(v.attempts).toHaveLength(3);
    expect(simCampaigns(a, ws.id)).toHaveLength(1);
  });

  it("gives up after the attempt limit and creates nothing", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.faults.meta.transientFailuresRemaining = 99;
    await a.worker.runUntilIdle();
    expect(status(a, ws.id, p.id)).toBe("failed");
    expect(simCampaigns(a, ws.id)).toHaveLength(0);
  });

  it("does not retry a permission failure", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.faults.meta.failKind = "permission";
    await a.worker.runUntilIdle();
    expect(proposalView(a.ctx, ws.id, getProposalRow(a.ctx, ws.id, p.id))).toMatchObject({ status: "failed", attempts: [expect.objectContaining({ error_kind: "permission" })] });
  });

  it("after a timeout that actually succeeded, reconciles by name and never creates a duplicate", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.faults.meta.timeoutAfterSuccess = true;
    await a.worker.runUntilIdle();
    expect(status(a, ws.id, p.id)).toBe("executed");
    expect(simCampaigns(a, ws.id)).toHaveLength(1);
  });

  it("crash after dispatch: reconciles to the existing campaign instead of sending again", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    const name = (JSON.parse(p.payload) as { name: string }).name;
    // Simulate: the call went out, the platform created it, then the process died.
    a.ctx.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(p.id);
    a.ctx.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('a1',?,?,1,'started',1,?)").run(ws.id, p.id, "2026-10-15T12:00:00Z");
    a.ctx.db.prepare("INSERT INTO sim_meta_campaigns (id, workspace_id, account_id, name, objective, status, created_at) VALUES ('120300000001',?,?,?,'OUTCOME_LEADS','PAUSED',?)").run(ws.id, "act_9000000001", name, "2026-10-15T12:00:00Z");
    await executeProposal(a.ctx, ws.id, p.id);
    expect(status(a, ws.id, p.id)).toBe("executed");
    expect(simCampaigns(a, ws.id)).toHaveLength(1);
  });

  it("crash after dispatch with nothing found: needs human review, no blind retry", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(p.id);
    a.ctx.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('a1',?,?,1,'started',1,?)").run(ws.id, p.id, "2026-10-15T12:00:00Z");
    await executeProposal(a.ctx, ws.id, p.id);
    expect(status(a, ws.id, p.id)).toBe("needs_review");
    expect(simCampaigns(a, ws.id)).toHaveLength(0);
  });

  it("crash before dispatch: safely resumes and executes once", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    a.ctx.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(p.id);
    a.ctx.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('a1',?,?,1,'started',0,?)").run(ws.id, p.id, "2026-10-15T12:00:00Z");
    await executeProposal(a.ctx, ws.id, p.id);
    expect(status(a, ws.id, p.id)).toBe("executed");
    expect(simCampaigns(a, ws.id)).toHaveLength(1);
  });

  it("worker restart: a job orphaned in 'running' is re-queued and completes", async () => {
    const a = makeApp();
    const { ws, p } = await approved(a);
    expect(claimJob(a.ctx)?.type).toBe("execute_proposal"); // claimed, then the process "dies"
    expect(claimJob(a.ctx)).toBeNull();
    expect(recoverOrphanedJobs(a.ctx)).toBe(1);
    await a.worker.runUntilIdle();
    expect(status(a, ws.id, p.id)).toBe("executed");
    expect(simCampaigns(a, ws.id)).toHaveLength(1);
  });
});

describe("leads", () => {
  async function launched(a: App) {
    const d = await draftCampaign(a);
    const p = createProposal(a.ctx, d.ws.id, d.campaign.id);
    decideProposal(a.ctx, d.ws.id, p.id, "approve", { decidedBy: "elia" });
    requestExecution(a.ctx, d.ws.id, p.id, "test");
    await a.worker.runUntilIdle();
    return d;
  }

  it("refuses leads before the campaign has an external draft", async () => {
    const a = makeApp();
    const d = await draftCampaign(a);
    expect(() => ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "x", email: "x@y.co" })).toThrow(/before injecting/);
  });

  it("a duplicate event id creates no second lead, job, or contact", async () => {
    const a = makeApp();
    const d = await launched(a);
    const lead = { fullName: "Pat", email: "pat@example.com", eventId: "same" };
    expect(ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, lead).duplicate).toBe(false);
    expect(ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, lead).duplicate).toBe(true);
    await a.worker.runUntilIdle();
    expect(leadsView(a.ctx, d.ws.id)).toHaveLength(1);
    expect(contacts(a, d.ws.id)).toHaveLength(1);
  });

  it("deduplicates CRM contacts across different events by email and by phone", async () => {
    const a = makeApp();
    const d = await launched(a);
    ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Pat", email: "Pat@Example.com", eventId: "1" });
    ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Pat again", email: "pat@example.com", eventId: "2" });
    ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Sam", phone: "(512) 555-0100", eventId: "3" });
    ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Sam again", phone: "512-555-0100", eventId: "4" });
    await a.worker.runUntilIdle();
    expect(leadsView(a.ctx, d.ws.id)).toHaveLength(4);
    expect(contacts(a, d.ws.id)).toHaveLength(2);
  });

  it("retries a CRM outage and syncs exactly once", async () => {
    const a = makeApp();
    const d = await launched(a);
    a.ctx.faults.crm.transientFailuresRemaining = 2;
    ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Pat", email: "pat@example.com", eventId: "1" });
    await a.worker.runUntilIdle();
    expect(leadsView(a.ctx, d.ws.id)).toEqual([expect.objectContaining({ crmStatus: "synced" })]);
    expect(contacts(a, d.ws.id)).toHaveLength(1);
  });

  it("records a CRM permission failure on the lead and does not retry forever", async () => {
    const a = makeApp();
    const d = await launched(a);
    a.ctx.faults.crm.permissionDenied = true;
    ingestLeadEvent(a.ctx, d.ws.id, d.campaign.id, { fullName: "Pat", email: "pat@example.com", eventId: "1" });
    await a.worker.runUntilIdle();
    expect(leadsView(a.ctx, d.ws.id)).toEqual([expect.objectContaining({ crmStatus: "failed", crmError: expect.stringContaining("permission") })]);
    expect(a.ctx.db.prepare("SELECT status FROM jobs WHERE type = 'process_lead'").get()).toEqual({ status: "done" });
  });
});

describe("workspace isolation", () => {
  it("another workspace cannot see, decide or execute a proposal, and sees none of its data", async () => {
    const a = makeApp();
    const { ws, p, campaign } = await approved(a);
    await a.worker.runUntilIdle();
    ingestLeadEvent(a.ctx, ws.id, campaign.id, { fullName: "Pat", email: "pat@example.com", eventId: "1" });
    await a.worker.runUntilIdle();

    const other = createWorkspace(a.ctx, "Other").workspace;
    expect(() => getProposalRow(a.ctx, other.id, p.id)).toThrow(/not found/);
    expect(() => decideProposal(a.ctx, other.id, p.id, "approve", { decidedBy: "x" })).toThrow(/not found/);
    await expect(executeProposal(a.ctx, other.id, p.id)).rejects.toThrow(/not found/);
    expect(simCampaigns(a, other.id)).toHaveLength(0);
    expect(leadsView(a.ctx, other.id)).toHaveLength(0);
    expect(contacts(a, other.id)).toHaveLength(0);
    expect(() => ingestLeadEvent(a.ctx, other.id, campaign.id, { fullName: "x", email: "x@y.co" })).toThrow(/not found/);
  });
});
