import { fileURLToPath } from "node:url";
import { AiGateway, type GatewayOptions } from "../ai/gateway.js";
import { AnthropicProvider } from "../ai/anthropicProvider.js";
import { MockAiProvider } from "../ai/mockProvider.js";
import { OllamaProvider } from "../ai/ollamaProvider.js";
import { OpenAIProvider } from "../ai/openaiProvider.js";
import { PricingTable } from "../ai/pricing.js";
import { ModelRegistry } from "../ai/registry.js";
import type { AiProvider } from "../ai/types.js";
import { loadConfig } from "../config.js";
import type { AdPlatformConnector } from "../connector/AdPlatformConnector.js";
import { GraphClient } from "../connector/meta/graphClient.js";
import { MetaConnector } from "../connector/meta/MetaConnector.js";
import type { Db } from "../db/db.js";
import { MockGhlConnector, type CrmConnector, type CrmFaults } from "../integrations/crm.js";
import { MockMetaConnector, SIM_ACCOUNT_ID, type MetaFaults } from "../integrations/mockMeta.js";
import { loadIntegrationConfig, metaMode, type IntegrationConfig, type IntegrationMode } from "../integrations/mode.js";
import type { Core } from "./core.js";
import { getWorkspace } from "./workspaces.js";

export interface MetaHandle {
  connector: AdPlatformConnector;
  mode: IntegrationMode;
  /** The ad account this workspace is connected to (null in live mode until the owner sets one). */
  accountId: string | null;
}

export interface AppContext extends Core {
  ai: AiGateway;
  registry: ModelRegistry;
  integrations: IntegrationConfig;
  metaFor(workspaceId: string): MetaHandle;
  crmFor(workspaceId: string): CrmConnector;
  /** Mutable failure injection, used by tests only. Has no effect in live mode. */
  faults: { meta: MetaFaults; crm: CrmFaults };
  /** Hard ceiling on output tokens for any single request (AI_MAX_OUTPUT_TOKENS). Callers can ask for less, never more. */
  maxOutputTokens: number;
  maxExecutionAttempts: number;
  jobMaxAttempts: number;
  backoffMs: (attempt: number) => number;
}

export interface BuildOptions {
  db: Db;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** Replace the provider set (tests). The registry must list their models. */
  aiProviders?: AiProvider[];
  registry?: ModelRegistry;
  pricing?: PricingTable;
  gateway?: GatewayOptions;
  backoffMs?: (attempt: number) => number;
}

const DEFAULT_MODELS = fileURLToPath(new URL("../../config/ai-models.json", import.meta.url));
const DEFAULT_PRICING = fileURLToPath(new URL("../../config/ai-pricing.json", import.meta.url));

const intEnv = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 ? n : d;
};

export function buildContext(o: BuildOptions): AppContext {
  const env = o.env ?? {};
  const now = o.now ?? (() => new Date());
  const integrations = loadIntegrationConfig(env);
  const faults = { meta: {} as MetaFaults, crm: {} as CrmFaults };

  const registry = o.registry ?? ModelRegistry.fromFile(env.AI_MODELS_FILE ?? DEFAULT_MODELS);
  const pricing = o.pricing ?? PricingTable.fromFile(env.AI_PRICING_FILE ?? DEFAULT_PRICING);

  // Real provider keys are read ONLY when live AI is explicitly enabled. Keys that merely exist in the
  // environment are ignored in mock mode, so a real provider can never be selected by accident.
  const liveKey = (name: string) => (integrations.liveAi ? env[name] : undefined);
  const providers = o.aiProviders ?? [
    new MockAiProvider(),
    new OpenAIProvider({ apiKey: liveKey("OPENAI_API_KEY"), models: registry.modelsFor("openai"), effortByModel: registry.effortFor("openai"), baseURL: env.OPENAI_BASE_URL }),
    new AnthropicProvider({ apiKey: liveKey("ANTHROPIC_API_KEY"), models: registry.modelsFor("anthropic"), effortByModel: registry.effortFor("anthropic"), baseURL: env.ANTHROPIC_BASE_URL }),
    // Local model server on THIS machine. Eligible only in AI_PROVIDER_MODE=local; needs no key; loopback hosts only.
    new OllamaProvider({ models: registry.modelsFor("ollama"), temperatureByModel: registry.temperatureFor("ollama"), enabled: integrations.localAi, baseURL: env.OLLAMA_BASE_URL, timeoutMs: registry.entries.filter((e) => e.provider === "ollama").reduce((m, e) => Math.max(m, e.timeoutMs ?? 0), 0) || undefined }),
  ];

  const repair = intEnv(env.AI_REPAIR_ATTEMPTS, 1) > 0 ? 1 : 0;
  const ai = new AiGateway(providers, {
    maxRetries: Math.min(intEnv(env.AI_MAX_RETRIES, 2), 5),
    timeoutMs: intEnv(env.AI_TIMEOUT_MS, 60_000) || 60_000,
    repairAttempts: repair,
    pricing,
    ...o.gateway,
  });

  const ctx: AppContext = {
    db: o.db,
    now,
    ai,
    registry,
    integrations,
    faults,
    maxOutputTokens: Math.max(16, intEnv(env.AI_MAX_OUTPUT_TOKENS, 2000)),
    maxExecutionAttempts: 3,
    jobMaxAttempts: 5,
    backoffMs: o.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 30_000)),
    metaFor(workspaceId) {
      if (!integrations.liveMeta) {
        return { connector: new MockMetaConnector(o.db, workspaceId, faults.meta, now), mode: "mock", accountId: SIM_ACCOUNT_ID };
      }
      const ws = getWorkspace(ctx, workspaceId);
      const cfg = loadConfig(env); // requires META_ACCESS_TOKEN; throws a clear error if missing
      const client = new GraphClient({ token: cfg.accessToken, version: cfg.graphVersion, timeoutMs: cfg.timeoutMs });
      return { connector: new MetaConnector(client, { writeAllowlist: cfg.writeAllowlist, now }), mode: "live", accountId: ws.metaAccountId };
    },
    crmFor() {
      // Only the simulated CRM exists. LIVE_GHL is rejected at startup until a real connector is built.
      return new MockGhlConnector(o.db, faults.crm, now);
    },
  };
  return ctx;
}

export const currentMetaMode = (c: AppContext): IntegrationMode => metaMode(c.integrations);
