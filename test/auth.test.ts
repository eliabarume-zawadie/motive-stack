import { describe, expect, it } from "vitest";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { RemoteJwks, StaticJwks } from "../src/auth/jwks.js";
import { OidcVerifier } from "../src/auth/oidc.js";
import { AuthError } from "../src/auth/types.js";
import { mockFetch } from "./helpers.js";
import { AUDIENCE, ISSUER, NOW_MS, NOW_SEC, b64u, claims, hmacForgery, makeKey, signJwt, unsignedToken , OIDC_REQUIRED } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const ec = makeKey("ES256", "ec-1");
const other = makeKey("RS256", "rsa-1"); // same key id, a DIFFERENT key pair: what an attacker's own key looks like

const verifier = (over: Partial<ConstructorParameters<typeof OidcVerifier>[0]> = {}) =>
  new OidcVerifier({ issuer: ISSUER, audience: AUDIENCE, keys: new StaticJwks([rsa.jwk, ec.jwk]), now: () => NOW_MS, ...over });

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AuthError) return e.reason;
    throw e;
  }
  return "ACCEPTED";
}

describe("OIDC token verification: accepted tokens", () => {
  it("accepts a correctly signed RS256 and ES256 token and returns the verified identity", async () => {
    for (const k of [rsa, ec]) {
      const id = await verifier().verify(signJwt(k, claims({ email: "pat@example.test", email_verified: true, name: "  Pat Example " })));
      expect(id).toEqual({ issuer: ISSUER, subject: "idp|user-123", email: "pat@example.test", displayName: "Pat Example" });
    }
  });
  it("does not keep an email the provider has not verified, and never uses email as the identity", async () => {
    const id = await verifier().verify(signJwt(rsa, claims({ email: "boss@victim.test", email_verified: false })));
    expect(id.email).toBeNull();
    expect(id.subject).toBe("idp|user-123");
    expect((await verifier().verify(signJwt(rsa, claims({ email: "x@y.test" })))).email).toBeNull(); // claim absent = not verified
  });
  it("accepts an audience list that includes ours, when the token names the configured client (azp); see identityHardening.test.ts for the rest of the policy", async () => {
    await expect(verifier({ clientId: "pilot-client" }).verify(signJwt(rsa, claims({ aud: ["other-api", AUDIENCE], azp: "pilot-client" })))).resolves.toMatchObject({ subject: "idp|user-123" });
  });
  it("tolerates clock skew inside the leeway and no more", async () => {
    await expect(verifier().verify(signJwt(rsa, claims({ exp: NOW_SEC - 59 })))).resolves.toBeTruthy();
    expect(await reason(verifier().verify(signJwt(rsa, claims({ exp: NOW_SEC - 60 }))))).toBe("expired");
    await expect(verifier().verify(signJwt(rsa, claims({ nbf: NOW_SEC + 59 })))).resolves.toBeTruthy();
    expect(await reason(verifier().verify(signJwt(rsa, claims({ nbf: NOW_SEC + 61 }))))).toBe("not_yet_valid");
  });
});

describe("OIDC token verification: rejected tokens", () => {
  it("rejects missing, non-string, oversized and structurally broken tokens", async () => {
    for (const t of [undefined, null, 42, "", "a.b", "a.b.c.d", "...", "not a token", `${"a".repeat(9000)}.b.c`] as unknown[]) {
      expect(await reason(verifier().verify(t as string)), String(t).slice(0, 20)).toBe("malformed");
    }
    expect(await reason(verifier().verify(`${b64u("[1]")}.${b64u({})}.${b64u("x")}`))).toBe("malformed"); // header is not an object
    expect(await reason(verifier().verify(`!!!.${b64u({})}.${b64u("x")}`))).toBe("malformed");
  });
  it("rejects a tampered payload and a token signed by a different key with the same key id", async () => {
    const good = signJwt(rsa);
    const [h, , s] = good.split(".") as [string, string, string];
    expect(await reason(verifier().verify(`${h}.${b64u(claims({ sub: "idp|someone-else" }))}.${s}`))).toBe("bad_signature");
    expect(await reason(verifier().verify(signJwt(other)))).toBe("bad_signature");
    expect(await reason(verifier().verify(`${h}.${good.split(".")[1]}.${b64u("short")}`))).toBe("bad_signature");
  });
  it("rejects alg none, HMAC (algorithm confusion) and algorithms not allowed, before looking at any key", async () => {
    expect(await reason(verifier().verify(`${b64u({ alg: "none", kid: "rsa-1" })}.${b64u(claims())}.${b64u("sig")}`))).toBe("unsupported_algorithm");
    expect(await reason(verifier().verify(hmacForgery(rsa)))).toBe("unsupported_algorithm");
    expect(await reason(verifier().verify(signJwt(rsa, claims(), { alg: "RS512" })))).toBe("unsupported_algorithm");
    expect(await reason(verifier({ algorithms: ["ES256"] }).verify(signJwt(rsa)))).toBe("unsupported_algorithm");
    expect(await reason(verifier().verify(unsignedToken()))).toBe("malformed");
  });
  it("rejects a token missing its key id, with critical headers, or naming an unknown key", async () => {
    expect(await reason(verifier().verify(signJwt(rsa, claims(), { kid: undefined })))).toBe("malformed");
    expect(await reason(verifier().verify(signJwt(rsa, claims(), { crit: ["exp"] })))).toBe("malformed");
    expect(await reason(verifier().verify(signJwt(rsa, claims(), { kid: "nope" })))).toBe("unknown_key");
  });
  it("never lets the token choose its own key (jku / x5u / embedded jwk are ignored)", async () => {
    const attacker = makeKey("RS256", "rsa-1");
    const t = signJwt(attacker, claims(), { jku: "https://evil.example.test/keys", x5u: "https://evil.example.test/cert", jwk: attacker.jwk });
    expect(await reason(verifier().verify(t))).toBe("bad_signature");
  });
  it("rejects wrong issuer (including near-misses) and wrong audience", async () => {
    for (const iss of ["https://evil.example.test/", "https://idp.example.test", "https://idp.example.test//", undefined]) {
      expect(await reason(verifier().verify(signJwt(rsa, claims({ iss })))), String(iss)).toBe("wrong_issuer");
    }
    for (const aud of ["other-api", [], ["a", "b"], undefined, 7, `${AUDIENCE}x`]) {
      expect(await reason(verifier().verify(signJwt(rsa, claims({ aud })))), String(aud)).toBe("wrong_audience");
    }
  });
  it("rejects expired tokens, tokens without exp, and tokens issued in the future", async () => {
    expect(await reason(verifier().verify(signJwt(rsa, claims({ exp: NOW_SEC - 3600 }))))).toBe("expired");
    expect(await reason(verifier().verify(signJwt(rsa, claims({ exp: undefined }))))).toBe("missing_claim");
    expect(await reason(verifier().verify(signJwt(rsa, claims({ exp: "soon" }))))).toBe("missing_claim");
    expect(await reason(verifier().verify(signJwt(rsa, claims({ iat: NOW_SEC + 3600 }))))).toBe("not_yet_valid");
    expect(await reason(verifier().verify(signJwt(rsa, claims({ nbf: "x" }))))).toBe("malformed");
  });
  it("rejects a token without a usable subject", async () => {
    for (const sub of [undefined, "", 12, "x".repeat(256)]) expect(await reason(verifier().verify(signJwt(rsa, claims({ sub })))), String(sub).slice(0, 5)).toBe("missing_claim");
  });
  it("rejects keys that are unsafe or do not fit the token", async () => {
    const weak = makeKey("RS256", "weak", 1024);
    expect(await reason(verifier({ keys: new StaticJwks([weak.jwk]) }).verify(signJwt(weak)))).toBe("unknown_key");
    const leaky = { ...rsa.jwk, d: "private-part" } as JsonWebKey & { kid: string };
    expect(await reason(verifier({ keys: new StaticJwks([leaky]) }).verify(signJwt(rsa)))).toBe("unknown_key");
    expect(await reason(verifier({ keys: new StaticJwks([{ ...rsa.jwk, use: "enc" }]) }).verify(signJwt(rsa)))).toBe("unknown_key");
    expect(await reason(verifier({ keys: new StaticJwks([{ ...rsa.jwk, alg: "RS384" }]) }).verify(signJwt(rsa)))).toBe("unknown_key");
    expect(await reason(verifier({ keys: new StaticJwks([{ ...ec.jwk, kid: "rsa-1" }]) }).verify(signJwt(rsa)))).toBe("unknown_key"); // EC key presented for an RS256 token
  });
  it("does not accept a verified token for a verifier configured for another issuer or audience", async () => {
    const t = signJwt(rsa);
    expect(await reason(verifier({ issuer: "https://other.example.test/" }).verify(t))).toBe("wrong_issuer");
    expect(await reason(verifier({ audience: "different-api" }).verify(t))).toBe("wrong_audience");
  });
});

describe("remote key set", () => {
  const set = (...keys: Array<{ kid: string }>) => ({ body: { keys } });
  const clock = () => {
    let t = NOW_MS;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("only accepts an https URL without credentials", () => {
    expect(() => new RemoteJwks({ uri: "http://idp.example.test/jwks" })).toThrow(/https/);
    expect(() => new RemoteJwks({ uri: "https://user:pw@idp.example.test/jwks" })).toThrow(/credentials/);
    expect(() => new RemoteJwks({ uri: "nonsense" })).toThrow(/valid URL/);
  });
  it("fetches once, caches, and never follows redirects", async () => {
    const f = mockFetch([set(rsa.jwk as never)]);
    const c = clock();
    const v = verifier({ keys: new RemoteJwks({ uri: "https://idp.example.test/jwks", fetch: f.fetchImpl, now: c.now }) });
    await v.verify(signJwt(rsa));
    await v.verify(signJwt(rsa));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init.redirect).toBe("error");
    expect(f.calls[0]!.url).toBe("https://idp.example.test/jwks");
  });
  it("picks up a rotated key, but an unknown key id cannot trigger fetches faster than the cooldown", async () => {
    const rotated = makeKey("RS256", "rsa-2");
    const f = mockFetch([set(rsa.jwk as never), set(rsa.jwk as never, rotated.jwk as never)]);
    const c = clock();
    const keys = new RemoteJwks({ uri: "https://idp.example.test/jwks", fetch: f.fetchImpl, now: c.now, cooldownMs: 60_000 });
    const v = verifier({ keys });
    await v.verify(signJwt(rsa));
    expect(await reason(v.verify(signJwt(rotated)))).toBe("unknown_key"); // within the cooldown: no new fetch
    expect(f.calls).toHaveLength(1);
    c.advance(61_000);
    await expect(v.verify(signJwt(rotated))).resolves.toBeTruthy();
    expect(f.calls).toHaveLength(2);
    for (let i = 0; i < 20; i++) await reason(v.verify(signJwt(rsa, claims(), { kid: `junk-${i}` }))); // a flood of unknown ids
    expect(f.calls).toHaveLength(2);
  });
  it("fails closed with keys_unavailable when the provider cannot be reached or answers badly, and keeps serving cached keys", async () => {
    for (const first of [new Error("down"), { status: 500, body: {} }, { body: { notKeys: 1 } }]) {
      const f = mockFetch([first as never]);
      const v = verifier({ keys: new RemoteJwks({ uri: "https://idp.example.test/jwks", fetch: f.fetchImpl, now: clock().now }) });
      expect(await reason(v.verify(signJwt(rsa)))).toBe("keys_unavailable");
    }
    const f = mockFetch([set(rsa.jwk as never), new Error("down")]);
    const c = clock();
    const v = verifier({ keys: new RemoteJwks({ uri: "https://idp.example.test/jwks", fetch: f.fetchImpl, now: c.now, ttlMs: 1000, cooldownMs: 500 }) });
    await v.verify(signJwt(rsa));
    c.advance(5000); // stale and refetch fails: the last good key still verifies
    await expect(v.verify(signJwt(rsa))).resolves.toBeTruthy();
    expect(f.calls).toHaveLength(2);
  });
  it("rejects an oversized key set", async () => {
    const f = mockFetch([{ body: { keys: [], pad: "x".repeat(200) } }]);
    const v = verifier({ keys: new RemoteJwks({ uri: "https://idp.example.test/jwks", fetch: f.fetchImpl, maxBytes: 100, now: clock().now }) });
    expect(await reason(v.verify(signJwt(rsa)))).toBe("keys_unavailable");
  });
});

describe("authentication configuration", () => {
  const good = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/.well-known/jwks.json", ...OIDC_REQUIRED };

  it("defaults to workspace tokens only, with no verifier", () => {
    expect(loadAuthConfig({})).toEqual({ mode: "workspace_token" });
    const rt = buildAuthRuntime(loadAuthConfig({}));
    expect(rt).toMatchObject({ mode: "workspace_token", verifier: null, publicConfig: { mode: "workspace_token" } });
  });
  it("accepts a complete OIDC configuration and publishes only non-secret values", () => {
    const cfg = loadAuthConfig({ ...good, OIDC_CLIENT_ID: "public-client-id" });
    expect(cfg).toMatchObject({ mode: "oidc", issuer: ISSUER, audience: AUDIENCE, clientId: "public-client-id", algorithms: ["RS256", "ES256"] });
    const rt = buildAuthRuntime(cfg, { keys: new StaticJwks([]) });
    expect(Object.keys(rt.publicConfig).sort()).toEqual(["audience", "clientId", "issuer", "mode"]);
  });
  it("refuses an unknown mode and every incomplete or insecure OIDC setup, naming variables but not values", () => {
    expect(() => loadAuthConfig({ AUTH_MODE: "dev" })).toThrow(/AUTH_MODE/);
    expect(() => loadAuthConfig({ AUTH_MODE: "oidc" })).toThrow(/OIDC_ISSUER.*OIDC_JWKS_URI.*OIDC_AUDIENCE/);
    expect(() => loadAuthConfig({ ...good, OIDC_ISSUER: "http://idp.example.test/" })).toThrow(/OIDC_ISSUER: must be an https URL/);
    expect(() => loadAuthConfig({ ...good, OIDC_JWKS_URI: "https://u:p@idp.example.test/k" })).toThrow(/OIDC_JWKS_URI/);
    expect(() => loadAuthConfig({ ...good, OIDC_ALGORITHMS: "HS256" })).toThrow(/OIDC_ALGORITHMS/);
    try {
      loadAuthConfig({ ...good, OIDC_ISSUER: "http://leaky-value.example.test/" });
    } catch (e) {
      expect(String(e)).not.toContain("leaky-value");
    }
  });
});
