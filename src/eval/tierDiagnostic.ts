import { z } from "zod";
import { AiGateway } from "../ai/gateway.js";
import { OpenAIProvider } from "../ai/openaiProvider.js";
import type { PricingTable } from "../ai/pricing.js";
import { ModelRegistry } from "../ai/registry.js";
import { AiError } from "../ai/types.js";
import { absoluteInputTokens, actualMicros, requestText, worstCaseMicros, type PriceLike } from "./costBound.js";
import { VERIFIED_RATES } from "./evalPolicy.js";
import { canStart, committedMicros, loadLedger, saveLedger, type Ledger, type LedgerEntry } from "./ledger.js";

/**
 * ONE live diagnostic generation, to find out whether OpenAI's Responses API honours and reports the processing tier before any
 * evaluation is run. It exists because a GET on the model endpoint says nothing about how a generation is served or priced.
 *
 * The same code runs for real and under test (the tests pass a scripted fetch), so what is tested is what runs.
 * Guarantees, each enforced here and checked by tests:
 *   - at most ONE HTTP request is ever made (a second is refused before it leaves the process), no retries, no repair;
 *   - nothing is sent unless the worst case, including the pricing uplift and a faster-tier contingency, fits the budget;
 *   - the API key is used only to build the provider; it is never put in a record, a log line or an error message;
 *   - the aggregate ledger (ceiling = the budget, one request) is written before sending, so the run cannot be repeated;
 *   - only synthetic input; no advertising, CRM or other action exists on this path.
 */
export const DIAG = {
  provider: "openai",
  model: "gpt-6-luna",
  serviceTier: "default",
  maxOutputTokens: 128,
  budgetMicros: 2000,
  /** The provider's documented regional-processing uplift; it cannot be ruled out for this model or account. */
  uplift: 1.1,
  /** If the tier were NOT honoured and a faster one served the request, the published price is twice standard. Still has to fit. */
  fasterTierFactor: 2,
  /** The standard short-context rates read from the provider's pricing page on the date below. The recorded price must equal them. */
  verifiedRates: VERIFIED_RATES["openai/gpt-6-luna"]!,
  system: "You are a connectivity probe. Reply with one small JSON object and nothing else.",
  prompt: 'This is a synthetic test with no business data. Return the JSON object {"ok": true, "word": "pong"}.',
} as const;

export const DiagnosticOutputSchema = z.object({ ok: z.boolean(), word: z.string().max(40) }).strict();
const JSON_SCHEMA = { type: "object", additionalProperties: false, required: ["ok", "word"], properties: { ok: { type: "boolean" }, word: { type: "string" } } } as const;
const HINT = '{ "ok": boolean, "word": string (<= 40 chars) }';
/** The adapter wraps the system text and the hint in a fixed sentence; allow generously for it. */
const ADAPTER_WRAPPER_ALLOWANCE_BYTES = 300;

export interface Reserve { inputBytes: number; reserveMicros: number; fasterTierMicros: number; fitsBudget: boolean; priceMatchesDocs: boolean; why: string }

/** The worst case for the one request, and whether it may be sent at all. */
export function reserveFor(price: PriceLike | undefined): Reserve {
  const inputBytes = absoluteInputTokens(requestText({ system: DIAG.system, prompt: DIAG.prompt }, JSON.stringify(JSON_SCHEMA) + HINT)) + ADAPTER_WRAPPER_ALLOWANCE_BYTES;
  if (!price) return { inputBytes, reserveMicros: 0, fasterTierMicros: 0, fitsBudget: false, priceMatchesDocs: false, why: "no recorded price, so the cost cannot be bounded" };
  const priceMatchesDocs = price.inputPerMTokMicros === DIAG.verifiedRates.inputPerMTokMicros && price.outputPerMTokMicros === DIAG.verifiedRates.outputPerMTokMicros;
  const reserveMicros = Math.ceil(worstCaseMicros(inputBytes, DIAG.maxOutputTokens, price) * DIAG.uplift);
  const faster = { ...price, inputPerMTokMicros: price.inputPerMTokMicros * DIAG.fasterTierFactor, outputPerMTokMicros: price.outputPerMTokMicros * DIAG.fasterTierFactor };
  const fasterTierMicros = Math.ceil(worstCaseMicros(inputBytes, DIAG.maxOutputTokens, faster) * DIAG.uplift);
  const fitsBudget = Math.max(reserveMicros, fasterTierMicros) <= DIAG.budgetMicros;
  const why = !priceMatchesDocs ? "the recorded price differs from the rates read from the provider's pricing page; pricing is ambiguous" : !fitsBudget ? `worst case ${Math.max(reserveMicros, fasterTierMicros)} micro-USD exceeds the ${DIAG.budgetMicros} micro-USD budget` : "within budget";
  return { inputBytes, reserveMicros, fasterTierMicros, fitsBudget: fitsBudget && priceMatchesDocs, priceMatchesDocs, why };
}

export interface Check { id: string; pass: boolean; detail: string }
export interface DiagnosticRecord {
  startedAt: string;
  mode: "sent" | "refused";
  refusedBecause?: string;
  budgetMicros: number;
  reserve: Reserve;
  httpRequests: number;
  request?: { method: string; host: string; path: string; sent: { model?: string; service_tier?: string; max_output_tokens?: number; store?: unknown; reasoning?: unknown } };
  http?: { status: number; requestId?: string };
  response?: { id?: string; status?: string; model?: string; service_tier?: string | null; usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: unknown }; incomplete?: unknown; errorType?: string; errorCode?: string };
  adapter?: { serviceTier?: string; usage?: { inputTokens?: number; outputTokens?: number }; requestId?: string; estimatedCostMicros: number | null; costStatus?: string; latencyMs?: number; attempts: number };
  parsedOk?: boolean;
  error?: { kind: string; httpStatus?: number; message: string };
  calculatedCostMicros?: number;
  ledger?: { path: string; committedBefore: number; chargedMicros: number; committedAfter: number };
  checks: Check[];
  passed: boolean;
}

interface Captured { calls: number; request?: DiagnosticRecord["request"]; http?: DiagnosticRecord["http"]; response?: DiagnosticRecord["response"] }

/** Wraps fetch so that exactly one request can leave, and records what was sent and returned without ever recording a header. */
function recordingFetch(inner: typeof fetch, cap: Captured): typeof fetch {
  return (async (url: string | URL | Request, init: RequestInit = {}) => {
    cap.calls++;
    if (cap.calls > 1) throw new Error("refused: this diagnostic permits exactly one HTTP request");
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    cap.request = { method: String(init.method ?? "GET"), host: u.host, path: u.pathname, sent: { model: body.model as string, service_tier: body.service_tier as string, max_output_tokens: body.max_output_tokens as number, store: body.store, reasoning: body.reasoning } };
    const res = await inner(url as never, init);
    cap.http = { status: res.status, requestId: res.headers.get("x-request-id") ?? undefined };
    try {
      const j = (await res.clone().json()) as Record<string, any>;
      cap.response = {
        id: j.id, status: j.status, model: j.model, service_tier: j.service_tier,
        usage: j.usage ? { input_tokens: j.usage.input_tokens, output_tokens: j.usage.output_tokens, output_tokens_details: j.usage.output_tokens_details } : undefined,
        incomplete: j.incomplete_details ?? undefined, errorType: j.error?.type ?? undefined, errorCode: j.error?.code ?? undefined, // the error MESSAGE is deliberately not kept
      };
    } catch { /* not JSON: nothing to record */ }
    return res;
  }) as typeof fetch;
}

export interface RunInput {
  apiKey: string;
  fetchImpl: typeof fetch;
  ledgerPath: string;
  pricing: PricingTable;
  registry: ModelRegistry;
  now?: () => Date;
}

const redact = (s: string, secret: string) => (secret && s.includes(secret) ? s.split(secret).join("[redacted]") : s);

/** The checks that decide whether the diagnostic passed. Pure, so every failure mode can be tested. */
export function validate(r: Omit<DiagnosticRecord, "checks" | "passed">, price: PriceLike | undefined): Check[] {
  const out: Check[] = [];
  const add = (id: string, pass: boolean, detail: string) => out.push({ id, pass, detail });
  const u = r.response?.usage;
  const a = r.adapter;
  add("exactly_one_http_request", r.httpRequests === 1, `${r.httpRequests} request(s) were made`);
  add("request_targeted_responses_api", r.request?.method === "POST" && r.request?.host === "api.openai.com" && r.request?.path === "/v1/responses", `${r.request?.method} ${r.request?.host}${r.request?.path}`);
  add("request_pinned_model_tier_and_cap", r.request?.sent.model === DIAG.model && r.request?.sent.service_tier === DIAG.serviceTier && r.request?.sent.max_output_tokens === DIAG.maxOutputTokens, `model=${r.request?.sent.model} service_tier=${r.request?.sent.service_tier} max_output_tokens=${r.request?.sent.max_output_tokens}`);
  add("http_200", r.http?.status === 200, `HTTP ${r.http?.status ?? "none"}`);
  add("request_id_returned", !!(r.http?.requestId || r.response?.id), `header x-request-id=${r.http?.requestId ?? "none"}, response id=${r.response?.id ?? "none"}`);
  add("response_completed", r.response?.status === "completed", `status=${r.response?.status ?? "none"}`);
  add("returned_tier_is_default", r.response?.service_tier === DIAG.serviceTier, `response service_tier=${JSON.stringify(r.response?.service_tier ?? null)}`);
  add("adapter_reports_same_tier", a?.serviceTier === DIAG.serviceTier, `adapter serviceTier=${JSON.stringify(a?.serviceTier ?? null)}`);
  add("model_is_gpt_6_luna", typeof r.response?.model === "string" && r.response.model.startsWith(DIAG.model), `response model=${r.response?.model ?? "none"}`);
  add("output_valid", r.parsedOk === true, r.parsedOk === true ? "parsed and valid against the schema" : "output missing or invalid");
  add("usage_present", Number.isInteger(u?.input_tokens) && Number.isInteger(u?.output_tokens), `input_tokens=${u?.input_tokens ?? "none"} output_tokens=${u?.output_tokens ?? "none"}`);
  add("output_within_cap", (u?.output_tokens ?? Infinity) <= DIAG.maxOutputTokens, `${u?.output_tokens ?? "none"} <= ${DIAG.maxOutputTokens}`);
  add("adapter_usage_matches_response", Number.isInteger(a?.usage?.inputTokens) && Number.isInteger(a?.usage?.outputTokens) && a?.usage?.inputTokens === u?.input_tokens && a?.usage?.outputTokens === u?.output_tokens, `adapter ${a?.usage?.inputTokens}/${a?.usage?.outputTokens} vs response ${u?.input_tokens}/${u?.output_tokens}`);
  const calc = price && Number.isInteger(u?.input_tokens) && Number.isInteger(u?.output_tokens) ? actualMicros(u!.input_tokens!, u!.output_tokens!, price) : undefined;
  add("cost_calculated_from_usage", calc !== undefined && a?.estimatedCostMicros !== null && a?.estimatedCostMicros !== undefined && Math.abs(a.estimatedCostMicros - calc) <= 1, `gateway ${a?.estimatedCostMicros ?? "none"} vs independent ${calc ?? "none"} micro-USD`);
  add("cost_within_reserve_and_budget", calc !== undefined && calc <= r.reserve.reserveMicros && calc <= DIAG.budgetMicros, `${calc ?? "none"} <= reserve ${r.reserve.reserveMicros} <= budget ${DIAG.budgetMicros}`);
  add("no_retry_or_repair", (a?.attempts ?? 0) === 1, `${a?.attempts ?? 0} attempt(s)`);
  add("ledger_recorded_within_budget", !!r.ledger && r.ledger.chargedMicros <= DIAG.budgetMicros && r.ledger.committedAfter <= DIAG.budgetMicros, r.ledger ? `charged ${r.ledger.chargedMicros}, committed ${r.ledger.committedAfter} of ${DIAG.budgetMicros}` : "no ledger entry");
  return out;
}

export async function runTierDiagnostic(i: RunInput): Promise<DiagnosticRecord> {
  const now = i.now ?? (() => new Date());
  const price = i.pricing.entry(DIAG.provider, DIAG.model);
  const reserve = reserveFor(price);
  const base = { startedAt: now().toISOString(), budgetMicros: DIAG.budgetMicros, reserve, httpRequests: 0 };
  const refuse = (why: string): DiagnosticRecord => ({ ...base, mode: "refused", refusedBecause: why, checks: [], passed: false });

  if (!reserve.fitsBudget) return refuse(reserve.why);
  if (!i.apiKey) return refuse("OPENAI_API_KEY is not set");

  const ledger: Ledger = loadLedger(i.ledgerPath, { experiment: "tier-diagnostic", aggregateCeilingMicros: DIAG.budgetMicros, maxTotalRequests: 1 });
  const gate = canStart(ledger, { reservedMicros: reserve.reserveMicros, requests: 1 });
  if (!gate.ok) return refuse(gate.reason);
  const committedBefore = committedMicros(ledger);
  const entry: LedgerEntry = { label: "tier-diagnostic", arm: "diagnostic", startedAt: base.startedAt, status: "started", reservedMicros: Math.max(reserve.reserveMicros, reserve.fasterTierMicros), requests: 1 };
  ledger.entries.push(entry);
  saveLedger(i.ledgerPath, ledger); // written BEFORE the request: a crash or interrupt leaves a pessimistic entry and blocks a repeat

  const cap: Captured = { calls: 0 };
  const provider = new OpenAIProvider({ apiKey: i.apiKey, models: [DIAG.model], effortByModel: i.registry.effortFor("openai"), serviceTier: DIAG.serviceTier, fetch: recordingFetch(i.fetchImpl, cap), timeoutMs: 30_000 });
  const gateway = new AiGateway([provider], { pricing: i.pricing, maxRetries: 0, repairAttempts: 0, timeoutMs: 30_000, sleep: async () => {} });

  const rec: Omit<DiagnosticRecord, "checks" | "passed"> = { ...base, mode: "sent" };
  try {
    const out = await gateway.generate(DIAG.provider, {
      task: "live_probe", system: DIAG.system, prompt: DIAG.prompt, schemaHint: HINT, jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
      context: {}, schema: DiagnosticOutputSchema, model: DIAG.model, maxOutputTokens: DIAG.maxOutputTokens,
    });
    rec.parsedOk = DiagnosticOutputSchema.safeParse(out.structuredOutput).success;
    rec.adapter = { serviceTier: out.serviceTier, usage: { inputTokens: out.usage?.inputTokens, outputTokens: out.usage?.outputTokens }, requestId: out.requestId, estimatedCostMicros: out.estimatedCostMicros, costStatus: out.costStatus, latencyMs: out.latencyMs, attempts: out.attempts.length };
  } catch (e) {
    const err = e as AiError;
    rec.error = { kind: err.kind ?? "error", httpStatus: err.httpStatus, message: redact(String(err.message ?? e).slice(0, 300), i.apiKey) };
    rec.adapter = { estimatedCostMicros: null, attempts: err.attempts?.length ?? 0, ...(err.usage ? { usage: { inputTokens: err.usage.inputTokens, outputTokens: err.usage.outputTokens } } : {}) };
    rec.parsedOk = false;
  }
  rec.httpRequests = cap.calls;
  rec.request = cap.request;
  rec.http = cap.http;
  rec.response = cap.response;

  // Charge what was measured; if nothing measurable came back, charge the reserve, never zero.
  const u = cap.response?.usage;
  const calc = price && Number.isInteger(u?.input_tokens) && Number.isInteger(u?.output_tokens) ? actualMicros(u!.input_tokens!, u!.output_tokens!, price) : undefined;
  rec.calculatedCostMicros = calc;
  const charged = calc ?? Math.max(reserve.reserveMicros, reserve.fasterTierMicros);
  Object.assign(entry, { status: "finished", chargedMicros: charged, requests: cap.calls, finishedAt: now().toISOString(), halted: undefined });
  saveLedger(i.ledgerPath, ledger);
  rec.ledger = { path: i.ledgerPath, committedBefore, chargedMicros: charged, committedAfter: committedMicros(ledger) };

  const checks = validate(rec, price);
  return { ...rec, checks, passed: checks.every((c) => c.pass) };
}
