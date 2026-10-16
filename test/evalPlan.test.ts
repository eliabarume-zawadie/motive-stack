import { createHash } from "node:crypto";
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
  const script = readFileSync("scripts/eval-plan.ts", "utf8");

  it("made no network request and sends nothing", () => {
    expect(plan.networkUsed).toBe(false);
    expect(plan.status).toMatch(/PLAN ONLY/);
    expect(md).toMatch(/NOTHING SENT/);
    expect(script).toContain("{ fetch: unknown }).fetch = () => { throw"); // fetch is replaced with a function that throws
    expect(script).not.toMatch(/import[^;]*verifyModelAccess/); // the access check is never imported, so never reachable from the plan
    expect(script).not.toMatch(/\bfetch\(/);
  });
  it("records the approved settings exactly", () => {
    expect(plan.approvedSettings).toMatchObject({ model: "gpt-6-luna", cases: 14, repetitionsPerCasePerArm: 3, plannedGenerations: 84, maxOutputTokens: 2500, maxAggregateSpendMicros: 156000, retries: 0, repairs: 0, externalActions: "prohibited", deployment: "local only" });
    expect(plan.approvedSettings.arms).toEqual(["original", "current"]);
    expect(plan.model.id).toBe("gpt-6-luna");
  });
  it("covers the same 14 cases on both arms, and the request count follows from the design", () => {
    expect(plan.design.cases).toBe(EVAL_CASES.length);
    expect(plan.perCase.map((x: { id: string }) => x.id)).toEqual(EVAL_CASES.map((x) => x.id));
    expect(plan.design.primaryRequests).toBe(plan.design.cases * plan.design.arms.length * plan.design.repetitionsPerCasePerArm);
    expect(plan.design.primaryRequests).toBe(84);
    expect(plan.design.retriesAllowed + plan.design.repairAttemptsAllowed).toBe(0);
    expect(plan.design.maxRequestsIncludingRetries).toBe(plan.design.primaryRequests);
  });
  it("the cost bound is internally consistent and the most that can be committed stays within the approved ceiling", () => {
    const k = plan.cost;
    expect(k.hardCeilingMicros).toBe(156000);
    expect(k.estimatedWorstCase.totalMicros).toBeLessThan(k.hardCeilingMicros);
    expect(k.estimatedWorstCase.totalMicros).toBe((k.estimatedWorstCase.perRepetitionMicros.original + k.estimatedWorstCase.perRepetitionMicros.current) * 3);
    expect(k.maxCommittedMicros).toBe(3 * (k.perInvocationBudgetMicros.original + k.perInvocationBudgetMicros.current) + k.maxAccessChecksCharged * k.accessCheckAllowanceMicros);
    expect(k.maxCommittedMicros).toBeLessThanOrEqual(k.hardCeilingMicros);
    // each budget leaves room for its arm's whole estimated worst case, so a normal run is never blocked by its own budget
    expect(k.perInvocationBudgetMicros.original).toBeGreaterThan(k.estimatedWorstCase.perRepetitionMicros.original);
    expect(k.perInvocationBudgetMicros.current).toBeGreaterThan(k.estimatedWorstCase.perRepetitionMicros.current);
    expect(k.accessCheckAllowanceMicros).toBeGreaterThan(0); // the access check is never treated as free
  });
  it("the absolute bound is at least the estimate, and the document is honest when it exceeds the ceiling", () => {
    const k = plan.cost;
    expect(k.absoluteWorstCase.totalMicros).toBeGreaterThanOrEqual(k.estimatedWorstCase.totalMicros);
    if (k.absoluteWorstCase.totalMicros > k.hardCeilingMicros) expect(md).toMatch(/cannot prove that all 84 requests fit/);
    expect(md).toMatch(/spend cannot pass the ceiling/);
    expect(md).toMatch(/Not all 84 requests are guaranteed to run/);
  });
  it("expected spend is derived from billed requests, below the estimate, and labelled an expectation", () => {
    const e = plan.cost.expectedTotalMicros;
    expect(e.low).toBeGreaterThan(0);
    expect(e.high).toBeLessThan(plan.cost.estimatedWorstCase.totalMicros);
    expect(e.basis).toMatch(/an expectation, not a bound/);
    expect(plan.calibration.billedCostsMatchPriceTable).toBe(true);
    expect(plan.calibration.billedToEstimatedInputRatio.max).toBeLessThan(1); // the estimate was above every billed input
  });
  it("uses the recorded price, pins the standard tier, and applies the regional uplift to every reserve", () => {
    const pricing = JSON.parse(readFileSync("config/ai-pricing.json", "utf8")).prices.find((p: { model: string }) => p.model === "gpt-6-luna");
    expect(plan.price.inputPerMTokMicros).toBe(pricing.inputPerMTokMicros);
    expect(plan.price.outputPerMTokMicros).toBe(pricing.outputPerMTokMicros);
    expect(plan.price.serviceTier).toBe("default");
    expect(plan.price.regionalUpliftApplied).toBe(1.1);
    for (const phrase of [/Fast \(priority\).*Twice the standard rates/, /Regional processing.*10% uplift/, /Long-context pricing/, /Cached input/, /Batch \/ Flex/, /does not say how they are billed/]) expect(md).toMatch(phrase);
  });
  it("names the same prompt, schema and evaluator versions as the code (a stale plan fails)", () => {
    expect(plan.identifiers.promptSha256.current).toBe(currentGenerationIdentity().promptSha256);
    expect(plan.identifiers.schemaSha256.current).toBe(currentGenerationIdentity().schemaSha256);
    expect(plan.identifiers.promptSha256.original).toBe(originalGenerationIdentity().promptSha256);
    expect(plan.identifiers.schemaSha256.original).toBe(originalGenerationIdentity().schemaSha256);
    expect(plan.identifiers.evaluator).toBe(EVALUATOR_VERSION);
  });
  it("the source fingerprints match the files on disk (the plan was regenerated after the last change)", () => {
    for (const [file, sha] of Object.entries(plan.identifiers.evaluatorSourceSha256 as Record<string, string>)) {
      expect(createHash("sha256").update(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex"), file).toBe(sha);
    }
  });
  it("documents the access check precisely and never calls it free", () => {
    expect(md).toMatch(/GET https:\/\/api\.openai\.com\/v1\/models\/gpt-6-luna/);
    expect(md).toMatch(/not\*\* a generation endpoint/);
    expect(md).toMatch(/states \*\*nothing\*\* about billing/);
    expect(md).toMatch(/this plan does not claim it is free/);
    expect(md).toMatch(/charged to the budget at an allowance of 500/);
    expect(md).toMatch(/Not run in this task/);
  });
  it("states the stop conditions, the reconstructed dependencies, the fixed decision rule and separate scoring layers", () => {
    for (const phrase of [/Budget would be passed/, /more than 1 attempt/, /cost cannot be determined/, /processing tier other than/, /Aggregate ceiling or request cap/, /earlier invocation halted/, /Price page differs/, /What depends on reconstructed historical artifacts/, /Everything on the original arm inherits that limit/, /Schema validity\*\*, against each arm's own contract/, /Decision rule, fixed before any result exists/, /No result is described as statistically significant/, /Every repetition is its own report/]) expect(md).toMatch(phrase);
  });
  it("the invocation list matches the approved settings: 6 invocations, one access check, ledger and limits on each, nothing else", () => {
    const cmds: string[] = plan.commands;
    expect(cmds).toHaveLength(6);
    expect(cmds.filter((c) => c.includes("--check-access"))).toHaveLength(1);
    for (const c of cmds) {
      expect(c).toContain("--models openai/gpt-6-luna");
      expect(c).toContain("--max-output 2500");
      expect(c).toContain("--repair 0");
      expect(c).toContain("--retries 0");
      expect(c).toContain("--aggregate-ceiling-micros 156000");
      expect(c).toContain("--max-total-requests 84");
      expect(c).toContain("--ledger docs/eval/ledger-cmp-3-2.json");
      expect(c).toMatch(/--yes-spend$/);
      expect(c).not.toMatch(/gpt-5|anthropic|claude/i);
    }
    expect(cmds.filter((c) => c.includes("--prompt original"))).toHaveLength(3);
    expect(cmds.filter((c) => c.includes("--prompt current"))).toHaveLength(3);
    expect(cmds[0]).toContain("--prompt original"); // alternating order: original 1, current 1, original 2, ...
    expect(cmds[1]).toContain("--prompt current");
  });
});
