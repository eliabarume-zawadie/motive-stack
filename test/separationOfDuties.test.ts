/**
 * Phase 1: approval never runs anything; running needs its own permission; a person cannot approve their own proposal (default on, server-side);
 * in single-token local mode separation is NOT enforceable and is recorded as such. Simulated actions only.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { workspaceTokenRuntime, buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
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

type Json = Record<string, any>;
function boot(mode: "oidc" | "token") {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, mode === "oidc" ? oidc() : workspaceTokenRuntime);
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}
type S = ReturnType<typeof boot>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
async function person(s: S, name: string) {
  const token = jwtFor(name);
  const r = await call(s.app, "GET", "/api/me", token);
  return { token, id: r.body.user.id as string };
}

/** A workspace with an owner, an admin, an operator, and a draft campaign ready to propose. */
async function world() {
  const s = boot("oidc");
  const owner = await person(s, "olivia");
  const admin = await person(s, "adam");
  const operator = await person(s, "oscar");
  const W = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Sep Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [operator, "operator"]] as const) expect((await call(s.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
  const cid = (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const propose = async (by: { token: string }) => {
    const r = await call(s.app, "POST", `${base}/campaigns/${cid}/proposals`, by.token, {});
    expect(r.status).toBe(201);
    return r.body.id as string;
  };
  const approve = (pid: string, by: { token: string }) => call(s.app, "POST", `${base}/proposals/${pid}/approve`, by.token, { decidedBy: "x" });
  const run = (pid: string, by: { token: string }) => call(s.app, "POST", `${base}/proposals/${pid}/execute`, by.token);
  const status = (pid: string) => (s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pid) as { status: string }).status;
  const execJobs = () => (s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get() as { n: number }).n;
  return { s, owner, admin, operator, W, base, cid, propose, approve, run, status, execJobs };
}

describe("approving never runs anything; running is its own permissioned step", () => {
  it("approval records the decision and leaves the action waiting: no job is queued and nothing is created until someone runs it", async () => {
    const w = await world();
    const pid = await w.propose(w.operator);
    expect((await w.approve(pid, w.admin)).body.status).toBe("approved");
    expect(w.execJobs()).toBe(0);
    await w.s.worker.runUntilIdle();
    expect(w.status(pid)).toBe("approved");
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 0 });
    expect((await call(w.s.app, "GET", `${w.base}/dashboard`, w.admin.token)).body.attention.map((a: Json) => a.kind)).toContain("approved_not_run");
  });

  it("running needs proposals.execute: an operator is refused, an admin may run, and the run is audited with who asked", async () => {
    const w = await world();
    const pid = await w.propose(w.operator);
    await w.approve(pid, w.admin);
    expect((await w.run(pid, w.operator)).status).toBe(403);
    expect(w.execJobs()).toBe(0);
    const r = await w.run(pid, w.admin);
    expect(r.status).toBe(200);
    expect(w.execJobs()).toBe(1);
    await w.s.worker.runUntilIdle();
    expect(w.status(pid)).toBe("executed");
    const ev = w.s.db.prepare("SELECT actor, detail FROM audit_events WHERE type = 'proposal.execution_requested'").get() as { actor: string; detail: string };
    expect(ev.actor).toBe(`user:${w.admin.id}`);
    expect(JSON.parse(ev.detail)).toMatchObject({ mode: "mock", queued: true });
  });

  it("running twice is idempotent: one job, one external draft, and the second answer simply reports the state", async () => {
    const w = await world();
    const pid = await w.propose(w.operator);
    await w.approve(pid, w.admin);
    expect((await w.run(pid, w.admin)).status).toBe(200);
    expect((await w.run(pid, w.admin)).status).toBe(200);
    expect(w.execJobs()).toBe(1);
    await w.s.worker.runUntilIdle();
    expect((await w.run(pid, w.admin)).body.status).toBe("executed");
    expect(w.execJobs()).toBe(1);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 1 });
  });

  it("only an approved, unexpired proposal can be run, and an approval that no longer counts is refused", async () => {
    const w = await world();
    const pid = await w.propose(w.operator);
    expect((await w.run(pid, w.admin)).body.error.code).toBe("not_approved"); // proposed
    await call(w.s.app, "POST", `${w.base}/proposals/${pid}/reject`, w.admin.token, { decidedBy: "x", reason: "no" });
    expect((await w.run(pid, w.admin)).body.error.code).toBe("not_approved"); // rejected
    const p2 = await w.propose(w.operator);
    await w.approve(p2, w.admin);
    w.s.db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE proposal_id = ?").run(p2);
    expect((await w.run(p2, w.admin)).body.error.code).toBe("approval_expired");
    expect(w.execJobs()).toBe(0);
  });

  it("the approver's access is re-checked when running: an approver removed after approving makes the approval void", async () => {
    const w = await world();
    const pid = await w.propose(w.operator);
    await w.approve(pid, w.admin);
    expect((await call(w.s.app, "PATCH", `${w.base}/members/${w.admin.id}`, w.owner.token, { role: "viewer" })).status).toBe(200);
    const r = await w.run(pid, w.owner);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("approver_not_valid");
    expect(w.execJobs()).toBe(0);
  });

  it("approve and run are separate custom permissions: one can approve without running, another can run without approving", async () => {
    const w = await world();
    const orgId = (w.s.db.prepare("SELECT organization_id o FROM workspaces WHERE id = ?").get(w.W) as { o: string }).o;
    const O = `/api/organizations/${orgId}`;
    const mk = async (name: string, permissions: string[]) => (await call(w.s.app, "POST", `${O}/role-templates`, w.owner.token, { name, permissions })).body.id as string;
    const approverRole = await mk("Approver only", ["workspace.read", "proposals.read", "proposals.decide"]);
    const runnerRole = await mk("Runner only", ["workspace.read", "proposals.read", "proposals.execute"]);
    const approver = await person(w.s, "ann");
    const runner = await person(w.s, "ray");
    await call(w.s.app, "POST", `${O}/members`, w.owner.token, { userId: approver.id, role: "member" });
    await call(w.s.app, "POST", `${O}/members`, w.owner.token, { userId: runner.id, role: "member" });
    await call(w.s.app, "POST", `${O}/access-grants`, w.owner.token, { userId: approver.id, workspaceIds: [w.W], customRoleId: approverRole });
    await call(w.s.app, "POST", `${O}/access-grants`, w.owner.token, { userId: runner.id, workspaceIds: [w.W], customRoleId: runnerRole });
    const pid = await w.propose(w.operator);
    expect((await w.run(pid, runner)).status).toBe(409); // not approved yet: allowed to try, refused for the right reason
    expect((await w.approve(pid, runner)).status).toBe(403); // the runner cannot approve
    expect((await w.approve(pid, approver)).status).toBe(200);
    expect((await w.run(pid, approver)).status).toBe(403); // the approver cannot run
    expect((await w.run(pid, runner)).status).toBe(200);
    await w.s.worker.runUntilIdle();
    expect(w.status(pid)).toBe("executed");
  });
});

describe("separation of duties (default on)", () => {
  it("a signed-in person cannot approve their own proposal, and nothing is recorded as approved", async () => {
    const w = await world();
    const pid = await w.propose(w.admin);
    const r = await w.approve(pid, w.admin);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("self_approval_not_allowed");
    expect(w.status(pid)).toBe("proposed");
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM approvals").get()).toEqual({ n: 0 });
  });

  it("a different person can approve it, and the decision records that separation was enforced", async () => {
    const w = await world();
    const pid = await w.propose(w.admin);
    expect((await w.approve(pid, w.owner)).status).toBe(200);
    expect(w.s.db.prepare("SELECT separation FROM approvals WHERE proposal_id = ?").get(pid)).toEqual({ separation: "enforced" });
    const ev = w.s.db.prepare("SELECT detail FROM audit_events WHERE type = 'proposal.approved'").get() as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ separation: "enforced", separationEnforced: true });
    expect((await call(w.s.app, "GET", `${w.base}/proposals/${pid}`, w.owner.token)).body.approval.separation).toBe("enforced");
  });

  it("rejecting your own proposal is allowed (it is not an approval)", async () => {
    const w = await world();
    const pid = await w.propose(w.admin);
    expect((await call(w.s.app, "POST", `${w.base}/proposals/${pid}/reject`, w.admin.token, { decidedBy: "x", reason: "changed my mind" })).status).toBe(200);
  });

  it("a proposal whose proposer was never recorded cannot be proven separate, so a person's approval is refused", async () => {
    const w = await world();
    const pid = await w.propose(w.operator);
    w.s.db.prepare("UPDATE action_proposals SET proposed_by = NULL, proposed_by_kind = NULL WHERE id = ?").run(pid);
    expect((await w.approve(pid, w.admin)).body.error.code).toBe("separation_unprovable");
  });

  it("only an owner may change the policy; turning it off is audited and then recorded as policy_off on each approval", async () => {
    const w = await world();
    expect((await call(w.s.app, "GET", `${w.base}/policy`, w.operator.token)).body.preventSelfApproval).toBe(true);
    expect((await call(w.s.app, "PUT", `${w.base}/policy`, w.admin.token, { preventSelfApproval: false })).status).toBe(403);
    expect((await call(w.s.app, "PUT", `${w.base}/policy`, w.owner.token, { preventSelfApproval: false, extra: 1 })).status).toBe(400);
    expect((await call(w.s.app, "PUT", `${w.base}/policy`, w.owner.token, { preventSelfApproval: false })).body.preventSelfApproval).toBe(false);
    const ev = w.s.db.prepare("SELECT actor, detail FROM audit_events WHERE type = 'policy.changed'").get() as { actor: string; detail: string };
    expect(ev.actor).toBe(`user:${w.owner.id}`);
    expect(JSON.parse(ev.detail)).toEqual({ preventSelfApproval: { from: true, to: false } });
    const pid = await w.propose(w.admin);
    expect((await w.approve(pid, w.admin)).status).toBe(200);
    expect(w.s.db.prepare("SELECT separation FROM approvals WHERE proposal_id = ?").get(pid)).toEqual({ separation: "policy_off" });
  });

  it("another workspace's policy is untouched, and a person from another workspace cannot read or change this one's", async () => {
    const w = await world();
    const other = await person(w.s, "olga");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    await call(w.s.app, "PUT", `${w.base}/policy`, w.owner.token, { preventSelfApproval: false });
    expect((await call(w.s.app, "GET", `/api/workspaces/${W2}/policy`, other.token)).body.preventSelfApproval).toBe(true);
    expect((await call(w.s.app, "GET", `${w.base}/policy`, other.token)).status).toBe(404);
    expect((await call(w.s.app, "PUT", `${w.base}/policy`, other.token, { preventSelfApproval: true })).status).toBe(404);
  });
});

describe("local single-token mode: separation is not enforceable, and the record says so", () => {
  async function tokenWorld() {
    const s = boot("token");
    const { workspace, token } = createWorkspace(s.ctx, "Local Co");
    const base = `/api/workspaces/${workspace.id}`;
    await call(s.app, "PUT", `${base}/brain`, token, BRAIN);
    const cid = (await call(s.app, "POST", `${base}/campaigns/generate`, token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
    return { s, token, base, cid, wid: workspace.id };
  }

  it("the one workspace token can propose and approve, the approval is recorded as 'not_enforceable_token_mode', and it is never described as separation", async () => {
    const t = await tokenWorld();
    expect((await call(t.s.app, "GET", `${t.base}/policy`, t.token)).body.preventSelfApproval).toBe(true); // the policy is on...
    const pid = (await call(t.s.app, "POST", `${t.base}/campaigns/${t.cid}/proposals`, t.token, {})).body.id as string;
    expect((await call(t.s.app, "POST", `${t.base}/proposals/${pid}/approve`, t.token, { decidedBy: "me" })).status).toBe(200); // ...but cannot be enforced here
    expect(t.s.db.prepare("SELECT separation, approver_kind FROM approvals WHERE proposal_id = ?").get(pid)).toEqual({ separation: "not_enforceable_token_mode", approver_kind: "legacy_token" });
    const ev = t.s.db.prepare("SELECT detail FROM audit_events WHERE type = 'proposal.approved'").get() as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ separation: "not_enforceable_token_mode", separationEnforced: false });
    const view = (await call(t.s.app, "GET", `${t.base}/proposals/${pid}`, t.token)).body;
    expect(view.approval.separation).toBe("not_enforceable_token_mode");
    expect(view.proposedByKind).toBe("legacy_token");
    // and approving still did not run it
    expect(t.s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get()).toEqual({ n: 0 });
    expect((await call(t.s.app, "POST", `${t.base}/proposals/${pid}/execute`, t.token)).status).toBe(200); // the token is admin-equivalent: it may run simulated actions
    await t.s.worker.runUntilIdle();
    expect((t.s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pid) as { status: string }).status).toBe("executed");
  });

  it("the token still cannot change the policy (owner-only), so it cannot quietly switch separation off", async () => {
    const t = await tokenWorld();
    expect((await call(t.s.app, "PUT", `${t.base}/policy`, t.token, { preventSelfApproval: false })).status).toBe(403);
    expect((await call(t.s.app, "GET", `${t.base}/policy`, t.token)).body.preventSelfApproval).toBe(true);
  });
});
