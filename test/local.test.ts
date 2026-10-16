import { describe, expect, it } from "vitest";
import { assertLoopbackUrl, OllamaProvider } from "../src/ai/ollamaProvider.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { connectionTest, listModels, listUsage, putAiSettings, runAiTask, usageSummary } from "../src/app/aiService.js";
import { generateCampaign } from "../src/app/campaigns.js";
import { buildContext } from "../src/app/context.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { CampaignBriefSchema } from "../src/domain/schemas.js";
import { loadIntegrationConfig } from "../src/integrations/mode.js";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { BusinessBrainSchema } from "../src/domain/schemas.js";
import { BRIEF_OK, req } from "./briefFixture.js";
import { BRAIN, makeCore } from "./fixtures.js";

const KEYS = { OPENAI_API_KEY: "sk-OPENAI-NOT-REAL", ANTHROPIC_API_KEY: "sk-ant-NOT-REAL" };
const LOCAL = { AI_PROVIDER_MODE: "local" };

/** Records requests and replies like Ollama's /v1/responses (no request-id header, usage in the OpenAI shape). */
function ollamaFetch(replies: Array<{ status?: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; auth: string | null; body: any }> = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const h = new Headers(init.headers as HeadersInit);
    calls.push({ url: String(url), auth: h.get("authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}
const okResponse = (text: string) => ({
  body: {
    id: "resp_385873", object: "response", status: "completed", model: "llama3.1:latest",
    output: [{ type: "message", role: "assistant", id: "m", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 189, output_tokens: 247, total_tokens: 436 },
  },
});

describe("local mode: configuration", () => {
  it("is accepted as a third AI mode; mock stays the default", () => {
    expect(loadIntegrationConfig({}).aiMode).toBe("mock");
    expect(loadIntegrationConfig({ AI_PROVIDER_MODE: "local" })).toMatchObject({ aiMode: "local", localAi: true, liveAi: false });
    expect(() => loadIntegrationConfig({ AI_PROVIDER_MODE: "cloud" })).toThrow(/mock", "local" or "live/);
  });
  it("needs no ALLOW_LIVE_PROVIDER_CALLS, and that flag cannot turn paid providers on in local mode", () => {
    expect(loadIntegrationConfig({ AI_PROVIDER_MODE: "local" }).liveAi).toBe(false);
    expect(loadIntegrationConfig({ AI_PROVIDER_MODE: "local", ALLOW_LIVE_PROVIDER_CALLS: "true" })).toMatchObject({ liveAi: false, localAi: true });
  });
  it("keeps the two paid-provider switches unchanged", () => {
    expect(() => loadIntegrationConfig({ AI_PROVIDER_MODE: "live" })).toThrow(/ALLOW_LIVE_PROVIDER_CALLS/);
    expect(loadIntegrationConfig({ AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true" })).toMatchObject({ liveAi: true, localAi: false });
  });
});

describe("local mode: Ollama must be on this machine", () => {
  it.each(["http://127.0.0.1:11434/v1", "http://localhost:11434/v1", "http://[::1]:11434/v1"])("accepts %s", (u) => {
    expect(() => assertLoopbackUrl(u)).not.toThrow();
  });
  it.each([
    "http://192.168.1.20:11434/v1", "http://example.com/v1", "https://api.openai.com/v1", "http://localhost.evil.com/v1",
    "http://user:pw@127.0.0.1:11434/v1", "ftp://127.0.0.1/v1", "not a url",
  ])("refuses %s", (u) => {
    expect(() => assertLoopbackUrl(u)).toThrow();
  });
  it("refuses a remote host at construction, so it can never be selected", () => {
    expect(() => new OllamaProvider({ models: ["m"], enabled: true, baseURL: "http://10.0.0.5:11434/v1" })).toThrow(/this machine/);
  });
  it("a remote OLLAMA_BASE_URL stops the whole app at startup", () => {
    expect(() => buildContext({ db: makeCore().db, env: { AI_PROVIDER_MODE: "local", OLLAMA_BASE_URL: "http://203.0.113.9:11434/v1" } })).toThrow(/this machine/);
  });
});

describe("eligibility never mixes provider kinds", () => {
  const boot = (env: Record<string, string>) => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env, gateway: { sleep: async () => {} } });
    const ws = createWorkspace(ctx, "Acme").workspace;
    putBrain(ctx, ws.id, BRAIN);
    return { ctx, ws };
  };
  const usable = (env: Record<string, string>) => {
    const { ctx, ws } = boot(env);
    return listModels(ctx, ws.id).filter((m) => m.eligible).map((m) => `${m.provider}/${m.model}`);
  };

  it("mock mode: only the simulated model, even if Ollama is installed and keys are set", () => {
    expect(usable({ ...KEYS })).toEqual(["mock/mock-deterministic-1"]);
  });
  it("local mode: only the local model; mock and paid providers are not eligible, even with keys present", () => {
    expect(usable({ ...LOCAL, ...KEYS, ALLOW_LIVE_PROVIDER_CALLS: "true" })).toEqual(["ollama/llama3.1:latest"]);
  });
  it("live mode: only paid providers; neither the local nor the mock model is eligible", () => {
    const u = usable({ AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", ...KEYS });
    expect(u).not.toContain("ollama/llama3.1:latest");
    expect(u).not.toContain("mock/mock-deterministic-1");
    expect(u.length).toBeGreaterThan(0);
  });
  it("explains why in each mode", () => {
    const m = boot({ ...KEYS });
    expect(listModels(m.ctx, m.ws.id).find((x) => x.provider === "ollama")?.reason).toMatch(/local providers are disabled in mock mode/);
    const l = boot({ ...LOCAL });
    expect(listModels(l.ctx, l.ws.id).find((x) => x.provider === "mock")?.reason).toMatch(/simulated providers are disabled in local mode/);
    expect(listModels(l.ctx, l.ws.id).find((x) => x.provider === "openai")?.reason).toMatch(/live providers are disabled in local mode/);
  });
  it("asking for a paid model explicitly in local mode is refused before any request", async () => {
    const { ctx, ws } = boot({ ...LOCAL, ...KEYS });
    await expect(generateCampaign(ctx, ws.id, { providerId: "anthropic", model: "claude-haiku-5-5" })).rejects.toMatchObject({ kind: "not_eligible" });
  });
});

describe("OllamaProvider wire behavior (real SDK, mocked HTTP)", () => {
  const make = (f: typeof fetch, enabled = true) => new OllamaProvider({ models: ["llama3.1:latest"], enabled, fetch: f, baseURL: "http://127.0.0.1:11434/v1" });

  it("calls /v1/responses with the JSON schema and a placeholder key, and normalizes usage and the response id", async () => {
    const s = ollamaFetch([okResponse(JSON.stringify(BRIEF_OK))]);
    const r = await make(s.fetch).generateObject(req("llama3.1:latest"));
    expect(s.calls[0]).toMatchObject({ url: "http://127.0.0.1:11434/v1/responses", auth: "Bearer ollama" });
    expect(s.calls[0]!.body.text.format).toMatchObject({ type: "json_schema", strict: true });
    // A local server sends no x-request-id header, so there is NO server request id; the response id is kept as the response id and is not passed off as one.
    expect(r).toMatchObject({ raw: BRIEF_OK, simulated: false, usage: { inputTokens: 189, outputTokens: 247, source: "provider" } });
    expect(r.requestId).toBeUndefined();
    expect(r.meta).toMatchObject({ responseId: "resp_385873", requestId: null });
  });
  it("is unavailable and sends nothing unless local mode is on", async () => {
    const s = ollamaFetch([okResponse("{}")]);
    const p = make(s.fetch, false);
    expect(p.isAvailable()).toBe(false);
    await expect(p.generateObject(req("llama3.1:latest"))).rejects.toMatchObject({ kind: "provider_unavailable" });
    expect(s.calls).toHaveLength(0);
  });
  it("reports 'not running' as a retryable outage that names Ollama, not OpenAI", async () => {
    const err = (await make(ollamaFetch([new TypeError("fetch failed")]).fetch).generateObject(req("llama3.1:latest")).catch((e) => e)) as AiError;
    expect(err).toMatchObject({ kind: "provider_unavailable", retryable: true });
    expect(err.message).toContain("Ollama (local)");
    expect(err.message).not.toContain("OpenAI");
  });
  it("a model that is not installed (HTTP 404) is a request error, not a retry loop", async () => {
    const miss = { status: 404, body: { error: { message: "model not found", type: "not_found_error" } } };
    const err = (await make(ollamaFetch([miss]).fetch).generateObject(req("llama3.1:latest")).catch((e) => e)) as AiError;
    expect(err).toMatchObject({ kind: "invalid_request", retryable: false });
  });
  it("identifies as a local, non-simulated provider", () => {
    const p = make(ollamaFetch([]).fetch);
    expect(p).toMatchObject({ id: "ollama", simulated: false, local: true });
    expect(p.isAvailable()).toBe(true);
  });
});

describe("local mode end to end (fake local server)", () => {
  const registry = () => ModelRegistry.fromFile("config/ai-models.json");
  function setup(replies: Array<{ status?: number; body?: unknown } | Error>, repair: 0 | 1 = 0, env: Record<string, string> = { ...LOCAL, ...KEYS }) {
    const core = makeCore();
    const s = ollamaFetch(replies);
    const reg = registry();
    const ctx = buildContext({
      db: core.db, now: core.now, env, registry: reg, gateway: { sleep: async () => {}, repairAttempts: repair },
      aiProviders: [new OllamaProvider({ models: reg.modelsFor("ollama"), enabled: true, fetch: s.fetch })],
    });
    const ws = createWorkspace(ctx, "Acme").workspace;
    putBrain(ctx, ws.id, BRAIN);
    return { ctx, ws, s };
  }
  const task = { taskType: "campaign_brief", system: "s", prompt: "p", schemaHint: "{}", context: BRAIN, schema: CampaignBriefSchema };

  it("generates and stores a campaign from the local model, labelled local and not simulated", async () => {
    const { ctx, ws } = setup([okResponse(JSON.stringify(BRIEF_OK))]);
    const rec = await generateCampaign(ctx, ws.id);
    expect(rec.versions[0]).toMatchObject({ aiProvider: "ollama", aiModel: "llama3.1:latest" });
    expect(listUsage(ctx, ws.id)[0]).toMatchObject({ mode: "local", simulated: false, outcome: "ok", inputTokens: 189, outputTokens: 247, usageSource: "provider", costStatus: "local_no_charge", estimatedCostMicros: null });
  });
  it("reports 'no charge': never an invented price, and counted apart from live and simulated requests", async () => {
    const { ctx, ws } = setup([okResponse(JSON.stringify(BRIEF_OK))]);
    const r = await runAiTask(ctx, ws.id, task);
    expect(r).toMatchObject({ simulated: false, costStatus: "local_no_charge", estimatedCostMicros: null });
    expect(usageSummary(ctx, ws.id).today).toMatchObject({ localRequests: 1, liveRequests: 0, simulatedRequests: 0, requestsWithUnknownCost: 0, knownCostMicros: 0 });
  });
  it("local requests are not billable: daily and monthly limits never block them", async () => {
    const { ctx, ws } = setup(Array.from({ length: 3 }, () => okResponse(JSON.stringify(BRIEF_OK))));
    putAiSettings(ctx, ws.id, { routingMode: "automatic", maxRequestsPerDay: 1, monthlyBudgetMicros: 1 });
    for (let i = 0; i < 3; i++) await runAiTask(ctx, ws.id, task);
    expect(listUsage(ctx, ws.id).filter((r) => r.mode === "local")).toHaveLength(3);
  });
  it("rejects invalid structured output from a local model and stores nothing", async () => {
    const { ctx, ws } = setup([okResponse(JSON.stringify({ name: 7 }))]);
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(ctx.db.prepare("SELECT COUNT(*) n FROM campaigns").get()).toEqual({ n: 0 });
  });
  it("makes one repair attempt when enabled, then stores only the valid result", async () => {
    const { ctx, ws, s } = setup([okResponse(JSON.stringify({ name: 7 })), okResponse(JSON.stringify(BRIEF_OK))], 1);
    await generateCampaign(ctx, ws.id);
    expect(s.calls).toHaveLength(2);
    expect(listUsage(ctx, ws.id).reverse().map((r) => `${r.attemptKind}:${r.outcome}`)).toEqual(["initial:invalid_output", "repair:ok"]);
  });
  it("the connection test is a REAL request in local mode (free); a refused connection is reported as not connected", async () => {
    const good = setup([okResponse("pong")]);
    expect(await connectionTest(good.ctx, good.ws.id, "ollama", "llama3.1:latest")).toMatchObject({
      simulated: false, connected: true, message: expect.stringMatching(/local model server succeeded \(no charge\)/),
    });
    const down = setup(Array.from({ length: 3 }, () => new TypeError("fetch failed")));
    expect(await connectionTest(down.ctx, down.ws.id, "ollama", "llama3.1:latest")).toMatchObject({ simulated: false, connected: false, errorKind: "provider_unavailable" });
  });
  it("outside local mode the connection test refuses to contact Ollama", async () => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: {}, gateway: { sleep: async () => {} } });
    const ws = createWorkspace(ctx, "A").workspace;
    await expect(connectionTest(ctx, ws.id, "ollama", "llama3.1:latest")).rejects.toMatchObject({ kind: "live_disabled" });
  });
  it("a local model cannot execute anything: generation creates no proposal, job or external resource", async () => {
    const { ctx, ws } = setup([okResponse(JSON.stringify(BRIEF_OK))]);
    await generateCampaign(ctx, ws.id);
    for (const t of ["action_proposals", "approvals", "external_resources", "jobs", "sim_meta_campaigns", "sim_crm_contacts"]) {
      expect(ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });
  it("paid-provider keys in the environment stay unused in local mode", () => {
    const { ctx } = setup([]);
    expect(ctx.ai.list().filter((p) => !p.simulated && !p.local).every((p) => !p.available)).toBe(true);
  });
});

describe("per-model timeout for slow local models", () => {
  /** A local provider that needs ~80ms, against a 20ms gateway default. */
  const slow = (): AiProvider => ({
    id: "ollama", label: "slow", models: ["llama3.1:latest"], simulated: false, local: true, isAvailable: () => true,
    generateText: async () => ({ text: "pong", model: "llama3.1:latest", simulated: false }),
    // Like the real SDKs, abort when the signal fires; otherwise finish after 80ms.
    generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 80);
        r.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new AiError("cancelled", "aborted")); }, { once: true });
      });
      return { raw: BRIEF_OK, model: "llama3.1:latest", simulated: false };
    },
  });
  const run = async (timeoutMs: number | undefined) => {
    const core = makeCore();
    const base = ModelRegistry.fromFile("config/ai-models.json").entries.map((e) => (e.provider === "ollama" ? { ...e, timeoutMs } : e));
    const ctx = buildContext({ db: core.db, now: core.now, env: LOCAL, registry: new ModelRegistry(base), aiProviders: [slow()], gateway: { timeoutMs: 20, maxRetries: 0, repairAttempts: 0, sleep: async () => {} } });
    const ws = createWorkspace(ctx, "A").workspace;
    putBrain(ctx, ws.id, BRAIN);
    return runAiTask(ctx, ws.id, { taskType: "campaign_brief", system: "s", prompt: "p", schemaHint: "{}", context: BRAIN, schema: CampaignBriefSchema });
  };

  it("without a model timeout the gateway default applies and the slow call times out", async () => {
    await expect(run(undefined)).rejects.toMatchObject({ kind: "timeout" });
  });
  it("with the registry's per-model timeout the same slow call succeeds", async () => {
    await expect(run(2000)).resolves.toMatchObject({ provider: "ollama", simulated: false });
  });
  it("the shipped registry gives the local model a long timeout", () => {
    expect(ModelRegistry.fromFile("config/ai-models.json").find("ollama", "llama3.1:latest")?.timeoutMs).toBeGreaterThanOrEqual(120_000);
  });
});

describe("temperature and context-window safeguards for local models", () => {
  const mk = (extraEnv: Record<string, string> = {}, reply: unknown = BRIEF_OK) => {
    const core = makeCore();
    const s = ollamaFetch(Array.from({ length: 4 }, () => okResponse(JSON.stringify(reply))));
    const reg = ModelRegistry.fromFile("config/ai-models.json");
    const ctx = buildContext({
      db: core.db, now: core.now, env: { ...LOCAL, ...extraEnv }, registry: reg, gateway: { sleep: async () => {}, repairAttempts: 0 },
      aiProviders: [new OllamaProvider({ models: reg.modelsFor("ollama"), temperatureByModel: reg.temperatureFor("ollama"), enabled: true, fetch: s.fetch })],
    });
    const ws = createWorkspace(ctx, "Acme").workspace;
    putBrain(ctx, ws.id, BRAIN);
    return { ctx, ws, s, reg };
  };
  const task = (over: object = {}) => ({ taskType: "campaign_brief", system: "s", prompt: "p", schemaHint: "{}", context: BRAIN, schema: CampaignBriefSchema, ...over });

  it("the shipped registry sets temperature 0 and a 4096-token context for the local model", () => {
    const e = ModelRegistry.fromFile("config/ai-models.json").find("ollama", "llama3.1:latest");
    expect(e).toMatchObject({ temperature: 0, contextTokens: 4096 });
  });
  it("sends temperature 0 on the wire (zero is a setting, not 'unset')", async () => {
    const { ctx, ws, s } = mk();
    await runAiTask(ctx, ws.id, task());
    expect(s.calls[0]!.body.temperature).toBe(0);
  });
  it("sends no temperature for a model with none configured", async () => {
    const s = ollamaFetch([okResponse(JSON.stringify(BRIEF_OK))]);
    await new OllamaProvider({ models: ["m"], enabled: true, fetch: s.fetch }).generateObject(req("m"));
    expect("temperature" in s.calls[0]!.body).toBe(false);
  });
  it("refuses a prompt that would not fit the context window, and sends NOTHING", async () => {
    const { ctx, ws, s } = mk();
    const err = (await runAiTask(ctx, ws.id, task({ prompt: "x".repeat(20_000) })).catch((e) => e)) as AiError;
    expect(err).toMatchObject({ kind: "invalid_request" });
    expect(err.message).toMatch(/too large.*4096-token context.*Nothing was sent/);
    expect(s.calls).toHaveLength(0);
  });
  it("counts the output cap too: a cap that cannot fit alongside the prompt is refused", async () => {
    const { ctx, ws, s } = mk({ AI_MAX_OUTPUT_TOKENS: "5000" });
    await expect(runAiTask(ctx, ws.id, task())).rejects.toMatchObject({ kind: "invalid_request" });
    expect(s.calls).toHaveLength(0);
  });
  it("a normal-sized request passes the guard, including a large but legal Business Brain", async () => {
    const big = { ...BRAIN, services: Array.from({ length: 20 }, (_, i) => `Service number ${i} ${"x".repeat(80)}`), differentiators: Array.from({ length: 10 }, (_, i) => `Differentiator ${i} ${"y".repeat(150)}`) };
    // the scripted local model answers with a brief that is valid FOR THIS brain (one decision per differentiator)
    const { ctx, ws, s } = mk({ AI_MAX_OUTPUT_TOKENS: "900" }, buildMockBrief(BusinessBrainSchema.parse(big))); // a 4096-token window must leave room for the longer prompt
    putBrain(ctx, ws.id, big);
    await expect(generateCampaign(ctx, ws.id)).resolves.toBeDefined();
    expect(s.calls).toHaveLength(1);
  });
  it("models without a configured context are not guarded (remote providers manage their own)", async () => {
    const core = makeCore();
    const reg = ModelRegistry.fromFile("config/ai-models.json");
    expect(reg.find("anthropic", "claude-haiku-5-5")?.contextTokens).toBeUndefined();
    void core;
  });
});
