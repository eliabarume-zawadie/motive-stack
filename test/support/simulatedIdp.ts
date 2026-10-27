import { AUDIENCE, ISSUER, NOW_SEC } from "./jwt.js";

/**
 * SIMULATED identity-provider token shapes, for contract tests only.
 *
 * Every profile here is INVENTED to exercise a documented difference between providers (does it send azp? an audience list? iat? string
 * booleans? extra authorization-looking claims?). None reproduces any real provider's output, none is named after one, and a passing
 * test against a profile proves only that THIS server's verifier handles that shape. Real-provider compatibility is verified only by the
 * staging plan in docs/idp-compatibility.md.
 */
export const SIM_AUDIENCE = AUDIENCE;
export const SIM_CLIENT = "sim-spa-client";
export const SIM_OTHER_RESOURCE = "sim-other-resource";

export interface SimProfile {
  id: string;
  /** What real-world difference this shape stands for. */
  note: string;
  payload(sub: string): Record<string, unknown>;
}

const base = (sub: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  sub,
  aud: SIM_AUDIENCE,
  exp: NOW_SEC + 600, // the pilot target: a 10-minute access token
  iat: NOW_SEC - 5,
  ...over,
});

export const SIM_PROFILES: SimProfile[] = [
  { id: "minimal", note: "only the required claims; no azp, no email", payload: (sub) => base(sub) },
  { id: "azp-single", note: "a single audience plus azp naming the calling client", payload: (sub) => base(sub, { azp: SIM_CLIENT }) },
  { id: "multi-audience", note: "an audience list (API plus another resource) with azp", payload: (sub) => base(sub, { aud: [SIM_AUDIENCE, SIM_OTHER_RESOURCE], azp: SIM_CLIENT }) },
  { id: "no-iat", note: "a provider that omits iat", payload: (sub) => { const p = base(sub); delete p.iat; return p; } },
  { id: "with-nbf", note: "a provider that sends nbf", payload: (sub) => base(sub, { nbf: NOW_SEC - 5 }) },
  { id: "verified-email", note: "email with a boolean email_verified", payload: (sub) => base(sub, { email: "pat@example.test", email_verified: true, name: "Pat Example" }) },
  { id: "string-booleans", note: "a provider that sends email_verified as the STRING \"true\"", payload: (sub) => base(sub, { email: "pat@example.test", email_verified: "true" }) },
  {
    id: "authorization-looking-claims",
    note: "claims that look like roles, scopes and groups (they must never grant anything here)",
    payload: (sub) => base(sub, { scope: "openid profile credentials:manage", scp: ["admin"], groups: ["owners"], roles: ["owner"], role: "owner", is_admin: true, "https://sim.example/role": "owner", jti: "sim-jti-1", acr: "1", amr: ["pwd"] }),
  },
];
