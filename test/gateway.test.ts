import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { PricingTable } from "../src/ai/pricing.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult } from "../src/ai/types.js";
import { BRIEF_OK, brief, req } from "./briefFixture.js";

type Step = ProviderResult | AiError | ((r: GenerateObjectRequest<unknown>) => Promise<ProviderResult>);

/** A scripted provider: each call consumes the next step. Records every request it receives. */
class Scripted implements AiProvider {
  readonly id = "fake";
  readonly label = "Fake";
  readonly models = ["m1"] as const;
  readonly simulated: boolean;
  calls: Array<GenerateObjectRequest<unknown>> = [];
  constructor(private steps: Step[], simulated = false) { this.simulated = simulated; }
  isAvailable() { return true; }
  async generateObject<T>(r: GenerateObjectRequest<T>): Promise<ProviderResult> {
    this.calls.push(r as GenerateObjectRequest<unknown>);
    const s = this.steps.shift();
    if (!s) throw new Error("script exhausted");
    if (s instanceof AiError) throw s;
    if (typeof s === "function") return s(r as GenerateObjectRequest<unknown>);
    return s;
  }
  async generateText(r: GenerateTextRequest): Promise<ProviderResult> {
    const s = this.steps.shift();
    if (!s || s instanceof AiError || typeof s === "function") throw (s as AiError) ?? new Error("script exhausted");
    void r;
    return s;
  }
}

/** usage: omit for a default; pass null for "the provider reported no usage at all". */
const ok = (usage: ProviderResult["usage"] | null = { inputTokens: 100, outputTokens: 50, source: "provider" }, extra: Partial<ProviderResult> = {}): ProviderResult =>
  ({ raw: BRIEF_OK, model: "m1", simulated: false, usage: usage ?? undefined, requestId: "r1", ...extra });
const rateLimit = (ms?: number) => new AiError("rate_limit", "rl", { retryable: true, retryAfterMs: ms });

const slept: number[] = [];
const sleep = async (ms: number, signal?: AbortSignal) => { slept.push(ms); if (signal?.aborted) throw new AiError("cancelled", "c"); };
const gw = (p: AiProvider, o: ConstructorParameters<typeof AiGateway>[1] = {}) => new AiGateway([p], { sleep, ...o });

describe("success path", () => {
  it("returns validated output with provider, model, usage, latency and request id", async () => {
    const r = await gw(new Scripted([ok()])).generate("fake", req("m1"));
    expect(r).toMatchObject({ status: "ok", provider: "fake", model: "m1", simulated: false, requestId: "r1", usage: { inputTokens: 100, outputTokens: 50, source: "provider" } });
    expect(r.structuredOutput).toEqual(brief());
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.attempts).toHaveLength(1);
  });
});

describe("retries (bounded)", () => {
  it("retries retryable failures, honoring retry-after, then succeeds", async () => {
    slept.length = 0;
    const r = await gw(new Scripted([rateLimit(1500), rateLimit(), ok()])).generate("fake", req("m1"));
    expect(r.attempts.map((a) => [a.kind, a.outcome])).toEqual([["initial", "rate_limit"], ["retry", "rate_limit"], ["retry", "ok"]]);
    expect(slept[0]).toBe(1500);
  });
  it("stops at the retry limit and surfaces the last error with its attempts", async () => {
    const p = new Scripted([rateLimit(), rateLimit(), rateLimit(), rateLimit()]);
    const err = (await gw(p, { maxRetries: 2 }).generate("fake", req("m1")).catch((e) => e)) as AiError;
    expect(err.kind).toBe("rate_limit");
    expect(err.attempts).toHaveLength(3);
    expect(p.calls).toHaveLength(3);
  });
  it.each(["auth", "insufficient_balance", "invalid_request"] as const)("never retries %s", async (kind) => {
    const p = new Scripted([new AiError(kind, "x"), ok()]);
    await expect(gw(p).generate("fake", req("m1"))).rejects.toMatchObject({ kind });
    expect(p.calls).toHaveLength(1);
  });
});

describe("structured output repair", () => {
  const bad: ProviderResult = { raw: { name: 42 }, model: "m1", simulated: false, usage: { inputTokens: 10, outputTokens: 5, source: "provider" } };
  it("makes one bounded repair attempt that names the failing fields, then succeeds", async () => {
    const p = new Scripted([bad, ok()]);
    const r = await gw(p).generate("fake", req("m1"));
    expect(r.attempts.map((a) => [a.kind, a.outcome])).toEqual([["initial", "invalid_output"], ["repair", "ok"]]);
    expect(p.calls[1]!.prompt).toMatch(/rejected by validation: name:/);
    expect(p.calls[1]!.prompt).toContain("openQuestions"); // reminds the model to leave unknown facts explicit
  });
  it("fails with invalid_output if the repair is also invalid, and returns nothing", async () => {
    const err = (await gw(new Scripted([bad, bad])).generate("fake", req("m1")).catch((e) => e)) as AiError;
    expect(err.kind).toBe("invalid_output");
    expect(err.attempts).toHaveLength(2);
  });
  it("makes no repair attempt when repair is disabled", async () => {
    const p = new Scripted([bad, ok()]);
    await expect(gw(p, { repairAttempts: 0 }).generate("fake", req("m1"))).rejects.toMatchObject({ kind: "invalid_output" });
    expect(p.calls).toHaveLength(1);
  });
  it("treats a provider-reported malformed/cut-off output as repairable invalid_output", async () => {
    const r = await gw(new Scripted([new AiError("invalid_output", "malformed"), ok()])).generate("fake", req("m1"));
    expect(r.attempts.map((a) => a.kind)).toEqual(["initial", "repair"]);
  });
  it("sums usage across attempts, including the repair", async () => {
    const r = await gw(new Scripted([bad, ok()])).generate("fake", req("m1"));
    expect(r.usage).toEqual({ inputTokens: 110, outputTokens: 55, source: "provider" });
  });
});

describe("cancellation and timeout", () => {
  it("does not call the provider when already cancelled", async () => {
    const c = new AbortController();
    c.abort();
    const p = new Scripted([ok()]);
    await expect(gw(p).generate("fake", req("m1"), { signal: c.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(p.calls).toHaveLength(0);
  });
  it("stops retrying when cancelled while waiting", async () => {
    const c = new AbortController();
    const p = new Scripted([rateLimit(), ok()]);
    const g = new AiGateway([p], { sleep: async () => { c.abort(); throw new AiError("cancelled", "c"); } });
    await expect(g.generate("fake", req("m1"), { signal: c.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(p.calls).toHaveLength(1);
  });
  it("turns a hung provider into a timeout (and retries it within the limit)", async () => {
    const hang = (r: GenerateObjectRequest<unknown>) => new Promise<ProviderResult>((_, rej) => r.signal?.addEventListener("abort", () => rej(new AiError("cancelled", "aborted"))));
    const p = new Scripted([hang, ok()]);
    const r = await gw(p, { timeoutMs: 30 }).generate("fake", req("m1"));
    expect(r.attempts.map((a) => a.outcome)).toEqual(["timeout", "ok"]);
    const p2 = new Scripted([hang]);
    await expect(gw(p2, { timeoutMs: 30, maxRetries: 0 }).generate("fake", req("m1"))).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("usage and cost", () => {
  const pricing = new PricingTable("USD", [{ provider: "fake", model: "m1", inputPerMTokMicros: 3_000_000, outputPerMTokMicros: 15_000_000, appliesTo: "test fixture", asOf: "2026-01-01", source: "https://example.com/pricing" }]);

  it("estimates cost from provider-reported usage and the configured price", async () => {
    const r = await gw(new Scripted([ok({ inputTokens: 1_000_000, outputTokens: 100_000, source: "provider" })]), { pricing }).generate("fake", req("m1"));
    expect(r).toMatchObject({ costStatus: "estimated", estimatedCostMicros: 3_000_000 + 1_500_000 });
  });
  it("records unknown cost explicitly when no price is configured", async () => {
    const r = await gw(new Scripted([ok()])).generate("fake", req("m1"));
    expect(r).toMatchObject({ costStatus: "unknown_no_pricing", estimatedCostMicros: null });
    expect(r.usage).toMatchObject({ inputTokens: 100 }); // provider usage preserved
  });
  it("distinguishes missing usage (unknown) from zero usage (a real zero)", async () => {
    const none = await gw(new Scripted([ok(null)]), { pricing }).generate("fake", req("m1"));
    expect(none).toMatchObject({ usage: null, costStatus: "unknown_no_usage", estimatedCostMicros: null });
    const zero = await gw(new Scripted([ok({ inputTokens: 0, outputTokens: 0, source: "provider" })]), { pricing }).generate("fake", req("m1"));
    expect(zero).toMatchObject({ costStatus: "estimated", estimatedCostMicros: 0 });
  });
  it("marks a partially-priced multi-attempt result as partial", async () => {
    const bad: ProviderResult = { raw: {}, model: "m1", simulated: false }; // invalid AND no usage
    const r = await gw(new Scripted([bad, ok()]), { pricing }).generate("fake", req("m1"));
    expect(r.costStatus).toBe("partial");
    expect(r.usage).toBeNull(); // the first attempt reported no usage, so the total is unknown
  });
  it("never prices simulated results", async () => {
    const r = await gw(new Scripted([ok({ inputTokens: 5, outputTokens: 5, source: "simulated" }, { simulated: true })], true), { pricing }).generate("fake", req("m1"));
    expect(r).toMatchObject({ simulated: true, costStatus: "not_applicable", estimatedCostMicros: null });
  });
  it("reports every attempt (including failures) to the observer", async () => {
    const seen: string[] = [];
    await gw(new Scripted([rateLimit(), ok()])).generate("fake", req("m1"), { observer: (a) => seen.push(`${a.kind}:${a.outcome}`) });
    expect(seen).toEqual(["initial:rate_limit", "retry:ok"]);
  });
});

describe("text generation", () => {
  it("returns text with usage and rejects empty text", async () => {
    const r = await gw(new Scripted([{ text: "pong", model: "m1", simulated: false, usage: { inputTokens: 3, outputTokens: 1, source: "provider" } }])).generateText("fake", { task: "t", system: "s", prompt: "p", model: "m1" });
    expect(r.text).toBe("pong");
    await expect(gw(new Scripted([{ text: "  ", model: "m1", simulated: false }]), { repairAttempts: 0 }).generateText("fake", { task: "t", system: "s", prompt: "p", model: "m1" })).rejects.toMatchObject({ kind: "invalid_output" });
  });
});

describe("repair feedback is specific enough for a model that cannot count characters", () => {
  const longHeadline = "Emergency Plumbing Services in Austin, TX - 24/7 Availability"; // 61 chars
  const tooManyItems = Array.from({ length: 7 }, (_, i) => `H${i}`);
  const bad = (over: object): ProviderResult => ({ raw: { ...BRIEF_OK, ...over }, model: "m1", simulated: false, usage: { inputTokens: 5, outputTokens: 5, source: "provider" } });

  it("tells the model how long an over-limit string actually is, and the limit", async () => {
    const p = new Scripted([bad({ headlines: [longHeadline, "Short one"] }), ok()]);
    await gw(p).generate("fake", req("m1"));
    const note = p.calls[1]!.prompt;
    expect(note).toContain(`headlines.0: String must contain at most 40 character(s) (it is ${longHeadline.length} characters; rewrite it shorter, at most 40)`);
    expect(note).not.toContain("headlines.1"); // only the failing field is called out
  });
  it("tells the model how many items an over-long list has", async () => {
    const p = new Scripted([bad({ headlines: tooManyItems }), ok()]);
    await gw(p).generate("fake", req("m1"));
    expect(p.calls[1]!.prompt).toMatch(/headlines: .*\(it has 7 items; keep at most 5\)/);
  });
  it("never echoes the offending TEXT in the error that reaches callers and usage records", async () => {
    const p = new Scripted([bad({ headlines: [longHeadline] }), bad({ headlines: [longHeadline] })]);
    const err = (await gw(p).generate("fake", req("m1")).catch((e) => e)) as AiError;
    expect(err.message).not.toContain("Emergency Plumbing");
    for (const a of err.attempts) expect(a.errorMessage ?? "").not.toContain("Emergency Plumbing");
  });
});
