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
 * A misspelt DEPLOYMENT_ENV ("prod", "Production") must stop the process at once, before it opens a database or does anything else: otherwise a typo would leave the production
 * checks switched off until a later step happened to notice. The message names the variable and the allowed values, never the value that was given.
 */
function invalidDeploymentProblem(env: Record<string, string | undefined>): string | null {
  return readDeployment(env).kind === "invalid" ? `DEPLOYMENT_ENV: must be one of ${DEPLOYMENT_ENVS.join(", ")} (a misspelling is refused, never guessed).` : null;
}

/**
 * Settings a PRODUCTION deployment must have, checked at start-up (only when DEPLOYMENT_ENV=production). Each problem names the variable, never a value. A development or test
 * process is never affected. This does not make a deployment production-ready: it stops the most dangerous accident, running the shared local-token mode in front of the public.
 */
export function productionProblems(env: Record<string, string | undefined>): string[] {
  const invalid = invalidDeploymentProblem(env);
  if (invalid) return [invalid];
  if (readDeployment(env).kind !== "set" || deploymentEnv(env) !== "production") return [];
  const problems: string[] = [];
  if ((env.AUTH_MODE ?? "workspace_token") !== "oidc") problems.push("AUTH_MODE: production requires oidc. The local workspace token is a shared, admin-equivalent secret with no accounts and must not face the public.");
  const origins = (env.PUBLIC_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origins.some((o) => o.startsWith("https://"))) problems.push("PUBLIC_ORIGINS: production requires at least one https origin, so the browser boundary matches how the app is served.");
  const hsts = Number((env.HSTS_MAX_AGE_SEC ?? "0").trim() || "0");
  if (!Number.isFinite(hsts) || hsts <= 0) problems.push("HSTS_MAX_AGE_SEC: production requires a value above 0, set once TLS is confirmed.");
  if (!(env.DATABASE_PATH ?? "").trim()) problems.push("DATABASE_PATH: production requires an explicit database path, so the data is never created in a default working directory.");
  problems.push(...liveExecutionProblems(env));
  return problems;
}

/**
 * The standalone background worker (npm run worker, used with WORKER_IN_PROCESS=false) is a second entry point that executes approved jobs, so it needs the same refusal as the
 * web process: in production it will not start with an unset database path or any live or external execution switch. It does not need the sign-in or browser settings, which
 * only the web process uses. Outside production it checks nothing.
 */
export function workerProblems(env: Record<string, string | undefined>): string[] {
  const invalid = invalidDeploymentProblem(env);
  if (invalid) return [invalid];
  if (readDeployment(env).kind !== "set" || deploymentEnv(env) !== "production") return [];
  const problems: string[] = [];
  if (!(env.DATABASE_PATH ?? "").trim()) problems.push("DATABASE_PATH: production requires an explicit database path, so the data is never created in a default working directory.");
  problems.push(...liveExecutionProblems(env));
  return problems;
}

const TRUE_LIKE = /^(true|1|yes|on)$/i;
const isOn = (v: string | undefined) => TRUE_LIKE.test((v ?? "").trim());

/**
 * Production never starts with a switch that lets this application reach the outside world or spend money on its own: live ad-platform writes, a live CRM, billable AI calls,
 * provider keys sent to a non-official host. Simulated and local operation stay available. There is deliberately NO setting that overrides this: enabling live execution in a
 * deployment is a separate, explicit decision that needs a code change and a review, not an environment variable. Each problem names the variable, never its value.
 * (The application has no code that sends e-mail, SMS or publishes content, so there is no flag to refuse for those; a new live flag named LIVE_* or ALLOW_LIVE* set to a
 * true-like value is refused by the catch-all below even before anyone remembers to list it.)
 */
export function liveExecutionProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const refuse = (name: string, why: string) => { if (!seen.has(name)) { seen.add(name); problems.push(`${name}: ${why}`); } };
  const mode = (env.INTEGRATION_MODE ?? "").trim();
  if (mode !== "" && mode !== "mock") refuse("INTEGRATION_MODE", "production must run in mock (simulated) mode. Live ad-platform writes are not enabled for this deployment.");
  const ai = (env.AI_PROVIDER_MODE ?? "").trim();
  if (ai !== "" && ai !== "mock" && ai !== "local") refuse("AI_PROVIDER_MODE", "production allows mock or a local model only. Billable AI-provider calls are not enabled for this deployment.");
  for (const name of ["LIVE_META", "LIVE_GHL", "ALLOW_LIVE_PROVIDER_CALLS", "ALLOW_CUSTOM_PROVIDER_BASE_URL"]) {
    const v = (env[name] ?? "").trim();
    if (v !== "" && v.toLowerCase() !== "false") refuse(name, name === "ALLOW_CUSTOM_PROVIDER_BASE_URL" ? "must be unset or false in production: it would send provider keys to a host other than the official API." : "must be unset or false in production: live external execution is not enabled for this deployment.");
  }
  for (const name of Object.keys(env).sort()) if (/^(LIVE_|ALLOW_LIVE)/.test(name) && isOn(env[name])) refuse(name, "a live-execution switch is turned on. Production refuses every LIVE_* and ALLOW_LIVE* switch.");
  return problems;
}
