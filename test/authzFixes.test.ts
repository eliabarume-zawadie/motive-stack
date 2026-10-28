/**
 * Milestone 4.2.1 regression tests:
 *   1. a legacy-token (or unverified) approval can never reach a LIVE connector, by any path;
 *   2. claiming a workspace is atomic across independent database connections;
 *   3. a workspace request from someone who is not authorized writes no user record.
 * Everything is local: the "live" connector is a spy object, the databases are temporary, and the test network blocker stays active.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { executeProposal } from "../src/app/executor.js";
import { enqueueJob } from "../src/app/jobs.js";
import { claimWorkspace } from "../src/app/memberships.js";
import { upsertUser } from "../src/app/users.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { MetaApiError } from "../src/connector/meta/errors.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OPEN_POLICY , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const runtime = () => buildAuthRuntime(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const jwtFor = (name: string, extra: Record<string, unknown> = {}) => signJwt(rsa, claims({ sub: `idp|${name}`, name, ...extra }));
const ident = (n: string) => ({ issuer: ISSUER, subject: `idp|${n}`, email: null, displayName: n });

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "ms-fixes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, opts: { token?: string; payload?: unknown } = {}) {
  const res = await app.inject({ method, url, headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {}, payload: opts.payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
const n = (db: Db, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

/* ===================================================================================================================
 * 1. Legacy-token and unverified approvals never reach a live connector
 * =================================================================================================================== */

function liveWorld() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const spy = {
    mode: "live" as "live" | "mock",
    create: [] as Array<{ approvedBy: string }>,
    list: 0,
    status: 0,
    failNext: false,
    knownName: "",
    listResult: [] as unknown[],
  };
  const connector: any = {
    createCampaignDraft: async (i: any, g: any) => {
      spy.create.push({ approvedBy: g.approvedBy });
      spy.knownName = i.name;
      if (spy.failNext) {
        spy.failNext = false;
        throw new MetaApiError("transient", "temporary failure");
      }
      return { id: "ext_1", name: i.name, status: "PAUSED" };
    },
    getCampaignStatus: async () => (spy.status++, { id: "ext_1", name: spy.knownName, status: "PAUSED" }),
    listCampaigns: async () => (spy.list++, spy.listResult),
  };
  ctx.metaFor = () => ({ connector, mode: spy.mode, accountId: "act_111", configuredAccountId: "act_111" }); // no real connector exists anywhere in this test
  const app = buildServer(ctx, runtime());
  cleanups.push(() => db.open && db.close());
  return { db, ctx, app, spy, worker: createWorker(ctx) };
}
type LW = ReturnType<typeof liveWorld>;

async function person(w: LW, name: string) {
  const token = jwtFor(name);
  const r = await call(w.app, "GET", "/api/me", { token });
  return { token, id: r.body.user.id as string };
}

/** A proposal in the spy's current mode, made by `token` (a person's JWT or a workspace token). */
async function propose(w: LW, wid: string, token: string) {
  const base = `/api/workspaces/${wid}`;
  // The stubbed live handle uses act_111, so this workspace holds it (a fixture row; authorization itself is tested in metaAccounts.test.ts).
  w.db.prepare("INSERT OR IGNORE INTO workspace_meta_accounts (id, workspace_id, account_id, status, source, created_at, created_by, updated_at, updated_by) VALUES (?,?,'act_111','active','owner_assertion','t','fixture','t','fixture')").run(`mac_${wid}`, wid);
  expect((await call(w.app, "PUT", `${base}/brain`, { token, payload: BRAIN })).status).toBe(200);
  const gen = await call(w.app, "POST", `${base}/campaigns/generate`, { token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
  expect(gen.status).toBe(201);
  await call(w.app, "PUT", `${base}/policy`, { token, payload: { preventSelfApproval: false } }); // this test is not about separation of duties (see separationOfDuties.test.ts)
  const prop = await call(w.app, "POST", `${base}/campaigns/${gen.body.id}/proposals`, { token, payload: {} });
  expect(prop.status).toBe(201);
  expect(prop.body.mode).toBe(w.spy.mode);
  return { base, cid: gen.body.id as string, pid: prop.body.id as string };
}

/** Write an approval row directly, as an older build or a damaged database could have left it, and queue the execution job. */
function forceApproval(w: LW, wid: string, pid: string, kind: "legacy_token" | "unverified" | "user", userId: string | null = null, over: Record<string, unknown> = {}) {
  const p = w.db.prepare("SELECT payload_hash, campaign_version, integration_mode FROM action_proposals WHERE id = ?").get(pid) as { payload_hash: string; campaign_version: number; integration_mode: string };
  w.db.prepare("DELETE FROM approvals WHERE proposal_id = ?").run(pid);
  const row = { decided_by: kind === "user" ? `user:${userId}` : `workspace-token:${wid}`, integration_mode: p.integration_mode, expires_at: new Date(NOW_MS + 3_600_000 + 9e11).toISOString(), ...over };
  w.db.prepare(
    `INSERT INTO approvals (id, workspace_id, proposal_id, decision, decided_by, payload_hash, campaign_version, integration_mode, decided_at, expires_at, approver_kind, approver_user_id)
     VALUES (?,?,?,'approve',?,?,?,?,?,?,?,?)`,
  ).run(`apr_${pid}`, wid, pid, row.decided_by, p.payload_hash, p.campaign_version, row.integration_mode, "2026-10-19T00:00:00.000Z", row.expires_at, kind, userId);
  w.db.prepare("UPDATE action_proposals SET status = 'approved' WHERE id = ?").run(pid);
  enqueueJob(w.ctx, wid, "execute_proposal", { proposalId: pid }, `exec:${pid}`);
}

const state = (w: LW, pid: string) => ({
  proposal: w.db.prepare("SELECT status, last_error FROM action_proposals WHERE id = ?").get(pid) as { status: string; last_error: string | null },
  attempts: n(w.db, "SELECT COUNT(*) n FROM execution_attempts WHERE proposal_id = ?", pid),
  resources: n(w.db, "SELECT COUNT(*) n FROM external_resources WHERE proposal_id = ?", pid),
});
const noConnectorContact = (w: LW) => expect({ create: w.spy.create.length, list: w.spy.list, status: w.spy.status }).toEqual({ create: 0, list: 0, status: 0 });

describe("a legacy-token or unverified approval cannot authorize a live write", () => {
  async function tokenWorkspace(w: LW) {
    const { workspace, token } = createWorkspace(w.ctx, "Token Co");
    return { wid: workspace.id, token };
  }

  it("is refused at approval time, with nothing recorded and nothing queued; rejecting stays possible", async () => {
    const w = liveWorld();
    const t = await tokenWorkspace(w);
    const { base, pid } = await propose(w, t.wid, t.token);
    const r = await call(w.app, "POST", `${base}/proposals/${pid}/approve`, { token: t.token, payload: { decidedBy: "anyone" } });
    await call(w.app, "POST", `${base}/proposals/${pid}/execute`, { token: t.token });
    expect([r.status, r.body.error.code]).toEqual([403, "live_requires_signed_in_approver"]);
    expect(n(w.db, "SELECT COUNT(*) n FROM approvals")).toBe(0);
    expect(n(w.db, "SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'")).toBe(0);
    expect(state(w, pid).proposal.status).toBe("proposed");
    expect((await call(w.app, "POST", `${base}/proposals/${pid}/reject`, { token: t.token, payload: { decidedBy: "anyone" } })).status).toBe(200);
    await w.worker.runUntilIdle();
    noConnectorContact(w);
  });

  it("an existing legacy-token or unverified approval (enabled token or not) is refused by the executor before any connector call or attempt", async () => {
    for (const [kind, disabled] of [["legacy_token", false], ["legacy_token", true], ["unverified", false]] as const) {
      const w = liveWorld();
      const t = await tokenWorkspace(w);
      const { pid } = await propose(w, t.wid, t.token);
      forceApproval(w, t.wid, pid, kind);
      if (disabled) w.db.prepare("UPDATE workspaces SET legacy_token_disabled_at = 't' WHERE id = ?").run(t.wid);
      await w.worker.runUntilIdle();
      expect(state(w, pid), `${kind} disabled=${disabled}`).toEqual({ proposal: { status: "failed", last_error: "approver_not_authorized" }, attempts: 0, resources: 0 });
      expect(n(w.db, "SELECT COUNT(*) n FROM audit_events WHERE type = 'execution.refused' AND entity_id = ?", pid)).toBe(1);
      noConnectorContact(w);
    }
  });

  it("is still refused on retry: a transient failure is retried, then the approval is found to be a legacy-token one", async () => {
    const w = liveWorld();
    const alice = await person(w, "alice");
    const wid = (await call(w.app, "POST", "/api/workspaces", { token: alice.token, payload: { name: "Retry Co" } })).body.workspace.id as string;
    const { base, pid } = await propose(w, wid, alice.token);
    expect((await call(w.app, "POST", `${base}/proposals/${pid}/approve`, { token: alice.token, payload: { decidedBy: "a" } })).status).toBe(200);
    await call(w.app, "POST", `${base}/proposals/${pid}/execute`, { token: alice.token });
    w.spy.failNext = true;
    await w.worker.runUntilIdle(1); // attempt 1: the connector fails transiently and the job is re-queued
    expect(state(w, pid)).toMatchObject({ proposal: { status: "approved" }, attempts: 1 });
    expect(w.spy.create).toHaveLength(1);
    w.db.prepare("UPDATE approvals SET approver_kind = 'legacy_token', approver_user_id = NULL WHERE proposal_id = ?").run(pid);
    await w.worker.runUntilIdle();
    expect(state(w, pid)).toEqual({ proposal: { status: "failed", last_error: "approver_not_authorized" }, attempts: 1, resources: 0 });
    expect(w.spy.create).toHaveLength(1); // no second send
  });

  it("is still refused on recovery after a crash before dispatch", async () => {
    const w = liveWorld();
    const t = await tokenWorkspace(w);
    const { pid } = await propose(w, t.wid, t.token);
    forceApproval(w, t.wid, pid, "legacy_token");
    w.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(pid);
    w.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('att_1', ?, ?, 1, 'started', 0, 't')").run(t.wid, pid);
    await executeProposal(w.ctx, t.wid, pid);
    expect(state(w, pid).proposal).toEqual({ status: "failed", last_error: "approver_not_authorized" });
    expect(n(w.db, "SELECT COUNT(*) n FROM execution_attempts WHERE proposal_id = ? AND status = 'started'", pid)).toBe(0); // no new attempt began
    noConnectorContact(w);
  });

  it("is still refused on reconciliation after a crash AFTER dispatch: the connector is not even read, and a person is asked to review", async () => {
    const w = liveWorld();
    const t = await tokenWorkspace(w);
    const { pid } = await propose(w, t.wid, t.token);
    forceApproval(w, t.wid, pid, "legacy_token");
    w.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(pid);
    w.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('att_1', ?, ?, 1, 'started', 1, 't')").run(t.wid, pid);
    await executeProposal(w.ctx, t.wid, pid);
    expect(state(w, pid)).toEqual({ proposal: { status: "needs_review", last_error: "approver_not_authorized" }, attempts: 1, resources: 0 });
    noConnectorContact(w);
    const ev = w.db.prepare("SELECT detail FROM audit_events WHERE type = 'execution.refused' AND entity_id = ?").get(pid) as { detail: string };
    expect(JSON.parse(ev.detail)).toEqual({ reason: "approver_not_authorized", phase: "reconcile" });
  });

  it("control: the same reconciliation proceeds for an approver who is still a qualified signed-in member", async () => {
    const w = liveWorld();
    const alice = await person(w, "alice");
    const wid = (await call(w.app, "POST", "/api/workspaces", { token: alice.token, payload: { name: "Control Co" } })).body.workspace.id as string;
    const { pid } = await propose(w, wid, alice.token);
    forceApproval(w, wid, pid, "user", alice.id);
    const name = (JSON.parse((w.db.prepare("SELECT payload FROM action_proposals WHERE id = ?").get(pid) as { payload: string }).payload) as { name: string }).name;
    w.spy.knownName = name;
    w.spy.listResult = [{ id: "ext_9", name, status: "PAUSED" }];
    w.db.prepare("UPDATE action_proposals SET status = 'executing' WHERE id = ?").run(pid);
    w.db.prepare("INSERT INTO execution_attempts (id, workspace_id, proposal_id, attempt_no, status, dispatched, started_at) VALUES ('att_1', ?, ?, 1, 'started', 1, 't')").run(wid, pid);
    await executeProposal(w.ctx, wid, pid);
    expect(state(w, pid)).toMatchObject({ proposal: { status: "executed" }, resources: 1 });
    expect(w.spy.list).toBe(1);
    expect(w.spy.create).toHaveLength(0); // reconciled by name, never re-sent
  });

  it("control: a signed-in owner's live approval still executes, attributed to that person", async () => {
    const w = liveWorld();
    const alice = await person(w, "alice");
    const wid = (await call(w.app, "POST", "/api/workspaces", { token: alice.token, payload: { name: "Live Co" } })).body.workspace.id as string;
    const { base, pid } = await propose(w, wid, alice.token);
    expect((await call(w.app, "POST", `${base}/proposals/${pid}/approve`, { token: alice.token, payload: { decidedBy: "a" } })).status).toBe(200);
    await call(w.app, "POST", `${base}/proposals/${pid}/execute`, { token: alice.token });
    await w.worker.runUntilIdle();
    expect(state(w, pid)).toEqual({ proposal: { status: "executed", last_error: null }, attempts: 1, resources: 1 });
    expect(w.spy.create).toEqual([{ approvedBy: `user:${alice.id}` }]);
  });

  it("control: legacy-token approvals of SIMULATED actions still work while the token is enabled, and stop when it is disabled", async () => {
    for (const disable of [false, true]) {
      const w = liveWorld();
      w.spy.mode = "mock";
      const t = await tokenWorkspace(w);
      const { base, pid } = await propose(w, t.wid, t.token);
      expect((await call(w.app, "POST", `${base}/proposals/${pid}/approve`, { token: t.token, payload: { decidedBy: "Pat" } })).status).toBe(200);
      await call(w.app, "POST", `${base}/proposals/${pid}/execute`, { token: t.token });
      if (disable) w.db.prepare("UPDATE workspaces SET legacy_token_disabled_at = 't' WHERE id = ?").run(t.wid);
      await w.worker.runUntilIdle();
      if (disable) {
        expect(state(w, pid)).toEqual({ proposal: { status: "failed", last_error: "approver_not_authorized" }, attempts: 0, resources: 0 });
        expect(w.spy.create).toHaveLength(0);
      } else {
        expect(state(w, pid)).toMatchObject({ proposal: { status: "executed" }, resources: 1 });
        expect(w.spy.create).toEqual([{ approvedBy: `workspace-token:${t.wid}` }]);
      }
    }
  });

  it("the other execution gates still hold for a qualified live approver: expiry, payload hash, mode, budget cap, missing approval", async () => {
    const cases: Array<[string, (w: LW, wid: string, pid: string, alice: { token: string }) => Promise<void> | void, string]> = [
      ["expired", (w, _wid, pid) => void w.db.prepare("UPDATE approvals SET expires_at = '2020-01-01T00:00:00.000Z' WHERE proposal_id = ?").run(pid), "approval_expired"],
      ["tampered payload", (w, _wid, pid) => void w.db.prepare("UPDATE action_proposals SET payload = json_set(payload, '$.name', 'Tampered Name') WHERE id = ?").run(pid), "payload_tampered"],
      ["mode mismatch", (w, _wid, pid) => void w.db.prepare("UPDATE approvals SET integration_mode = 'mock' WHERE proposal_id = ?").run(pid), "mode_mismatch"],
      ["budget cap lowered", async (w, wid, _pid, alice) => void (await call(w.app, "PUT", `/api/workspaces/${wid}/brain`, { token: alice.token, payload: { ...BRAIN, maxDailyBudgetCents: 100 } })), "budget_exceeds_cap"],
      ["no approval", (w, _wid, pid) => void w.db.prepare("DELETE FROM approvals WHERE proposal_id = ?").run(pid), "no_approval"],
    ];
    for (const [name, tweak, reason] of cases) {
      const w = liveWorld();
      const alice = await person(w, "alice");
      const wid = (await call(w.app, "POST", "/api/workspaces", { token: alice.token, payload: { name: "Gate Co" } })).body.workspace.id as string;
      const { base, pid } = await propose(w, wid, alice.token);
      expect((await call(w.app, "POST", `${base}/proposals/${pid}/approve`, { token: alice.token, payload: { decidedBy: "a" } })).status).toBe(200);
      await call(w.app, "POST", `${base}/proposals/${pid}/execute`, { token: alice.token });
      await tweak(w, wid, pid, alice);
      await w.worker.runUntilIdle();
      expect(state(w, pid).proposal, name).toMatchObject({ status: expect.stringMatching(/failed|stale/), last_error: reason });
      expect(w.spy.create, name).toHaveLength(0);
      expect(state(w, pid).attempts, name).toBe(0);
    }
  });
});

/* ===================================================================================================================
 * 2. Claiming a workspace is atomic across connections
 * =================================================================================================================== */

function twoConnections() {
  const file = join(tmp(), "claim.db");
  const dbA = openDb(file);
  migrate(dbA);
  const dbB = openDb(file);
  cleanups.push(() => { if (dbA.open) dbA.close(); if (dbB.open) dbB.close(); });
  return { file, dbA, dbB, ctxA: buildContext({ db: dbA, env: {} }), ctxB: buildContext({ db: dbB, env: {} }) };
}
const owners = (db: Db, wid: string) => n(db, "SELECT COUNT(*) n FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner' AND status = 'active'", wid);

describe("claiming a workspace is atomic", () => {
  it("when another connection claims between this one's checks and its write, exactly one claim wins and one owner remains", async () => {
    const c = twoConnections();
    const x = upsertUser(c.ctxA, ident("xavier"));
    const y = upsertUser(c.ctxA, ident("yara"));
    const { workspace, token } = createWorkspace(c.ctxA, "Old Co");
    let injected = 0;
    const racing = new Proxy(c.dbA, {
      get(t, p) {
        if (p === "transaction") {
          return (fn: never) => {
            if (!injected++) claimWorkspace(c.ctxB, userActor(y.id) as never, workspace.id, token); // B commits after A's pre-check, before A's write
            return t.transaction(fn);
          };
        }
        const v = (t as never as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    let err: { status?: number; code?: string } | null = null;
    try {
      claimWorkspace({ ...c.ctxA, db: racing as never }, userActor(x.id) as never, workspace.id, token);
    } catch (e) {
      err = e as { status?: number; code?: string };
    }
    expect(injected).toBe(1);
    expect(err).toMatchObject({ status: 409, code: "already_claimed" }); // A re-checked inside its locked transaction
    expect(owners(c.dbA, workspace.id)).toBe(1);
    expect(c.dbA.prepare("SELECT user_id FROM workspace_memberships WHERE workspace_id = ?").all(workspace.id)).toEqual([{ user_id: y.id }]);
    expect(n(c.dbA, "SELECT COUNT(*) n FROM audit_events WHERE type = 'workspace.claimed' AND workspace_id = ?", workspace.id)).toBe(1);
  });

  it("while another connection holds the write lock, a claim fails with a retryable 503 and writes nothing; after release it succeeds", async () => {
    const c = twoConnections();
    const x = upsertUser(c.ctxA, ident("xavier"));
    const { workspace, token } = createWorkspace(c.ctxA, "Old Co");
    const impatient: Db = new Database(c.file, { timeout: 25 }); // a short busy timeout so the test is fast
    impatient.pragma("journal_mode = WAL");
    impatient.pragma("foreign_keys = ON");
    cleanups.push(() => impatient.open && impatient.close());
    const ctx = buildContext({ db: impatient, env: {} });
    c.dbB.exec("BEGIN IMMEDIATE"); // another process is in the middle of a write
    let err: { status?: number; code?: string; message?: string } | null = null;
    try {
      claimWorkspace(ctx, userActor(x.id) as never, workspace.id, token);
    } catch (e) {
      err = e as { status?: number; code?: string };
    }
    expect(err).toMatchObject({ status: 503, code: "busy" });
    c.dbB.exec("ROLLBACK");
    expect(owners(c.dbA, workspace.id)).toBe(0);
    expect(claimWorkspace(ctx, userActor(x.id) as never, workspace.id, token).id).toBe(workspace.id);
    expect(owners(c.dbA, workspace.id)).toBe(1);
  });

  it("holds the write lock for the whole claim: a rival that tries mid-transaction is turned away, and the first claim completes as sole owner", async () => {
    const c = twoConnections();
    const x = upsertUser(c.ctxA, ident("xavier"));
    const y = upsertUser(c.ctxA, ident("yara"));
    const { workspace, token } = createWorkspace(c.ctxA, "Old Co");
    const rival: Db = new Database(c.file, { timeout: 25 });
    rival.pragma("journal_mode = WAL");
    rival.pragma("foreign_keys = ON");
    cleanups.push(() => rival.open && rival.close());
    const ctxRival = buildContext({ db: rival, env: {} });
    let rivalOutcome: { status?: number; code?: string } | "claimed" | null = null;
    const racing = new Proxy(c.dbA, {
      get(t, p) {
        if (p === "prepare") {
          return (sql: string) => {
            const st = t.prepare(sql);
            if (!sql.startsWith("INSERT INTO workspace_memberships")) return st;
            return new Proxy(st, {
              get(s, k) {
                if (k === "run") {
                  return (...a: unknown[]) => {
                    // A is past its checks and about to write. A rival connection now tries to claim the same workspace.
                    try { claimWorkspace(ctxRival, userActor(y.id) as never, workspace.id, token); rivalOutcome = "claimed"; } catch (e) { rivalOutcome = e as { status?: number; code?: string }; }
                    return (s as never as { run: (...x: unknown[]) => unknown }).run(...a);
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
    claimWorkspace({ ...c.ctxA, db: racing as never }, userActor(x.id) as never, workspace.id, token);
    expect(rivalOutcome).toMatchObject({ status: 503, code: "busy" }); // it could not even start writing while A held the lock
    expect(c.dbA.prepare("SELECT user_id FROM workspace_memberships WHERE workspace_id = ?").all(workspace.id)).toEqual([{ user_id: x.id }]);
    expect(owners(c.dbA, workspace.id)).toBe(1);
  });

  it("a second claim after ownership is established is refused, and the first owner stays the only owner", () => {
    const c = twoConnections();
    const x = upsertUser(c.ctxA, ident("xavier"));
    const y = upsertUser(c.ctxA, ident("yara"));
    const { workspace, token } = createWorkspace(c.ctxA, "Old Co");
    claimWorkspace(c.ctxA, userActor(x.id) as never, workspace.id, token);
    expect(() => claimWorkspace(c.ctxB, userActor(y.id) as never, workspace.id, token)).toThrow(/already has an owner/);
    expect(owners(c.dbA, workspace.id)).toBe(1);
  });

  it("answers an unknown workspace, a wrong token and a disabled token identically, and never with the 'already claimed' answer", () => {
    const c = twoConnections();
    const x = upsertUser(c.ctxA, ident("xavier"));
    const y = upsertUser(c.ctxA, ident("yara"));
    const fresh = createWorkspace(c.ctxA, "Fresh Co");
    const claimed = createWorkspace(c.ctxA, "Claimed Co");
    const disabled = createWorkspace(c.ctxA, "Disabled Co");
    claimWorkspace(c.ctxA, userActor(x.id) as never, claimed.workspace.id, claimed.token);
    c.dbA.prepare("UPDATE workspaces SET legacy_token_disabled_at = 't' WHERE id = ?").run(disabled.workspace.id);
    const answer = (wid: string, t: string) => {
      try {
        claimWorkspace(c.ctxA, userActor(y.id) as never, wid, t);
        return "claimed";
      } catch (e) {
        const x = e as { status: number; code: string; message: string };
        return JSON.stringify([x.status, x.code, x.message]);
      }
    };
    const missing = answer("ws_does_not_exist", fresh.token);
    expect(missing).toBe(JSON.stringify([404, "not_found", "Workspace not found"]));
    expect(answer(fresh.workspace.id, "msw_wrong")).toBe(missing);
    expect(answer(disabled.workspace.id, disabled.token)).toBe(missing);
    expect(answer(claimed.workspace.id, "msw_wrong")).toBe(missing); // a wrong token on a claimed workspace does not reveal that it is claimed
    expect(owners(c.dbA, fresh.workspace.id)).toBe(0);
  });
});

/* ===================================================================================================================
 * 3. No user record is written before workspace authorization
 * =================================================================================================================== */

describe("a workspace request does not write user records before authorization", () => {
  async function world() {
    const db = openDb(":memory:");
    migrate(db);
    const ctx = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
    const app = buildServer(ctx, runtime());
    cleanups.push(() => db.open && db.close());
    const alice = jwtFor("alice");
    expect((await call(app, "GET", "/api/me", { token: alice })).status).toBe(200);
    const wid = (await call(app, "POST", "/api/workspaces", { token: alice, payload: { name: "Alpha Co" } })).body.workspace.id as string;
    return { db, ctx, app, wid, alice };
  }
  const users = (db: Db) => db.prepare("SELECT * FROM users ORDER BY id").all();
  const urls = (wid: string): Array<["GET" | "PUT" | "POST", string, unknown?]> => [["GET", `/api/workspaces/${wid}`], ["GET", `/api/workspaces/${wid}/campaigns`], ["PUT", `/api/workspaces/${wid}/brain`, BRAIN], ["POST", `/api/workspaces/${wid}/campaigns/generate`, {}], ["GET", `/api/workspaces/${wid}/members`]];

  it("an identity that has never been seen creates nothing by asking for a workspace", async () => {
    const w = await world();
    const before = users(w.db);
    for (const [m, u, body] of urls(w.wid)) expect((await call(w.app, m, u, { token: jwtFor("mallory"), payload: body })).status, `${m} ${u}`).toBe(404);
    expect(users(w.db)).toEqual(before);
    expect(n(w.db, "SELECT COUNT(*) n FROM users WHERE subject = 'idp|mallory'")).toBe(0);
  });

  it("a known user who is not a member leaves their record untouched, even when their token carries new profile data", async () => {
    const w = await world();
    const bob = jwtFor("bob");
    expect((await call(w.app, "GET", "/api/me", { token: bob })).status).toBe(200);
    w.db.prepare("UPDATE users SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE subject = 'idp|bob'").run();
    const before = users(w.db);
    const changed = jwtFor("bob", { name: "Robert Renamed", email: "new@example.test", email_verified: true });
    for (const [m, u, body] of urls(w.wid)) expect((await call(w.app, m, u, { token: changed, payload: body })).status, `${m} ${u}`).toBe(404);
    expect(users(w.db)).toEqual(before);
  });

  it("a member refused for lack of role (403) leaves their record untouched", async () => {
    const w = await world();
    const erin = jwtFor("erin");
    const erinId = (await call(w.app, "GET", "/api/me", { token: erin })).body.user.id as string;
    expect((await call(w.app, "POST", `/api/workspaces/${w.wid}/members`, { token: w.alice, payload: { userId: erinId, role: "viewer" } })).status).toBe(201);
    w.db.prepare("UPDATE users SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(erinId);
    const before = users(w.db);
    expect((await call(w.app, "PUT", `/api/workspaces/${w.wid}/brain`, { token: jwtFor("erin", { name: "Renamed" }), payload: BRAIN })).status).toBe(403);
    expect(users(w.db)).toEqual(before);
  });

  it("an authorized workspace request is also read-only for user records", async () => {
    const w = await world();
    w.db.prepare("UPDATE users SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE subject = 'idp|alice'").run();
    const before = users(w.db);
    expect((await call(w.app, "GET", `/api/workspaces/${w.wid}/campaigns`, { token: jwtFor("alice", { name: "Alice Renamed" }) })).status).toBe(200);
    expect(users(w.db)).toEqual(before);
  });

  it("provisioning still happens where it is legitimately needed: sign-in, workspace listing, claim and workspace creation", async () => {
    const w = await world();
    const count = () => n(w.db, "SELECT COUNT(*) n FROM users");
    const start = count();
    expect((await call(w.app, "GET", "/api/me", { token: jwtFor("p1") })).status).toBe(200);
    expect((await call(w.app, "GET", "/api/me/workspaces", { token: jwtFor("p2") })).status).toBe(200);
    expect((await call(w.app, "POST", "/api/workspaces", { token: jwtFor("p3"), payload: { name: "Third Co" } })).status).toBe(201);
    const { workspace, token } = createWorkspace(w.ctx, "Old Co");
    expect((await call(w.app, "POST", "/api/workspaces/claim", { token: jwtFor("p4"), payload: { workspaceId: workspace.id, token } })).status).toBe(200);
    expect(count()).toBe(start + 4);
    // and the new owner can then use the workspace
    expect((await call(w.app, "GET", `/api/workspaces/${workspace.id}`, { token: jwtFor("p4") })).status).toBe(200);
  });
});
