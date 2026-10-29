import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { executeProposal } from "../src/app/executor.js";
import { activeMembership } from "../src/app/memberships.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { enqueueJob } from "../src/app/jobs.js";
import { PERMISSION_MIN_ROLE, ROLES, ROUTE_PERMISSIONS, roleAllows, routeKey, type Role } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OPEN_POLICY , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const runtime = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length) open.pop()?.();
});

function boot(env: Record<string, string> = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, runtime());
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}
type S = ReturnType<typeof boot>;
type Json = Record<string, any>;

async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts: { token?: string; payload?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.inject({ method, url, headers, payload: opts.payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}

const jwtFor = (name: string, extra: Record<string, unknown> = {}) => signJwt(rsa, claims({ sub: `idp|${name}`, name, ...extra }));
const count = (s: S, sql: string, ...args: unknown[]) => (s.db.prepare(sql).get(...args) as { n: number }).n;

/** Two workspaces owned by different people, with A staffed by one person per role, and a campaign and proposal in each. */
async function world() {
  const s = boot();
  const names = ["alice", "bob", "carol", "dave", "erin", "zed"] as const;
  const u = {} as Record<(typeof names)[number], { token: string; id: string }>;
  for (const n of names) {
    const token = jwtFor(n);
    const r = await call(s.app, "GET", "/api/me", { token });
    expect(r.status).toBe(200);
    u[n] = { token, id: r.body.user.id };
  }
  const mk = async (owner: { token: string }, name: string) => {
    const r = await call(s.app, "POST", "/api/workspaces", { token: owner.token, payload: { name } });
    expect(r.status).toBe(201);
    expect(r.body.token).toBeUndefined(); // a workspace created by a person has no workspace token
    return r.body.workspace.id as string;
  };
  const A = await mk(u.alice, "Alpha Co");
  const B = await mk(u.bob, "Bravo Co");
  const add = (w: string, owner: { token: string }, who: { id: string }, role: Role) => call(s.app, "POST", `/api/workspaces/${w}/members`, { token: owner.token, payload: { userId: who.id, role } });
  expect((await add(A, u.alice, u.carol, "admin")).status).toBe(201);
  expect((await add(A, u.alice, u.dave, "operator")).status).toBe(201);
  expect((await add(A, u.alice, u.erin, "viewer")).status).toBe(201);
  const seed = async (w: string, owner: { token: string }) => {
    const base = `/api/workspaces/${w}`;
    expect((await call(s.app, "PUT", `${base}/brain`, { token: owner.token, payload: BRAIN })).status).toBe(200);
    const gen = await call(s.app, "POST", `${base}/campaigns/generate`, { token: owner.token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
    expect(gen.status).toBe(201);
    await call(s.app, "PUT", `${base}/policy`, { token: owner.token, payload: { preventSelfApproval: false } }); // this test is not about separation of duties (see separationOfDuties.test.ts)
    const prop = await call(s.app, "POST", `${base}/campaigns/${gen.body.id}/proposals`, { token: owner.token, payload: {} });
    expect(prop.status).toBe(201);
    return { cid: gen.body.id as string, pid: prop.body.id as string };
  };
  const a = await seed(A, u.alice);
  const b = await seed(B, u.bob);
  return { s, u, A, B, a, b, add, baseA: `/api/workspaces/${A}`, baseB: `/api/workspaces/${B}` };
}

describe("membership: own workspace, several workspaces, no workspace", () => {
  it("a person reaches the workspaces they belong to, with the role they hold in each", async () => {
    const w = await world();
    expect((await call(w.s.app, "GET", w.baseA, { token: w.u.alice.token })).status).toBe(200);
    expect((await call(w.s.app, "GET", "/api/me/workspaces", { token: w.u.alice.token })).body.workspaces).toEqual([{ id: w.A, name: "Alpha Co", role: "owner" }]);
    expect((await call(w.s.app, "GET", "/api/me/workspaces", { token: w.u.bob.token })).body.workspaces).toEqual([{ id: w.B, name: "Bravo Co", role: "owner" }]);
  });
  it("one person can belong to several workspaces with a different role in each, and the two memberships do not mix", async () => {
    const w = await world();
    expect((await w.add(w.B, w.u.bob, w.u.alice, "viewer")).status).toBe(201);
    const list = (await call(w.s.app, "GET", "/api/me/workspaces", { token: w.u.alice.token })).body.workspaces as Array<{ id: string; role: string }>;
    expect(Object.fromEntries(list.map((x) => [x.id, x.role]))).toEqual({ [w.A]: "owner", [w.B]: "viewer" });
    expect((await call(w.s.app, "GET", `${w.baseB}/campaigns`, { token: w.u.alice.token })).status).toBe(200); // viewer: read
    expect((await call(w.s.app, "PUT", `${w.baseB}/brain`, { token: w.u.alice.token, payload: BRAIN })).status).toBe(403); // viewer: no write
    expect((await call(w.s.app, "PUT", `${w.baseA}/brain`, { token: w.u.alice.token, payload: BRAIN })).status).toBe(200); // owner of A: write
    expect((await call(w.s.app, "GET", `${w.baseB}/campaigns`, { token: w.u.carol.token })).status).toBe(404); // a member of A only
  });
  it("multiple users share one workspace", async () => {
    const w = await world();
    const members = (await call(w.s.app, "GET", `${w.baseA}/members`, { token: w.u.alice.token })).body.members as Array<{ userId: string; role: string }>;
    expect(Object.fromEntries(members.map((m) => [m.userId, m.role]))).toEqual({ [w.u.alice.id]: "owner", [w.u.carol.id]: "admin", [w.u.dave.id]: "operator", [w.u.erin.id]: "viewer" });
  });
  it("a verified person who is not a member gets exactly the answer a missing workspace gets, on every route", async () => {
    const w = await world();
    const routes = Object.keys(ROUTE_PERMISSIONS);
    for (const key of routes) {
      const [method, pattern] = key.split(" ") as ["GET", string];
      const url = (wid: string) => pattern.replace(":wid", wid).replace(":cid", w.a.cid).replace(":pid", w.a.pid).replace(":uid", w.u.erin.id);
      const real = await call(w.s.app, method, url(w.A), { token: w.u.bob.token, payload: method === "GET" ? undefined : {} });
      const ghost = await call(w.s.app, method, url("ws_does_not_exist"), { token: w.u.bob.token, payload: method === "GET" ? undefined : {} });
      expect([real.status, real.body], key).toEqual([404, ghost.body]);
    }
  });
});

describe("revocation and role changes take effect on the next request", () => {
  it("removing a member ends their access immediately; they can be re-added", async () => {
    const w = await world();
    expect((await call(w.s.app, "GET", w.baseA, { token: w.u.dave.token })).status).toBe(200);
    expect((await call(w.s.app, "DELETE", `${w.baseA}/members/${w.u.dave.id}`, { token: w.u.alice.token })).status).toBe(200);
    expect((await call(w.s.app, "GET", w.baseA, { token: w.u.dave.token })).status).toBe(404);
    expect(activeMembership(w.s.ctx, w.u.dave.id, w.A)).toBeNull();
    expect(w.s.db.prepare("SELECT status FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?").get(w.u.dave.id, w.A)).toEqual({ status: "revoked" });
    expect((await w.add(w.A, w.u.alice, w.u.dave, "viewer")).status).toBe(201); // reactivates the same row with the new role
    expect((await call(w.s.app, "GET", w.baseA, { token: w.u.dave.token })).status).toBe(200);
    expect((await call(w.s.app, "POST", `${w.baseA}/campaigns/generate`, { token: w.u.dave.token, payload: {} })).status).toBe(403);
    expect(count(w.s, "SELECT COUNT(*) n FROM workspace_memberships WHERE user_id = ? AND workspace_id = ?", w.u.dave.id, w.A)).toBe(1);
  });
  it("lowering a role takes effect immediately", async () => {
    const w = await world();
    expect((await call(w.s.app, "PUT", `${w.baseA}/brain`, { token: w.u.carol.token, payload: BRAIN })).status).toBe(200);
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${w.u.carol.id}`, { token: w.u.alice.token, payload: { role: "viewer" } })).status).toBe(200);
    expect((await call(w.s.app, "PUT", `${w.baseA}/brain`, { token: w.u.carol.token, payload: BRAIN })).status).toBe(403);
    expect((await call(w.s.app, "GET", `${w.baseA}/brain`, { token: w.u.carol.token })).status).toBe(200);
  });
  it("a role written into the token is ignored: the database decides", async () => {
    const w = await world();
    const sly = jwtFor("erin", { role: "owner", roles: ["owner"], workspace: w.A, wid: w.A, "https://claims/role": "owner", is_admin: true });
    expect((await call(w.s.app, "PUT", `${w.baseA}/brain`, { token: sly, payload: BRAIN })).status).toBe(403);
    expect((await call(w.s.app, "POST", `${w.baseA}/members`, { token: sly, payload: { userId: w.u.zed.id, role: "owner" } })).status).toBe(403);
  });
});

describe("the permission matrix is enforced centrally, for every route and every role", () => {
  it("pins the policy so it cannot drift silently", () => {
    expect(PERMISSION_MIN_ROLE).toEqual({
      "workspace.read": "viewer", "brain.read": "viewer", "campaigns.read": "viewer", "proposals.read": "viewer", "leads.read": "viewer", "activity.read": "viewer",
      "ai.settings.read": "viewer", "ai.usage.read": "viewer", "jobs.read": "operator", "campaigns.generate": "operator", "campaigns.edit": "operator",
      "proposals.create": "operator", "leads.simulate": "operator", "leads.update": "operator", "jobs.retry": "admin", "proposals.decide": "admin", "brain.write": "admin", "workspace.update": "admin",
      "ai.settings.write": "admin", "ai.connection_test": "admin", "members.read": "admin", "meta_accounts.read": "admin", "credentials.read": "admin", "members.manage": "owner", "meta_accounts.manage": "owner", "credentials.manage": "owner", "legacy_token.disable": "owner", "proposals.execute": "admin", "roles.manage": "owner", "policy.manage": "owner",
      "plans.read": "viewer", "plans.write": "operator", "plans.review": "admin", "campaigns.archive": "admin", "brandkit.read": "viewer", "brandkit.write": "operator", "brandkit.approve": "admin", "assets.read": "viewer", "assets.write": "operator", "assets.review": "admin", "assets.archive": "admin", "creatives.read": "viewer", "creatives.write": "operator", "creatives.review": "admin", "leads.import": "operator", "data.export": "admin", "leads.erase": "admin", "usage.read": "admin", "integrations.read": "admin", "integrations.test": "admin", "experiments.read": "viewer", "experiments.write": "operator", "experiments.decide": "admin", "learnings.read": "viewer", "learnings.write": "operator", "learnings.confirm": "admin", "recommendations.read": "viewer", "recommendations.decide": "admin", "forms.read": "viewer", "forms.write": "operator", "analytics.read": "viewer", "tasks.read": "viewer", "tasks.write": "operator", "assignments.manage": "admin",
    });
    expect(ROLES).toEqual(["viewer", "operator", "admin", "owner"]);
    expect(roleAllows("operator", "proposals.decide")).toBe(false); // operators cannot approve
    expect(roleAllows("admin", "members.manage")).toBe(false); // admins cannot manage ownership or membership
    expect(roleAllows("viewer", "campaigns.edit")).toBe(false);
    expect(roleAllows("owner", "members.manage")).toBe(true);
  });
  it("every workspace route has a declared permission, and every declared permission is a real route", async () => {
    const w = await world();
    await w.s.app.ready();
    const real = new Set(w.s.app.routeTable.filter((r) => r.url.startsWith("/api/workspaces/:wid")).map((r) => routeKey(r.method, r.url)));
    expect([...real].sort()).toEqual(Object.keys(ROUTE_PERMISSIONS).sort());
    for (const p of Object.values(ROUTE_PERMISSIONS)) expect(PERMISSION_MIN_ROLE).toHaveProperty(p);
  });
  it("allows exactly what the matrix says, route by route, for each role", async () => {
    const w = await world();
    const byRole: Record<Role, string> = { viewer: w.u.erin.token, operator: w.u.dave.token, admin: w.u.carol.token, owner: w.u.alice.token };
    const payloads: Record<string, unknown> = {
      "PATCH /api/workspaces/:wid": { metaAccountId: null }, "PUT /api/workspaces/:wid/brain": BRAIN,
      "POST /api/workspaces/:wid/campaigns/generate": { providerId: "mock", model: "mock-deterministic-1" },
      "PUT /api/workspaces/:wid/ai/settings": { routingMode: "automatic" },
      "POST /api/workspaces/:wid/ai/connection-test": { provider: "mock", model: "mock-deterministic-1" },
      "POST /api/workspaces/:wid/members": { userId: w.u.zed.id, role: "viewer" }, "PATCH /api/workspaces/:wid/members/:uid": { role: "viewer" },
      "POST /api/workspaces/:wid/proposals/:pid/approve": { decidedBy: "t" }, "POST /api/workspaces/:wid/proposals/:pid/reject": { decidedBy: "t" },
    };
    for (const role of ["viewer", "operator", "admin", "owner"] as Role[]) {
      for (const [key, permission] of Object.entries(ROUTE_PERMISSIONS)) {
        const [method, pattern] = key.split(" ") as ["GET", string];
        const url = pattern.replace(":wid", w.A).replace(":cid", w.a.cid).replace(":pid", w.a.pid).replace(":uid", w.u.zed.id);
        const r = await call(w.s.app, method, url, { token: byRole[role], payload: method === "GET" ? undefined : (payloads[key] ?? {}) });
        if (roleAllows(role, permission)) expect([401, 403], `${role} ${key} should pass authorization`).not.toContain(r.status);
        else expect(r.status, `${role} ${key} should be refused`).toBe(403);
      }
    }
  });
  it("operators run campaign work but cannot approve; viewers cannot change anything; admins cannot touch ownership", async () => {
    const w = await world();
    const { dave, erin, carol, alice } = w.u;
    expect((await call(w.s.app, "POST", `${w.baseA}/campaigns/generate`, { token: dave.token, payload: { providerId: "mock", model: "mock-deterministic-1" } })).status).toBe(201);
    expect((await call(w.s.app, "POST", `${w.baseA}/campaigns/${w.a.cid}/proposals`, { token: dave.token, payload: {} })).status).toBeLessThan(500);
    const before = count(w.s, "SELECT COUNT(*) n FROM approvals");
    expect((await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/approve`, { token: dave.token, payload: { decidedBy: "Dave" } })).status).toBe(403);
    expect(count(w.s, "SELECT COUNT(*) n FROM approvals")).toBe(before);
    expect(w.s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(w.a.pid)).toEqual({ status: "proposed" });
    for (const [m, p, body] of [["PUT", "/brain", BRAIN], ["POST", "/campaigns/generate", {}], ["PUT", `/campaigns/${w.a.cid}/brief`, {}], ["POST", `/campaigns/${w.a.cid}/proposals`, {}], ["PUT", "/ai/settings", { routingMode: "automatic" }]] as const) {
      expect((await call(w.s.app, m, `${w.baseA}${p}`, { token: erin.token, payload: body })).status, `viewer ${m} ${p}`).toBe(403);
    }
    // an admin cannot transfer ownership, grant it, or manage members
    expect((await call(w.s.app, "POST", `${w.baseA}/members`, { token: carol.token, payload: { userId: w.u.zed.id, role: "owner" } })).status).toBe(403);
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${carol.id}`, { token: carol.token, payload: { role: "owner" } })).status).toBe(403);
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${alice.id}`, { token: carol.token, payload: { role: "viewer" } })).status).toBe(403);
    expect((await call(w.s.app, "DELETE", `${w.baseA}/members/${alice.id}`, { token: carol.token })).status).toBe(403);
    expect(activeMembership(w.s.ctx, alice.id, w.A)?.role).toBe("owner");
    expect(activeMembership(w.s.ctx, carol.id, w.A)?.role).toBe("admin");
  });
});

describe("ownership rules", () => {
  it("only an owner creates owners; a workspace always keeps at least one", async () => {
    const w = await world();
    const { alice, carol } = w.u;
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${alice.id}`, { token: alice.token, payload: { role: "admin" } })).body.error.code).toBe("last_owner");
    expect((await call(w.s.app, "DELETE", `${w.baseA}/members/${alice.id}`, { token: alice.token })).body.error.code).toBe("last_owner");
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${carol.id}`, { token: alice.token, payload: { role: "owner" } })).status).toBe(200); // transfer: promote first
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${alice.id}`, { token: alice.token, payload: { role: "admin" } })).status).toBe(200); // then step down
    expect(activeMembership(w.s.ctx, carol.id, w.A)?.role).toBe("owner");
    expect((await call(w.s.app, "DELETE", `${w.baseA}/members/${carol.id}`, { token: carol.token })).body.error.code).toBe("last_owner");
    expect(count(w.s, "SELECT COUNT(*) n FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner' AND status = 'active'", w.A)).toBe(1);
  });
  it("validates membership requests: unknown user, duplicates, bad roles and extra fields", async () => {
    const w = await world();
    const t = w.u.alice.token;
    expect((await call(w.s.app, "POST", `${w.baseA}/members`, { token: t, payload: { userId: "usr_nobody", role: "viewer" } })).status).toBe(404);
    expect((await call(w.s.app, "POST", `${w.baseA}/members`, { token: t, payload: { userId: w.u.erin.id, role: "viewer" } })).body.error.code).toBe("already_member");
    expect((await call(w.s.app, "POST", `${w.baseA}/members`, { token: t, payload: { userId: w.u.zed.id, role: "superuser" } })).status).toBe(400);
    expect((await call(w.s.app, "POST", `${w.baseA}/members`, { token: t, payload: { userId: w.u.zed.id, role: "viewer", workspaceId: w.B } })).status).toBe(400);
    expect((await call(w.s.app, "PATCH", `${w.baseA}/members/${w.u.zed.id}`, { token: t, payload: { role: "viewer" } })).status).toBe(404); // not a member
    expect(count(w.s, "SELECT COUNT(*) n FROM workspace_memberships WHERE user_id = ?", w.u.zed.id)).toBe(0);
  });
  it("records who changed a membership, from the authenticated actor", async () => {
    const w = await world();
    await call(w.s.app, "PATCH", `${w.baseA}/members/${w.u.dave.id}`, { token: w.u.alice.token, payload: { role: "admin" } });
    const ev = w.s.db.prepare("SELECT actor, detail FROM audit_events WHERE type = 'membership.role_changed' AND workspace_id = ?").get(w.A) as { actor: string; detail: string };
    expect(ev.actor).toBe(`user:${w.u.alice.id}`);
    expect(JSON.parse(ev.detail)).toEqual({ from: "operator", to: "admin" });
  });
});

describe("forged identity, role, workspace and approver are ignored or rejected", () => {
  it("client-supplied user ids, roles, workspace ids and approver fields do nothing", async () => {
    const w = await world();
    const e = w.u.erin.token;
    const before = count(w.s, "SELECT COUNT(*) n FROM approvals");
    for (const extra of [{ userId: w.u.alice.id }, { role: "owner" }, { workspaceId: w.B }, { approverId: w.u.alice.id }, { approvedBy: w.u.alice.id }]) {
      expect((await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/approve`, { token: w.u.carol.token, payload: { decidedBy: "x", ...extra } })).status, JSON.stringify(extra)).toBe(400);
    }
    expect(count(w.s, "SELECT COUNT(*) n FROM approvals")).toBe(before);
    const sneaky = { "x-user-id": w.u.alice.id, "x-role": "owner", "x-workspace-id": w.A, cookie: `role=owner; user=${w.u.alice.id}` };
    expect((await call(w.s.app, "PUT", `${w.baseA}/brain?role=owner&userId=${w.u.alice.id}`, { token: e, payload: BRAIN, headers: sneaky })).status).toBe(403);
    expect((await call(w.s.app, "PUT", `${w.baseA}/ai/settings`, { token: e, payload: { routingMode: "automatic", role: "owner" } })).status).toBe(403);
  });
});

describe("guessed ids from another workspace reach nothing", () => {
  it("every id-addressed route answers 404 for a resource of another workspace, and changes nothing there", async () => {
    const w = await world();
    const bob = w.u.bob.token; // owner of B, using A's ids inside B's URL
    const snapshot = () => JSON.stringify([
      w.s.db.prepare("SELECT * FROM campaigns WHERE workspace_id = ? ORDER BY id").all(w.A), w.s.db.prepare("SELECT * FROM action_proposals WHERE workspace_id = ? ORDER BY id").all(w.A),
      w.s.db.prepare("SELECT * FROM approvals WHERE workspace_id = ?").all(w.A), w.s.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE workspace_id = ?").all(w.A),
    ]);
    const before = snapshot();
    const tries: Array<[string, string, unknown]> = [
      ["GET", `/campaigns/${w.a.cid}`, undefined], ["PUT", `/campaigns/${w.a.cid}/brief`, {}], ["POST", `/campaigns/${w.a.cid}/proposals`, {}],
      ["POST", `/campaigns/${w.a.cid}/simulate-lead`, { fullName: "X Y", email: "x@y.test" }], ["GET", `/proposals/${w.a.pid}`, undefined],
      ["POST", `/proposals/${w.a.pid}/approve`, { decidedBy: "b" }], ["POST", `/proposals/${w.a.pid}/reject`, { decidedBy: "b" }],
    ];
    for (const [m, p, body] of tries) {
      const r = await call(w.s.app, m as "GET", `${w.baseB}${p}`, { token: bob, payload: body });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    expect(snapshot()).toBe(before);
  });
  it("list and view endpoints return only the caller's own workspace data", async () => {
    const w = await world();
    for (const p of ["/campaigns", "/leads", "/activity", "/jobs", "/ai/usage", "/ai/settings", "/members"]) {
      const text = JSON.stringify((await call(w.s.app, "GET", `${w.baseB}${p}`, { token: w.u.bob.token })).body);
      expect(text, p).not.toContain(w.A);
      expect(text, p).not.toContain(w.a.cid);
      expect(text, p).not.toContain(w.a.pid);
      expect(text, p).not.toContain(w.u.carol.id);
    }
  });
  it("a background job that names another workspace's proposal does nothing to it", async () => {
    const w = await world();
    await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/approve`, { token: w.u.alice.token, payload: { decidedBy: "a" } });
    await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/execute`, { token: w.u.alice.token });
    w.s.db.prepare("UPDATE jobs SET status = 'done' WHERE workspace_id = ?").run(w.A); // park A's real job
    enqueueJob(w.s.ctx, w.B, "execute_proposal", { proposalId: w.a.pid }, "forged:1"); // a job in B pointing at A's proposal
    await w.s.worker.runUntilIdle();
    expect(w.s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(w.a.pid)).toEqual({ status: "approved" }); // untouched
    expect(count(w.s, "SELECT COUNT(*) n FROM execution_attempts")).toBe(0);
    await expect(executeProposal(w.s.ctx, w.B, w.a.pid)).rejects.toThrow(/not found/i);
  });
});

describe("approval attribution comes from the authenticated user", () => {
  it("records the user's stable id, role-checked membership and the typed name only as an unverified label", async () => {
    const w = await world();
    const r = await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/approve`, { token: w.u.carol.token, payload: { decidedBy: `user:${w.u.alice.id}`, reason: "ok" } });
    expect(r.status).toBe(200);
    expect(w.s.db.prepare("SELECT decided_by, approver_kind, approver_user_id, claimed_label FROM approvals WHERE proposal_id = ?").get(w.a.pid)).toEqual({
      decided_by: `user:${w.u.carol.id}`, approver_kind: "user", approver_user_id: w.u.carol.id, claimed_label: `user:${w.u.alice.id}`,
    });
    const ev = w.s.db.prepare("SELECT actor, detail FROM audit_events WHERE type = 'proposal.approved' AND entity_id = ?").get(w.a.pid) as { actor: string; detail: string };
    expect(ev.actor).toBe(`user:${w.u.carol.id}`);
    expect(JSON.parse(ev.detail)).toMatchObject({ claimedLabelVerified: false });
    expect((await call(w.s.app, "GET", `${w.baseA}/proposals/${w.a.pid}`, { token: w.u.carol.token })).body.status).toBe("approved"); // approving alone ran nothing
    expect((await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/execute`, { token: w.u.carol.token })).status).toBe(200);
    await w.s.worker.runUntilIdle();
    expect((await call(w.s.app, "GET", `${w.baseA}/proposals/${w.a.pid}`, { token: w.u.carol.token })).body.status).toBe("executed"); // the allowed path still works end to end
  });
  it("other audited changes are attributed to the user who made them", async () => {
    const w = await world();
    await call(w.s.app, "PUT", `${w.baseA}/brain`, { token: w.u.carol.token, payload: BRAIN });
    await call(w.s.app, "PUT", `${w.baseA}/ai/settings`, { token: w.u.carol.token, payload: { routingMode: "automatic" } });
    const actors = (w.s.db.prepare("SELECT DISTINCT actor FROM audit_events WHERE workspace_id = ? AND type IN ('brain.saved','ai.settings_saved') AND actor LIKE 'user:%'").all(w.A) as Array<{ actor: string }>).map((x) => x.actor);
    expect(actors).toContain(`user:${w.u.carol.id}`);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE workspace_id = ? AND actor = 'owner'").get(w.A)).toEqual({ n: 0 }); // no hard-coded "owner" any more on the HTTP path
  });
});

describe("the executor re-checks the approver at execution time", () => {
  async function approvedBy(who: "carol" | "alice") {
    const w = await world();
    const r = await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/approve`, { token: w.u[who].token, payload: { decidedBy: "x" } });
    await call(w.s.app, "POST", `${w.baseA}/proposals/${w.a.pid}/execute`, { token: w.u[who].token });
    expect(r.status).toBe(200);
    return w;
  }
  const outcome = (w: Awaited<ReturnType<typeof approvedBy>>) => ({
    proposal: w.s.db.prepare("SELECT status, last_error FROM action_proposals WHERE id = ?").get(w.a.pid),
    resources: count(w.s, "SELECT COUNT(*) n FROM external_resources WHERE proposal_id = ?", w.a.pid),
    attempts: count(w.s, "SELECT COUNT(*) n FROM execution_attempts WHERE proposal_id = ?", w.a.pid),
    refused: count(w.s, "SELECT COUNT(*) n FROM audit_events WHERE type = 'execution.refused' AND entity_id = ?", w.a.pid),
  });

  it("still executes when the approver remains authorized", async () => {
    const w = await approvedBy("carol");
    await w.s.worker.runUntilIdle();
    expect(outcome(w)).toMatchObject({ proposal: { status: "executed" }, resources: 1 });
  });
  it("fails closed when the approver was removed after approving", async () => {
    const w = await approvedBy("carol");
    await call(w.s.app, "DELETE", `${w.baseA}/members/${w.u.carol.id}`, { token: w.u.alice.token });
    await w.s.worker.runUntilIdle();
    expect(outcome(w)).toEqual({ proposal: { status: "failed", last_error: "approver_not_authorized" }, resources: 0, attempts: 0, refused: 1 });
  });
  it("fails closed when the approver's role dropped below the approval role", async () => {
    const w = await approvedBy("carol");
    await call(w.s.app, "PATCH", `${w.baseA}/members/${w.u.carol.id}`, { token: w.u.alice.token, payload: { role: "operator" } });
    await w.s.worker.runUntilIdle();
    expect(outcome(w)).toMatchObject({ proposal: { status: "failed", last_error: "approver_not_authorized" }, resources: 0 });
  });
  it("is not fooled by the approver being re-added later as a lesser role, or by someone else holding their old role", async () => {
    const w = await approvedBy("carol");
    await call(w.s.app, "DELETE", `${w.baseA}/members/${w.u.carol.id}`, { token: w.u.alice.token });
    await w.add(w.A, w.u.alice, w.u.carol, "viewer");
    await w.add(w.A, w.u.alice, w.u.zed, "admin");
    await w.s.worker.runUntilIdle();
    expect(outcome(w).proposal).toEqual({ status: "failed", last_error: "approver_not_authorized" });
  });
  it("trusted code that approves without an identity records an 'unverified' approver (live use is covered in authzFixes.test.ts)", async () => {
    const w = await world();
    const { decideProposal, requestExecution } = await import("../src/app/proposals.js");
    decideProposal(w.s.ctx, w.A, w.a.pid, "approve", { decidedBy: "trusted-code" }); // no approver identity
    requestExecution(w.s.ctx, w.A, w.a.pid, "trusted-code");
    expect(w.s.db.prepare("SELECT approver_kind FROM approvals WHERE proposal_id = ?").get(w.a.pid)).toEqual({ approver_kind: "unverified" });
    await w.s.worker.runUntilIdle(); // simulated action: allowed
    expect(outcome(w as never).proposal).toMatchObject({ status: "executed" });
  });
});

describe("the legacy workspace token during the transition", () => {
  it("acts as a bounded principal: it works, but is never a user and never an owner", async () => {
    const w = await world();
    const { workspace, token } = createWorkspace(w.s.ctx, "Old Co");
    const base = `/api/workspaces/${workspace.id}`;
    expect((await call(w.s.app, "PUT", `${base}/brain`, { token, payload: BRAIN })).status).toBe(200);
    expect((await call(w.s.app, "GET", `${base}/members`, { token })).status).toBe(200);
    expect((await call(w.s.app, "POST", `${base}/members`, { token, payload: { userId: w.u.zed.id, role: "owner" } })).status).toBe(403);
    expect((await call(w.s.app, "POST", `${base}/legacy-token/disable`, { token })).status).toBe(403);
    for (const p of ["/api/me", "/api/me/workspaces"]) expect((await call(w.s.app, "GET", p, { token })).status).toBe(401);
    expect((await call(w.s.app, "POST", "/api/workspaces/claim", { token, payload: { workspaceId: workspace.id, token } })).status).toBe(401);
    expect(count(w.s, "SELECT COUNT(*) n FROM workspace_memberships WHERE workspace_id = ?", workspace.id)).toBe(0);
  });
  it("new workspaces cannot be created anonymously or with a token once an identity provider is configured", async () => {
    const w = await world();
    expect((await call(w.s.app, "POST", "/api/workspaces", { payload: { name: "Nope" } })).status).toBe(401);
    const { token } = createWorkspace(w.s.ctx, "Old Co");
    expect((await call(w.s.app, "POST", "/api/workspaces", { token, payload: { name: "Nope" } })).status).toBe(401);
    const row = w.s.db.prepare("SELECT legacy_token_disabled_at d FROM workspaces WHERE id = ?").get(w.A) as { d: string | null };
    expect(row.d).not.toBeNull(); // a person-created workspace has no usable token
  });
  it("an approval made with the token stops authorizing a write once an owner disables the token", async () => {
    const w = await world();
    const { workspace, token } = createWorkspace(w.s.ctx, "Old Co");
    const base = `/api/workspaces/${workspace.id}`;
    await call(w.s.app, "PUT", `${base}/brain`, { token, payload: BRAIN });
    const gen = await call(w.s.app, "POST", `${base}/campaigns/generate`, { token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
    const prop = await call(w.s.app, "POST", `${base}/campaigns/${gen.body.id}/proposals`, { token, payload: {} });
    await call(w.s.app, "POST", `${base}/proposals/${prop.body.id}/approve`, { token, payload: { decidedBy: "Pat" } });
    await call(w.s.app, "POST", `${base}/proposals/${prop.body.id}/execute`, { token });
    expect(w.s.db.prepare("SELECT approver_kind, approver_user_id, decided_by FROM approvals WHERE proposal_id = ?").get(prop.body.id)).toEqual({ approver_kind: "legacy_token", approver_user_id: null, decided_by: `workspace-token:${workspace.id}` });
    expect((await call(w.s.app, "POST", "/api/workspaces/claim", { token: w.u.zed.token, payload: { workspaceId: workspace.id, token } })).status).toBe(200);
    expect((await call(w.s.app, "POST", `${base}/legacy-token/disable`, { token: w.u.zed.token })).status).toBe(200);
    expect((await call(w.s.app, "GET", base, { token })).status).toBe(401); // the token no longer opens anything
    await w.s.worker.runUntilIdle();
    expect(w.s.db.prepare("SELECT status, last_error FROM action_proposals WHERE id = ?").get(prop.body.id)).toEqual({ status: "failed", last_error: "approver_not_authorized" });
  });
});

describe("claiming a workspace that predates memberships", () => {
  it("leaves existing workspaces unclaimed, and a person with the token becomes its first owner, once", async () => {
    const w = await world();
    const { workspace, token } = createWorkspace(w.s.ctx, "Old Co");
    expect(count(w.s, "SELECT COUNT(*) n FROM workspace_memberships WHERE workspace_id = ?", workspace.id)).toBe(0);
    const claim = (who: { token: string }, t: string, id = workspace.id) => call(w.s.app, "POST", "/api/workspaces/claim", { token: who.token, payload: { workspaceId: id, token: t } });
    expect((await call(w.s.app, "GET", `/api/workspaces/${workspace.id}`, { token: w.u.zed.token })).status).toBe(404); // signed in, not a member
    expect((await claim(w.u.zed, "msw_wrong")).status).toBe(404);
    expect((await claim(w.u.zed, token, "ws_nope")).status).toBe(404);
    const ok = await claim(w.u.zed, token);
    expect(ok.status).toBe(200);
    expect(ok.body.role).toBe("owner");
    expect(JSON.stringify(ok.body)).not.toContain(token);
    expect(activeMembership(w.s.ctx, w.u.zed.id, workspace.id)?.role).toBe("owner");
    expect((await claim(w.u.erin, token)).body.error.code).toBe("already_claimed"); // the token cannot be used to take over or add owners
    expect((await call(w.s.app, "GET", `/api/workspaces/${workspace.id}`, { token: w.u.erin.token })).status).toBe(404);
    const ev = w.s.db.prepare("SELECT actor FROM audit_events WHERE type = 'workspace.claimed' AND workspace_id = ?").get(workspace.id) as { actor: string };
    expect(ev.actor).toBe(`user:${w.u.zed.id}`);
    expect(JSON.stringify(w.s.db.prepare("SELECT detail FROM audit_events WHERE workspace_id = ?").all(workspace.id))).not.toContain(token);
  });
  it("is refused once the token is disabled, and for a claim body that carries extra fields", async () => {
    const w = await world();
    const { workspace, token } = createWorkspace(w.s.ctx, "Old Co");
    expect((await call(w.s.app, "POST", "/api/workspaces/claim", { token: w.u.zed.token, payload: { workspaceId: workspace.id, token, role: "owner", userId: w.u.alice.id } })).status).toBe(400);
    w.s.db.prepare("UPDATE workspaces SET legacy_token_disabled_at = 'x' WHERE id = ?").run(workspace.id);
    expect((await call(w.s.app, "POST", "/api/workspaces/claim", { token: w.u.zed.token, payload: { workspaceId: workspace.id, token } })).status).toBe(404);
  });
});

describe("migration 005 on a database that already has data", () => {
  function oldDb() {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of ["001_init.sql", "002_ai.sql", "003_generation_identity.sql", "004_users.sql"]) {
      db.exec(readFileSync(`src/db/migrations/${f}`, "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
    }
    return db;
  }
  it("backfills nothing it cannot know: workspaces stay unclaimed, history is kept, approvals are classified deterministically", () => {
    const db = oldDb();
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_old','Old','h','t')").run();
    db.prepare("INSERT INTO users (id, issuer, subject, created_at, last_seen_at) VALUES ('usr_1','i','s','t','t')").run();
    db.prepare("INSERT INTO campaigns (id, workspace_id, name, status, current_version, created_at) VALUES ('cmp_1','ws_old','c','draft',1,'t')").run();
    for (const p of ["prp_1", "prp_2"]) db.prepare("INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at) VALUES (?, 'ws_old','cmp_1',1,'t','{}','h',1,'mock','approved','t','t')").run(p);
    for (const [id, proposal, by] of [["apr_1", "prp_1", "workspace-token:ws_old"], ["apr_2", "prp_2", "elia"]] as const) {
      db.prepare("INSERT INTO approvals (id, workspace_id, proposal_id, decision, decided_by, payload_hash, campaign_version, integration_mode, decided_at, expires_at) VALUES (?, 'ws_old', ?, 'approve', ?, 'h',1,'mock','t','t')").run(id, proposal, by);
    }
    expect(migrate(db)).toEqual(["005_memberships.sql", "006_meta_accounts.sql", "007_credentials.sql", "008_drop_credential_hint.sql", "009_website_analysis.sql", "010_website_content_hash.sql", "011_ai_reservations.sql", "012_reservation_state_and_fill_ledger.sql", "013_campaign_plans.sql", "014_lead_status_job_retries.sql", "015_organizations_permissions.sql", "016_brand_kit_assets.sql", "017_plans_lifecycle.sql", "018_creative_studio.sql", "019_team_operations.sql", "020_lead_lineage_forms.sql", "021_experiments_learnings.sql", "022_integration_tests.sql", "023_audit_append_only.sql"]);
    expect(count({ db } as S, "SELECT COUNT(*) n FROM workspace_memberships")).toBe(0); // no owner is invented
    expect(db.prepare("SELECT id, approver_kind, approver_user_id FROM approvals ORDER BY id").all()).toEqual([
      { id: "apr_1", approver_kind: "legacy_token", approver_user_id: null },
      { id: "apr_2", approver_kind: "unverified", approver_user_id: null },
    ]);
    expect(db.prepare("SELECT id, name, legacy_token_disabled_at d FROM workspaces").all()).toEqual([{ id: "ws_old", name: "Old", d: null }]);
    expect(db.prepare("SELECT * FROM campaigns").all()).toHaveLength(1);
    db.close();
  });
  it("rejects a role outside the four, a duplicate membership, and a status outside active/revoked", () => {
    const db = openDb(":memory:");
    migrate(db);
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('w','W','h','t')").run();
    db.prepare("INSERT INTO users (id, issuer, subject, created_at, last_seen_at) VALUES ('u','i','s','t','t')").run();
    const ins = (id: string, role: string, status = "active") => () => db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, status, created_at, created_by, updated_at) VALUES (?, 'w','u',?,?, 't','x','t')").run(id, role, status);
    expect(ins("m1", "superuser")).toThrow(/CHECK/);
    expect(ins("m1", "owner", "pending")).toThrow(/CHECK/);
    expect(ins("m1", "owner")).not.toThrow();
    expect(ins("m2", "viewer")).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO workspace_memberships (id, workspace_id, user_id, role, created_at, created_by, updated_at) VALUES ('m3','nope','u','viewer','t','x','t')").run()).toThrow(/FOREIGN KEY/);
    db.close();
  });
});

describe("the database itself refuses cross-workspace children and workspace changes", () => {
  it("rejects a child row whose parent belongs to another workspace, and any change of a row's workspace", () => {
    const db = openDb(":memory:");
    migrate(db);
    for (const w of ["w1", "w2"]) db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES (?, ?, 'h', 't')").run(w, w);
    db.prepare("INSERT INTO campaigns (id, workspace_id, name, status, current_version, created_at) VALUES ('c1','w1','c','draft',1,'t')").run();
    db.prepare("INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at) VALUES ('p1','w1','c1',1,'t','{}','h',1,'mock','approved','t','t')").run();
    db.prepare("INSERT INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES ('e1','w1','s','e','c1','{}',1,'t')").run();
    db.prepare("INSERT INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, simulated, created_at) VALUES ('l1','w1','c1','e1','n',1,'t')").run();
    const bad: Array<[string, string]> = [
      ["campaign_versions", "INSERT INTO campaign_versions (campaign_id, workspace_id, version, brief, source, created_at) VALUES ('c1','w2',1,'{}','ai','t')"],
      ["campaign_assets", "INSERT INTO campaign_assets (id, campaign_id, workspace_id, version, kind, position, content) VALUES ('a','c1','w2',1,'headline',0,'x')"],
      ["action_proposals", "INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at) VALUES ('p2','w2','c1',1,'t','{}','h',1,'mock','proposed','t','t')"],
      ["approvals", "INSERT INTO approvals (id, workspace_id, proposal_id, decision, decided_by, payload_hash, campaign_version, integration_mode, decided_at, expires_at) VALUES ('a1','w2','p1','approve','x','h',1,'mock','t','t')"],
      ["execution_attempts", "INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, started_at) VALUES ('x1','w2','p1',1,'started','t')"],
      ["external_resources", "INSERT INTO external_resources (id, workspace_id, platform, kind, external_id, proposal_id, campaign_id, verified_state, verified_at, simulated) VALUES ('r1','w2','meta','campaign','e','p1','c1','PAUSED','t',1)"],
      ["lead_events", "INSERT INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES ('e2','w2','s','e2','c1','{}',1,'t')"],
      ["leads", "INSERT INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, simulated, created_at) VALUES ('l2','w2','c1','e1','n',1,'t')"],
      ["crm_syncs", "INSERT INTO crm_syncs (id, workspace_id, lead_id, platform, contact_id, created_contact, simulated, synced_at) VALUES ('s1','w2','l1','ghl','c',1,1,'t')"],
    ];
    for (const [table, sql] of bad) expect(() => db.prepare(sql).run(), table).toThrow(/workspace mismatch/);
    // the same inserts under the parent's own workspace are accepted
    expect(() => db.prepare(bad[0]![1].replace("'w2'", "'w1'")).run()).not.toThrow();
    expect(() => db.prepare("UPDATE campaigns SET workspace_id = 'w2' WHERE id = 'c1'").run()).toThrow(/cannot change/);
    expect(() => db.prepare("UPDATE action_proposals SET workspace_id = 'w2' WHERE id = 'p1'").run()).toThrow(/cannot change/);
    expect(() => db.prepare("UPDATE leads SET workspace_id = 'w2' WHERE id = 'l1'").run()).toThrow(/cannot change/);
    db.close();
  });
});
