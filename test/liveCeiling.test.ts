/**
 * The server-side spending ceiling for paid AI, the one-request test flow, and the status report that proves the key is present
 * without showing it. Everything runs against fake providers or a scripted HTTP layer: no network, no key, no charge.
 */
import { describe, expect, it } from "vitest";
import { PricingTable } from "../src/ai/pricing.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult } from "../src/ai/types.js";
import { aiProviderStatus, listUsage, runTestRequest } from "../src/app/aiService.js";
import { buildContext } from "../src/app/context.js";
import { createWorkspace } from "../src/app/workspaces.js";
import { buildServer } from "../src/server/app.js";
import { makeCore } from "./fixtures.js";

class Fake implements AiProvider {
  readonly id = "fake"; readonly label = "fake"; readonly models = ["m"] as const; readonly simulated = false;
  calls = 0;
  constructor(public usage: ProviderResult["usage"] = { inputTokens: 1_000_000, outputTokens: 0, source: "provider" }, public failWith?: AiError) {}
  isAvailable() { return true; }
  async generateObject<T>(_r: GenerateObjectRequest<T>): Promise<ProviderResult> { throw new Error("not used"); }
  async generateText(r: GenerateTextRequest): Promise<ProviderResult> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return { text: `echo: ${r.prompt}`, model: r.model, simulated: false, usage: this.usage, requestId: "req-test" };
  }
}
const PRICE = { provider: "fake", model: "m", inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com/p" };
const LIVE = { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_MAX_RETRIES: "0", AI_REPAIR_ATTEMPTS: "0" };

function liveApp(p: Fake, env: Record<string, string> = {}, priced = true) {
  const core = makeCore();
  const registry = new ModelRegistry([{ provider: "fake", model: "m", label: "fake", enabled: true, tasks: ["connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
  const ctx = buildContext({ db: core.db, now: core.now, env: { ...LIVE, ...env }, aiProviders: [p], registry, pricing: new PricingTable("USD", priced ? [PRICE] : []), gateway: { sleep: async () => {}, maxRetries: 0 } });
  const ws = createWorkspace(ctx, "Test Co").workspace;
  return { ctx, ws, core };
}
const test = (c: ReturnType<typeof liveApp>, prompt = "Say hello") => runTestRequest(c.ctx, c.ws.id, "fake", "m", prompt);

describe("live AI needs the server's own spending ceiling", () => {
  it("refuses every live request when no ceiling is configured, and says what to set", async () => {
    const p = new Fake();
    const a = liveApp(p);
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_unverifiable", message: expect.stringContaining("AI_LIVE_BUDGET_MICROS") });
    expect(p.calls).toBe(0);
    expect(listUsage(a.ctx, a.ws.id)[0]).toMatchObject({ attemptKind: "blocked", outcome: "budget_unverifiable" });
  });

  it("refuses a model with no price (its cost cannot be limited)", async () => {
    const p = new Fake();
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000" }, false);
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_unverifiable" });
    expect(p.calls).toBe(0);
  });

  it("sends a request that fits, labels it live, and reports provider usage and an estimated cost", async () => {
    const p = new Fake({ inputTokens: 12, outputTokens: 5, source: "provider" });
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000" });
    const r = await test(a, "What is 2+2?");
    expect(r).toMatchObject({ status: "ok", mode: "live", provider: "fake", model: "m", text: "echo: What is 2+2?", usage: { inputTokens: 12, outputTokens: 5, source: "provider" }, costStatus: "estimated", currency: "USD" });
    expect(r.estimatedCostMicros).toBe(Math.round((12 * 100_000 + 5 * 500_000) / 1e6));
    expect(listUsage(a.ctx, a.ws.id)[0]).toMatchObject({ mode: "live", inputTokens: 12, outputTokens: 5, taskType: "test_request" });
    // metadata only: the prompt is not in the usage record
    expect(JSON.stringify(listUsage(a.ctx, a.ws.id))).not.toContain("2+2");
  });

  it("stops when the ceiling is reached: later requests are refused, not sent", async () => {
    const p = new Fake({ inputTokens: 1_000_000, outputTokens: 0, source: "provider" }); // each request really costs 100_000
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "250000" });
    for (let i = 0; i < 3; i++) await test(a); // 100k, 200k, 300k (each was allowed to start below the ceiling)
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(p.calls).toBe(3);
    const s = aiProviderStatus(a.ctx).budget;
    expect(s).toMatchObject({ configured: true, ceilingMicros: 250000, spentMicros: 300000, remainingMicros: 0 });
    expect(s.note).toMatch(/not your provider's own billing limit/);
  });

  it("will not start a request whose worst case cannot fit in what is left", async () => {
    const p = new Fake();
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "50" }); // 200 output tokens x 0.5 = 100 micros at the very least
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_exhausted", message: expect.stringContaining("would be exceeded") });
    expect(p.calls).toBe(0);
  });

  it("reserves spend for every attempt a request may make (retries and repair)", async () => {
    const p = new Fake();
    const one = liveApp(p, { AI_LIVE_BUDGET_MICROS: "150" });
    expect(one.ctx.aiPolicy.attemptsPerRequest).toBe(1);
    await expect(test(one)).resolves.toMatchObject({ status: "ok" }); // ~100 micros worst case fits in 150 with one attempt
    const core = makeCore();
    const registry = new ModelRegistry([{ provider: "fake", model: "m", label: "fake", enabled: true, tasks: ["connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
    const ctx = buildContext({ db: core.db, now: core.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "150" }, aiProviders: [new Fake()], registry, pricing: new PricingTable("USD", [PRICE]) });
    expect(ctx.aiPolicy.attemptsPerRequest).toBe(4); // first try + 2 retries + 1 repair by default
    const ws = createWorkspace(ctx, "Test Co").workspace;
    await expect(runTestRequest(ctx, ws.id, "fake", "m", "hi")).rejects.toMatchObject({ kind: "budget_exhausted" });
  });

  it("pauses live requests when an earlier one returned no token count, because the spend cannot be verified", async () => {
    const p = new Fake(undefined);
    p.usage = undefined;
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000" });
    const first = await test(a);
    expect(first).toMatchObject({ status: "ok", usage: null, estimatedCostMicros: null, costStatus: "unknown_no_usage" }); // reported as unknown, not as 0
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_unverifiable", message: expect.stringContaining("cannot be verified") });
    expect(p.calls).toBe(1);
  });

  it("enforces a daily request cap and the workspace's own stricter limits, and a workspace cannot raise the server ceiling", async () => {
    const p = new Fake({ inputTokens: 1, outputTokens: 1, source: "provider" });
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000", AI_LIVE_MAX_REQUESTS_PER_DAY: "2" });
    await test(a); await test(a);
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_exhausted", message: expect.stringContaining("daily limit") });
    const { putAiSettings } = await import("../src/app/aiService.js");
    const b = liveApp(new Fake(), { AI_LIVE_BUDGET_MICROS: "50" });
    putAiSettings(b.ctx, b.ws.id, { routingMode: "automatic", monthlyBudgetMicros: 999_999_999 });
    await expect(test(b)).rejects.toMatchObject({ kind: "budget_exhausted" });
  });

  it("rejects an invalid ceiling at startup instead of guessing", () => {
    const core = makeCore();
    for (const bad of ["abc", "-5", "1.5", "0"]) expect(() => buildContext({ db: core.db, now: core.now, env: { AI_LIVE_BUDGET_MICROS: bad } })).toThrow(/AI_LIVE_BUDGET_MICROS/);
  });

  it("requires explicit live opt-in and server permission for the request itself", async () => {
    const core = makeCore();
    const registry = new ModelRegistry([{ provider: "fake", model: "m", label: "fake", enabled: true, tasks: ["connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
    const ctx = buildContext({ db: core.db, now: core.now, env: { AI_LIVE_BUDGET_MICROS: "1000000" }, aiProviders: [new Fake()], registry, pricing: new PricingTable("USD", [PRICE]) });
    const ws = createWorkspace(ctx, "Test Co").workspace;
    await expect(runTestRequest(ctx, ws.id, "fake", "m", "hi")).rejects.toMatchObject({ kind: "live_disabled" });
  });
});

describe("the one-request test flow", () => {
  it("works in mock mode with no key and no ceiling, labels the result simulated, and never reports a cost", async () => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: { OPENAI_API_KEY: "sk-FAKE-mock-mode-key-12345" } });
    const ws = createWorkspace(ctx, "Mock Co").workspace;
    const r = await runTestRequest(ctx, ws.id, "mock", "mock-deterministic-1", "hello");
    expect(r).toMatchObject({ status: "ok", mode: "mock", provider: "mock", costStatus: "not_applicable", estimatedCostMicros: null });
    expect(r.usage?.source).toBe("simulated");
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ mode: "mock", simulated: true });
    await expect(runTestRequest(ctx, ws.id, "openai", "gpt-6-luna", "hello")).rejects.toMatchObject({ kind: "live_disabled" }); // the key present in the environment is ignored in mock mode
  });

  it("validates the question", async () => {
    const a = liveApp(new Fake(), { AI_LIVE_BUDGET_MICROS: "1000000" });
    await expect(test(a, "   ")).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(test(a, "x".repeat(501))).rejects.toMatchObject({ kind: "invalid_request" });
    await expect(runTestRequest(a.ctx, a.ws.id, "nope", "m", "hi")).rejects.toMatchObject({ kind: "unknown_provider" });
  });

  it("returns a provider failure as a normalized result, with no key or internals in it", async () => {
    const p = new Fake(undefined, new AiError("auth", "The provider rejected the credentials", { requestId: "req-9" }));
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000", OPENAI_API_KEY: "sk-FAKE-should-never-appear" });
    const r = await test(a);
    expect(r).toMatchObject({ status: "error", mode: "live", errorKind: "auth", requestId: "req-9" });
    expect(JSON.stringify(r)).not.toContain("sk-FAKE");
  });
});

describe("the real OpenAI adapter, driven through a scripted HTTP layer", () => {
  const KEY = "sk-TEST-FAKE-ceiling-0000000000000000000";
  function ctxWith(env: Record<string, string>, reply: () => { status?: number; body: unknown }) {
    const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const aiFetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
      const r = reply();
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: KEY, ...env }, aiFetch, backoffMs: () => 0, gateway: { sleep: async () => {}, maxRetries: 0 } });
    const ws = createWorkspace(ctx, "Real Adapter Co").workspace;
    return { ctx, ws, seen };
  }
  const okBody = { object: "response", id: "resp_1", model: "gpt-6-luna-2026-10-01", status: "completed", output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text: "Hello!", annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 3 } };

  it("asks OpenAI not to store the response, caps the output, keeps the key in the Authorization header only, and shows real usage", async () => {
    const { ctx, ws, seen } = ctxWith({ AI_LIVE_BUDGET_MICROS: "50000" }, () => ({ body: okBody }));
    const r = await runTestRequest(ctx, ws.id, "openai", "gpt-6-luna", "Say hello");
    expect(r).toMatchObject({ status: "ok", mode: "live", provider: "openai", text: "Hello!", usage: { inputTokens: 20, outputTokens: 3, source: "provider" }, costStatus: "estimated" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(seen[0]!.body.store).toBe(false);
    expect(seen[0]!.body.max_output_tokens).toBe(200);
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(seen[0]!.body)).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(aiProviderStatus(ctx))).not.toContain(KEY);
    expect(JSON.stringify(listUsage(ctx, ws.id))).not.toContain(KEY);
  });

  it("honours an explicit OPENAI_STORE choice, and makes no request at all when the ceiling is missing", async () => {
    const { ctx, ws, seen } = ctxWith({ AI_LIVE_BUDGET_MICROS: "50000", OPENAI_STORE: "true" }, () => ({ body: okBody }));
    await runTestRequest(ctx, ws.id, "openai", "gpt-6-luna", "hi");
    expect(seen[0]!.body.store).toBe(true);
    const none = ctxWith({}, () => ({ body: okBody }));
    await expect(runTestRequest(none.ctx, none.ws.id, "openai", "gpt-6-luna", "hi")).rejects.toMatchObject({ kind: "budget_unverifiable" });
    expect(none.seen).toEqual([]);
  });

  it("turns a rejected key into a safe message that never echoes the key", async () => {
    const { ctx, ws } = ctxWith({ AI_LIVE_BUDGET_MICROS: "50000" }, () => ({ status: 401, body: { error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } } }));
    const r = await runTestRequest(ctx, ws.id, "openai", "gpt-6-luna", "hi");
    expect(r).toMatchObject({ status: "error", errorKind: "auth" });
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(listUsage(ctx, ws.id))).not.toContain(KEY);
  });
});

describe("status and routes", () => {
  it("reports whether a key is present without revealing it, in every mode", () => {
    const KEY = "sk-TEST-FAKE-status-1234567890abcdef";
    const core = makeCore();
    const mock = buildContext({ db: core.db, now: core.now, env: { OPENAI_API_KEY: KEY } });
    const s = aiProviderStatus(mock);
    expect(s.mode).toBe("mock");
    expect(s.providers.find((p) => p.id === "openai")).toMatchObject({ keyConfigured: true, available: false });
    expect(s.nextStep).toMatch(/ignored in mock mode/);
    expect(s.nextStep).toMatch(/AI_LIVE_BUDGET_MICROS/);
    expect(JSON.stringify(s)).not.toContain(KEY);
    const none = aiProviderStatus(buildContext({ db: makeCore().db, env: { OPENAI_API_KEY: "" } }));
    expect(none.providers.find((p) => p.id === "openai")?.keyConfigured).toBe(false);
    const placeholder = aiProviderStatus(buildContext({ db: makeCore().db, env: { OPENAI_API_KEY: "your-key-here" } }));
    expect(placeholder.providers.find((p) => p.id === "openai")?.keyConfigured).toBe(false);
    const live = aiProviderStatus(buildContext({ db: makeCore().db, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: KEY } }));
    expect(live.nextStep).toMatch(/no spending ceiling/);
    expect(live.openaiStoreFalse).toBe(true);
  });

  it("serves status and the test request over HTTP to the workspace only, in mock mode", async () => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: { OPENAI_API_KEY: "sk-FAKE-http-0000000000000" } });
    const app = buildServer(ctx);
    const call = async (method: string, url: string, token?: string, body?: unknown) => {
      const r = await app.inject({ method: method as never, url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, payload: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : {}, raw: r.body };
    };
    const w = (await call("POST", "/api/workspaces", undefined, { name: "Http Co" })).body as { workspace: { id: string }; token: string };
    const base = `/api/workspaces/${w.workspace.id}/ai`;
    expect((await call("GET", `${base}/status`)).status).toBe(401);
    const st = await call("GET", `${base}/status`, w.token);
    expect(st.status).toBe(200);
    expect(st.raw).not.toContain("sk-FAKE");
    const ok = await call("POST", `${base}/test-request`, w.token, { provider: "mock", model: "mock-deterministic-1", prompt: "hi" });
    expect(ok.body).toMatchObject({ status: "ok", mode: "mock" });
    const live = await call("POST", `${base}/test-request`, w.token, { provider: "openai", model: "gpt-6-luna", prompt: "hi" });
    expect(live.status).toBe(409);
    expect(live.body.error.code).toBe("live_disabled");
    expect((await call("POST", `${base}/test-request`, w.token, { provider: "mock", model: "m", prompt: "hi", extra: 1 })).status).toBe(400);
  });
});
