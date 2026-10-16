import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { PricingTable } from "../src/ai/pricing.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { currentGenerationIdentity } from "../src/app/versions.js";
import { BusinessBrainSchema } from "../src/domain/schemas.js";
import { EVALUATOR_VERSION } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { makeLiveGenerator } from "../src/eval/liveRun.js";
import { originalGenerationIdentity } from "../src/eval/original.js";

const price = new PricingTable("USD", [{ provider: "fake", model: "m", inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 1_000_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com" }]);
const usage = { inputTokens: 100, outputTokens: 100, source: "provider" as const };
const c = EVAL_CASES[0]!;

function harness(script: Array<"ok" | "rate_limit">, opts: { maxRetries?: number; pricing?: PricingTable; haltOnUnknownCost?: boolean } = {}) {
  let calls = 0;
  const steps = [...script];
  const p: AiProvider = {
    id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
    generateText: async () => ({ text: "x", model: "m", simulated: false }),
    generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => {
      calls++;
      if ((steps.shift() ?? "ok") === "rate_limit") throw new AiError("rate_limit", "slow down", { retryable: true });
      return { raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage };
    },
  };
  const gw = new AiGateway([p], { pricing: opts.pricing ?? price, repairAttempts: 0, maxRetries: opts.maxRetries ?? 0, sleep: async () => {} });
  const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000_000, maxOutputTokens: 1000, reserveMicros: 5000, haltOnUnknownCost: opts.haltOnUnknownCost });
  return { live, calls: () => calls };
}

describe("evaluation run stop conditions (fake providers; no network)", () => {
  it("a run with no retries and known costs is not halted", async () => {
    const h = harness(["ok", "ok", "ok"]);
    for (let i = 0; i < 3; i++) expect((await h.live.generate(c)).raw).toBeDefined();
    expect(h.live.halted()).toBeUndefined();
    expect(h.calls()).toBe(3);
  });

  it("a request that needed a retry HALTS the run: nothing further is sent", async () => {
    const h = harness(["rate_limit", "ok", "ok", "ok"], { maxRetries: 1 });
    const first = await h.live.generate(c);
    expect(first.raw).toBeDefined(); // the request itself succeeded on its second attempt, and is still recorded
    expect(first.meta?.attempts).toBe(2);
    expect(h.live.halted()).toMatch(/needed 2 attempts \(limit 1\); retries and repairs are not permitted/);
    const second = await h.live.generate(c);
    expect(second.error).toMatch(/^stopped:/);
    expect(h.calls()).toBe(2); // the retry only; the third generate() did not reach the provider
  });

  it("a failed request that used extra attempts also halts the run", async () => {
    const h = harness(["rate_limit", "rate_limit", "ok"], { maxRetries: 1 });
    const r = await h.live.generate(c);
    expect(r.error).toMatch(/rate_limit/);
    expect(h.live.halted()).toMatch(/2 attempts/);
    expect((await h.live.generate(c)).error).toMatch(/^stopped:/);
  });

  it("an unknown cost halts the run and is charged at the worst-case reserve, never as zero", async () => {
    const h = harness(["ok", "ok"], { pricing: PricingTable.empty() });
    const first = await h.live.generate(c);
    expect(first.raw).toBeDefined();
    expect(h.live.spent()).toBe(5000);
    expect(h.live.halted()).toMatch(/pricing uncertainty/);
    expect((await h.live.generate(c)).error).toMatch(/^stopped:/);
    expect(h.calls()).toBe(1);
  });

  it("budget exhaustion stops before the request that could pass the budget", async () => {
    let calls = 0;
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => { calls++; return { raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage: { inputTokens: 1000, outputTokens: 2000, source: "provider" } }; },
    };
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, maxRetries: 0, sleep: async () => {} });
    const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 4000, maxOutputTokens: 1000, reserveMicros: 3000 });
    await live.generate(c); // spends 3000 of 4000
    expect((await live.generate(c)).error).toMatch(/evaluation budget reached/);
    expect(calls).toBe(1);
  });
});

describe("the committed dry-run plan", () => {
  const plan = JSON.parse(readFileSync("docs/eval/plan-original-vs-current.json", "utf8"));
  const md = readFileSync("docs/eval/plan-original-vs-current.md", "utf8");

  it("made no network request and sends nothing", () => {
    expect(plan.networkUsed).toBe(false);
    expect(plan.status).toMatch(/PLAN ONLY/);
    expect(md).toMatch(/nothing sent/i);
    const script = readFileSync("scripts/eval-plan.ts", "utf8");
    expect(script).toContain("{ fetch: unknown }).fetch = () => { throw"); // fetch is replaced with a function that throws
    expect(script).not.toMatch(/verifyModelAccess|api\.openai\.com|api\.anthropic\.com/);
  });
  it("covers the same 14 cases on both arms, and the request count follows from the design", () => {
    expect(plan.design.cases).toBe(14);
    expect(plan.design.cases).toBe(EVAL_CASES.length);
    expect(plan.perCase.map((x: { id: string }) => x.id)).toEqual(EVAL_CASES.map((x) => x.id));
    expect(plan.design.primaryRequests).toBe(plan.design.cases * plan.design.arms.length * plan.design.repetitionsPerCasePerArm);
    expect(plan.design.retriesAllowed + plan.design.repairAttemptsAllowed).toBe(0);
    expect(plan.design.maxRequestsIncludingRetries).toBe(plan.design.primaryRequests);
  });
  it("its cost ceiling is above the worst case and equals the sum of the per-invocation budgets", () => {
    const k = plan.cost;
    expect(k.hardCeilingMicros).toBeGreaterThan(k.worstCaseTotalMicros);
    expect(k.worstCaseTotalMicros).toBe((k.perRepWorstCaseMicros.original + k.perRepWorstCaseMicros.current) * plan.design.repetitionsPerCasePerArm);
    expect((k.perInvocationBudgetMicros.original + k.perInvocationBudgetMicros.current) * plan.design.repetitionsPerCasePerArm).toBeGreaterThanOrEqual(k.hardCeilingMicros);
    expect(k.worstCaseTotalMicros / 1e6).toBeLessThan(0.5); // sanity bound for a low-cost model
  });
  it("uses the recorded price and says it is provisional", () => {
    const pricing = JSON.parse(readFileSync("config/ai-pricing.json", "utf8")).prices.find((p: { model: string }) => p.model === "gpt-6-luna");
    expect(plan.price.inputPerMTokMicros).toBe(pricing.inputPerMTokMicros);
    expect(plan.price.outputPerMTokMicros).toBe(pricing.outputPerMTokMicros);
    expect(plan.price.status).toMatch(/PROVISIONAL/);
  });
  it("names the same prompt, schema and evaluator versions as the code (a stale plan fails)", () => {
    expect(plan.identifiers.promptSha256.current).toBe(currentGenerationIdentity().promptSha256);
    expect(plan.identifiers.schemaSha256.current).toBe(currentGenerationIdentity().schemaSha256);
    expect(plan.identifiers.promptSha256.original).toBe(originalGenerationIdentity().promptSha256);
    expect(plan.identifiers.schemaSha256.original).toBe(originalGenerationIdentity().schemaSha256);
    expect(plan.identifiers.evaluator).toBe(EVALUATOR_VERSION);
  });
  it("states the stop conditions, the reconstructed dependencies and how schema validity is kept separate", () => {
    for (const phrase of [/Budget exhaustion/, /retry or repair/, /Unknown or unmeasurable cost/, /Price record older than 14 days/, /Which results depend on reconstructed historical artifacts/, /Schema validity.*Reported separately and never merged into quality/s, /Decision rule, fixed in advance/, /No result is described as statistically significant/]) expect(md).toMatch(phrase);
  });
});
