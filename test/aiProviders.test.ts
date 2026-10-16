import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/ai/anthropicProvider.js";
import { OpenAIProvider } from "../src/ai/openaiProvider.js";
import { AiError, type AiProvider } from "../src/ai/types.js";
import { CampaignBriefSchema, BusinessBrainSchema } from "../src/domain/schemas.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { BRAIN } from "./fixtures.js";

const KEY = "sk-test-SECRET-KEY-123";
const BRIEF = {
  name: "Sunrise - Plumbing Leads", objective: "OUTCOME_LEADS", headlines: ["Fast plumbing"], primaryTexts: ["Call today"],
  callToAction: "GET_QUOTE", audience: { locations: ["Austin, TX"], ageMin: 25, ageMax: 65, interests: ["Home"] },
  dailyBudgetCents: 1500, rationale: "r", assumptions: [], openQuestions: ["License number?"],
};

interface Captured { url: string; headers: Record<string, string>; body: any }
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error | ((init: RequestInit) => Promise<Response>);

/** A fetch that records requests and replays scripted replies. The REAL SDKs run on top of it. */
function scripted(replies: Reply[]) {
  const captured: Captured[] = [];
  const fn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const h: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => (h[k.toLowerCase()] = v));
    captured.push({ url: String(url), headers: h, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const next = replies.shift();
    if (!next) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next(init);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "content-type": "application/json", ...(next.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fetch: fn, captured };
}

const req = (model: string, extra: object = {}) => ({
  task: "campaign_brief", system: "sys", prompt: "business data here", schemaHint: CAMPAIGN_BRIEF_HINT,
  jsonSchema: CAMPAIGN_BRIEF_JSON_SCHEMA as unknown as Record<string, unknown>,
  context: BusinessBrainSchema.parse(BRAIN), schema: CampaignBriefSchema, model, ...extra,
});

interface Flavor {
  name: string;
  model: string;
  make: (f: typeof fetch, key?: string) => AiProvider;
  ok: (text: string, usage?: object | null) => Reply;
  http: (status: number, extra?: object, headers?: Record<string, string>) => Reply;
  cutOff: Reply;
  refusal: Reply;
  endpoint: RegExp;
  assertStructuredRequest: (b: any) => void;
}

const openai: Flavor = {
  name: "OpenAI", model: "test-model",
  make: (f, key = KEY) => new OpenAIProvider({ apiKey: key, models: ["test-model"], fetch: f }),
  ok: (text, usage) => ({
    headers: { "x-request-id": "req_openai_1" },
    body: { id: "resp_1", object: "response", status: "completed", model: "test-model", output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], ...(usage === null ? {} : { usage: usage ?? { input_tokens: 120, output_tokens: 80, total_tokens: 200 } }) },
  }),
  http: (status, extra = {}, headers = {}) => ({ status, headers, body: { error: { message: "secret prompt echo: business data here", type: "x", code: null, ...extra } } }),
  cutOff: { body: { id: "r", object: "response", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
  refusal: { body: { id: "r", object: "response", status: "completed", output: [{ type: "message", role: "assistant", id: "m", status: "completed", content: [{ type: "refusal", refusal: "no" }] }] } },
  endpoint: /\/responses$/,
  assertStructuredRequest: (b) => {
    expect(b.model).toBe("test-model");
    expect(b.text.format).toMatchObject({ type: "json_schema", strict: true, name: "campaign_brief" });
    expect(b.text.format.schema.additionalProperties).toBe(false);
  },
};

const anthropic: Flavor = {
  name: "Anthropic", model: "test-model",
  make: (f, key = KEY) => new AnthropicProvider({ apiKey: key, models: ["test-model"], fetch: f }),
  ok: (text, usage) => ({
    headers: { "request-id": "req_anthropic_1" },
    body: { id: "msg_1", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, ...(usage === null ? {} : { usage: usage ?? { input_tokens: 120, output_tokens: 80 } }) },
  }),
  http: (status, extra = {}, headers = {}) => ({ status, headers, body: { type: "error", error: { type: "x", message: "secret prompt echo: business data here", ...extra } } }),
  cutOff: { body: { id: "m", type: "message", role: "assistant", model: "t", content: [{ type: "text", text: '{"name":' }], stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 } } },
  refusal: { body: { id: "m", type: "message", role: "assistant", model: "t", content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } } },
  endpoint: /\/messages$/,
  assertStructuredRequest: (b) => {
    expect(b.model).toBe("test-model");
    expect(b.output_config.format).toMatchObject({ type: "json_schema" });
    expect(b.output_config.format.schema.additionalProperties).toBe(false);
  },
};

for (const f of [openai, anthropic]) {
  describe(`${f.name} adapter (official SDK, mocked HTTP only)`, () => {
    it("is unavailable without a server-side key, and lists only configured models", () => {
      const p = f.make(scripted([]).fetch, "");
      expect(p.isAvailable()).toBe(false);
      expect(f.make(scripted([]).fetch).models).toEqual(["test-model"]);
    });

    it("translates a structured request and normalizes the response (usage, request id, latency-free raw)", async () => {
      const s = scripted([f.ok(JSON.stringify(BRIEF))]);
      const r = await f.make(s.fetch).generateObject(req("test-model"));
      expect(r.raw).toEqual(BRIEF);
      expect(r).toMatchObject({ model: "test-model", simulated: false, usage: { inputTokens: 120, outputTokens: 80, source: "provider" } });
      expect(r.requestId).toMatch(/^req_/);
      expect(s.captured[0]!.url).toMatch(f.endpoint);
      f.assertStructuredRequest(s.captured[0]!.body);
      expect(JSON.stringify(s.captured[0]!.body)).toContain("business data here");
    });

    it("sends the key only in a header, never in the URL or body", async () => {
      const s = scripted([f.ok(JSON.stringify(BRIEF))]);
      await f.make(s.fetch).generateObject(req("test-model"));
      const c = s.captured[0]!;
      expect(c.url).not.toContain(KEY);
      expect(JSON.stringify(c.body)).not.toContain(KEY);
      expect(Object.values(c.headers).some((v) => v.includes(KEY))).toBe(true);
    });

    it("reports missing usage as unknown, never zero", async () => {
      const r = await f.make(scripted([f.ok(JSON.stringify(BRIEF), null)]).fetch).generateObject(req("test-model"));
      expect(r.usage).toBeUndefined();
    });

    it("keeps a provider-reported zero as zero", async () => {
      const u = f === openai ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 } : { input_tokens: 0, output_tokens: 0 };
      const r = await f.make(scripted([f.ok(JSON.stringify(BRIEF), u)]).fetch).generateObject(req("test-model"));
      expect(r.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    });

    it("generates plain text", async () => {
      const r = await f.make(scripted([f.ok("pong")]).fetch).generateText({ task: "connection_test", system: "s", prompt: "ping", model: "test-model", maxOutputTokens: 16 });
      expect(r.text).toBe("pong");
    });

    const errorCases: Array<[string, () => Reply, string, boolean]> = [
      ["401 -> auth", () => f.http(401), "auth", false],
      ["403 -> auth", () => f.http(403), "auth", false],
      ["429 -> rate_limit (retryable)", () => f.http(429, {}, { "retry-after": "2" }), "rate_limit", true],
      ["429 insufficient_quota -> insufficient_balance", () => f.http(429, { type: "insufficient_quota", code: "insufficient_quota" }), "insufficient_balance", false],
      ["400 credit balance -> insufficient_balance", () => f.http(400, { message: "Your credit balance is too low" }), "insufficient_balance", false],
      ["400 -> invalid_request", () => f.http(400), "invalid_request", false],
      ["500 -> provider_unavailable (retryable)", () => f.http(500), "provider_unavailable", true],
      ["529 overloaded -> provider_unavailable (retryable)", () => f.http(529), "provider_unavailable", true],
    ];
    for (const [label, reply, kind, retryable] of errorCases) {
      it(`normalizes ${label} without leaking the key or the provider's message`, async () => {
        const s = scripted([reply()]);
        const err = (await f.make(s.fetch).generateObject(req("test-model")).catch((e) => e)) as AiError;
        expect(err).toBeInstanceOf(AiError);
        expect(err.kind).toBe(kind);
        expect(err.retryable).toBe(retryable);
        expect(err.message).not.toContain(KEY);
        expect(err.message).not.toContain("business data here");
        expect(s.captured).toHaveLength(1); // the SDK itself did not retry: the gateway owns retries
      });
    }

    it("surfaces retry-after as retryAfterMs", async () => {
      const err = (await f.make(scripted([f.http(429, {}, { "retry-after": "3" })]).fetch).generateObject(req("test-model")).catch((e) => e)) as AiError;
      expect(err.retryAfterMs).toBe(3000);
    });

    it("maps a network failure to a retryable provider_unavailable", async () => {
      const err = (await f.make(scripted([new TypeError("fetch failed")]).fetch).generateObject(req("test-model")).catch((e) => e)) as AiError;
      expect(err).toMatchObject({ kind: "provider_unavailable", retryable: true });
    });

    it("treats malformed JSON, cut-off output and refusals as invalid_output", async () => {
      for (const reply of [f.ok("this is not json"), f.cutOff, f.refusal]) {
        const err = (await f.make(scripted([reply]).fetch).generateObject(req("test-model")).catch((e) => e)) as AiError;
        expect(err.kind).toBe("invalid_output");
      }
    });

    it("respects cancellation (already aborted, and aborted mid-request)", async () => {
      const pre = new AbortController();
      pre.abort();
      const e1 = (await f.make(scripted([f.ok(JSON.stringify(BRIEF))]).fetch).generateObject(req("test-model", { signal: pre.signal })).catch((e) => e)) as AiError;
      expect(e1.kind).toBe("cancelled");

      const mid = new AbortController();
      const hang = (init: RequestInit) =>
        new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      const p = f.make(scripted([hang]).fetch).generateObject(req("test-model", { signal: mid.signal })).catch((e) => e);
      setTimeout(() => mid.abort(), 20);
      expect(((await p) as AiError).kind).toBe("cancelled");
    });
  });
}

describe("reasoning effort is sent to bound hidden reasoning tokens", () => {
  const cases: Array<[string, (f: typeof fetch, effort?: string) => AiProvider, Reply, (b: any) => unknown, (b: any) => unknown]> = [
    ["OpenAI", (f, e) => new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: f, effortByModel: e ? { "test-model": e } : {} }), openai.ok(JSON.stringify(BRIEF)), (b) => b.reasoning, (b) => b.reasoning],
    ["Anthropic", (f, e) => new AnthropicProvider({ apiKey: KEY, models: ["test-model"], fetch: f, effortByModel: e ? { "test-model": e } : {} }), anthropic.ok(JSON.stringify(BRIEF)), (b) => b.output_config?.effort, (b) => b.output_config],
  ];
  for (const [name, make, reply, effort, cfg] of cases) {
    it(`${name}: structured request carries the configured effort`, async () => {
      const s = scripted([reply]);
      await make(s.fetch, name === "OpenAI" ? "none" : "low").generateObject(req("test-model"));
      expect(effort(s.captured[0]!.body)).toEqual(name === "OpenAI" ? { effort: "none" } : "low");
      if (name === "Anthropic") expect((cfg(s.captured[0]!.body) as { format: { type: string } }).format.type).toBe("json_schema"); // effort did not displace the schema
    });
    it(`${name}: text request carries the configured effort`, async () => {
      const s = scripted([reply]);
      await make(s.fetch, name === "OpenAI" ? "none" : "low").generateText({ task: "connection_test", system: "s", prompt: "p", model: "test-model" });
      expect(effort(s.captured[0]!.body)).toEqual(name === "OpenAI" ? { effort: "none" } : "low");
    });
    it(`${name}: sends no effort when none is configured`, async () => {
      const s = scripted([reply]);
      await make(s.fetch).generateObject(req("test-model"));
      expect(effort(s.captured[0]!.body)).toBeUndefined();
    });
  }

  it("bounds output tokens on the wire for both providers", async () => {
    for (const [make, reply, field] of [
      [(f: typeof fetch) => new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: f }), openai.ok(JSON.stringify(BRIEF)), "max_output_tokens"],
      [(f: typeof fetch) => new AnthropicProvider({ apiKey: KEY, models: ["test-model"], fetch: f }), anthropic.ok(JSON.stringify(BRIEF)), "max_tokens"],
    ] as const) {
      const s = scripted([reply]);
      await make(s.fetch).generateObject(req("test-model", { maxOutputTokens: 321 }));
      expect(s.captured[0]!.body[field]).toBe(321);
    }
  });
});

describe("field limits are always told to the model (regression: found by the real Ollama measurement)", () => {
  // The JSON schema sent for native structured output deliberately carries no length limits (providers' strict modes reject them),
  // so the human-readable limits MUST reach the model another way, or it produces briefs that fail validation every time.
  const LIMITS = /each <= 40 chars/;
  const cases: Array<[string, (f: typeof fetch) => AiProvider, Reply, (b: any) => string]> = [
    ["OpenAI", (f) => new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: f }), openai.ok(JSON.stringify(BRIEF)), (b) => b.instructions],
    ["Anthropic", (f) => new AnthropicProvider({ apiKey: KEY, models: ["test-model"], fetch: f }), anthropic.ok(JSON.stringify(BRIEF)), (b) => b.system],
  ];
  for (const [name, make, reply, sysOf] of cases) {
    it(`${name}: the schema hint is in the instructions even when a JSON schema is supplied`, async () => {
      const s = scripted([reply]);
      await make(s.fetch).generateObject(req("test-model"));
      expect(s.captured[0]!.body.text?.format?.type ?? s.captured[0]!.body.output_config?.format?.type).toBe("json_schema"); // native mode really is on
      expect(sysOf(s.captured[0]!.body)).toMatch(LIMITS);
      expect(sysOf(s.captured[0]!.body)).toContain("sys"); // the caller's own system prompt is kept
    });
    it(`${name}: the hint is also present when there is no JSON schema`, async () => {
      const s = scripted([reply]);
      await make(s.fetch).generateObject({ ...req("test-model"), jsonSchema: undefined });
      expect(sysOf(s.captured[0]!.body)).toMatch(LIMITS);
    });
  }
});

describe("a cut-off response is billed, so its usage travels with the error (regression: Milestone 3 live run)", () => {
  for (const [name, make, reply] of [
    ["OpenAI", (f: typeof fetch) => new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: f }), openai.cutOff],
    ["Anthropic", (f: typeof fetch) => new AnthropicProvider({ apiKey: KEY, models: ["test-model"], fetch: f }), anthropic.cutOff],
  ] as const) {
    it(`${name}: the error reports the tokens used and says it was truncated`, async () => {
      const s = scripted([reply]);
      const err = (await make(s.fetch).generateObject(req("test-model")).catch((e) => e)) as AiError;
      expect(err).toMatchObject({ kind: "invalid_output", truncated: true });
      expect(err.usage).toMatchObject({ inputTokens: 1, outputTokens: 1, source: "provider" });
    });
  }
});

describe("the processing tier is pinned on request and read back (it changes the price)", () => {
  const withTier = (tier: string | undefined) => {
    const r = openai.ok(JSON.stringify(BRIEF)) as { body: Record<string, unknown> };
    if (tier) r.body.service_tier = tier;
    return r as unknown as Reply;
  };
  it("sends service_tier when one is configured and returns what the provider reports", async () => {
    const s = scripted([withTier("default")]);
    const out = await new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: s.fetch, serviceTier: "default" }).generateObject(req("test-model"));
    expect(s.captured[0]!.body.service_tier).toBe("default");
    expect(out.serviceTier).toBe("default");
  });
  it("sends nothing about the tier when none is configured (existing behaviour is unchanged)", async () => {
    const s = scripted([withTier(undefined)]);
    const out = await new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: s.fetch }).generateObject(req("test-model"));
    expect("service_tier" in s.captured[0]!.body).toBe(false);
    expect(out.serviceTier).toBeUndefined();
  });
  it("reports a different tier as it came, so a caller can refuse it", async () => {
    const s = scripted([withTier("priority")]);
    const out = await new OpenAIProvider({ apiKey: KEY, models: ["test-model"], fetch: s.fetch, serviceTier: "default" }).generateObject(req("test-model"));
    expect(out.serviceTier).toBe("priority");
  });
  it("the Anthropic adapter is unaffected", async () => {
    const s = scripted([anthropic.ok(JSON.stringify(BRIEF))]);
    await new AnthropicProvider({ apiKey: KEY, models: ["test-model"], fetch: s.fetch }).generateObject(req("test-model"));
    expect("service_tier" in s.captured[0]!.body).toBe(false);
  });
});
