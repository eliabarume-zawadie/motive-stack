import type { AiGateway, GatewayOptions } from "../ai/gateway.js";
import type { PricingTable } from "../ai/pricing.js";
import type { ModelRegistry } from "../ai/registry.js";
import { buildAiStack, intEnv } from "../ai/stack.js";
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


export function buildContext(o: BuildOptions): AppContext {
  const env = o.env ?? {};
  const now = o.now ?? (() => new Date());
  const integrations = loadIntegrationConfig(env);
  const faults = { meta: {} as MetaFaults, crm: {} as CrmFaults };

  // The AI half (providers, registry, prices, gateway) is built by the shared stack, which the evaluation commands also use.
  const stack = buildAiStack({ env, providers: o.aiProviders, registry: o.registry, pricing: o.pricing, gateway: o.gateway });
  const { gateway: ai, registry } = stack;

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
