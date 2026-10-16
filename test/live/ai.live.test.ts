import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicProvider } from "../../src/ai/anthropicProvider.js";
import { OpenAIProvider } from "../../src/ai/openaiProvider.js";
import { PricingTable } from "../../src/ai/pricing.js";
import { ModelRegistry } from "../../src/ai/registry.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult } from "../../src/ai/types.js";
import { getAiSettings, listUsage, putAiSettings, runAiTask } from "../../src/app/aiService.js";
import { buildContext } from "../../src/app/context.js";
import { createWorkspace } from "../../src/app/workspaces.js";
import { migrate, openDb } from "../../src/db/db.js";

/**
 * REAL provider verification. Opt-in, one provider per invocation, never part of `npm test`:
 *   npm run live:preflight
 *   npm run test:live:openai      |      npm run test:live:anthropic
 * Requires AI_PROVIDER_MODE=live, ALLOW_LIVE_PROVIDER_CALLS=true and the provider's key (from .env.local or the shell).
 * Sends only a tiny, non-sensitive prompt ("capital of France") with a hard cost budget and output-token cap.
 * No secret is printed, asserted against, or written to the evidence file.
 */
if (process.env.LIVE_TESTS === "1") {
  const f = process.env.LIVE_ENV_FILE ?? ".env.local";
  if (existsSync(f)) loadEnv({ path: f }); // never overrides variables already set in the shell
}
const env = process.env;

type P = "openai" | "anthropic";
const KEY_VAR: Record<P, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const DEFAULT_MODEL: Record<P, string> = { openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" };
/** Several models per provider, to prove the gateway really is multi-model: cheapest first, one tiny request each. */
const MULTI_MODELS: Record<P, string[]> = { openai: ["gpt-6-luna", "gpt-5.5"], anthropic: ["claude-haiku-5-5", "claude-sonnet-5-5"] };

const PROVIDER = env.LIVE_AI_PROVIDER as P | undefined;
const known = PROVIDER === "openai" || PROVIDER === "anthropic";
const MODEL = known ? (env[`${PROVIDER.toUpperCase()}_LIVE_TEST_MODEL`] ?? DEFAULT_MODEL[PROVIDER]) : "";
const BUDGET_MICROS = Number(env.LIVE_TEST_BUDGET_MICROS ?? 50_000); // 0.05 USD
const MAX_OUT = Number(env.LIVE_TEST_MAX_OUTPUT_TOKENS ?? 400);

const optedIn =
  env.LIVE_TESTS === "1" && env.AI_PROVIDER_MODE === "live" && env.ALLOW_LIVE_PROVIDER_CALLS === "true" && known && !!env[KEY_VAR[PROVIDER as P]];
const HINT = "run `npm run live:preflight`, then `npm run test:live:openai` or `npm run test:live:anthropic`";

const REGISTRY_FILE = env.AI_MODELS_FILE ?? "config/ai-models.json";
const PRICING_FILE = env.AI_PRICING_FILE ?? "config/ai-pricing.json";

/* ---------------------------------------------------------------- offline preflight (always runs) */
describe("live verification preflight (offline, runs in the default suite)", () => {
  const registry = ModelRegistry.fromFile(REGISTRY_FILE);
  const pricing = PricingTable.fromFile(PRICING_FILE);
  for (const p of ["openai", "anthropic"] as P[]) {
    const m = DEFAULT_MODEL[p];
    it(`${p}/${m}: in the registry with structured output, the live_probe task and a bounded reasoning effort`, () => {
      const e = registry.find(p, m);
      expect(e?.enabled).toBe(true);
      expect(e?.capabilities.structuredOutput).toBe(true);
      expect(e?.tasks).toContain("live_probe");
      expect(e?.reasoningEffort).toBeTruthy();
    });
    it(`${p}/${m}: has a verified price, so cost-limited live requests are allowed`, () => {
      const price = pricing.entry(p, m);
      expect(price?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(price?.source).toMatch(/^https:\/\//);
    });
  }
  it(".env.local is ignored by git, so keys placed there cannot be committed", () => {
    expect(spawnSync("git", ["check-ignore", "-q", ".env.local"]).status).toBe(0);
  });
  it("the default run cannot go live: the opt-in gate is closed unless every switch is set", () => {
    if (env.LIVE_TESTS !== "1") expect(optedIn).toBe(false);
  });
});

/* -------------------------------------------------------------------------- live (opt-in) */
const Probe = z.object({ city: z.string().min(1), country: z.string().min(1) }).strict();
const PROBE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["city", "country"],
  properties: { city: { type: "string" }, country: { type: "string" } },
} as const;
const probeTask = (schema: z.ZodType<unknown> = Probe) => ({
  taskType: "live_probe", system: "You answer geography questions with one JSON object.",
  prompt: "What is the capital of France? Reply as JSON with the capital city and its country.",
  schemaHint: '{ "city": string, "country": string }', jsonSchema: PROBE_JSON_SCHEMA as unknown as Record<string, unknown>,
  context: {}, schema,
});

const evidence: Record<string, unknown> = {};
let liveRequestsMade = 0;

describe.skipIf(!optedIn)(`LIVE ${PROVIDER ?? "(no provider)"} / ${MODEL}${optedIn ? "" : ` - SKIPPED: ${HINT}`}`, () => {
  // Setup lives in beforeAll: a skipped describe still runs its body at collection time, but never its hooks.
  let db: ReturnType<typeof openDb>;
  let ctx: ReturnType<typeof buildContext>;
  let ws: { id: string };
  const pricing = PricingTable.fromFile(PRICING_FILE);
  beforeAll(() => {
    db = openDb(":memory:");
    migrate(db);
    const baseEnv = {
      AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", [KEY_VAR[PROVIDER as P]]: env[KEY_VAR[PROVIDER as P]],
      AI_MAX_OUTPUT_TOKENS: String(MAX_OUT), AI_MAX_RETRIES: "1", AI_REPAIR_ATTEMPTS: "0", AI_TIMEOUT_MS: "30000",
      OPENAI_BASE_URL: env.OPENAI_BASE_URL, ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL,
    };
    ctx = buildContext({ db, env: baseEnv });
    ws = createWorkspace(ctx, "Live verification").workspace;
    putAiSettings(ctx, ws.id, { routingMode: "manual", provider: PROVIDER, model: MODEL, maxRequestsPerDay: 4, monthlyBudgetMicros: BUDGET_MICROS });
  });
  let ok: Awaited<ReturnType<typeof runAiTask<z.infer<typeof Probe>>>>;

  it("1. one small structured request succeeds and is validated by the application's schema", async () => {
    ok = await runAiTask(ctx, ws.id, probeTask() as never) as never;
    liveRequestsMade++;
    expect(ok).toMatchObject({ status: "ok", simulated: false, provider: PROVIDER, model: MODEL });
    expect(ok.structuredOutput?.city.toLowerCase()).toContain("paris");
    expect(ok.requestId).toBeTruthy();
    expect(ok.latencyMs).toBeGreaterThan(0);
    expect(ok.usage?.source).toBe("provider");
    expect(ok.usage?.inputTokens).toBeGreaterThan(0);
    expect(ok.usage?.outputTokens).toBeGreaterThan(0);
    expect(ok.usage?.outputTokens ?? Infinity).toBeLessThanOrEqual(MAX_OUT); // the output bound held
    expect(ok.costStatus).toBe("estimated");
    expect(ok.estimatedCostMicros ?? Infinity).toBeLessThan(BUDGET_MICROS);
    Object.assign(evidence, {
      provider: PROVIDER, model: MODEL, requestId: ok.requestId, latencyMs: ok.latencyMs, usage: ok.usage,
      estimatedCostMicros: ok.estimatedCostMicros, costStatus: ok.costStatus, status: ok.status, output: ok.structuredOutput,
    });
  });

  it("2. the cost estimate agrees with an independent calculation from the provider-reported usage", () => {
    const price = pricing.entry(PROVIDER as P, MODEL);
    expect(price).toBeDefined();
    const u = ok.usage;
    const long = price?.longContext && (u?.inputTokens ?? 0) > price.longContext.aboveInputTokens;
    const inRate = long ? price?.longContext?.inputPerMTokMicros : price?.inputPerMTokMicros;
    const outRate = long ? price?.longContext?.outputPerMTokMicros : price?.outputPerMTokMicros;
    const independent = Math.round(((u?.inputTokens ?? 0) * (inRate ?? 0) + (u?.outputTokens ?? 0) * (outRate ?? 0)) / 1_000_000);
    expect(ok.estimatedCostMicros).toBe(independent);
    const row = listUsage(ctx, ws.id).find((r) => r.requestId === ok.requestId);
    expect(row).toMatchObject({ mode: "live", simulated: false, inputTokens: ok.usage?.inputTokens, outputTokens: ok.usage?.outputTokens, estimatedCostMicros: independent, costStatus: "estimated" });
    evidence.independentCostMicros = independent;
  });

  it("3. a real response that violates the application's schema is rejected (no repair, nothing returned)", async () => {
    const impossible = Probe.refine(() => false, "forced rejection");
    const err = (await runAiTask(ctx, ws.id, probeTask(impossible) as never).catch((e) => e)) as AiError;
    liveRequestsMade++;
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("invalid_output");
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ outcome: "invalid_output", mode: "live" });
    evidence.invalidOutputRejected = true;
  });

  /** Re-save the current settings with a changed limit (drops the read-only updatedAt). */
  const withLimits = (patch: { maxRequestsPerDay?: number | null; monthlyBudgetMicros?: number | null }) => {
    const { updatedAt: _ignored, ...current } = getAiSettings(ctx, ws.id);
    putAiSettings(ctx, ws.id, { ...current, ...patch });
  };

  it("4. the per-test limits are enforced BEFORE a request is sent", async () => {
    const before = listUsage(ctx, ws.id).filter((r) => r.attemptKind !== "blocked").length;
    // daily request limit
    withLimits({ maxRequestsPerDay: before });
    await expect(runAiTask(ctx, ws.id, probeTask() as never)).rejects.toMatchObject({ kind: "budget_exhausted" });
    // monthly cost ceiling already below what was spent
    withLimits({ maxRequestsPerDay: 50, monthlyBudgetMicros: 1 });
    await expect(runAiTask(ctx, ws.id, probeTask() as never)).rejects.toMatchObject({ kind: "budget_exhausted" });
    const rows = listUsage(ctx, ws.id);
    expect(rows.filter((r) => r.attemptKind !== "blocked").length).toBe(before); // no new provider request was made
    expect(rows.filter((r) => r.attemptKind === "blocked").length).toBe(2);
    evidence.limitsEnforcedBeforeRequest = true;
  });

  it("4b. several models of this provider work through the same gateway, each priced from its own entry", async () => {
    const models = (env.LIVE_MULTI_MODELS ? env.LIVE_MULTI_MODELS.split(",").map((m) => m.trim()) : MULTI_MODELS[PROVIDER as P]).filter(Boolean);
    withLimits({ maxRequestsPerDay: 50, monthlyBudgetMicros: BUDGET_MICROS * 4 }); // test 4 left the limits closed on purpose
    const seen: Array<Record<string, unknown>> = [];
    for (const model of models) {
      const r = await runAiTask(ctx, ws.id, { ...probeTask(), override: { providerId: PROVIDER as string, model } } as never) as unknown as typeof ok;
      liveRequestsMade++;
      expect(r).toMatchObject({ status: "ok", simulated: false, provider: PROVIDER, model });
      expect(r.structuredOutput?.city.toLowerCase()).toContain("paris");
      expect(r.usage?.outputTokens ?? Infinity).toBeLessThanOrEqual(MAX_OUT);
      const price = pricing.entry(PROVIDER as P, model);
      expect(price, `a verified price must exist for ${model}`).toBeDefined();
      expect(r.costStatus).toBe("estimated");
      seen.push({ model, requestId: r.requestId, latencyMs: r.latencyMs, usage: r.usage, estimatedCostMicros: r.estimatedCostMicros });
    }
    expect(new Set(seen.map((s) => s.model)).size).toBe(models.length);
    // the usage log attributes each request to the model that actually served it
    const served = new Set(listUsage(ctx, ws.id).filter((u) => u.outcome === "ok" && u.taskType === "live_probe").map((u) => u.model));
    for (const m of models) expect(served.has(m)).toBe(true);
    evidence.multiModel = seen;
  });

  it("5. an authentication failure is reported as auth and does NOT fall back to another provider", async () => {
    // Real provider with a deliberately invalid key (a free 401), plus a fallback that must never be called.
    const registry = ModelRegistry.fromFile(REGISTRY_FILE);
    class MustNotBeCalled implements AiProvider {
      readonly id = "fallback-sentinel"; readonly label = "sentinel"; readonly models = ["s1"] as const; readonly simulated = false; calls = 0;
      isAvailable() { return true; }
      async generateObject<T>(_r: GenerateObjectRequest<T>): Promise<ProviderResult> { this.calls++; throw new Error("unauthorized fallback"); }
      async generateText(_r: GenerateTextRequest): Promise<ProviderResult> { this.calls++; throw new Error("unauthorized fallback"); }
    }
    const sentinel = new MustNotBeCalled();
    const effort = registry.effortFor(PROVIDER as P);
    const badKey = "invalid-key-for-verification";
    const real: AiProvider = PROVIDER === "openai"
      ? new OpenAIProvider({ apiKey: badKey, models: registry.modelsFor("openai"), effortByModel: effort, timeoutMs: 20_000, baseURL: env.OPENAI_BASE_URL })
      : new AnthropicProvider({ apiKey: badKey, models: registry.modelsFor("anthropic"), effortByModel: effort, timeoutMs: 20_000, baseURL: env.ANTHROPIC_BASE_URL });
    const reg2 = new ModelRegistry([...registry.entries, { provider: "fallback-sentinel", model: "s1", label: "s", enabled: true, tasks: ["live_probe"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
    const db2 = openDb(":memory:");
    migrate(db2);
    const ctx2 = buildContext({ db: db2, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_MAX_RETRIES: "1" }, aiProviders: [real, sentinel], registry: reg2 });
    const ws2 = createWorkspace(ctx2, "Auth probe").workspace;
    putAiSettings(ctx2, ws2.id, { routingMode: "preferred_with_fallback", provider: PROVIDER, model: MODEL, fallbackProvider: "fallback-sentinel", fallbackModel: "s1" });
    const err = (await runAiTask(ctx2, ws2.id, probeTask() as never).catch((e) => e)) as AiError;
    expect(err).toBeInstanceOf(AiError);
    expect(err.kind).toBe("auth");
    expect(sentinel.calls).toBe(0);
    expect(err.message).not.toContain(badKey);
    expect(listUsage(ctx2, ws2.id).map((r) => r.provider)).toEqual([PROVIDER]); // only the real provider was attempted
    evidence.authFailureNoFallback = true;
    db2.close();
  });

  afterAll(() => {
    if (!optedIn) return;
    const overridden = !!(env.OPENAI_BASE_URL || env.ANTHROPIC_BASE_URL); // a proxy/stub, not the provider's own endpoint
    const dir = overridden ? (process.env.TEMP ?? process.env.TMPDIR ?? "/tmp") : "docs/live-verification";
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `${dir}/${overridden ? "DRYRUN-NOT-EVIDENCE-" : ""}${PROVIDER}-${stamp}.json`;
    // Evidence only: no keys, no prompts beyond the fixed probe, no raw responses.
    writeFileSync(file, JSON.stringify({ verifiedAgainstRealProvider: !overridden, verifiedAt: new Date().toISOString(), liveBillableRequests: liveRequestsMade, budgetMicros: BUDGET_MICROS, maxOutputTokens: MAX_OUT, ...evidence }, null, 2) + "\n");
    console.log(`Live verification evidence written to ${file}`);
    db?.close();
  });
});

describe("live gate (always runs)", () => {
  it(optedIn ? "live AI tests are ENABLED for this run" : `live AI tests are DISABLED for this run - ${HINT}`, () => {
    expect(typeof optedIn).toBe("boolean");
  });
});
