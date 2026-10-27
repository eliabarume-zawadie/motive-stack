/**
 * Milestone 4.4.1: identity and onboarding hardening.
 *   1. a legacy workspace token cannot make a person an owner unless the server's claim list names them,
 *   2. only listed identities are provisioned or may create workspaces (closed pilot),
 *   3. cached signing keys have a maximum age, and failed refreshes never make them look newer,
 *   4. token lifetime and the audience / client (azp) relationship are checked by policy.
 * Everything is local: keys are generated in memory, the key-set fetch is a fake, the clock is injected.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { RemoteJwks, StaticJwks } from "../src/auth/jwks.js";
import { OidcVerifier } from "../src/auth/oidc.js";
import { AuthError } from "../src/auth/types.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring } from "../src/credentials/keys.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { mockFetch } from "./helpers.js";
import { AUDIENCE, ISSUER, NOW_MS, NOW_SEC, claims, makeKey, signJwt , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const JWKS_URI = "https://idp.example.test/jwks";
const BASE_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: JWKS_URI , ...OIDC_REQUIRED };

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e.reason;
    throw e;
  }
  return "ACCEPTED";
}
const verifier = (over: Partial<ConstructorParameters<typeof OidcVerifier>[0]> = {}) =>
  new OidcVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, ...over });
const tokenWith = (over: Record<string, unknown>) => signJwt(rsa, claims(over));

/* ====================================================================================================================
 * configuration
 * ================================================================================================================== */

describe("configuration of the onboarding policy and token limits", () => {
  it("is closed by default: no one may register, no one may claim; the client id and token lifetime are stated, not defaulted", () => {
    const cfg = loadAuthConfig(BASE_ENV);
    expect(cfg).toMatchObject({ mode: "oidc", allowedSubjects: [], claimSubjects: [], clientId: "sim-spa-client", accessTokenTypes: ["at+jwt"], maxTokenLifetimeSec: 900, jwksMaxAgeSec: 86_400, requireAzp: false });
    const rt = buildAuthRuntime(cfg, { keys: new StaticJwks([rsa.jwk]) });
    const anyone = { issuer: ISSUER, subject: "idp|anyone", email: "anyone@example.test", displayName: "Anyone" };
    expect([rt.policy.canRegister(anyone), rt.policy.canClaim(anyone)]).toEqual([false, false]);
  });

  it("matches exact subjects of the configured issuer, never email, case or patterns", () => {
    const rt = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: " idp|alice , idp|carol,idp|alice ", OIDC_CLAIM_SUBJECTS: "idp|alice" }), { keys: new StaticJwks([rsa.jwk]) });
    const who = (subject: string, over: Record<string, unknown> = {}) => ({ issuer: ISSUER, subject, email: null, displayName: null, ...over });
    expect([rt.policy.canRegister(who("idp|alice")), rt.policy.canClaim(who("idp|alice"))]).toEqual([true, true]);
    expect([rt.policy.canRegister(who("idp|carol")), rt.policy.canClaim(who("idp|carol"))]).toEqual([true, false]);
    for (const s of ["IDP|ALICE", "idp|alic", "idp|alice ", "idp|bob", "alice", "idp|*"]) expect(rt.policy.canRegister(who(s)), s).toBe(false);
    expect(rt.policy.canRegister(who("idp|bob", { email: "alice@example.test" }))).toBe(false); // an email address is not an identity
    expect(rt.policy.canRegister(who("idp|alice", { issuer: "https://other.example.test/" }))).toBe(false); // same subject, another issuer
    expect(rt.policy.canClaim(who("idp|alice", { issuer: "https://other.example.test/" }))).toBe(false);
  });

  it("refuses wildcards, malformed entries, claim entries that cannot register, and out-of-range limits, naming variables only", () => {
    const bad = (over: Record<string, string>, re: RegExp) => expect(() => loadAuthConfig({ ...BASE_ENV, ...over }), JSON.stringify(over)).toThrow(re);
    bad({ OIDC_ALLOWED_SUBJECTS: "*" }, /OIDC_ALLOWED_SUBJECTS/);
    bad({ OIDC_ALLOWED_SUBJECTS: "idp|a*" }, /OIDC_ALLOWED_SUBJECTS/);
    bad({ OIDC_ALLOWED_SUBJECTS: "idp|a b" }, /OIDC_ALLOWED_SUBJECTS/);
    bad({ OIDC_CLAIM_SUBJECTS: "idp|zed" }, /OIDC_CLAIM_SUBJECTS: every entry must also be in OIDC_ALLOWED_SUBJECTS/);
    bad({ OIDC_ALLOWED_SUBJECTS: "idp|a", OIDC_CLAIM_SUBJECTS: "idp|b" }, /OIDC_CLAIM_SUBJECTS/);
    for (const v of ["0", "59", "abc", "1.5", "-1", "901", "86400", "2592001"]) bad({ OIDC_MAX_TOKEN_LIFETIME_SEC: v }, /OIDC_MAX_TOKEN_LIFETIME_SEC/);
    for (const v of ["0", "599", "x", "604801"]) bad({ OIDC_JWKS_MAX_AGE_SEC: v }, /OIDC_JWKS_MAX_AGE_SEC/);
    bad({ OIDC_REQUIRE_AZP: "yes" }, /OIDC_REQUIRE_AZP/);
    const { OIDC_CLIENT_ID: _client, ...noClient } = BASE_ENV;
    expect(() => loadAuthConfig({ ...noClient, OIDC_REQUIRE_AZP: "true" })).toThrow(/OIDC_CLIENT_ID: required/); // requiring azp is meaningless without a client, and the client is mandatory anyway
    expect(loadAuthConfig({ ...BASE_ENV, OIDC_CLIENT_ID: "c1", OIDC_REQUIRE_AZP: "true", OIDC_MAX_TOKEN_LIFETIME_SEC: "600", OIDC_JWKS_MAX_AGE_SEC: "7200" })).toMatchObject({ requireAzp: true, maxTokenLifetimeSec: 600, jwksMaxAgeSec: 7200 });
    let msg = "";
    try { loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "idp|very-secret-looking-subject x" }); } catch (e) { msg = (e as Error).message; }
    expect(msg).not.toContain("very-secret-looking-subject");
  });
});

/* ====================================================================================================================
 * token lifetime and audience / client policy
 * ================================================================================================================== */

describe("maximum token lifetime", () => {
  it("accepts a token within the limit and refuses one that lives longer, however it is measured", async () => {
    const v = verifier({ maxLifetimeSec: 600 });
    await expect(v.verify(tokenWith({ iat: NOW_SEC - 10, exp: NOW_SEC + 500 }))).resolves.toBeTruthy();
    expect(await reason(v.verify(tokenWith({ iat: NOW_SEC - 10, exp: NOW_SEC + 700 })))).toBe("lifetime_too_long"); // long from its own issue time
    expect(await reason(v.verify(tokenWith({ iat: NOW_SEC - 7200, exp: NOW_SEC + 300 })))).toBe("lifetime_too_long"); // issued long ago, lives on
    expect(await reason(v.verify(tokenWith({ iat: undefined, exp: NOW_SEC + 700 })))).toBe("lifetime_too_long"); // no iat cannot hide a long life
    expect(await reason(v.verify(tokenWith({ iat: NOW_SEC + 30, exp: NOW_SEC + 86_400 * 365 })))).toBe("lifetime_too_long");
    await expect(v.verify(tokenWith({ iat: undefined, exp: NOW_SEC + 500 }))).resolves.toBeTruthy(); // a token without iat is fine when short-lived
    // the leeway is explicit: NONE for the duration inside the token, and only for the remaining life measured against OUR clock
    await expect(v.verify(tokenWith({ iat: NOW_SEC, exp: NOW_SEC + 600 }))).resolves.toBeTruthy();
    expect(await reason(v.verify(tokenWith({ iat: NOW_SEC, exp: NOW_SEC + 601 })))).toBe("lifetime_too_long");
    await expect(v.verify(tokenWith({ iat: undefined, exp: NOW_SEC + 660 }))).resolves.toBeTruthy();
    expect(await reason(v.verify(tokenWith({ iat: undefined, exp: NOW_SEC + 661 })))).toBe("lifetime_too_long");
  });
  it("defaults to, and can never exceed, the 900 s ceiling; the configured runtime enforces its own limit", async () => {
    await expect(verifier().verify(tokenWith({ iat: NOW_SEC - 10, exp: NOW_SEC + 890 }))).resolves.toBeTruthy(); // exactly 900 s long
    expect(await reason(verifier().verify(tokenWith({ iat: NOW_SEC - 10, exp: NOW_SEC + 891 })))).toBe("lifetime_too_long");
    expect(await reason(verifier().verify(tokenWith({ exp: NOW_SEC + 80_000 })))).toBe("lifetime_too_long"); // the old 24 h tokens are gone
    for (const tooBig of [901, 3600, 86_400]) expect(() => verifier({ maxLifetimeSec: tooBig }), String(tooBig)).toThrow(/1 to 900/);
    const rt = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_MAX_TOKEN_LIFETIME_SEC: "300" }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS });
    expect(await reason(rt.verifier!.verify(tokenWith({ exp: NOW_SEC + 700 })))).toBe("lifetime_too_long");
  });
  it("still refuses expired tokens first-class, and rejects a nonsense limit", async () => {
    expect(await reason(verifier().verify(tokenWith({ exp: NOW_SEC - 120 })))).toBe("expired");
    for (const bad of [0, -5, Number.NaN, 901]) expect(() => verifier({ maxLifetimeSec: bad })).toThrow();
  });
});

describe("audience and client (azp) policy", () => {
  it("wrong audiences are refused, alone or in a list", async () => {
    expect(await reason(verifier().verify(tokenWith({ aud: "someone-else" })))).toBe("wrong_audience");
    expect(await reason(verifier({ clientId: "c1" }).verify(tokenWith({ aud: ["a", "b"], azp: "c1" })))).toBe("wrong_audience");
    expect(await reason(verifier().verify(tokenWith({ aud: [] })))).toBe("wrong_audience");
    expect(await reason(verifier().verify(tokenWith({ aud: 7 })))).toBe("wrong_audience");
  });
  it("a token with several audiences must name the configured client", async () => {
    const multi = (azp: unknown) => tokenWith({ aud: ["other-api", AUDIENCE], ...(azp === undefined ? {} : { azp }) });
    const v = verifier({ clientId: "pilot-client" });
    await expect(v.verify(multi("pilot-client"))).resolves.toBeTruthy();
    expect(await reason(v.verify(multi(undefined)))).toBe("wrong_client");
    expect(await reason(v.verify(multi("some-other-client")))).toBe("wrong_client");
    expect(await reason(v.verify(multi(""))) ).toBe("wrong_client");
    expect(await reason(v.verify(multi(["pilot-client"])))).toBe("malformed");
    expect(await reason(verifier().verify(multi("pilot-client")))).toBe("wrong_client"); // no client configured: cannot attribute it, so refuse
    expect(await reason(verifier().verify(multi(undefined)))).toBe("wrong_client");
  });
  it("with a client configured, an azp that is present must match; one that is absent is fine unless requireAzp is set", async () => {
    const v = verifier({ clientId: "pilot-client" });
    await expect(v.verify(tokenWith({}))).resolves.toBeTruthy(); // providers that do not issue azp keep working
    await expect(v.verify(tokenWith({ azp: "pilot-client" }))).resolves.toBeTruthy();
    expect(await reason(v.verify(tokenWith({ azp: "attacker-app" })))).toBe("wrong_client"); // a token minted for another application
    const strict = verifier({ clientId: "pilot-client", requireAzp: true });
    await expect(strict.verify(tokenWith({ azp: "pilot-client" }))).resolves.toBeTruthy();
    expect(await reason(strict.verify(tokenWith({})))).toBe("wrong_client");
    expect(() => verifier({ requireAzp: true })).toThrow(/client id/);
  });
  it("without a client configured, a single-audience token's azp is not interpreted", async () => {
    await expect(verifier().verify(tokenWith({ azp: "whatever" }))).resolves.toBeTruthy();
  });
  it("the configured runtime applies it", async () => {
    const rt = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_CLIENT_ID: "pilot-client", OIDC_REQUIRE_AZP: "true" }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS });
    expect(await reason(rt.verifier!.verify(tokenWith({})))).toBe("wrong_client");
    await expect(rt.verifier!.verify(tokenWith({ azp: "pilot-client" }))).resolves.toBeTruthy();
  });
});

/* ====================================================================================================================
 * signing-key age
 * ================================================================================================================== */

describe("cached signing keys have a maximum age", () => {
  const set = (...keys: Array<{ kid: string }>) => ({ body: { keys } });
  const clock = () => {
    let t = NOW_MS;
    return { now: () => t, advance: (ms: number) => (t += ms), at: () => t };
  };
  const down = () => new Error("provider down");
  // The verifier is given the SAME clock, and tokens are signed relative to it, so only key age is under test.
  const setup = (responses: Array<{ status?: number; body?: unknown } | Error>, o: { ttlMs: number; maxStaleMs: number; cooldownMs: number }) => {
    const f = mockFetch(responses);
    const c = clock();
    const keys = new RemoteJwks({ uri: JWKS_URI, fetch: f.fetchImpl, now: c.now, ...o });
    const v = new OidcVerifier({ issuer: ISSUER, audience: AUDIENCE, keys, now: c.now });
    const token = () => signJwt(rsa, claims({ iat: Math.floor(c.at() / 1000) - 10, exp: Math.floor(c.at() / 1000) + 600 }));
    return { f, c, v, token };
  };

  it("keeps working inside the stale window during an outage, and fails closed once the keys are older than the maximum age", async () => {
    const { f, c, v, token } = setup([set(rsa.jwk as never), down(), down(), down(), down()], { ttlMs: 1_000, maxStaleMs: 10_000, cooldownMs: 500 });
    await expect(v.verify(token())).resolves.toBeTruthy(); // fetched at t0
    c.advance(2_000); // stale; the refresh fails; the key is 2 s old, inside the 10 s window
    await expect(v.verify(token())).resolves.toBeTruthy();
    c.advance(7_000); // 9 s old: still inside
    await expect(v.verify(token())).resolves.toBeTruthy();
    c.advance(2_000); // 11 s old: past the window; the refresh fails again
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(f.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("a failed refresh does not extend the age of the last successful fetch", async () => {
    // Failed attempts every 4 s would, if they reset the age, keep the first key set alive indefinitely.
    const { c, v, token } = setup([set(rsa.jwk as never), ...Array.from({ length: 10 }, down)], { ttlMs: 1_000, maxStaleMs: 10_000, cooldownMs: 500 });
    await v.verify(token()); // success at t0
    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      c.advance(4_000); // t = 4, 8, 12, 16 s; every call attempts a refresh that fails
      results.push(await reason(v.verify(token())));
    }
    expect(results).toEqual(["ACCEPTED", "ACCEPTED", "keys_unavailable", "keys_unavailable"]); // cut off at 12 s: 10 s after t0, not after the last failure
  });

  it("an unknown key id or a recent failed attempt cannot revive keys that are too old", async () => {
    const { c, v, token } = setup([set(rsa.jwk as never), down(), down()], { ttlMs: 1_000, maxStaleMs: 2_000, cooldownMs: 60_000 });
    await v.verify(token());
    c.advance(3_000); // older than the window, and the cooldown (60 s) forbids another attempt right now
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(await reason(v.verify(signJwt(rsa, claims(), { kid: "unknown" })))).toBe("keys_unavailable");
  });

  it("recovers as soon as the provider answers, and the new fetch restarts the age", async () => {
    const { c, v, token } = setup([set(rsa.jwk as never), down(), set(rsa.jwk as never), down(), down()], { ttlMs: 1_000, maxStaleMs: 5_000, cooldownMs: 500 });
    await v.verify(token());
    c.advance(6_000);
    expect(await reason(v.verify(token()))).toBe("keys_unavailable"); // too old and the provider is down
    c.advance(1_000);
    await expect(v.verify(token())).resolves.toBeTruthy(); // the provider is back
    c.advance(2_000); // 2 s since the new success: stale, refresh fails, but inside the window again
    await expect(v.verify(token())).resolves.toBeTruthy();
    c.advance(4_000); // 6 s since the new success
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
  });

  it("a provider that never answered keeps failing closed, and a maximum age below the cache lifetime is a configuration error", async () => {
    const { v, token } = setup([down(), down()], { ttlMs: 1_000, maxStaleMs: 5_000, cooldownMs: 500 });
    expect(await reason(v.verify(token()))).toBe("keys_unavailable");
    expect(() => new RemoteJwks({ uri: JWKS_URI, ttlMs: 10_000, maxStaleMs: 1_000 })).toThrow(/maximum key age/);
  });

  it("the configured maximum age (OIDC_JWKS_MAX_AGE_SEC) reaches the key client", async () => {
    const f = mockFetch([set(rsa.jwk as never), down(), down(), down()]);
    const c = clock();
    const rt = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_JWKS_MAX_AGE_SEC: "700" }), { fetch: f.fetchImpl, now: c.now }); // default cache lifetime is 600 s
    const token = () => signJwt(rsa, claims({ iat: Math.floor(c.at() / 1000) - 10, exp: Math.floor(c.at() / 1000) + 600 }));
    await rt.verifier!.verify(token());
    c.advance(650_000); // stale (> 600 s), refresh fails, 650 s old: inside the 700 s maximum
    await expect(rt.verifier!.verify(token())).resolves.toBeTruthy();
    c.advance(100_000); // 750 s old
    expect(await reason(rt.verifier!.verify(token()))).toBe("keys_unavailable");
  });
});

/* ====================================================================================================================
 * onboarding: who may register, create workspaces and claim
 * ================================================================================================================== */

describe("closed onboarding at the HTTP boundary", () => {
  const open: Array<() => void> = [];
  afterEach(() => {
    while (open.length) open.pop()?.();
  });
  const jwtFor = (name: string, extra: Record<string, unknown> = {}) => signJwt(rsa, claims({ sub: `idp|${name}`, name, ...extra }));

  function boot(env: Record<string, string> = { OIDC_ALLOWED_SUBJECTS: "idp|alice,idp|carol,idp|dave", OIDC_CLAIM_SUBJECTS: "idp|alice" }) {
    const db = openDb(":memory:");
    migrate(db);
    const ctx: AppContext = buildContext({ db, env: {}, keyProvider: new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") });
    const runtime = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, ...env }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS });
    const app = buildServer(ctx, runtime);
    open.push(() => db.open && db.close());
    const users = () => (db.prepare("SELECT COUNT(*) n FROM users").get() as { n: number }).n;
    const workspaces = () => (db.prepare("SELECT COUNT(*) n FROM workspaces").get() as { n: number }).n;
    const memberships = () => (db.prepare("SELECT COUNT(*) n FROM workspace_memberships").get() as { n: number }).n;
    return { db, ctx, app, runtime, users, workspaces, memberships };
  }
  type World = ReturnType<typeof boot>;
  async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
    const res = await app.inject({ method, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, payload: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Record<string, any>, text: res.body };
  }
  const legacy = (w: World) => {
    const { workspace, token } = createWorkspace(w.ctx, "Legacy Co");
    return { id: workspace.id, token };
  };

  it("an identity that is not listed is refused everywhere at person level, and nothing is written", async () => {
    const w = boot();
    const before = [w.users(), w.workspaces(), w.memberships()];
    const mallory = jwtFor("mallory", { email: "alice@example.test", email_verified: true }); // even with a listed person's verified email
    for (const [m, u, body] of [["GET", "/api/me"], ["GET", "/api/me/workspaces"], ["POST", "/api/workspaces", { name: "Mallory Co" }], ["POST", "/api/workspaces/claim", { workspaceId: "ws_x", token: "msw_x" }]] as const) {
      const r = await call(w.app, m, u, mallory, body);
      expect([m, u, r.status, r.body.error?.code]).toEqual([m, u, 403, "not_authorized"]);
      expect(r.text).not.toMatch(/alice|listed|allow|OIDC|subject/i);
    }
    expect([w.users(), w.workspaces(), w.memberships()]).toEqual(before);
  });

  it("a listed identity is provisioned and may create a workspace, becoming its owner", async () => {
    const w = boot();
    expect((await call(w.app, "GET", "/api/me", jwtFor("carol"))).status).toBe(200);
    const made = await call(w.app, "POST", "/api/workspaces", jwtFor("carol"), { name: "Carol Co" });
    expect(made.status).toBe(201);
    expect((await call(w.app, "GET", `/api/workspaces/${made.body.workspace.id}`, jwtFor("carol"))).status).toBe(200);
    expect(w.users()).toBe(1);
  });

  it("an unconfigured deployment is closed: with empty lists even a valid token creates nothing", async () => {
    const w = boot({});
    for (const name of ["alice", "carol"]) {
      expect((await call(w.app, "GET", "/api/me", jwtFor(name))).status).toBe(403);
      expect((await call(w.app, "POST", "/api/workspaces", jwtFor(name), { name: "X Co" })).status).toBe(403);
    }
    expect([w.users(), w.workspaces()]).toEqual([0, 0]);
  });

  it("holding a legacy token is not enough: a registered person who is not on the claim list cannot become an owner", async () => {
    const w = boot();
    const ws = legacy(w);
    await call(w.app, "GET", "/api/me", jwtFor("carol"));
    const right = await call(w.app, "POST", "/api/workspaces/claim", jwtFor("carol"), { workspaceId: ws.id, token: ws.token });
    const wrong = await call(w.app, "POST", "/api/workspaces/claim", jwtFor("carol"), { workspaceId: ws.id, token: "msw_wrong" });
    const unknown = await call(w.app, "POST", "/api/workspaces/claim", jwtFor("carol"), { workspaceId: "ws_nope", token: ws.token });
    for (const r of [right, wrong, unknown]) expect([r.status, r.body.error.code]).toEqual([403, "claim_not_permitted"]);
    expect(right.text).toBe(wrong.text); // the answer does not depend on whether the token is right
    expect(right.text).toBe(unknown.text);
    expect(w.memberships()).toBe(0);
    // and the legacy token itself still cannot touch credentials, even with the workspace unclaimed
    for (const [m, u, body] of [["GET", `/api/workspaces/${ws.id}/credentials`], ["PUT", `/api/workspaces/${ws.id}/credentials/openai`, { secret: "x".repeat(24) }]] as const) {
      expect((await call(w.app, m, u, ws.token, body)).status, `${m} ${u}`).toBe(403);
    }
    // carol is still nobody in that workspace
    expect((await call(w.app, "GET", `/api/workspaces/${ws.id}`, jwtFor("carol"))).status).toBe(404);
  });

  it("the explicitly listed identity can still claim, once, and then manage credentials as owner (the intended migration path)", async () => {
    const w = boot();
    const ws = legacy(w);
    expect((await call(w.app, "POST", "/api/workspaces/claim", jwtFor("alice"), { workspaceId: ws.id, token: "msw_wrong" })).status).toBe(404); // wrong token: same as before
    const claimed = await call(w.app, "POST", "/api/workspaces/claim", jwtFor("alice"), { workspaceId: ws.id, token: ws.token });
    expect([claimed.status, claimed.body.role]).toEqual([200, "owner"]);
    const stored = await call(w.app, "PUT", `/api/workspaces/${ws.id}/credentials/openai`, jwtFor("alice"), { secret: "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60" });
    expect(stored.status).toBe(201);
    // a second listed claimer is refused: the workspace has an owner
    await call(w.app, "GET", "/api/me", jwtFor("dave"));
    expect((await call(w.app, "POST", "/api/workspaces/claim", jwtFor("dave"), { workspaceId: ws.id, token: ws.token })).status).toBe(403); // dave is not on the claim list
  });

  it("a claim-listed person is still stopped by an existing owner, and a disabled token cannot be claimed", async () => {
    const w = boot({ OIDC_ALLOWED_SUBJECTS: "idp|alice,idp|dave", OIDC_CLAIM_SUBJECTS: "idp|alice,idp|dave" });
    const ws = legacy(w);
    expect((await call(w.app, "POST", "/api/workspaces/claim", jwtFor("alice"), { workspaceId: ws.id, token: ws.token })).status).toBe(200);
    const second = await call(w.app, "POST", "/api/workspaces/claim", jwtFor("dave"), { workspaceId: ws.id, token: ws.token });
    expect([second.status, second.body.error.code]).toEqual([409, "already_claimed"]);
    expect(w.memberships()).toBe(1);
  });

  it("someone who already has a user row keeps their memberships if later removed from the list, but cannot create workspaces or be updated", async () => {
    const w = boot();
    await call(w.app, "GET", "/api/me", jwtFor("alice", { name: "Alice Original" }));
    const made = await call(w.app, "POST", "/api/workspaces", jwtFor("alice"), { name: "Alice Co" });
    const reduced = buildServer(w.ctx, buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "idp|dave" }), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS }));
    const nameBefore = () => (w.db.prepare("SELECT display_name FROM users").get() as { display_name: string }).display_name;
    const kept = nameBefore();
    const renamed = jwtFor("alice", { name: "Alice Renamed" });
    expect((await call(reduced, "GET", `/api/workspaces/${made.body.workspace.id}`, renamed)).status).toBe(200); // the membership stands
    expect((await call(reduced, "GET", "/api/me", renamed)).status).toBe(200);
    expect((await call(reduced, "POST", "/api/workspaces", renamed, { name: "Second Co" })).status).toBe(403);
    expect(nameBefore()).toBe(kept); // not updated once the person is no longer listed
    expect(w.workspaces()).toBe(1);
  });

  it("an unlisted person cannot be added to a workspace: they never get a user row to add", async () => {
    const w = boot();
    const made = await call(w.app, "POST", "/api/workspaces", jwtFor("carol"), { name: "Carol Co" });
    await call(w.app, "GET", "/api/me", jwtFor("mallory"));
    const mallory = w.db.prepare("SELECT id FROM users WHERE subject = 'idp|mallory'").get();
    expect(mallory).toBeUndefined();
    const r = await call(w.app, "POST", `/api/workspaces/${made.body.workspace.id}/members`, jwtFor("carol"), { userId: "usr_mallory", role: "viewer" });
    expect(r.status).toBe(404);
  });

  it("workspace isolation, roles and the credential vault are unchanged for allowed people", async () => {
    const w = boot();
    const alice = await call(w.app, "POST", "/api/workspaces", jwtFor("alice"), { name: "Alpha" });
    const carol = await call(w.app, "POST", "/api/workspaces", jwtFor("carol"), { name: "Carol" });
    expect((await call(w.app, "GET", `/api/workspaces/${carol.body.workspace.id}/credentials`, jwtFor("alice"))).status).toBe(404); // another workspace
    expect((await call(w.app, "GET", `/api/workspaces/${alice.body.workspace.id}/credentials`, jwtFor("alice"))).body.available).toBe(true);
    expect((await call(w.app, "PUT", `/api/workspaces/${alice.body.workspace.id}/credentials/openai`, jwtFor("alice"), { secret: "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60" })).status).toBe(201);
  });
});
