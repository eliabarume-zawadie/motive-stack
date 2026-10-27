import type { AiGateway, GatewayOptions } from "../ai/gateway.js";
import type { PricingTable } from "../ai/pricing.js";
import type { ModelRegistry } from "../ai/registry.js";
import { buildAiStack, intEnv, openAiRequestPolicy } from "../ai/stack.js";
import type { AiProvider } from "../ai/types.js";
import { loadConfig } from "../config.js";
import type { AdPlatformConnector } from "../connector/AdPlatformConnector.js";
import { WorkspaceScopedConnector } from "../connector/WorkspaceScopedConnector.js";
import type { KeyProvider } from "../credentials/keys.js";
import { selectKeyProvider } from "../credentials/provider.js";
import { CredentialVault } from "../credentials/vault.js";
import { GraphClient } from "../connector/meta/graphClient.js";
import { MetaConnector } from "../connector/meta/MetaConnector.js";
import type { Db } from "../db/db.js";
import { MockGhlConnector, type CrmConnector, type CrmFaults } from "../integrations/crm.js";
import { MockMetaConnector, SIM_ACCOUNT_ID, type MetaFaults } from "../integrations/mockMeta.js";
import { loadIntegrationConfig, metaMode, type IntegrationConfig, type IntegrationMode } from "../integrations/mode.js";
import type { Core } from "./core.js";
import { DEFAULT_CRAWL, type CrawlConfig } from "../web/crawler.js";
import type { FetchDeps } from "../web/safeFetch.js";
import { authorizedAccountIds, isMetaAccountAuthorized } from "./metaAccounts.js";
import { getWorkspace } from "./workspaces.js";

export interface MetaHandle {
  connector: AdPlatformConnector;
  mode: IntegrationMode;
  /**
   * The ad account this workspace may use RIGHT NOW. In live mode it is the workspace's chosen account only if that account is
   * currently authorized for this workspace; otherwise null, so everything that needs an account fails closed.
   */
  accountId: string | null;
  /** What the workspace setting says, authorized or not (for display and precise error messages). Never use it to act. */
  configuredAccountId: string | null;
}

/**
 * Server-side policy for paid (live) AI calls. Everything here comes from the server's environment and cannot be changed from the browser.
 * It holds booleans and numbers only: the key itself is never copied out of the environment.
 */
export interface AiPolicy {
  /** The most the server will let live AI requests cost in one UTC month, all workspaces together, in micro-units of the price list's currency. null = not configured, which blocks every live request. */
  liveBudgetMicros: number | null;
  /** Hard cap on live requests per UTC day across all workspaces. null = none. */
  liveMaxRequestsPerDay: number | null;
  /** How many provider attempts one request can make at most (first try, retries, one repair). Spend is reserved for all of them before the first is sent. */
  attemptsPerRequest: number;
  /** Whether a key is present in the server's environment. The value is never read into this object. */
  keyPresent: { openai: boolean; anthropic: boolean };
  /** True when requests ask OpenAI not to store the response (store:false). */
  openaiStore: boolean | null;
}

export interface WebConfig {
  crawl: CrawlConfig;
  maxAnalysesPerDay: number;
  /** TEST SEAM: replaces name resolution / connection for website reads. Never set from the environment. */
  fetchDeps?: FetchDeps;
}

export interface AppContext extends Core {
  ai: AiGateway;
  pricing: PricingTable;
  aiPolicy: AiPolicy;
  web: WebConfig;
  registry: ModelRegistry;
  integrations: IntegrationConfig;
  metaFor(workspaceId: string): MetaHandle;
  /** Encrypted per-workspace credential storage. Inert until a key provider is configured; nothing in the application consumes it yet. */
  credentials: CredentialVault;
  /** The operator's global write allow-list (empty unless Meta is live). It restricts every workspace; it never authorizes one. */
  metaWriteAllowlist(): readonly string[];
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
  /** Master-key provider for the credential vault. Undefined: load the key ring from env (see credentials/keys.ts). Null: none (storage off). */
  keyProvider?: KeyProvider | null;
  /** Replace the platform connector behind the workspace guard (tests). The guard and the authorization checks stay in place. */
  metaConnector?: (workspaceId: string) => AdPlatformConnector;
  /** TEST SEAM: lets a test drive the real OpenAI SDK against a scripted HTTP layer. Never set in production. */
  aiFetch?: typeof fetch;
  /** Test seam for the website reader (see WebConfig.fetchDeps). */
  webFetchDeps?: FetchDeps;
  webCrawl?: Partial<CrawlConfig>;
}

const positiveInt = (env: Record<string, string | undefined>, name: string): number | null => {
  const v = env[name];
  if (v === undefined || v.trim() === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number`);
  return n;
};
const hasKey = (v: string | undefined): boolean => !!v && v.trim().length > 8 && !/^(sk-)?(x+|your|changeme|placeholder|\.\.\.)/i.test(v.trim());


export function buildContext(o: BuildOptions): AppContext {
  const env = o.env ?? {};
  const now = o.now ?? (() => new Date());
  const integrations = loadIntegrationConfig(env);
  const faults = { meta: {} as MetaFaults, crm: {} as CrmFaults };
  const knownCampaigns = new Map<string, Map<string, string>>(); // workspace -> (campaign id -> account), for the workspace guard

  // The AI half (providers, registry, prices, gateway) is built by the shared stack, which the evaluation commands also use.
  // OpenAI responses are not stored unless the operator says otherwise (OPENAI_STORE); this is the application's default, not a retention guarantee.
  const aiEnv = env.OPENAI_STORE === undefined ? { ...env, OPENAI_STORE: "false" } : env;
  const stack = buildAiStack({ env: aiEnv, providers: o.aiProviders, registry: o.registry, pricing: o.pricing, gateway: o.gateway, fetch: o.aiFetch });
  const { gateway: ai, registry } = stack;

  const ctx: AppContext = {
    db: o.db,
    now,
    ai,
    pricing: stack.pricing,
    aiPolicy: {
      liveBudgetMicros: positiveInt(env, "AI_LIVE_BUDGET_MICROS"),
      liveMaxRequestsPerDay: positiveInt(env, "AI_LIVE_MAX_REQUESTS_PER_DAY"),
      attemptsPerRequest: 1 + Math.min(intEnv(env.AI_MAX_RETRIES, 2), 5) + (intEnv(env.AI_REPAIR_ATTEMPTS, 1) > 0 ? 1 : 0),
      keyPresent: { openai: hasKey(env.OPENAI_API_KEY), anthropic: hasKey(env.ANTHROPIC_API_KEY) },
      openaiStore: openAiRequestPolicy(aiEnv).store ?? null,
    },
    web: {
      crawl: { ...DEFAULT_CRAWL, maxPages: Math.min(Math.max(intEnv(env.WEBSITE_MAX_PAGES, DEFAULT_CRAWL.maxPages), 1), 10), ...o.webCrawl },
      maxAnalysesPerDay: Math.max(1, intEnv(env.WEBSITE_MAX_ANALYSES_PER_DAY, 10)),
      fetchDeps: o.webFetchDeps,
    },
    registry,
    integrations,
    faults,
    maxOutputTokens: Math.max(16, intEnv(env.AI_MAX_OUTPUT_TOKENS, 2000)),
    maxExecutionAttempts: 3,
    jobMaxAttempts: 5,
    backoffMs: o.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 30_000)),
    // The ONE place a key provider is chosen (fails closed; production accepts only an approved managed provider). Throws on an invalid DEPLOYMENT_ENV.
    credentials: new CredentialVault({ db: o.db, now }, selectKeyProvider(env, o.keyProvider).provider),
    metaWriteAllowlist() {
      return integrations.liveMeta ? loadConfig(env).writeAllowlist : [];
    },
    metaFor(workspaceId) {
      if (!integrations.liveMeta) {
        return { connector: new MockMetaConnector(o.db, workspaceId, faults.meta, now), mode: "mock", accountId: SIM_ACCOUNT_ID, configuredAccountId: SIM_ACCOUNT_ID };
      }
      const ws = getWorkspace(ctx, workspaceId);
      const cfg = loadConfig(env); // requires META_ACCESS_TOKEN; throws a clear error if missing
      const inner =
        o.metaConnector?.(workspaceId) ??
        new MetaConnector(new GraphClient({ token: cfg.accessToken, version: cfg.graphVersion, timeoutMs: cfg.timeoutMs }), { writeAllowlist: cfg.writeAllowlist, now });
      let known = knownCampaigns.get(workspaceId);
      if (!known) knownCampaigns.set(workspaceId, (known = new Map()));
      // The shared token can see every customer's accounts, so the workspace boundary is enforced HERE, on every call.
      const connector = new WorkspaceScopedConnector(inner, {
        workspaceId,
        writeAllowlist: cfg.writeAllowlist,
        isAuthorized: (a) => isMetaAccountAuthorized(ctx, workspaceId, a),
        authorizedAccountIds: () => authorizedAccountIds(ctx, workspaceId),
        knownCampaigns: known,
      });
      const configured = ws.metaAccountId;
      return { connector, mode: "live", accountId: configured && isMetaAccountAuthorized(ctx, workspaceId, configured) ? configured : null, configuredAccountId: configured };
    },
    crmFor() {
      // Only the simulated CRM exists. LIVE_GHL is rejected at startup until a real connector is built.
      return new MockGhlConnector(o.db, faults.crm, now);
    },
  };
  return ctx;
}

export const currentMetaMode = (c: AppContext): IntegrationMode => metaMode(c.integrations);
