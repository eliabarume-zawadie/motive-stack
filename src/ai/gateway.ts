import type { ZodIssue } from "zod";
import { PricingTable } from "./pricing.js";
import {
  AiError,
  type AiProvider,
  type AttemptRecord,
  type CostStatus,
  type GatewayResult,
  type GenerateObjectRequest,
  type GenerateTextRequest,
  type ProviderResult,
  type ResponseMeta,
  type Usage,
} from "./types.js";

export interface ProviderInfo {
  id: string;
  label: string;
  models: string[];
  available: boolean;
  simulated: boolean;
  local: boolean;
}

export interface GatewayOptions {
  /** Extra attempts after a retryable failure (rate limit, timeout, server error). Default 2. */
  maxRetries?: number;
  /** Per-attempt timeout. Default 60s. */
  timeoutMs?: number;
  /** Bounded repair attempts after invalid output (0 or 1). Default 1. */
  repairAttempts?: 0 | 1;
  pricing?: PricingTable;
  /** Injectable for tests. Must reject if the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CallOptions {
  signal?: AbortSignal;
  /** Per-attempt timeout for this call (e.g. slow local models). Defaults to the gateway timeout. */
  timeoutMs?: number;
  /** Called after EVERY provider attempt (success or failure) so callers can record usage. */
  observer?: (a: AttemptRecord) => void;
  /**
   * Checks what the provider said about a response (processing tier, model) BEFORE its content is parsed or validated, and returns
   * a reason to reject it, or undefined to accept. Receives undefined when the provider returned no metadata. A rejection is a
   * "response_rejected" error that is never retried or repaired; usage and cost of the rejected attempt are still recorded.
   * Because it runs first, a malformed or invalid answer cannot slip past it.
   */
  responseGuard?: (meta: ResponseMeta | undefined) => string | undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AiError("cancelled", "Cancelled while waiting to retry"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new AiError("cancelled", "Cancelled while waiting to retry")); }, { once: true });
  });

type Verdict<V> = { ok: true; value: V } | { ok: false; issues: string; previous?: string };

/**
 * The single entry point to every model provider. It does NOT authorize or execute anything:
 * it only generates, validates, measures and prices. Output is returned only after schema validation.
 */
export class AiGateway {
  private readonly byId = new Map<string, AiProvider>();
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly repairAttempts: number;
  private readonly pricing: PricingTable;
  private readonly sleep: NonNullable<GatewayOptions["sleep"]>;

  constructor(providers: AiProvider[], opts: GatewayOptions = {}) {
    for (const p of providers) this.byId.set(p.id, p);
    this.maxRetries = opts.maxRetries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.repairAttempts = opts.repairAttempts ?? 1;
    this.pricing = opts.pricing ?? PricingTable.empty();
    this.sleep = opts.sleep ?? defaultSleep;
  }

  list(): ProviderInfo[] {
    return [...this.byId.values()].map((p) => ({ id: p.id, label: p.label, models: [...p.models], available: p.isAvailable(), simulated: p.simulated, local: p.local === true }));
  }

  get(providerId: string): AiProvider | undefined {
    return this.byId.get(providerId);
  }

  get currency(): string {
    return this.pricing.currency;
  }

  /** The retry, repair and timeout settings in force (recorded with each generation so results are reproducible). */
  settings(): { maxRetries: number; repairAttempts: number; timeoutMs: number } {
    return { maxRetries: this.maxRetries, repairAttempts: this.repairAttempts, timeoutMs: this.timeoutMs };
  }

  hasPrice(provider: string, model: string): boolean {
    return this.pricing.has(provider, model);
  }

  /** Structured generation. The returned object has passed the caller's runtime schema. */
  async generate<T>(providerId: string, req: GenerateObjectRequest<T>, call: CallOptions = {}): Promise<GatewayResult<T>> {
    const p = this.resolve(providerId, req.model);
    return this.execute<T>(p, req.model, call, {
      invoke: (note, signal) => p.generateObject({ ...req, signal, prompt: note ? `${req.prompt}\n\n---\n${note}` : req.prompt }),
      interpret: (r) => {
        const parsed = req.schema.safeParse(r.raw);
        if (parsed.success) return { ok: true, value: parsed.data };
        const issues = parsed.error.issues.map((i) => describeIssue(i, r.raw)).join("; ");
        return { ok: false, issues, previous: safeJson(r.raw) };
      },
      assign: (res, v) => { res.structuredOutput = v; },
    });
  }

  async generateText(providerId: string, req: GenerateTextRequest, call: CallOptions = {}): Promise<GatewayResult<string>> {
    const p = this.resolve(providerId, req.model);
    return this.execute<string>(p, req.model, call, {
      invoke: (_note, signal) => p.generateText({ ...req, signal }),
      interpret: (r) => (r.text && r.text.trim() ? { ok: true, value: r.text } : { ok: false, issues: "empty text" }),
      assign: (res, v) => { res.text = v; },
    });
  }

  private resolve(providerId: string, model: string): AiProvider {
    const p = this.byId.get(providerId);
    if (!p) throw new AiError("unknown_provider", `Unknown AI provider "${providerId}"`);
    if (!p.models.includes(model)) throw new AiError("unknown_model", `Provider "${providerId}" has no configured model "${model}"`);
    if (!p.isAvailable()) throw new AiError("provider_unavailable", `Provider "${providerId}" is not available`);
    return p;
  }

  private async execute<V>(
    p: AiProvider,
    model: string,
    call: CallOptions,
    h: {
      invoke: (repairNote: string | undefined, signal: AbortSignal) => Promise<ProviderResult>;
      interpret: (r: ProviderResult) => Verdict<V>;
      assign: (res: GatewayResult<V>, v: V) => void;
    },
  ): Promise<GatewayResult<V>> {
    const attempts: AttemptRecord[] = [];
    const t0 = performance.now();
    let retriesLeft = this.maxRetries;
    let repairsLeft = this.repairAttempts;
    let kind: AttemptRecord["kind"] = "initial";
    let note: string | undefined;
    let lastRaw: unknown;
    let lastTruncated = false;
    let lastMeta: ResponseMeta | undefined;

    const finish = (err: AiError): never => {
      err.attempts = attempts;
      throw err;
    };
    const record = (start: number, outcome: AttemptRecord["outcome"], usage: Usage | undefined, requestId: string | undefined, msg?: string, meta?: ResponseMeta): AttemptRecord => {
      const cost = p.local ? { micros: null, status: "local_no_charge" as CostStatus } : this.pricing.estimate(p.id, model, usage, p.simulated);
      const rec: AttemptRecord = {
        attemptNo: attempts.length + 1, kind, provider: p.id, model, simulated: p.simulated, outcome,
        latencyMs: Math.round(performance.now() - start), usage, requestId,
        estimatedCostMicros: cost.micros, costStatus: cost.status, errorMessage: msg,
        ...(meta ? { meta } : {}),
      };
      attempts.push(rec);
      call.observer?.(rec);
      return rec;
    };

    for (;;) {
      if (call.signal?.aborted) return finish(new AiError("cancelled", "Request was cancelled"));
      const attemptTimeout = call.timeoutMs ?? this.timeoutMs;
      const timeoutSignal = AbortSignal.timeout(attemptTimeout);
      const signal = AbortSignal.any(call.signal ? [call.signal, timeoutSignal] : [timeoutSignal]);
      const start = performance.now();

      let verdict: Verdict<V>;
      let res: ProviderResult | undefined;
      try {
        lastRaw = undefined;
        lastMeta = undefined;
        res = await h.invoke(note, signal);
        lastRaw = res.raw;
        lastMeta = res.meta;
        lastTruncated = false;
        // The response's own metadata is checked BEFORE its content is looked at, so nothing malformed can bypass it.
        const rejected = call.responseGuard?.(res.meta);
        if (rejected) throw new AiError("response_rejected", rejected, { usage: res.usage, requestId: res.meta?.requestId ?? res.requestId, meta: res.meta });
        verdict = h.interpret(res);
      } catch (e) {
        let err = e instanceof AiError ? e : new AiError("provider_unavailable", "Unexpected provider failure");
        // The SDKs report our own abort as "cancelled"; distinguish a timeout from a caller cancel.
        if (call.signal?.aborted) err = new AiError("cancelled", "Request was cancelled");
        else if (timeoutSignal.aborted && err.kind === "cancelled") err = new AiError("timeout", `Request timed out after ${attemptTimeout}ms`, { retryable: true });

        // An answer the adapter itself rejected (cut off, refused, malformed JSON) still arrived with metadata: check that too.
        if (err.kind === "invalid_output" && err.meta) {
          const rejected = call.responseGuard?.(err.meta);
          if (rejected) err = new AiError("response_rejected", rejected, { usage: err.usage, requestId: err.requestId, meta: err.meta });
        }
        lastMeta = err.meta;
        if (err.kind === "invalid_output") {
          record(start, "invalid_output", err.usage, err.requestId, err.message, err.meta);
          verdict = { ok: false, issues: err.message };
          lastTruncated = err.truncated === true;
        } else {
          record(start, err.kind, err.usage, err.requestId, err.message, err.meta);
          if (err.retryable && retriesLeft > 0) {
            retriesLeft--;
            try {
              await this.sleep(err.retryAfterMs ?? Math.min(500 * 2 ** (this.maxRetries - retriesLeft - 1), 4000), call.signal);
            } catch (se) {
              return finish(se instanceof AiError ? se : new AiError("cancelled", "Request was cancelled"));
            }
            kind = "retry";
            note = undefined;
            continue;
          }
          return finish(err);
        }
      }

      if (verdict.ok) {
        const out = res as ProviderResult;
        record(start, "ok", out.usage, out.requestId, undefined, out.meta);
        return this.build(p, model, out, verdict.value, attempts, t0, h.assign);
      }

      // Invalid output (failed validation, malformed, cut off). Record it if we have not already (validation case).
      if (res) record(start, "invalid_output", res.usage, res.requestId, verdict.issues, res.meta);
      if (repairsLeft > 0 && (verdict.issues.length > 0)) {
        repairsLeft--;
        kind = "repair";
        note = `Your previous output was rejected by validation: ${verdict.issues}.${verdict.previous ? `\nPrevious output:\n${verdict.previous}` : ""}\nReturn a corrected JSON object only. Do not invent facts you were not given; list missing facts in openQuestions.`;
        continue;
      }
      const failure = new AiError("invalid_output", `Model output failed validation: ${verdict.issues}`, { truncated: lastTruncated, usage: attempts[attempts.length - 1]?.usage, requestId: lastMeta?.requestId ?? undefined, meta: lastMeta });
      if (lastRaw !== undefined) failure.rawOutput = lastRaw;
      return finish(failure);
    }
  }

  private build<V>(
    p: AiProvider, model: string, out: ProviderResult, value: V, attempts: AttemptRecord[], t0: number,
    assign: (r: GatewayResult<V>, v: V) => void,
  ): GatewayResult<V> {
    const sum = (f: "inputTokens" | "outputTokens"): number | undefined =>
      attempts.every((a) => a.usage?.[f] !== undefined) ? attempts.reduce((s, a) => s + (a.usage?.[f] ?? 0), 0) : undefined;
    const input = sum("inputTokens");
    const output = sum("outputTokens");
    const known = attempts.filter((a) => a.estimatedCostMicros !== null);
    let costStatus: CostStatus;
    let cost: number | null;
    if (p.simulated) { costStatus = "not_applicable"; cost = null; }
    else if (p.local) { costStatus = "local_no_charge"; cost = null; }
    else if (known.length === attempts.length) { costStatus = "estimated"; cost = known.reduce((s, a) => s + (a.estimatedCostMicros ?? 0), 0); }
    else if (known.length > 0) { costStatus = "partial"; cost = known.reduce((s, a) => s + (a.estimatedCostMicros ?? 0), 0); }
    else { costStatus = attempts[attempts.length - 1]?.costStatus ?? "unknown_no_usage"; cost = null; }

    const res: GatewayResult<V> = {
      status: "ok", provider: p.id, model, simulated: p.simulated,
      usage: input === undefined && output === undefined ? null : { inputTokens: input, outputTokens: output, source: p.simulated ? "simulated" : "provider" },
      latencyMs: Math.round(performance.now() - t0), requestId: out.requestId,
      estimatedCostMicros: cost, costStatus, attempts,
      ...(out.serviceTier || out.meta?.returnedServiceTier ? { serviceTier: out.serviceTier ?? out.meta?.returnedServiceTier ?? undefined } : {}),
      ...(out.meta ? { meta: out.meta } : {}),
    };
    assign(res, value);
    return res;
  }
}

function valueAt(raw: unknown, path: Array<string | number>): unknown {
  let cur: unknown = raw;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/**
 * One validation issue as feedback for a repair attempt. "At most 40 characters" is not actionable for a model that
 * cannot count (small local models in particular), so over-limit strings and lists also say how big they actually are.
 * Only sizes are added, never the offending text, so this stays safe to store and to show.
 */
function describeIssue(i: ZodIssue, raw: unknown): string {
  const where = i.path.join(".") || "(root)";
  const base = `${where}: ${i.message}`;
  if (i.code === "too_big") {
    const v = valueAt(raw, i.path);
    if (i.type === "string" && typeof v === "string") return `${base} (it is ${v.length} characters; rewrite it shorter, at most ${i.maximum})`;
    if (i.type === "array" && Array.isArray(v)) return `${base} (it has ${v.length} items; keep at most ${i.maximum})`;
  }
  return base;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 4000);
  } catch {
    return "";
  }
}
