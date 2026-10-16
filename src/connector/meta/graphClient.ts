import { MetaApiError, classifyGraphError } from "./errors.js";

export interface GraphClientOptions {
  token: string;
  version: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Extra attempts for GET requests on rate-limit, transient or timeout errors. Default 3. */
  maxReadRetries?: number;
}

const BASE = "https://graph.facebook.com";
const RETRYABLE = new Set(["rate_limit", "transient", "timeout"]);

/**
 * Minimal Graph API client.
 * - Token travels in the Authorization header only, never in URLs, logs or error messages.
 * - GET is retried with backoff; POST is NEVER retried (a failed POST may still have succeeded).
 */
export class GraphClient {
  private readonly token: string;
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxReadRetries: number;

  constructor(opts: GraphClientOptions) {
    this.token = opts.token;
    this.version = opts.version;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxReadRetries = opts.maxReadRetries ?? 3;
  }

  async get(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const url = `${BASE}/${this.version}/${path}${query ? `?${query}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send(url, { method: "GET" }, false);
      } catch (e) {
        if (!(e instanceof MetaApiError) || !RETRYABLE.has(e.kind) || attempt >= this.maxReadRetries) throw e;
        await this.sleep(Math.min(1000 * 2 ** attempt, 8000));
      }
    }
  }

  /** Single attempt. On timeout the error has outcomeUnknown = true: reconcile, do not retry. */
  async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) form.set(k, typeof v === "string" ? v : JSON.stringify(v));
    const url = `${BASE}/${this.version}/${path}`;
    return this.send(url, { method: "POST", body: form.toString() }, true);
  }

  private async send(url: string, init: { method: string; body?: string }, isWrite: boolean): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
    try {
      const res = await this.fetchImpl(url, { ...init, headers, signal: controller.signal });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new MetaApiError("invalid_response", `Non-JSON response (HTTP ${res.status})`, {
          httpStatus: res.status,
          outcomeUnknown: isWrite && res.ok,
        });
      }
      if (!res.ok || (parsed as { error?: unknown })?.error) throw classifyGraphError(res.status, parsed, this.token);
      return parsed;
    } catch (e) {
      if (e instanceof MetaApiError) throw e;
      if ((e as { name?: string })?.name === "AbortError") {
        throw new MetaApiError("timeout", `Request timed out after ${this.timeoutMs}ms`, { outcomeUnknown: isWrite });
      }
      throw new MetaApiError("transient", "Network error", { outcomeUnknown: isWrite });
    } finally {
      clearTimeout(timer);
    }
  }
}
