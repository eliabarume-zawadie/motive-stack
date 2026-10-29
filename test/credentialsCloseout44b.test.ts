/**
 * Milestone 4.4b closeout:
 *   A. the DEPLOYMENT_ENV guard for master-key providers,
 *   B. precondition semantics of create / revoke / delete (stale retries, version history, concurrency),
 *   C. the rate limiter's memory behavior, lockout scope and coverage of every write route.
 * Offline and deterministic: nothing here reads process.env except one test that proves it is NOT consulted.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspaceForUser } from "../src/app/memberships.js";
import { upsertUser } from "../src/app/users.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring, type KeyProvider } from "../src/credentials/keys.js";
import { credentialStartupNotes, selectKeyProvider } from "../src/credentials/provider.js";
import { DEPLOYMENT_ENVS, deploymentEnv, readDeployment } from "../src/deployment.js";
import { migrate, openDb, type Db } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { RateLimiter, type CredentialRateLimits } from "../src/server/rateLimit.js";
import { AUDIENCE, ISSUER, NOW_MS, claims, makeKey, signJwt , OPEN_POLICY , OIDC_REQUIRED } from "./support/jwt.js";

const SECRET = "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60";
const SECRET2 = "FIXTURE-SECRET-SECOND-91ab34cd56ef7801";
const SECRET3 = "FIXTURE-SECRET-THIRD-5566778899aabbcc";
const rsa = makeKey("RS256", "rsa-1");
const runtime = () => buildAuthRuntime(loadAuthConfig({ AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const jwtFor = (name: string) => signJwt(rsa, claims({ sub: `idp|${name}`, name }));
const ident = (n: string) => ({ issuer: ISSUER, subject: `idp|${n}`, email: null, displayName: n });
const ROOMY: CredentialRateLimits = { callerMax: 1000, workspaceMax: 10_000, windowSec: 60, failureMax: 1000, failureWindowSec: 300, lockoutSec: 900, deniedAuditMax: 1000 };
const b64 = () => randomBytes(KEY_BYTES).toString("base64");
const SLOW_BUILD_MS = 20_000;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.unstubAllEnvs();
});

/** A key provider that declares itself managed (a stand-in for an approved key service; not a real one). */
function managedFake(delayMs = 0, hook?: { unwrap?: () => void }): KeyProvider {
  const inner = new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1");
  const wait = delayMs ? () => new Promise<void>((r) => setTimeout(r, delayMs)) : async () => undefined;
  return {
    name: "managed-fake", managed: true, activeKeyId: () => inner.activeKeyId(), hasKey: (k) => inner.hasKey(k),
    wrap: async (d, c) => (await wait(), inner.wrap(d, c)),
    unwrap: async (k, w, c) => (hook?.unwrap?.(), inner.unwrap(k, w, c)),
  };
}

interface Reply { status: number; headers: Record<string, any>; text: string; body: Record<string, any> }
async function send(app: FastifyInstance, method: "GET" | "PUT" | "POST" | "DELETE", url: string, o: { token?: string; body?: unknown; ifMatch?: string | number } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.ifMatch !== undefined) headers["if-match"] = String(o.ifMatch);
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  if (payload !== undefined) headers["content-type"] = "application/json";
  const res = await app.inject({ method, url, headers, payload });
  let body: Record<string, any> = {};
  try { body = res.body ? JSON.parse(res.body) : {}; } catch { /* not JSON */ }
  return { status: res.statusCode, headers: res.headers, text: res.body, body };
}
const count = (db: Db, sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;

/** One owner (alice) of workspace A and one (bob) of B, created through the services; requests use real signed-token authentication. */
function build(o: { env?: Record<string, string>; keys?: KeyProvider | null | "env"; limits?: Partial<CredentialRateLimits>; now?: () => number; limiter?: RateLimiter } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const keys = o.keys === undefined ? new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") : o.keys;
  const ctx: AppContext = buildContext({ db, env: o.env ?? {}, keyProvider: keys === "env" ? undefined : keys });
  const app = buildServer(ctx, runtime(), { rateLimits: { ...ROOMY, ...o.limits }, now: o.now, limiter: o.limiter });
  cleanups.push(() => db.open && db.close());
  const alice = upsertUser(ctx, ident("alice"));
  const bob = upsertUser(ctx, ident("bob"));
  const A = createWorkspaceForUser(ctx, userActor(alice.id) as never, "Alpha Co").id;
  const B = createWorkspaceForUser(ctx, userActor(bob.id) as never, "Bravo Co").id;
  const at = jwtFor("alice");
  const url = (wid: string, kind: string, suffix = "") => `/api/workspaces/${wid}/credentials/${kind}${suffix}`;
  return {
    db, ctx, app, A, B, alice, bob, at, bt: jwtFor("bob"), url,
    put: (kind: string, secret: string, ifMatch?: string | number, wid = A, token = at) => send(app, "PUT", url(wid, kind), { token, body: { secret }, ifMatch }),
    revoke: (kind: string, ifMatch?: string | number, wid = A, token = at) => send(app, "POST", url(wid, kind, "/revoke"), { token, ifMatch }),
    del: (kind: string, ifMatch?: string | number, wid = A, token = at) => send(app, "DELETE", url(wid, kind), { token, ifMatch }),
    list: (wid = A, token = at) => send(app, "GET", `/api/workspaces/${wid}/credentials`, { token }),
    rows: (kind = "openai", wid = A) => db.prepare("SELECT version, status FROM workspace_credentials WHERE workspace_id = ? AND kind = ? ORDER BY version").all(wid, kind) as Array<{ version: number; status: string }>,
    used: (kind: "openai" | "anthropic" | "meta_graph" | "ghl", wid = A) => ctx.credentials.use(wid, kind, (s) => s.toString("utf8")),
  };
}

/* ======================================================================================================================
 * A. DEPLOYMENT_ENV
 * ==================================================================================================================== */

describe("DEPLOYMENT_ENV", () => {
  it("accepts exactly development, test and production; unset or blank is 'unset'; anything else is invalid and never echoed", () => {
    expect([...DEPLOYMENT_ENVS]).toEqual(["development", "test", "production"]);
    for (const v of DEPLOYMENT_ENVS) expect(readDeployment({ DEPLOYMENT_ENV: v })).toEqual({ kind: "set", env: v });
    expect(readDeployment({ DEPLOYMENT_ENV: "  production  " })).toEqual({ kind: "set", env: "production" });
    for (const unset of [undefined, "", "   "]) expect(readDeployment({ DEPLOYMENT_ENV: unset })).toEqual({ kind: "unset" });
    for (const bad of ["prod", "Production", "PRODUCTION", "dev", "staging", "true", "production1", "test,production", "0"]) {
      expect(readDeployment({ DEPLOYMENT_ENV: bad }), bad).toEqual({ kind: "invalid" });
      let msg = "";
      try { deploymentEnv({ DEPLOYMENT_ENV: bad }); } catch (e) { msg = (e as Error).message; }
      expect(msg, bad).toMatch(/DEPLOYMENT_ENV.*development, test, production/);
      expect(msg, bad).toBe("Invalid configuration (DEPLOYMENT_ENV: must be one of development, test, production)"); // fixed text, the value is not echoed
    }
    expect(deploymentEnv({})).toBeNull();
  });

  it("local master keys are usable ONLY with DEPLOYMENT_ENV=development|test AND the exact opt-in; production, unset and invalid never enable them", () => {
    const keyring = { CREDENTIAL_KEYRING: `k1:${b64()}`, CREDENTIAL_ACTIVE_KEY: "k1" };
    const envs: Array<string | undefined> = [undefined, "", "development", "test", "production", "prod", "Production"];
    const flags: Array<string | undefined> = [undefined, "true", "TRUE", "1", "yes", "false", " true"];
    for (const dep of envs) for (const flag of flags) {
      const env = { ...keyring, DEPLOYMENT_ENV: dep, CREDENTIAL_ALLOW_LOCAL_KEYRING: flag };
      const expected = (dep === "development" || dep === "test") && flag === "true";
      expect(LocalKeyring.allowed(env), `${dep}/${flag}`).toBe(expected);
      expect(LocalKeyring.fromEnv(env) !== null, `${dep}/${flag}`).toBe(expected);
      expect(LocalKeyring.ignored(env), `${dep}/${flag}`).toBe(!expected);
    }
  });

  it("selectKeyProvider fails closed and says why", () => {
    const keyring = { CREDENTIAL_KEYRING: `k1:${b64()}`, CREDENTIAL_ACTIVE_KEY: "k1", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" };
    const reason = (env: Record<string, string>, injected?: KeyProvider | null) => selectKeyProvider(env, injected).reason;
    expect(reason({ ...keyring, DEPLOYMENT_ENV: "production" })).toBe("production_requires_managed_provider"); // refused regardless of the opt-in
    expect(reason({ ...keyring })).toBe("local_keyring_not_allowed"); // DEPLOYMENT_ENV unset
    expect(reason({ ...keyring, DEPLOYMENT_ENV: "" })).toBe("local_keyring_not_allowed");
    expect(reason({ ...keyring, DEPLOYMENT_ENV: "development", CREDENTIAL_ALLOW_LOCAL_KEYRING: "" })).toBe("local_keyring_not_allowed");
    expect(reason({ DEPLOYMENT_ENV: "development" })).toBe("disabled"); // nothing configured
    expect(selectKeyProvider({ ...keyring, DEPLOYMENT_ENV: "test" })).toMatchObject({ reason: "ok", provider: { name: "local_keyring" } });
    expect(selectKeyProvider({ ...keyring, DEPLOYMENT_ENV: "development" }).reason).toBe("ok");
    expect(() => selectKeyProvider({ ...keyring, DEPLOYMENT_ENV: "prod" })).toThrow(/DEPLOYMENT_ENV/); // a typo must not select a weaker mode
    // injected providers (how code, and later an approved managed service, supplies one)
    const local = new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1");
    const managed = managedFake();
    expect(reason({ DEPLOYMENT_ENV: "production" }, local)).toBe("production_requires_managed_provider");
    expect(reason({ DEPLOYMENT_ENV: "production" }, managed)).toBe("ok");
    expect(reason({ DEPLOYMENT_ENV: "production" }, { ...managed, managed: "yes" as unknown as boolean })).toBe("production_requires_managed_provider"); // exactly true
    expect(reason({ DEPLOYMENT_ENV: "production" }, null)).toBe("disabled");
    for (const dep of ["development", "test", undefined]) expect(reason({ DEPLOYMENT_ENV: dep ?? "" }, local), String(dep)).toBe("ok"); // a code-level choice, not configuration
    expect(() => selectKeyProvider({ DEPLOYMENT_ENV: "nope" }, managed)).toThrow(/DEPLOYMENT_ENV/);
  });

  it("an invalid value stops context creation; production with the local keyring in every form leaves the vault off", () => {
    const db = openDb(":memory:");
    migrate(db);
    cleanups.push(() => db.open && db.close());
    expect(() => buildContext({ db, env: { DEPLOYMENT_ENV: "Production" } })).toThrow(/DEPLOYMENT_ENV/);
    const keyring = { CREDENTIAL_KEYRING: `k1:${b64()}`, CREDENTIAL_ACTIVE_KEY: "k1", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" };
    const prod = buildContext({ db, env: { ...keyring, DEPLOYMENT_ENV: "production" } }).credentials;
    expect([prod.available, prod.providerName]).toEqual([false, null]);
    const dev = buildContext({ db, env: { ...keyring, DEPLOYMENT_ENV: "development" } }).credentials;
    expect([dev.available, dev.providerName]).toEqual([true, "local_keyring"]);
    expect(buildContext({ db, env: { ...keyring, DEPLOYMENT_ENV: "production" }, keyProvider: new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") }).credentials.available).toBe(false);
    expect(buildContext({ db, env: { DEPLOYMENT_ENV: "production" }, keyProvider: managedFake() }).credentials.available).toBe(true);
  });

  // These two tests build 2 and 5 complete servers, each applying every migration to a fresh in-memory database (about 75 ms each when the machine is idle; 0.9 s per test).
  // That is CPU-bound work with no shared state, so it slows several-fold when the full suite runs many files at once: one of five full runs exceeded the 5 s default (5.9 s).
  // The timeout is raised for these two tests only; the assertions are unchanged.
  it("production without an approved managed provider: every credential write answers 503, the list says 'not available', nothing is stored", async () => {
    const keyring = { CREDENTIAL_KEYRING: `k1:${b64()}`, CREDENTIAL_ACTIVE_KEY: "k1", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true", DEPLOYMENT_ENV: "production" };
    for (const keys of ["env", new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1")] as const) {
      const w = build({ env: keyring, keys });
      expect(w.ctx.credentials.available).toBe(false);
      for (const r of [await w.put("openai", SECRET), await w.revoke("openai", 1), await w.del("openai", 1)]) {
        expect([r.status, r.body.error.code]).toEqual([503, "credentials_unavailable"]);
        expect(r.text).not.toMatch(/keyring|DEPLOYMENT|production|CREDENTIAL_|local|provider/i);
      }
      expect((await w.list()).body).toEqual({ available: false, credentials: [] });
      expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    }
  }, SLOW_BUILD_MS);

  it("production WITH a managed provider works end to end; development and test still need the explicit opt-in", async () => {
    const prod = build({ env: { DEPLOYMENT_ENV: "production" }, keys: managedFake() });
    expect((await prod.put("openai", SECRET)).status).toBe(201);
    expect((await prod.put("openai", SECRET2, 1)).status).toBe(200);
    expect(await prod.used("openai")).toBe(SECRET2);
    for (const dep of ["development", "test"]) {
      const keyring = { DEPLOYMENT_ENV: dep, CREDENTIAL_KEYRING: `k1:${b64()}`, CREDENTIAL_ACTIVE_KEY: "k1" };
      expect((await build({ env: keyring, keys: "env" }).put("openai", SECRET)).status, `${dep} without opt-in`).toBe(503);
      expect((await build({ env: { ...keyring, CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" }, keys: "env" }).put("openai", SECRET)).status, `${dep} with opt-in`).toBe(201);
    }
  }, SLOW_BUILD_MS);

  it("startup notes tell the operator the truth without repeating any configured value", () => {
    const key = b64();
    const env = { CREDENTIAL_KEYRING: `k1:${key}`, CREDENTIAL_ACTIVE_KEY: "k1", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" };
    const text = (e: Record<string, string>, on: boolean) => credentialStartupNotes(e, on).map((n) => `${n.level}: ${n.text}`).join("\n");
    expect(text({}, false)).toBe(""); // a plain local start prints no credential warning: nothing is configured, nothing is refused
    expect(text({ CREDENTIAL_KEYRING: env.CREDENTIAL_KEYRING }, false)).toMatch(/warn: DEPLOYMENT_ENV is not set/); // a keyring without a deployment label is exactly what the notice is for
    expect(text({ CREDENTIAL_ALLOW_LOCAL_KEYRING: "true" }, false)).toMatch(/warn: DEPLOYMENT_ENV is not set/);
    expect(text(env, false)).toMatch(/warn: DEPLOYMENT_ENV is not set/);
    expect(LocalKeyring.allowed(env)).toBe(false); // and the guard still refuses the local keyring while it is unset
    expect(text({ ...env, DEPLOYMENT_ENV: "production" }, false)).toMatch(/production: credential storage is OFF.*no approved managed key provider.*refused in production/s);
    expect(text({ ...env, DEPLOYMENT_ENV: "production" }, false)).toMatch(/ignored in production/);
    expect(text({ DEPLOYMENT_ENV: "production" }, true)).toMatch(/info: .*ON through an approved managed key provider/);
    expect(text({ DEPLOYMENT_ENV: "development", CREDENTIAL_KEYRING: env.CREDENTIAL_KEYRING }, false)).toMatch(/set but ignored.*BOTH DEPLOYMENT_ENV=development \(or test\) AND CREDENTIAL_ALLOW_LOCAL_KEYRING=true/);
    expect(text({ ...env, DEPLOYMENT_ENV: "test" }, true)).toBe(""); // working as intended: nothing to warn about
    for (const e of [{}, env, { ...env, DEPLOYMENT_ENV: "production" }, { ...env, DEPLOYMENT_ENV: "test" }]) expect(text(e, false)).not.toContain(key);
  });

  it("is deterministic: the real process environment is never consulted", async () => {
    vi.stubEnv("DEPLOYMENT_ENV", "production");
    vi.stubEnv("CREDENTIAL_ALLOW_LOCAL_KEYRING", "true");
    vi.stubEnv("CREDENTIAL_KEYRING", `k1:${b64()}`);
    vi.stubEnv("CREDENTIAL_ACTIVE_KEY", "k1");
    expect(selectKeyProvider({}).reason).toBe("disabled"); // an empty environment, whatever the process has
    expect(selectKeyProvider({ DEPLOYMENT_ENV: "test", CREDENTIAL_ALLOW_LOCAL_KEYRING: "true", CREDENTIAL_KEYRING: `k1:${b64()}`, CREDENTIAL_ACTIVE_KEY: "k1" }).reason).toBe("ok"); // the passed one wins
    const w = build({ keys: new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") }); // env {} + injected provider
    expect((await w.put("openai", SECRET)).status).toBe(201);
  });

  it("only the deployment module reads DEPLOYMENT_ENV, and only the provider module builds a key provider from the environment", () => {
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p.replace(/\\/g, "/")); } };
    walk("src");
    const using = (re: RegExp) => files.filter((f) => re.test(readFileSync(f, "utf8"))).sort();
    expect(using(/env\.DEPLOYMENT_ENV|env\["DEPLOYMENT_ENV/)).toEqual(["src/deployment.ts"]);
    expect(using(/LocalKeyring\.fromEnv\(/).filter((f) => f !== "src/credentials/keys.ts")).toEqual(["src/credentials/provider.ts"]);
    // The server (context.ts) and the operator tool (keyOps.ts) must make the identical guarded decision, so both call the one function. Any other caller fails this test.
    expect(using(/selectKeyProvider\(/).filter((f) => f !== "src/credentials/provider.ts")).toEqual(["src/app/context.ts", "src/credentials/keyOps.ts"]);
  });
});

/* ======================================================================================================================
 * B. mutation semantics
 * ==================================================================================================================== */

describe("stale requests can never touch a newer version", () => {
  it("an old If-Match on revoke or delete is refused after every kind of later change, and the newer credential survives", async () => {
    const w = build();
    await w.put("openai", SECRET); // v1
    await w.put("openai", SECRET2, 1); // v2
    expect([(await w.revoke("openai", 1)).status, (await w.del("openai", 1)).status]).toEqual([412, 412]); // retries of v1-era requests
    expect(await w.used("openai")).toBe(SECRET2);
    expect((await w.revoke("openai", 2)).body.outcome).toBe("revoked"); // v2 revoked
    expect((await w.put("openai", SECRET3, 2)).body.credential.version).toBe(3); // re-created as v3
    // the retried v2 revoke / delete must not touch v3
    expect([(await w.revoke("openai", 2)).status, (await w.del("openai", 2)).status]).toEqual([412, 412]);
    expect(await w.used("openai")).toBe(SECRET3);
    expect((await w.del("openai", 3)).body.outcome).toBe("deleted");
    expect((await w.del("openai", 3)).body.outcome).toBe("unchanged"); // the current version's retry is a safe no-op
    expect((await w.put("openai", SECRET, 3)).body.credential.version).toBe(4); // re-created as v4
    expect([(await w.del("openai", 3)).status, (await w.revoke("openai", 3)).status]).toEqual([412, 412]);
    expect(await w.used("openai")).toBe(SECRET);
    expect(w.rows().map((r) => `${r.version}:${r.status}`)).toEqual(["1:deleted", "2:deleted", "3:deleted", "4:active"]);
  });

  it("missing and stale preconditions get the documented codes on every write route", async () => {
    const w = build();
    await w.put("openai", SECRET);
    const cases: Array<[string, (m?: number) => Promise<Reply>]> = [
      ["replace", (m) => w.put("openai", SECRET2, m)],
      ["revoke", (m) => w.revoke("openai", m)],
      ["delete", (m) => w.del("openai", m)],
    ];
    for (const [name, call] of cases) {
      const missing = await call(undefined);
      const stale = await call(9);
      expect([name, missing.status, missing.body.error.code]).toEqual([name, 428, "precondition_required"]);
      expect([name, stale.status, stale.body.error.code]).toEqual([name, 412, "precondition_failed"]);
    }
    expect(await w.used("openai")).toBe(SECRET);
    expect(w.rows()).toEqual([{ version: 1, status: "active" }]);
  });

  it("a stale client retrying an old CREATE cannot bring back a credential that was since revoked or deleted", async () => {
    const w = build();
    expect((await w.put("openai", SECRET)).status).toBe(201); // the response was lost
    await w.revoke("openai", 1); // an owner revokes it
    const retry = await w.put("openai", SECRET); // the client retries its create
    expect([retry.status, retry.body.error.code]).toEqual([428, "precondition_required"]);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(0);
    await w.del("openai", 1); // same after a delete
    expect((await w.put("openai", SECRET)).status).toBe(428);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status = 'active'")).toBe(0);
    // only a client that has seen the latest version can create again
    expect((await w.put("openai", SECRET, 1)).body.credential.version).toBe(2);
    // and the very first creation of a kind is still free
    expect((await w.put("anthropic", SECRET2)).status).toBe(201);
  });

  it("an old create retried while a DIFFERENT credential is active is refused, not applied over it", async () => {
    const w = build();
    await w.put("openai", SECRET); // v1
    await w.put("openai", SECRET2, 1); // v2: replaced by someone else
    const lateRetryOfV1 = await w.put("openai", SECRET); // no If-Match, a different secret from what is active
    expect(lateRetryOfV1.status).toBe(428);
    expect(await w.used("openai")).toBe(SECRET2);
  });

  it("history is continuous across revoke, delete and re-creation, with exactly one live version at the end", async () => {
    const w = build();
    await w.put("openai", SECRET); // 1
    await w.revoke("openai", 1);
    await w.put("openai", SECRET2, 1); // 2
    await w.put("openai", SECRET3, 2); // 3 replaces 2
    await w.del("openai", 3);
    await w.put("openai", SECRET, 3); // 4
    const rows = w.rows();
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect([rows[0]!.status, rows[2]!.status, rows[3]!.status]).toEqual(["deleted", "deleted", "active"]) // superseded versions are erased;
    expect(rows.filter((r) => r.status === "active")).toHaveLength(1);
  });
});

describe("concurrency cannot get around the version checks", () => {
  it("an 'unchanged' answer is never given for a state that changed while it was being checked", async () => {
    let revokeNow: (() => void) | null = null;
    const keys = managedFake(0, { unwrap: () => revokeNow?.() });
    const w = build({ keys });
    await w.put("openai", SECRET, undefined);
    revokeNow = () => { revokeNow = null; w.db.prepare("UPDATE workspace_credentials SET status = 'revoked', sealed = NULL, wrapped_dek = NULL, key_id = NULL").run(); }; // lands during the comparison
    const retry = await w.put("openai", SECRET); // identical: would normally be 'unchanged'
    expect([retry.status, retry.body.error.code]).toEqual([409, "credential_changed"]);
    expect(retry.text).not.toContain("unchanged");
  });

  it("revoke, delete and replace racing on the same version leave one consistent state and never a 5xx", async () => {
    const w = build({ keys: managedFake(15) });
    await w.put("openai", SECRET);
    const replies = await Promise.all([w.put("openai", SECRET2, 1), w.revoke("openai", 1), w.del("openai", 1), w.revoke("openai", 1), w.put("openai", SECRET3, 1)]);
    for (const r of replies) expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    for (const r of replies) expect([200, 201, 409, 412, 428, 404]).toContain(r.status);
    const live = w.rows().filter((r) => r.status === "active");
    expect(live.length).toBeLessThanOrEqual(1);
    expect(count(w.db, "SELECT COUNT(*) n FROM workspace_credentials WHERE status <> 'active' AND (sealed IS NOT NULL OR wrapped_dek IS NOT NULL OR key_id IS NOT NULL)")).toBe(0);
    expect(new Set(w.rows().map((r) => r.version)).size).toBe(w.rows().length); // no duplicated version number
    for (const lost of [SECRET, SECRET2, SECRET3]) {
      if (live.length === 0 || (await w.used("openai").catch(() => "")) !== lost) {
        // a secret that is not the live one must not be present anywhere
        const dumpText = JSON.stringify(w.db.prepare("SELECT * FROM workspace_credentials").all());
        expect(dumpText).not.toContain(lost);
      }
    }
  });

  it("two stale writers holding the same old version cannot both succeed, even when they overlap in time", async () => {
    const w = build({ keys: managedFake(20) });
    await w.put("openai", SECRET);
    await w.put("openai", SECRET2, 1); // now v2; two slow clients both still believe v1... and v2
    const replies = await Promise.all([w.put("openai", SECRET3, 2), w.put("openai", "FIXTURE-SECRET-FOURTH-0011223344556677", 2), w.put("openai", SECRET, 1)]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409, 412]);
    expect(w.rows().map((r) => r.version)).toEqual([1, 2, 3]);
  });
});

/* ======================================================================================================================
 * C. rate limiter
 * ==================================================================================================================== */

describe("the limiter's memory and lockouts", () => {
  it("a flood of unique keys cannot grow the table without bound", () => {
    let t = 0;
    const l = new RateLimiter(() => t, 100);
    for (let i = 0; i < 20_000; i++) l.hit(`caller|ws|user:${i}`, 5, 60_000);
    expect(l.size).toBeLessThanOrEqual(100);
    for (let i = 0; i < 20_000; i++) l.fail(`fail|ws|user:${i}`, 1, 60_000, 900_000); // every key locked: the worst case for memory
    expect(l.size).toBeLessThanOrEqual(200); // hard cap = twice the soft cap
  });

  it("eviction never erases an active lockout while there is anything else to evict", () => {
    let t = 0;
    const l = new RateLimiter(() => t, 50);
    l.fail("fail|a|alice", 1, 60_000, 600_000);
    l.fail("fail|a|alice", 1, 60_000, 600_000); // locked for 10 minutes
    expect(l.lockedFor("fail|a|alice")).toBe(600_000);
    for (let i = 0; i < 5000; i++) l.hit(`junk|${i}`, 1, 60_000); // a flood of other keys, far past the cap, with time moving on
    expect(l.size).toBeLessThanOrEqual(100);
    t += 120_000; // the junk windows have all ended; the lockout has not
    for (let i = 0; i < 5000; i++) l.hit(`more|${i}`, 1, 60_000);
    expect(l.lockedFor("fail|a|alice")).toBe(480_000);
    t += 481_000; // now it has ended, and the entry may go
    expect(l.lockedFor("fail|a|alice")).toBe(0);
  });

  it("the oldest lockouts go only once locked entries alone exceed the hard cap", () => {
    const l = new RateLimiter(() => 0, 10);
    for (let i = 0; i < 100; i++) { l.fail(`fail|${i}`, 1, 60_000, 600_000); l.fail(`fail|${i}`, 1, 60_000, 600_000); }
    expect(l.size).toBeLessThanOrEqual(20);
    expect(l.lockedFor("fail|99")).toBeGreaterThan(0); // the newest lockouts survive
  });
});

describe("the limiter on the credential routes", () => {
  const clock = () => {
    let t = 50_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("a lockout survives a flood of other keys at the real server, is scoped to its workspace and person, and reports an accurate Retry-After", async () => {
    const c = clock();
    const limiter = new RateLimiter(c.now, 30);
    const w = build({ limits: { failureMax: 2, lockoutSec: 600 }, now: c.now, limiter });
    await send(w.app, "POST", `/api/workspaces/${w.B}/members`, { token: w.bt, body: { userId: w.alice.id, role: "owner" } });
    for (let i = 0; i < 3; i++) await w.put("stripe", SECRET); // alice locks herself out of Alpha
    for (let i = 0; i < 2000; i++) limiter.hit(`junk|${i}`, 1, 60_000); // someone floods the table
    const limited = await w.put("openai", SECRET);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBe(600);
    expect(limiter.lockedFor(`fail|${w.A}|user:${w.alice.id}`)).toBe(600_000);
    expect(limiter.lockedFor(`fail|${w.B}|user:${w.alice.id}`)).toBe(0); // not in Bravo
    expect(limiter.lockedFor(`fail|${w.A}|user:${w.bob.id}`)).toBe(0); // not for another person
    expect((await w.put("openai", SECRET, undefined, w.B)).status).toBe(201); // the same person, another workspace
    c.advance(300_000);
    expect(Number((await w.put("openai", SECRET)).headers["retry-after"])).toBe(300);
    c.advance(301_000);
    expect((await w.put("openai", SECRET)).status).toBe(201);
    expect(limiter.size).toBeLessThanOrEqual(60);
  });

  it("every credential write route shares the limits: the budget is spent across all three and each one is refused when it is gone", async () => {
    const routes = ["put", "revoke", "del"] as const;
    for (const under of routes) {
      const c = clock();
      const w = build({ limits: { callerMax: 3 }, now: c.now });
      const call = (r: (typeof routes)[number]) => (r === "put" ? w.put("openai", SECRET) : r === "revoke" ? w.revoke("openai", 1) : w.del("openai", 1));
      const others = routes.filter((r) => r !== under);
      for (const r of [others[0]!, others[1]!, others[0]!]) await call(r); // three attempts through the other routes use the budget (their own outcome does not matter)
      const refused = await call(under);
      expect([under, refused.status, refused.body.error.code]).toEqual([under, 429, "rate_limited"]);
      expect(refused.headers["retry-after"]).toBeDefined();
      expect(refused.headers["cache-control"]).toBe("no-store");
      c.advance(61_000);
      expect((await call(under)).status).not.toBe(429);
    }
  });

  it("failures through any one route lock the person out of all three", async () => {
    for (const via of ["put", "revoke", "del"] as const) {
      const c = clock();
      const w = build({ limits: { failureMax: 2 }, now: c.now });
      const fail = () => (via === "put" ? w.put("stripe", SECRET) : via === "revoke" ? w.revoke("stripe", 1) : w.del("stripe", 1)); // unknown kind: a 404 each time
      for (let i = 0; i < 3; i++) expect((await fail()).status, via).toBe(404);
      for (const next of [w.put("openai", SECRET), w.revoke("openai", 1), w.del("openai", 1)]) expect((await next).status, via).toBe(429);
    }
  });

  it("the three write routes are all registered with the rate gate (a new route cannot be added without it)", () => {
    const src = readFileSync("src/server/app.ts", "utf8");
    const writes = [...src.matchAll(/ws\.(put|post|delete)\("\/credentials[^"]*",\s*([^,)]+)/g)];
    expect(writes.map((m) => `${m[1]} ${m[2]}`).sort()).toEqual(["delete writeRoute", "post writeRoute", "put writeRoute"]);
    expect(src).toMatch(/const writeRoute = \{ bodyLimit: CREDENTIAL_BODY_LIMIT, onRequest: \[rateGate, requireJson\], onResponse: \[countFailure\] \}/);
  });
});
