/**
 * The workspace-wide daily budget limit. The Business Brain's ceiling is an AGGREGATE limit across every plan and stand-alone campaign in one workspace: what is
 * already approved or running counts, each campaign once, and no approval, run or edit can push the total over it. Mock AI only; signed-in people are test identities.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { generateCampaign, updateBrief } from "../src/app/campaigns.js";
import { budgetPosition } from "../src/app/budgetCommitments.js";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createProposal, decideProposal } from "../src/app/proposals.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const oidc = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

const BRAIN3 = { ...BRAIN, services: ["Emergency plumbing", "Water heater repair", "Drain cleaning"], maxDailyBudgetCents: 2000 };
const MOCK = { providerId: "mock", model: "mock-deterministic-1" };
type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
function boot() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, oidc());
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}
type W = ReturnType<typeof boot>;
async function person(w: W, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  const r = await call(w.app, "GET", "/api/me", token);
  return { token, id: r.body.user.id as string };
}
/** One workspace: an owner, two admins (so one can propose a plan change and the other review it), an operator and a viewer. */
async function team(brain: Json = BRAIN3) {
  const w = boot();
  const owner = await person(w, "olivia"), admin = await person(w, "adam"), admin2 = await person(w, "amy"), operator = await person(w, "oscar"), viewer = await person(w, "vera");
  const id = (await call(w.app, "POST", "/api/workspaces", owner.token, { name: "Budget Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${id}`;
  for (const [p, role] of [[admin, "admin"], [admin2, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) await call(w.app, "POST", `${base}/members`, owner.token, { userId: p.id, role });
  expect((await call(w.app, "PUT", `${base}/brain`, owner.token, brain)).status).toBe(200);
  return { w, base, id, owner, admin, admin2, operator, viewer };
}
type T = Awaited<ReturnType<typeof team>>;

/** A stand-alone campaign with an exact daily budget (a person's edit of the generated draft). */
async function campaign(t: T, cents: number, svc = "Emergency plumbing") {
  const gen = (await call(t.w.app, "POST", `${t.base}/campaigns/generate`, t.operator.token, { ...MOCK, goal: "promote_service", focusService: svc })).body;
  const edited = await call(t.w.app, "PUT", `${t.base}/campaigns/${gen.id}/brief`, t.operator.token, { ...gen.brief, dailyBudgetCents: cents });
  expect(edited.status, JSON.stringify(edited.body.error)).toBe(200);
  return { id: gen.id as string, name: edited.body.name as string };
}
const propose = (t: T, cid: string) => call(t.w.app, "POST", `${t.base}/campaigns/${cid}/proposals`, t.operator.token, {});
const approve = (t: T, pid: string, by = t.admin) => call(t.w.app, "POST", `${t.base}/proposals/${pid}/approve`, by.token, { decidedBy: "x", acknowledgedReview: true });
const run = (t: T, pid: string, by = t.admin) => call(t.w.app, "POST", `${t.base}/proposals/${pid}/execute`, by.token);
const position = (t: T) => budgetPosition(t.w.ctx, t.id);
const dash = async (t: T) => (await call(t.w.app, "GET", `${t.base}/dashboard`, t.viewer.token)).body;
const LIMIT = "daily_budget_limit_exceeded";

/* ---------------------------------------------------------------- what counts */

describe("what counts as a commitment", () => {
  it("counts approved (unexpired), executing, executed and unknown-outcome proposals, once per campaign, and nothing that is only proposed, stale, rejected, failed, archived or completed", async () => {
    const t = await team();
    const mk = async (cents: number) => { const c = await campaign(t, cents); const p = (await propose(t, c.id)).body.id as string; return { ...c, pid: p }; };
    const [c1, c2, c3, c4, c5, c6, c7, c8] = [await mk(100), await mk(200), await mk(300), await mk(400), await mk(500), await mk(600), await mk(150), await mk(250)];
    // c1: proposed (counts nothing). c2: approved. c4: rejected through the API. The rest are set the way the executor and a failure would leave them.
    expect((await approve(t, c2.pid)).status).toBe(200);
    expect((await call(t.w.app, "POST", `${t.base}/proposals/${c4.pid}/reject`, t.admin.token, { decidedBy: "x", reason: "no" })).status).toBe(200);
    const set = (pid: string, status: string) => t.w.db.prepare("UPDATE action_proposals SET status = ? WHERE id = ?").run(status, pid);
    set(c3.pid, "stale"); set(c5.pid, "failed"); set(c6.pid, "needs_review"); set(c7.pid, "executing"); set(c8.pid, "executed");
    const pos = position(t);
    expect(pos.committedCents).toBe(200 + 600 + 150 + 250);
    expect(pos.commitments.map((x) => [x.campaignId === c2.id ? "c2" : "other", x.state]).sort()).toEqual([["c2", "approved"], ["other", "executed"], ["other", "executing"], ["other", "needs_review"]].sort());
    expect(c1.pid).toBeTruthy();
    // an archived campaign and a completed campaign release what they held
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${c2.id}/archive`, t.admin.token)).status).toBe(200);
    expect(position(t).committedCents).toBe(600 + 150 + 250);
    t.w.db.prepare("UPDATE campaigns SET completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(c8.id);
    expect(position(t).committedCents).toBe(600 + 150);
    // a second, newer committed proposal for the same campaign replaces the first: the campaign is counted once
    t.w.db.prepare("INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at, proposed_by, proposed_by_kind) SELECT 'prp_newer', workspace_id, campaign_id, campaign_version, type, json_set(payload, '$.plannedDailyBudgetCents', 999), payload_hash, 999, integration_mode, 'executed', '2099-01-01T00:00:00.000Z', updated_at, proposed_by, proposed_by_kind FROM action_proposals WHERE id = ?").run(c6.pid);
    expect(position(t).committedCents).toBe(999 + 150);
    expect(position(t).commitments.filter((x) => x.campaignId === c6.id)).toHaveLength(1);
  });

  it("releases an approval that expired without being run, and shows the commitment on the dashboard once per campaign", async () => {
    const t = await team();
    const a = await campaign(t, 1200);
    const pa = (await propose(t, a.id)).body.id as string;
    await approve(t, pa);
    expect((await dash(t)).budget).toMatchObject({ ceilingCents: 2000, committedCents: 1200, availableCents: 800, overLimitCents: 0 });
    expect((await dash(t)).budget.commitments).toHaveLength(1);
    t.w.db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE proposal_id = ?").run(pa);
    expect(position(t).committedCents).toBe(0);
    expect((await run(t, pa)).body.error.code).toBe("approval_expired"); // and it cannot be run either
  });

  it("legacy proposals (no budget basis in their payload) count, so the correction needs no data migration", async () => {
    const t = await team();
    const old = await campaign(t, 100);
    t.w.db.prepare("UPDATE campaigns SET status = 'launched_paused' WHERE id = ?").run(old.id);
    t.w.db.prepare("INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at, proposed_by, proposed_by_kind) VALUES ('prp_legacy', ?, ?, 1, 'create_campaign_draft', ?, 'h', 1500, 'mock', 'executed', 't', 't', 'workspace-token:x', 'legacy_token')")
      .run(t.id, old.id, JSON.stringify({ action: "create_campaign_draft", accountId: "act_9000000001", name: "x", objective: "OUTCOME_LEADS", plannedDailyBudgetCents: 1500, campaignVersion: 1, mode: "mock", budgetCeilingCents: 2000, reviewFlags: [] }));
    expect(position(t)).toMatchObject({ committedCents: 1500, availableCents: 500, unnormalizable: [] });
    const next = await campaign(t, 600);
    const r = await propose(t, next.id);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe(LIMIT);
    expect(r.body.error.message).toMatch(/This would commit 600¢ per day\. 1500¢ of your 2000¢ daily limit is already committed/);
  });
});

/* ---------------------------------------------------------------- the ceiling cannot be bypassed */

describe("stand-alone campaigns: approvals stop at the limit, with an explanation", () => {
  it("approves up to the limit, refuses the next one at approval time (not only at proposal time), and frees room when a campaign is archived", async () => {
    const t = await team();
    const [a, b, c] = [await campaign(t, 800), await campaign(t, 800), await campaign(t, 800)];
    const [pa, pb, pc] = [(await propose(t, a.id)).body.id, (await propose(t, b.id)).body.id, (await propose(t, c.id)).body.id] as string[]; // all three are only proposed: nothing committed yet
    expect((await approve(t, pa!)).status).toBe(200);
    expect((await approve(t, pb!)).status).toBe(200);
    const third = await approve(t, pc!);
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe(LIMIT);
    const msg = third.body.error.message as string;
    expect(msg).toMatch(/This would commit 800¢ per day/);
    expect(msg).toMatch(/1600¢ of your 2000¢ daily limit is already committed/);
    expect(msg).toContain(a.name);
    expect(msg).toContain(b.name);
    expect(msg).toMatch(/leaving 400¢/);
    expect(t.w.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pc)).toEqual({ status: "proposed" });
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM approvals").get()).toEqual({ n: 2 });
    const refused = t.w.db.prepare("SELECT detail FROM audit_events WHERE type = 'proposal.approval_blocked'").get() as { detail: string };
    expect(JSON.parse(refused.detail)).toMatchObject({ reason: LIMIT, requestedCents: 800 });
    // proposing a fourth is refused early, with the same explanation
    const d = await campaign(t, 800);
    expect((await propose(t, d.id)).body.error.code).toBe(LIMIT);
    // archiving one frees its 800¢, and the waiting approval now fits
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${a.id}/archive`, t.admin.token)).status).toBe(200);
    expect((await approve(t, pc!)).status).toBe(200);
    expect(position(t).committedCents).toBe(1600);
  });

  it("an approval exactly at the limit is allowed; one cent more is not", async () => {
    const t = await team();
    const [a, b, c] = [await campaign(t, 1000), await campaign(t, 1000), await campaign(t, 1)];
    expect((await approve(t, (await propose(t, a.id)).body.id)).status).toBe(200);
    expect((await approve(t, (await propose(t, b.id)).body.id)).status).toBe(200);
    expect(position(t)).toMatchObject({ committedCents: 2000, availableCents: 0, overLimitCents: 0 });
    const r = await propose(t, c.id);
    expect(r.body.error.code).toBe(LIMIT);
    expect(r.body.error.message).toMatch(/leaving 0¢/);
  });

  it("editing a committed campaign cannot raise committed spend: the approval goes stale and the larger budget must fit on its own", async () => {
    const t = await team();
    const [a, b] = [await campaign(t, 1200), await campaign(t, 700)];
    await approve(t, (await propose(t, a.id)).body.id);
    await approve(t, (await propose(t, b.id)).body.id);
    expect(position(t).committedCents).toBe(1900);
    const rec = (await call(t.w.app, "GET", `${t.base}/campaigns/${b.id}`, t.viewer.token)).body;
    await call(t.w.app, "PUT", `${t.base}/campaigns/${b.id}/brief`, t.operator.token, { ...rec.brief, dailyBudgetCents: 1900 });
    expect(position(t).committedCents).toBe(1200); // B's approval is stale: nothing is committed for B any more
    const again = await propose(t, b.id);
    expect(again.body.error.code).toBe(LIMIT);
    // a campaign that was already run cannot be edited at all
    const c = await campaign(t, 100);
    const pc = (await propose(t, c.id)).body.id as string;
    await approve(t, pc);
    await run(t, pc);
    await t.w.worker.runUntilIdle();
    const rc = (await call(t.w.app, "GET", `${t.base}/campaigns/${c.id}`, t.viewer.token)).body;
    expect((await call(t.w.app, "PUT", `${t.base}/campaigns/${c.id}/brief`, t.operator.token, { ...rc.brief, dailyBudgetCents: 1900 })).body.error.code).toBe("already_launched");
    expect(position(t).committedCents).toBe(1300);
  });
});

describe("plans and stand-alone campaigns share ONE limit", () => {
  /** A plan whose campaigns have exact budgets, reviewed and proposed (not yet approved). Duplicate warnings are acknowledged: these tests are about money. */
  async function plan(t: T, total: number, budgets: number[], opts: { propose?: boolean } = {}) {
    const p = (await call(t.w.app, "POST", `${t.base}/plans/recommend`, t.operator.token, { totalDailyBudgetCents: total, maxOpportunities: budgets.length })).body;
    for (const o of p.opportunities as Json[]) if (o.duplicate) await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}/opportunities/${o.id}`, t.operator.token, { status: "selected", acknowledgeDuplicate: true });
    const g = (await call(t.w.app, "POST", `${t.base}/plans/${p.id}/generate`, t.operator.token, MOCK)).body;
    const cids = (g.opportunities as Json[]).map((o) => o.campaign.id as string);
    for (const [i, cid] of cids.entries()) {
      const rec = (await call(t.w.app, "GET", `${t.base}/campaigns/${cid}`, t.viewer.token)).body;
      expect((await call(t.w.app, "PUT", `${t.base}/campaigns/${cid}/brief`, t.operator.token, { ...rec.brief, dailyBudgetCents: budgets[i]! })).status).toBe(200);
    }
    const fp = (await call(t.w.app, "GET", `${t.base}/plans/${p.id}`, t.viewer.token)).body.budget.fingerprint;
    expect((await call(t.w.app, "POST", `${t.base}/plans/${p.id}/budget-review`, t.admin.token, { fingerprint: fp })).status).toBe(200);
    const pids = opts.propose === false ? [] : await Promise.all(cids.map(async (cid) => { const r = await propose(t, cid); expect(r.status, JSON.stringify(r.body.error)).toBe(201); return r.body.id as string; }));
    return { id: p.id as string, cids, pids };
  }

  it("two plans and a stand-alone campaign together can never be approved past the limit, and plan totals are never added on top of their campaigns", async () => {
    const t = await team();
    const s1 = await campaign(t, 600);
    await approve(t, (await propose(t, s1.id)).body.id); // 600
    const p1 = await plan(t, 1000, [500, 500]);          // plan total 1000
    const p2 = await plan(t, 400, [400]);                // plan total 400
    for (const pid of [...p1.pids, ...p2.pids]) expect((await approve(t, pid)).status).toBe(200);
    expect(position(t).committedCents).toBe(600 + 500 + 500 + 400); // 2000: the campaigns, each once, NOT 600 + 1000 + 400 + 500 + 500 + 400
    expect(position(t).commitments).toHaveLength(4);
    expect((await dash(t)).budget).toMatchObject({ committedCents: 2000, availableCents: 0 });
    const s2 = await campaign(t, 100);
    expect((await propose(t, s2.id)).body.error.code).toBe(LIMIT);
  });

  it("two plans whose totals are each the whole limit still stop at the limit together, and the second plan says what is left for it", async () => {
    const t = await team();
    const p1 = await plan(t, 2000, [900, 900]);
    const p2 = await plan(t, 2000, [400]);
    for (const pid of p1.pids) expect((await approve(t, pid)).status).toBe(200); // 1800
    const view = (await call(t.w.app, "GET", `${t.base}/plans/${p2.id}`, t.viewer.token)).body;
    expect(view.budget.availableForPlanCents).toBe(200);
    expect(view.gaps.join(" ")).toMatch(/leaving 200¢ per day for this plan, less than its total of 2000¢/);
    const blocked = await approve(t, p2.pids[0]!);
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe(LIMIT);
    expect(blocked.body.error.message).toMatch(/This would commit 400¢ per day\. 1800¢ of your 2000¢ daily limit is already committed/);
    expect(blocked.body.error.message).toMatch(/leaving 200¢/);
    expect(position(t).committedCents).toBe(1800);
    // archiving a campaign in the first plan frees 900¢ and the second plan's campaign now fits
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${p1.cids[0]}/archive`, t.admin.token)).status).toBe(200);
    expect((await approve(t, p2.pids[0]!)).status).toBe(200);
    expect(position(t).committedCents).toBe(900 + 400);
  });

  it("a plan's duration is descriptive: it never multiplies or converts a budget", async () => {
    const t = await team();
    const p = (await call(t.w.app, "POST", `${t.base}/plans/recommend`, t.operator.token, { totalDailyBudgetCents: 600, durationDays: 30, maxOpportunities: 1 })).body;
    const g = (await call(t.w.app, "POST", `${t.base}/plans/${p.id}/generate`, t.operator.token, MOCK)).body;
    const cid = g.opportunities[0].campaign.id as string;
    const rec = (await call(t.w.app, "GET", `${t.base}/campaigns/${cid}`, t.viewer.token)).body;
    await call(t.w.app, "PUT", `${t.base}/campaigns/${cid}/brief`, t.operator.token, { ...rec.brief, dailyBudgetCents: 500 });
    const fp = (await call(t.w.app, "GET", `${t.base}/plans/${p.id}`, t.viewer.token)).body.budget.fingerprint;
    await call(t.w.app, "POST", `${t.base}/plans/${p.id}/budget-review`, t.admin.token, { fingerprint: fp });
    const pid = (await propose(t, cid)).body.id as string;
    await approve(t, pid);
    expect(position(t).committedCents).toBe(500); // not 500 x 30
    expect((await call(t.w.app, "GET", `${t.base}/proposals/${pid}`, t.viewer.token)).body.payload.budgetBasis).toBe("daily");
  });
});

/* ---------------------------------------------------------------- concurrency */

describe("two approvals cannot both pass on the same numbers", () => {
  it("through the API, two simultaneous approvals that cannot both fit give exactly one approval and one refusal", async () => {
    const t = await team();
    const [a, b] = [await campaign(t, 1200), await campaign(t, 1200)];
    const [pa, pb] = [(await propose(t, a.id)).body.id, (await propose(t, b.id)).body.id] as string[];
    const [x, y] = await Promise.all([approve(t, pa!), approve(t, pb!, t.admin2)]);
    expect([x.status, y.status].sort()).toEqual([200, 422]);
    expect([x, y].find((r) => r.status === 422)!.body.error.code).toBe(LIMIT);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM approvals WHERE decision = 'approve'").get()).toEqual({ n: 1 });
    expect(position(t).committedCents).toBe(1200);
  });

  it("across two database connections: the approval takes the write lock BEFORE counting, so a second approval cannot read stale numbers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-budget-"));
    open.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "two.db");
    const db1 = openDb(path); migrate(db1);
    const db2 = openDb(path);
    open.push(() => { if (db1.open) db1.close(); if (db2.open) db2.close(); });
    db2.pragma("busy_timeout = 50");
    const mk = (db: typeof db1) => buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
    const [ctx1, ctx2] = [mk(db1), mk(db2)];
    const { workspace } = createWorkspace(ctx1, "Two Connections Co");
    putBrain(ctx1, workspace.id, BRAIN3);
    const ids: string[] = [];
    for (const [i, svc] of ["Emergency plumbing", "Drain cleaning"].entries()) {
      const rec = await generateCampaign(ctx1, workspace.id, MOCK, undefined, { goal: "promote_service", focusService: svc });
      updateBrief(ctx1, workspace.id, rec.id, { ...rec.brief, dailyBudgetCents: 1200 }, "user:editor");
      ids.push(createProposal(ctx1, workspace.id, rec.id, `user:proposer${i}`).id);
    }
    const by = { decidedBy: "user:approver", approver: { kind: "legacy_token" as const } }; // a person who is not the proposer (the approval row would need a real user id otherwise)
    // connection 1 starts its approval and has not committed yet
    db1.exec("BEGIN IMMEDIATE");
    decideProposal(ctx1, workspace.id, ids[0]!, "approve", by);
    // connection 2 tries the other approval at the same moment: it must not proceed on stale numbers
    let busy: unknown;
    try { decideProposal(ctx2, workspace.id, ids[1]!, "approve", by); } catch (e) { busy = e; }
    expect(busy).toMatchObject({ status: 503, code: "busy" });
    db1.exec("COMMIT");
    // once the first has committed, the second sees it and is refused for the right reason
    let refused: unknown;
    try { decideProposal(ctx2, workspace.id, ids[1]!, "approve", by); } catch (e) { refused = e; }
    expect(refused).toMatchObject({ status: 422, code: LIMIT });
    expect(budgetPosition(ctx2, workspace.id).committedCents).toBe(1200);
    expect(db2.prepare("SELECT COUNT(*) n FROM approvals WHERE decision = 'approve'").get()).toEqual({ n: 1 });
  });
});

/* ---------------------------------------------------------------- running, and a limit that is lowered */

describe("running and lowering the limit", () => {
  it("lowering the limit below what is committed is allowed but flagged, blocks new approvals and runs, and the executor refuses a run that no longer fits", async () => {
    const t = await team();
    const [a, b, c] = [await campaign(t, 1200), await campaign(t, 700), await campaign(t, 100)];
    const [pa, pb, pc] = [(await propose(t, a.id)).body.id, (await propose(t, b.id)).body.id, (await propose(t, c.id)).body.id] as string[];
    await approve(t, pa!); await approve(t, pb!);
    expect((await run(t, pa!)).status).toBe(200); // A is queued to run
    const lowered = await call(t.w.app, "PUT", `${t.base}/brain`, t.owner.token, { ...BRAIN3, maxDailyBudgetCents: 1500 });
    expect(lowered.status).toBe(200);
    expect(lowered.body.budget).toMatchObject({ ceilingCents: 1500, committedCents: 1900, availableCents: 0, overLimitCents: 400 });
    const flagged = t.w.db.prepare("SELECT detail FROM audit_events WHERE type = 'budget.over_limit'").get() as { detail: string };
    expect(JSON.parse(flagged.detail)).toMatchObject({ overLimitCents: 400 });
    expect((await dash(t)).attention.map((x: Json) => x.kind)).toContain("budget_over_limit");
    expect((await dash(t)).budget).toMatchObject({ overLimitCents: 400 });
    const newApproval = await approve(t, pc!);
    expect(newApproval.body.error.code).toBe(LIMIT);
    expect(newApproval.body.error.message).toMatch(/leaving 0¢/);
    const newRun = await run(t, pb!);
    expect(newRun.status).toBe(422);
    expect(newRun.body.error.message).toMatch(/400¢ over it/);
    // the job that was already queued is refused by the executor's own gate, and the proposal fails safely with the reason
    await t.w.worker.runUntilIdle();
    expect(t.w.db.prepare("SELECT status, last_error FROM action_proposals WHERE id = ?").get(pa)).toEqual({ status: "failed", last_error: LIMIT });
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 0 }); // nothing was created
    // A no longer holds a commitment, so the rest fits again and B can now run
    expect(position(t)).toMatchObject({ committedCents: 700, overLimitCents: 0 });
    expect((await run(t, pb!)).status).toBe(200);
    await t.w.worker.runUntilIdle();
    expect(t.w.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pb)).toEqual({ status: "executed" });
  });

  it("running a campaign does not change what is committed, and a campaign that was run keeps its commitment until it is completed or archived", async () => {
    const t = await team();
    const a = await campaign(t, 900);
    const pa = (await propose(t, a.id)).body.id as string;
    await approve(t, pa);
    expect(position(t).committedCents).toBe(900);
    await run(t, pa);
    await t.w.worker.runUntilIdle();
    expect(position(t)).toMatchObject({ committedCents: 900, commitments: [expect.objectContaining({ state: "executed" })] });
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${a.id}/complete`, t.admin.token)).status).toBe(200);
    expect(position(t).committedCents).toBe(0);
  });
});

/* ---------------------------------------------------------------- normalization */

describe("a budget that cannot be read as a daily amount is flagged, never counted as zero, and blocks new approvals", () => {
  async function committedA(t: T) {
    const a = await campaign(t, 800);
    const pa = (await propose(t, a.id)).body.id as string;
    await approve(t, pa);
    return { a, pa };
  }
  const setPayload = (t: T, pid: string, patch: Json) => t.w.db.prepare("UPDATE action_proposals SET payload = json_patch(payload, ?) WHERE id = ?").run(JSON.stringify(patch), pid);

  it("a non-daily basis, a lifetime or currency field, a missing amount, or a recorded amount that disagrees with the payload", async () => {
    for (const [patch, reason] of [
      [{ budgetBasis: "lifetime" }, /not daily/],
      [{ lifetimeBudgetCents: 50000 }, /lifetime, total or currency/],
      [{ currency: "EUR" }, /lifetime, total or currency/],
      [{ plannedDailyBudgetCents: null }, /no valid daily budget/],
    ] as const) {
      const t = await team();
      const { a, pa } = await committedA(t);
      setPayload(t, pa, patch);
      const pos = position(t);
      expect(pos.committedCents, JSON.stringify(patch)).toBe(0); // not counted as zero spend: it is reported instead
      expect(pos.unnormalizable).toHaveLength(1);
      expect(pos.unnormalizable[0]).toMatchObject({ campaignId: a.id });
      expect(pos.unnormalizable[0]!.reason).toMatch(reason);
      // new commitments are refused until someone has looked at it, and nothing can run
      const b = await campaign(t, 100, "Drain cleaning");
      const r = await propose(t, b.id);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("budget_not_normalizable");
      expect((await dash(t)).attention.map((x: Json) => x.kind)).toContain("budget_not_normalizable");
      expect((await dash(t)).budget.unnormalizable).toHaveLength(1);
    }
    const t = await team();
    const { pa } = await committedA(t);
    t.w.db.prepare("UPDATE action_proposals SET daily_budget_cents = 700 WHERE id = ?").run(pa); // the column and the payload now disagree
    expect(position(t).unnormalizable[0]!.reason).toMatch(/disagrees with its payload/);
    expect((await run(t, pa)).body.error.code).toBe("budget_not_normalizable");
  });
});

/* ---------------------------------------------------------------- agency workspaces, and the batch limit */

describe("each client workspace has its own limit", () => {
  it("two client workspaces of one agency never count against each other", async () => {
    const w = boot();
    const owner = await person(w, "olivia"), admin = await person(w, "adam"), operator = await person(w, "oscar");
    const org = (await call(w.app, "POST", "/api/organizations", owner.token, { name: "Bright Agency" })).body;
    const O = `/api/organizations/${org.id}`;
    const clients: Array<{ base: string; id: string }> = [];
    for (const name of ["Client One", "Client Two"]) {
      const ws = (await call(w.app, "POST", `${O}/workspaces`, owner.token, { name })).body;
      const base = `/api/workspaces/${ws.id}`;
      await call(w.app, "POST", `${base}/members`, owner.token, { userId: admin.id, role: "admin" });
      await call(w.app, "POST", `${base}/members`, owner.token, { userId: operator.id, role: "operator" });
      expect((await call(w.app, "PUT", `${base}/brain`, owner.token, BRAIN3)).status).toBe(200);
      clients.push({ base, id: ws.id });
    }
    const commit = async (c: { base: string }, cents: number) => {
      const gen = (await call(w.app, "POST", `${c.base}/campaigns/generate`, operator.token, MOCK)).body;
      await call(w.app, "PUT", `${c.base}/campaigns/${gen.id}/brief`, operator.token, { ...gen.brief, dailyBudgetCents: cents });
      const p = await call(w.app, "POST", `${c.base}/campaigns/${gen.id}/proposals`, operator.token, {});
      if (p.status !== 201) return p;
      return call(w.app, "POST", `${c.base}/proposals/${p.body.id}/approve`, admin.token, { decidedBy: "x", acknowledgedReview: true });
    };
    const [one, two] = clients as [{ base: string; id: string }, { base: string; id: string }];
    expect((await commit(one, 900)).status).toBe(200);
    expect((await commit(one, 900)).status).toBe(200);   // 1800 of client one's own 2000
    expect((await commit(one, 300)).body.error.code).toBe(LIMIT); // client one is full
    expect((await commit(two, 1900)).status).toBe(200);  // client two has all of its own limit
    expect(budgetPosition(w.ctx, one.id).committedCents).toBe(1800);
    expect(budgetPosition(w.ctx, two.id).committedCents).toBe(1900);
  });
});

describe("the batch limit of five drafts per request is kept", () => {
  it("a plan never offers more than five opportunities, and a request naming more than five is refused", async () => {
    const t = await team({ ...BRAIN3, services: ["Svc one", "Svc two", "Svc three", "Svc four", "Svc five", "Svc six", "Svc seven"] });
    const asked6 = await call(t.w.app, "POST", `${t.base}/plans/recommend`, t.operator.token, { maxOpportunities: 6 });
    expect(asked6.status).toBe(400);
    const p = (await call(t.w.app, "POST", `${t.base}/plans/recommend`, t.operator.token, {})).body;
    expect(p.opportunities).toHaveLength(5);
    const six = await call(t.w.app, "POST", `${t.base}/plans/${p.id}/generate`, t.operator.token, { ...MOCK, opportunityIds: Array.from({ length: 6 }, (_, i) => `opp_${i}`) });
    expect(six.status).toBe(400);
    const g = await call(t.w.app, "POST", `${t.base}/plans/${p.id}/generate`, t.operator.token, MOCK);
    expect(g.body.results).toHaveLength(5);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM campaigns").get()).toEqual({ n: 5 });
  });
});
