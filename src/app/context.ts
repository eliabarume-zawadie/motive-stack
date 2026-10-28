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
import { DEFAULT_ASSET_LIMITS, type AssetLimits } from "./assets.js";
import { MockImageProvider, type ImageProvider } from "../creative/image.js";
import { DEFAULT_CREATIVE_LIMITS, type CreativeLimits } from "./creatives.js";
import { MemoryAssetStore, type AssetStore } from "../storage/assetStore.js";
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
  /** Names (never values) of provider address settings that point somewhere other than the official API host. Empty in normal use. */
  customBaseUrls: string[];
}

/** The only hosts a provider key is sent to unless a development override says otherwise. */
const OFFICIAL_ORIGINS: Record<string, string> = { OPENAI_BASE_URL: "https://api.openai.com", ANTHROPIC_BASE_URL: "https://api.anthropic.com" };

/**
 * A provider API key goes to whatever address the provider is configured with, so an accidental or hostile setting could send it to the wrong place.
 * The address must be the official API host. Any other address needs ALLOW_CUSTOM_PROVIDER_BASE_URL=true (development only, for a stub or proxy you
 * control), must then be https (or http on this machine), and carry no credentials. The error names the setting, never its value.
 */
export function checkProviderBaseUrl(name: string, value: string, allowCustom: boolean): "official" | "custom" {
  let u: URL;
  try { u = new URL(value.trim()); } catch { throw new Error(`${name} is not a valid web address`); }
  if (u.username || u.password) throw new Error(`${name} must not contain a username or password`);
  if (u.origin === OFFICIAL_ORIGINS[name]) return "official";
  if (!allowCustom) {
    throw new Error(`${name} is not the official ${name.startsWith("OPENAI") ? "OpenAI" : "Anthropic"} API address, and the provider key is only ever sent to the official host. Remove the setting. To send the key to another host for DEVELOPMENT ONLY (a stub or proxy you control), also set ALLOW_CUSTOM_PROVIDER_BASE_URL=true.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error(`${name} must use https (plain http is accepted only for this machine)`);
  return "custom";
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
  /** Where asset files live. In memory unless the server passes a folder (see main.ts), so tests never write to disk. */
  assetStore: AssetStore;
  assetLimits: AssetLimits;
  /** The image generator. Only the offline placeholder exists; no live image provider is wired in this release. */
  imageProvider: ImageProvider;
  creativeLimits: CreativeLimits;
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
  assetStore?: AssetStore;
  assetLimits?: Partial<AssetLimits>;
  imageProvider?: ImageProvider;
  creativeLimits?: Partial<CreativeLimits>;
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
  // The standard processing tier is pinned too: left to the account's project setting, a faster tier could silently cost more than the price list says.
  const aiEnv: Record<string, string | undefined> = { ...env, ...(env.OPENAI_STORE === undefined ? { OPENAI_STORE: "false" } : {}), ...(env.OPENAI_SERVICE_TIER === undefined ? { OPENAI_SERVICE_TIER: "default" } : {}) };
  // A blank or placeholder value ("your-key-here") is not a key: the provider is left without one, so no request is ever sent with it.
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const) if (!hasKey(aiEnv[name])) delete aiEnv[name];
  // The provider addresses matter only when a key can be used (live AI). Then each must be official, or explicitly overridden for development.
  const customBaseUrls: string[] = [];
  for (const name of Object.keys(OFFICIAL_ORIGINS)) {
    const v = aiEnv[name];
    if (v === undefined || v.trim() === "") { delete aiEnv[name]; continue; }
    if (!integrations.liveAi) { delete aiEnv[name]; continue; } // mock and local modes never send a key anywhere
    if (checkProviderBaseUrl(name, v, env.ALLOW_CUSTOM_PROVIDER_BASE_URL === "true") === "custom") customBaseUrls.push(name);
  }
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
      customBaseUrls,
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
    assetStore: o.assetStore ?? new MemoryAssetStore(),
    assetLimits: { ...DEFAULT_ASSET_LIMITS, ...(o.assetLimits ?? {}) },
    imageProvider: o.imageProvider ?? new MockImageProvider(),
    creativeLimits: { ...DEFAULT_CREATIVE_LIMITS, ...(o.creativeLimits ?? {}) },
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
