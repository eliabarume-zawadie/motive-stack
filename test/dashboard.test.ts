/**
 * The dashboard read model (GET /api/workspaces/:wid/dashboard): every number must come from real application state, stay inside the
 * workspace, respect roles, and never carry a stack trace. States are created through the real services and the real worker, with the
 * simulated platform's fault injection, not by inserting rows.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateCampaign, getCampaignRecord, listCampaigns, updateBrief } from "../src/app/campaigns.js";
import { dashboardView } from "../src/app/dashboard.js";
import { enqueueJob } from "../src/app/jobs.js";
import { ingestLeadEvent } from "../src/app/leads.js";
import { addMember, createWorkspaceForUser } from "../src/app/memberships.js";
import { createProposal, decideProposal } from "../src/app/proposals.js";
import { upsertUser } from "../src/app/users.js";
import { jobsView, leadsView } from "../src/app/views.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN, GEN, draftCampaign, makeApp, type App } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const approve = (a: App, ws: string, pid: string) => decideProposal(a.ctx, ws, pid, "approve", { decidedBy: "dash tester" });

/** One workspace holding a campaign in every state the dashboard must tell apart. */
async function populated() {
  const a = makeApp();
  const { ws, campaign: launched } = await draftCampaign(a, "Dash Co");
  const p1 = createProposal(a.ctx, ws.id, launched.id);
  approve(a, ws.id, p1.id);
  await a.worker.runUntilIdle(); // launched (simulated)
  const lead = ingestLeadEvent(a.ctx, ws.id, launched.id, { fullName: "Dash Lead", email: "dash@example.com", eventId: "dash-1" });
  await a.worker.runUntilIdle();

  const pending = await generateCampaign(a.ctx, ws.id, GEN);
  const p2 = createProposal(a.ctx, ws.id, pending.id); // waits for a person

  const failed = await generateCampaign(a.ctx, ws.id, GEN);
  const p3 = createProposal(a.ctx, ws.id, failed.id);
  approve(a, ws.id, p3.id);
  a.ctx.faults.meta.transientFailuresRemaining = 99;
  await a.worker.runUntilIdle(); // gives up: proposal failed, job dead
  a.ctx.faults.meta.transientFailuresRemaining = 0;

  const review = await generateCampaign(a.ctx, ws.id, GEN);
  const p4 = createProposal(a.ctx, ws.id, review.id);
  approve(a, ws.id, p4.id);
  a.ctx.faults.meta.createActive = true; // the platform ignored "paused": the outcome cannot be trusted
  await a.worker.runUntilIdle();
  a.ctx.faults.meta.createActive = false;

  // a job whose handler keeps throwing (its proposal does not exist) is retried and finally marked dead: the real "dead job" path
  enqueueJob(a.ctx, ws.id, "execute_proposal", { proposalId: "prp_does_not_exist" }, "dash-dead-job");
  await a.worker.runUntilIdle();

  const over = await generateCampaign(a.ctx, ws.id, GEN);
  const brief = getCampaignRecord(a.ctx, ws.id, over.id).brief;
  updateBrief(a.ctx, ws.id, over.id, { ...brief, dailyBudgetCents: 999_999 }, "dash tester");
  let refused = "";
  try { createProposal(a.ctx, ws.id, over.id); } catch (e) { refused = (e as { code?: string }).code ?? ""; }
  return { a, ws, launched, pending, failed, review, over, p1, p2, p3, p4, lead, refused };
}

describe("dashboard read model", () => {
  it("an empty workspace reports zeros and empty lists, with simulated integrations", () => {
    const a = makeApp();
    const { workspace } = createWorkspace(a.ctx, "Empty Co");
    const d = dashboardView(a.ctx, workspace.id, "owner");
    expect(d.campaigns).toMatchObject({ total: 0, byStatus: { draft: 0, launched_paused: 0 }, launchedSimulated: 0, launchedLive: 0, list: [] });
    expect([d.pendingApprovals, d.needsAttention, d.recentBlocked, d.recentActivity.length]).toEqual([[], [], [], 1]); // only workspace.created
    expect(d.jobs).toMatchObject({ counts: { queued: 0, running: 0, done: 0, dead: 0 }, attention: [], recent: [] });
    expect(d.leads).toEqual({ total: 0, simulated: 0, crmSynced: 0, crmFailed: 0, crmPending: 0 });
    expect(d.usage.today).toMatchObject({ attempts: 0, liveRequests: 0, simulatedRequests: 0 });
    expect(d.integrations).toMatchObject({ mode: "mock", meta: { mode: "mock", simulated: true }, crm: { simulated: true, live: false }, ai: { mode: "mock", live: false } });
  });

  it("reports exactly the states that exist: statuses, pending approvals, failures, refusals, leads, usage", async () => {
    const { a, ws, launched, pending, failed, review, over, p2, refused } = await populated();
    expect(refused).toBe("budget_exceeds_cap");
    const d = dashboardView(a.ctx, ws.id, "owner");

    // campaigns: counted and listed from the stored data
    expect(d.campaigns.total).toBe(5);
    expect(d.campaigns.byStatus).toEqual({ draft: 4, launched_paused: 1 });
    expect([d.campaigns.launchedSimulated, d.campaigns.launchedLive]).toEqual([1, 0]);
    const row = (id: string) => d.campaigns.list.find((c) => c.id === id)!;
    expect(row(launched.id)).toMatchObject({ status: "launched_paused", simulated: true, latestProposal: { status: "executed", mode: "mock" }, external: { platform: "meta", simulated: true, verifiedState: "PAUSED" }, overCeiling: false });
    expect(row(pending.id)).toMatchObject({ status: "draft", latestProposal: { id: p2.id, status: "proposed" }, external: null });
    expect(row(failed.id).latestProposal?.status).toBe("failed");
    expect(row(review.id).latestProposal?.status).toBe("needs_review");
    expect(row(over.id)).toMatchObject({ budgetCents: 999_999, overCeiling: true, latestProposal: null });
    expect(row(launched.id).budgetCents).toBe(getCampaignRecord(a.ctx, ws.id, launched.id).brief.dailyBudgetCents);
    for (const c of d.campaigns.list) expect(Date.parse(c.updatedAt)).toBeGreaterThanOrEqual(Date.parse(c.createdAt));
    expect(d.campaigns.list.map((c) => c.id).sort()).toEqual(listCampaigns(a.ctx, ws.id).map((c) => c.id).sort()); // the same campaigns the API lists

    // work waiting for a person, and work that needs attention
    expect(d.pendingApprovals.map((p) => [p.proposalId, p.campaignId, p.mode])).toEqual([[p2.id, pending.id, "mock"]]);
    expect(d.needsAttention.map((n) => n.status).sort()).toEqual(["failed", "needs_review"]);
    expect(d.needsAttention.find((n) => n.status === "needs_review")?.campaignId).toBe(review.id);

    // refusals are visible, with their reason
    expect(d.recentBlocked[0]).toMatchObject({ type: "proposal.blocked", reason: "budget_exceeds_cap", entityId: over.id });

    // jobs: real queue state, single-line errors
    expect(d.jobs!.counts.dead).toBe(1);
    expect(d.jobs!.counts.done).toBeGreaterThanOrEqual(3);
    expect(d.jobs!.attention).toHaveLength(1);
    expect(d.jobs!.attention[0]).toMatchObject({ status: "dead", type: "execute_proposal", attempts: 5, maxAttempts: 5 });
    expect(d.jobs!.attention[0]!.lastError).toEqual(expect.any(String));
    expect(d.jobs!.recent.length).toBeLessThanOrEqual(15);
    expect(jobsView(a.ctx, ws.id)).toHaveLength(Object.values(d.jobs!.counts).reduce((x, y) => x + y, 0)); // the same rows the jobs route returns

    // leads
    expect(d.leads).toEqual({ total: 1, simulated: 1, crmSynced: 1, crmFailed: 0, crmPending: 0 });
    expect(leadsView(a.ctx, ws.id)).toHaveLength(d.leads.total);

    // AI usage: simulated requests counted, nothing live, no invented cost
    expect(d.usage.today.simulatedRequests).toBe(5);
    expect(d.usage.today).toMatchObject({ liveRequests: 0, knownCostMicros: 0, requestsWithUnknownCost: 0 });

    // activity: newest first, bounded
    expect(d.recentActivity.length).toBe(8);
    expect(d.recentActivity.map((e) => e.id)).toEqual([...d.recentActivity.map((e) => e.id)].sort((x, y) => Number(y) - Number(x)));
  });

  it("never carries a stack trace or an unbounded error: job and proposal errors are reduced to one short line", async () => {
    const { a, ws, p3 } = await populated();
    const stack = "Provider exploded\n    at runJob (C:\\secret\\path\\worker.ts:10:5)\n    at async next (node:internal:1:1)";
    a.ctx.db.prepare("UPDATE jobs SET last_error = ? WHERE workspace_id = ? AND status = 'dead'").run(stack, ws.id);
    a.ctx.db.prepare("UPDATE action_proposals SET last_error = ? WHERE id = ?").run(`${"x".repeat(900)}\nsecond line`, p3.id);
    const d = dashboardView(a.ctx, ws.id, "owner");
    expect(d.jobs!.attention[0]!.lastError).toBe("Provider exploded");
    const attn = d.needsAttention.find((n) => n.proposalId === p3.id)!;
    expect(attn.lastError).toHaveLength(240);
    expect(JSON.stringify(d)).not.toMatch(/secret|worker\.ts|node:internal|second line/);
  });

  it("stays inside the workspace: another workspace sees none of it", async () => {
    const { a, ws } = await populated();
    const other = createWorkspace(a.ctx, "Other Co").workspace;
    putBrain(a.ctx, other.id, BRAIN);
    const d = dashboardView(a.ctx, other.id, "owner");
    expect(d.campaigns.total).toBe(0);
    expect([d.pendingApprovals, d.needsAttention, d.recentBlocked]).toEqual([[], [], []]);
    expect(d.jobs!.counts).toEqual({ queued: 0, running: 0, done: 0, dead: 0 });
    expect(d.leads.total).toBe(0);
    expect(d.usage.today.simulatedRequests).toBe(0);
    const mine = JSON.stringify(dashboardView(a.ctx, ws.id, "owner"));
    expect(JSON.stringify(d)).not.toContain(ws.id);
    expect(mine).not.toContain(other.id);
  });

  it("includes jobs only for roles that may read them", async () => {
    const { a, ws } = await populated();
    expect(dashboardView(a.ctx, ws.id, "viewer").jobs).toBeNull();
    for (const role of ["operator", "admin", "owner"] as const) expect(dashboardView(a.ctx, ws.id, role).jobs, role).not.toBeNull();
    const viewer = dashboardView(a.ctx, ws.id, "viewer"); // and everything a viewer may already read is still there
    expect(viewer.campaigns.total).toBe(5);
    expect(viewer.pendingApprovals).toHaveLength(1);
  });
});

describe("GET /api/workspaces/:wid/dashboard", () => {
  const rsa = makeKey("RS256", "rsa-1");
  const afters: Array<() => void> = [];
  afterEach(() => { while (afters.length) afters.pop()?.(); });

  it("is workspace-token authenticated, isolated, and answers with the same data as the read model", async () => {
    const { a, ws } = await populated();
    const app = buildServer(a.ctx);
    const token = (a.ctx.db.prepare("SELECT id FROM workspaces WHERE id = ?").get(ws.id), null);
    void token;
    const issue = createWorkspace(a.ctx, "Token Co"); // a second workspace with its own token
    const get = (wid: string, tok?: string) => app.inject({ method: "GET", url: `/api/workspaces/${wid}/dashboard`, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    expect((await get(issue.workspace.id)).statusCode).toBe(401);
    expect((await get(issue.workspace.id, "msw_wrong")).statusCode).toBe(401);
    expect((await get(ws.id, issue.token)).statusCode).toBe(401); // another workspace's token
    const ok = await get(issue.workspace.id, issue.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().campaigns.total).toBe(0);
    expect(ok.headers["content-security-policy"]).toBeTruthy(); // the Package 2 headers apply to it too
  });

  it("applies roles: a viewer gets no jobs, an operator does, a non-member is refused like a missing workspace", async () => {
    const a = makeApp();
    const runtime = buildAuthRuntime(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
    const app = buildServer(a.ctx, runtime);
    const person = (name: string) => upsertUser(a.ctx, { issuer: ISSUER, subject: `idp|${name}`, email: null, displayName: name });
    const owner = person("owner"), viewer = person("viewer"), operator = person("operator"), outsider = person("outsider");
    const wsId = createWorkspaceForUser(a.ctx, userActor(owner.id) as never, "Roles Co").id;
    addMember(a.ctx, userActor(owner.id), wsId, viewer.id, "viewer");
    addMember(a.ctx, userActor(owner.id), wsId, operator.id, "operator");
    const jwt = (name: string) => signJwt(rsa, claims({ aud: AUDIENCE, sub: `idp|${name}`, azp: undefined }));
    const get = (name: string) => app.inject({ method: "GET", url: `/api/workspaces/${wsId}/dashboard`, headers: { authorization: `Bearer ${jwt(name)}` } });
    expect((await get("viewer")).json().jobs).toBeNull();
    expect((await get("operator")).json().jobs).toMatchObject({ counts: expect.any(Object) });
    expect((await get("owner")).statusCode).toBe(200);
    const out = await get("outsider");
    expect(out.statusCode).toBe(404);
    expect(out.json().error.code).toBe("not_found");
    void outsider;
    afters.push(() => a.ctx.db.close());
  });
});
