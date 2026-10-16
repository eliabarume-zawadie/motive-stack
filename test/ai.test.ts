import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { AnthropicProvider } from "../src/ai/anthropicProvider.js";
import { OpenAIProvider } from "../src/ai/openaiProvider.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { PricingTable } from "../src/ai/pricing.js";
import { AiError, type AiProvider } from "../src/ai/types.js";
import { BusinessBrainSchema, CampaignBriefSchema } from "../src/domain/schemas.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { BRAIN } from "./fixtures.js";
import { req } from "./briefFixture.js";
import { readFileSync } from "node:fs";

/** The contract EVERY provider (mock or real) must satisfy, through the gateway. */
function providerContract(name: string, make: () => AiProvider, model: string, skip?: string) {
  const d = skip ? describe.skip : describe;
  d(`AiProvider contract: ${name}${skip ? ` (SKIPPED: ${skip})` : ""}`, () => {
    it("declares identity, models and a simulated flag", () => {
      const p = make();
      expect(p.id).toBeTruthy();
      expect(p.models).toContain(model);
      expect(typeof p.simulated).toBe("boolean");
    });
    it("returns schema-valid structured output with latency, through the gateway", async () => {
      const p = make();
      const out = await new AiGateway([p]).generate(p.id, req(model));
      expect(CampaignBriefSchema.safeParse(out.structuredOutput).success).toBe(true);
      expect(out.latencyMs).toBeGreaterThanOrEqual(0);
      expect(out.simulated).toBe(p.simulated);
    });
    it("generates text", async () => {
      const p = make();
      const out = await new AiGateway([p]).generateText(p.id, { task: "connection_test", system: "s", prompt: "Reply with the word pong.", model, maxOutputTokens: 16 });
      expect(out.text?.length).toBeGreaterThan(0);
    });
  });
}

providerContract("mock", () => new MockAiProvider(), "mock-deterministic-1");

// Real providers: run ONLY with full explicit opt-in. Otherwise reported as skipped, never faked, never calling out.
const env = process.env;
const liveOptIn = env.LIVE_TESTS === "1" && env.AI_PROVIDER_MODE === "live" && env.ALLOW_LIVE_PROVIDER_CALLS === "true";
const LIVE_HINT = "set LIVE_TESTS=1 AI_PROVIDER_MODE=live ALLOW_LIVE_PROVIDER_CALLS=true plus the provider key and *_LIVE_TEST_MODEL";
providerContract(
  "anthropic (live)",
  () => new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, models: [env.ANTHROPIC_LIVE_TEST_MODEL ?? ""] }),
  env.ANTHROPIC_LIVE_TEST_MODEL ?? "unset",
  liveOptIn && env.ANTHROPIC_API_KEY && env.ANTHROPIC_LIVE_TEST_MODEL ? undefined : LIVE_HINT,
);
providerContract(
  "openai (live)",
  () => new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, models: [env.OPENAI_LIVE_TEST_MODEL ?? ""] }),
  env.OPENAI_LIVE_TEST_MODEL ?? "unset",
  liveOptIn && env.OPENAI_API_KEY && env.OPENAI_LIVE_TEST_MODEL ? undefined : LIVE_HINT,
);

describe("mock provider", () => {
  it("is deterministic, including request ids and simulated usage", async () => {
    const g = new AiGateway([new MockAiProvider()]);
    const a = await g.generate("mock", req("mock-deterministic-1"));
    const b = await g.generate("mock", req("mock-deterministic-1"));
    expect(a.structuredOutput).toEqual(b.structuredOutput);
    expect(a.requestId).toBe(b.requestId);
    expect(a.usage).toEqual(b.usage);
  });
  it("labels everything simulated and has no cost", async () => {
    const out = await new AiGateway([new MockAiProvider()]).generate("mock", req("mock-deterministic-1"));
    expect(out).toMatchObject({ simulated: true, costStatus: "not_applicable", estimatedCostMicros: null, usage: { source: "simulated" } });
  });
  it("never exceeds the budget cap and keeps unknown facts explicit", async () => {
    const out = await new AiGateway([new MockAiProvider()]).generate("mock", req("mock-deterministic-1"));
    const o = out.structuredOutput!;
    expect(o.dailyBudgetCents).toBeLessThan(BRAIN.maxDailyBudgetCents); // the ceiling is a limit, not a target
    expect((o.budgetRationale ?? "").length).toBeGreaterThan(20);
    expect((o.targeting?.uncertainties ?? []).length).toBeGreaterThan(0);
    expect((o.assumptions ?? []).length).toBeGreaterThan(0);
  });
});

describe("campaign JSON schema stays in sync with the zod schema", () => {
  it("requires exactly the zod keys, at the top level and for audience", () => {
    const zodKeys = Object.keys((CampaignBriefSchema as unknown as { shape: Record<string, unknown> }).shape).sort();
    expect([...CAMPAIGN_BRIEF_JSON_SCHEMA.required].sort()).toEqual(zodKeys);
    expect(Object.keys(CAMPAIGN_BRIEF_JSON_SCHEMA.properties).sort()).toEqual(zodKeys);
    expect(CAMPAIGN_BRIEF_JSON_SCHEMA.additionalProperties).toBe(false);
  });
  it("uses no keywords that providers' strict modes reject", () => {
    const text = JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA);
    for (const k of ["minLength", "maxLength", "minimum", "maximum", "maxItems", "minItems", "pattern", "format"]) expect(text).not.toContain(`"${k}"`);
  });
});

describe("AiGateway basics", () => {
  it("lists providers with availability and simulated flags", () => {
    const g = new AiGateway([new MockAiProvider(), new AnthropicProvider({ models: ["m"] })]);
    expect(g.list()).toEqual([
      { id: "mock", label: expect.any(String), models: ["mock-deterministic-1"], available: true, simulated: true, local: false },
      { id: "anthropic", label: expect.any(String), models: ["m"], available: false, simulated: false, local: false },
    ]);
  });
  it("rejects unknown providers and models, and unavailable providers", async () => {
    const g = new AiGateway([new MockAiProvider(), new AnthropicProvider({ models: ["m"] })]);
    await expect(g.generate("nope", req("x"))).rejects.toMatchObject({ kind: "unknown_provider" });
    await expect(g.generate("mock", req("nope"))).rejects.toMatchObject({ kind: "unknown_model" });
    await expect(g.generate("anthropic", req("m"))).rejects.toMatchObject({ kind: "provider_unavailable" });
  });
  it("rejects model output that fails the schema (after the bounded repair attempt)", async () => {
    const g = new AiGateway([new MockAiProvider("invalid")]);
    const err = (await g.generate("mock", req("mock-deterministic-1")).catch((e) => e)) as AiError;
    expect(err.kind).toBe("invalid_output");
    expect(err.attempts.map((a) => a.kind)).toEqual(["initial", "repair"]);
  });
});

describe("registry and pricing configuration files", () => {
  it("the shipped registry parses, has unique entries, and includes mock, anthropic and openai", () => {
    const r = ModelRegistry.fromFile("config/ai-models.json");
    expect(r.providers()).toEqual(expect.arrayContaining(["mock", "anthropic", "openai"]));
    expect(r.modelsFor("mock")).toEqual(["mock-deterministic-1"]);
  });
  it("rejects duplicate registry entries", () => {
    const e = { provider: "x", model: "m", label: "l", tasks: ["t"] } as never;
    expect(() => new ModelRegistry([e, e])).toThrow(/Duplicate/);
  });
});
