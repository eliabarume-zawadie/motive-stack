/**
 * Identity-provider compatibility CONTRACT (docs/idp-compatibility.md), executable offline.
 *
 * What this proves: how THIS server's token verification, key handling and authorization behave for a range of token and key-set shapes.
 * What it does NOT prove: that any real provider produces those shapes. The shapes in test/support/simulatedIdp.ts are invented and
 * labeled SIMULATED. Real-provider compatibility is verified only by the staging plan in the document. Nothing here touches a network.
 *
 * Every test title starts with its clause id (C1..C17); a final test keeps the document and this file in step.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { addMember, createWorkspaceForUser } from "../src/app/memberships.js";
import { upsertUser } from "../src/app/users.js";
import { userActor } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig, type OidcAuthConfig } from "../src/auth/config.js";
import { RemoteJwks, StaticJwks } from "../src/auth/jwks.js";
import { OidcVerifier } from "../src/auth/oidc.js";
import { AuthError } from "../src/auth/types.js";
import { KEY_BYTES } from "../src/credentials/crypto.js";
import { LocalKeyring } from "../src/credentials/keys.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { mockFetch } from "./helpers.js";
import { SIM_AUDIENCE, SIM_CLIENT, SIM_OTHER_RESOURCE, SIM_PROFILES } from "./support/simulatedIdp.js";
import { ISSUER, NOW_MS, NOW_SEC, OPEN_POLICY, b64u, claims, makeKey, signJwt , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const ec = makeKey("ES256", "ec-1");
const JWKS_URI = "https://idp.example.test/jwks";
const BASE_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: SIM_AUDIENCE, OIDC_JWKS_URI: JWKS_URI , ...OIDC_REQUIRED };

const oidcConfig = (env: Record<string, string>): OidcAuthConfig => loadAuthConfig(env) as OidcAuthConfig;
const verifier = (over: Partial<ConstructorParameters<typeof OidcVerifier>[0]> = {}) =>
  new OidcVerifier({ issuer: ISSUER, audience: SIM_AUDIENCE, keys: new StaticJwks([rsa.jwk, ec.jwk]), now: () => NOW_MS, ...over });
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e.reason;
    throw e;
  }
  return "ACCEPTED";
}
const tokenWith = (over: Record<string, unknown>, key = rsa, header: Record<string, unknown> = {}) => signJwt(key, claims({ aud: SIM_AUDIENCE, ...over }), header);

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length) open.pop()?.();
});
function server(o: { policy?: "open" | "real"; env?: Record<string, string>; fetch?: typeof fetch; now?: () => number; keys?: StaticJwks } = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, keyProvider: new LocalKeyring({ k1: randomBytes(KEY_BYTES) }, "k1") });
  const runtime = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, ...(o.env ?? {}) }), {
    ...(o.keys || !o.fetch ? { keys: o.keys ?? new StaticJwks([rsa.jwk]) } : {}),
    fetch: o.fetch,
    now: o.now ?? (() => NOW_MS),
    ...(o.policy === "real" ? {} : { policy: OPEN_POLICY }),
  });
  const app = buildServer(ctx, runtime);
  open.push(() => db.open && db.close());
  const get = async (url: string, token?: string) => {
    const r = await app.inject({ method: "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {} });
    let body: any = null;
    try { body = r.body ? JSON.parse(r.body) : null; } catch { /* not JSON */ }
    return { status: r.statusCode, headers: r.headers, text: r.body, body };
  };
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return { db, ctx, app, get, count };
}
const jwtFor = (sub: string, extra: Record<string, unknown> = {}) => signJwt(rsa, claims({ aud: SIM_AUDIENCE, sub, ...extra }));

/* ====================================================================================================================
 * C1  Authorization Code with PKCE (S256)
 * ================================================================================================================== */

describe("C1: PKCE with S256 is a browser-client duty; the API is a resource server", () => {
  /** Reference implementation of the S256 transform, pinned against the RFC 7636 appendix B vector, for the future browser client to match. */
  const s256 = (verifierText: string) => createHash("sha256").update(verifierText, "ascii").digest("base64url");

  it("C1: the reference S256 transform matches the RFC 7636 test vector, and the challenge has the required shape", () => {
    expect(s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const v = randomBytes(32).toString("base64url"); // 43 characters: the minimum verifier length
    expect(v).toHaveLength(43);
    expect(s256(v)).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url, no padding, never "plain"
  });

  it("C1: the server holds no PKCE, code-exchange or token-endpoint logic: it only verifies bearer tokens (the flow is a staging item)", () => {
    for (const f of ["src/auth/oidc.ts", "src/auth/jwks.ts", "src/auth/config.ts", "src/server/auth.ts", "src/server/app.ts", "public/app.js"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/code_challenge|code_verifier|authorization_endpoint|token_endpoint|redirect_uri|response_type/);
    }
  });
});

/* ====================================================================================================================
 * C2  issuer, C3  audience
 * ================================================================================================================== */

describe("C2: the issuer must equal the configured string exactly", () => {
  it("C2: scheme, case, port, trailing slash and whitespace all matter, in both directions", async () => {
    const v = verifier();
    await expect(v.verify(tokenWith({}))).resolves.toBeTruthy();
    for (const iss of ["https://idp.example.test", "https://IDP.example.test/", "http://idp.example.test/", "https://idp.example.test:443/", "https://idp.example.test/ ", " https://idp.example.test/", "https://idp.example.test/x", ["https://idp.example.test/"], 7, null]) {
      expect(await outcome(v.verify(tokenWith({ iss }))), JSON.stringify(iss)).toBe("wrong_issuer");
    }
    const t = signJwt(rsa, (() => { const p = claims({ aud: SIM_AUDIENCE }); delete p.iss; return p; })());
    expect(await outcome(v.verify(t))).toBe("wrong_issuer");
    // a deployment configured WITHOUT the slash rejects tokens that carry it
    const bare = verifier({ issuer: "https://idp.example.test" });
    expect(await outcome(bare.verify(tokenWith({ iss: "https://idp.example.test/" })))).toBe("wrong_issuer");
    await expect(bare.verify(tokenWith({ iss: "https://idp.example.test" }))).resolves.toBeTruthy();
  });
});

describe("C3: the audience is a string or an array of strings and must include the configured one exactly", () => {
  it("C3: exact matching, and malformed audiences are refused", async () => {
    const v = verifier({ clientId: SIM_CLIENT });
    await expect(v.verify(tokenWith({ aud: SIM_AUDIENCE }))).resolves.toBeTruthy();
    await expect(v.verify(tokenWith({ aud: [SIM_AUDIENCE] }))).resolves.toBeTruthy();
    await expect(v.verify(tokenWith({ aud: [SIM_AUDIENCE, SIM_OTHER_RESOURCE], azp: SIM_CLIENT }))).resolves.toBeTruthy();
    for (const aud of ["other", `${SIM_AUDIENCE} `, SIM_AUDIENCE.toUpperCase(), `${SIM_AUDIENCE}/`, "", [], [SIM_OTHER_RESOURCE], { 0: SIM_AUDIENCE }, 7, null, true]) {
      expect(await outcome(v.verify(tokenWith({ aud }))), JSON.stringify(aud)).toBe("wrong_audience");
    }
    // an array that mixes in non-strings is ambiguous (it would otherwise hide a second audience from the multi-audience rule)
    for (const aud of [[SIM_AUDIENCE, 7], [SIM_AUDIENCE, null], [SIM_AUDIENCE, { a: 1 }], [7]]) {
      expect(await outcome(v.verify(tokenWith({ aud }))), JSON.stringify(aud)).toBe("malformed");
    }
    const noAud = claims({}); delete noAud.aud;
    expect(await outcome(v.verify(signJwt(rsa, noAud)))).toBe("wrong_audience");
  });
});

/* ====================================================================================================================
 * C4  client id and azp, over the SIMULATED profiles
 * ================================================================================================================== */

describe("C4: client id and azp behave as documented for each SIMULATED token shape", () => {
  type Cfg = { label: string; over: Partial<ConstructorParameters<typeof OidcVerifier>[0]> };
  const none: Cfg = { label: "no client id", over: {} };
  const right: Cfg = { label: "client id matches", over: { clientId: SIM_CLIENT } };
  const other: Cfg = { label: "a different client id", over: { clientId: "sim-another-client" } };
  const strict: Cfg = { label: "client id + require azp", over: { clientId: SIM_CLIENT, requireAzp: true } };
  const table: Array<[string, Cfg, string]> = [
    ["minimal", none, "ACCEPTED"], ["minimal", right, "ACCEPTED"], ["minimal", other, "ACCEPTED"], ["minimal", strict, "wrong_client"],
    ["azp-single", none, "ACCEPTED"], ["azp-single", right, "ACCEPTED"], ["azp-single", other, "wrong_client"], ["azp-single", strict, "ACCEPTED"],
    ["multi-audience", none, "wrong_client"], ["multi-audience", right, "ACCEPTED"], ["multi-audience", other, "wrong_client"], ["multi-audience", strict, "ACCEPTED"],
    ["no-iat", none, "ACCEPTED"], ["with-nbf", right, "ACCEPTED"], ["verified-email", none, "ACCEPTED"], ["string-booleans", none, "ACCEPTED"], ["authorization-looking-claims", right, "ACCEPTED"],
  ];
  for (const [profile, cfg, expected] of table) {
    it(`C4: SIMULATED profile "${profile}" with ${cfg.label} -> ${expected}`, async () => {
      const p = SIM_PROFILES.find((x) => x.id === profile)!;
      expect(await outcome(verifier(cfg.over).verify(signJwt(rsa, p.payload("sim|subject"))))).toBe(expected);
    });
  }
  it("C4: the audience and the client id are different things: a token for another audience is refused even from the right client", async () => {
    expect(await outcome(verifier({ clientId: SIM_CLIENT }).verify(tokenWith({ aud: SIM_CLIENT, azp: SIM_CLIENT })))).toBe("wrong_audience");
  });
});

/* ====================================================================================================================
 * C5  subject, C6  time
 * ================================================================================================================== */

describe("C5: the subject is an opaque string, compared and stored exactly", () => {
  it("C5: any string up to 255 characters is accepted unchanged; empty, longer or non-string subjects are refused", async () => {
    const v = verifier();
    for (const sub of ["sim|123", "0b1c2d3e-0000-4000-8000-000000000001", "someone@example.test", "ユーザー|1", " padded ", "x".repeat(255), "a b\tc"]) {
      const id = await v.verify(tokenWith({ sub }));
      expect(id.subject, JSON.stringify(sub)).toBe(sub);
      expect(id.issuer).toBe(ISSUER);
    }
    for (const sub of ["", "x".repeat(256), 123, null, {}, [], true]) expect(await outcome(v.verify(tokenWith({ sub }))), JSON.stringify(sub)?.slice(0, 20)).toBe("missing_claim");
    const noSub = claims({ aud: SIM_AUDIENCE }); delete noSub.sub;
    expect(await outcome(v.verify(signJwt(rsa, noSub)))).toBe("missing_claim");
  });
});

describe("C6: exp, nbf, iat and the maximum lifetime", () => {
  it("C6: claims must be numbers (not numeric strings); fractions are fine; every boundary is exact", async () => {
    const v = verifier({ leewaySec: 60 });
    const short = verifier({ maxLifetimeSec: 600, leewaySec: 60 });
    expect(await outcome(v.verify(tokenWith({ exp: String(NOW_SEC + 600) })))).toBe("missing_claim");
    expect(await outcome(v.verify(tokenWith({ nbf: String(NOW_SEC - 5) })))).toBe("malformed");
    expect(await outcome(v.verify(tokenWith({ iat: String(NOW_SEC - 5) })))).toBe("malformed");
    expect(await outcome(v.verify(tokenWith({ exp: null })))).toBe("missing_claim");
    await expect(v.verify(tokenWith({ exp: NOW_SEC + 500.5, iat: NOW_SEC - 5.25 }))).resolves.toBeTruthy();
    await expect(v.verify(tokenWith({ exp: NOW_SEC - 59 }))).resolves.toBeTruthy(); // inside the leeway
    expect(await outcome(v.verify(tokenWith({ exp: NOW_SEC - 60 })))).toBe("expired");
    await expect(v.verify(tokenWith({ nbf: NOW_SEC + 59 }))).resolves.toBeTruthy();
    expect(await outcome(v.verify(tokenWith({ nbf: NOW_SEC + 61 })))).toBe("not_yet_valid");
    await expect(v.verify(tokenWith({ iat: NOW_SEC + 59 }))).resolves.toBeTruthy();
    expect(await outcome(v.verify(tokenWith({ iat: NOW_SEC + 61 })))).toBe("not_yet_valid");
    // the duration inside the token gets NO leeway; the remaining life against our clock gets the leeway
    await expect(short.verify(tokenWith({ exp: NOW_SEC + 600, iat: NOW_SEC }))).resolves.toBeTruthy();
    expect(await outcome(short.verify(tokenWith({ exp: NOW_SEC + 601, iat: NOW_SEC })))).toBe("lifetime_too_long");
    await expect(short.verify(tokenWith({ exp: NOW_SEC + 660, iat: undefined }))).resolves.toBeTruthy();
    expect(await outcome(short.verify(tokenWith({ exp: NOW_SEC + 661, iat: undefined })))).toBe("lifetime_too_long");
    expect(await outcome(v.verify(tokenWith({ exp: 1e15 })))).toBe("lifetime_too_long");
  });
  it("C6: a provider that omits iat or nbf is fine as long as the remaining life is within the limit", async () => {
    for (const id of ["no-iat", "with-nbf", "minimal"]) {
      const p = SIM_PROFILES.find((x) => x.id === id)!;
      await expect(verifier().verify(signJwt(rsa, p.payload("sim|s")))).resolves.toBeTruthy();
    }
  });
});

/* ====================================================================================================================
 * C7  algorithms and key shapes
 * ================================================================================================================== */

describe("C7: only RS256 and ES256 with suitable keys", () => {
  it("C7: other algorithms are refused before any key is looked up", async () => {
    for (const alg of ["HS256", "HS384", "none", "None", "PS256", "RS384", "RS512", "ES384", "ES512", "EdDSA", "", 5, null]) {
      expect(await outcome(verifier().verify(tokenWith({}, rsa, { alg }))), String(alg)).toBe("unsupported_algorithm");
    }
    await expect(verifier().verify(tokenWith({}, rsa))).resolves.toBeTruthy();
    await expect(verifier().verify(tokenWith({}, ec))).resolves.toBeTruthy();
  });

  it("C7: a key set entry may omit use and alg and may carry extra standard fields, and still verifies", async () => {
    const bare = { ...rsa.jwk } as Record<string, unknown>; delete bare.use; delete bare.alg;
    const extras = { ...rsa.jwk, x5c: ["MIIBsimulated"], x5t: "simulated", "x5t#S256": "simulated", key_ops: ["verify"], ext: true } as never;
    for (const jwk of [bare, extras]) await expect(verifier({ keys: new StaticJwks([jwk as never]) }).verify(tokenWith({}))).resolves.toBeTruthy();
    const ecBare = { ...ec.jwk } as Record<string, unknown>; delete ecBare.use; delete ecBare.alg;
    await expect(verifier({ keys: new StaticJwks([ecBare as never]) }).verify(tokenWith({}, ec))).resolves.toBeTruthy();
  });

  it("C7: a key that is not for verifying, is private, too small, or the wrong type is refused", async () => {
    const bad = (extra: Record<string, unknown>) => verifier({ keys: new StaticJwks([{ ...rsa.jwk, ...extra } as never]) });
    expect(await outcome(bad({ key_ops: ["encrypt"] }).verify(tokenWith({})))).toBe("unknown_key"); // declared for another operation
    expect(await outcome(bad({ key_ops: ["sign"] }).verify(tokenWith({})))).toBe("unknown_key");
    expect(await outcome(bad({ key_ops: "verify" }).verify(tokenWith({})))).toBe("unknown_key"); // malformed member
    expect(await outcome(bad({ use: "enc" }).verify(tokenWith({})))).toBe("unknown_key");
    expect(await outcome(bad({ alg: "RS384" }).verify(tokenWith({})))).toBe("unknown_key");
    expect(await outcome(bad({ d: "AQAB" }).verify(tokenWith({})))).toBe("unknown_key");
    expect(await outcome(bad({ kty: "oct" }).verify(tokenWith({})))).toBe("unknown_key");
    const weak = makeKey("RS256", "weak", 1024);
    expect(await outcome(verifier({ keys: new StaticJwks([weak.jwk]) }).verify(signJwt(weak, claims({ aud: SIM_AUDIENCE }))))).toBe("unknown_key");
    const p384 = makeKey("ES256", "p384"); // sanity: a P-256 key presented for RS256 is refused
    expect(await outcome(verifier({ keys: new StaticJwks([{ ...p384.jwk, kid: "rsa-1" } as never]) }).verify(tokenWith({})))).toBe("unknown_key");
  });
});

/* ====================================================================================================================
 * C8 / C9 / C10  key sets: rotation, unknown ids, outages, recovery
 * ================================================================================================================== */

const clock = () => {
  let t = NOW_MS;
  return { now: () => t, advance: (ms: number) => (t += ms), at: () => t };
};
const keySet = (...keys: Array<{ kid: string }>) => ({ body: { keys } });
function rig(responses: Array<{ status?: number; body?: unknown } | Error>, o: { ttlMs?: number; maxStaleMs?: number; cooldownMs?: number } = {}) {
  const f = mockFetch(responses);
  const c = clock();
  const keys = new RemoteJwks({ uri: JWKS_URI, fetch: f.fetchImpl, now: c.now, ttlMs: 1_000, maxStaleMs: 10_000, cooldownMs: 500, ...o });
  const v = new OidcVerifier({ issuer: ISSUER, audience: SIM_AUDIENCE, keys, now: c.now });
  const tok = (key = rsa, kid?: string) => signJwt(key, claims({ aud: SIM_AUDIENCE, iat: Math.floor(c.at() / 1000) - 5, exp: Math.floor(c.at() / 1000) + 600 }), kid ? { kid } : {});
  return { f, c, v, tok };
}

describe("C8: key rotation", () => {
  const k2 = makeKey("RS256", "rsa-2");
  it("C8: a new key id is picked up (bounded by the cooldown), and during an overlap both keys verify", async () => {
    const { f, c, v, tok } = rig([keySet(rsa.jwk as never), keySet(rsa.jwk as never, k2.jwk as never)], { cooldownMs: 60_000 });
    await expect(v.verify(tok())).resolves.toBeTruthy();
    expect(await outcome(v.verify(tok(k2)))).toBe("unknown_key"); // too soon after the last fetch: no new request
    expect(f.calls).toHaveLength(1);
    c.advance(61_000);
    await expect(v.verify(tok(k2))).resolves.toBeTruthy();
    await expect(v.verify(tok(rsa))).resolves.toBeTruthy(); // overlap
    expect(f.calls).toHaveLength(2);
  });

  it("C8: a removed key stops verifying once the cache refreshes (until then it is still trusted for at most the cache lifetime)", async () => {
    const { f, c, v, tok } = rig([keySet(rsa.jwk as never, k2.jwk as never), keySet(k2.jwk as never)]);
    await v.verify(tok(rsa));
    c.advance(500); // the provider has removed rsa-1, but the cache is still fresh
    await expect(v.verify(tok(rsa))).resolves.toBeTruthy();
    c.advance(1_500); // past the cache lifetime: refreshed
    expect(await outcome(v.verify(tok(rsa)))).toBe("unknown_key");
    await expect(v.verify(tok(k2))).resolves.toBeTruthy();
    expect(f.calls).toHaveLength(2);
  });

  it("C8: a key id reused with NEW key material: tokens signed by the old material fail once refreshed, new ones verify", async () => {
    const reissued = makeKey("RS256", "rsa-1"); // same kid, different key pair
    const { c, v, tok } = rig([keySet(rsa.jwk as never), keySet(reissued.jwk as never)]);
    await v.verify(tok(rsa));
    c.advance(2_000);
    expect(await outcome(v.verify(tok(rsa)))).toBe("bad_signature");
    await expect(v.verify(tok(reissued))).resolves.toBeTruthy();
  });

  it("C8: two different keys under one id in the same set are ambiguous: that id is unusable, other keys are unaffected; identical repeats are harmless", async () => {
    const impostor = makeKey("RS256", "rsa-1");
    const conflicting = rig([keySet(rsa.jwk as never, impostor.jwk as never, ec.jwk as never)]);
    expect(await outcome(conflicting.v.verify(conflicting.tok(rsa)))).toBe("unknown_key");
    expect(await outcome(conflicting.v.verify(conflicting.tok(impostor)))).toBe("unknown_key");
    await expect(conflicting.v.verify(conflicting.tok(ec))).resolves.toBeTruthy();
    const repeated = rig([keySet(rsa.jwk as never, rsa.jwk as never)]);
    await expect(repeated.v.verify(repeated.tok(rsa))).resolves.toBeTruthy();
    const onlyConflict = rig([keySet(rsa.jwk as never, impostor.jwk as never)]);
    expect(await outcome(onlyConflict.v.verify(onlyConflict.tok(rsa)))).toBe("keys_unavailable"); // nothing usable at all: a failed fetch
  });
});

describe("C9: an unknown key id", () => {
  it("C9: is a plain refusal (not an outage), cannot cause fetches faster than the cooldown, and absurd ids are malformed", async () => {
    const { f, v, tok } = rig([keySet(rsa.jwk as never)], { cooldownMs: 60_000 });
    await v.verify(tok());
    for (let i = 0; i < 25; i++) expect(await outcome(v.verify(tok(rsa, `unknown-${i}`)))).toBe("unknown_key");
    expect(f.calls).toHaveLength(1);
    expect(await outcome(v.verify(tok(rsa, "k".repeat(257))))).toBe("malformed");
    const noKid = signJwt(rsa, claims({ aud: SIM_AUDIENCE }), { kid: undefined });
    expect(await outcome(v.verify(noKid))).toBe("malformed");
    for (const kid of [7, null, "", {}]) expect(await outcome(v.verify(signJwt(rsa, claims({ aud: SIM_AUDIENCE }), { kid } as never))), JSON.stringify(kid)).toBe("malformed");
  });

  it("C9: at the HTTP boundary an unknown key is 401 with a generic body, never a 503 and never a reason", async () => {
    const s = server();
    const t = signJwt(rsa, claims({ aud: SIM_AUDIENCE, sub: "sim|u" }), { kid: "never-published" });
    const r = await s.get("/api/me", t);
    expect([r.status, r.body.error.code]).toEqual([401, "unauthorized"]);
    expect(r.text).not.toMatch(/unknown_key|kid|never-published/);
    expect(r.headers["www-authenticate"]).toContain("invalid_token");
  });
});

describe("C10: provider outages, stale-key expiry and recovery", () => {
  it("C10: cached keys keep working inside the maximum age, sign-in answers 503 after it, and a good fetch recovers; nothing is ever a pass", async () => {
    const c = clock();
    const f = mockFetch([keySet(rsa.jwk as never), new Error("provider down"), new Error("provider down"), keySet(rsa.jwk as never)]);
    // 1200 s maximum age (the configured minimum is 600 s); the cache lifetime is the default 600 s
    const s = server({ fetch: f.fetchImpl, now: c.now, env: { OIDC_JWKS_MAX_AGE_SEC: "1200" } });
    const tok = () => signJwt(rsa, claims({ aud: SIM_AUDIENCE, sub: "sim|outage", iat: Math.floor(c.at() / 1000) - 5, exp: Math.floor(c.at() / 1000) + 600 }));
    expect((await s.get("/api/me", tok())).status).toBe(200);
    c.advance(700_000); // stale, refresh fails, the keys are 700 s old: inside the window
    expect((await s.get("/api/me", tok())).status).toBe(200);
    c.advance(600_000); // 1300 s old, refresh fails again: past the window
    const down = await s.get("/api/me", tok());
    expect([down.status, down.body.error.code]).toEqual([503, "auth_unavailable"]);
    expect(down.text).not.toMatch(/keys_unavailable|provider|jwks/i);
    c.advance(100_000); // the provider answers again
    expect((await s.get("/api/me", tok())).status).toBe(200);
    expect(f.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("C10: a provider that never answered keeps sign-in closed, and an unusable (empty) key set is a failed fetch, not a new empty cache", async () => {
    const never = rig([new Error("down"), new Error("down")]);
    expect(await outcome(never.v.verify(never.tok()))).toBe("keys_unavailable");
    const emptied = rig([keySet(rsa.jwk as never), { body: { keys: [] } }]);
    await emptied.v.verify(emptied.tok());
    emptied.c.advance(2_000);
    await expect(emptied.v.verify(emptied.tok())).resolves.toBeTruthy(); // the empty answer did not discard the cache
  });
});

/* ====================================================================================================================
 * C11  email is informational only
 * ================================================================================================================== */

describe("C11: a verified email is informational metadata and never an identity", () => {
  it("C11: only a boolean true email_verified keeps the address; a string 'true', false or absence drops it", async () => {
    const email = async (id: string) => (await verifier().verify(signJwt(rsa, SIM_PROFILES.find((p) => p.id === id)!.payload("sim|s")))).email;
    expect(await email("verified-email")).toBe("pat@example.test");
    expect(await email("string-booleans")).toBeNull();
    expect(await email("minimal")).toBeNull();
    for (const ev of [false, "false", 1, null, undefined]) expect((await verifier().verify(tokenWith({ email: "x@example.test", email_verified: ev }))).email, String(ev)).toBeNull();
    expect((await verifier().verify(tokenWith({ email: "x".repeat(321), email_verified: true }))).email).toBeNull();
  });

  it("C11: users are keyed by issuer and subject: one email under two subjects is two people, and a changed email is the same person", async () => {
    const s = server();
    const as = (sub: string, email: string) => jwtFor(sub, { email, email_verified: true, name: sub });
    expect((await s.get("/api/me", as("sim|one", "shared@example.test"))).status).toBe(200);
    expect((await s.get("/api/me", as("sim|two", "shared@example.test"))).status).toBe(200);
    expect(s.count("SELECT COUNT(*) n FROM users")).toBe(2);
    expect((await s.get("/api/me", as("sim|one", "renamed@example.test"))).status).toBe(200);
    expect(s.count("SELECT COUNT(*) n FROM users")).toBe(2);
    expect((s.db.prepare("SELECT email FROM users WHERE subject = 'sim|one'").get() as { email: string }).email).toBe("renamed@example.test");
  });
});

/* ====================================================================================================================
 * C12  allowlists, C13  claims never authorize
 * ================================================================================================================== */

describe("C12: exact subject allowlists and claim allowlists", () => {
  it("C12: matching is by exact subject of the configured issuer; email, case, padding and another issuer never match; claim list is a subset", () => {
    const rt = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "sim|alice,sim|bob", OIDC_CLAIM_SUBJECTS: "sim|alice" }), { keys: new StaticJwks([rsa.jwk]) });
    const who = (subject: string, over: Record<string, unknown> = {}) => ({ issuer: ISSUER, subject, email: null, displayName: null, ...over });
    expect([rt.policy.canRegister(who("sim|alice")), rt.policy.canClaim(who("sim|alice"))]).toEqual([true, true]);
    expect([rt.policy.canRegister(who("sim|bob")), rt.policy.canClaim(who("sim|bob"))]).toEqual([true, false]);
    for (const s of ["SIM|ALICE", "sim|alice ", " sim|alice", "sim|alic", "alice@example.test", "sim|*"]) expect(rt.policy.canRegister(who(s)), s).toBe(false);
    expect(rt.policy.canRegister(who("sim|zed", { email: "alice@example.test" }))).toBe(false);
    expect(rt.policy.canRegister(who("sim|alice", { issuer: "https://other.example.test/" }))).toBe(false);
    expect(() => loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "sim|alice", OIDC_CLAIM_SUBJECTS: "sim|bob" })).toThrow(/OIDC_CLAIM_SUBJECTS/);
    expect(() => loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "*" })).toThrow(/OIDC_ALLOWED_SUBJECTS/);
  });
});

describe("C13: claims in a token never grant authorization", () => {
  it("C13: role-, scope- and group-looking claims change nothing: a non-member is 404, a viewer cannot reach owner-only credential routes", async () => {
    const s = server();
    const alice = upsertUser(s.ctx, { issuer: ISSUER, subject: "sim|alice", email: null, displayName: "alice" });
    const bob = upsertUser(s.ctx, { issuer: ISSUER, subject: "sim|bob", email: null, displayName: "bob" });
    upsertUser(s.ctx, { issuer: ISSUER, subject: "sim|carol", email: null, displayName: "carol" });
    const ws = createWorkspaceForUser(s.ctx, userActor(alice.id) as never, "Claims Co");
    addMember(s.ctx, userActor(alice.id), ws.id, bob.id, "viewer");
    const profile = SIM_PROFILES.find((p) => p.id === "authorization-looking-claims")!;
    const as = (sub: string) => signJwt(rsa, profile.payload(sub));
    const put = (token: string) => s.app.inject({ method: "PUT", url: `/api/workspaces/${ws.id}/credentials/openai`, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify({ secret: "FIXTURE-SECRET-VALUE-7f3a9c1e5b2d4f60" }) });
    expect((await put(as("sim|bob"))).statusCode).toBe(403); // a viewer, whatever the token says
    expect((await put(as("sim|carol"))).statusCode).toBe(404); // not a member
    expect((await s.get(`/api/workspaces/${ws.id}/credentials`, as("sim|bob"))).status).toBe(403);
    expect((await s.get(`/api/workspaces/${ws.id}/credentials`, as("sim|carol"))).status).toBe(404);
    expect(s.count("SELECT COUNT(*) n FROM workspace_credentials")).toBe(0);
    expect((await put(as("sim|alice"))).statusCode).toBe(201); // the owner, by membership
  });
});

/* ====================================================================================================================
 * C14  size
 * ================================================================================================================== */

describe("C14: tokens up to 8192 characters are accepted end to end; longer ones are refused at both layers", () => {
  it("C14: size limits", async () => {
    const pad = (n: number) => jwtFor("sim|size", { pad: "x".repeat(n) });
    const sizeOf = (t: string) => t.length;
    let n = 4000; // base64 makes the token about 4/3 of the padding plus the fixed parts
    let t = pad(n);
    while (sizeOf(t) < 8000) t = pad((n += 25));
    expect(sizeOf(t)).toBeGreaterThanOrEqual(8000);
    expect(sizeOf(t)).toBeLessThanOrEqual(8192);
    const s = server();
    expect((await s.get("/api/me", t)).status).toBe(200);
    const big = pad(9000);
    expect(sizeOf(big)).toBeGreaterThan(8192);
    expect((await s.get("/api/me", big)).status).toBe(401);
    expect(await outcome(verifier().verify(big))).toBe("malformed");
  });
});

/* ====================================================================================================================
 * C15  token type (enforced), C16  replay / revocation / logout  (documented LIMITATIONS, pinned so a change is deliberate)
 * ================================================================================================================== */

describe("C15: only an explicitly supported access-token format is accepted; an ID token is never an API credential", () => {
  const CLIENT = "sim-spa-client";
  const strict = (over: Partial<ConstructorParameters<typeof OidcVerifier>[0]> = {}) => verifier({ clientId: CLIENT, ...over });
  const withTyp = (typ: unknown, over: Record<string, unknown> = {}) => signJwt(rsa, claims({ aud: SIM_AUDIENCE, ...over }), { typ } as never);

  it("C15: the header typ must be RFC 9068 at+jwt (either spelling); JWT, ID-token types, nothing or junk are refused", async () => {
    const v = strict();
    for (const typ of ["at+jwt", "AT+JWT", "application/at+jwt", "Application/AT+JWT"]) await expect(v.verify(withTyp(typ)), String(typ)).resolves.toBeTruthy();
    for (const typ of ["JWT", "jwt", "id_token+jwt", "ID_TOKEN", "", "at+jwt ", " at+jwt", "at+jwt;charset=utf-8", "application/", "application/at+jwt/x", "at+jwt\n", undefined, null, 7, ["at+jwt"], {}, true]) {
      expect(await outcome(v.verify(withTyp(typ))), JSON.stringify(typ)).toBe("wrong_token_type");
    }
  });

  it("C15: the type is decided from the header BEFORE any key is looked up, so a refused type never costs a key fetch", async () => {
    let lookups = 0;
    const counting = { getKey: async () => { lookups++; return undefined; } };
    const v = new OidcVerifier({ issuer: ISSUER, audience: SIM_AUDIENCE, keys: counting, now: () => NOW_MS, clientId: CLIENT });
    expect(await outcome(v.verify(withTyp("JWT")))).toBe("wrong_token_type");
    expect(lookups).toBe(0);
    expect(await outcome(v.verify(withTyp("at+jwt")))).toBe("unknown_key"); // an acceptable type does reach the key lookup
    expect(lookups).toBe(1);
  });

  it("C15: an ID token is refused however it is shaped, even when its audience would otherwise match the API", async () => {
    const v = strict();
    const idToken = { aud: CLIENT, azp: CLIENT, nonce: "n-0S6_WzA2Mj", at_hash: "simulated-hash", email: "pat@example.test", email_verified: true };
    expect(await outcome(v.verify(withTyp("JWT", idToken)))).toBe("wrong_token_type"); // the usual ID token
    expect(await outcome(v.verify(withTyp("at+jwt", idToken)))).toBe("wrong_token_type"); // mislabelled as an access token: its ID-token claims give it away
    expect(await outcome(v.verify(withTyp("at+jwt", { aud: CLIENT, azp: CLIENT })))).toBe("wrong_audience"); // no markers at all: it is addressed to the client, not to the API
    // addressed to BOTH the API and the client (the case a bare audience match would let through)
    for (const typ of ["JWT", "at+jwt"]) {
      expect(await outcome(v.verify(withTyp(typ, { aud: [SIM_AUDIENCE, CLIENT], azp: CLIENT })))).toBe("wrong_token_type");
      expect(await outcome(v.verify(withTyp(typ, { aud: [CLIENT, SIM_AUDIENCE], azp: CLIENT, nonce: "n" })))).toBe("wrong_token_type");
    }
    // each ID-token-only claim is enough on its own, on an otherwise perfect access token
    for (const claim of ["nonce", "at_hash", "c_hash"]) {
      expect(await outcome(v.verify(withTyp("at+jwt", { [claim]: "x" }))), claim).toBe("wrong_token_type");
      expect(await outcome(v.verify(withTyp("at+jwt", { [claim]: "" }))), `empty ${claim}`).toBe("wrong_token_type"); // presence, not value
    }
    // and the check does not depend on a client id being configured for the claim markers and the typ
    const noClient = verifier();
    expect(await outcome(noClient.verify(withTyp("JWT", idToken)))).toBe("wrong_token_type");
    expect(await outcome(noClient.verify(withTyp("at+jwt", { nonce: "x" })))).toBe("wrong_token_type");
  });

  it("C15: a genuine access token is not over-rejected: azp, session and authentication-context claims are fine", async () => {
    const v = strict();
    await expect(v.verify(withTyp("at+jwt", { azp: CLIENT, scope: "openid profile", sid: "sess-1", auth_time: NOW_SEC - 30, acr: "1", amr: ["pwd"], jti: "j1", client_id: CLIENT }))).resolves.toBeTruthy();
    await expect(v.verify(withTyp("at+jwt", { aud: [SIM_AUDIENCE, SIM_OTHER_RESOURCE], azp: CLIENT }))).resolves.toBeTruthy();
  });

  it("C15: naming another type is an explicit operator choice, and it does not switch the other defences off", async () => {
    const v = strict({ accessTokenTypes: ["JWT"] });
    await expect(v.verify(withTyp("JWT"))).resolves.toBeTruthy();
    expect(await outcome(v.verify(withTyp("at+jwt")))).toBe("wrong_token_type"); // only what was named
    expect(await outcome(v.verify(withTyp("JWT", { nonce: "x" })))).toBe("wrong_token_type");
    expect(await outcome(v.verify(withTyp("JWT", { aud: [SIM_AUDIENCE, CLIENT], azp: CLIENT })))).toBe("wrong_token_type");
    for (const bad of [[], ["bad value"], [""], ["x".repeat(80)]]) expect(() => strict({ accessTokenTypes: bad }), JSON.stringify(bad)).toThrow(/access-token types/);
  });

  it("C15: the configured types reach the running verifier (default at+jwt only; an explicit list replaces it)", async () => {
    const keys = new StaticJwks([rsa.jwk]);
    const make = (env: Record<string, string>) => buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, ...env }), { keys, now: () => NOW_MS }).verifier!;
    const byDefault = make({});
    await expect(byDefault.verify(withTyp("at+jwt"))).resolves.toBeTruthy();
    expect(await outcome(byDefault.verify(withTyp("JWT")))).toBe("wrong_token_type");
    const named = make({ OIDC_ACCESS_TOKEN_TYPES: "JWT" });
    await expect(named.verify(withTyp("JWT"))).resolves.toBeTruthy();
    expect(await outcome(named.verify(withTyp("at+jwt")))).toBe("wrong_token_type");
    // the client id and the lifetime ceiling configured in the environment reach it too
    expect(await outcome(make({}).verify(withTyp("at+jwt", { aud: [SIM_AUDIENCE, "sim-spa-client"], azp: "sim-spa-client" })))).toBe("wrong_token_type");
    expect(await outcome(make({ OIDC_MAX_TOKEN_LIFETIME_SEC: "300" }).verify(withTyp("at+jwt", { iat: NOW_SEC, exp: NOW_SEC + 400 })))).toBe("lifetime_too_long");
  });

  it("C15: at the HTTP boundary an ID token is the same generic 401, creates or changes no user, and a member cannot use theirs", async () => {
    const s = server({ env: { OIDC_CLIENT_ID: CLIENT } });
    const alice = upsertUser(s.ctx, { issuer: ISSUER, subject: "sim|alice", email: null, displayName: "alice" });
    const ws = createWorkspaceForUser(s.ctx, userActor(alice.id) as never, "Token Type Co");
    const idTokenFor = (sub: string, over: Record<string, unknown> = {}) => signJwt(rsa, claims({ aud: CLIENT, azp: CLIENT, sub, nonce: "n", at_hash: "h", name: "Changed Name", email: "x@example.test", email_verified: true, ...over }), { typ: "JWT" });
    const before = JSON.stringify(s.db.prepare("SELECT * FROM users ORDER BY id").all());
    const users = s.count("SELECT COUNT(*) n FROM users");
    for (const sub of ["sim|alice", "sim|mallory"]) {
      for (const url of ["/api/me", "/api/me/workspaces", `/api/workspaces/${ws.id}`, `/api/workspaces/${ws.id}/credentials`]) {
        const r = await s.get(url, idTokenFor(sub));
        expect([sub, url, r.status], `${sub} ${url}`).toEqual([sub, url, url.includes("/workspaces/") ? 401 : 401]);
        expect(r.body.error.code).toBe("unauthorized");
        expect(r.text).not.toMatch(/token|type|nonce|id_token|audience|client/i); // generic: nothing about why
      }
      // the ID-token shape that WOULD pass a bare audience check
      expect((await s.get("/api/me", idTokenFor(sub, { aud: [SIM_AUDIENCE, CLIENT], typ: undefined }))).status).toBe(401);
    }
    const post = await s.app.inject({ method: "POST", url: "/api/workspaces", headers: { authorization: `Bearer ${idTokenFor("sim|mallory")}`, "content-type": "application/json" }, payload: JSON.stringify({ name: "Evil Co" }) });
    expect(post.statusCode).toBe(401);
    expect(s.count("SELECT COUNT(*) n FROM users")).toBe(users); // nobody was created
    expect(JSON.stringify(s.db.prepare("SELECT * FROM users ORDER BY id").all())).toBe(before); // nobody was modified (name and email untouched)
    expect(s.count("SELECT COUNT(*) n FROM workspaces")).toBe(1);
    // the same person's real access token works
    const access = signJwt(rsa, claims({ aud: SIM_AUDIENCE, sub: "sim|alice", azp: CLIENT }));
    expect((await s.get("/api/me", access)).status).toBe(200);
  });

  it("C15: opaque (non-JWT) bearers cannot be verified and are refused (no introspection exists, by decision)", async () => {
    const s = server();
    for (const opaque of ["gho_simulatedopaqueaccesstoken0123456789", "Zm9vYmFy", "a.b", "a.b.c.d"]) expect((await s.get("/api/me", opaque)).status, opaque).toBe(401);
  });
});

describe("C16: tokens are stateless: replay until expiry, no server-side revocation or logout (a documented limitation)", () => {
  it("C16: the same valid token works repeatedly until it expires; there is no logout or session route", async () => {
    const c = clock();
    const s = server({ now: c.now });
    const t = signJwt(rsa, claims({ aud: SIM_AUDIENCE, sub: "sim|replay", jti: "same-id", iat: NOW_SEC - 5, exp: NOW_SEC + 300 }));
    for (let i = 0; i < 3; i++) expect((await s.get("/api/me", t)).status).toBe(200); // no jti memory
    c.advance(400_000);
    expect((await s.get("/api/me", t)).status).toBe(401); // expiry is the only end
    for (const url of ["/api/logout", "/api/session", "/api/sessions", "/logout", "/api/token/revoke"]) expect((await s.get(url, t)).status, url).toBeGreaterThanOrEqual(400);
  });
});

/* ====================================================================================================================
 * C18  explicit configuration; contradictory settings are refused
 * ================================================================================================================== */

describe("C18: the deployment states its client id and token lifetime; contradictory settings stop startup without echoing values", () => {
  it("C18: issuer, audience, JWKS address, client id and token lifetime are all required, each error names only its variable", () => {
    const full = { ...BASE_ENV };
    expect(oidcConfig(full)).toMatchObject({ mode: "oidc", clientId: "sim-spa-client", maxTokenLifetimeSec: 900, accessTokenTypes: ["at+jwt"] });
    for (const name of ["OIDC_ISSUER", "OIDC_AUDIENCE", "OIDC_JWKS_URI", "OIDC_CLIENT_ID", "OIDC_MAX_TOKEN_LIFETIME_SEC"]) {
      const env = { ...full } as Record<string, string>;
      delete env[name];
      expect(() => loadAuthConfig(env), name).toThrow(new RegExp(`${name}: required|${name}: must|${name}`));
      for (const blank of ["", "   "]) expect(() => loadAuthConfig({ ...env, [name]: blank }), `${name}=${JSON.stringify(blank)}`).toThrow(new RegExp(name));
    }
  });

  it("C18: the token lifetime is 60 to 900 seconds and nothing else", () => {
    for (const v of ["60", "300", "600", "900"]) expect(oidcConfig({ ...BASE_ENV, OIDC_MAX_TOKEN_LIFETIME_SEC: v }).maxTokenLifetimeSec, v).toBe(Number(v));
    for (const v of ["0", "59", "901", "1000", "3600", "86400", "-1", "9.5", "1e3", "abc", "0x10", " 12 x"]) expect(() => loadAuthConfig({ ...BASE_ENV, OIDC_MAX_TOKEN_LIFETIME_SEC: v }), v).toThrow(/OIDC_MAX_TOKEN_LIFETIME_SEC/);
  });

  it("C18: an audience equal to the client id is contradictory (an ID token is addressed to the client id) and is refused without echoing it", () => {
    let message = "";
    try { loadAuthConfig({ ...BASE_ENV, OIDC_AUDIENCE: "shared-identifier-123", OIDC_CLIENT_ID: "shared-identifier-123" }); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/OIDC_AUDIENCE: must differ from OIDC_CLIENT_ID/);
    expect(message).not.toContain("shared-identifier-123");
  });

  it("C18: accepted token types are an explicit list; an ID-token type, junk or an empty list is refused; the default is RFC 9068", () => {
    expect(oidcConfig({ ...BASE_ENV, OIDC_ACCESS_TOKEN_TYPES: "" }).accessTokenTypes).toEqual(["at+jwt"]);
    expect(oidcConfig({ ...BASE_ENV, OIDC_ACCESS_TOKEN_TYPES: "at+jwt, application/AT+JWT" }).accessTokenTypes).toEqual(["at+jwt"]);
    expect(oidcConfig({ ...BASE_ENV, OIDC_ACCESS_TOKEN_TYPES: "JWT" }).accessTokenTypes).toEqual(["jwt"]); // allowed only because it was named
    for (const v of ["id_token+jwt", "ID_TOKEN", "at+jwt,id_token+jwt", "a b", "x".repeat(70), ",", "at+jwt,,"]) expect(() => loadAuthConfig({ ...BASE_ENV, OIDC_ACCESS_TOKEN_TYPES: v }), v).toThrow(/OIDC_ACCESS_TOKEN_TYPES/);
  });

  it("C18: only non-secret values are published to the browser, and the ceiling is a constant the verifier enforces itself", () => {
    const rt = buildAuthRuntime(loadAuthConfig({ ...BASE_ENV, OIDC_ALLOWED_SUBJECTS: "sim|a", OIDC_ACCESS_TOKEN_TYPES: "JWT" }), { keys: new StaticJwks([rsa.jwk]) });
    expect(Object.keys(rt.publicConfig).sort()).toEqual(["audience", "clientId", "issuer", "mode"]);
    expect(JSON.stringify(rt.publicConfig)).not.toMatch(/sim\|a|jwt|900|jwks/i);
    expect(() => verifier({ maxLifetimeSec: 901 })).toThrow();
  });
});

/* ====================================================================================================================
 * keep the document and this file in step
 * ================================================================================================================== */

describe("the contract document and this suite agree", () => {
  const load = () => {
    const doc = readFileSync("docs/idp-compatibility.md", "utf8");
    const self = readFileSync("test/idpContract.test.ts", "utf8");
    const rows = [...doc.matchAll(/^\| (C\d+) \| ([^|]+)\| ([^|]+)\|/gm)].map((m) => ({ id: m[1]!, status: m[3]!.trim() }));
    return { doc, self, rows };
  };

  it("every clause in the document has a status, and every one marked ENFORCED, REFERENCE or LIMITATION has tests here", () => {
    const { self, rows } = load();
    expect(rows.length).toBeGreaterThanOrEqual(17);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.status, r.id).toMatch(/^(ENFORCED|REFERENCE|LIMITATION|STAGING)/);
      if (/^(ENFORCED|REFERENCE|LIMITATION)/.test(r.status)) expect(self.includes(`it("${r.id}:`), `${r.id} has no test titled "${r.id}: ..."`).toBe(true);
    }
  });

  it("every test clause id appears in the document, and the document says the fixtures are simulated", () => {
    const { doc, self, rows } = load();
    const ids = new Set([...self.matchAll(/\bit\(`?"?(C\d+)[:"` ]/g)].map((m) => m[1]!));
    for (const id of ids) expect(rows.some((r) => r.id === id), `${id} is not in the document`).toBe(true);
    expect(doc).toMatch(/SIMULATED/);
    expect(doc).toMatch(/not verified against any real provider|does not verify any real provider/i);
    expect(readFileSync("test/support/simulatedIdp.ts", "utf8")).toMatch(/INVENTED/);
  });
});
