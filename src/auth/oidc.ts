import { createPublicKey, verify as cryptoVerify, type JsonWebKey as NodeJwk } from "node:crypto";
import type { JwksSource } from "./jwks.js";
import { AuthError, type Identity, type IdentityVerifier } from "./types.js";

export type JwtAlgorithm = "RS256" | "ES256";
export const SUPPORTED_ALGORITHMS: readonly JwtAlgorithm[] = ["RS256", "ES256"];

/** The longest an access token may live (exp minus iat), in seconds. Not configurable above this: it is the pilot's revocation window. */
export const MAX_ACCESS_TOKEN_LIFETIME_SEC = 900;

/**
 * The only JWT access-token format accepted unless the operator names another one: RFC 9068, "JWT Profile for OAuth 2.0 Access Tokens",
 * which marks access tokens with the header `typ: at+jwt`. A token without that marker is refused, so a provider that does not emit it
 * fails CLOSED until its actual format has been verified (staging check S6) and configured deliberately.
 */
export const DEFAULT_ACCESS_TOKEN_TYPES: readonly string[] = ["at+jwt"];

/** Claims defined by OpenID Connect Core for ID tokens only. A bearer carrying any of them is an ID token (or a token made from one). */
export const ID_TOKEN_ONLY_CLAIMS: readonly string[] = ["nonce", "at_hash", "c_hash"];

/**
 * A `typ` value in comparable form, or null when it is not one. Case-insensitive, and the "application/" media-type prefix is
 * equivalent (RFC 7515 4.1.9, RFC 9068 2.1). Nothing else is normalized: padding, parameters and non-strings do not match anything.
 */
export function normalizeTokenType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.toLowerCase();
  const bare = t.startsWith("application/") ? t.slice("application/".length) : t;
  return /^[a-z0-9][a-z0-9._+-]{0,63}$/.test(bare) ? bare : null;
}

export interface OidcVerifierOptions {
  /** Exact issuer string the token's `iss` must equal. */
  issuer: string;
  /** This API's identifier: the token's `aud` must be, or include, this value. */
  audience: string;
  keys: JwksSource;
  /** Accepted signature algorithms. Default: both supported ones. Never includes "none" or any HMAC algorithm. */
  algorithms?: readonly JwtAlgorithm[];
  /** Clock tolerance in seconds for exp / nbf / iat. Default 60. */
  leewaySec?: number;
  /**
   * Longest validity a token may have. Measured two ways: exp minus iat must not exceed it (a duration inside the token, no clock
   * skew involved, so NO leeway), and exp minus now must not exceed it plus the leeway (the verifier's clock may differ). Default and
   * ceiling: 900 seconds.
   */
  maxLifetimeSec?: number;
  /** Accepted values of the header `typ` (normalized). Default: RFC 9068 `at+jwt` only. A token with another or no `typ` is refused. */
  accessTokenTypes?: readonly string[];
  /** The OAuth client this API expects tokens to have been issued to (the azp claim). See the azp rules in verify(). */
  clientId?: string | null;
  /** Require an azp claim equal to clientId on EVERY token. Off by default because providers differ in whether they issue it. */
  requireAzp?: boolean;
  now?: () => number;
}

const MAX_TOKEN_CHARS = 8192;
const B64URL = /^[A-Za-z0-9_-]+$/;

const fail = (reason: ConstructorParameters<typeof AuthError>[0], detail?: string): never => {
  throw new AuthError(reason, detail);
};

function decodeJson(part: string): Record<string, unknown> {
  if (!B64URL.test(part)) return fail("malformed", "segment is not base64url");
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return fail("malformed", "segment is not JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("malformed", "segment is not an object");
  return v as Record<string, unknown>;
}

/**
 * Verifies an OpenID Connect / OAuth2 JWT against the provider's public keys. Order matters: structure, then algorithm and
 * key, then the SIGNATURE, and only then are the claims read. Nothing in an unverified payload is ever used as identity.
 *
 * Not used from the token: `jku`, `x5u`, `jwk` and other headers that would let the token choose its own key.
 */
export class OidcVerifier implements IdentityVerifier {
  private readonly algorithms: readonly JwtAlgorithm[];
  private readonly leeway: number;
  private readonly maxLifetime: number;
  private readonly accessTypes: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(private readonly o: OidcVerifierOptions) {
    if (!o.issuer || !o.audience) throw new Error("OidcVerifier needs an issuer and an audience");
    this.algorithms = (o.algorithms ?? SUPPORTED_ALGORITHMS).filter((a) => SUPPORTED_ALGORITHMS.includes(a));
    if (this.algorithms.length === 0) throw new Error("OidcVerifier needs at least one supported algorithm");
    this.leeway = o.leewaySec ?? 60;
    this.maxLifetime = o.maxLifetimeSec ?? MAX_ACCESS_TOKEN_LIFETIME_SEC;
    if (!Number.isFinite(this.maxLifetime) || this.maxLifetime < 1 || this.maxLifetime > MAX_ACCESS_TOKEN_LIFETIME_SEC) throw new Error(`OidcVerifier needs a maximum token lifetime from 1 to ${MAX_ACCESS_TOKEN_LIFETIME_SEC} seconds`);
    const types = (o.accessTokenTypes ?? DEFAULT_ACCESS_TOKEN_TYPES).map(normalizeTokenType);
    if (types.length === 0 || types.some((t) => t === null)) throw new Error("OidcVerifier needs valid access-token types");
    this.accessTypes = new Set(types as string[]);
    if (o.requireAzp && !o.clientId) throw new Error("OidcVerifier: requiring azp needs a client id");
    this.now = o.now ?? Date.now;
  }

  async verify(token: string): Promise<Identity> {
    if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return fail("malformed", "token missing or too long");
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => p.length === 0)) return fail("malformed", "not a compact JWS");
    const [h, p, s] = parts as [string, string, string];

    const header = decodeJson(h);
    const alg = header.alg;
    if (typeof alg !== "string" || !this.algorithms.includes(alg as JwtAlgorithm)) return fail("unsupported_algorithm");
    if ("crit" in header) return fail("malformed", "critical header extensions are not supported");
    // Token type, decided from the header BEFORE any key is looked up: only an explicitly accepted access-token type gets further.
    // (The header is unverified here; this only ever REFUSES more. The signature still decides what is genuine.)
    const typ = normalizeTokenType(header.typ);
    if (typ === null || !this.accessTypes.has(typ)) return fail("wrong_token_type");
    const kid = header.kid;
    if (typeof kid !== "string" || kid.length === 0 || kid.length > 256) return fail("malformed", "missing key id");

    const jwk = await this.o.keys.getKey(kid);
    if (!jwk) return fail("unknown_key");
    const key = this.publicKeyFor(jwk, alg as JwtAlgorithm);

    if (!B64URL.test(s)) return fail("malformed", "signature is not base64url");
    const signature = Buffer.from(s, "base64url");
    const data = Buffer.from(`${h}.${p}`, "ascii");
    let ok = false;
    try {
      ok = alg === "ES256"
        ? signature.length === 64 && cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
        : cryptoVerify("sha256", data, key, signature);
    } catch {
      ok = false;
    }
    if (!ok) return fail("bad_signature");

    // Signature verified: from here on the claims are trustworthy to read.
    const c = decodeJson(p);
    if (c.iss !== this.o.issuer) return fail("wrong_issuer");
    // Claims that exist only in OpenID Connect ID tokens: a bearer that carries one is an ID token (or made from one), whatever its header says.
    for (const marker of ID_TOKEN_ONLY_CLAIMS) if (marker in c) return fail("wrong_token_type");
    const aud = c.aud;
    // aud is a string or an array of strings. An array that mixes in anything else is ambiguous (filtering it would hide a second audience
    // from the multi-audience rule below), so it is refused rather than interpreted.
    if (Array.isArray(aud) && aud.some((a) => typeof a !== "string")) return fail("malformed", "aud");
    const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? (aud as string[]) : [];
    if (!audiences.includes(this.o.audience)) return fail("wrong_audience");
    // A token addressed to the browser client (its client id is an audience) is an ID token by definition, not an API credential.
    if (this.o.clientId && audiences.includes(this.o.clientId)) return fail("wrong_token_type");
    // Audience / client relationship. Providers differ, so nothing is assumed about azp:
    //   - a token with several audiences MUST carry azp equal to the configured client id (OpenID Connect Core, ID Token); with no
    //     client id configured such a token cannot be attributed to a client and is refused;
    //   - when a client id is configured, any azp that IS present must equal it;
    //   - azp is demanded on every token only when requireAzp is set.
    const azp = c.azp;
    if (azp !== undefined && typeof azp !== "string") return fail("malformed", "azp");
    const clientId = this.o.clientId ?? null;
    if (audiences.length > 1 && (clientId === null || azp !== clientId)) return fail("wrong_client");
    if (clientId !== null && azp !== undefined && azp !== clientId) return fail("wrong_client");
    if (this.o.requireAzp && azp !== clientId) return fail("wrong_client");

    const nowSec = Math.floor(this.now() / 1000);
    if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return fail("missing_claim", "exp");
    if (nowSec >= c.exp + this.leeway) return fail("expired");
    if (c.nbf !== undefined && (typeof c.nbf !== "number" || !Number.isFinite(c.nbf))) return fail("malformed", "nbf");
    if (typeof c.nbf === "number" && nowSec + this.leeway < c.nbf) return fail("not_yet_valid");
    if (c.iat !== undefined && (typeof c.iat !== "number" || !Number.isFinite(c.iat))) return fail("malformed", "iat");
    if (typeof c.iat === "number" && c.iat > nowSec + this.leeway) return fail("not_yet_valid");
    // A token must not stay valid for longer than the policy allows, whatever the provider put in exp: measured from its own
    // issue time when it has one, and always from now (so a missing or backdated iat cannot hide a long life).
    if (typeof c.iat === "number" && c.exp - c.iat > this.maxLifetime) return fail("lifetime_too_long"); // a duration inside the token: no skew, no leeway
    if (c.exp - nowSec > this.maxLifetime + this.leeway) return fail("lifetime_too_long"); // against OUR clock: allow the leeway
    if (typeof c.sub !== "string" || c.sub.length === 0 || c.sub.length > 255) return fail("missing_claim", "sub");

    const email = typeof c.email === "string" && c.email_verified === true && c.email.length <= 320 ? c.email : null;
    const name = typeof c.name === "string" && c.name.trim() ? c.name.trim().slice(0, 200) : null;
    return { issuer: this.o.issuer, subject: c.sub, email, displayName: name };
  }

  private publicKeyFor(jwk: JsonWebKey, alg: JwtAlgorithm) {
    const k = jwk as JsonWebKey & { use?: string; alg?: string; d?: unknown };
    if (k.d !== undefined) return fail("unknown_key", "key set contains private key material"); // never trust a set that leaks one
    if (k.use !== undefined && k.use !== "sig") return fail("unknown_key", "key is not a signing key");
    // key_ops, when a provider states it, must allow verifying (an entry meant for another operation must not be used to verify)
    const ops = (jwk as { key_ops?: unknown }).key_ops;
    if (ops !== undefined && (!Array.isArray(ops) || !ops.includes("verify"))) return fail("unknown_key", "key is not for verification");
    if (k.alg !== undefined && k.alg !== alg) return fail("unknown_key", "key algorithm differs from the token's");
    if (alg === "RS256") {
      if (k.kty !== "RSA" || typeof k.n !== "string" || Buffer.from(k.n, "base64url").length < 256) return fail("unknown_key", "key is not RSA >= 2048 bits");
    } else if (k.kty !== "EC" || k.crv !== "P-256") {
      return fail("unknown_key", "key is not EC P-256");
    }
    try {
      return createPublicKey({ key: jwk as unknown as NodeJwk, format: "jwk" });
    } catch {
      return fail("unknown_key", "key could not be imported");
    }
  }
}
