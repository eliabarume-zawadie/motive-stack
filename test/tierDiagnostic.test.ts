import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PricingTable } from "../src/ai/pricing.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { actualMicros } from "../src/eval/costBound.js";
import { loadLedger } from "../src/eval/ledger.js";
import { DIAG, reserveFor, runTierDiagnostic } from "../src/eval/tierDiagnostic.js";

const KEY = "sk-TESTSECRET-do-not-leak-0123456789";
const pricing = PricingTable.fromFile("config/ai-pricing.json");
const registry = ModelRegistry.fromFile("config/ai-models.json");
const price = pricing.entry("openai", "gpt-6-luna")!;

const dirs: string[] = [];
const ledgerPath = () => { const d = mkdtempSync(join(tmpdir(), "tier-")); dirs.push(d); return join(d, "ledger.json"); };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

interface Opts { tier?: string | null; usage?: { input_tokens?: number; output_tokens?: number } | null; text?: string; status?: string; model?: string; http?: number; body?: unknown }
/** A scripted Responses API. Records every request it receives. */
function api(o: Opts = {}) {
  const requests: Array<{ url: string; method?: string; body: any; headers: Headers }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers as HeadersInit) });
    const status = o.http ?? 200;
    const body = o.body ?? {
      id: "resp_diag_1", object: "response", status: o.status ?? "completed", model: o.model ?? "gpt-6-luna-2026-10-01",
      output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text: o.text ?? '{"ok":true,"word":"pong"}', annotations: [] }] }],
      ...(o.usage === null ? {} : { usage: o.usage ?? { input_tokens: 190, output_tokens: 12, total_tokens: 202, output_tokens_details: { reasoning_tokens: 0 } } }),
      ...(o.tier === null ? {} : { service_tier: o.tier ?? "default" }),
    };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_diag_abc123" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}
const run = (a: ReturnType<typeof api>, path = ledgerPath(), over: Partial<{ pricing: PricingTable; apiKey: string }> = {}) =>
  runTierDiagnostic({ apiKey: over.apiKey ?? KEY, fetchImpl: a.fetchImpl, ledgerPath: path, pricing: over.pricing ?? pricing, registry, now: () => new Date("2026-10-16T12:00:00Z") });
const failed = (r: { checks: Array<{ id: string; pass: boolean }> }) => r.checks.filter((c) => !c.pass).map((c) => c.id);

describe("worst-case reserve (pure arithmetic; no request)", () => {
  it("is far below the $0.002 budget, including the uplift and a faster-tier contingency", () => {
    const r = reserveFor(price);
    expect(r.priceMatchesDocs).toBe(true);
    expect(r.fitsBudget).toBe(true);
    expect(r.reserveMicros).toBeGreaterThan(0);
    expect(r.reserveMicros).toBeLessThan(250);
    expect(r.fasterTierMicros).toBeGreaterThan(r.reserveMicros);
    expect(r.fasterTierMicros).toBeLessThanOrEqual(DIAG.budgetMicros);
    expect(DIAG.budgetMicros).toBe(2000); // $0.002
  });
  it("is the input bytes plus the full output cap at the recorded rates, times the uplift", () => {
    const r = reserveFor(price);
    expect(r.reserveMicros).toBe(Math.ceil(Math.ceil((r.inputBytes * price.inputPerMTokMicros + DIAG.maxOutputTokens * price.outputPerMTokMicros) / 1e6) * DIAG.uplift));
  });
  it("refuses when there is no recorded price, when the price differs from the rates read from the docs, or when it cannot fit", () => {
    expect(reserveFor(undefined)).toMatchObject({ fitsBudget: false, why: expect.stringMatching(/cannot be bounded/) });
    expect(reserveFor({ ...price, inputPerMTokMicros: 200_000 })).toMatchObject({ fitsBudget: false, priceMatchesDocs: false, why: expect.stringMatching(/pricing is ambiguous/) });
    const huge = { inputPerMTokMicros: DIAG.verifiedRates.inputPerMTokMicros, outputPerMTokMicros: DIAG.verifiedRates.outputPerMTokMicros * 1000 };
    expect(reserveFor(huge).fitsBudget).toBe(false); // matches the docs' rates but pretend the cap were far bigger: out of budget
  });
});

describe("the one diagnostic request", () => {
  it("passes when the tier, usage, output and cost are all as required, and records exactly what was asked", async () => {
    const a = api();
    const r = await run(a);
    expect(failed(r)).toEqual([]);
    expect(r.passed).toBe(true);
    expect(a.requests).toHaveLength(1);
    const sent = a.requests[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/responses");
    expect(sent.body).toMatchObject({ model: "gpt-6-luna", service_tier: "default", max_output_tokens: 128 });
    expect(sent.body.reasoning).toEqual({ effort: "none" });
    expect("store" in sent.body).toBe(false); // the existing adapter does not send it; this is reported, not worked around
    expect(sent.body.input).toBe(DIAG.prompt);
    expect(r.http).toEqual({ status: 200, requestId: "req_diag_abc123" });
    expect(r.response).toMatchObject({ id: "resp_diag_1", status: "completed", service_tier: "default", model: "gpt-6-luna-2026-10-01" });
    expect(r.response?.usage).toMatchObject({ input_tokens: 190, output_tokens: 12 });
    expect(r.calculatedCostMicros).toBe(actualMicros(190, 12, price));
    expect(r.adapter?.estimatedCostMicros).toBeGreaterThan(0);
    expect(r.adapter?.attempts).toBe(1);
  });

  it("writes the ledger BEFORE the request and finishes it with the charged cost; a second run is refused without sending", async () => {
    const path = ledgerPath();
    const r = await run(api(), path);
    const l = loadLedger(path, { experiment: "tier-diagnostic", aggregateCeilingMicros: 2000, maxTotalRequests: 1 });
    expect(l.entries).toHaveLength(1);
    expect(l.entries[0]).toMatchObject({ status: "finished", requests: 1, chargedMicros: r.calculatedCostMicros });
    expect(r.ledger).toMatchObject({ committedBefore: 0, chargedMicros: r.calculatedCostMicros, committedAfter: r.calculatedCostMicros });
    const again = api();
    const second = await run(again, path);
    expect(second.mode).toBe("refused");
    expect(second.refusedBecause).toMatch(/pass the cap of 1|would pass/);
    expect(again.requests).toHaveLength(0);
  });

  it("never lets the key into the record, the request log, an error message or the ledger", async () => {
    const path = ledgerPath();
    const a = api({ http: 401, body: { error: { message: `Incorrect API key provided: ${KEY}`, type: "invalid_request_error", code: "invalid_api_key" } } });
    const r = await run(a, path);
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(loadLedger(path, { experiment: "tier-diagnostic", aggregateCeilingMicros: 2000, maxTotalRequests: 1 }))).not.toContain(KEY);
    expect(a.requests[0]!.headers.get("authorization")).toBe(`Bearer ${KEY}`); // it IS sent to the provider, as it must be, and nowhere else
    const ok = await run(api(), ledgerPath());
    expect(JSON.stringify(ok)).not.toContain(KEY);
  });

  it.each([
    ["the tier is missing from the response", { tier: null }, ["returned_tier_is_default", "adapter_reports_same_tier"]],
    ["a different tier is returned", { tier: "priority" }, ["returned_tier_is_default", "adapter_reports_same_tier"]],
    ["usage is unavailable", { usage: null }, ["usage_present", "adapter_usage_matches_response", "cost_calculated_from_usage", "cost_within_reserve_and_budget"]],
    ["the response is incomplete", { status: "incomplete" }, ["response_completed"]],
    ["the model is not gpt-6-luna", { model: "gpt-5.5" }, ["model_is_gpt_6_luna"]],
    ["the output is not valid JSON for the schema", { text: '{"ok":"yes"}' }, ["output_valid"]],
  ] as const)("FAILS when %s", async (_n, o, expected) => {
    const r = await run(api(o as Opts));
    expect(r.passed).toBe(false);
    for (const id of expected) expect(failed(r), id).toContain(id);
    expect(r.httpRequests).toBe(1);
  });

  it("charges the reserve, never zero, when no usage came back", async () => {
    const path = ledgerPath();
    const r = await run(api({ usage: null }), path);
    expect(r.calculatedCostMicros).toBeUndefined();
    expect(r.ledger!.chargedMicros).toBeGreaterThanOrEqual(r.reserve.reserveMicros);
    expect(r.ledger!.chargedMicros).toBeLessThanOrEqual(DIAG.budgetMicros);
  });

  it("flags output that reaches past the cap or cost that exceeds its reserve", async () => {
    const r = await run(api({ usage: { input_tokens: 190, output_tokens: 129 } }));
    expect(failed(r)).toContain("output_within_cap");
    const big = await run(api({ usage: { input_tokens: 5000, output_tokens: 128 } }));
    expect(failed(big)).toContain("cost_within_reserve_and_budget");
    expect(big.passed).toBe(false);
  });

  it.each([400, 401, 429, 500, 503])("on HTTP %i: exactly one request, no retry, the failure is recorded, and it does not pass", async (status) => {
    const a = api({ http: status, body: { error: { message: "details that must not be copied", type: "x", code: "y" } } });
    const r = await run(a);
    expect(a.requests).toHaveLength(1); // no retry at the SDK, gateway or adapter
    expect(r.httpRequests).toBe(1);
    expect(r.http?.status).toBe(status);
    expect(r.passed).toBe(false);
    expect(r.error).toBeDefined();
    expect(JSON.stringify(r)).not.toContain("details that must not be copied");
    expect(failed(r)).toEqual(expect.arrayContaining(["http_200", "output_valid"]));
  });

  it("an unaccepted service_tier value (HTTP 400) ends the diagnostic: recorded, not retried, evaluation not allowed to proceed", async () => {
    const a = api({ http: 400, body: { error: { message: "Invalid value for service_tier", type: "invalid_request_error", code: "invalid_value" } } });
    const r = await run(a);
    expect(r.passed).toBe(false);
    expect(r.response?.errorType).toBe("invalid_request_error");
    expect(a.requests).toHaveLength(1);
  });

  it("a network failure is one attempt, recorded, not retried", async () => {
    let calls = 0;
    const r = await runTierDiagnostic({ apiKey: KEY, fetchImpl: (async () => { calls++; throw new TypeError("fetch failed"); }) as unknown as typeof fetch, ledgerPath: ledgerPath(), pricing, registry });
    expect(calls).toBe(1);
    expect(r.passed).toBe(false);
    expect(r.error).toBeDefined();
    expect(r.ledger!.chargedMicros).toBeGreaterThan(0); // unknown outcome: counted at the reserve
  });

  it("refuses WITHOUT sending when pricing is ambiguous, absent, or the key is missing", async () => {
    for (const over of [{ pricing: PricingTable.empty() }, { apiKey: "" }] as const) {
      const a = api();
      const r = await run(a, ledgerPath(), over as never);
      expect(r.mode).toBe("refused");
      expect(a.requests).toHaveLength(0);
    }
    const changed = new PricingTable("USD", [{ ...price, inputPerMTokMicros: 250_000 }]);
    const a = api();
    const r = await run(a, ledgerPath(), { pricing: changed });
    expect(r.refusedBecause).toMatch(/pricing is ambiguous/);
    expect(a.requests).toHaveLength(0);
  });

  it("refuses to repeat after an interrupted run (an unfinished ledger entry counts at its full reserve)", async () => {
    const path = ledgerPath();
    const { saveLedger } = await import("../src/eval/ledger.js");
    saveLedger(path, { experiment: "tier-diagnostic", aggregateCeilingMicros: 2000, maxTotalRequests: 1, entries: [{ label: "tier-diagnostic", arm: "diagnostic", startedAt: "t", status: "started", reservedMicros: 300, requests: 1 }] });
    const a = api();
    const r = await run(a, path);
    expect(r.mode).toBe("refused");
    expect(a.requests).toHaveLength(0);
  });
});

describe("the command", () => {
  const PRELOAD = join(process.cwd(), "test", "support", "blocknet.cjs");
  const exec = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", join(process.cwd(), "scripts", "live-tier-diagnostic.ts"), ...args], {
      encoding: "utf8", timeout: 90_000,
      env: { ...process.env, OPENAI_API_KEY: "dummy-not-a-real-key", LIVE_ENV_FILE: "does-not-exist.env", ...env },
    });

  /** Names and sizes of everything in the evidence folder, so a test can prove a command created or changed nothing. */
  const snapshot = () => (existsSync("docs/live-verification") ? readdirSync("docs/live-verification").sort().map((f) => `${f}:${statSync(join("docs/live-verification", f)).size}`) : []);

  it("the dry run completes with every network primitive blocked, prints the reserve and the budget, and writes nothing", () => {
    const before = snapshot();
    const r = exec([]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN\. Nothing was sent and no network request was made/);
    expect(r.stdout).toMatch(/budget 2000 micro-USD \(\$0\.0020\) -> fits/);
    expect(r.stdout).toMatch(/matches the rates read on 2026-10-16: true/);
    expect(r.stdout).toMatch(/present \(value never printed\)/);
    expect(r.stdout).not.toContain("dummy-not-a-real-key");
    expect(snapshot()).toEqual(before); // no file created, none changed (the real ledger exists after the live run and must stay as it is)
  });
  it("--send is refused unless both live switches are set, and sends nothing", () => {
    const before = snapshot();
    const r = exec(["--send"], { AI_PROVIDER_MODE: "mock", ALLOW_LIVE_PROVIDER_CALLS: "false" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/REFUSING: set AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true/);
    expect(snapshot()).toEqual(before);
  });
  it("does not use the access check or the comparison runner", () => {
    const src = require("node:fs").readFileSync("scripts/live-tier-diagnostic.ts", "utf8") + require("node:fs").readFileSync("src/eval/tierDiagnostic.ts", "utf8");
    expect(src).not.toMatch(/import[^;]*(verifyModelAccess|runEvaluation|makeLiveGenerator)/);
    expect(src).not.toMatch(/argv.includes("--check-access")|flag("check-access")/);
  });
});
