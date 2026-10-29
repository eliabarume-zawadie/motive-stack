/**
 * Which kind of deployment this process is, from the DEPLOYMENT_ENV variable. The ONLY thing that reads it today is the credential
 * key-provider guard (src/credentials/provider.ts); it does not change any other behavior.
 *
 *   development | test   local master keys MAY be used, but only with the explicit opt-in CREDENTIAL_ALLOW_LOCAL_KEYRING=true
 *   production            local master keys are REFUSED, whatever else is set; only an approved managed key provider can enable credential storage
 *   unset or empty        treated as "not known to be development or test": local master keys are refused
 *   anything else         a configuration error that stops startup (a typo must never quietly select a weaker mode)
 *
 * Nothing here reads process.env: callers pass the environment in, so tests are deterministic and need no real configuration.
 */
export const DEPLOYMENT_ENVS = ["development", "test", "production"] as const;
export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number];

export type DeploymentState = { kind: "unset" } | { kind: "set"; env: DeploymentEnv } | { kind: "invalid" };

/** Exact lower-case spelling only (surrounding whitespace is ignored). Nothing is guessed, so "prod" or "Production" are invalid. */
export function readDeployment(env: Record<string, string | undefined>): DeploymentState {
  const raw = env.DEPLOYMENT_ENV?.trim();
  if (raw === undefined || raw === "") return { kind: "unset" };
  return (DEPLOYMENT_ENVS as readonly string[]).includes(raw) ? { kind: "set", env: raw as DeploymentEnv } : { kind: "invalid" };
}

/** The validated value, or null when unset. Throws on an invalid value; the message names the variable and the choices, never the value. */
export function deploymentEnv(env: Record<string, string | undefined>): DeploymentEnv | null {
  const s = readDeployment(env);
  if (s.kind === "invalid") throw new Error(`Invalid configuration (DEPLOYMENT_ENV: must be one of ${DEPLOYMENT_ENVS.join(", ")})`);
  return s.kind === "set" ? s.env : null;
}

/**
 * Settings a PRODUCTION deployment must have, checked at start-up (only when DEPLOYMENT_ENV=production). Each problem names the variable, never a value. A development or test
 * process is never affected. This does not make a deployment production-ready: it stops the most dangerous accident, running the shared local-token mode in front of the public.
 */
export function productionProblems(env: Record<string, string | undefined>): string[] {
  if (readDeployment(env).kind !== "set" || deploymentEnv(env) !== "production") return [];
  const problems: string[] = [];
  if ((env.AUTH_MODE ?? "workspace_token") !== "oidc") problems.push("AUTH_MODE: production requires oidc. The local workspace token is a shared, admin-equivalent secret with no accounts and must not face the public.");
  const origins = (env.PUBLIC_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origins.some((o) => o.startsWith("https://"))) problems.push("PUBLIC_ORIGINS: production requires at least one https origin, so the browser boundary matches how the app is served.");
  const hsts = Number((env.HSTS_MAX_AGE_SEC ?? "0").trim() || "0");
  if (!Number.isFinite(hsts) || hsts <= 0) problems.push("HSTS_MAX_AGE_SEC: production requires a value above 0, set once TLS is confirmed.");
  if (!(env.DATABASE_PATH ?? "").trim()) problems.push("DATABASE_PATH: production requires an explicit database path, so the data is never created in a default working directory.");
  return problems;
}
