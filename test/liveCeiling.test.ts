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

describe("spend is reserved before a paid request, so concurrent requests cannot exceed the ceiling", () => {
  class Slow extends Fake {
    async generateText(r: GenerateTextRequest): Promise<ProviderResult> { await new Promise((res) => setTimeout(res, 40)); return super.generateText(r); }
  }
  const held = (c: ReturnType<typeof liveApp>) => (c.ctx.db.prepare("SELECT COUNT(*) n FROM ai_reservations").get() as { n: number }).n;
  const small = { inputTokens: 10, outputTokens: 5, source: "provider" as const };

  it("two requests at the same time, room for one: exactly one is sent, and the reservation is released afterwards", async () => {
    const p = new Slow(small);
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "150" }); // one request reserves ~100 micros (200 output tokens at 0.5/M tokens plus input)
    const results = await Promise.allSettled([test(a), test(a)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ kind: "budget_exhausted", message: expect.stringContaining("held for requests in progress") });
    expect(p.calls).toBe(1);
    expect(held(a)).toBe(0);
    await expect(test(a)).resolves.toMatchObject({ status: "ok" }); // the actual spend was tiny, so a later request fits again
  });

  it("the daily request cap counts requests that are still running", async () => {
    const p = new Slow(small);
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000", AI_LIVE_MAX_REQUESTS_PER_DAY: "1" });
    const results = await Promise.allSettled([test(a), test(a), test(a)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(p.calls).toBe(1);
    expect(held(a)).toBe(0);
  });

  it("a failed request releases its reservation too", async () => {
    const p = new Fake(undefined, new AiError("rate_limit", "slow down", { retryable: true }));
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000" });
    await expect(test(a)).resolves.toMatchObject({ status: "error", errorKind: "rate_limit" });
    expect(held(a)).toBe(0);
  });

  it("a reservation left behind by a crash keeps counting for the month (it may have been billed unrecorded), and is cleared when the month ends", async () => {
    const p = new Fake(small);
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "150" });
    a.ctx.db.prepare("INSERT INTO ai_reservations (id, workspace_id, micros, reserved_at) VALUES ('rsv_crash', ?, 140, ?)").run(a.ws.id, new Date(a.ctx.now().getTime() - 6 * 60 * 60_000).toISOString()); // hours old, same month
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_exhausted", message: expect.stringContaining("held for requests in progress") });
    expect(p.calls).toBe(0);
    expect(held(a)).toBe(1); // nothing was removed or released by the refusal
    // next month: last month's leftovers are gone and the new month starts clean
    a.core.setNow("2026-11-02T09:00:00Z");
    await expect(test(a)).resolves.toMatchObject({ status: "ok" });
    expect((a.ctx.db.prepare("SELECT COUNT(*) n FROM ai_reservations WHERE id = 'rsv_crash'").get() as { n: number }).n).toBe(0);
  });

  it("a request that times out may have been billed with no usage reported: its worst case stays held, and the usage row says 'unknown', never zero", async () => {
    const p = new Fake(small, new AiError("timeout", "Request timed out", { retryable: true }));
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "250" });
    const r = await test(a);
    expect(r).toMatchObject({ status: "error", errorKind: "timeout", estimatedCostMicros: null });
    const row = a.ctx.db.prepare("SELECT micros, state FROM ai_reservations").get() as { micros: number; state: string };
    expect(row.state).toBe("unverified");
    expect(row.micros).toBeGreaterThan(0);
    expect(row.micros).toBeLessThanOrEqual(110); // one attempt's worst case, not the whole multi-attempt reservation
    const usage = listUsage(a.ctx, a.ws.id)[0]!;
    expect(usage).toMatchObject({ outcome: "timeout", estimatedCostMicros: null, costStatus: "unknown_no_usage", inputTokens: null, outputTokens: null });
    const status = aiProviderStatus(a.ctx).budget;
    expect(status).toMatchObject({ unverifiedHolds: 1 });
    expect(status.heldMicros).toBe(row.micros);
    // it keeps counting: with 250 micros and 103 held, a second request (103 reserved) still fits, a third does not
    p.failWith = undefined;
    await expect(test(a)).resolves.toMatchObject({ status: "ok" });
    p.failWith = new AiError("timeout", "Request timed out", { retryable: true });
    await test(a); // times out again: a second unverified hold
    p.failWith = undefined;
    await expect(test(a)).rejects.toMatchObject({ kind: "budget_exhausted" });
  });

  it("a request can only release its own reservation: another request's failure leaves a running request's hold in place", async () => {
    let n = 0;
    let seenDuringSlow = -1;
    const p = new Fake(small);
    const a = liveApp(p, { AI_LIVE_BUDGET_MICROS: "1000000" });
    const original = p.generateText.bind(p);
    p.generateText = async (r: GenerateTextRequest) => {
      const mine = ++n;
      if (mine === 1) { await new Promise((res) => setTimeout(res, 80)); seenDuringSlow = held(a); return original(r); } // the slow one reads the table after the other has failed and released
      throw new AiError("rate_limit", "no", { retryable: true });
    };
    const [slow, fast] = await Promise.all([test(a), new Promise<void>((res) => setTimeout(res, 10)).then(() => test(a))]);
    expect(fast).toMatchObject({ status: "error", errorKind: "rate_limit" });
    expect(seenDuringSlow).toBe(1); // only the slow request's own hold was there: the failed one released ITS hold and nothing else
    expect(slow).toMatchObject({ status: "ok" });
    expect(held(a)).toBe(0);
  });

  it("the monthly figure and the daily cap survive a restart (they live in the database, not in memory)", async () => {
    const p = new Fake({ inputTokens: 1_000_000, outputTokens: 0, source: "provider" }); // each real request costs 100_000
    const first = liveApp(p, { AI_LIVE_BUDGET_MICROS: "150000", AI_LIVE_MAX_REQUESTS_PER_DAY: "2" });
    await test(first);
    const restart = () => buildContext({ db: first.core.db, now: first.core.now, env: { ...LIVE, AI_LIVE_BUDGET_MICROS: "150000", AI_LIVE_MAX_REQUESTS_PER_DAY: "2" }, aiProviders: [p], registry: new ModelRegistry([{ provider: "fake", model: "m", label: "fake", enabled: true, tasks: ["connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]), pricing: new PricingTable("USD", [PRICE]), gateway: { sleep: async () => {}, maxRetries: 0 } });
    const second = restart();
    expect(aiProviderStatus(second).budget).toMatchObject({ spentMicros: 100000, requestsToday: 1 });
    await test({ ...first, ctx: second }); // 100_000 used + ~100 reserved fits under 150_000
    const third = restart(); // another restart: 200_000 used now, over the ceiling
    await expect(test({ ...first, ctx: third })).rejects.toMatchObject({ kind: "budget_exhausted" });
    // and the daily cap of 2 is reached too, whichever process asks
    const capped = restart();
    await expect(test({ ...first, ctx: capped })).rejects.toMatchObject({ kind: "budget_exhausted" });
    expect(p.calls).toBe(2);
  });
});

describe("retry accounting equals the real maximum number of provider attempts", () => {
  // The gateway allows 1 first try + AI_MAX_RETRIES retries (rate limit, timeout, outage) + AI_REPAIR_ATTEMPTS repair (after unusable output): it does not matter
  // whether the call is text or structured, because empty text counts as unusable output and is repaired too. The reservation must cover exactly that many.
  class Scripted implements AiProvider {
    readonly id = "fake"; readonly label = "fake"; readonly models = ["m"] as const; readonly simulated = false;
    calls = 0;
    constructor(private script: Array<"rate_limit" | "empty" | "ok">) {}
    isAvailable() { return true; }
    async generateObject<T>(_r: GenerateObjectRequest<T>): Promise<ProviderResult> { throw new Error("unused"); }
    async generateText(r: GenerateTextRequest): Promise<ProviderResult> {
      const step = this.script[this.calls++] ?? "ok";
      if (step === "rate_limit") throw new AiError("rate_limit", "slow", { retryable: true });
      return { text: step === "empty" ? "" : "fine", model: r.model, simulated: false, usage: { inputTokens: 10, outputTokens: 1, source: "provider" } };
    }
  }
  const build = (p: Scripted, env: Record<string, string>) => {
    const core = makeCore();
    const registry = new ModelRegistry([{ provider: "fake", model: "m", label: "fake", enabled: true, tasks: ["connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
    const ctx = buildContext({ db: core.db, now: core.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "1000000", ...env }, aiProviders: [p], registry, pricing: new PricingTable("USD", [PRICE]), gateway: { sleep: async () => {} } });
    return { ctx, ws: createWorkspace(ctx, "Attempts Co").workspace };
  };
  const cases: Array<[string, Record<string, string>, number]> = [["defaults (2 retries, 1 repair)", {}, 4], ["no retries, no repair", { AI_MAX_RETRIES: "0", AI_REPAIR_ATTEMPTS: "0" }, 1], ["5 retries, 1 repair", { AI_MAX_RETRIES: "5" }, 7], ["retries capped at 5", { AI_MAX_RETRIES: "50" }, 7], ["no repair", { AI_REPAIR_ATTEMPTS: "0" }, 3]];
  it.each(cases)("%s: the worst case really is the reserved number of attempts", async (_n, env, expected) => {
    // every attempt fails in the way that allows the most further attempts: rate limits first (retries), then unusable output (repair)
    const retries = Math.min(Number(env.AI_MAX_RETRIES ?? 2), 5);
    const repair = env.AI_REPAIR_ATTEMPTS === "0" ? 0 : 1;
    const script: Array<"rate_limit" | "empty"> = [...Array(retries).fill("rate_limit"), ...Array(1 + repair).fill("empty")];
    const p = new Scripted(script);
    const { ctx, ws } = build(p, env);
    expect(ctx.aiPolicy.attemptsPerRequest).toBe(expected);
    await runTestRequest(ctx, ws.id, "fake", "m", "hi").catch(() => undefined);
    expect(p.calls).toBe(expected); // the provider was called exactly as many times as the reservation allows for, and not once more
  });
  it("the reservation is that many times the single-attempt worst case", async () => {
    const { ctx, ws } = build(new Scripted([]), {});
    // inspect the reservation while the request is running
    let heldMicros = 0;
    const p = new Scripted([]);
    p.generateText = async (r: GenerateTextRequest) => { heldMicros = (ctx.db.prepare("SELECT SUM(micros) m FROM ai_reservations").get() as { m: number }).m; return { text: "ok", model: r.model, simulated: false, usage: { inputTokens: 1, outputTokens: 1, source: "provider" } }; };
    const registry = new ModelRegistry([{ provider: "fake", model: "m", label: "fake", enabled: true, tasks: ["connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
    const c2 = buildContext({ db: ctx.db, now: ctx.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "1000000" }, aiProviders: [p], registry, pricing: new PricingTable("USD", [PRICE]) });
    await runTestRequest(c2, ws.id, "fake", "m", "Reply with the single word: pong");
    const single = Math.round((26 * 100_000 + 200 * 500_000) / 1e6); // 26 estimated input tokens, 200 output tokens, the price list's rates
    expect(single).toBe(103);
    expect(heldMicros).toBe(single * 4);
  });
});

describe("a provider key is only sent to the official host", () => {
  const live = { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "50000", OPENAI_API_KEY: "sk-TEST-FAKE-host-000000000000000000" };
  const make = (extra: Record<string, string>) => { const core = makeCore(); return buildContext({ db: core.db, now: core.now, env: { ...live, ...extra } }); };
  it("accepts the official address, and no address at all", () => {
    expect(() => make({})).not.toThrow();
    expect(() => make({ OPENAI_BASE_URL: "https://api.openai.com/v1" })).not.toThrow();
    expect(make({ OPENAI_BASE_URL: "https://api.openai.com/v1" }).aiPolicy.customBaseUrls).toEqual([]);
  });
  it.each(["https://evil.example.com/v1", "https://api.openai.com.evil.example.com/v1", "http://api.openai.com/v1", "https://api.openai.com:8443/v1", "https://user:pw@api.openai.com/v1", "http://localhost:4010/v1", "not a url"])("refuses %s by default, naming the setting and never the value", (bad) => {
    let msg = "";
    try { make({ OPENAI_BASE_URL: bad }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/OPENAI_BASE_URL/);
    const host = (() => { try { return new URL(bad).hostname; } catch { return null; } })();
    if (host && host !== "api.openai.com") expect(msg).not.toContain(host); // the message never echoes the configured address
    expect(msg).not.toContain("sk-TEST");
  });
  it("allows another host only with the explicit development override, over https (or http on this machine), and flags it", () => {
    const c = make({ OPENAI_BASE_URL: "https://stub.example.com/v1", ALLOW_CUSTOM_PROVIDER_BASE_URL: "true" });
    expect(c.aiPolicy.customBaseUrls).toEqual(["OPENAI_BASE_URL"]);
    expect(aiProviderStatus(c).nextStep).toMatch(/^WARNING: OPENAI_BASE_URL points to a custom host/);
    expect(make({ OPENAI_BASE_URL: "http://127.0.0.1:4010/v1", ALLOW_CUSTOM_PROVIDER_BASE_URL: "true" }).aiPolicy.customBaseUrls).toEqual(["OPENAI_BASE_URL"]);
    expect(() => make({ OPENAI_BASE_URL: "http://stub.example.com/v1", ALLOW_CUSTOM_PROVIDER_BASE_URL: "true" })).toThrow(/https/);
    expect(() => make({ OPENAI_BASE_URL: "https://user:pw@stub.example.com/v1", ALLOW_CUSTOM_PROVIDER_BASE_URL: "true" })).toThrow(/username or password/);
  });
  it("is ignored (and never used) when no key can be used: mock mode does not care what the address says", async () => {
    const core = makeCore();
    const c = buildContext({ db: core.db, now: core.now, env: { OPENAI_BASE_URL: "https://evil.example.com/v1", OPENAI_API_KEY: "sk-TEST-FAKE-host-000000000000000000" } });
    expect(c.aiPolicy.customBaseUrls).toEqual([]);
  });
  it("the same rule covers the Anthropic address", () => {
    expect(() => make({ ANTHROPIC_BASE_URL: "https://evil.example.com" })).toThrow(/ANTHROPIC_BASE_URL/);
    expect(() => make({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" })).not.toThrow();
  });
});

describe("the processing tier is pinned so the price list stays true", () => {
  it("sends service_tier=default unless the operator chooses otherwise", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const aiFetch = (async (_u: string | URL | Request, init: RequestInit = {}) => {
      seen.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ object: "response", id: "resp_1", model: "gpt-6-luna", status: "completed", output: [{ type: "message", role: "assistant", id: "m", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    for (const [extra, expected] of [[{}, "default"], [{ OPENAI_SERVICE_TIER: "flex" }, "flex"]] as const) {
      const core = makeCore();
      const ctx = buildContext({ db: core.db, now: core.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "sk-TEST-FAKE-tier-000000000000000000", AI_LIVE_BUDGET_MICROS: "50000", ...extra }, aiFetch, gateway: { sleep: async () => {}, maxRetries: 0 } });
      const ws = createWorkspace(ctx, "Tier Co").workspace;
      await runTestRequest(ctx, ws.id, "openai", "gpt-6-luna", "hi");
      expect(seen.at(-1)?.service_tier).toBe(expected);
      expect(seen.at(-1)?.store).toBe(false);
    }
  });
});

describe("live mode fails safely without a usable key", () => {
  it("with no key at all, the request is refused before anything is sent, and nothing is reserved or recorded as spend", async () => {
    let sent = 0;
    const aiFetch = (async () => { sent++; throw new Error("must not be called"); }) as unknown as typeof fetch;
    for (const key of [undefined, "", "your-key-here", "   "]) {
      const core = makeCore();
      const ctx = buildContext({ db: core.db, now: core.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "50000", ...(key === undefined ? {} : { OPENAI_API_KEY: key }) }, aiFetch });
      const ws = createWorkspace(ctx, "No Key Co").workspace;
      await expect(runTestRequest(ctx, ws.id, "openai", "gpt-6-luna", "hi")).rejects.toMatchObject({ kind: "not_eligible" });
      expect(aiProviderStatus(ctx).providers.find((p) => p.id === "openai")).toMatchObject({ keyConfigured: false, available: false });
      expect((ctx.db.prepare("SELECT COUNT(*) n FROM ai_reservations").get() as { n: number }).n).toBe(0);
    }
    expect(sent).toBe(0);
  });
  it("says that a key being present does not prove it works", () => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "50000", OPENAI_API_KEY: "sk-TEST-FAKE-present-0000000000000000" } });
    expect(aiProviderStatus(ctx).nextStep).toMatch(/present does not prove it is valid or unexpired/);
  });
});
