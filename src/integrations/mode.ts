export type IntegrationMode = "mock" | "live";
export type AiMode = "mock" | "local" | "live";

export interface IntegrationConfig {
  /** Meta / CRM mode. Default "mock". Live is NEVER implied by the presence of credentials. */
  mode: IntegrationMode;
  liveMeta: boolean;
  liveGhl: boolean;
  /**
   * AI provider mode (AI_PROVIDER_MODE). Default "mock".
   *   mock  - deterministic simulated model only
   *   local - a model server on THIS machine only (Ollama): real output, no key, no billing, no data leaves the machine
   *   live  - paid remote providers (OpenAI, Anthropic) only
   * Modes never mix: each mode makes exactly one kind of provider eligible.
   */
  aiMode: AiMode;
  /** ALLOW_LIVE_PROVIDER_CALLS. A second, separate switch: live AI needs BOTH this and aiMode=live. */
  allowLiveProviderCalls: boolean;
  /** True only when paid remote providers may be called: aiMode === "live" AND allowLiveProviderCalls. */
  liveAi: boolean;
  /** True when aiMode === "local". */
  localAi: boolean;
}

export function loadIntegrationConfig(env: Record<string, string | undefined>): IntegrationConfig {
  const raw = env.INTEGRATION_MODE ?? "mock";
  if (raw !== "mock" && raw !== "live") throw new Error('INTEGRATION_MODE must be "mock" or "live"');
  const live = raw === "live";
  const flag = (n: string) => live && env[n] === "true";

  const aiRaw = env.AI_PROVIDER_MODE ?? "mock";
  if (aiRaw !== "mock" && aiRaw !== "live" && aiRaw !== "local") throw new Error('AI_PROVIDER_MODE must be "mock", "local" or "live"');
  const allow = env.ALLOW_LIVE_PROVIDER_CALLS === "true";
  if (aiRaw === "live" && !allow) {
    throw new Error("AI_PROVIDER_MODE=live also requires ALLOW_LIVE_PROVIDER_CALLS=true (explicit opt-in to billable provider calls)");
  }

  const cfg: IntegrationConfig = {
    mode: raw,
    liveMeta: flag("LIVE_META"),
    liveGhl: flag("LIVE_GHL"),
    aiMode: aiRaw,
    allowLiveProviderCalls: allow,
    liveAi: aiRaw === "live" && allow,
    localAi: aiRaw === "local",
  };
  if (cfg.liveGhl) throw new Error("LIVE_GHL=true is not supported yet: the GoHighLevel connector is simulated only");
  return cfg;
}

export const metaMode = (c: IntegrationConfig): IntegrationMode => (c.liveMeta ? "live" : "mock");
