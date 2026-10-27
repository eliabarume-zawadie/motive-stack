import { RemoteJwks, type JwksSource } from "./jwks.js";
import { DEFAULT_ACCESS_TOKEN_TYPES, MAX_ACCESS_TOKEN_LIFETIME_SEC, OidcVerifier, SUPPORTED_ALGORITHMS, normalizeTokenType, type JwtAlgorithm } from "./oidc.js";
import type { Identity, IdentityVerifier } from "./types.js";

/**
 * Authentication mode (AUTH_MODE).
 *   workspace_token  (default) only the existing per-workspace bearer token exists. No identity provider is contacted.
 *   oidc             an OpenID Connect provider's tokens identify people at /api/me. Workspace routes still take workspace
 *                    tokens until Milestone 4.2 adds memberships; a verified user is NOT thereby given any workspace.
 * There is deliberately no mode that trusts an unverified token, and no "test" mode in production code: tests inject keys.
 */
export type AuthConfig =
  | { mode: "workspace_token" }
  | {
      mode: "oidc";
      issuer: string;
      audience: string;
      jwksUri: string;
      /** The browser client's id. Required: an ID token is addressed to it, so the verifier refuses any bearer that names it as an audience. */
      clientId: string;
      algorithms: JwtAlgorithm[];
      /** Accepted values of the access token's `typ` header (normalized). Default: RFC 9068 `at+jwt` only. */
      accessTokenTypes: string[];
      /** Subjects (of the configured issuer) who may be provisioned as users and create workspaces. Empty = nobody: the pilot is closed. */
      allowedSubjects: string[];
      /** Subjects who may claim a legacy workspace. Empty = claiming is disabled. Always a subset of allowedSubjects. */
      claimSubjects: string[];
      maxTokenLifetimeSec: number;
      /** Longest the cached signing keys are trusted after the last successful fetch. */
      jwksMaxAgeSec: number;
      requireAzp: boolean;
    };

export type OidcAuthConfig = Extract<AuthConfig, { mode: "oidc" }>;

/**
 * Who may do what at the person level. Decided from server configuration only: nothing in a token or a request can add to it.
 * The identity has already been verified, so its issuer is the configured one; entries are matched on the subject, never on email.
 */
export interface OnboardingPolicy {
  /** May this person be provisioned as a user and create workspaces? (People who already have a user row keep working through their memberships.) */
  canRegister(identity: Identity): boolean;
  /** May this person claim a workspace that predates memberships, using its legacy token? */
  canClaim(identity: Identity): boolean;
}
const closedPolicy: OnboardingPolicy = { canRegister: () => false, canClaim: () => false };

export interface AuthRuntime {
  mode: "workspace_token" | "oidc";
  verifier: IdentityVerifier | null;
  /** Non-secret values the browser needs to start a sign-in. Never contains a key or a client secret. */
  publicConfig: { mode: "workspace_token" | "oidc"; issuer?: string; audience?: string; clientId?: string | null };
  policy: OnboardingPolicy;
}

const intVar = (env: Record<string, string | undefined>, name: string, def: number, min: number, max: number, problems: string[]): number => {
  const raw = env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    problems.push(`${name}: integer from ${min} to ${max}`);
    return def;
  }
  return n;
};

/** OIDC_ACCESS_TOKEN_TYPES: comma-separated `typ` values. Unset means the RFC 9068 default. A value that names an ID token is contradictory and refused. */
function parseTokenTypes(raw: string | undefined, problems: string[]): string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_ACCESS_TOKEN_TYPES];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const t = normalizeTokenType(part.trim());
    if (t === null || t.includes("id_token") || t.includes("id-token")) {
      problems.push("OIDC_ACCESS_TOKEN_TYPES: use access-token typ values such as at+jwt (never an ID-token type)");
      return [...DEFAULT_ACCESS_TOKEN_TYPES];
    }
    out.add(t);
  }
  return [...out];
}

/** Comma-separated exact subjects. No wildcards, no patterns: opening registration to everyone must never be one character away. */
function subjectList(env: Record<string, string | undefined>, name: string, problems: string[]): string[] {
  const raw = env[name];
  if (!raw || !raw.trim()) return [];
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    if (s.length > 255 || /[\s*?\u0000-\u001f]/.test(s)) {
      problems.push(`${name}: entries must be exact subjects (no spaces, wildcards or control characters)`);
      return [];
    }
    out.add(s);
  }
  if (out.size > 1000) problems.push(`${name}: at most 1000 entries`);
  return [...out];
}

const httpsUrl = (name: string, v: string | undefined, problems: string[]): string => {
  if (!v) {
    problems.push(`${name}: required`);
    return "";
  }
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password) problems.push(`${name}: must be an https URL without credentials`);
  } catch {
    problems.push(`${name}: not a valid URL`);
  }
  return v;
};

/** Error text names variables only, never values. */
export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const mode = env.AUTH_MODE || "workspace_token";
  if (mode === "workspace_token") return { mode };
  if (mode !== "oidc") throw new Error('Invalid configuration (AUTH_MODE: must be "workspace_token" or "oidc")');
  const problems: string[] = [];
  const issuer = httpsUrl("OIDC_ISSUER", env.OIDC_ISSUER, problems);
  const jwksUri = httpsUrl("OIDC_JWKS_URI", env.OIDC_JWKS_URI, problems);
  const audience = (env.OIDC_AUDIENCE ?? "").trim();
  if (!audience) problems.push("OIDC_AUDIENCE: required");
  const algorithms = (env.OIDC_ALGORITHMS ? env.OIDC_ALGORITHMS.split(",").map((x) => x.trim()).filter(Boolean) : [...SUPPORTED_ALGORITHMS]) as JwtAlgorithm[];
  if (algorithms.length === 0 || algorithms.some((a) => !SUPPORTED_ALGORITHMS.includes(a))) problems.push(`OIDC_ALGORITHMS: use ${SUPPORTED_ALGORITHMS.join(", ")}`);
  const clientId = env.OIDC_CLIENT_ID?.trim() || "";
  if (!clientId) problems.push("OIDC_CLIENT_ID: required");
  else if (clientId === audience) problems.push("OIDC_AUDIENCE: must differ from OIDC_CLIENT_ID (an ID token is addressed to the client id)");
  const allowedSubjects = subjectList(env, "OIDC_ALLOWED_SUBJECTS", problems);
  const claimSubjects = subjectList(env, "OIDC_CLAIM_SUBJECTS", problems);
  if (claimSubjects.some((s) => !allowedSubjects.includes(s))) problems.push("OIDC_CLAIM_SUBJECTS: every entry must also be in OIDC_ALLOWED_SUBJECTS");
  // Explicit, not defaulted: the operator states the access-token lifetime the provider is configured for, and it can never exceed the ceiling.
  if (!env.OIDC_MAX_TOKEN_LIFETIME_SEC?.trim()) problems.push(`OIDC_MAX_TOKEN_LIFETIME_SEC: required (60 to ${MAX_ACCESS_TOKEN_LIFETIME_SEC})`);
  const maxTokenLifetimeSec = intVar(env, "OIDC_MAX_TOKEN_LIFETIME_SEC", MAX_ACCESS_TOKEN_LIFETIME_SEC, 60, MAX_ACCESS_TOKEN_LIFETIME_SEC, problems);
  const accessTokenTypes = parseTokenTypes(env.OIDC_ACCESS_TOKEN_TYPES, problems);
  const jwksMaxAgeSec = intVar(env, "OIDC_JWKS_MAX_AGE_SEC", 86_400, 600, 604_800, problems);
  const reqAzp = env.OIDC_REQUIRE_AZP?.trim();
  if (reqAzp && reqAzp !== "true" && reqAzp !== "false") problems.push('OIDC_REQUIRE_AZP: must be "true" or "false"');
  const requireAzp = reqAzp === "true";
  if (requireAzp && !clientId) problems.push("OIDC_REQUIRE_AZP: needs OIDC_CLIENT_ID");
  if (problems.length) throw new Error(`Invalid configuration (${problems.join("; ")})`);
  return { mode: "oidc", issuer, audience, jwksUri, clientId, algorithms, accessTokenTypes, allowedSubjects, claimSubjects, maxTokenLifetimeSec, jwksMaxAgeSec, requireAzp };
}

export const workspaceTokenRuntime: AuthRuntime = { mode: "workspace_token", verifier: null, publicConfig: { mode: "workspace_token" }, policy: closedPolicy };

/**
 * `o.policy` is a code-level override for tests only (like `o.keys`): no environment value can replace the configured lists.
 */
export function buildAuthRuntime(cfg: AuthConfig, o: { keys?: JwksSource; fetch?: typeof fetch; now?: () => number; policy?: OnboardingPolicy } = {}): AuthRuntime {
  if (cfg.mode === "workspace_token") return workspaceTokenRuntime;
  const keys = o.keys ?? new RemoteJwks({ uri: cfg.jwksUri, fetch: o.fetch, maxStaleMs: cfg.jwksMaxAgeSec * 1000, now: o.now });
  const allowed = new Set(cfg.allowedSubjects);
  const claim = new Set(cfg.claimSubjects);
  return {
    mode: "oidc",
    verifier: new OidcVerifier({ issuer: cfg.issuer, audience: cfg.audience, keys, algorithms: cfg.algorithms, accessTokenTypes: cfg.accessTokenTypes, now: o.now, maxLifetimeSec: cfg.maxTokenLifetimeSec, clientId: cfg.clientId, requireAzp: cfg.requireAzp }),
    publicConfig: { mode: "oidc", issuer: cfg.issuer, audience: cfg.audience, clientId: cfg.clientId },
    policy: o.policy ?? {
      canRegister: (i) => i.issuer === cfg.issuer && allowed.has(i.subject),
      canClaim: (i) => i.issuer === cfg.issuer && allowed.has(i.subject) && claim.has(i.subject),
    },
  };
}
