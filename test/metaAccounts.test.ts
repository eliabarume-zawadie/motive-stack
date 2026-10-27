/**
 * Milestone 4.2.2: a workspace may use only the Meta ad accounts explicitly authorized for it.
 * "Live" here means the server believes Meta is live; the platform connector is a spy object that records every call, so nothing
 * touches Meta or the network (and the test network blocker stays active). The workspace guard and the database checks are the REAL ones.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { executeProposal } from "../src/app/executor.js";
import { authorizeMetaAccount, isMetaAccountAuthorized } from "../src/app/metaAccounts.js";
import { createWorkspaceForUser } from "../src/app/memberships.js";
import { hashPayload } from "../src/app/proposals.js";
import { upsertUser } from "../src/app/users.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { MetaApiError } from "../src/connector/meta/errors.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { readFileSync } from "node:fs";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OPEN_POLICY , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const FIXTURE_TOKEN = "FIXTURE-TOKEN-NOT-A-SECRET";
const ENV = { INTEGRATION_MODE: "live", LIVE_META: "true", META_ACCESS_TOKEN: FIXTURE_TOKEN, META_WRITE_ALLOWLIST: "act_111,act_222,act_333" };
const runtime = () => buildAuthRuntime(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
const ident = (n: string) => ({ issuer: ISSUER, subject: `idp|${n}`, email: null, displayName: n });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts: { token?: string; payload?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await app.inject({ method, url, headers, payload: opts.payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
const n = (db: Db, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

/** A spy standing in for the platform. It records every call; the guard in front of it is the real one. */
function makeSpy() {
  const spy = {
    calls: [] as string[],
    create: [] as Array<{ accountId: string; approvedBy: string }>,
    failNext: null as null | "transient" | "timeout",
    onCreate: null as null | (() => void), // lets a test change authorization in the middle of a call
    knownName: "",
    listResult: [] as unknown[],
    count: (m: string) => spy.calls.filter((c) => c === m).length,
  };
  const connector: any = {
    getAuthorizedAccounts: async () => (spy.calls.push("getAuthorizedAccounts"), ["act_111", "act_222", "act_333", "act_999"].map((id) => ({ id, name: id, status: "active" }))),
    getAdAccountDetails: async (id: string) => (spy.calls.push("getAdAccountDetails"), { id, name: id, status: "active" }),
    listCampaigns: async () => (spy.calls.push("listCampaigns"), spy.listResult),
    createCampaignDraft: async (i: any, g: any) => {
      spy.calls.push("createCampaignDraft");
      spy.create.push({ accountId: i.accountId, approvedBy: g.approvedBy });
      spy.knownName = i.name;
      spy.onCreate?.();
      if (spy.failNext === "transient") { spy.failNext = null; throw new MetaApiError("transient", "temporary failure"); }
      if (spy.failNext === "timeout") { spy.failNext = null; throw new MetaApiError("timeout", "lost response", { outcomeUnknown: true }); }
      return { id: `ext_${spy.create.length}`, name: i.name, status: "PAUSED", effectiveStatus: "PAUSED", objective: i.objective };
    },
    getCampaignStatus: async (id: string) => (spy.calls.push("getCampaignStatus"), { id, name: spy.knownName, status: "PAUSED", effectiveStatus: "PAUSED", objective: "x" }),
    listLeadForms: async () => (spy.calls.push("listLeadForms"), []),
    retrieveLead: async () => (spy.calls.push("retrieveLead"), {}),
  };
  return { spy, connector };
}

async function world() {
  const db = openDb(":memory:");
  migrate(db);
  const { spy, connector } = makeSpy();
  const ctx: AppContext = buildContext({ db, env: ENV, backoffMs: () => 0, gateway: { sleep: async () => {} }, metaConnector: () => connector });
  const app = buildServer(ctx, runtime());
  cleanups.push(() => db.open && db.close());
  const worker = createWorker(ctx);
  const u = {} as Record<"alice" | "bob" | "carol" | "dave" | "erin" | "zed", { token: string; id: string }>;
  for (const name of ["alice", "bob", "carol", "dave", "erin", "zed"] as const) {
    const token = jwtFor(name);
    u[name] = { token, id: (await call(app, "GET", "/api/me", { token })).body.user.id };
  }
  const mk = async (owner: { token: string }, name: string) => (await call(app, "POST", "/api/workspaces", { token: owner.token, payload: { name } })).body.workspace.id as string;
  const A = await mk(u.alice, "Alpha Co");
  const B = await mk(u.bob, "Bravo Co");
  for (const [who, role] of [["carol", "admin"], ["dave", "operator"], ["erin", "viewer"]] as const) {
    expect((await call(app, "POST", `/api/workspaces/${A}/members`, { token: u.alice.token, payload: { userId: u[who].id, role } })).status).toBe(201);
  }
  const auth = (token: string, wid: string, accountId: unknown) => call(app, "POST", `/api/workspaces/${wid}/meta-accounts`, { token, payload: { accountId } });
  const pick = (token: string, wid: string, accountId: string | null) => call(app, "PATCH", `/api/workspaces/${wid}`, { token, payload: { metaAccountId: accountId } });
  const accounts = async (token: string, wid: string) => (await call(app, "GET", `/api/workspaces/${wid}/meta-accounts`, { token })).body.accounts as Array<{ accountId: string; status: string }>;
  /** Brain, campaign and a live proposal for `wid`, after authorizing and choosing `account`. */
  const prepare = async (owner: { token: string }, wid: string, account: string) => {
    expect((await auth(owner.token, wid, account)).status).toBe(201);
    expect((await pick(owner.token, wid, account)).status).toBe(200);
    const base = `/api/workspaces/${wid}`;
    expect((await call(app, "PUT", `${base}/brain`, { token: owner.token, payload: BRAIN })).status).toBe(200);
    const gen = await call(app, "POST", `${base}/campaigns/generate`, { token: owner.token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
    const prop = await call(app, "POST", `${base}/campaigns/${gen.body.id}/proposals`, { token: owner.token, payload: {} });
    expect([gen.status, prop.status, prop.body.mode, prop.body.payload?.accountId]).toEqual([201, 201, "live", account]);
    return { base, pid: prop.body.id as string, approve: () => call(app, "POST", `${base}/proposals/${prop.body.id}/approve`, { token: owner.token, payload: { decidedBy: "a" } }) };
  };
  return { db, ctx, app, worker, spy, u, A, B, auth, pick, accounts, prepare };
}
type W = Awaited<ReturnType<typeof world>>;
const st = (w: W, pid: string) => ({
  proposal: w.db.prepare("SELECT status, last_error FROM action_proposals WHERE id = ?").get(pid) as { status: string; last_error: string | null },
  attempts: n(w.db, "SELECT COUNT(*) n FROM execution_attempts WHERE proposal_id = ?", pid),
  resources: n(w.db, "SELECT COUNT(*) n FROM external_resources WHERE proposal_id = ?", pid),
});
const untouched = (w: W) => expect(w.spy.calls).toEqual([]);
const retarget = (w: W, pid: string, accountId: string) => {
  // an attacker with database access rewrites the account and recomputes every hash, so only the authorization check can stop it
  const row = w.db.prepare("SELECT payload FROM action_proposals WHERE id = ?").get(pid) as { payload: string };
  const payload = { ...JSON.parse(row.payload), accountId };
  const hash = hashPayload(payload);
  w.db.prepare("UPDATE action_proposals SET payload = ?, payload_hash = ? WHERE id = ?").run(JSON.stringify(payload), hash, pid);
  w.db.prepare("UPDATE approvals SET payload_hash = ? WHERE proposal_id = ?").run(hash, pid);
};

describe("tenant isolation: a workspace reaches only the accounts authorized for it", () => {
  it("another workspace's account cannot be authorized, selected or managed, and the refusals look like any other refusal", async () => {
    const w = await world();
    expect((await w.auth(w.u.bob.token, w.B, "act_111")).status).toBe(201);
    const held = await w.auth(w.u.alice.token, w.A, "act_111"); // held by Bravo
    const off = await w.auth(w.u.alice.token, w.A, "act_999"); // not on the operator's allow-list
    expect([held.status, held.body]).toEqual([off.status, off.body]);
    expect(held.body.error.code).toBe("meta_account_unavailable");
    const pick = await w.pick(w.u.carol.token, w.A, "act_111"); // an admin choosing it
    expect([pick.status, pick.body.error.code]).toEqual([409, "meta_account_not_authorized"]);
    expect(w.db.prepare("SELECT meta_account_id m FROM workspaces WHERE id = ?").get(w.A)).toEqual({ m: null });
    expect(await w.accounts(w.u.alice.token, w.A)).toEqual([]);
    expect((await w.accounts(w.u.bob.token, w.B)).map((a) => a.accountId)).toEqual(["act_111"]);
    expect(n(w.db, "SELECT COUNT(*) n FROM workspace_meta_accounts WHERE account_id = 'act_111'")).toBe(1);
  });

  it("another workspace cannot disable or revoke it, and a real account looks exactly like a missing one", async () => {
    const w = await world();
    await w.auth(w.u.bob.token, w.B, "act_111");
    const ours = `/api/workspaces/${w.A}/meta-accounts`;
    for (const [m, suffix] of [["POST", "/disable"], ["DELETE", ""]] as const) {
      const real = await call(w.app, m, `${ours}/act_111${suffix}`, { token: w.u.alice.token });
      const none = await call(w.app, m, `${ours}/act_424242${suffix}`, { token: w.u.alice.token });
      const junk = await call(w.app, m, `${ours}/not-an-account${suffix}`, { token: w.u.alice.token });
      expect([real.status, real.body]).toEqual([404, none.body]);
      expect(junk.body).toEqual(none.body);
    }
    expect(n(w.db, "SELECT COUNT(*) n FROM workspace_meta_accounts WHERE account_id = 'act_111' AND status = 'active' AND workspace_id = ?", w.B)).toBe(1);
  });

  it("an entry on the global allow-list authorizes nobody: no selection, no proposal, and no connector call", async () => {
    const w = await world();
    expect((await w.pick(w.u.alice.token, w.A, "act_222")).status).toBe(409);
    w.db.prepare("UPDATE workspaces SET meta_account_id = 'act_222' WHERE id = ?").run(w.A); // an old or hand-edited setting
    const handle = w.ctx.metaFor(w.A);
    expect([handle.accountId, handle.configuredAccountId, handle.mode]).toEqual([null, "act_222", "live"]);
    const base = `/api/workspaces/${w.A}`;
    await call(w.app, "PUT", `${base}/brain`, { token: w.u.alice.token, payload: BRAIN });
    const gen = await call(w.app, "POST", `${base}/campaigns/generate`, { token: w.u.alice.token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
    const prop = await call(w.app, "POST", `${base}/campaigns/${gen.body.id}/proposals`, { token: w.u.alice.token, payload: {} });
    expect([prop.status, prop.body.error.code]).toEqual([409, "meta_account_not_authorized"]);
    const view = await call(w.app, "GET", base, { token: w.u.alice.token });
    expect([view.body.metaAccountId, view.body.metaAccountAuthorized]).toEqual(["act_222", false]);
    await expect(handle.connector.listCampaigns("act_222")).rejects.toMatchObject({ kind: "permission" });
    await expect(handle.connector.getAdAccountDetails("act_222")).rejects.toMatchObject({ kind: "permission" });
    untouched(w);
  });

  it("changing request bodies, headers, or stored references to another workspace's account does not help", async () => {
    const w = await world();
    await w.auth(w.u.bob.token, w.B, "act_111");
    const p = await w.prepare(w.u.alice, w.A, "act_222");
    // bodies and headers
    expect((await call(w.app, "PATCH", `/api/workspaces/${w.A}`, { token: w.u.alice.token, payload: { metaAccountId: "act_222", accountId: "act_111" } })).status).toBe(400);
    expect((await call(w.app, "POST", `/api/workspaces/${w.A}/meta-accounts`, { token: w.u.alice.token, payload: { accountId: "act_333", workspaceId: w.B } })).status).toBe(400);
    const prop2 = await call(w.app, "POST", `${p.base}/campaigns/${(await call(w.app, "GET", `${p.base}/campaigns`, { token: w.u.alice.token })).body[0].id}/proposals`, { token: w.u.alice.token, payload: { accountId: "act_111" }, headers: { "x-meta-account-id": "act_111", "x-account": "act_111" } });
    expect([prop2.status === 201 || prop2.status === 409, prop2.body.payload?.accountId ?? "act_222"]).toEqual([true, "act_222"]); // the workspace's own account, whatever was sent
    // a stored proposal rewritten to Bravo's account, hashes recomputed
    expect((await p.approve()).status).toBe(200);
    retarget(w, p.pid, "act_111");
    await w.worker.runUntilIdle();
    expect(st(w, p.pid)).toEqual({ proposal: { status: "failed", last_error: "meta_account_not_authorized" }, attempts: 0, resources: 0 });
    untouched(w);
  });

  it("guards the connector itself: every call names an account, and an unauthorized one is refused before the platform is reached", async () => {
    const w = await world();
    expect((await w.auth(w.u.alice.token, w.A, "act_111")).status).toBe(201);
    await w.auth(w.u.bob.token, w.B, "act_222");
    const c = w.ctx.metaFor(w.A).connector;
    const grant = { workspaceId: w.A, accountId: "act_222", action: "create_campaign_draft" as const, actionVersion: 1, approvedBy: "x", expiresAt: "2999-01-01T00:00:00Z" };
    await expect(c.getAdAccountDetails("act_222")).rejects.toMatchObject({ kind: "permission" });
    await expect(c.listCampaigns("act_222")).rejects.toMatchObject({ kind: "permission" });
    await expect(c.createCampaignDraft({ workspaceId: w.A, accountId: "act_222", name: "n", objective: "OUTCOME_LEADS" }, grant)).rejects.toMatchObject({ kind: "permission" });
    await expect(c.getCampaignStatus("12345")).rejects.toMatchObject({ kind: "permission" }); // an id this workspace never saw
    await expect(c.listLeadForms("1")).rejects.toMatchObject({ kind: "permission" });
    await expect(c.retrieveLead("1")).rejects.toMatchObject({ kind: "permission" });
    await expect(c.getAdAccountDetails("ACT_111")).rejects.toMatchObject({ kind: "permission" }); // not the canonical spelling
    untouched(w);
    // what the shared token can see is filtered to what this workspace may use
    expect((await c.getAuthorizedAccounts()).map((a) => a.id)).toEqual(["act_111"]);
    expect(w.spy.calls).toEqual(["getAuthorizedAccounts"]);
    // an authorized account works, and campaigns learned from it can be read until the authorization goes
    w.spy.listResult = [{ id: "777", name: "x", status: "PAUSED", effectiveStatus: "PAUSED", objective: "o" }];
    await c.listCampaigns("act_111");
    await expect(c.getCampaignStatus("777")).resolves.toMatchObject({ id: "777" });
    await call(w.app, "DELETE", `/api/workspaces/${w.A}/meta-accounts/act_111`, { token: w.u.alice.token });
    await expect(c.getCampaignStatus("777")).rejects.toMatchObject({ kind: "permission" });
    await expect(c.listCampaigns("act_111")).rejects.toMatchObject({ kind: "permission" });
    // a write also needs the operator's allow-list, even for an account that is authorized in the table
    w.db.prepare("INSERT INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES ('m1', ?, 'act_444', 'active', 'owner_assertion', 't','x','t','x')").run(w.A);
    await expect(c.createCampaignDraft({ workspaceId: w.A, accountId: "act_444", name: "n", objective: "OUTCOME_LEADS" }, { ...grant, accountId: "act_444" })).rejects.toMatchObject({ kind: "permission" });
    expect(w.spy.count("createCampaignDraft")).toBe(0);
  });

  it("with nothing authorized the connector does not even ask the platform what it can see", async () => {
    const w = await world();
    expect(await w.ctx.metaFor(w.A).connector.getAuthorizedAccounts()).toEqual([]);
    untouched(w);
  });

  it("an ambiguous holder (two workspaces both active) fails closed for both", async () => {
    const w = await world();
    w.db.exec("DROP INDEX uq_meta_account_holder"); // only a damaged or tampered database could get here
    for (const ws of [w.A, w.B]) w.db.prepare("INSERT INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES (?,?, 'act_111','active','owner_assertion','t','x','t','x')").run(`m_${ws}`, ws);
    expect([isMetaAccountAuthorized(w.ctx, w.A, "act_111"), isMetaAccountAuthorized(w.ctx, w.B, "act_111")]).toEqual([false, false]);
    await expect(w.ctx.metaFor(w.A).connector.listCampaigns("act_111")).rejects.toMatchObject({ kind: "permission" });
    untouched(w);
  });
});

describe("who may manage account authorizations", () => {
  it("only an owner can authorize, disable or revoke; admins may read and choose among authorized accounts; everyone else is refused", async () => {
    const w = await world();
    await w.auth(w.u.alice.token, w.A, "act_111");
    const legacy = createWorkspace(w.ctx, "Old Co");
    const base = `/api/workspaces/${w.A}/meta-accounts`;
    const who: Array<[string, string | undefined, number, number]> = [ // [label, token, manage status, read status]
      ["viewer", w.u.erin.token, 403, 403], ["operator", w.u.dave.token, 403, 403], ["admin", w.u.carol.token, 403, 200],
      ["non-member", w.u.bob.token, 404, 404], ["anonymous", undefined, 401, 401],
    ];
    for (const [label, token, manage, read] of who) {
      expect((await call(w.app, "POST", base, { token, payload: { accountId: "act_222" } })).status, `${label} authorize`).toBe(manage);
      expect((await call(w.app, "POST", `${base}/act_111/disable`, { token })).status, `${label} disable`).toBe(manage);
      expect((await call(w.app, "DELETE", `${base}/act_111`, { token })).status, `${label} revoke`).toBe(manage);
      expect((await call(w.app, "GET", base, { token })).status, `${label} read`).toBe(read);
    }
    // the legacy workspace token is admin-equivalent: it cannot manage, and cannot choose an account nobody authorized
    const lbase = `/api/workspaces/${legacy.workspace.id}`;
    expect((await call(w.app, "POST", `${lbase}/meta-accounts`, { token: legacy.token, payload: { accountId: "act_333" } })).status).toBe(403);
    expect((await call(w.app, "PATCH", lbase, { token: legacy.token, payload: { metaAccountId: "act_333" } })).status).toBe(409);
    // an admin can choose an authorized account, and can clear the choice
    expect((await w.pick(w.u.carol.token, w.A, "act_111")).status).toBe(200);
    expect((await w.pick(w.u.carol.token, w.A, null)).status).toBe(200);
    expect(await w.accounts(w.u.alice.token, w.A)).toMatchObject([{ accountId: "act_111", status: "active" }]);
    expect(n(w.db, "SELECT COUNT(*) n FROM workspace_meta_accounts")).toBe(1);
  });

  it("rejects malformed account ids everywhere, and stores nothing for them", async () => {
    const w = await world();
    for (const bad of ["ACT_111", "act_", "act_0111", "act_11x", "act_ 111", " act_111", "act_111 ", `act_${"9".repeat(21)}`, "111", "", 111, null, { id: "act_111" }, ["act_111"]]) {
      expect((await w.auth(w.u.alice.token, w.A, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await w.pick(w.u.alice.token, w.A, "act_0111")).status).toBe(409); // the legacy request schema lets it through; the canonical check refuses it as not authorized
    expect(n(w.db, "SELECT COUNT(*) n FROM workspace_meta_accounts")).toBe(0);
  });

  it("every change is audited with the real actor, workspace and account, and nothing secret", async () => {
    const w = await world();
    await w.auth(w.u.alice.token, w.A, "act_111");
    await call(w.app, "POST", `/api/workspaces/${w.A}/meta-accounts/act_111/disable`, { token: w.u.alice.token });
    await w.auth(w.u.alice.token, w.A, "act_111");
    await call(w.app, "DELETE", `/api/workspaces/${w.A}/meta-accounts/act_111`, { token: w.u.alice.token });
    await w.pick(w.u.carol.token, w.A, null);
    const ev = w.db.prepare("SELECT type, actor, workspace_id, entity_id, detail FROM audit_events WHERE type LIKE 'meta_account.%' ORDER BY id").all() as Array<Record<string, string>>;
    expect(ev.map((e) => e.type)).toEqual(["meta_account.authorized", "meta_account.disabled", "meta_account.authorized", "meta_account.revoked"]);
    for (const e of ev) expect([e.actor, e.workspace_id, e.entity_id]).toEqual([`user:${w.u.alice.id}`, w.A, "act_111"]);
    expect(JSON.parse(ev[2]!.detail as string)).toMatchObject({ reactivated: true, source: "owner_assertion" });
    const setting = w.db.prepare("SELECT actor FROM audit_events WHERE type = 'workspace.meta_account_set'").get() as { actor: string };
    expect(setting.actor).toBe(`user:${w.u.carol.id}`);
    expect(JSON.stringify(w.db.prepare("SELECT * FROM audit_events").all())).not.toContain(FIXTURE_TOKEN);
  });
});

describe("the authorization lifecycle governs execution", () => {
  it("control: with an authorization, a signed-in owner's approval executes against that account only", async () => {
    const w = await world();
    const p = await w.prepare(w.u.alice, w.A, "act_111");
    expect((await p.approve()).status).toBe(200);
    await w.worker.runUntilIdle();
    expect(st(w, p.pid)).toEqual({ proposal: { status: "executed", last_error: null }, attempts: 1, resources: 1 });
    expect(w.spy.create).toEqual([{ accountId: "act_111", approvedBy: `user:${w.u.alice.id}` }]);
    expect((await call(w.app, "GET", `/api/workspaces/${w.A}`, { token: w.u.alice.token })).body.metaAccountAuthorized).toBe(true);
  });

  it("disabling or revoking blocks the next execution, re-authorizing restores it, and a revoked account can move to another workspace", async () => {
    const w = await world();
    const p = await w.prepare(w.u.alice, w.A, "act_111");
    await p.approve();
    await call(w.app, "POST", `/api/workspaces/${w.A}/meta-accounts/act_111/disable`, { token: w.u.alice.token });
    expect((await call(w.app, "GET", `/api/workspaces/${w.A}`, { token: w.u.alice.token })).body.metaAccountAuthorized).toBe(false);
    await w.worker.runUntilIdle();
    expect(st(w, p.pid)).toEqual({ proposal: { status: "failed", last_error: "meta_account_not_authorized" }, attempts: 0, resources: 0 });
    expect(w.spy.create).toHaveLength(0);
    expect((await w.auth(w.u.bob.token, w.B, "act_111")).status).toBe(409); // a disabled account is still held by Alpha
    // a fresh proposal is impossible while it is disabled, and possible again after re-authorizing
    const gen = await call(w.app, "GET", `${p.base}/campaigns`, { token: w.u.alice.token });
    const again = () => call(w.app, "POST", `${p.base}/campaigns/${gen.body[0].id}/proposals`, { token: w.u.alice.token, payload: {} });
    expect((await again()).body.error?.code).toBe("meta_account_not_authorized");
    await w.auth(w.u.alice.token, w.A, "act_111");
    const prop = await again();
    expect([prop.status, prop.body.payload.accountId]).toEqual([201, "act_111"]);
    await call(w.app, "POST", `${p.base}/proposals/${prop.body.id}/approve`, { token: w.u.alice.token, payload: { decidedBy: "a" } });
    await call(w.app, "DELETE", `/api/workspaces/${w.A}/meta-accounts/act_111`, { token: w.u.alice.token });
    await w.worker.runUntilIdle();
    expect(st(w, prop.body.id).proposal).toEqual({ status: "failed", last_error: "meta_account_not_authorized" });
    expect(w.spy.create).toHaveLength(0);
    expect((await w.auth(w.u.bob.token, w.B, "act_111")).status).toBe(201); // revoked: free for Bravo
    expect(isMetaAccountAuthorized(w.ctx, w.A, "act_111")).toBe(false);
  });

  it("changing which account the workspace uses cannot revive an approval made for the old one", async () => {
    const w = await world();
    const p = await w.prepare(w.u.alice, w.A, "act_111");
    await p.approve();
    await call(w.app, "DELETE", `/api/workspaces/${w.A}/meta-accounts/act_111`, { token: w.u.alice.token });
    await w.auth(w.u.alice.token, w.A, "act_222");
    expect((await w.pick(w.u.carol.token, w.A, "act_222")).status).toBe(200);
    await w.worker.runUntilIdle();
    expect(st(w, p.pid).proposal).toEqual({ status: "failed", last_error: "meta_account_not_authorized" });
    untouched(w);
  });

  it("retry: a transient failure is retried, then authorization is found withdrawn and there is no second send", async () => {
    const w = await world();
    const p = await w.prepare(w.u.alice, w.A, "act_111");
    await p.approve();
    w.spy.failNext = "transient";
    await w.worker.runUntilIdle(1);
    expect(st(w, p.pid)).toMatchObject({ proposal: { status: "approved" }, attempts: 1 });
    await call(w.app, "DELETE", `/api/workspaces/${w.A}/meta-accounts/act_111`, { token: w.u.alice.token });
    await w.worker.runUntilIdle();
    expect(st(w, p.pid)).toEqual({ proposal: { status: "failed", last_error: "meta_account_not_authorized" }, attempts: 1, resources: 0 });
    expect(w.spy.create).toHaveLength(1);
  });

  it("crash recovery: nothing is sent, read or reconciled once the authorization is gone; with it, reconciliation still works", async () => {
    for (const dispatched of [0, 1] as const) {
      const w = await world();
      const p = await w.prepare(w.u.alice, w.A, "act_111");
      await p.approve();
      w.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(p.pid);
      w.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('att_1', ?, ?, 1, 'started', ?, 't')").run(w.A, p.pid, dispatched);
      await call(w.app, "POST", `/api/workspaces/${w.A}/meta-accounts/act_111/disable`, { token: w.u.alice.token });
      await executeProposal(w.ctx, w.A, p.pid);
      expect(st(w, p.pid).proposal, `dispatched=${dispatched}`).toEqual(dispatched ? { status: "needs_review", last_error: "meta_account_not_authorized" } : { status: "failed", last_error: "meta_account_not_authorized" });
      untouched(w);
    }
    const w = await world(); // control
    const p = await w.prepare(w.u.alice, w.A, "act_111");
    await p.approve();
    const name = (JSON.parse((w.db.prepare("SELECT payload FROM action_proposals WHERE id = ?").get(p.pid) as { payload: string }).payload) as { name: string }).name;
    w.spy.knownName = name;
    w.spy.listResult = [{ id: "ext_9", name, status: "PAUSED", effectiveStatus: "PAUSED", objective: "o" }];
    w.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(p.pid);
    w.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('att_1', ?, ?, 1, 'started', 1, 't')").run(w.A, p.pid);
    await executeProposal(w.ctx, w.A, p.pid);
    expect(st(w, p.pid)).toMatchObject({ proposal: { status: "executed" }, resources: 1 });
    expect([w.spy.count("listCampaigns"), w.spy.count("createCampaignDraft")]).toEqual([1, 0]);
  });

  it("reconciliation cannot query another workspace's account, even if a proposal is rewritten to point at it", async () => {
    const w = await world();
    await w.auth(w.u.bob.token, w.B, "act_333");
    const p = await w.prepare(w.u.alice, w.A, "act_111");
    await p.approve();
    retarget(w, p.pid, "act_333");
    w.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(p.pid);
    w.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('att_1', ?, ?, 1, 'started', 1, 't')").run(w.A, p.pid);
    await executeProposal(w.ctx, w.A, p.pid);
    expect(st(w, p.pid).proposal).toEqual({ status: "needs_review", last_error: "meta_account_not_authorized" });
    untouched(w);
  });

  it("authorization withdrawn in the middle of a run: an unknown-outcome reconcile and the read-back verification both stop and ask a person", async () => {
    for (const mode of ["lost response", "success"] as const) {
      const w = await world();
      const p = await w.prepare(w.u.alice, w.A, "act_111");
      await p.approve();
      w.spy.onCreate = () => void w.db.prepare("UPDATE workspace_meta_accounts SET status = 'revoked' WHERE account_id = 'act_111'").run(); // revoked while the call is in flight
      if (mode === "lost response") w.spy.failNext = "timeout";
      await w.worker.runUntilIdle();
      expect(st(w, p.pid).proposal, mode).toEqual({ status: "needs_review", last_error: "meta_account_not_authorized" });
      expect(w.spy.count("createCampaignDraft"), mode).toBe(1); // the one authorized send
      expect([w.spy.count("listCampaigns"), w.spy.count("getCampaignStatus")], mode).toEqual([0, 0]); // and no read on the withdrawn account
      expect(n(w.db, "SELECT COUNT(*) n FROM external_resources")).toBe(0);
      expect(n(w.db, "SELECT COUNT(*) n FROM audit_events WHERE type = 'execution.refused' AND entity_id = ?", p.pid)).toBe(1);
    }
  });

  it("legacy-token approvals still cannot authorize a live write, even for an authorized account", async () => {
    const w = await world();
    const legacy = createWorkspace(w.ctx, "Old Co");
    const lbase = `/api/workspaces/${legacy.workspace.id}`;
    w.db.prepare("INSERT INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES ('m1', ?, 'act_333', 'active', 'owner_assertion', 't','fixture','t','fixture')").run(legacy.workspace.id);
    w.db.prepare("UPDATE workspaces SET meta_account_id = 'act_333' WHERE id = ?").run(legacy.workspace.id);
    await call(w.app, "PUT", `${lbase}/brain`, { token: legacy.token, payload: BRAIN });
    const gen = await call(w.app, "POST", `${lbase}/campaigns/generate`, { token: legacy.token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
    const prop = await call(w.app, "POST", `${lbase}/campaigns/${gen.body.id}/proposals`, { token: legacy.token, payload: {} });
    expect(prop.status).toBe(201);
    const r = await call(w.app, "POST", `${lbase}/proposals/${prop.body.id}/approve`, { token: legacy.token, payload: { decidedBy: "x" } });
    expect([r.status, r.body.error.code]).toEqual([403, "live_requires_signed_in_approver"]);
    untouched(w);
  });

  it("the other execution gates still hold for an authorized account: expiry, payload hash, mode, budget cap, missing approval", async () => {
    const cases: Array<[string, (w: W, pid: string) => void | Promise<void>, string]> = [
      ["expired", (w, pid) => void w.db.prepare("UPDATE approvals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE proposal_id = ?").run(pid), "approval_expired"],
      ["tampered", (w, pid) => void w.db.prepare("UPDATE action_proposals SET payload = json_set(payload, '$.name', 'Tampered') WHERE id = ?").run(pid), "payload_tampered"],
      ["mode", (w, pid) => void w.db.prepare("UPDATE approvals SET integration_mode = 'mock' WHERE proposal_id = ?").run(pid), "mode_mismatch"],
      ["budget", async (w) => void (await call(w.app, "PUT", `/api/workspaces/${w.A}/brain`, { token: w.u.alice.token, payload: { ...BRAIN, maxDailyBudgetCents: 100 } })), "budget_exceeds_cap"],
      ["no approval", (w, pid) => void w.db.prepare("DELETE FROM approvals WHERE proposal_id = ?").run(pid), "no_approval"],
    ];
    for (const [name, tweak, reason] of cases) {
      const w = await world();
      const p = await w.prepare(w.u.alice, w.A, "act_111");
      await p.approve();
      await tweak(w, p.pid);
      await w.worker.runUntilIdle();
      expect(st(w, p.pid).proposal, name).toMatchObject({ last_error: reason });
      expect(w.spy.create, name).toHaveLength(0);
    }
  });
});

describe("authorizing the same account from two connections", () => {
  it("when another workspace takes the account between the check and the write, this one is refused and exactly one holder remains", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-meta-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "m.db");
    const dbA = openDb(file);
    migrate(dbA);
    const dbB = openDb(file);
    cleanups.push(() => { if (dbA.open) dbA.close(); if (dbB.open) dbB.close(); });
    const ctxA = buildContext({ db: dbA, env: ENV });
    const ctxB = buildContext({ db: dbB, env: ENV });
    const x = upsertUser(ctxA, ident("xavier"));
    const y = upsertUser(ctxA, ident("yara"));
    const wx = createWorkspaceForUser(ctxA, userActor(x.id) as never, "X Co");
    const wy = createWorkspaceForUser(ctxA, userActor(y.id) as never, "Y Co");
    let injected = 0;
    const racing = new Proxy(dbA, {
      get(t, p) {
        if (p === "transaction") return (fn: never) => { if (!injected++) authorizeMetaAccount(ctxB, userActor(y.id), wy.id, "act_111"); return t.transaction(fn); };
        const v = (t as never as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    expect(() => authorizeMetaAccount({ ...ctxA, db: racing as never }, userActor(x.id), wx.id, "act_111")).toThrow(/cannot be authorized/);
    expect(dbA.prepare("SELECT workspace_id FROM workspace_meta_accounts WHERE account_id = 'act_111'").all()).toEqual([{ workspace_id: wy.id }]);
  });
});

describe("authorization holds the write lock while it decides", () => {
  it("a rival that tries to take the same account mid-transaction is turned away, and the first authorization completes as sole holder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-meta-lock-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "m.db");
    const dbA = openDb(file);
    migrate(dbA);
    const rival = openDb(file);
    rival.pragma("busy_timeout = 25"); // fail fast instead of waiting five seconds
    cleanups.push(() => { if (dbA.open) dbA.close(); if (rival.open) rival.close(); });
    const ctxA = buildContext({ db: dbA, env: ENV });
    const ctxRival = buildContext({ db: rival, env: ENV });
    const x = upsertUser(ctxA, ident("xavier"));
    const y = upsertUser(ctxA, ident("yara"));
    const wx = createWorkspaceForUser(ctxA, userActor(x.id) as never, "X Co");
    const wy = createWorkspaceForUser(ctxA, userActor(y.id) as never, "Y Co");
    let rivalOutcome: { status?: number; code?: string } | "authorized" | null = null;
    const racing = new Proxy(dbA, {
      get(t, p) {
        if (p === "prepare") {
          return (sql: string) => {
            const st = t.prepare(sql);
            if (!sql.startsWith("INSERT INTO workspace_meta_accounts")) return st;
            return new Proxy(st, {
              get(s, k) {
                if (k === "run") {
                  return (...a: unknown[]) => {
                    try { authorizeMetaAccount(ctxRival, userActor(y.id), wy.id, "act_111"); rivalOutcome = "authorized"; } catch (e) { rivalOutcome = e as { status?: number; code?: string }; }
                    return (s as never as { run: (...q: unknown[]) => unknown }).run(...a);
                  };
                }
                const v = (s as never as Record<string | symbol, unknown>)[k];
                return typeof v === "function" ? (v as (...q: unknown[]) => unknown).bind(s) : v;
              },
            });
          };
        }
        const v = (t as never as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...q: unknown[]) => unknown).bind(t) : v;
      },
    });
    authorizeMetaAccount({ ...ctxA, db: racing as never }, userActor(x.id), wx.id, "act_111");
    expect(rivalOutcome).toMatchObject({ status: 503, code: "busy" });
    expect(dbA.prepare("SELECT workspace_id FROM workspace_meta_accounts WHERE account_id = 'act_111'").all()).toEqual([{ workspace_id: wx.id }]);
  });
});

describe("migration 006 and unchanged behavior elsewhere", () => {
  function oldDb() {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of ["001_init.sql", "002_ai.sql", "003_generation_identity.sql", "004_users.sql", "005_memberships.sql"]) {
      db.exec(readFileSync(`src/db/migrations/${f}`, "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
    }
    return db;
  }

  it("keeps existing data, authorizes nothing, and leaves a live workspace with no usable account until an owner acts", async () => {
    const db = oldDb();
    db.prepare("INSERT INTO workspaces (id, name, token_hash, meta_account_id, created_at) VALUES ('ws_old','Old Co','h','act_111','t')").run();
    db.prepare("INSERT INTO workspaces (id, name, token_hash, meta_account_id, created_at) VALUES ('ws_two','Two Co','h2','act_111','t')").run(); // two workspaces already claiming one account
    const before = db.prepare("SELECT * FROM workspaces ORDER BY id").all();
    expect(migrate(db)).toEqual(["006_meta_accounts.sql", "007_credentials.sql", "008_drop_credential_hint.sql", "009_website_analysis.sql", "010_website_content_hash.sql"]);
    expect(db.prepare("SELECT * FROM workspaces ORDER BY id").all()).toEqual(before);
    expect(n(db, "SELECT COUNT(*) n FROM workspace_meta_accounts")).toBe(0);
    const { connector } = makeSpy();
    const ctx = buildContext({ db, env: ENV, metaConnector: () => connector });
    for (const ws of ["ws_old", "ws_two"]) {
      const h = ctx.metaFor(ws);
      expect([h.accountId, h.configuredAccountId, isMetaAccountAuthorized(ctx, ws, "act_111")]).toEqual([null, "act_111", false]);
    }
    db.close();
  });

  it("enforces the format, status, source and holder rules in the database itself", () => {
    const db = openDb(":memory:");
    migrate(db);
    for (const w of ["w1", "w2"]) db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES (?,?, 'h','t')").run(w, w);
    const ins = (id: string, ws: string, account: string, status = "active", source = "owner_assertion") => () =>
      db.prepare("INSERT INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,'t','x','t','x')").run(id, ws, account, status, source);
    for (const bad of ["ACT_1", "act_", "act_0", "act_01", "act_1x", "act_1 ", "1", `act_${"1".repeat(21)}`]) expect(ins("m", "w1", bad), bad).toThrow(/CHECK/);
    expect(ins("m", "w1", "act_1", "paused")).toThrow(/CHECK/);
    expect(ins("m", "w1", "act_1", "active", "guess")).toThrow(/CHECK/);
    expect(ins("m", "nope", "act_1")).toThrow(/FOREIGN KEY/);
    expect(ins("m1", "w1", "act_1")).not.toThrow();
    expect(ins("m2", "w2", "act_1")).toThrow(/UNIQUE/); // held
    expect(ins("m3", "w1", "act_1", "disabled")).toThrow(/UNIQUE/); // same workspace, same account
    db.prepare("UPDATE workspace_meta_accounts SET status = 'disabled' WHERE id = 'm1'").run();
    expect(ins("m2", "w2", "act_1")).toThrow(/UNIQUE/); // disabled still holds it
    db.prepare("UPDATE workspace_meta_accounts SET status = 'revoked' WHERE id = 'm1'").run();
    expect(ins("m2", "w2", "act_1")).not.toThrow(); // revoked releases it, history stays
    expect(() => db.prepare("UPDATE workspace_meta_accounts SET workspace_id = 'w2' WHERE id = 'm1'").run()).toThrow(/cannot change/);
    expect(() => db.prepare("UPDATE workspace_meta_accounts SET account_id = 'act_9' WHERE id = 'm1'").run()).toThrow(/cannot change/);
    expect(n(db, "SELECT COUNT(*) n FROM workspace_meta_accounts")).toBe(2);
    db.close();
  });

  it("simulated (mock) mode is unchanged: no authorization needed, nothing to authorize, and the setting stays inert", async () => {
    const db = openDb(":memory:");
    migrate(db);
    const ctx = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
    const app = buildServer(ctx);
    cleanups.push(() => db.open && db.close());
    const r = await call(app, "POST", "/api/workspaces", { payload: { name: "Mock Co" } });
    const base = `/api/workspaces/${r.body.workspace.id}`;
    expect((await call(app, "PATCH", base, { token: r.body.token, payload: { metaAccountId: "act_123" } })).status).toBe(200);
    const view = await call(app, "GET", base, { token: r.body.token });
    expect([view.body.mode, view.body.metaAccountAuthorized]).toEqual(["mock", null]);
    expect(ctx.metaFor(r.body.workspace.id).accountId).toBe("act_9000000001"); // the simulator account, as before
    expect(() => authorizeMetaAccount(ctx, { kind: "system", label: "system" }, r.body.workspace.id, "act_111")).toThrow(/cannot be authorized/);
  });

  it("tokens and credentials appear in no response or record of the new routes", async () => {
    const w = await world();
    const seen: string[] = [];
    seen.push(JSON.stringify((await w.auth(w.u.alice.token, w.A, "act_111")).body), JSON.stringify((await w.pick(w.u.alice.token, w.A, "act_111")).body), JSON.stringify(await w.accounts(w.u.alice.token, w.A)));
    seen.push(JSON.stringify(w.db.prepare("SELECT * FROM workspace_meta_accounts").all()), JSON.stringify(w.db.prepare("SELECT * FROM audit_events").all()));
    for (const text of seen) expect(text).not.toMatch(new RegExp(`${FIXTURE_TOKEN}|authorization|bearer|access_token`, "i"));
  });
});
