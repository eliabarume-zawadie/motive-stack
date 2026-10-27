/** What a verified token proves about a person. Nothing here comes from the client except through a verified signature. */
export interface Identity {
  /** Exact `iss` claim of the verified token. */
  issuer: string;
  /** Exact `sub` claim: the provider's stable id for the person. The only identity key. */
  subject: string;
  /** Only set when the provider marked the address verified. Informational, never an identity key. */
  email: string | null;
  displayName: string | null;
}

export type AuthFailure =
  | "malformed"
  | "unsupported_algorithm"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "missing_claim"
  | "lifetime_too_long"
  | "wrong_token_type"
  | "wrong_client"
  | "keys_unavailable";

/** The reason is for tests and operators. Callers must not echo it to the client. */
export class AuthError extends Error {
  constructor(readonly reason: AuthFailure, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "AuthError";
  }
}

export interface IdentityVerifier {
  /** Resolves only for a token whose signature, issuer, audience and time claims were all verified. */
  verify(token: string): Promise<Identity>;
}

/** Who a request acts as, derived on the server. Never taken from a request body. */
export type Principal =
  | { kind: "workspace_token"; workspaceId: string; label: string }
  | { kind: "user"; userId: string; identity: Identity; label: string };
