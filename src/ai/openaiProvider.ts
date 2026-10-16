import OpenAI from "openai";
import { mapSdkError } from "./sdkErrors.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult, type Usage } from "./types.js";

export interface OpenAIProviderOptions {
  /** Server-side only. Leave undefined to make the provider unavailable. */
  apiKey?: string;
  /** Configured model IDs (from the registry). The provider never hardcodes any. */
  models: readonly string[];
  baseURL?: string;
  /** Test seam: lets tests drive the REAL SDK against a mocked HTTP layer. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Identity overrides, so an OpenAI-compatible server (e.g. Ollama) can reuse this adapter under its own name. */
  id?: string;
  label?: string;
  /** True when the server runs on this machine. */
  local?: boolean;
  /** model id -> reasoning effort (from the registry). Bounds hidden reasoning tokens, which bill as output. */
  effortByModel?: Record<string, string>;
  /** model id -> sampling temperature (from the registry). 0 is sent as 0. */
  temperatureByModel?: Record<string, number>;
  /**
   * Pin the processing tier ("default" = standard pricing). Left unset, the account's project setting decides, and a project
   * configured for a faster tier would silently cost more. When set, the tier the response reports is returned so it can be checked.
   */
  serviceTier?: string;
  /**
   * The Responses API `store` parameter. `false` asks the API not to store the generated response for later retrieval. Left unset,
   * nothing is sent and the provider's default applies. This is application-level storage control only: it does not by itself
   * guarantee zero retention in the provider's logging or abuse-monitoring systems.
   */
  store?: boolean;
}

/** Subset of the Responses API result we read. */
interface ResponseLike {
  id?: string;
  _request_id?: string | null;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string }> }>;
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  service_tier?: string | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "result";

/** OpenAI adapter on the official SDK and the Responses API. Not verified against the live API by this repo. */
export class OpenAIProvider implements AiProvider {
  readonly id: string;
  readonly label: string;
  readonly simulated = false;
  readonly local: boolean;
  private client?: OpenAI;

  constructor(protected readonly opts: OpenAIProviderOptions) {
    this.id = opts.id ?? "openai";
    this.label = opts.label ?? "OpenAI";
    this.local = opts.local ?? false;
  }

  get models(): readonly string[] {
    return this.opts.models;
  }

  isAvailable(): boolean {
    return !!this.opts.apiKey && this.opts.models.length > 0;
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<ProviderResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      // The limits in schemaHint (lengths, counts) are NOT in the JSON schema, so they must always be stated here.
      // Without this a model happily returns well-formed JSON that fails validation every time.
      instructions: req.jsonSchema
        ? `${req.system}\nThe JSON object must satisfy these field rules exactly (they are checked after generation):\n${req.schemaHint}`
        : `${req.system}\nReturn ONLY one JSON object matching:\n${req.schemaHint}`,
      input: req.prompt,
      max_output_tokens: req.maxOutputTokens ?? 2000,
      text: {
        format: req.jsonSchema
          ? { type: "json_schema", name: safeName(req.task), strict: true, schema: req.jsonSchema }
          : { type: "json_object" },
      },
    };
    this.applyEffort(body, req.model);
    const resp = await this.call(body, req.signal);
    this.rejectIncomplete(resp);
    const serviceTier = resp.service_tier ?? undefined;
    const text = resp.output_text ?? "";
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AiError("invalid_output", `${this.label} returned malformed JSON`, { requestId: this.requestId(resp) });
    }
    return { raw, model: req.model, simulated: false, usage: this.usage(resp), requestId: this.requestId(resp), ...(serviceTier ? { serviceTier } : {}) };
  }

  async generateText(req: GenerateTextRequest): Promise<ProviderResult> {
    const body: Record<string, unknown> = { model: req.model, instructions: req.system, input: req.prompt, max_output_tokens: req.maxOutputTokens ?? 1000 };
    this.applyEffort(body, req.model);
    const resp = await this.call(body, req.signal);
    this.rejectIncomplete(resp, false);
    return { text: resp.output_text ?? "", model: req.model, simulated: false, usage: this.usage(resp), requestId: this.requestId(resp) };
  }

  private applyEffort(body: Record<string, unknown>, model: string): void {
    const effort = this.opts.effortByModel?.[model];
    if (effort) body.reasoning = { effort };
    if (this.opts.serviceTier) body.service_tier = this.opts.serviceTier;
    if (this.opts.store !== undefined) body.store = this.opts.store;
    const temperature = this.opts.temperatureByModel?.[model];
    if (temperature !== undefined) body.temperature = temperature;
  }

  private getClient(): OpenAI {
    if (!this.opts.apiKey) throw new AiError("provider_unavailable", `${this.label} is not configured${this.local ? "" : " (no server-side API key)"}`);
    this.client ??= new OpenAI({
      apiKey: this.opts.apiKey,
      baseURL: this.opts.baseURL,
      fetch: this.opts.fetch,
      maxRetries: 0, // retries are owned by the gateway so every attempt is counted and recorded
      timeout: this.opts.timeoutMs ?? 60_000,
    });
    return this.client;
  }

  private async call(body: Record<string, unknown>, signal?: AbortSignal): Promise<ResponseLike> {
    try {
      const create = this.getClient().responses.create.bind(this.getClient().responses) as unknown as (b: unknown, o: unknown) => Promise<ResponseLike>;
      return await create(body, { signal, maxRetries: 0 });
    } catch (e) {
      throw mapSdkError(this.label, e, [this.opts.apiKey]);
    }
  }

  private rejectIncomplete(r: ResponseLike, structured = true): void {
    const id = this.requestId(r);
    if (r.status === "incomplete") throw new AiError("invalid_output", `${this.label} output was cut off (${r.incomplete_details?.reason ?? "incomplete"})`, { requestId: id, usage: this.usage(r), truncated: true });
    if (structured && r.output?.some((o) => o.content?.some((c) => c.type === "refusal"))) throw new AiError("invalid_output", `${this.label} declined to produce the requested output`, { requestId: id, usage: this.usage(r) });
  }

  private usage(r: ResponseLike): Usage | undefined {
    const input = num(r.usage?.input_tokens);
    const output = num(r.usage?.output_tokens);
    return input === undefined && output === undefined ? undefined : { inputTokens: input, outputTokens: output, source: "provider" };
  }

  private requestId(r: ResponseLike): string | undefined {
    return r._request_id ?? r.id ?? undefined;
  }
}
