/**
 * M4.4c Package 2: browser and deployment boundary.
 *   - security headers on every kind of response,
 *   - Host validation (DNS rebinding) and Origin validation on state-changing requests, without ever trusting forwarded headers,
 *   - the bundled UI stays compatible with the policy, and its token storage is characterized (it is NOT changed here),
 *   - a general per-person API limiter that only sees verified identities and leaves the credential and claim limits alone.
 * Everything runs through the server's own test interface with in-memory databases, injected clocks and throwaway keys.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspaceForUser } from "../src/app/memberships.js";
import { upsertUser } from "../src/app/users.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig, workspaceTokenRuntime, type AuthRuntime } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring } from "../src/credentials/keys.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { DEFAULT_API_RATE_LIMITS, RateLimiter, loadApiRateLimits, type ApiRateLimits, type CredentialRateLimits } from "../src/server/rateLimit.js";
import { CONTENT_SECURITY_POLICY, DEFAULT_SECURITY_CONFIG, loadSecurityConfig, type SecurityConfig } from "../src/server/security.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OPEN_POLICY, claims, makeKey, signJwt , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const BASE_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const clock = () => {
  let t = 70_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};
const publicCfg = (over: Partial<SecurityConfig> = {}): SecurityConfig => ({ publicOrigins: ["https://app.example.com"], hstsMaxAgeSec: 0, ...over });

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length) open.pop()?.();
});

interface BootOptions {
  oidc?: boolean;
  security?: SecurityConfig;
  apiLimits?: ApiRateLimits;
  rateLimits?: CredentialRateLimits;
  limiter?: RateLimiter;
  now?: () => number;
  policy?: "open" | "real";
}
function boot(o: BootOptions = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, keyProvider: new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") });
  const runtime: AuthRuntime = o.oidc
    ? buildAuthRuntime(
        loadAuthConfig(o.policy === "real" ? { ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "idp|alice,idp|bob" } : BASE_ENV),
        { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, ...(o.policy === "real" ? {} : { policy: OPEN_POLICY }) },
      )
    : workspaceTokenRuntime;
  const app = buildServer(ctx, runtime, { security: o.security, apiLimits: o.apiLimits, rateLimits: o.rateLimits, limiter: o.limiter, now: o.now });
  open.push(() => db.open && db.close());
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { db, ctx, app, count };
}
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
/** An owner of a fresh workspace, created through the services; requests use real signed-token authentication. */
function owner(w: ReturnType<typeof boot>, name: string) {
  const user = upsertUser(w.ctx, { issuer: ISSUER, subject: `idp|${name}`, email: null, displayName: name });
  const ws = createWorkspaceForUser(w.ctx, userActor(user.id) as never, `${name} Co`);
  return { token: jwtFor(name), wid: ws.id };
}

type Headers = Record<string, string>;
interface Reply { status: number; headers: Record<string, any>; text: string; body: any }
async function send(app: FastifyInstance, method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS", url: string, o: { headers?: Headers; token?: string; payload?: unknown; raw?: string } = {}): Promise<Reply> {
  const headers: Headers = { ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const payload = o.raw ?? (o.payload === undefined ? undefined : JSON.stringify(o.payload));
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await app.inject({ method, url, headers, payload });
  let body: any = null;
  try { body = res.body ? JSON.parse(res.body) : null; } catch { /* not JSON */ }
  return { status: res.statusCode, headers: res.headers, text: res.body, body };
}

/* ====================================================================================================================
 * headers
 * ================================================================================================================== */

describe("security headers", () => {
  const EXPECTED: Record<string, string> = {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  };
  const expectSecure = (r: Reply, what: string) => {
    for (const [k, v] of Object.entries(EXPECTED)) expect(r.headers[k], `${what}: ${k}`).toBe(v);
    for (const k of Object.keys(r.headers)) expect(k.startsWith("access-control-"), `${what}: ${k}`).toBe(false); // no CORS, ever
    expect(r.headers["strict-transport-security"], what).toBeUndefined(); // default config: never
    expect(r.headers["x-frame-options"], what).toBeUndefined(); // frame-ancestors in the CSP is the one frame policy
  };

  it("the policy is strict: default deny, same-origin scripts, styles and connections, no framing, no plugins, no inline or eval", () => {
    expect(CONTENT_SECURITY_POLICY).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|blob:|https?:/);
  });

  it("is present on static files, normal API answers, and every kind of error answer", async () => {
    const t = boot({ apiLimits: { apiMax: 10, apiWindowSec: 60 } });
    const ws = createWorkspace(t.ctx, "Header Co");
    const auth = { authorization: `Bearer ${ws.token}` };
    const cases: Array<[string, Promise<Reply>, number]> = [
      ["index page", send(t.app, "GET", "/"), 200],
      ["script", send(t.app, "GET", "/app.js"), 200],
      ["second script", send(t.app, "GET", "/ai.js"), 200],
      ["stylesheet", send(t.app, "GET", "/style.css"), 200],
      ["HEAD of the page", send(t.app, "HEAD", "/"), 200],
      ["health", send(t.app, "GET", "/api/health"), 200],
      ["config", send(t.app, "GET", "/api/config"), 200],
      ["authenticated answer", send(t.app, "GET", `/api/workspaces/${ws.workspace.id}`, { headers: auth }), 200],
      ["created", send(t.app, "POST", "/api/workspaces", { payload: { name: "Another Co" } }), 201],
      ["401", send(t.app, "GET", `/api/workspaces/${ws.workspace.id}`), 401],
      ["401 bad token", send(t.app, "GET", `/api/workspaces/${ws.workspace.id}`, { token: "msw_nope" }), 401],
      ["403 role", send(t.app, "POST", `/api/workspaces/${ws.workspace.id}/legacy-token/disable`, { headers: auth }), 403],
      ["404 unknown API path", send(t.app, "GET", "/api/nope"), 404],
      ["404 unknown file", send(t.app, "GET", "/no-such-file.js"), 404],
      ["404 unknown route method", send(t.app, "OPTIONS", "/api/workspaces"), 404],
      ["400 bad JSON", send(t.app, "POST", "/api/workspaces", { raw: "{not json" }), 400],
      ["400 validation", send(t.app, "POST", "/api/workspaces", { payload: { name: "" } }), 400],
      ["413 oversized body", send(t.app, "POST", "/api/workspaces", { raw: JSON.stringify({ name: "x".repeat(300_000) }) }), 413],
      ["403 host", send(t.app, "GET", "/api/health", { headers: { host: "evil.example" } }), 403],
      ["403 origin", send(t.app, "POST", "/api/workspaces", { headers: { origin: "https://evil.example" }, payload: { name: "Evil Co" } }), 403],
    ];
    for (const [what, p, status] of cases) {
      const r = await p;
      expect([what, r.status]).toEqual([what, status]);
      expectSecure(r, what);
    }
  });

  it("is present on 429 and 500 answers, and credential answers keep their no-store policy alongside", async () => {
    const t = boot({ oidc: true, apiLimits: { apiMax: 10, apiWindowSec: 60 } });
    const a = owner(t, "alice");
    // 500: a route that throws, to prove the error handler's answer is covered too
    t.app.get("/boom", async () => { throw new Error("boom with SECRET-INTERNALS"); }); // outside /api so the default-deny auth rule does not answer first
    const boom = await send(t.app, "GET", "/boom");
    expect([boom.status, boom.body.error.code]).toEqual([500, "internal"]);
    expect(boom.text).not.toContain("SECRET-INTERNALS");
    expectSecure(boom, "500");
    const cred = await send(t.app, "GET", `/api/workspaces/${a.wid}/credentials`, { token: a.token });
    expect(cred.status).toBe(200);
    expectSecure(cred, "credentials");
    expect(cred.headers["cache-control"]).toBe("no-store");
    for (let i = 0; i < 10; i++) await send(t.app, "GET", "/api/me", { token: a.token });
    const limited = await send(t.app, "GET", "/api/me", { token: a.token });
    expect(limited.status).toBe(429);
    expectSecure(limited, "429");
  });

  it("a route that sets one of these headers itself keeps its value, and still gets the others", async () => {
    const t = boot();
    t.app.get("/custom-policy", async (_req, reply) => reply.header("content-security-policy", "default-src 'none'; sandbox").send("ok"));
    const r = await send(t.app, "GET", "/custom-policy");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("HSTS is off by default, never sent for loopback or from a forwarded header, and sent only for an asserted https origin's own host", async () => {
    const hsts = publicCfg({ hstsMaxAgeSec: 3600 });
    const t = boot({ security: hsts });
    const get = (host: string, extra: Headers = {}) => send(t.app, "GET", "/api/health", { headers: { host, ...extra } });
    expect((await get("app.example.com")).headers["strict-transport-security"]).toBe("max-age=3600");
    expect((await get("app.example.com:443")).headers["strict-transport-security"]).toBe("max-age=3600");
    expect((await get("localhost:3000")).headers["strict-transport-security"]).toBeUndefined();
    expect((await get("127.0.0.1:3000")).headers["strict-transport-security"]).toBeUndefined();
    expect((await get("localhost:3000", { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com", forwarded: "proto=https;host=app.example.com" })).headers["strict-transport-security"]).toBeUndefined();
    const refused = await get("evil.example");
    expect(refused.status).toBe(403);
    expect(refused.headers["strict-transport-security"]).toBeUndefined();
    // an http loopback origin listed next to the https one is still never an HSTS host
    const mixed = boot({ security: { publicOrigins: ["https://app.example.com", "http://localhost:3000"], hstsMaxAgeSec: 3600 } });
    expect((await send(mixed.app, "GET", "/api/health", { headers: { host: "localhost:3000" } })).headers["strict-transport-security"]).toBeUndefined();
    expect((await send(mixed.app, "GET", "/api/health", { headers: { host: "app.example.com" } })).headers["strict-transport-security"]).toBe("max-age=3600");
    const off = boot({ security: publicCfg({ hstsMaxAgeSec: 0 }) });
    expect((await send(off.app, "GET", "/api/health", { headers: { host: "app.example.com" } })).headers["strict-transport-security"]).toBeUndefined();
  });
});

/* ====================================================================================================================
 * Host validation
 * ================================================================================================================== */

describe("Host validation", () => {
  const statusFor = async (app: FastifyInstance, host: string, extra: Headers = {}) => (await send(app, "GET", "/api/health", { headers: { host, ...extra } })).status;

  it("accepts loopback names on any port, case-insensitively, and nothing else, by default", async () => {
    const t = boot();
    for (const h of ["localhost", "localhost:3000", "LOCALHOST:3000", "127.0.0.1", "127.0.0.1:8080", "[::1]", "[::1]:3000"]) expect(await statusFor(t.app, h), h).toBe(200);
    const bad = ["evil.example", "localhost.evil.example", "127.0.0.1.evil.example", "localhost:3000.evil.example", "localhost.", "0.0.0.0:3000", "127.0.0.2", "10.0.0.5:3000", "[::2]", "localhost@evil.example", "evil.example@localhost", "evil.example#@localhost", "localhost:99999", "localhost:abc", "local host", "localhost/evil", "localhost\\evil", "local\u0000host", "xn--evil", "app.example.com"];
    for (const h of bad) {
      const r = await send(t.app, "GET", "/api/health", { headers: { host: h } });
      expect([h, r.status, r.body?.error?.code]).toEqual([h, 403, "host_not_allowed"]);
      expect(r.text).toBe('{"error":{"code":"host_not_allowed","message":"This host is not allowed"}}'); // fixed text: the value is never echoed
    }
  });

  it("accepts a configured public origin's host (default port implied or explicit), plus loopback, and not look-alikes", async () => {
    const t = boot({ security: publicCfg() });
    for (const h of ["app.example.com", "app.example.com:443", "APP.Example.com", "localhost:3000", "127.0.0.1:3000"]) expect(await statusFor(t.app, h), h).toBe(200);
    for (const h of ["app.example.com:8443", "app.example.com:80", "app.example.com.evil.example", "evilapp.example.com", "www.app.example.com", "example.com", "app.example.com@evil.example"]) expect(await statusFor(t.app, h), h).toBe(403);
    const custom = boot({ security: { publicOrigins: ["https://app.example.com:8443"], hstsMaxAgeSec: 0 } });
    expect(await statusFor(custom.app, "app.example.com:8443")).toBe(200);
    for (const h of ["app.example.com", "app.example.com:443"]) expect(await statusFor(custom.app, h), h).toBe(403);
  });

  it("applies to every kind of request, including static files, and runs before authentication", async () => {
    const t = boot();
    const ws = createWorkspace(t.ctx, "Host Co");
    for (const [m, u] of [["GET", "/"], ["GET", "/app.js"], ["GET", "/api/config"], ["POST", "/api/workspaces"], ["GET", `/api/workspaces/${ws.workspace.id}`]] as const) {
      const r = await send(t.app, m, u, { headers: { host: "evil.example" }, token: ws.token, payload: m === "POST" ? { name: "X Co" } : undefined });
      expect([m, u, r.status]).toEqual([m, u, 403]); // a VALID token does not help
    }
    expect(t.count("SELECT COUNT(*) n FROM workspaces")).toBe(1); // and nothing was created
    // refused before authentication ever runs: with NO credentials the answer is still the host refusal, not a 401
    const anon = await send(t.app, "GET", `/api/workspaces/${ws.workspace.id}`, { headers: { host: "evil.example" } });
    expect([anon.status, anon.body.error.code]).toEqual([403, "host_not_allowed"]);
  });

  it("never trusts forwarded headers: they cannot grant a host, and are never reflected", async () => {
    const t = boot();
    const forwarded = { "x-forwarded-host": "localhost", forwarded: "host=localhost", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" };
    expect(await statusFor(t.app, "evil.example", forwarded)).toBe(403);
    const r = await send(t.app, "GET", "/api/config", { headers: { host: "localhost:3000", "x-forwarded-host": "evil.example", forwarded: "host=evil.example;proto=http", "x-forwarded-proto": "http" } });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.headers) + r.text).not.toContain("evil.example");
  });
});

/* ====================================================================================================================
 * Origin validation
 * ================================================================================================================== */

describe("Origin validation on state-changing requests", () => {
  const create = (t: ReturnType<typeof boot>, headers: Headers) => send(t.app, "POST", "/api/workspaces", { headers, payload: { name: "Origin Co" } });

  it("loopback: a request may come from the same local address and port, or from no browser at all; anything else is refused and does nothing", async () => {
    const t = boot();
    const ok = async (h: Headers) => (await create(t, h)).status;
    expect(await ok({})).toBe(201); // curl, server-to-server, tests: no Origin
    expect(await ok({ host: "localhost:3000", origin: "http://localhost:3000" })).toBe(201);
    expect(await ok({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" })).toBe(201);
    expect(await ok({ host: "[::1]:3000", origin: "http://[::1]:3000" })).toBe(201);
    expect(await ok({ host: "localhost:3000", "sec-fetch-site": "same-origin" })).toBe(201);
    expect(await ok({ host: "localhost:3000", "sec-fetch-site": "none" })).toBe(201);
    const created = t.count("SELECT COUNT(*) n FROM workspaces");
    const refused: Array<[string, Headers]> = [
      ["another site", { host: "localhost:3000", origin: "https://evil.example" }],
      ["another local program (other port)", { host: "localhost:3000", origin: "http://localhost:4000" }],
      ["another name for this machine", { host: "127.0.0.1:3000", origin: "http://localhost:3000" }],
      ["the null origin", { host: "localhost:3000", origin: "null" }],
      ["wrong scheme", { host: "localhost:3000", origin: "https://localhost:3000" }],
      ["trailing slash", { host: "localhost:3000", origin: "http://localhost:3000/" }],
      ["path", { host: "localhost:3000", origin: "http://localhost:3000/x" }],
      ["upper case", { host: "localhost:3000", origin: "HTTP://LOCALHOST:3000" }],
      ["userinfo", { host: "localhost:3000", origin: "http://user@localhost:3000" }],
      ["garbage", { host: "localhost:3000", origin: "not a url" }],
      ["empty", { host: "localhost:3000", origin: "" }],
      ["look-alike", { host: "localhost:3000", origin: "http://localhost.evil.example:3000" }],
      ["cross-site fetch metadata, no Origin", { host: "localhost:3000", "sec-fetch-site": "cross-site" }],
      ["same-site fetch metadata, no Origin", { host: "localhost:3000", "sec-fetch-site": "same-site" }],
      ["cross-site fetch metadata despite a matching Origin", { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "cross-site" }],
    ];
    for (const [what, h] of refused) {
      const r = await create(t, h);
      expect([what, r.status, r.body?.error?.code]).toEqual([what, 403, "origin_not_allowed"]);
      expect(r.text).toBe('{"error":{"code":"origin_not_allowed","message":"This origin is not allowed"}}');
    }
    expect(t.count("SELECT COUNT(*) n FROM workspaces")).toBe(created); // every refused request changed nothing
  });

  it("with public origins: exactly the configured origins are accepted, even when a proxy rewrites Host to the loopback address", async () => {
    const t = boot({ security: publicCfg() });
    const ok = async (h: Headers) => (await create(t, h)).status;
    expect(await ok({ host: "app.example.com", origin: "https://app.example.com" })).toBe(201);
    expect(await ok({ host: "127.0.0.1:3000", origin: "https://app.example.com" })).toBe(201); // typical proxy that rewrites Host to the upstream address
    for (const origin of ["http://app.example.com", "https://app.example.com:8443", "https://www.app.example.com", "https://evil.example", "https://app.example.com.evil.example", "null"]) {
      expect(await ok({ host: "app.example.com", origin }), origin).toBe(403);
    }
    // a public origin is NOT enough for a different, unlisted Host
    expect(await ok({ host: "evil.example", origin: "https://app.example.com" })).toBe(403);
  });

  it("covers PUT, PATCH and DELETE, is decided before authentication, and is never a substitute for it", async () => {
    const t = boot();
    const ws = createWorkspace(t.ctx, "Method Co");
    const base = `/api/workspaces/${ws.workspace.id}`;
    const evil = { origin: "https://evil.example" };
    for (const [m, u, p] of [["PUT", `${base}/brain`, BRAIN], ["PATCH", base, { metaAccountId: null }], ["DELETE", `${base}/members/usr_x`, undefined], ["POST", `${base}/campaigns/generate`, {}]] as const) {
      const bad = await send(t.app, m, u, { headers: evil, token: ws.token, payload: p });
      expect([m, bad.status, bad.body.error.code]).toEqual([m, 403, "origin_not_allowed"]); // a VALID token does not help
    }
    const noCredentials = await send(t.app, "PUT", `${base}/brain`, { headers: evil, payload: BRAIN });
    expect([noCredentials.status, noCredentials.body.error.code]).toEqual([403, "origin_not_allowed"]); // the origin refusal comes before the 401
    const good = { host: "localhost:3000", origin: "http://localhost:3000" };
    expect((await send(t.app, "PUT", `${base}/brain`, { headers: good, payload: BRAIN })).status).toBe(401); // right origin, no credentials: authentication still decides
    expect((await send(t.app, "PUT", `${base}/brain`, { headers: good, token: "msw_wrong", payload: BRAIN })).status).toBe(401);
    expect((await send(t.app, "PUT", `${base}/brain`, { headers: good, token: ws.token, payload: BRAIN })).status).toBe(200);
    expect(t.count("SELECT COUNT(*) n FROM campaigns")).toBe(0);
  });

  it("does not restrict reads, and adds no CORS: a cross-origin page can neither preflight nor read", async () => {
    const t = boot();
    const read = await send(t.app, "GET", "/api/config", { headers: { host: "localhost:3000", origin: "https://evil.example" } });
    expect(read.status).toBe(200);
    expect(Object.keys(read.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
    const pre = await send(t.app, "OPTIONS", "/api/workspaces", { headers: { host: "localhost:3000", origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
    expect(pre.status).toBeGreaterThanOrEqual(400);
    expect(Object.keys(pre.headers).filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  it("holds in OIDC mode too: a refused origin never reaches token verification or the membership lookup", async () => {
    const t = boot({ oidc: true });
    const a = owner(t, "alice");
    const users = t.count("SELECT COUNT(*) n FROM users");
    const r = await send(t.app, "POST", "/api/workspaces", { headers: { host: "localhost:3000", origin: "https://evil.example" }, token: a.token, payload: { name: "Evil Co" } });
    expect(r.status).toBe(403);
    expect(t.count("SELECT COUNT(*) n FROM workspaces")).toBe(1);
    expect(t.count("SELECT COUNT(*) n FROM users")).toBe(users);
    const ok = await send(t.app, "POST", "/api/workspaces", { headers: { host: "localhost:3000", origin: "http://localhost:3000" }, token: a.token, payload: { name: "Fine Co" } });
    expect(ok.status).toBe(201);
  });
});

/* ====================================================================================================================
 * configuration
 * ================================================================================================================== */

describe("configuration is validated at startup", () => {
  it("defaults to loopback only with HSTS off, and normalizes valid origins", () => {
    expect(loadSecurityConfig({})).toEqual(DEFAULT_SECURITY_CONFIG);
    expect(loadSecurityConfig({ PUBLIC_ORIGINS: " https://App.Example.com , https://app.example.com , https://other.example:8443" })).toEqual({ publicOrigins: ["https://app.example.com", "https://other.example:8443"], hstsMaxAgeSec: 0 });
    expect(loadSecurityConfig({ PUBLIC_ORIGINS: "http://localhost:3000" }).publicOrigins).toEqual(["http://localhost:3000"]);
    expect(loadSecurityConfig({ PUBLIC_ORIGINS: "https://app.example.com", HSTS_MAX_AGE_SEC: "86400" }).hstsMaxAgeSec).toBe(86400);
  });

  it("refuses wildcards, non-origins, plain http for public names, and HSTS without TLS asserted, naming variables only", () => {
    const bad = (env: Record<string, string>, re: RegExp) => expect(() => loadSecurityConfig(env), JSON.stringify(env)).toThrow(re);
    for (const v of ["*", "https://*.example.com", "app.example.com", "https://app.example.com/", "https://app.example.com/path", "https://u:p@app.example.com", "https://app.example.com?x=1", "ftp://app.example.com", "https://", "http://app.example.com"]) bad({ PUBLIC_ORIGINS: v }, /PUBLIC_ORIGINS/);
    bad({ HSTS_MAX_AGE_SEC: "60" }, /HSTS_MAX_AGE_SEC: needs an https origin/);
    bad({ PUBLIC_ORIGINS: "http://localhost:3000", HSTS_MAX_AGE_SEC: "60" }, /HSTS_MAX_AGE_SEC/);
    for (const v of ["-1", "1.5", "abc", "63072001"]) bad({ PUBLIC_ORIGINS: "https://app.example.com", HSTS_MAX_AGE_SEC: v }, /HSTS_MAX_AGE_SEC/);
    let msg = "";
    try { loadSecurityConfig({ PUBLIC_ORIGINS: "https://secret-looking-host.example/path" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain("secret-looking-host");
    expect(loadApiRateLimits({})).toEqual(DEFAULT_API_RATE_LIMITS);
    expect(DEFAULT_API_RATE_LIMITS).toEqual({ apiMax: 1200, apiWindowSec: 60 });
    expect(loadApiRateLimits({ API_RL_MAX: "50", API_RL_WINDOW_SEC: " 30 " })).toEqual({ apiMax: 50, apiWindowSec: 30 });
    for (const v of ["0", "9", "abc", "-5", "1.5", "100001"]) expect(() => loadApiRateLimits({ API_RL_MAX: v }), v).toThrow(/API_RL_MAX/);
    expect(() => loadApiRateLimits({ API_RL_WINDOW_SEC: "0", API_RL_MAX: "x" })).toThrow(/API_RL_MAX.*API_RL_WINDOW_SEC/);
  });
});

/* ====================================================================================================================
 * the bundled UI under the policy, and its token storage as it is today
 * ================================================================================================================== */

describe("the bundled UI and the policy", () => {
  const read = (f: string) => readFileSync(`public/${f}`, "utf8");

  it("is compatible with the strict policy: one same-origin module script, one stylesheet, no inline code or style, no third-party or dynamic code", () => {
    const html = read("index.html");
    expect([...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])).toEqual(['<script src="app.js" type="module">']);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i); // no script tag without a src
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<(iframe|object|embed|base)\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
    const css = read("style.css");
    expect(css).not.toMatch(/@import|url\(\s*["']?(?:https?:|\/\/|data:)/i);
    for (const f of ["app.js", "ai.js", "dashboard.js", "recovery.js", "onboarding.js", "aitest.js", "claims.js", "activity.js", "provenance.js", "goal.js", "leads.js", "workspace.js", "brand.js", "plans.js", "creative.js", "team.js", "intake.js", "results.js", "learning.js", "integrations.js", "privacy.js"]) {
      const js = read(f);
      expect(js, f).not.toMatch(/\beval\s*\(|new\s+Function\b|document\.write\b|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|setAttribute\(\s*["']style|\.style\.cssText|createElement\(\s*["'](?:script|iframe|object)/);
      expect(js, f).not.toMatch(/https?:\/\//);
      expect(js, f).not.toMatch(/\bimport\(/);
    }
  });

  it("local-MVP fixes found in the real browser stay fixed: errors are shown (never swallowed), the layout can shrink to a phone, the favicon exists, every navigation link reaches a section", () => {
    const js = read("app.js");
    // with no workspace selected the error must be SHOWN before it is thrown (callers swallow it believing it was shown)
    expect(js).toMatch(/if \(!s\) \{\s*const msg = "Create or select a workspace first";\s*if \(!quiet\) showError\(msg\);[^\n]*\s*throw new Error\(msg\);/);
    const css = read("style.css");
    expect(css).toMatch(/main \{[^}]*grid-template-columns: minmax\(0, 1fr\)/); // a grid item may shrink below its widest content
    expect(css).toMatch(/section \{[^}]*min-width: 0[^}]*overflow-x: auto/); // wide tables scroll inside their card, not the page
    const html = read("index.html");
    expect(html).toContain('<link rel="icon" href="favicon.svg" type="image/svg+xml">');
    expect(readFileSync("public/favicon.svg", "utf8")).toMatch(/^<svg /);
    const targets = [...html.matchAll(/<a href="#([\w-]+)"[^>]*>/g)].map((m) => m[1]);
    expect(targets.length).toBe(13);
    for (const t of targets) expect(html, `nav link #${t} must reach a section`).toMatch(new RegExp(`<section[^>]*id="${t}"`));
  });

  it("characterizes the CURRENT token storage so any change is deliberate: workspace tokens live in localStorage, never in URLs, logs or HTML", () => {
    const js = read("app.js");
    expect([...new Set([...js.matchAll(/localStorage\.(?:getItem|setItem)\(\s*([A-Za-z_"'\w]+)/g)].map((m) => m[1]))].sort()).toEqual(['"ms_by"', "CKEY", "SKEY"].sort());
    expect(js).toMatch(/const SKEY = "ms_sessions", CKEY = "ms_current"/);
    expect(js).not.toMatch(/sessionStorage|document\.cookie|indexedDB/);
    expect(js).not.toMatch(/location\.(?:href|search|hash|assign|replace)|history\.(?:push|replace)State|URLSearchParams/); // nothing is put in or read from the address
    expect(js).not.toMatch(/\?token=|[&?]access_token=|[?&]auth=/);
    expect(js).not.toMatch(/console\.\w+\([^)]*(?:token|session)/i);
    expect(js).toMatch(/headers\.authorization = Auth\.header\(s\)/); // the token travels only in the Authorization header
    expect(js).not.toMatch(/textContent\s*=\s*[^;]*\.token|append\([^)]*\.token/); // and is never rendered
    expect(js).toMatch(/is NOT implemented in this UI/); // there is no person sign-in flow in the UI yet
  });
});

/* ====================================================================================================================
 * the general API limiter
 * ================================================================================================================== */

describe("general API rate limit per verified person", () => {
  const sized = (apiMax: number, extra: Partial<BootOptions> = {}) => {
    const c = clock();
    const limiter = new RateLimiter(c.now);
    const t = boot({ oidc: true, now: c.now, limiter, apiLimits: { apiMax, apiWindowSec: 60 }, ...extra });
    return { ...t, c, limiter };
  };
  const me = (t: ReturnType<typeof sized>, token: string) => send(t.app, "GET", "/api/me", { token });

  it("the (N+1)th request in a window is refused with 429, a fixed body and an accurate Retry-After; the window then resets", async () => {
    const t = sized(5);
    const a = owner(t, "alice");
    for (let i = 0; i < 5; i++) expect((await me(t, a.token)).status, `request ${i + 1}`).toBe(200);
    t.c.advance(20_000);
    const limited = await me(t, a.token);
    expect([limited.status, limited.body.error.code, limited.body.error.message]).toEqual([429, "rate_limited", "Too many requests; try again later"]);
    expect(limited.headers["retry-after"]).toBe("40");
    expect(limited.text).not.toMatch(/alice|api\||user:|60|5/);
    t.c.advance(40_001);
    expect((await me(t, a.token)).status).toBe(200);
  });

  it("is per person: one person's volume never limits another, and it spans all of that person's routes and workspaces", async () => {
    const t = sized(6);
    const a = owner(t, "alice");
    const b = owner(t, "bob");
    for (let i = 0; i < 3; i++) await me(t, a.token);
    for (let i = 0; i < 3; i++) expect((await send(t.app, "GET", `/api/workspaces/${a.wid}`, { token: a.token })).status).toBe(200);
    expect((await me(t, a.token)).status).toBe(429); // 3 + 3 used the whole quota across routes
    expect((await send(t.app, "GET", `/api/workspaces/${a.wid}`, { token: a.token })).status).toBe(429);
    for (let i = 0; i < 6; i++) expect((await me(t, b.token)).status).toBe(200); // bob has his own full quota
    expect((await me(t, b.token)).status).toBe(429);
  });

  it("an unauthenticated caller creates no entry and cannot spend anyone's quota", async () => {
    const t = sized(5);
    const a = owner(t, "alice");
    const before = t.limiter.size;
    const forged = signJwt(makeKey("RS256", "rsa-1"), claims({ sub: "idp|alice" })); // same kid, different key
    const wrongAudience = signJwt(rsa, claims({ sub: "idp|alice", aud: "someone-else" }));
    for (let i = 0; i < 60; i++) {
      for (const headers of [{}, { authorization: "Bearer garbage" }, { authorization: `Bearer ${forged}` }, { authorization: `Bearer ${wrongAudience}` }, { authorization: "Bearer msw_nope" }] as Array<Headers>) {
        const r = await send(t.app, "GET", i % 2 ? "/api/me" : `/api/workspaces/${a.wid}`, { headers });
        expect([401, 404]).toContain(r.status);
      }
    }
    expect(t.limiter.size).toBe(before); // nothing was added
    for (let i = 0; i < 5; i++) expect((await me(t, a.token)).status, `alice request ${i + 1}`).toBe(200); // alice's quota is untouched
  });

  it("a verified person who is not authorized (closed pilot) is refused before the limiter and creates no entry", async () => {
    const t = sized(5, { policy: "real" });
    const before = t.limiter.size;
    for (let i = 0; i < 20; i++) expect((await me(t, jwtFor("mallory"))).status).toBe(403);
    expect(t.limiter.size).toBe(before);
  });

  it("public routes and static files are not counted", async () => {
    const t = sized(5);
    for (let i = 0; i < 40; i++) {
      await send(t.app, "GET", "/api/health");
      await send(t.app, "GET", "/api/config");
      await send(t.app, "GET", "/");
      await send(t.app, "GET", "/app.js");
      await send(t.app, "GET", "/api/nope");
    }
    expect(t.limiter.size).toBe(0);
  });

  it("the legacy workspace token is counted per workspace, never across workspaces", async () => {
    const c = clock();
    const limiter = new RateLimiter(c.now);
    const t = boot({ now: c.now, limiter, apiLimits: { apiMax: 4, apiWindowSec: 60 } });
    const one = createWorkspace(t.ctx, "Token One");
    const two = createWorkspace(t.ctx, "Token Two");
    const get = (w: typeof one) => send(t.app, "GET", `/api/workspaces/${w.workspace.id}`, { token: w.token });
    for (let i = 0; i < 4; i++) expect((await get(one)).status).toBe(200);
    expect((await get(one)).status).toBe(429);
    expect((await get(two)).status).toBe(200);
  });

  it("memory is bounded: many different people cannot grow the table without limit", async () => {
    const c = clock();
    const limiter = new RateLimiter(c.now, 20);
    const t = boot({ oidc: true, now: c.now, limiter, apiLimits: { apiMax: 100, apiWindowSec: 60 } });
    for (let i = 0; i < 120; i++) expect((await send(t.app, "GET", "/api/me", { token: jwtFor(`person${i}`) })).status).toBe(200);
    expect(limiter.size).toBeLessThanOrEqual(40); // the limiter's hard cap is twice its soft cap
  });

  it("leaves the credential limit alone: its own counters still decide, and a general refusal does not spend them", async () => {
    // credential limit tighter than the general one: the credential gate answers (and records its audit event)
    const a1 = sized(1000, { rateLimits: { callerMax: 2, workspaceMax: 100, windowSec: 60, failureMax: 100, failureWindowSec: 300, lockoutSec: 900, deniedAuditMax: 10 } });
    const o1 = owner(a1, "alice");
    const put = (t: ReturnType<typeof sized>, o: { token: string; wid: string }) => send(t.app, "PUT", `/api/workspaces/${o.wid}/credentials/openai`, { token: o.token, payload: { secret: SECRET } });
    expect([(await put(a1, o1)).status, (await put(a1, o1)).status, (await put(a1, o1)).status]).toEqual([201, 200, 429]);
    expect(a1.count("SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rate_limited'")).toBe(1);
    // general limit tighter than the credential one: the general limiter answers first and no credential counter is spent
    const a2 = sized(2);
    const o2 = owner(a2, "alice");
    expect([(await put(a2, o2)).status, (await put(a2, o2)).status, (await put(a2, o2)).status]).toEqual([201, 200, 429]);
    expect(a2.count("SELECT COUNT(*) n FROM audit_events WHERE type = 'credential.rate_limited'")).toBe(0);
    a2.c.advance(61_000); // new window: the credential counters had only seen two requests, so the next write is admitted
    expect((await put(a2, o2)).status).toBe(200);
  });

  it("leaves claim limits alone, and is documented as in-process (not shared between instances)", async () => {
    const src = readFileSync("src/server/app.ts", "utf8");
    expect(src).toMatch(/claim\|\$\{p\.userId\}/); // the claim quota keeps its own key
    expect(src).toMatch(/api\|\$\{who\}/);
    const doc = readFileSync("docs/browser-deployment-security.md", "utf8");
    expect(doc).toMatch(/per process|in-process/i);
    expect(doc).toMatch(/no multi-instance protection/i);
    expect(doc).toMatch(/each counts separately/i);
  });
});
