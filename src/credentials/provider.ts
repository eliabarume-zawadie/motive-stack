import { deploymentEnv, readDeployment } from "../deployment.js";
import { LocalKeyring, type KeyProvider } from "./keys.js";

export type KeySelectionReason = "ok" | "disabled" | "local_keyring_not_allowed" | "production_requires_managed_provider";
export interface KeySelection {
  provider: KeyProvider | null;
  reason: KeySelectionReason;
}

/**
 * THE one place that decides which master-key provider (if any) the credential vault gets. Fails CLOSED: when no acceptable provider
 * exists the vault is simply off, and every credential write answers 503.
 *
 *   production   only a provider that declares itself `managed` can enable credential storage. This codebase has no managed provider
 *                yet (none has been approved or chosen), so in production the vault is OFF. The local keyring is refused whatever else
 *                is set, including CREDENTIAL_ALLOW_LOCAL_KEYRING.
 *   other        the local keyring, from the environment, only with DEPLOYMENT_ENV=development|test AND CREDENTIAL_ALLOW_LOCAL_KEYRING=true.
 *                An unset DEPLOYMENT_ENV does not qualify. An invalid one throws.
 *
 * `injected` is how code (tests, and later a managed provider) supplies a provider: undefined = choose from the environment,
 * null = none. An injected provider that is not managed is refused in production.
 *
 * To add an approved managed key service: implement KeyProvider with `managed = true` and construct it in the production branch below.
 * That is the only change needed; nothing else may select a provider.
 */
export function selectKeyProvider(env: Record<string, string | undefined>, injected?: KeyProvider | null): KeySelection {
  const production = deploymentEnv(env) === "production"; // throws on an invalid value
  if (injected !== undefined) {
    if (injected === null) return { provider: null, reason: "disabled" };
    if (production && injected.managed !== true) return { provider: null, reason: "production_requires_managed_provider" };
    return { provider: injected, reason: "ok" };
  }
  if (production) return { provider: null, reason: "production_requires_managed_provider" };
  const local = LocalKeyring.fromEnv(env);
  if (local) return { provider: local, reason: "ok" };
  return { provider: null, reason: LocalKeyring.ignored(env) ? "local_keyring_not_allowed" : "disabled" };
}

/** What to tell the operator at startup about credential storage. Pure, so it is testable. Never includes a value from the environment. */
export function credentialStartupNotes(env: Record<string, string | undefined>, vaultAvailable: boolean): Array<{ level: "info" | "warn"; text: string }> {
  const notes: Array<{ level: "info" | "warn"; text: string }> = [];
  const state = readDeployment(env);
  const keyringSet = !!env.CREDENTIAL_KEYRING?.trim();
  // Silent on a plain local start (nothing credential-related is configured, so nothing is being refused). The guard itself is unchanged:
  // with DEPLOYMENT_ENV unset, local master keys are still refused; this only decides whether to TELL the operator.
  if (state.kind === "unset" && (keyringSet || env.CREDENTIAL_ALLOW_LOCAL_KEYRING === "true")) {
    notes.push({ level: "warn", text: "DEPLOYMENT_ENV is not set. It must be development, test or production. Until it is development or test, master keys from the environment are refused." });
  }
  if (state.kind === "set" && state.env === "production") {
    notes.push({
      level: vaultAvailable ? "info" : "warn",
      text: vaultAvailable
        ? "DEPLOYMENT_ENV=production: credential storage is ON through an approved managed key provider."
        : "DEPLOYMENT_ENV=production: credential storage is OFF, because no approved managed key provider is configured. Credential writes answer 503. Master keys from the environment are refused in production whatever else is set.",
    });
    if (keyringSet || env.CREDENTIAL_ALLOW_LOCAL_KEYRING === "true") notes.push({ level: "warn", text: "CREDENTIAL_KEYRING / CREDENTIAL_ALLOW_LOCAL_KEYRING are set but ignored in production." });
  } else if (keyringSet && !vaultAvailable) {
    notes.push({
      level: "warn",
      text: "CREDENTIAL_KEYRING is set but ignored. Master keys from the environment need BOTH DEPLOYMENT_ENV=development (or test) AND CREDENTIAL_ALLOW_LOCAL_KEYRING=true. Credential storage stays OFF (see docs/credential-security.md).",
    });
  }
  return notes;
}
