import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { PricingTable } from "../src/ai/pricing.js";
import { type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { buildCampaignPrompt } from "../src/app/campaignPrompt.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { BusinessBrainSchema } from "../src/domain/schemas.js";
import { absoluteInputTokens, actualMicros, estimatedInputTokens, requestText, worstCaseMicros } from "../src/eval/costBound.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { canStart, committedMicros, committedRequests, loadLedger, saveLedger, type Ledger } from "../src/eval/ledger.js";
import { buildLegacyPrompt, makeLiveGenerator } from "../src/eval/liveRun.js";

const luna = { inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000, longContext: { aboveInputTokens: 272_000, inputPerMTokMicros: 200_000, outputPerMTokMicros: 750_000 } };

describe("cost bound arithmetic", () => {
  it("prices input and output at the recorded rates and rounds up", () => {
    expect(worstCaseMicros(1000, 2500, luna)).toBe(100 + 1250); // 1000 × 0.10 + 2500 × 0.50 per million, in micro-USD
    expect(worstCaseMicros(1, 1, luna)).toBe(1); // never rounds down to zero
    expect(actualMicros(1751, 457, luna)).toBe(404); // the cost recorded for a real billed request (403.6, rounded up)
  });
  it("switches to the long-context rates above the threshold, so the bound cannot be too low", () => {
    expect(worstCaseMicros(272_000, 1000, luna)).toBe(Math.ceil((272_000 * 100_000 + 1000 * 500_000) / 1e6));
    expect(worstCaseMicros(272_001, 1000, luna)).toBe(Math.ceil((272_001 * 200_000 + 1000 * 750_000) / 1e6));
  });
  it("the absolute input bound is the UTF-8 byte count, which no tokenizer can exceed", () => {
    expect(absoluteInputTokens("abc")).toBe(3);
    expect(absoluteInputTokens("é")).toBe(2); // two bytes, never more than two tokens
    expect(absoluteInputTokens("日本語")).toBe(9);
    for (const t of ["x".repeat(500), "a b c ".repeat(100), JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA)]) expect(absoluteInputTokens(t)).toBeGreaterThanOrEqual(Math.ceil(t.length / 3));
  });
  it("for every fixture and both arms the largest possible input is far below the long-context threshold", async () => {
    const { buildOriginalPrompt, ORIGINAL_JSON_SCHEMA, ORIGINAL_HINT } = await import("../src/eval/original.js");
    for (const c of EVAL_CASES) {
      const cur = requestText(buildCampaignPrompt(c.brain, { asOf: new Date("2026-10-16T12:00:00Z") }), JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA) + CAMPAIGN_BRIEF_HINT);
      const orig = requestText(buildOriginalPrompt(c.brain), JSON.stringify(ORIGINAL_JSON_SCHEMA) + ORIGINAL_HINT);
      expect(absoluteInputTokens(cur), c.id).toBeLessThan(20_000);
      expect(absoluteInputTokens(orig), c.id).toBeLessThan(20_000);
    }
  });
  it("the estimate was above the billed input for every earlier billed request (calibration evidence, not a guarantee)", () => {
    const contract = JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA) + CAMPAIGN_BRIEF_HINT;
    let n = 0;
    for (const v of ["current", "legacy"] as const) {
      const r = JSON.parse(readFileSync(`docs/eval/m3-live2-${v}-openai-gpt_6_luna.json`, "utf8")) as { cases: Array<{ caseId: string; meta?: { inputTokens?: number; outputTokens?: number; costMicros?: number } }> };
      for (const c of r.cases) {
        const fx = EVAL_CASES.find((x) => x.id === c.caseId)!;
        const p = v === "current" ? buildCampaignPrompt(fx.brain, { asOf: new Date("2026-10-16T12:00:00Z") }) : buildLegacyPrompt(fx.brain);
        const text = requestText(p, contract);
        expect(c.meta!.inputTokens!, `${v}/${c.caseId}`).toBeLessThan(estimatedInputTokens(text));
        expect(estimatedInputTokens(text)).toBeLessThan(absoluteInputTokens(text));
        expect(c.meta!.costMicros!).toBeLessThanOrEqual(worstCaseMicros(estimatedInputTokens(text), 2500, luna)); // cost billed vs worst case
        expect(Math.abs(actualMicros(c.meta!.inputTokens!, c.meta!.outputTokens!, luna) - c.meta!.costMicros!)).toBeLessThanOrEqual(1); // the price table reproduces the recorded cost (the gateway rounds to nearest, the bound rounds up)
        n++;
      }
    }
    expect(n).toBe(6);
  });
});

describe("the aggregate ledger", () => {
  const init = { experiment: "cmp", aggregateCeilingMicros: 156_000, maxTotalRequests: 84 };
  const tmp = () => mkdtempSync(join(tmpdir(), "ledger-"));
  const entry = (label: string, over: object = {}) => ({ label, arm: "current", startedAt: "t", status: "finished" as const, reservedMicros: 27_500, requests: 14, chargedMicros: 9_000, ...over });

  it("starts empty, round-trips through a file, and counts finished entries at what was charged", () => {
    const dir = tmp();
    const path = join(dir, "l.json");
    const l = loadLedger(path, init);
    expect(l.entries).toEqual([]);
    l.entries.push(entry("a"), entry("b", { chargedMicros: 7_500 }));
    saveLedger(path, l);
    const back = loadLedger(path, init);
    expect(committedMicros(back)).toBe(16_500);
    expect(committedRequests(back)).toBe(28);
    rmSync(dir, { recursive: true });
  });
  it("counts an unfinished entry at its FULL reserve (a crash must never look cheap)", () => {
    const l: Ledger = { ...init, entries: [entry("crashed", { status: "started", chargedMicros: undefined, reservedMicros: 28_000 })] };
    expect(committedMicros(l)).toBe(28_000);
    expect(canStart(l, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/never finished/) });
    expect(canStart(l, { reservedMicros: 1, requests: 1 }, true).ok).toBe(true); // only after a person acknowledges
  });
  it("refuses an invocation that could pass the ceiling or the request cap", () => {
    const l: Ledger = { ...init, entries: [entry("a", { chargedMicros: 150_000, requests: 70 })] };
    expect(canStart(l, { reservedMicros: 6_000, requests: 14 })).toMatchObject({ ok: true });
    expect(canStart(l, { reservedMicros: 6_001, requests: 14 })).toMatchObject({ ok: false, reason: expect.stringMatching(/aggregate ceiling of 156000/) });
    expect(canStart(l, { reservedMicros: 100, requests: 15 })).toMatchObject({ ok: false, reason: expect.stringMatching(/cap of 84/) });
  });
  it("an earlier halt blocks the next invocation until a person acknowledges it", () => {
    const l: Ledger = { ...init, entries: [entry("h", { halted: "stopped: a request needed 2 attempts" })] };
    expect(canStart(l, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/halted: stopped: a request needed 2 attempts/) });
    expect(canStart(l, { reservedMicros: 1, requests: 1 }, true).ok).toBe(true);
  });
  it("limits cannot be loosened on an existing ledger", () => {
    const dir = tmp();
    const path = join(dir, "l.json");
    saveLedger(path, { ...init, entries: [] });
    expect(() => loadLedger(path, { ...init, aggregateCeilingMicros: 1_000_000 })).toThrow(/Limits cannot be changed on an existing ledger/);
    expect(() => loadLedger(path, { ...init, maxTotalRequests: 500 })).toThrow(/Limits cannot be changed/);
    rmSync(dir, { recursive: true });
  });
  it("the planned six invocations fit the ceiling even if every one spent its entire budget and made an access check; a seventh would not", () => {
    const plan = JSON.parse(readFileSync("docs/eval/plan-original-vs-current.json", "utf8"));
    const b = plan.cost.perInvocationBudgetMicros as { original: number; current: number };
    const allow = plan.cost.accessCheckAllowanceMicros as number;
    const l: Ledger = { ...init, entries: [] };
    for (let rep = 1; rep <= 3; rep++) for (const arm of ["original", "current"] as const) {
      const reserve = b[arm] + allow;
      expect(canStart(l, { reservedMicros: reserve, requests: 14 }), `${arm} ${rep}`).toMatchObject({ ok: true });
      l.entries.push(entry(`${arm}-${rep}`, { arm, reservedMicros: reserve, chargedMicros: reserve, requests: 14 })); // worst case: the whole budget plus the allowance
    }
    expect(committedMicros(l)).toBeLessThanOrEqual(156_000);
    expect(committedRequests(l)).toBe(84);
    expect(canStart(l, { reservedMicros: 1, requests: 1 }).ok).toBe(false);
  });
});

describe("live run safeguards that protect the cost bound (fake providers)", () => {
  const price = new PricingTable("USD", [{ provider: "fake", model: "m", inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com" }]);
  const c = EVAL_CASES[0]!;
  const run = (tier: string | undefined, expected: string | undefined) => {
    let calls = 0;
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => { calls++; return { raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage: { inputTokens: 100, outputTokens: 100, source: "provider" }, ...(tier ? { serviceTier: tier } : {}) }; },
    };
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, maxRetries: 0, sleep: async () => {} });
    return { live: makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000_000, maxOutputTokens: 1000, reserveMicros: 10, expectedServiceTier: expected }), calls: () => calls };
  };

  it("a response in the expected tier is accepted, and the tier is recorded", async () => {
    const h = run("default", "default");
    const out = await h.live.generate(c);
    expect(out.meta?.serviceTier).toBe("default");
    expect(h.live.halted()).toBeUndefined();
  });
  it("a faster (more expensive) tier HALTS the run: the price assumed no longer applies", async () => {
    const h = run("priority", "default");
    await h.live.generate(c);
    expect(h.live.halted()).toMatch(/reported the processing tier "priority" instead of "default"/);
    expect((await h.live.generate(c)).error).toMatch(/^stopped:/);
    expect(h.calls()).toBe(1);
  });
  it("a response that does not report a tier HALTS too (the tier cannot be verified)", async () => {
    const h = run(undefined, "default");
    await h.live.generate(c);
    expect(h.live.halted()).toMatch(/processing tier "none"/);
  });
  it("without an expected tier nothing is checked (other providers)", async () => {
    const h = run(undefined, undefined);
    await h.live.generate(c);
    expect(h.live.halted()).toBeUndefined();
  });
  it("each request reserves ITS OWN worst case, so a large case cannot be sent when the budget could not cover it", async () => {
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({ raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage: { inputTokens: 1, outputTokens: 1, source: "provider" } }),
    };
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, maxRetries: 0, sleep: async () => {} });
    const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000, maxOutputTokens: 100, reserveForCase: (x) => (x.id === EVAL_CASES[1]!.id ? 5_000 : 100) });
    expect((await live.generate(EVAL_CASES[0]!)).raw).toBeDefined();
    expect((await live.generate(EVAL_CASES[1]!)).error).toMatch(/evaluation budget reached/);
  });
});

const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");

describe("the evaluation command makes no network request unless it is asked to", () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-campaigns.ts"), ...args], {
      encoding: "utf8", timeout: 90_000,
      env: { ...process.env, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env", ...env },
    });
  const base = ["--models", "openai/gpt-6-luna", "--prompt", "current", "--max-output", "2500", "--repair", "0", "--retries", "0", "--budget-micros", "27500"];

  it("a dry run with a dummy key and every network primitive blocked completes, says nothing was sent, and writes no ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-"));
    const ledger = join(dir, "ledger.json");
    const r = run([...base, "--ledger", ledger, "--aggregate-ceiling-micros", "156000", "--max-total-requests", "84", "--label", "dry"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Nothing was sent\. No network request was made\./);
    expect(r.stdout).toMatch(/READY\s+openai\/gpt-6-luna.*access NOT checked/);
    expect(r.stdout).toMatch(/service tier "default"/);
    expect(r.stdout).toMatch(/committed 0 of 156000 micro-USD, 0 of 84 requests; this invocation reserves 27500 micro-USD and 14 requests -> may start/);
    expect(existsSync(ledger)).toBe(false);
    rmSync(dir, { recursive: true });
  });
  it("the access check is the only way it reaches for the network: with the flag, a blocked network makes the model BLOCKED", () => {
    const r = run([...base, "--check-access", "--label", "dry"]);
    expect(r.stdout).toMatch(/BLOCKED\s+openai\/gpt-6-luna.*could not reach the provider/);
    expect(r.stdout).not.toMatch(/Nothing was sent\. No network request was made/);
    expect(r.status).toBe(1);
  });
  it("refuses to run (and sends nothing) when the ledger shows the ceiling would be passed", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-"));
    const ledger = join(dir, "ledger.json");
    writeFileSync(ledger, JSON.stringify({ experiment: "dry", aggregateCeilingMicros: 156000, maxTotalRequests: 84, entries: [{ label: "x", arm: "current", startedAt: "t", status: "finished", reservedMicros: 1, requests: 14, chargedMicros: 150000 }] }));
    const r = run([...base, "--ledger", ledger, "--aggregate-ceiling-micros", "156000", "--max-total-requests", "84", "--label", "dry", "--yes-spend"]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/REFUSED|REFUSING TO RUN LIVE.*would pass the aggregate ceiling/s);
    expect(r.stdout + r.stderr).not.toMatch(/estimated spend/);
    rmSync(dir, { recursive: true });
  });
  it("refuses to run at all unless both live switches are set", () => {
    const r = run(base, { AI_PROVIDER_MODE: "mock" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING TO RUN LIVE: set AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true/);
  });
  it("the plan generator is also offline under the same blocked network", () => {
    const out = execFileSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-plan.ts"), "--no-write"], { encoding: "utf8", timeout: 90_000 });
    expect(out).toMatch(/No network request was made\./);
  });
});
