import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorker } from "../src/app/worker.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { buildAuthRuntime, loadAuthConfig, workspaceTokenRuntime, type AuthRuntime } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { AuthError } from "../src/auth/types.js";
import { migrate, openDb } from "../src/db/db.js";
import { PUBLIC_ROUTES } from "../src/server/auth.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, hmacForgery, makeKey, signJwt, unsignedToken , OPEN_POLICY } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const attacker = makeKey("RS256", "rsa-1");

const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", OIDC_CLIENT_ID: "public-client-id", OIDC_MAX_TOKEN_LIFETIME_SEC: "900" };
const oidcRuntime = (): AuthRuntime => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length) open.pop()?.();
});

function boot(auth: AuthRuntime = workspaceTokenRuntime) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, auth);
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH" | "HEAD", url: string, opts: { token?: string; header?: string; payload?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.header !== undefined) headers.authorization = opts.header;
  else if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.raw !== undefined) headers["content-type"] = "application/json";
  const res = await app.inject({ method, url, headers, payload: (opts.raw ?? opts.payload) as never });
  return { status: res.statusCode, headers: res.headers, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
/** A workspace that predates memberships (or was made while no identity provider was configured): reachable only by its legacy token. */
const legacy = (s: { ctx: AppContext }, name = "Legacy Co") => {
  const { workspace, token } = createWorkspace(s.ctx, name);
  return { id: workspace.id, token };
};
const signup = async (app: FastifyInstance, name = "Acme") => {
  const r = await call(app, "POST", "/api/workspaces", { payload: { name } });
  expect(r.status).toBe(201);
  return { id: r.body.workspace.id as string, token: r.body.token as string };
};

describe("public routes are narrow and explicit", () => {
  it("serves health, config, workspace creation and the static UI without credentials, and nothing else under /api", async () => {
    const s = boot();
    expect((await call(s.app, "GET", "/api/health")).status).toBe(200);
    expect((await call(s.app, "HEAD", "/api/health")).status).toBe(200);
    const cfg = await call(s.app, "GET", "/api/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body.auth).toEqual({ mode: "workspace_token" });
    expect((await call(s.app, "POST", "/api/workspaces", { payload: { name: "Open Signup" } })).status).toBe(201);
    expect((await s.app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
    expect((await s.app.inject({ method: "GET", url: "/app.js" })).statusCode).toBe(200);
    (await call(s.app, "GET", "/api/health/ready")).status === 200 || expect.fail("readiness must answer without credentials");
    expect([...PUBLIC_ROUTES].sort()).toEqual(["GET /api/config", "GET /api/health", "GET /api/health/ready", "HEAD /api/config", "HEAD /api/health", "HEAD /api/health/ready", "POST /api/workspaces"]); // readiness (Phase 9) is the only addition: it says yes or no and which check failed
  });
  it("answers an unknown /api path with 404 and no data", async () => {
    const s = boot();
    const r = await call(s.app, "GET", "/api/nothing-here");
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/ws_|msw_/);
  });
});

describe("every non-public route demands credentials (default deny)", () => {
  for (const [label, make] of [["workspace-token mode", () => boot()], ["oidc mode", () => boot(oidcRuntime())]] as const) {
    it(`rejects each protected route without credentials, with a bad header, and with a forged token: ${label}`, async () => {
      const s = make();
      await s.app.ready(); // plugin routes are registered on ready
      const routes = s.app.routeTable.filter((r) => r.url.startsWith("/api/") && !PUBLIC_ROUTES.has(`${r.method} ${r.url}`) && r.method !== "HEAD");
      expect(routes.length).toBeGreaterThan(20); // the inventory really contains the API
      expect(routes.some((r) => r.url === "/api/workspaces/:wid/ai/settings" && r.method === "PUT")).toBe(true);
      const w = legacy(s);
      const personRoutes = new Set(["GET /api/me", "GET /api/me/workspaces", "GET /api/me/organizations", "POST /api/workspaces/claim", "POST /api/organizations"]);
      expect(routes.filter((r) => personRoutes.has(`${r.method} ${r.url}`))).toHaveLength(5);
      // every organization route is for signed-in people too: with no identity provider they do not exist (404), with one they need credentials (401)
      const isPerson = (r: { method: string; url: string }) => personRoutes.has(`${r.method} ${r.url}`) || r.url.startsWith("/api/organizations/:oid");
      expect(routes.filter((r) => r.url.startsWith("/api/organizations/:oid")).length).toBeGreaterThan(10);
      for (const r of routes) {
        const url = r.url.replace(":wid", w.id).replace(/:[a-z]+/g, "x_1");
        const isMe = isPerson(r);
        for (const h of [undefined, "Basic abc", "Bearer", "Bearer msw_wrong", `Bearer ${signJwt(attacker)}`]) {
          const res = await call(s.app, r.method as "GET", url, { header: h, payload: r.method === "GET" ? undefined : {} });
          const expected = isMe && label === "workspace-token mode" ? 404 : 401;
          expect(res.status, `${r.method} ${r.url} with ${String(h).slice(0, 12)}`).toBe(expected);
        }
      }
    });
  }
  it("refuses a route someone adds under /api without declaring it public or giving it an auth rule", async () => {
    const s = boot();
    s.app.get("/api/added-later", async () => ({ secret: "data" })); // routes must be added before the server is ready
    s.app.get("/api/workspaces/:wid/added-later", async () => ({ secret: "data" }));
    const w = await signup(s.app);
    expect((await call(s.app, "GET", "/api/added-later")).status).toBe(401);
    expect((await call(s.app, "GET", "/api/added-later", { token: w.token })).status).toBe(401); // no valid credential type exists for it
    expect((await call(s.app, "GET", `/api/workspaces/${w.id}/added-later`)).status).toBe(401); // workspace routes always need that workspace token
    expect((await call(s.app, "GET", `/api/workspaces/${w.id}/added-later`, { token: w.token })).status).toBe(403); // no declared permission: refused even for a valid token
  });
  it("rejects BEFORE reading the body: malformed or oversized bodies without credentials get 401, not 400 or 413", async () => {
    const s = boot();
    const w = await signup(s.app);
    const url = `/api/workspaces/${w.id}/brain`;
    expect((await call(s.app, "PUT", url, { raw: "{ not json" })).status).toBe(401);
    expect((await call(s.app, "PUT", url, { raw: JSON.stringify({ pad: "x".repeat(300_000) }) })).status).toBe(401);
    expect((await call(s.app, "PUT", url, { token: w.token, raw: "{ not json" })).status).toBe(400); // authenticated: the body is parsed and judged
  });
  it("accepts only `Bearer <token>`: other schemes, extra words and credentials outside the header do not authenticate", async () => {
    const s = boot();
    const w = await signup(s.app);
    const url = `/api/workspaces/${w.id}/brain`;
    for (const header of ["", "Basic dXNlcjpwYXNz", "Bearer", "Bearer  x", `Bearer ${w.token} extra`, `Token ${w.token}`, w.token]) {
      const r = await call(s.app, "GET", url, { header });
      expect(r.status, header).toBe(401);
      expect(r.headers["www-authenticate"]).toBeTruthy();
    }
    expect((await call(s.app, "GET", `${url}?access_token=${w.token}`)).status).toBe(401);
    expect((await call(s.app, "GET", url, { headers: { cookie: `token=${w.token}`, "x-workspace-token": w.token } })).status).toBe(401);
    expect((await call(s.app, "GET", url, { header: `bearer ${w.token}` })).status).toBe(200); // the scheme name is case-insensitive
  });
  it("never reveals whether a workspace exists: a wrong token and an unknown workspace are the same 401", async () => {
    const s = boot();
    const w = await signup(s.app);
    const a = await call(s.app, "GET", `/api/workspaces/${w.id}/brain`, { token: "msw_wrong" });
    const b = await call(s.app, "GET", `/api/workspaces/ws_does_not_exist/brain`, { token: "msw_wrong" });
    expect([a.status, a.body]).toEqual([b.status, b.body]);
  });
});

describe("workspace tokens during the documented transition", () => {
  it("still authenticate exactly their own workspace, in both auth modes", async () => {
    for (const auth of [workspaceTokenRuntime, oidcRuntime()]) {
      const s = boot(auth);
      const a = legacy(s, "Alpha");
      const b = legacy(s, "Bravo");
      expect((await call(s.app, "GET", `/api/workspaces/${a.id}`, { token: a.token })).status).toBe(200);
      expect((await call(s.app, "GET", `/api/workspaces/${a.id}`, { token: b.token })).status).toBe(401);
      expect((await call(s.app, "GET", `/api/workspaces/${a.id}/ai/usage`, { token: b.token })).status).toBe(401);
    }
  });
  it("are not user identities: a workspace token does not authenticate /api/me and creates no user", async () => {
    const s = boot(oidcRuntime());
    const w = legacy(s);
    expect((await call(s.app, "GET", "/api/me", { token: w.token })).status).toBe(401);
    expect((s.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0);
  });
  it("a JWT-shaped token is rejected in workspace-token mode, and /api/me does not exist there", async () => {
    const s = boot();
    const w = await signup(s.app);
    expect((await call(s.app, "GET", `/api/workspaces/${w.id}`, { token: signJwt(rsa) })).status).toBe(401);
    expect((await call(s.app, "GET", "/api/me", { token: signJwt(rsa) })).status).toBe(404);
  });
});

describe("OIDC identities at /api/me", () => {
  it("returns the verified person, creates one internal user keyed by issuer and subject, and exposes no claims beyond that", async () => {
    const s = boot(oidcRuntime());
    const t = signJwt(rsa, claims({ email: "pat@example.test", email_verified: true, name: "Pat Example", scope: "private-claim" }));
    const r1 = await call(s.app, "GET", "/api/me", { token: t });
    expect(r1.status).toBe(200);
    expect(r1.body.user).toEqual({ id: expect.stringMatching(/^usr_/), email: "pat@example.test", displayName: "Pat Example" });
    const r2 = await call(s.app, "GET", "/api/me", { token: signJwt(rsa, claims({ name: "Pat E." })) });
    expect(r2.body.user.id).toBe(r1.body.user.id); // same person, same user
    const rows = s.db.prepare("SELECT issuer, subject, email, display_name FROM users").all();
    expect(rows).toEqual([{ issuer: ISSUER, subject: "idp|user-123", email: null, display_name: "Pat E." }]);
    expect(JSON.stringify(r1.body)).not.toMatch(/idp\||private-claim|issuer|subject/);
  });
  it("treats the subject, not the email, as the identity", async () => {
    const s = boot(oidcRuntime());
    const a = await call(s.app, "GET", "/api/me", { token: signJwt(rsa, claims({ sub: "idp|a", email: "same@example.test", email_verified: true })) });
    const b = await call(s.app, "GET", "/api/me", { token: signJwt(rsa, claims({ sub: "idp|b", email: "same@example.test", email_verified: true })) });
    expect(a.body.user.id).not.toBe(b.body.user.id);
    expect((s.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(2);
  });
  it("rejects every invalid token with 401 and creates no user", async () => {
    const s = boot(oidcRuntime());
    const bad = [
      signJwt(attacker), // wrong key
      signJwt(rsa, claims({ exp: Math.floor(NOW_MS / 1000) - 7200 })), // expired
      signJwt(rsa, claims({ iss: "https://evil.example.test/" })),
      signJwt(rsa, claims({ aud: "someone-else" })),
      signJwt(rsa, claims({ sub: undefined })),
      hmacForgery(rsa),
      `${Buffer.from(JSON.stringify({ alg: "none", kid: "rsa-1" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims())).toString("base64url")}.AAAA`,
      unsignedToken(),
      "not.a.jwt",
      "msw_looks_like_a_workspace_token",
    ];
    for (const t of bad) expect((await call(s.app, "GET", "/api/me", { token: t })).status, t.slice(0, 24)).toBe(401);
    expect((await call(s.app, "GET", "/api/me")).status).toBe(401);
    expect((s.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0);
  });
  it("answers 503 when the provider's keys cannot be obtained, never a pass", async () => {
    const down: AuthRuntime = { mode: "oidc", publicConfig: { mode: "oidc" }, policy: OPEN_POLICY, verifier: { verify: async () => { throw new AuthError("keys_unavailable"); } } };
    const s = boot(down);
    const w = legacy(s);
    expect((await call(s.app, "GET", "/api/me", { token: signJwt(rsa) })).status).toBe(503);
    expect((await call(s.app, "GET", `/api/workspaces/${w.id}`, { token: signJwt(rsa) })).status).toBe(503);
  });
  it("lets a bug in verification surface as a 500 instead of passing or masquerading as a bad token", async () => {
    const broken: AuthRuntime = { mode: "oidc", publicConfig: { mode: "oidc" }, policy: OPEN_POLICY, verifier: { verify: async () => { throw new TypeError("boom"); } } };
    const s = boot(broken);
    expect((await call(s.app, "GET", "/api/me", { token: signJwt(rsa) })).status).toBe(500);
  });
  it("publishes only non-secret values in /api/config", async () => {
    const s = boot(oidcRuntime());
    const cfg = await call(s.app, "GET", "/api/config");
    expect(cfg.body.auth).toEqual({ mode: "oidc", issuer: ISSUER, audience: AUDIENCE, clientId: "public-client-id" });
    expect(JSON.stringify(cfg.body)).not.toMatch(/token_hash|msw_|api[_-]?key|secret|private|jwks/i);
  });
});

describe("a verified identity is not workspace access", () => {
  it("gets the same 404 as a workspace that does not exist, on every workspace route, and sees no data", async () => {
    const s = boot(oidcRuntime());
    const w = legacy(s);
    const t = signJwt(rsa);
    for (const [method, path] of [["GET", ""], ["GET", "/brain"], ["PUT", "/ai/settings"], ["POST", "/campaigns/generate"], ["GET", "/leads"], ["GET", "/activity"]] as const) {
      const r = await call(s.app, method, `/api/workspaces/${w.id}${path}`, { token: t, payload: method === "GET" ? undefined : {} });
      const ghost = await call(s.app, method, `/api/workspaces/ws_does_not_exist${path}`, { token: t, payload: method === "GET" ? undefined : {} });
      expect([r.status, r.body], `${method} ${path}`).toEqual([404, ghost.body]);
      expect(r.status).toBe(ghost.status);
      expect(JSON.stringify(r.body)).not.toContain(w.id);
    }
    expect((s.db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0); // M4.2.1: a non-member's workspace request writes no user record
    expect((await call(s.app, "GET", `/api/workspaces/${w.id}`, { token: signJwt(attacker) })).status).toBe(401); // an invalid token is 401, not 403
  });
});

describe("approval attribution is derived on the server", () => {
  async function proposal(s: ReturnType<typeof boot>, preExisting = false) {
    const w = preExisting ? legacy(s) : await signup(s.app);
    const base = `/api/workspaces/${w.id}`;
    expect((await call(s.app, "PUT", `${base}/brain`, { token: w.token, payload: BRAIN })).status).toBe(200);
    const gen = await call(s.app, "POST", `${base}/campaigns/generate`, { token: w.token, payload: { providerId: "mock", model: "mock-deterministic-1" } });
    const prop = await call(s.app, "POST", `${base}/campaigns/${gen.body.id}/proposals`, { token: w.token, payload: {} });
    return { w, base, pid: prop.body.id as string };
  }

  it("records the authenticated principal as the approver; the typed name is kept only as an unverified label", async () => {
    const s = boot();
    const { w, base, pid } = await proposal(s);
    const claimed = "user:usr_victim";
    const r = await call(s.app, "POST", `${base}/proposals/${pid}/approve`, { token: w.token, payload: { decidedBy: claimed, reason: "ok" } });
    await call(s.app, "POST", `${base}/proposals/${pid}/execute`, { token: w.token });
    expect(r.status).toBe(200);
    const principal = `workspace-token:${w.id}`;
    const row = s.db.prepare("SELECT decided_by, claimed_label, reason FROM approvals WHERE proposal_id = ?").get(pid);
    expect(row).toEqual({ decided_by: principal, claimed_label: claimed, reason: "ok" });
    expect(r.body.approval).toMatchObject({ decided_by: principal, claimed_label: claimed });
    const ev = s.db.prepare("SELECT actor, detail FROM audit_events WHERE type = 'proposal.approved' AND entity_id = ?").get(pid) as { actor: string; detail: string };
    expect(ev.actor).toBe(principal);
    expect(JSON.parse(ev.detail)).toMatchObject({ claimedLabel: claimed, claimedLabelVerified: false });
    await s.worker.runUntilIdle(); // the approved write still runs through the same gates
    expect((await call(s.app, "GET", `${base}/proposals/${pid}`, { token: w.token })).body.status).toBe("executed");
  });
  it("attributes a rejection the same way", async () => {
    const s = boot();
    const { w, base, pid } = await proposal(s);
    await call(s.app, "POST", `${base}/proposals/${pid}/reject`, { token: w.token, payload: { decidedBy: "Someone Else" } });
    expect(s.db.prepare("SELECT decided_by, claimed_label FROM approvals WHERE proposal_id = ?").get(pid)).toEqual({ decided_by: `workspace-token:${w.id}`, claimed_label: "Someone Else" });
  });
  it("a verified user cannot approve (no membership yet), and an unauthenticated caller cannot either", async () => {
    const s = boot(oidcRuntime());
    const { w, base, pid } = await proposal(s, true);
    expect((await call(s.app, "POST", `${base}/proposals/${pid}/approve`, { token: signJwt(rsa), payload: { decidedBy: "x" } })).status).toBe(404);
    expect((await call(s.app, "POST", `${base}/proposals/${pid}/approve`, { payload: { decidedBy: "x" } })).status).toBe(401);
    expect((s.db.prepare("SELECT COUNT(*) n FROM approvals").get() as { n: number }).n).toBe(0);
    expect(w.id).toBeTruthy();
  });
  it("still validates the approval body: unknown fields and a blank name are rejected", async () => {
    const s = boot();
    const { w, base, pid } = await proposal(s);
    expect((await call(s.app, "POST", `${base}/proposals/${pid}/approve`, { token: w.token, payload: { decidedBy: "a", approvedBy: "b" } })).status).toBe(400);
    expect((await call(s.app, "POST", `${base}/proposals/${pid}/approve`, { token: w.token, payload: { decidedBy: "" } })).status).toBe(400);
  });
});

describe("migration 004 is additive", () => {
  it("applies on top of existing data without changing it", () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of ["001_init.sql", "002_ai.sql", "003_generation_identity.sql"]) {
      db.exec(readFileSync(`src/db/migrations/${f}`, "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f);
    }
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_old', 'Old Co', 'hash-old', '2026-01-01')").run();
    const cols = "id, name, token_hash, meta_account_id, created_at";
    const before = db.prepare(`SELECT ${cols} FROM workspaces`).all();
    expect(migrate(db)).toEqual(["004_users.sql", "005_memberships.sql", "006_meta_accounts.sql", "007_credentials.sql", "008_drop_credential_hint.sql", "009_website_analysis.sql", "010_website_content_hash.sql", "011_ai_reservations.sql", "012_reservation_state_and_fill_ledger.sql", "013_campaign_plans.sql", "014_lead_status_job_retries.sql", "015_organizations_permissions.sql", "016_brand_kit_assets.sql", "017_plans_lifecycle.sql", "018_creative_studio.sql", "019_team_operations.sql", "020_lead_lineage_forms.sql", "021_experiments_learnings.sql", "022_integration_tests.sql", "023_audit_append_only.sql"]);
    expect(db.prepare(`SELECT ${cols} FROM workspaces`).all()).toEqual(before);
    expect((db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0);
    const approvalCols = (db.prepare("PRAGMA table_info(approvals)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(approvalCols).toContain("claimed_label");
    expect(() => db.prepare("INSERT INTO users (id, issuer, subject, created_at, last_seen_at) VALUES ('u1','i','s','t','t')").run()).not.toThrow();
    expect(() => db.prepare("INSERT INTO users (id, issuer, subject, created_at, last_seen_at) VALUES ('u2','i','s','t','t')").run()).toThrow(/UNIQUE/);
    db.close();
  });
});
