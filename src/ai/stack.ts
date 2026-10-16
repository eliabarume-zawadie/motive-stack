import { fileURLToPath } from "node:url";
import { loadIntegrationConfig, type IntegrationConfig } from "../integrations/mode.js";
import { AiGateway, type GatewayOptions } from "./gateway.js";
import { AnthropicProvider } from "./anthropicProvider.js";
import { MockAiProvider } from "./mockProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OpenAIProvider } from "./openaiProvider.js";
import { PricingTable } from "./pricing.js";
import { ModelRegistry } from "./registry.js";
import type { AiProvider } from "./types.js";

/**
 * The AI half of the application on its own: providers, model registry, price table and gateway, with no database, no ad-platform
 * connector and no CRM. The web application builds its context on top of this, and the evaluation commands use it directly, so
 * the evaluation path contains nothing that could touch Meta, a CRM or a customer (a test checks the import graph).
 */
export interface AiStackOptions {
  env?: Record<string, string | undefined>;
  /** Replace the provider set (tests). The registry must list their models. */
  providers?: AiProvider[];
  registry?: ModelRegistry;
  pricing?: PricingTable;
  gateway?: GatewayOptions;
  /** Test seam: lets a test drive the real OpenAI SDK against a scripted HTTP layer. Never set in production. */
  fetch?: typeof fetch;
}

export interface AiStack {
  gateway: AiGateway;
  registry: ModelRegistry;
  pricing: PricingTable;
  integrations: IntegrationConfig;
}

const DEFAULT_MODELS = fileURLToPath(new URL("../../config/ai-models.json", import.meta.url));
const DEFAULT_PRICING = fileURLToPath(new URL("../../config/ai-pricing.json", import.meta.url));

export const intEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 ? n : d;
};

/**
 * Per-request OpenAI policy from the environment.
 *   OPENAI_SERVICE_TIER  pins the processing tier ("default" = standard pricing). Unset: the project's own setting decides.
 *   OPENAI_STORE         "false" sends store:false on every Responses request, which asks the API not to keep the response for later retrieval.
 *                        Unset: the provider default applies. Any other value is a configuration error, not a guess.
 */
export function openAiRequestPolicy(env: Record<string, string | undefined>): { serviceTier?: string; store?: boolean } {
  const store = env.OPENAI_STORE;
  if (store !== undefined && store !== "" && store !== "true" && store !== "false") throw new Error('OPENAI_STORE must be "true", "false" or unset');
  return { serviceTier: env.OPENAI_SERVICE_TIER || undefined, store: store === "" || store === undefined ? undefined : store === "true" };
}

export function buildAiStack(o: AiStackOptions = {}): AiStack {
  const env = o.env ?? {};
  const integrations = loadIntegrationConfig(env);
  const registry = o.registry ?? ModelRegistry.fromFile(env.AI_MODELS_FILE ?? DEFAULT_MODELS);
  const pricing = o.pricing ?? PricingTable.fromFile(env.AI_PRICING_FILE ?? DEFAULT_PRICING);

  // Real provider keys are read ONLY when live AI is explicitly enabled. Keys that merely exist in the
  // environment are ignored in mock mode, so a real provider can never be selected by accident.
  const liveKey = (name: string) => (integrations.liveAi ? env[name] : undefined);
  const policy = openAiRequestPolicy(env);
  const providers = o.providers ?? [
    new MockAiProvider(),
    new OpenAIProvider({ apiKey: liveKey("OPENAI_API_KEY"), models: registry.modelsFor("openai"), effortByModel: registry.effortFor("openai"), baseURL: env.OPENAI_BASE_URL, serviceTier: policy.serviceTier, store: policy.store, fetch: o.fetch }),
    new AnthropicProvider({ apiKey: liveKey("ANTHROPIC_API_KEY"), models: registry.modelsFor("anthropic"), effortByModel: registry.effortFor("anthropic"), baseURL: env.ANTHROPIC_BASE_URL }),
    // Local model server on THIS machine. Eligible only in AI_PROVIDER_MODE=local; needs no key; loopback hosts only.
    new OllamaProvider({ models: registry.modelsFor("ollama"), temperatureByModel: registry.temperatureFor("ollama"), enabled: integrations.localAi, baseURL: env.OLLAMA_BASE_URL, timeoutMs: registry.entries.filter((e) => e.provider === "ollama").reduce((m, e) => Math.max(m, e.timeoutMs ?? 0), 0) || undefined }),
  ];

  const repair = intEnv(env.AI_REPAIR_ATTEMPTS, 1) > 0 ? 1 : 0;
  const gateway = new AiGateway(providers, {
    maxRetries: Math.min(intEnv(env.AI_MAX_RETRIES, 2), 5),
    timeoutMs: intEnv(env.AI_TIMEOUT_MS, 60_000) || 60_000,
    repairAttempts: repair,
    pricing,
    ...o.gateway,
  });
  return { gateway, registry, pricing, integrations };
}
