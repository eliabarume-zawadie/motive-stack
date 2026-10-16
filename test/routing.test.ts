import { describe, expect, it } from "vitest";
import type { ProviderInfo } from "../src/ai/gateway.js";
import { ModelRegistry, type ModelEntry } from "../src/ai/registry.js";
import { route, type RoutingSettings } from "../src/ai/router.js";
import { AiError } from "../src/ai/types.js";

const entry = (provider: string, model: string, costTier: ModelEntry["costTier"] = "medium", extra: Partial<ModelEntry> = {}): ModelEntry => ({
  provider, model, label: `${provider}/${model}`, enabled: true, tasks: ["campaign_brief"], capabilities: { text: true, structuredOutput: true }, costTier, ...extra,
});
const info = (id: string, simulated: boolean, available = true, local = false): ProviderInfo => ({ id, label: id, models: [], available, simulated, local });

const REG = new ModelRegistry([
  entry("mock", "m", "low"),
  entry("anthropic", "haiku", "low"),
  entry("anthropic", "opus", "high"),
  entry("openai", "gpt-a", "medium"),
]);
// providers advertise every registry model so "served by adapter" passes
const providers = (over: Record<string, Partial<ProviderInfo>> = {}): ProviderInfo[] =>
  [info("mock", true), info("anthropic", false), info("openai", false)].map((p) => ({
    ...p, models: REG.entries.filter((e) => e.provider === p.id).map((e) => e.model), ...(over[p.id] ?? {}),
  }));

const S = (o: Partial<RoutingSettings> = {}): RoutingSettings => ({
  routingMode: "automatic", provider: null, model: null, fallbackProvider: null, fallbackModel: null, allowedProviders: null, ...o,
});
const base = { task: "campaign_brief", needsStructuredOutput: true, registry: REG };
const ids = (cs: Array<{ provider: string; model: string }>) => cs.map((c) => `${c.provider}/${c.model}`);

describe("eligibility is evaluated before any selection", () => {
  it("mock mode only ever offers simulated providers; live mode only real ones", () => {
    expect(ids(route({ ...base, settings: S(), providers: providers(), aiMode: "mock" }))).toEqual(["mock/m"]);
    expect(ids(route({ ...base, settings: S(), providers: providers(), aiMode: "live" }))).toEqual(["anthropic/haiku"]);
  });
  it("skips unavailable providers (no key) and disabled models", () => {
    const reg = new ModelRegistry([entry("anthropic", "haiku", "low", { enabled: false }), entry("openai", "gpt-a")]);
    const ps = [info("anthropic", false), { ...info("openai", false), models: ["gpt-a"] }];
    expect(ids(route({ ...base, registry: reg, settings: S(), providers: ps, aiMode: "live" }))).toEqual(["openai/gpt-a"]);
    expect(() => route({ ...base, registry: reg, settings: S(), providers: [info("anthropic", false, false), { ...info("openai", false, false), models: ["gpt-a"] }], aiMode: "live" })).toThrow(/No eligible model/);
  });
  it("requires the task and structured-output capability", () => {
    const reg = new ModelRegistry([entry("anthropic", "x", "low", { capabilities: { text: true, structuredOutput: false } }), entry("openai", "gpt-a", "low", { tasks: ["other"] })]);
    expect(() => route({ ...base, registry: reg, settings: S(), providers: [{ ...info("anthropic", false), models: ["x"] }, { ...info("openai", false), models: ["gpt-a"] }], aiMode: "live" })).toThrow(AiError);
  });
  it("enforces the workspace data policy allow-list", () => {
    const r = route({ ...base, settings: S({ allowedProviders: ["openai"] }), providers: providers(), aiMode: "live" });
    expect(ids(r)).toEqual(["openai/gpt-a"]);
  });
});

describe("manual routing", () => {
  it("uses exactly the chosen model, with no fallback", () => {
    const r = route({ ...base, settings: S({ routingMode: "manual", provider: "anthropic", model: "opus" }), providers: providers(), aiMode: "live" });
    expect(r).toEqual([{ provider: "anthropic", model: "opus", role: "manual" }]);
  });
  it("refuses (rather than substituting) an ineligible choice", () => {
    expect(() => route({ ...base, settings: S({ routingMode: "manual", provider: "openai", model: "gpt-a" }), providers: providers({ openai: { available: false } }), aiMode: "live" })).toThrow(/cannot be used.*not available/);
    expect(() => route({ ...base, settings: S({ routingMode: "manual", provider: "openai", model: "gpt-a", allowedProviders: ["anthropic"] }), providers: providers(), aiMode: "live" })).toThrow(/data policy/);
  });
  it("an explicit per-request override beats the saved settings and is single-candidate", () => {
    const r = route({ ...base, settings: S({ routingMode: "preferred_with_fallback", provider: "anthropic", model: "haiku", fallbackProvider: "openai", fallbackModel: "gpt-a" }), providers: providers(), aiMode: "live", override: { provider: "openai", model: "gpt-a" } });
    expect(ids(r)).toEqual(["openai/gpt-a"]);
  });
  it("rejects an unknown model", () => {
    expect(() => route({ ...base, settings: S({ routingMode: "manual", provider: "anthropic", model: "nope" }), providers: providers(), aiMode: "live" })).toThrow(/not in the registry/);
  });
});

describe("automatic routing is deterministic", () => {
  it("prefers the lowest cost tier, then provider id, then model id", () => {
    const reg = new ModelRegistry([entry("zeta", "a", "low"), entry("alpha", "z", "low"), entry("alpha", "b", "low"), entry("mid", "m", "medium")]);
    const ps = reg.providers().map((id) => ({ ...info(id, false), models: reg.modelsFor(id) }));
    const first = route({ ...base, registry: reg, settings: S(), providers: ps, aiMode: "live" });
    expect(ids(first)).toEqual(["alpha/b"]);
    expect(route({ ...base, registry: reg, settings: S(), providers: [...ps].reverse(), aiMode: "live" })).toEqual(first); // input order does not matter
  });
});

describe("preferred with fallback", () => {
  const pf = (o: Partial<RoutingSettings> = {}) => S({ routingMode: "preferred_with_fallback", provider: "anthropic", model: "haiku", fallbackProvider: "openai", fallbackModel: "gpt-a", ...o });

  it("returns the preferred model then the fallback", () => {
    expect(route({ ...base, settings: pf(), providers: providers(), aiMode: "live" }).map((c) => c.role)).toEqual(["primary", "fallback"]);
  });
  it("never includes a fallback that the data policy forbids", () => {
    const r = route({ ...base, settings: pf({ allowedProviders: ["anthropic"] }), providers: providers(), aiMode: "live" });
    expect(ids(r)).toEqual(["anthropic/haiku"]);
  });
  it("never includes a fallback that is unavailable or the same as the preferred model", () => {
    expect(ids(route({ ...base, settings: pf(), providers: providers({ openai: { available: false } }), aiMode: "live" }))).toEqual(["anthropic/haiku"]);
    expect(ids(route({ ...base, settings: pf({ fallbackProvider: "anthropic", fallbackModel: "haiku" }), providers: providers(), aiMode: "live" }))).toEqual(["anthropic/haiku"]);
  });
  it("fails if the PREFERRED model is ineligible instead of silently switching to the fallback", () => {
    expect(() => route({ ...base, settings: pf(), providers: providers({ anthropic: { available: false } }), aiMode: "live" })).toThrow(/cannot be used/);
  });
});
