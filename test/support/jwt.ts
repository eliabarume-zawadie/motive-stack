import { createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

/** Local test keys and a JWT signer. Keys are generated per test run and exist only in memory: nothing here is a real credential. */
export const b64u = (v: string | Buffer | object): string => Buffer.from(typeof v === "object" && !Buffer.isBuffer(v) ? JSON.stringify(v) : v).toString("base64url");

export interface TestKey {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: KeyObject;
  /** The public half as it would appear in a JWKS. */
  jwk: JsonWebKey & { kid: string; use: string; alg: string };
}

export function makeKey(alg: "RS256" | "ES256", kid: string, modulusLength = 2048): TestKey {
  const pair = alg === "RS256" ? generateKeyPairSync("rsa", { modulusLength }) : generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...(pair.publicKey.export({ format: "jwk" }) as JsonWebKey), kid, use: "sig", alg } as TestKey["jwk"];
  return { kid, alg, privateKey: pair.privateKey, jwk };
}

/** The settings an OIDC deployment must now state explicitly (no defaults): the browser client id and the access-token lifetime. Test values only. */
export const OIDC_REQUIRED = { OIDC_CLIENT_ID: "sim-spa-client", OIDC_MAX_TOKEN_LIFETIME_SEC: "900" };

export const ISSUER = "https://idp.example.test/";
export const AUDIENCE = "motivestack-api";
export const NOW_MS = Date.UTC(2026, 9, 19, 12, 0, 0);
export const NOW_SEC = Math.floor(NOW_MS / 1000);

export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: ISSUER, aud: AUDIENCE, sub: "idp|user-123", exp: NOW_SEC + 600, iat: NOW_SEC - 10, ...over };
}

/** Signs `payload` with `key`. `header` overrides let a test forge odd tokens (wrong alg, no kid, extra fields). */
export function signJwt(key: TestKey, payload: Record<string, unknown> = claims(), header: Record<string, unknown> = {}): string {
  const h = { alg: key.alg, typ: "at+jwt", kid: key.kid, ...header }; // RFC 9068 access-token marker: the one format the API accepts by default
  const data = `${b64u(h)}.${b64u(payload)}`;
  const sig = key.alg === "ES256" ? sign("sha256", Buffer.from(data), { key: key.privateKey, dsaEncoding: "ieee-p1363" }) : sign("sha256", Buffer.from(data), key.privateKey);
  return `${data}.${sig.toString("base64url")}`;
}

/** The classic algorithm-confusion forgery: an HS256 token "signed" using the public key bytes as the HMAC secret. */
export function hmacForgery(key: TestKey, payload: Record<string, unknown> = claims()): string {
  const data = `${b64u({ alg: "HS256", typ: "JWT", kid: key.kid })}.${b64u(payload)}`;
  const secret = JSON.stringify(key.jwk);
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

export const unsignedToken = (payload: Record<string, unknown> = claims()): string => `${b64u({ alg: "none", typ: "JWT" })}.${b64u(payload)}.`;

/**
 * Test fixture only: a policy that authorizes every identity, injected in code (buildAuthRuntime's `policy` option). Production has no
 * such switch; its lists come from OIDC_ALLOWED_SUBJECTS / OIDC_CLAIM_SUBJECTS. Tests of the closed behavior build the real policy.
 */
export const OPEN_POLICY = { canRegister: () => true, canClaim: () => true };
