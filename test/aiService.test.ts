import { describe, expect, it } from "vitest";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { PricingTable } from "../src/ai/pricing.js";
import { ModelRegistry, type ModelEntry } from "../src/ai/registry.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult } from "../src/ai/types.js";
import { connectionTest, getAiSettings, listModels, listUsage, putAiSettings, runAiTask, usageSummary } from "../src/app/aiService.js";
import { generateCampaign, listCampaigns } from "../src/app/campaigns.js";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { CampaignBriefSchema } from "../src/domain/schemas.js";
import { BRIEF_OK } from "./briefFixture.js";
import { BRAIN, makeCore } from "./fixtures.js";

/** A non-simulated provider whose behavior is scripted. Stands in for OpenAI/Anthropic with NO network. */
class Fake implements AiProvider {
  readonly label: string;
  readonly simulated = false;
  calls = 0;
  lastMaxTokens: number | undefined;
  constructor(readonly id: string, readonly models: readonly string[], private steps: Array<ProviderResult | AiError | "ok">, private available = true) { this.label = id; }
  isAvailable() { return this.available; }
  private next(model: string): ProviderResult {
    this.calls++;
    const s = this.steps.length ? this.steps.shift() : "ok";
    if (s instanceof AiError) throw s;
    if (s && s !== "ok") return s;
    return { raw: BRIEF_OK, text: "pong", model, simulated: false, usage: { inputTokens: 1000, outputTokens: 500, source: "provider" }, requestId: `${this.id}-req` };
  }
  async generateObject<T>(r: GenerateObjectRequest<T>) { this.lastMaxTokens = r.maxOutputTokens; return this.next(r.model); }
  async generateText(r: GenerateTextRequest) { this.lastMaxTokens = r.maxOutputTokens; return this.next(r.model); }
}

const entry = (provider: string, model: string, costTier: ModelEntry["costTier"] = "medium"): ModelEntry => ({
  provider, model, label: `${provider}/${model}`, enabled: true, tasks: ["campaign_brief", "connection_test"],
  capabilities: { text: true, structuredOutput: true }, costTier,
});
const PRICE = { inputPerMTokMicros: 3_000_000, outputPerMTokMicros: 15_000_000, appliesTo: "test fixture", asOf: "2026-01-01", source: "https://example.com/pricing" };
const rl = () => new AiError("rate_limit", "rl", { retryable: true });

// Live requests now need the server's own spending ceiling (AI_LIVE_BUDGET_MICROS) and a price for the model. These fixtures set a large ceiling
// and price every fake model, so the tests below keep exercising the behavior they were written for; the ceiling itself is tested in liveCeiling.test.ts.
const LIVE_ENV = { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "1000000000000" };

function liveApp(providers: AiProvider[], opts: { priced?: string[]; start?: string } = {}) {
  const core = makeCore(opts.start);
  const registry = new ModelRegistry(providers.flatMap((p) => p.models.map((m) => entry(p.id, m))));
  const pricing = new PricingTable("USD", (opts.priced ?? providers.map((p) => p.id)).map((id) => ({ provider: id, model: "m", ...PRICE })));
  const ctx = buildContext({ db: core.db, now: core.now, env: LIVE_ENV, aiProviders: providers, registry, pricing, gateway: { sleep: async () => {} } });
  const ws = createWorkspace(ctx, "Acme").workspace;
  putBrain(ctx, ws.id, BRAIN);
  return { ctx, ws, core };
}

function mockApp() {
  const core = makeCore();
  const ctx = buildContext({ db: core.db, now: core.now, env: {}, gateway: { sleep: async () => {} } });
  const ws = createWorkspace(ctx, "Acme").workspace;
  putBrain(ctx, ws.id, BRAIN);
  return { ctx, ws };
}

const TASK = (c: AppContext, over: object = {}) => ({
  taskType: "campaign_brief", system: "s", prompt: "SECRET-BUSINESS-PROMPT", schemaHint: "{}", context: BRAIN, schema: CampaignBriefSchema, ...over,
});
const run = (c: AppContext, ws: string, over: object = {}) => runAiTask(c, ws, TASK(c, over));

describe("workspace AI settings", () => {
  it("default to automatic routing with no limits, and persist what is saved", () => {
    const { ctx, ws } = mockApp();
    expect(getAiSettings(ctx, ws.id)).toMatchObject({ routingMode: "automatic", allowedProviders: null, maxRequestsPerDay: null, updatedAt: null });
    const saved = putAiSettings(ctx, ws.id, { routingMode: "manual", provider: "mock", model: "mock-deterministic-1", maxRequestsPerDay: 5 });
    expect(saved).toMatchObject({ routingMode: "manual", provider: "mock", model: "mock-deterministic-1", maxRequestsPerDay: 5 });
    expect(getAiSettings(ctx, ws.id)).toEqual(saved);
  });

  it.each([
    ["an unknown model", { routingMode: "manual", provider: "mock", model: "nope" }, /not in the registry/],
    ["manual without a model", { routingMode: "manual" }, /needs a provider and model/],
    ["a fallback equal to the preferred model", { routingMode: "preferred_with_fallback", provider: "anthropic", model: "claude-haiku-5-5", fallbackProvider: "anthropic", fallbackModel: "claude-haiku-5-5" }, /must differ/],
    ["a provider outside the data-policy allow-list", { routingMode: "manual", provider: "anthropic", model: "claude-haiku-5-5", allowedProviders: ["openai"] }, /allow-list/],
    ["a fallback outside the allow-list", { routingMode: "preferred_with_fallback", provider: "anthropic", model: "claude-haiku-5-5", fallbackProvider: "openai", fallbackModel: "gpt-5.5", allowedProviders: ["anthropic"] }, /allow-list/],
    ["an unknown provider in the allow-list", { routingMode: "automatic", allowedProviders: ["nobody"] }, /Unknown provider/],
  ])("rejects %s", (_l, input, msg) => {
    const { ctx, ws } = mockApp();
    expect(() => putAiSettings(ctx, ws.id, input)).toThrow(msg);
    expect(getAiSettings(ctx, ws.id).updatedAt).toBeNull(); // nothing saved
  });

  it("rejects unknown fields and non-positive limits", () => {
    const { ctx, ws } = mockApp();
    expect(() => putAiSettings(ctx, ws.id, { routingMode: "automatic", extra: 1 })).toThrow();
    expect(() => putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 0 })).toThrow();
  });

  it("are isolated per workspace", () => {
    const { ctx, ws } = mockApp();
    const other = createWorkspace(ctx, "Other").workspace;
    putAiSettings(ctx, ws.id, { routingMode: "manual", provider: "mock", model: "mock-deterministic-1" });
    expect(getAiSettings(ctx, other.id).routingMode).toBe("automatic");
  });

  it("listModels explains why a real model is unusable in mock mode", () => {
    const { ctx, ws } = mockApp();
    const m = listModels(ctx, ws.id);
    expect(m.find((x) => x.provider === "mock")).toMatchObject({ eligible: true, reason: null, simulated: true });
    expect(m.find((x) => x.provider === "anthropic")).toMatchObject({ eligible: false, reason: expect.stringMatching(/disabled in mock mode/) });
  });
});

describe("mock mode usage records", () => {
  it("records a simulated attempt with unknown cost, and stores no prompt or business data", async () => {
    const { ctx, ws } = mockApp();
    const r = await run(ctx, ws.id);
    expect(r).toMatchObject({ provider: "mock", simulated: true, costStatus: "not_applicable", route: { mode: "automatic", usedFallback: false } });
    const rows = listUsage(ctx, ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: "mock", simulated: true, outcome: "ok", costStatus: "not_applicable", estimatedCostMicros: null, usageSource: "simulated", taskType: "campaign_brief" });
    expect(rows[0]?.requestId).toMatch(/^mock-/);
    const dump = JSON.stringify(ctx.db.prepare("SELECT * FROM ai_usage").all());
    expect(dump).not.toContain("SECRET-BUSINESS-PROMPT");
    expect(dump).not.toContain(BRAIN.businessName);
  });

  it("mock requests are never billable: limits do not block them", async () => {
    const { ctx, ws } = mockApp();
    putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 1, monthlyBudgetMicros: 1 });
    for (let i = 0; i < 3; i++) await run(ctx, ws.id);
    expect(usageSummary(ctx, ws.id).today).toMatchObject({ liveRequests: 0, simulatedRequests: 3 });
  });
});

describe("live-mode usage and cost (fake providers, no network)", () => {
  it("records provider-reported usage and an estimated cost when a price is configured", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a], { priced: ["fa"] });
    const r = await run(ctx, ws.id);
    expect(r).toMatchObject({ simulated: false, costStatus: "estimated", estimatedCostMicros: 3000 + 7500 });
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ mode: "live", simulated: false, inputTokens: 1000, outputTokens: 500, usageSource: "provider", estimatedCostMicros: 10500, costStatus: "estimated", currency: "USD", requestId: "fa-req" });
  });

  it("a model with no configured price is refused before any live request (its cost cannot be limited), and the refusal is recorded as blocked", async () => {
    // Previously such a request went through and was recorded with an unknown cost. With the server's mandatory spending ceiling it cannot be bounded, so it is not sent.
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a], { priced: [] });
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_unverifiable" });
    expect(a.calls).toBe(0);
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ attemptKind: "blocked", outcome: "budget_unverifiable" });
  });

  it("records unknown token usage as NULL, not zero", async () => {
    const noUsage: ProviderResult = { raw: BRIEF_OK, model: "m", simulated: false };
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [noUsage])], { priced: ["fa"] });
    await run(ctx, ws.id);
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ inputTokens: null, outputTokens: null, usageSource: null, costStatus: "unknown_no_usage" });
  });

  it("records every retry and repair as its own attempt", async () => {
    const bad: ProviderResult = { raw: { name: 1 }, model: "m", simulated: false, usage: { inputTokens: 10, outputTokens: 5, source: "provider" } };
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [rl(), bad, "ok"])]);
    await run(ctx, ws.id);
    expect(listUsage(ctx, ws.id).reverse().map((r) => `${r.attemptKind}:${r.outcome}`)).toEqual(["initial:rate_limit", "retry:invalid_output", "repair:ok"]);
  });
});

describe("fallback rules", () => {
  const pref = (extra: object = {}) => ({ routingMode: "preferred_with_fallback", provider: "fa", model: "m", fallbackProvider: "fb", fallbackModel: "m", ...extra });

  it("falls back after rate limiting is exhausted, and records the fallback", async () => {
    const a = new Fake("fa", ["m"], [rl(), rl(), rl()]);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, pref());
    const r = await run(ctx, ws.id);
    expect(r).toMatchObject({ provider: "fb", route: { mode: "preferred_with_fallback", usedFallback: true, fallbackFrom: "fa/m" } });
    const rows = listUsage(ctx, ws.id).reverse();
    expect(rows.map((x) => `${x.provider}:${x.attemptKind}:${x.outcome}`)).toEqual(["fa:initial:rate_limit", "fa:retry:rate_limit", "fa:retry:rate_limit", "fb:fallback:ok"]);
    expect(rows[3]?.fallbackFrom).toBe("fa/m");
    expect(new Set(rows.map((x) => x.taskId)).size).toBe(1);
  });

  it.each([["timeout"], ["provider_unavailable"]] as const)("falls back on %s", async (kind) => {
    const a = new Fake("fa", ["m"], [new AiError(kind, "x"), new AiError(kind, "x")]);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, pref());
    expect((await run(ctx, ws.id)).provider).toBe("fb");
  });

  it.each([["auth"], ["insufficient_balance"], ["invalid_request"], ["invalid_output"]] as const)("NEVER falls back on %s", async (kind) => {
    const a = new Fake("fa", ["m"], [new AiError(kind, "x"), new AiError(kind, "x")]);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, pref());
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind });
    expect(b.calls).toBe(0);
  });

  it("never routes to a fallback the workspace data policy forbids", async () => {
    const a = new Fake("fa", ["m"], [rl(), rl(), rl()]);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    // Saving such a combination is rejected outright (see "rejects a fallback outside the allow-list").
    // Defense in depth: even if the policy is tightened AFTER the fallback was saved, routing still refuses it.
    putAiSettings(ctx, ws.id, pref());
    ctx.db.prepare("UPDATE ai_settings SET allowed_providers = ? WHERE workspace_id = ?").run(JSON.stringify(["fa"]), ws.id);
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(b.calls).toBe(0);
  });

  it("a manual selection has no fallback", async () => {
    const a = new Fake("fa", ["m"], [rl(), rl(), rl()]);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, { routingMode: "manual", provider: "fa", model: "m" });
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(b.calls).toBe(0);
  });
});

describe("usage limits are enforced before billable requests", () => {
  it("blocks the request that would exceed the daily limit, records it as blocked, and does not call the provider", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a]);
    putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 2 });
    await run(ctx, ws.id);
    await run(ctx, ws.id);
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(a.calls).toBe(2);
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ attemptKind: "blocked", outcome: "budget_exhausted" });
  });

  it("the daily limit resets the next UTC day", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws, core } = liveApp([a]);
    putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 1 });
    await run(ctx, ws.id);
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_exhausted" });
    core.setNow("2026-10-16T00:00:01Z");
    await expect(run(ctx, ws.id)).resolves.toBeDefined();
  });

  it("refuses a cost ceiling it cannot verify (no configured price) rather than guessing", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a], { priced: [] });
    putAiSettings(ctx, ws.id, { routingMode: "automatic", monthlyBudgetMicros: 1_000_000 });
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_unverifiable" });
    expect(a.calls).toBe(0);
  });

  it("enforces the monthly estimated-cost ceiling for priced models", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a], { priced: ["fa"] });
    putAiSettings(ctx, ws.id, { routingMode: "automatic", monthlyBudgetMicros: 15_000 }); // each call costs 10_500
    await run(ctx, ws.id); // spent 10_500 < 15_000
    await run(ctx, ws.id); // allowed to start; spent becomes 21_000
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(a.calls).toBe(2);
  });

  it("a budget failure never triggers a fallback", async () => {
    const a = new Fake("fa", ["m"], []);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, { routingMode: "preferred_with_fallback", provider: "fa", model: "m", fallbackProvider: "fb", fallbackModel: "m", maxRequestsPerDay: 1 });
    await run(ctx, ws.id);
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(b.calls).toBe(0);
  });

  it("counts limits per workspace", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a]);
    const other = createWorkspace(ctx, "Other").workspace;
    putBrain(ctx, other.id, BRAIN);
    putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 1 });
    await run(ctx, ws.id);
    await expect(run(ctx, ws.id)).rejects.toMatchObject({ kind: "budget_exhausted" });
    await expect(run(ctx, other.id)).resolves.toBeDefined();
    expect(listUsage(ctx, other.id)).toHaveLength(1);
  });
});

describe("campaign generation through the gateway", () => {
  it("stores the campaign with its provider and model, and links the AI task in the audit trail", async () => {
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [])]);
    const rec = await generateCampaign(ctx, ws.id);
    expect(rec.versions[0]).toMatchObject({ source: "ai", aiProvider: "fa", aiModel: "m" });
    const ev = ctx.db.prepare("SELECT detail FROM audit_events WHERE type = 'campaign.generated'").get() as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ simulated: false, taskId: expect.stringMatching(/^aitask_/) });
  });

  it("uses the workspace settings when no explicit choice is given", async () => {
    const a = new Fake("fa", ["m"], []);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, { routingMode: "manual", provider: "fb", model: "m" });
    expect((await generateCampaign(ctx, ws.id)).versions[0]?.aiProvider).toBe("fb");
    expect(a.calls).toBe(0);
  });

  it("an explicit selection overrides the settings", async () => {
    const a = new Fake("fa", ["m"], []);
    const b = new Fake("fb", ["m"], []);
    const { ctx, ws } = liveApp([a, b]);
    putAiSettings(ctx, ws.id, { routingMode: "manual", provider: "fa", model: "m" });
    expect((await generateCampaign(ctx, ws.id, { providerId: "fb", model: "m" })).versions[0]?.aiProvider).toBe("fb");
  });

  it("repairs invalid output once and stores only the valid result", async () => {
    const bad: ProviderResult = { raw: { name: 1 }, model: "m", simulated: false };
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [bad, "ok"])]);
    await generateCampaign(ctx, ws.id);
    expect(listCampaigns(ctx, ws.id)).toHaveLength(1);
    expect(listUsage(ctx, ws.id)).toHaveLength(2);
  });

  it("persists NOTHING when output stays invalid, but still records the usage", async () => {
    const bad: ProviderResult = { raw: { name: 1 }, model: "m", simulated: false, usage: { inputTokens: 5, outputTokens: 5, source: "provider" } };
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [bad, bad])]);
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(listCampaigns(ctx, ws.id)).toEqual([]);
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM campaign_versions").get()).toEqual({ n: 0 });
    expect(listUsage(ctx, ws.id)).toHaveLength(2);
  });

  it("rejects model output that breaks a business rule of the schema (age range) before it reaches the domain", async () => {
    const badAudience: ProviderResult = { raw: { ...BRIEF_OK, audience: { ...BRIEF_OK.audience, ageMin: 60, ageMax: 30 } }, model: "m", simulated: false };
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [badAudience, badAudience])]);
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(listCampaigns(ctx, ws.id)).toEqual([]);
  });

  it("keeps missing facts explicit: material questions (with their impact) and assumptions are stored with the brief", async () => {
    const { ctx, ws } = mockApp();
    putBrain(ctx, ws.id, { ...BRAIN, unverifiedClaims: ["Voted #1 in Austin"] });
    const rec = await generateCampaign(ctx, ws.id);
    expect(rec.brief.openQuestions).toEqual([expect.objectContaining({ question: expect.stringMatching(/proof/i), impact: expect.stringMatching(/.{15}/), blocking: false })]);
    expect(rec.brief.assumptions.length).toBeGreaterThan(0);
  });

  it("the AI cannot execute or approve anything: generation creates no proposal, external resource or job", async () => {
    const { ctx, ws } = mockApp();
    await generateCampaign(ctx, ws.id);
    for (const t of ["action_proposals", "approvals", "external_resources", "jobs", "sim_meta_campaigns", "sim_crm_contacts"]) {
      expect(ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });
});

describe("mock vs live separation", () => {
  it("a real provider cannot be selected in mock mode, even explicitly and even with a key present", async () => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" } });
    const ws = createWorkspace(ctx, "A").workspace;
    putBrain(ctx, ws.id, BRAIN);
    await expect(generateCampaign(ctx, ws.id, { providerId: "anthropic", model: "claude-haiku-5-5" })).rejects.toMatchObject({ kind: "not_eligible" });
    await expect(generateCampaign(ctx, ws.id, { providerId: "openai", model: "gpt-5.5" })).rejects.toMatchObject({ kind: "not_eligible" });
    expect((await generateCampaign(ctx, ws.id)).versions[0]?.aiProvider).toBe("mock"); // default route is the mock
  });

  it("the mock provider cannot be selected in live mode (no silent mixing)", async () => {
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], []), new MockAiProvider()]);
    await expect(generateCampaign(ctx, ws.id, { providerId: "mock", model: "mock-deterministic-1" })).rejects.toThrow();
  });
});

describe("explicit connection test", () => {
  it("is simulated for the mock provider: reports nothing verified and makes no usage record", async () => {
    const { ctx, ws } = mockApp();
    const r = await connectionTest(ctx, ws.id, "mock", "mock-deterministic-1");
    expect(r).toMatchObject({ simulated: true, connected: null });
    expect(r.message).toMatch(/nothing was verified/i);
    expect(listUsage(ctx, ws.id)).toHaveLength(0);
  });

  it("refuses to test a real provider while live mode is off, without any request", async () => {
    const { ctx, ws } = mockApp();
    await expect(connectionTest(ctx, ws.id, "anthropic", "claude-haiku-5-5")).rejects.toMatchObject({ kind: "live_disabled" });
  });

  it("in live mode makes one real (here: fake) request, records it, and reports success", async () => {
    const a = new Fake("fa", ["m"], []);
    const { ctx, ws } = liveApp([a]);
    const r = await connectionTest(ctx, ws.id, "fa", "m");
    expect(r).toMatchObject({ simulated: false, connected: true, requestId: "fa-req" });
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ taskType: "connection_test", mode: "live" });
  });

  it("reports a failed live test as not connected, with a normalized error kind", async () => {
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [new AiError("auth", "rejected credentials")])]);
    const r = await connectionTest(ctx, ws.id, "fa", "m");
    expect(r).toMatchObject({ simulated: false, connected: false, errorKind: "auth" });
  });

  it("counts toward the usage limit", async () => {
    const { ctx, ws } = liveApp([new Fake("fa", ["m"], [])]);
    putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 1 });
    await connectionTest(ctx, ws.id, "fa", "m");
    await expect(connectionTest(ctx, ws.id, "fa", "m")).rejects.toMatchObject({ kind: "budget_exhausted" });
  });
});

describe("workspace isolation of usage data", () => {
  it("one workspace never sees another's usage records or totals", async () => {
    const { ctx, ws } = mockApp();
    const other = createWorkspace(ctx, "Other").workspace;
    await run(ctx, ws.id);
    await run(ctx, ws.id);
    expect(listUsage(ctx, ws.id)).toHaveLength(2);
    expect(listUsage(ctx, other.id)).toEqual([]);
    expect(usageSummary(ctx, other.id).today.attempts).toBe(0);
  });
});

describe("output-token ceiling", () => {
  it("clamps any requested maximum to AI_MAX_OUTPUT_TOKENS and applies it by default", async () => {
    const core = makeCore();
    const p = new Fake("fa", ["m"], []);
    const registry = new ModelRegistry([entry("fa", "m")]);
    const ctx = buildContext({ db: core.db, now: core.now, env: { ...LIVE_ENV, AI_MAX_OUTPUT_TOKENS: "300" }, aiProviders: [p], registry, pricing: new PricingTable("USD", [{ provider: "fa", model: "m", ...PRICE }]), gateway: { sleep: async () => {} } });
    const ws = createWorkspace(ctx, "Acme").workspace;
    putBrain(ctx, ws.id, BRAIN);
    await runAiTask(ctx, ws.id, TASK(ctx));
    expect(p.lastMaxTokens).toBe(300); // default = the ceiling
    await runAiTask(ctx, ws.id, TASK(ctx, { maxOutputTokens: 50 }));
    expect(p.lastMaxTokens).toBe(50); // callers may ask for less
    await runAiTask(ctx, ws.id, TASK(ctx, { maxOutputTokens: 999_999 }));
    expect(p.lastMaxTokens).toBe(300); // but never more
    await connectionTest(ctx, ws.id, "fa", "m");
    expect(p.lastMaxTokens).toBeLessThanOrEqual(64);
  });
});
