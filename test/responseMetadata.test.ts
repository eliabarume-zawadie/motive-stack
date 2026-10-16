import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { buildAiStack } from "../src/ai/stack.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { EVAL_SERVICE_TIER, evaluationEnv } from "../src/eval/evalPolicy.js";
import { runEvaluation } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { canStart, closeEntry, committedMicros, reconcile, type Ledger, type LedgerEntry } from "../src/eval/ledger.js";
import { makeLiveGenerator } from "../src/eval/liveRun.js";
import { renderMarkdown } from "../src/eval/report.js";

const KEY = "sk-TEST-FAKE-metadata-0000000000000000";
const c = EVAL_CASES[2]!;
const URL_OK = "https://api.openai.com/v1/responses";

interface Reply { status?: number; headers?: Record<string, string>; body: unknown }
/** A scripted Responses API. Records every request that reaches it; nothing here touches the network. */
function transport(reply: (n: number) => Reply) {
  const seen: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = reply(seen.length);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

interface BodyOpts { model?: string | null; id?: string | null; tier?: string | null; status?: string; usage?: { input_tokens: number; output_tokens: number } | null; text?: string; incomplete?: boolean }
/** A Responses API body. A field set to null is OMITTED, as a provider that did not send it would. */
function body(o: BodyOpts = {}) {
  const text = o.text ?? JSON.stringify(buildMockBrief(c.brain));
  return {
    object: "response",
    ...(o.id === null ? {} : { id: o.id ?? "resp_abc123" }),
    ...(o.model === null ? {} : { model: o.model ?? "gpt-6-luna-2026-10-01" }),
    status: o.status ?? (o.incomplete ? "incomplete" : "completed"),
    ...(o.incomplete ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
    ...(o.usage === null ? {} : { usage: o.usage ?? { input_tokens: 1700, output_tokens: 600, total_tokens: 2300, output_tokens_details: { reasoning_tokens: 0 } } }),
    ...(o.tier === null ? {} : { service_tier: o.tier ?? "default" }),
  };
}
const withReq = (id = "req_abc123") => ({ "x-request-id": id });

const stackFor = (t: ReturnType<typeof transport>) =>
  buildAiStack({ env: evaluationEnv({ AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: KEY }, { repair: 0, retries: 0, maxOutputTokens: 2500 }), fetch: t.fetchImpl });
const generator = (t: ReturnType<typeof transport>, over: object = {}) =>
  makeLiveGenerator({ gateway: stackFor(t).gateway, provider: "openai", model: "gpt-6-luna", prompt: "current", budgetMicros: 46_500, maxOutputTokens: 2500, reserveForCase: () => 2_418, maxAttemptsPerRequest: 1, haltOnUnknownCost: true, expectedServiceTier: EVAL_SERVICE_TIER, ...over });

/* ================================================================================ 1. valid output */
describe("a valid response records everything the provider returned", () => {
  it("returned model, response id, server request id, tier, status, usage and cost, each in its own field", async () => {
    const t = transport(() => ({ headers: withReq(), body: body() }));
    const g = generator(t);
    const out = await g.generate(c);
    expect(out.raw).toBeDefined();
    expect(out.meta?.provider).toEqual({
      requestedModel: "gpt-6-luna", returnedModel: "gpt-6-luna-2026-10-01",
      responseId: "resp_abc123", requestId: "req_abc123",
      requestedServiceTier: "default", returnedServiceTier: "default",
      responseStatus: "completed", httpStatus: null,
      inputTokens: 1700, outputTokens: 600, costStatus: "estimated", estimatedCostMicros: 470,
      missing: [],
    });
    expect(out.meta?.provider?.requestId).not.toBe(out.meta?.provider?.responseId); // the server request id is not the response id
    expect(g.halted()).toBeUndefined();
    expect(t.seen).toHaveLength(1);
  });
  it("the requested model and tier are what the harness asked for, whatever the provider answered", async () => {
    const t = transport(() => ({ headers: withReq(), body: body({ model: "gpt-6-luna-2099-snapshot" }) }));
    const out = await generator(t).generate(c);
    expect(out.meta?.provider).toMatchObject({ requestedModel: "gpt-6-luna", returnedModel: "gpt-6-luna-2099-snapshot" });
  });
});

/* ================================================================================ 2. invalid output */
describe("a response whose content is invalid still records its metadata", () => {
  it("schema-invalid content: model id, request id, tier and usage are all kept", async () => {
    const t = transport(() => ({ headers: withReq("req_invalid_1"), body: body({ text: JSON.stringify({ name: "x" }) }) }));
    const g = generator(t);
    const out = await g.generate(c);
    expect(out.raw).toBeDefined(); // the received answer is kept for scoring, as an invalid one
    expect(out.schemaError).toMatch(/invalid_output/);
    expect(out.meta?.provider).toMatchObject({ returnedModel: "gpt-6-luna-2026-10-01", requestId: "req_invalid_1", responseId: "resp_abc123", returnedServiceTier: "default", inputTokens: 1700, outputTokens: 600, estimatedCostMicros: 470, missing: [] });
    expect(g.spent()).toBe(470);
    expect(g.halted()).toBeUndefined(); // an invalid answer is a result, not a halt
  });
  it("a length-limit violation (the case that lost its tier before): tier, ids and usage are recorded", async () => {
    const long = { ...(buildMockBrief(c.brain) as Record<string, any>), primaryTexts: ["T".repeat(126), "ok text"] };
    const t = transport(() => ({ headers: withReq("req_long_1"), body: body({ text: JSON.stringify(long) }) }));
    const out = await generator(t).generate(c);
    expect(out.schemaError).toMatch(/at most 125/);
    expect(out.meta?.provider).toMatchObject({ requestId: "req_long_1", returnedServiceTier: "default", returnedModel: "gpt-6-luna-2026-10-01", responseId: "resp_abc123", inputTokens: 1700 });
    expect(out.meta?.serviceTier).toBe("default");
  });
  it("malformed JSON and a cut-off answer both keep their metadata", async () => {
    const bad = await generator(transport(() => ({ headers: withReq("req_bad_json"), body: body({ text: "{not json" }) }))).generate(c);
    expect(bad.error ?? bad.schemaError).toMatch(/malformed JSON/);
    expect(bad.meta?.provider).toMatchObject({ requestId: "req_bad_json", returnedServiceTier: "default", returnedModel: "gpt-6-luna-2026-10-01", inputTokens: 1700 });
    const cut = await generator(transport(() => ({ headers: withReq("req_cut"), body: body({ incomplete: true, text: "{\"na", usage: { input_tokens: 1700, output_tokens: 2500 } }) }))).generate(c);
    expect(cut.truncated).toBe(true);
    expect(cut.meta?.provider).toMatchObject({ requestId: "req_cut", responseStatus: "incomplete", returnedServiceTier: "default", outputTokens: 2500, estimatedCostMicros: 1420 });
  });
});

/* ================================================================================ 3 and 4. tier and model checks */
describe("the tier and model are verified before the content is validated, so a malformed answer cannot bypass them", () => {
  it.each([
    ["is missing", { tier: null }, /processing tier "none" instead of "default"/],
    ["is a faster tier", { tier: "priority" }, /processing tier "priority" instead of "default"/],
    ["is a different standard-looking value", { tier: "auto" }, /processing tier "auto"/],
  ] as const)("when the returned tier %s the invocation halts", async (_n, o, why) => {
    const t = transport(() => ({ headers: withReq("req_tier_1"), body: body(o) }));
    const g = generator(t);
    const out = await g.generate(c);
    expect(g.halted()).toMatch(why);
    expect(out.error).toMatch(/^response_rejected: stopped:/);
    expect(out.raw).toBeUndefined(); // the content was never accepted or scored
    expect((await g.generate(c)).error).toMatch(/^stopped:/);
    expect(t.seen).toHaveLength(1); // nothing further was sent
  });
  it("usage and the known cost are preserved when it halts", async () => {
    const t = transport(() => ({ headers: withReq("req_tier_2"), body: body({ tier: "priority" }) }));
    const g = generator(t);
    const out = await g.generate(c);
    expect(g.spent()).toBe(470); // charged at the measured cost, not zero and not the reserve
    expect(out.meta?.provider).toMatchObject({ requestId: "req_tier_2", returnedServiceTier: "priority", requestedServiceTier: "default", inputTokens: 1700, outputTokens: 600, estimatedCostMicros: 470, returnedModel: "gpt-6-luna-2026-10-01" });
  });
  it("a malformed answer with the wrong tier is rejected for the TIER, not reported as malformed", async () => {
    const t = transport(() => ({ headers: withReq(), body: body({ tier: "priority", text: "{not json" }) }));
    const g = generator(t);
    const out = await g.generate(c);
    expect(out.error).toMatch(/^response_rejected:/);
    expect(out.error).not.toMatch(/malformed/);
    expect(g.halted()).toMatch(/priority/);
  });
  it("a cut-off answer with the wrong tier is rejected for the tier too", async () => {
    const g = generator(transport(() => ({ headers: withReq(), body: body({ tier: "flex", incomplete: true, text: "{\"na", usage: { input_tokens: 1700, output_tokens: 2500 } }) })));
    await g.generate(c);
    expect(g.halted()).toMatch(/processing tier "flex"/);
    expect(g.spent()).toBe(1420);
  });
  it("a schema-invalid answer with the wrong tier is rejected for the tier (validation never runs)", async () => {
    const g = generator(transport(() => ({ headers: withReq(), body: body({ tier: null, text: JSON.stringify({ name: "x" }) }) })));
    const out = await g.generate(c);
    expect(out.schemaError).toBeUndefined();
    expect(out.error).toMatch(/^response_rejected:/);
    expect(g.halted()).toMatch(/processing tier "none"/);
  });
  it("the tier is never inferred from the request: sending service_tier=default does not make an unreported tier 'default'", async () => {
    const t = transport(() => ({ headers: withReq(), body: body({ tier: null }) }));
    const g = generator(t);
    const out = await g.generate(c);
    expect(t.seen[0]!.body.service_tier).toBe("default"); // it WAS asked for
    expect(out.meta?.provider?.returnedServiceTier).toBeNull(); // and the answer did not say, so it is unknown
    expect(out.meta?.provider?.missing).toContain("returnedServiceTier");
    expect(g.halted()).toBeDefined();
  });
  it.each([
    ["a different model", { model: "gpt-5.5" }, /model "gpt-5\.5" instead of "gpt-6-luna"/],
    ["no model", { model: null }, /model "none" instead of "gpt-6-luna"/],
  ] as const)("returning %s halts the invocation", async (_n, o, why) => {
    const g = generator(transport(() => ({ headers: withReq(), body: body(o) })));
    await g.generate(c);
    expect(g.halted()).toMatch(why);
  });
  it("the guard runs BEFORE validation: the schema is never consulted for a rejected response", async () => {
    let validated = 0;
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({
        raw: {}, model: r.model, simulated: false, usage: { inputTokens: 10, outputTokens: 10, source: "provider" },
        meta: { requestedModel: "m", requestedServiceTier: "default", returnedModel: "m", responseId: "r", requestId: "q", returnedServiceTier: "priority", responseStatus: "completed", httpStatus: null },
      }),
    };
    const gw = new AiGateway([p], { repairAttempts: 1, maxRetries: 2, sleep: async () => {} });
    const err = await gw.generate("fake", { task: "t", system: "s", prompt: "p", schemaHint: "{}", context: {}, schema: { safeParse: () => { validated++; return { success: true, data: {} }; } } as never, model: "m" }, { responseGuard: (m) => (m?.returnedServiceTier === "default" ? undefined : "tier is wrong") }).catch((e) => e as AiError);
    expect(err).toMatchObject({ kind: "response_rejected", message: "tier is wrong", retryable: false });
    expect(validated).toBe(0);
    expect(err.attempts).toHaveLength(1); // not retried and not repaired
    expect(err.attempts[0]).toMatchObject({ outcome: "response_rejected", requestId: "q", meta: { returnedServiceTier: "priority" } });
    expect(err.meta?.returnedServiceTier).toBe("priority");
  });
  it("without metadata at all a registered experiment cannot verify the tier and halts", async () => {
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({ raw: buildMockBrief(c.brain), model: r.model, simulated: false, usage: { inputTokens: 10, outputTokens: 10, source: "provider" }, serviceTier: "default" }),
    };
    const g = makeLiveGenerator({ gateway: new AiGateway([p], { repairAttempts: 0, maxRetries: 0, sleep: async () => {} }), provider: "fake", model: "m", prompt: "current", budgetMicros: 100_000, maxOutputTokens: 100, reserveMicros: 1_000, expectedServiceTier: "default" });
    await g.generate(c);
    expect(g.halted()).toMatch(/no response metadata, so the processing tier cannot be verified/); // a bare serviceTier field is not enough
  });
});

/* ================================================================================ 5. HTTP errors */
describe("an HTTP error records the request id from the response headers when there is one", () => {
  it.each([[500], [429], [400], [401]])("HTTP %i: request id kept, nothing else invented", async (status) => {
    const t = transport(() => ({ status, headers: withReq(`req_http_${status}`), body: { error: { type: "server_error", code: null, message: "details that must not be copied" } } }));
    const g = generator(t, { haltOnUnknownCost: false });
    const out = await g.generate(c);
    expect(out.error).toBeDefined();
    expect(out.meta?.provider).toMatchObject({
      requestId: `req_http_${status}`, httpStatus: status,
      requestedModel: "gpt-6-luna", requestedServiceTier: "default",
      returnedModel: null, responseId: null, returnedServiceTier: null, responseStatus: null,
      inputTokens: null, outputTokens: null,
    });
    expect(out.meta?.provider?.missing).toEqual(expect.arrayContaining(["returnedModel", "returnedServiceTier", "inputTokens", "outputTokens"]));
    expect(JSON.stringify(out)).not.toContain("details that must not be copied");
    expect(t.seen).toHaveLength(1);
  });
  it("an HTTP error without a request-id header leaves it unknown rather than inventing one", async () => {
    const g = generator(transport(() => ({ status: 503, body: { error: { type: "server_error", code: null, message: "x" } } })), { haltOnUnknownCost: false });
    const out = await g.generate(c);
    expect(out.meta?.provider?.requestId).toBeNull();
    expect(out.meta?.provider?.missing).toContain("requestId");
  });
  it("a network failure (no response at all) records nothing returned, and charges the reserve", async () => {
    const t = { fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, seen: [] as never[] };
    const g = generator(t as never, { haltOnUnknownCost: false });
    const out = await g.generate(c);
    expect(out.meta?.provider).toMatchObject({ requestId: null, responseId: null, returnedModel: null, returnedServiceTier: null, requestedModel: "gpt-6-luna" });
    expect(g.spent()).toBe(2_418);
  });
});

/* ================================================================================ 6 and 7. missing values */
describe("missing values stay missing", () => {
  it("missing usage never becomes zero: tokens and cost are null, the cost is charged at the reserve, and the run halts", async () => {
    const g = generator(transport(() => ({ headers: withReq("req_nousage"), body: body({ usage: null }) })));
    const out = await g.generate(c);
    expect(out.meta?.provider).toMatchObject({ requestId: "req_nousage", inputTokens: null, outputTokens: null, estimatedCostMicros: null, costStatus: "unknown_no_usage" });
    expect(out.meta?.provider?.missing).toEqual(expect.arrayContaining(["inputTokens", "outputTokens"]));
    expect(out.meta?.costMicros).toBeNull();
    expect(g.spent()).toBe(2_418);
    expect(g.halted()).toMatch(/pricing uncertainty/);
  });
  it("a response with no model, no response id and no request-id header: all three are null, none filled from the request", async () => {
    const g = generator(transport(() => ({ body: body({ model: null, id: null }) })), { expectedServiceTier: undefined });
    const out = await g.generate(c);
    const p = out.meta!.provider!;
    expect(p).toMatchObject({ returnedModel: null, responseId: null, requestId: null, requestedModel: "gpt-6-luna", returnedServiceTier: "default" });
    expect(p.returnedModel).not.toBe(p.requestedModel);
    expect(p.missing).toEqual(expect.arrayContaining(["returnedModel", "responseId", "requestId"]));
  });
  it("the adapter's result keeps the REQUESTED model for routing and pricing, and the returned one separately in meta", async () => {
    const t = transport(() => ({ headers: withReq(), body: body({ model: null }) }));
    const stack = stackFor(t);
    const r = await stack.gateway.generate("openai", { task: "t", system: "s", prompt: "p", schemaHint: "{}", context: {}, schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never, model: "gpt-6-luna" });
    expect(r.model).toBe("gpt-6-luna");
    expect(r.meta?.returnedModel).toBeNull();
  });
  it("a local server's response id is not passed off as a server request id", async () => {
    const g = generator(transport(() => ({ body: body({ id: "resp_only" }) })), { expectedServiceTier: undefined });
    const out = await g.generate(c);
    expect(out.meta?.provider).toMatchObject({ responseId: "resp_only", requestId: null });
  });
});

/* ================================================================================ 8. the ledger */
describe("a metadata failure blocks the next invocation and keeps the ledger history", () => {
  const prior: LedgerEntry = { label: "cmp-3-2-original-rep1", arm: "original", startedAt: "t0", status: "finished", reservedMicros: 31_500, requests: 14, chargedMicros: 2_122, finishedAt: "t1" };
  const next = (): LedgerEntry => ({ label: "cmp-3-2-current-rep1", arm: "current", startedAt: "t2", status: "started", reservedMicros: 46_500, requests: 14 });

  it("a wrong tier halts, the entry closes as halted with the measured spend, and the next invocation is refused until reconciled", async () => {
    const t = transport(() => ({ headers: withReq("req_tier_ledger"), body: body({ tier: "priority" }) }));
    const g = generator(t);
    await g.generate(c);
    const ledger: Ledger = { experiment: "cmp-3-2", aggregateCeilingMicros: 156_000, maxTotalRequests: 56, entries: [structuredClone(prior), next()] };
    const before = structuredClone(ledger.entries[0]);
    closeEntry(ledger.entries[1]!, { spentMicros: g.spent(), accessChargedMicros: 0, requestsSent: t.seen.length, halted: g.halted(), inFlightReserveMicros: 2_418, finishedAt: "t3" });
    expect(ledger.entries[1]).toMatchObject({ status: "finished", requests: 1, chargedMicros: 470, halted: expect.stringMatching(/processing tier "priority"/) });
    expect(canStart(ledger, { reservedMicros: 1, requests: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/halted.*reconcile/) });
    expect(ledger.entries[0]).toEqual(before); // earlier history untouched
    expect(committedMicros(ledger)).toBe(2_122 + 470);
    reconcile(ledger, "Checked the account: the priority-tier request was billed at 470 micro-USD; the project setting is being corrected.", "t4");
    expect(canStart(ledger, { reservedMicros: 1, requests: 1 }).ok).toBe(true);
    expect(committedMicros(ledger)).toBe(2_122 + 470); // reconciling does not remove spend
    expect(ledger.entries).toHaveLength(2);
  });
  it("a missing tier and a wrong model block in exactly the same way", async () => {
    for (const o of [{ tier: null }, { model: "gpt-5.5" }] as const) {
      const g = generator(transport(() => ({ headers: withReq(), body: body(o) })));
      await g.generate(c);
      const e = next();
      closeEntry(e, { spentMicros: g.spent(), accessChargedMicros: 0, requestsSent: 1, halted: g.halted(), inFlightReserveMicros: 2_418, finishedAt: "t" });
      expect(e.halted).toBeDefined();
      expect(canStart({ experiment: "x", aggregateCeilingMicros: 156_000, maxTotalRequests: 56, entries: [e] }, { reservedMicros: 1, requests: 1 }).ok).toBe(false);
    }
  });
});

/* ================================================================================ reports and history */
describe("the sanitised evidence reaches the report, and previous results are untouched", () => {
  it("the report lists request ids, tiers, usage and cost per request, says 'unknown' for what was not returned, and carries no response text", async () => {
    const replies = [
      () => ({ headers: withReq("req_report_ok"), body: body() }),
      () => ({ headers: withReq("req_report_long"), body: body({ text: JSON.stringify({ ...(buildMockBrief(c.brain) as object), primaryTexts: ["T".repeat(126), "x"] }) }) }),
      () => ({ status: 500, headers: withReq("req_report_500"), body: { error: { type: "server_error", code: null, message: "x" } } }),
    ];
    const t = transport((n) => replies[n - 1]!());
    const g = generator(t, { haltOnUnknownCost: false });
    const report = await runEvaluation(EVAL_CASES.slice(0, 3), g.generate, "rep", "test");
    const md = renderMarkdown(report);
    expect(md).toMatch(/## Provider evidence per request/);
    for (const id of ["req_report_ok", "req_report_long", "req_report_500"]) expect(md).toContain(id);
    expect(md).toMatch(/gpt-6-luna \/ gpt-6-luna-2026-10-01/);
    expect(md).toMatch(/default \/ default/);
    expect(md).toMatch(/gpt-6-luna \/ unknown/); // the failed request returned no model
    expect(md).toMatch(/default \/ unknown/);
    expect(md).toMatch(/returnedModel, responseId, returnedServiceTier, responseStatus, inputTokens, outputTokens/);
    expect(md).not.toContain((buildMockBrief(c.brain) as { name: string }).name); // no response text
    const json = JSON.stringify(report);
    expect(json).not.toContain("T".repeat(120)); // the over-long text is not copied into the evidence
  });
  it("the committed results of invocation 1 are exactly as they were: its one unrecorded tier is still unknown, and no ids were back-filled", () => {
    const r = JSON.parse(readFileSync("docs/eval/cmp-3-2-original-rep1-openai-gpt_6_luna.json", "utf8")) as { cases: Array<{ caseId: string; meta: Record<string, unknown> }> };
    const e = r.cases.find((x) => x.caseId === "electrician-character-limits")!;
    expect(e.meta.serviceTier).toBeUndefined();
    for (const x of r.cases) expect(x.meta.provider, x.caseId).toBeUndefined();
    const ledger = JSON.parse(readFileSync("docs/eval/ledger-cmp-3-2.json", "utf8")) as Ledger;
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]).toMatchObject({ label: "cmp-3-2-original-rep1", status: "finished", requests: 14, chargedMicros: 2_122 });
  });
});

/* ================================================================================ 9. no network */
describe("no external request occurs in the default test suite", () => {
  it("every request in this file went to the scripted transport; the global fetch is the blocking stub and was not used", async () => {
    const t = transport(() => ({ headers: withReq(), body: body() }));
    await generator(t).generate(c);
    expect(t.seen.every((s) => s.url === URL_OK)).toBe(true);
    expect(String(globalThis.fetch)).toMatch(/NETWORK BLOCKED in tests/);
    expect(readFileSync("vitest.config.ts", "utf8")).toMatch(/setupFiles:\s*\[[^\]]*test\/setup\.ts/);
    expect(readFileSync("test/setup.ts", "utf8")).toMatch(/outbound network request\(s\) were attempted/); // an attempted call fails the test file
  });
});
