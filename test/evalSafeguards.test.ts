import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { OpenAIProvider } from "../src/ai/openaiProvider.js";
import { PricingTable } from "../src/ai/pricing.js";
import { buildAiStack, openAiRequestPolicy } from "../src/ai/stack.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { BusinessBrainSchema } from "../src/domain/schemas.js";
import { EVAL_SERVICE_TIER, evaluationEnv } from "../src/eval/evalPolicy.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { blockingEntries, canStart, committedMicros, committedRequests, loadLedger, reconcile, saveLedger, type Ledger, type LedgerEntry } from "../src/eval/ledger.js";
import { capRequests, makeLiveGenerator } from "../src/eval/liveRun.js";

const FAKE_KEY = "sk-TEST-FAKE-evaluation-0000000000000000";
const LIVE_ENV = { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: FAKE_KEY };
const c = EVAL_CASES[2]!;

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "safeguards-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** A scripted Responses API. Counts and records every request that reaches it. */
function transport(reply: (n: number) => { status?: number; body: unknown }) {
  const seen: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply(seen.length);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", "x-request-id": `req_${seen.length}` } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}
const okBody = (text: string, usage: object | null = { input_tokens: 1700, output_tokens: 600, total_tokens: 2300, output_tokens_details: { reasoning_tokens: 0 } }, tier: string | null = "default") => ({
  id: "resp_1", object: "response", status: "completed", model: "gpt-6-luna",
  output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  ...(usage ? { usage } : {}), ...(tier ? { service_tier: tier } : {}),
});
const goodBrief = () => JSON.stringify(buildMockBrief(c.brain));
const evalStack = (fetchImpl: typeof fetch, over: Partial<{ repair: number; retries: number }> = {}) =>
  buildAiStack({ env: evaluationEnv(LIVE_ENV, { repair: over.repair ?? 0, retries: over.retries ?? 0, maxOutputTokens: 2500 }), fetch: fetchImpl });
const generator = (stack: ReturnType<typeof buildAiStack>, over: object = {}) =>
  makeLiveGenerator({ gateway: stack.gateway, provider: "openai", model: "gpt-6-luna", prompt: "current", budgetMicros: 46_500, maxOutputTokens: 2500, reserveForCase: () => 2_418, maxAttemptsPerRequest: 1, haltOnUnknownCost: true, expectedServiceTier: EVAL_SERVICE_TIER, ...over });

/* ======================================================================================== B. response storage */
describe("explicit response-storage control (store)", () => {
  const brief = JSON.stringify({ name: "Sunrise - Plumbing Leads", objective: "OUTCOME_LEADS", headlines: ["Fast plumbing"], primaryTexts: ["Call today"], callToAction: "GET_QUOTE", audience: { locations: ["Austin, TX"], ageMin: 25, ageMax: 65, interests: [] }, dailyBudgetCents: 1500, rationale: "r" });
  const req = { task: "campaign_brief", system: "s", prompt: "p", schemaHint: "{}", jsonSchema: { type: "object" } as Record<string, unknown>, context: {}, schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never, model: "test-model" };

  it("sends store:false on a structured request when configured", async () => {
    const t = transport(() => ({ body: okBody(brief) }));
    await new OpenAIProvider({ apiKey: FAKE_KEY, models: ["test-model"], fetch: t.fetchImpl, store: false }).generateObject(req as never);
    expect(t.seen[0]!.body.store).toBe(false);
  });
  it("sends store:false on a text request too", async () => {
    const t = transport(() => ({ body: okBody("pong") }));
    await new OpenAIProvider({ apiKey: FAKE_KEY, models: ["test-model"], fetch: t.fetchImpl, store: false }).generateText({ task: "connection_test", system: "s", prompt: "p", model: "test-model" });
    expect(t.seen[0]!.body.store).toBe(false);
  });
  it("sends store:true when asked for it, and nothing when unconfigured (existing behaviour is unchanged)", async () => {
    const yes = transport(() => ({ body: okBody(brief) }));
    await new OpenAIProvider({ apiKey: FAKE_KEY, models: ["test-model"], fetch: yes.fetchImpl, store: true }).generateObject(req as never);
    expect(yes.seen[0]!.body.store).toBe(true);
    const none = transport(() => ({ body: okBody(brief) }));
    await new OpenAIProvider({ apiKey: FAKE_KEY, models: ["test-model"], fetch: none.fetchImpl }).generateObject(req as never);
    expect("store" in none.seen[0]!.body).toBe(false);
  });
  it("is read from OPENAI_STORE, and anything other than true/false/unset is a configuration error", () => {
    expect(openAiRequestPolicy({})).toEqual({ serviceTier: undefined, store: undefined });
    expect(openAiRequestPolicy({ OPENAI_STORE: "false", OPENAI_SERVICE_TIER: "default" })).toEqual({ serviceTier: "default", store: false });
    expect(openAiRequestPolicy({ OPENAI_STORE: "true" }).store).toBe(true);
    expect(openAiRequestPolicy({ OPENAI_STORE: "" }).store).toBeUndefined();
    expect(() => openAiRequestPolicy({ OPENAI_STORE: "maybe" })).toThrow(/OPENAI_STORE must be/);
    expect(() => openAiRequestPolicy({ OPENAI_STORE: "0" })).toThrow();
  });
  it("the evaluation environment forces storage off and the standard tier, and refuses a conflicting environment", () => {
    const e = evaluationEnv({ KEEP: "yes" }, { repair: 0, retries: 0, maxOutputTokens: 2500 });
    expect(e).toMatchObject({ KEEP: "yes", OPENAI_STORE: "false", OPENAI_SERVICE_TIER: "default", AI_REPAIR_ATTEMPTS: "0", AI_MAX_RETRIES: "0", AI_MAX_OUTPUT_TOKENS: "2500" });
    expect(() => evaluationEnv({ OPENAI_STORE: "true" }, { repair: 0, retries: 0, maxOutputTokens: 2500 })).toThrow(/storage disabled/);
    expect(() => evaluationEnv({ OPENAI_SERVICE_TIER: "priority" }, { repair: 0, retries: 0, maxOutputTokens: 2500 })).toThrow(/"default" tier/);
    expect(() => evaluationEnv({ OPENAI_STORE: "false", OPENAI_SERVICE_TIER: "default" }, { repair: 0, retries: 0, maxOutputTokens: 2500 })).not.toThrow();
  });
  it("on the INTENDED request: the evaluation stack built the way the command builds it sends store:false, the standard tier and the output cap", async () => {
    const t = transport(() => ({ body: okBody(goodBrief()) }));
    const g = generator(evalStack(t.fetchImpl));
    const out = await g.generate(c);
    expect(out.raw).toBeDefined();
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(t.seen[0]!.body).toMatchObject({ model: "gpt-6-luna", service_tier: "default", store: false, max_output_tokens: 2500, reasoning: { effort: "none" } });
    expect(out.meta?.serviceTier).toBe("default");
    expect(g.halted()).toBeUndefined();
  });
  it("the other providers are untouched by the OpenAI-only parameters", () => {
    const stack = buildAiStack({ env: evaluationEnv(LIVE_ENV, { repair: 0, retries: 0, maxOutputTokens: 2500 }) });
    expect(stack.gateway.list().map((p) => p.id).sort()).toEqual(["anthropic", "mock", "ollama", "openai"]);
  });
  it("the regular offline suite makes no network calls: the global fetch is a stub that throws, and the setup file is loaded for every test", () => {
    expect(String(globalThis.fetch)).toMatch(/NETWORK BLOCKED in tests/);
    expect(readFileSync("vitest.config.ts", "utf8")).toMatch(/setupFiles:\s*\[[^\]]*test\/setup\.ts/);
    expect(readFileSync("test/setup.ts", "utf8")).toMatch(/outbound network request\(s\) were attempted/); // an attempted call fails the test file
  });
});

/* ======================================================================================== D. safeguards */
describe("a request cannot begin if its reserve would exceed the remaining budget", () => {
  const stackWith = (usage: { input_tokens: number; output_tokens: number }) => {
    const t = transport(() => ({ body: okBody(goodBrief(), usage) }));
    return { t, stack: evalStack(t.fetchImpl) };
  };
  it("sends while spent + reserve fits, and refuses by exactly one micro-USD beyond", async () => {
    const { t, stack } = stackWith({ input_tokens: 1000, output_tokens: 1000 }); // 100 + 500 = 600 micro-USD each
    const fits = generator(stack, { budgetMicros: 600 + 2_000, reserveForCase: () => 2_000 }); // 600 spent + 2000 reserve = 2600: allowed
    await fits.generate(c);
    expect((await fits.generate(c)).raw).toBeDefined(); // 600 spent, 2000 reserve, 2600 <= 2600
    expect(t.seen).toHaveLength(2);
    const { t: t2, stack: s2 } = stackWith({ input_tokens: 1000, output_tokens: 1000 });
    const tight = generator(s2, { budgetMicros: 600 + 2_000 - 1, reserveForCase: () => 2_000 });
    await tight.generate(c);
    const second = await tight.generate(c);
    expect(second.error).toMatch(/evaluation budget reached \(600 of 2599/);
    expect(t2.seen).toHaveLength(1); // the second request never left
  });
  it("each request reserves its own worst case, and nothing is sent when even the first would not fit", async () => {
    const { t, stack } = stackWith({ input_tokens: 10, output_tokens: 10 });
    const g = generator(stack, { budgetMicros: 100, reserveForCase: () => 101 });
    expect((await g.generate(c)).error).toMatch(/evaluation budget reached/);
    expect(t.seen).toHaveLength(0);
  });
});

describe("the cumulative ledger persists across invocations and blocks after a halt or crash until reconciled", () => {
  const init = { experiment: "cmp-3-2", aggregateCeilingMicros: 156_000, maxTotalRequests: 56 };
  const finished = (label: string, charged: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({ label, arm: "current", startedAt: "t", status: "finished", reservedMicros: 46_500, requests: 14, chargedMicros: charged, ...over });

  it("each invocation reloads the ledger from disk, so the total and the request count carry from one command to the next", () => {
    const path = join(tmp(), "ledger.json");
    for (let i = 1; i <= 4; i++) {
      const l = loadLedger(path, init); // a fresh process each time
      expect(committedRequests(l)).toBe((i - 1) * 14);
      expect(canStart(l, { reservedMicros: 46_500, requests: 14 })).toMatchObject({ ok: true });
      l.entries.push(finished(`inv-${i}`, 10_000 * i));
      saveLedger(path, l);
    }
    const after = loadLedger(path, init);
    expect(committedMicros(after)).toBe(100_000);
    expect(committedRequests(after)).toBe(56);
    expect(canStart(after, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/cap of 56/) });
  });
  it("a crash (an entry written before sending that never finished) blocks the next invocation and keeps its full reserve", () => {
    const path = join(tmp(), "ledger.json");
    const l = loadLedger(path, init);
    l.entries.push(finished("crashed", 0, { status: "started", chargedMicros: undefined }));
    saveLedger(path, l);
    const next = loadLedger(path, init);
    expect(canStart(next, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/never finished.*reconcile/) });
    expect(committedMicros(next)).toBe(46_500);
  });
  it("a halt blocks the next invocation, and a reconciliation needs a real note, is recorded, and does not erase the spend", () => {
    const l: Ledger = { ...init, entries: [finished("halted", 12_345, { halted: "stopped: the provider reported the processing tier \"priority\"" })] };
    expect(blockingEntries(l)).toHaveLength(1);
    expect(canStart(l, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/halted: stopped: the provider reported.*reconcile/) });
    expect(() => reconcile(l, "ok", "t")).toThrow(/real explanation/);
    expect(() => reconcile(l, "".padEnd(20, " "), "t")).toThrow(/real explanation/);
    expect(reconcile(l, "Reviewed the halted request: the account showed standard pricing; safe to continue.", "2026-10-16T14:00:00Z")).toEqual(["halted"]);
    expect(l.entries[0]!.reconciled).toMatchObject({ note: expect.stringMatching(/standard pricing/), at: "2026-10-16T14:00:00Z" });
    expect(canStart(l, { reservedMicros: 1, requests: 1 }).ok).toBe(true);
    expect(committedMicros(l)).toBe(12_345); // the spend still counts
    expect(() => reconcile(l, "Nothing left to reconcile here at all.", "t")).toThrow(/nothing to reconcile/);
  });
  it("reconciling cannot quietly zero a crashed entry's charge: a lower charge needs an explicit number and exactly one entry", () => {
    const crashed = (n: string) => finished(n, 0, { status: "started", chargedMicros: undefined });
    const two: Ledger = { ...init, entries: [crashed("a"), crashed("b")] };
    expect(() => reconcile(two, "Both were interrupted before sending anything.", "t", 0)).toThrow(/exactly one entry/);
    reconcile(two, "Both were interrupted before sending anything.", "t");
    expect(committedMicros(two)).toBe(93_000); // still pessimistic
    const one: Ledger = { ...init, entries: [crashed("a")] };
    expect(() => reconcile(one, "The usage page shows nothing was billed.", "t", -5)).toThrow();
    reconcile(one, "The usage page shows nothing was billed for this request id.", "t", 0);
    expect(committedMicros(one)).toBe(0);
    expect(one.entries[0]!.reconciled?.chargedMicros).toBe(0); // recorded as a human decision, with the note
  });
});

describe("usage and cost cannot be treated as zero when missing", () => {
  it("a response with no usage halts the run and charges the reserve, never zero", async () => {
    const t = transport(() => ({ body: okBody(goodBrief(), null) }));
    const g = generator(evalStack(t.fetchImpl), { reserveForCase: () => 2_418 });
    const out = await g.generate(c);
    expect(out.meta?.costMicros).toBeNull();
    expect(g.spent()).toBe(2_418);
    expect(g.halted()).toMatch(/pricing uncertainty/);
    expect((await g.generate(c)).error).toMatch(/^stopped:/);
    expect(t.seen).toHaveLength(1);
  });
  it("a failed request that reports no usage is charged at the reserve too", async () => {
    const t = transport(() => ({ status: 500, body: { error: { type: "server_error", code: null, message: "x" } } }));
    const g = generator(evalStack(t.fetchImpl), { reserveForCase: () => 2_418 });
    await g.generate(c);
    expect(g.spent()).toBe(2_418);
    expect(g.halted()).toMatch(/failed request reported no usage.*pricing uncertainty/); // by default a single unmeasured failure stops the run
  });
  it("a request that costs more than its reserve halts the run: the price or tier assumed is wrong", async () => {
    const t = transport(() => ({ body: okBody(goodBrief(), { input_tokens: 9_000, output_tokens: 2_500 }) })); // 900 + 1250 = 2150
    const g = generator(evalStack(t.fetchImpl), { reserveForCase: () => 1_000 });
    await g.generate(c);
    expect(g.halted()).toMatch(/cost 2150 micro-USD, more than its worst-case reserve of 1000/);
  });
});

describe("retries and repairs cannot increase the planned request count", () => {
  it.each([
    ["HTTP 500", { status: 500, body: { error: { type: "server_error", code: null, message: "x" } } }],
    ["HTTP 429", { status: 429, body: { error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "x" } } }],
    ["a response cut off at the output cap", { body: { ...okBody("{\"na", { input_tokens: 1700, output_tokens: 2500 }), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }],
    ["output that fails the schema (a repair would be the usual response)", { body: okBody(JSON.stringify({ name: "x" })) }],
  ] as const)("%s: exactly one HTTP request, no retry and no repair", async (_n, reply) => {
    const t = transport(() => reply as never);
    await generator(evalStack(t.fetchImpl)).generate(c);
    expect(t.seen).toHaveLength(1);
  });
  it("the transport cap refuses the (N+1)th request before it leaves the process, whatever asked for it", async () => {
    const t = transport(() => ({ body: okBody(goodBrief()) }));
    const cap = capRequests(t.fetchImpl, 2);
    await cap.fetch("https://example.test/a");
    await cap.fetch("https://example.test/b");
    await expect(cap.fetch("https://example.test/c")).rejects.toThrow(/planned limit of 2 HTTP request/);
    expect(cap.sent()).toBe(2);
    expect(t.seen).toHaveLength(2);
  });
  it("even a gateway deliberately configured to retry cannot exceed the cap", async () => {
    const t = transport(() => ({ status: 500, body: { error: { type: "server_error", code: null, message: "x" } } }));
    const cap = capRequests(t.fetchImpl, 1);
    const stack = buildAiStack({ env: { ...LIVE_ENV, AI_MAX_RETRIES: "3", AI_REPAIR_ATTEMPTS: "1", OPENAI_SERVICE_TIER: "default", OPENAI_STORE: "false" }, fetch: cap.fetch, gateway: { sleep: async () => {} } });
    await stack.gateway.generate("openai", { task: "t", system: "s", prompt: "p", schemaHint: "{}", context: {}, schema: { safeParse: () => ({ success: true, data: {} }) } as never, model: "gpt-6-luna" }).catch(() => undefined);
    expect(t.seen).toHaveLength(1);
  });
  it("a request the provider rejects (HTTP 4xx other than 429) halts the run", async () => {
    const t = transport(() => ({ status: 400, body: { error: { type: "invalid_request_error", code: "invalid_value", message: "x" } } }));
    const g = generator(evalStack(t.fetchImpl));
    await g.generate(c);
    expect(g.halted()).toMatch(/provider rejected a request \(HTTP 400/);
    expect((await g.generate(c)).error).toMatch(/^stopped:/);
    expect(t.seen).toHaveLength(1);
  });
  it("three consecutive provider failures halt the run even when unmeasured failures are tolerated; a cut-off answer is not a provider failure", async () => {
    const t = transport(() => ({ status: 503, body: { error: { type: "server_error", code: null, message: "x" } } }));
    const g = generator(evalStack(t.fetchImpl), { haltOnUnknownCost: false });
    await g.generate(c); await g.generate(c);
    expect(g.halted()).toBeUndefined();
    await g.generate(c);
    expect(g.halted()).toMatch(/3 consecutive requests failed/);
    expect(t.seen).toHaveLength(3);
    const cut = transport(() => ({ body: { ...okBody("{\"na", { input_tokens: 1700, output_tokens: 2500 }), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }));
    const g2 = generator(evalStack(cut.fetchImpl), { haltOnUnknownCost: false });
    for (let i = 0; i < 4; i++) await g2.generate(c);
    expect(g2.halted()).toBeUndefined();
  });
});

describe("no Meta, CRM or customer-facing action is reachable from the evaluation path", () => {
  const FORBIDDEN = [
    /src\/connector\//, /src\/integrations\/(mockMeta|crm)/, /src\/server\//, /src\/db\//,
    /src\/app\/(executor|leads|jobs|worker|proposals|workspaces|campaigns|views|context|core|aiService|errors)\.ts$/,
  ];
  const FORBIDDEN_PACKAGES = /^(fastify|better-sqlite3|@fastify|undici)/;
  /** Every source file transitively imported by `entry`, and every package it imports. */
  function closure(entry: string) {
    const files = new Set<string>();
    const packages = new Set<string>();
    const visit = (file: string) => {
      const norm = resolve(file).replace(/\\/g, "/");
      if (files.has(norm)) return;
      files.add(norm);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) { packages.add(spec); continue; }
        const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        if (existsSync(target)) visit(target);
      }
    };
    visit(entry);
    return { files: [...files], packages: [...packages] };
  }
  it.each(["scripts/eval-campaigns.ts", "scripts/live-tier-diagnostic.ts", "scripts/eval-plan.ts"])("%s imports nothing that can reach an ad platform, a CRM, a database or the web server", (entry) => {
    const { files, packages } = closure(entry);
    expect(files.length).toBeGreaterThan(5); // the walk actually found the code
    const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
    expect(bad, bad.join("\n")).toEqual([]);
    expect(packages.filter((p) => FORBIDDEN_PACKAGES.test(p))).toEqual([]);
  });
  it("the AI stack itself pulls in only the integration CONFIG module, not any connector", () => {
    const { files } = closure("src/ai/stack.ts");
    expect(files.some((f) => /integrations\/mode\.ts$/.test(f))).toBe(true);
    expect(files.filter((f) => /connector\/|mockMeta|integrations\/crm/.test(f))).toEqual([]);
  });
  it("the evaluation path has no Meta or CRM configuration of its own", () => {
    for (const f of ["scripts/eval-campaigns.ts", "scripts/live-tier-diagnostic.ts", "src/eval/liveRun.ts", "src/eval/tierDiagnostic.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/META_ACCESS_TOKEN|INTEGRATION_MODE|LIVE_META|LIVE_GHL|graph\.facebook|gohighlevel/i);
    }
  });
});

describe("the command-line guards (child process, every network primitive blocked)", () => {
  const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");
  const exec = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-campaigns.ts"), ...args], {
      encoding: "utf8", timeout: 90_000, env: { ...process.env, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env", ...env },
    });
  const base = (ledger: string) => ["--models", "openai/gpt-6-luna", "--max-output", "2500", "--budget-micros", "31500", "--ledger", ledger, "--aggregate-ceiling-micros", "156000", "--max-total-requests", "56", "--label", "cmp-3-2-original-rep1", "--prompt", "original"];

  it("refuses a retry or a repair on a registered experiment, before anything is sent", () => {
    const ledger = join(tmp(), "l.json");
    for (const extra of [["--retries", "1"], ["--repair", "1"]]) {
      const r = exec([...base(ledger), ...extra, "--yes-spend"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--repair 0 and --retries 0.*would change the planned request count/);
    }
    expect(existsSync(ledger)).toBe(false);
  });
  it("refuses to start when the environment tries to change the tier or re-enable storage", () => {
    const ledger = join(tmp(), "l.json");
    const tier = exec([...base(ledger), "--repair", "0", "--retries", "0"], { OPENAI_SERVICE_TIER: "priority" });
    expect(tier.status).not.toBe(0);
    expect(tier.stderr).toMatch(/"default" tier/);
    const store = exec([...base(ledger), "--repair", "0", "--retries", "0"], { OPENAI_STORE: "true" });
    expect(store.status).not.toBe(0);
    expect(store.stderr).toMatch(/storage disabled/);
  });
  it("the dry run states that service tier and response storage are fixed, and sends nothing", () => {
    const r = exec([...base(join(tmp(), "l.json")), "--repair", "0", "--retries", "0"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/service tier "default", response storage disabled \(store:false\)/);
    expect(r.stdout).toMatch(/Nothing was sent\. No network request was made\./);
  });
  it("an invocation after a halt is refused until --reconcile records a note, and --reconcile itself sends nothing", () => {
    const dir = tmp();
    const path = join(dir, "l.json");
    const halted: LedgerEntry = { label: "cmp-3-2-original-rep1", arm: "original", startedAt: "t", status: "finished", reservedMicros: 31_500, requests: 14, chargedMicros: 9_000, halted: "stopped: a request needed 2 attempts" };
    saveLedger(path, { experiment: "cmp-3-2", aggregateCeilingMicros: 156_000, maxTotalRequests: 56, entries: [halted] });
    const refused = exec([...base(path), "--repair", "0", "--retries", "0"]);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/REFUSED: an earlier invocation .*halted.*reconcile/);
    const short = exec(["--reconcile", "ok", "--ledger", path, "--aggregate-ceiling-micros", "156000", "--max-total-requests", "56", "--label", "cmp-3-2-original-rep1"]);
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/real explanation/);
    const done = exec(["--reconcile", "Reviewed the halted run; the retry was caused by a test fault and cost nothing extra.", "--ledger", path, "--aggregate-ceiling-micros", "156000", "--max-total-requests", "56", "--label", "cmp-3-2-original-rep1"]);
    expect(done.status, done.stderr).toBe(0);
    expect(done.stdout).toMatch(/Reconciled: cmp-3-2-original-rep1.*Nothing was sent/);
    const l = JSON.parse(readFileSync(path, "utf8")) as Ledger;
    expect(l.entries[0]!.reconciled?.note).toMatch(/Reviewed the halted run/);
    expect(l.entries[0]!.chargedMicros).toBe(9_000); // not erased
    const again = exec([...base(path), "--repair", "0", "--retries", "0"]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/may start/);
    writeFileSync(join(dir, "unused"), "");
  });
});

describe("the reserve the command enforces is the reserve the plan promises", () => {
  const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");
  const plan = JSON.parse(readFileSync("docs/eval/plan-original-vs-current.json", "utf8"));
  const dry = (arm: "original" | "current") =>
    spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-campaigns.ts"), "--models", "openai/gpt-6-luna", "--prompt", arm, "--max-output", "2500", "--repair", "0", "--retries", "0", "--budget-micros", String(plan.cost.perInvocationBudgetMicros[arm]), "--label", `cmp-3-2-${arm}-rep1`], {
      encoding: "utf8", timeout: 90_000, env: { ...process.env, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env" },
    });
  it.each(["original", "current"] as const)("%s arm: the largest per-request reserve printed by the dry run equals the plan's, and includes the regional uplift", (arm) => {
    const r = dry(arm);
    expect(r.status, r.stderr).toBe(0);
    const printed = Number(/per-request reserve up to (\d+) micro-USD/.exec(r.stdout)?.[1]);
    expect(printed).toBe(plan.cost.absoluteWorstCase.perRequestMaxMicros[arm]);
    expect(r.stdout).toMatch(/incl\. the 1\.10 regional uplift/);
    expect(plan.price.regionalUpliftApplied).toBe(1.1);
  });
  it("the per-invocation budget is at least the sum of that arm's per-request reserves (so the budget cannot block a request)", () => {
    for (const arm of ["original", "current"] as const) {
      const sum = (plan.perCase as Array<Record<string, { absoluteWorstMicros: number }>>).reduce((s, row) => s + row[arm]!.absoluteWorstMicros, 0);
      expect(plan.cost.perInvocationBudgetMicros[arm], arm).toBeGreaterThanOrEqual(sum);
    }
  });
  it("the same function produces the diagnostic-style reserve: input at one token per byte, full output, times the uplift, rounded up", async () => {
    const { reserveWithUplift, REGIONAL_UPLIFT, worstCaseMicros } = await import("../src/eval/costBound.js");
    const price = { inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000 };
    expect(REGIONAL_UPLIFT).toBe(1.1);
    expect(reserveWithUplift(1000, 2500, price)).toBe(Math.ceil(worstCaseMicros(1000, 2500, price) * 1.1));
    expect(reserveWithUplift(1000, 2500, price)).toBeGreaterThan(worstCaseMicros(1000, 2500, price));
  });
});

/* ===================================================================== budget reconciliation (the $0.1129 vs $0.1142 question) */
describe("the aggregate reservation, recomputed independently of the plan", () => {
  const plan = JSON.parse(readFileSync("docs/eval/plan-original-vs-current.json", "utf8"));
  const price = PricingTable.fromFile("config/ai-pricing.json").entry("openai", "gpt-6-luna")!;

  async function reserves() {
    const { buildCampaignPrompt } = await import("../src/app/campaignPrompt.js");
    const { buildOriginalPrompt, ORIGINAL_HINT, ORIGINAL_JSON_SCHEMA } = await import("../src/eval/original.js");
    const { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } = await import("../src/domain/campaignJsonSchema.js");
    const { absoluteInputTokens, requestText, reserveWithUplift } = await import("../src/eval/costBound.js");
    const orig = EVAL_CASES.map((x) => reserveWithUplift(absoluteInputTokens(requestText(buildOriginalPrompt(x.brain), JSON.stringify(ORIGINAL_JSON_SCHEMA) + ORIGINAL_HINT)), 2500, price));
    const cur = EVAL_CASES.map((x) => reserveWithUplift(absoluteInputTokens(requestText(buildCampaignPrompt(x.brain, { asOf: new Date() }), JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA) + CAMPAIGN_BRIEF_HINT)), 2500, price));
    return { orig, cur };
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  it("each invocation evaluates exactly the 14 cases, and 4 invocations make the 56 requests", () => {
    expect(EVAL_CASES).toHaveLength(14);
    expect(plan.cost.reservation.requestsPerInvocation).toBe(14);
    expect(plan.cost.reservation.invocations).toBe(4);
    expect(14 * 4).toBe(plan.design.primaryRequests);
    for (const cmd of plan.commands as string[]) {
      expect(cmd).not.toMatch(/--cases/); // no subset: all 14
      expect(cmd).toContain("--max-total-requests 56");
    }
  });
  it("the plan's per-case reserves equal the reserves the command would compute from the fixtures today", async () => {
    const { orig, cur } = await reserves();
    expect(plan.cost.reservation.original.perCase).toEqual(orig);
    expect(plan.cost.reservation.current.perCase).toEqual(cur);
  });
  it("1,662 and 2,418 are the LARGEST per-request reserves, not the reserve of every request", async () => {
    const { orig, cur } = await reserves();
    expect(Math.max(...orig)).toBe(1662);
    expect(Math.max(...cur)).toBe(2418);
    expect(Math.min(...orig)).toBeLessThan(1662);
    expect(Math.min(...cur)).toBeLessThan(2418);
    expect(new Set(orig).size).toBeGreaterThan(1); // the reserves genuinely differ per case, because the inputs differ
  });
  it("exact aggregate = 2 x (22,985 + 33,487) = 112,944; the simple maximum-based bound = 28 x 1,662 + 28 x 2,418 = 114,240; the gap is 1,296", async () => {
    const { orig, cur } = await reserves();
    expect(sum(orig)).toBe(22_985);
    expect(sum(cur)).toBe(33_487);
    const exact = 2 * (sum(orig) + sum(cur));
    const simple = 28 * Math.max(...orig) + 28 * Math.max(...cur);
    expect(exact).toBe(112_944);
    expect(simple).toBe(114_240);
    expect(simple - exact).toBe(1_296);
    expect(plan.cost.reservation).toMatchObject({ exactTotalMicros: exact, simpleUpperBoundMicros: simple, differenceMicros: 1_296 });
    expect(plan.cost.absoluteWorstCase.totalMicros).toBe(exact);
    expect(readFileSync("docs/eval/plan-original-vs-current.md", "utf8")).toMatch(/those are maxima, not the reserve of every request/);
  });
  it("each invocation budget covers its arm's exact sum AND 14 x its largest reserve; both totals fit the ceiling", async () => {
    const { orig, cur } = await reserves();
    const b = plan.cost.perInvocationBudgetMicros as { original: number; current: number };
    expect(b).toEqual({ original: 31_500, current: 46_500 });
    expect(b.original).toBeGreaterThanOrEqual(14 * Math.max(...orig));
    expect(b.current).toBeGreaterThanOrEqual(14 * Math.max(...cur));
    expect(b.original).toBeGreaterThanOrEqual(sum(orig));
    expect(b.current).toBeGreaterThanOrEqual(sum(cur));
    expect(plan.cost.reservation.budgetsCoverMaxTimesRequests).toBe(true);
    expect(2 * (b.original + b.current)).toBe(156_000);
    expect(114_240).toBeLessThanOrEqual(156_000);
  });
  it("all four commands name the same ledger, the same limits and the same experiment (they share one persistent ledger)", () => {
    const cmds = plan.commands as string[];
    const val = (c: string, flag: string) => new RegExp(`--${flag} (\\S+)`).exec(c)?.[1];
    for (const flag of ["ledger", "aggregate-ceiling-micros", "max-total-requests"]) expect(new Set(cmds.map((c) => val(c, flag))).size, flag).toBe(1);
    const experiments = cmds.map((c) => val(c, "label")!.replace(/-(original|current)-rep\d+$/, ""));
    expect(new Set(experiments)).toEqual(new Set(["cmp-3-2"]));
    expect(val(cmds[0]!, "ledger")).toBe("docs/eval/ledger-cmp-3-2.json");
  });
  it("the diagnostic ledger and the comparison ledger are separate, and the diagnostic's recorded spend is intact", () => {
    const diag = JSON.parse(readFileSync("docs/live-verification/ledger-tier-diagnostic.json", "utf8")) as Ledger;
    expect(diag).toMatchObject({ experiment: "tier-diagnostic", aggregateCeilingMicros: 2000, maxTotalRequests: 1 });
    expect(diag.entries).toHaveLength(1);
    expect(diag.entries[0]).toMatchObject({ status: "finished", requests: 1, chargedMicros: 20 });
    expect(committedMicros(diag)).toBe(20);
    expect(plan.cost.priorDiagnosticSpendMicros).toBe(20);
    expect("docs/live-verification/ledger-tier-diagnostic.json").not.toBe((plan.commands[0] as string).match(/--ledger (\S+)/)![1]);
    // neither tool refers to the other's ledger, so neither can overwrite it
    expect(readFileSync("scripts/eval-campaigns.ts", "utf8")).not.toMatch(/ledger-tier-diagnostic/);
    expect(readFileSync("scripts/live-tier-diagnostic.ts", "utf8")).not.toMatch(/ledger-cmp/);
    expect(readFileSync("src/eval/tierDiagnostic.ts", "utf8")).not.toMatch(/ledger-cmp/);
    const cmp = "docs/eval/ledger-cmp-3-2.json";
    if (existsSync(cmp)) expect((JSON.parse(readFileSync(cmp, "utf8")) as Ledger).experiment).toBe("cmp-3-2"); // exists only after a run, and then it is its own experiment
  });
  it("re-running the diagnostic is refused, so its spend cannot be erased or duplicated", async () => {
    const { runTierDiagnostic } = await import("../src/eval/tierDiagnostic.js");
    const { ModelRegistry } = await import("../src/ai/registry.js");
    let sent = 0;
    const copy = join(tmp(), "ledger.json");
    writeFileSync(copy, readFileSync("docs/live-verification/ledger-tier-diagnostic.json", "utf8"));
    const r = await runTierDiagnostic({ apiKey: FAKE_KEY, fetchImpl: (async () => { sent++; throw new Error("must not be called"); }) as unknown as typeof fetch, ledgerPath: copy, pricing: PricingTable.fromFile("config/ai-pricing.json"), registry: ModelRegistry.fromFile("config/ai-models.json") });
    expect(r.mode).toBe("refused");
    expect(sent).toBe(0);
    expect(JSON.parse(readFileSync(copy, "utf8")).entries[0].chargedMicros).toBe(20);
  });
});

describe("closing an invocation can never pass silently", () => {
  const open = (): LedgerEntry => ({ label: "cmp-3-2-current-rep1", arm: "current", startedAt: "t", status: "started", reservedMicros: 46_500, requests: 14 });
  const outcome = (over: Partial<import("../src/eval/ledger.js").Outcome> = {}) => ({ spentMicros: 9_000, accessChargedMicros: 0, requestsSent: 14, inFlightReserveMicros: 2_418, finishedAt: "t2", ...over });
  const ledgerOf = (e: LedgerEntry): Ledger => ({ experiment: "cmp-3-2", aggregateCeilingMicros: 156_000, maxTotalRequests: 56, entries: [e] });

  it("a clean invocation is finished at its measured charge and does not block the next", async () => {
    const { closeEntry } = await import("../src/eval/ledger.js");
    const e = open();
    closeEntry(e, outcome());
    expect(e).toMatchObject({ status: "finished", requests: 14, chargedMicros: 9_000, halted: undefined });
    expect(canStart(ledgerOf(e), { reservedMicros: 46_500, requests: 14 }).ok).toBe(true);
  });
  it.each([
    ["a halt (retry, repair, tier, unknown cost, rejection, budget)", { halted: "stopped: a request needed 2 attempts" }, /needed 2 attempts/, 9_000],
    ["an error mid-run: the possibly in-flight request is charged one worst-case reserve", { error: "socket hang up" }, /ended with an error \(socket hang up\).*2418/, 11_418],
    ["a charge above what was reserved", { spentMicros: 50_000 }, /charged 50000 micro-USD, more than the 46500/, 50_000],
  ] as const)("%s blocks the next invocation until reconciled", async (_n, over, reason, charged) => {
    const { closeEntry } = await import("../src/eval/ledger.js");
    const e = open();
    closeEntry(e, outcome(over as never));
    expect(e.halted).toMatch(reason);
    expect(e.chargedMicros).toBe(charged);
    const l = ledgerOf(e);
    expect(canStart(l, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/reconcile/) });
    reconcile(l, "Reviewed this invocation and the provider usage page; safe to continue.", "t3");
    expect(canStart(l, { reservedMicros: 1, requests: 1 }).ok).toBe(true);
    expect(committedMicros(l)).toBe(charged); // reconciling did not remove the spend
  });
  it("an access-check allowance is part of the charge, and the request count is the transport's, not an inference", async () => {
    const { closeEntry } = await import("../src/eval/ledger.js");
    const e = open();
    closeEntry(e, outcome({ accessChargedMicros: 500, requestsSent: 13 }));
    expect(e).toMatchObject({ chargedMicros: 9_500, accessCheckChargedMicros: 500, requests: 13 });
  });
  it("an invocation that ran out of budget is a halt (it did not send all its requests)", async () => {
    const t = transport(() => ({ body: okBody(goodBrief(), { input_tokens: 1000, output_tokens: 1000 }) }));
    const g = generator(evalStack(t.fetchImpl), { budgetMicros: 2_500, reserveForCase: () => 2_000 });
    await g.generate(c);
    await g.generate(c);
    expect(g.halted()).toMatch(/evaluation budget reached/);
    expect(t.seen).toHaveLength(1);
  });
  it("a crash that never reaches closeEntry leaves the started entry, which blocks at its full reserve", () => {
    const e = open();
    expect(canStart(ledgerOf(e), { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/never finished/) });
    expect(committedMicros(ledgerOf(e))).toBe(46_500);
  });
});

describe("unknown or changed pricing stops a registered experiment before anything is sent", () => {
  const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");
  const run = (pricingFile: string) =>
    spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "eval-campaigns.ts"), "--models", "openai/gpt-6-luna", "--prompt", "current", "--max-output", "2500", "--repair", "0", "--retries", "0", "--budget-micros", "46500", "--label", "cmp-3-2-current-rep1", "--ledger", join(tmp(), "l.json"), "--aggregate-ceiling-micros", "156000", "--max-total-requests", "56"], {
      encoding: "utf8", timeout: 90_000, env: { ...process.env, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env", AI_PRICING_FILE: pricingFile },
    });
  const pricingWith = (edit: (p: any) => void) => {
    const cfg = JSON.parse(readFileSync("config/ai-pricing.json", "utf8"));
    edit(cfg);
    const f = join(tmp(), "pricing.json");
    writeFileSync(f, JSON.stringify(cfg));
    return f;
  };
  it("a recorded price that differs from the rates read from the provider is refused as ambiguous", () => {
    const r = run(pricingWith((cfg) => { cfg.prices.find((p: any) => p.model === "gpt-6-luna").inputPerMTokMicros = 200_000; }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/BLOCKED[^\n]*pricing is ambiguous: the recorded price \(200000\/500000\) differs/);
  });
  it("a model with no recorded price is refused", () => {
    const r = run(pricingWith((cfg) => { cfg.prices = cfg.prices.filter((p: any) => p.model !== "gpt-6-luna"); }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/no verified price/);
  });
  it("the unmodified price is accepted", () => {
    const r = run("config/ai-pricing.json");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/READY/);
  });
  it("verifiedRatesProblem: matches, differs, unlisted model, missing price", async () => {
    const { verifiedRatesProblem } = await import("../src/eval/evalPolicy.js");
    expect(verifiedRatesProblem("openai", "gpt-6-luna", { inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000 })).toBeUndefined();
    expect(verifiedRatesProblem("openai", "gpt-6-luna", { inputPerMTokMicros: 100_000, outputPerMTokMicros: 600_000 })).toMatch(/differs from the rates read from the provider on 2026-10-16/);
    expect(verifiedRatesProblem("openai", "gpt-5.5", { inputPerMTokMicros: 5_000_000, outputPerMTokMicros: 30_000_000 })).toMatch(/no rates for openai\/gpt-5\.5 have been read/);
    expect(verifiedRatesProblem("openai", "gpt-6-luna", undefined)).toMatch(/no recorded price/);
  });
});
