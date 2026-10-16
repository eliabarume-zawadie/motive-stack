import Anthropic from "@anthropic-ai/sdk";
import { mapSdkError } from "./sdkErrors.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult, type Usage } from "./types.js";

export interface AnthropicProviderOptions {
  /** Server-side only. Leave undefined to make the provider unavailable. */
  apiKey?: string;
  /** Configured model IDs (from the registry). The provider never hardcodes any. */
  models: readonly string[];
  baseURL?: string;
  /** Test seam: lets tests drive the REAL SDK against a mocked HTTP layer. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** model id -> effort level (from the registry). Sent as output_config.effort to bound thinking tokens. */
  effortByModel?: Record<string, string>;
}

interface MessageLike {
  _request_id?: string | null;
  id?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Anthropic adapter on the official SDK and the Messages API (native structured output). Not verified live by this repo. */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic";
  readonly label = "Anthropic";
  readonly simulated = false;
  private client?: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {}

  get models(): readonly string[] {
    return this.opts.models;
  }

  isAvailable(): boolean {
    return !!this.opts.apiKey && this.opts.models.length > 0;
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<ProviderResult> {
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 2000,
      // The limits in schemaHint (lengths, counts) are NOT in the JSON schema, so they must always be stated here.
      system: req.jsonSchema
        ? `${req.system}\nThe JSON object must satisfy these field rules exactly (they are checked after generation):\n${req.schemaHint}`
        : `${req.system}\nRespond with ONLY one JSON object matching:\n${req.schemaHint}`,
      messages: [{ role: "user", content: req.prompt }],
    };
    const outputConfig: Record<string, unknown> = {};
    if (req.jsonSchema) outputConfig.format = { type: "json_schema", schema: req.jsonSchema };
    const effort = this.opts.effortByModel?.[req.model];
    if (effort) outputConfig.effort = effort;
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;

    const msg = await this.call(params, req.signal);
    const id = this.requestId(msg);
    if (msg.stop_reason === "refusal") throw new AiError("invalid_output", "Anthropic declined to produce the requested output", { requestId: id, usage: this.usage(msg) });
    if (msg.stop_reason === "max_tokens") throw new AiError("invalid_output", "Anthropic output was cut off (max_tokens)", { requestId: id, usage: this.usage(msg), truncated: true });

    const text = (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new AiError("invalid_output", "Anthropic returned no JSON object", { requestId: id });
    let raw: unknown;
    try {
      raw = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new AiError("invalid_output", "Anthropic returned malformed JSON", { requestId: id });
    }
    return { raw, model: req.model, simulated: false, usage: this.usage(msg), requestId: id };
  }

  async generateText(req: GenerateTextRequest): Promise<ProviderResult> {
    const params: Record<string, unknown> = { model: req.model, max_tokens: req.maxOutputTokens ?? 1000, system: req.system, messages: [{ role: "user", content: req.prompt }] };
    const effort = this.opts.effortByModel?.[req.model];
    if (effort) params.output_config = { effort };
    const msg = await this.call(params, req.signal);
    const text = (msg.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return { text, model: req.model, simulated: false, usage: this.usage(msg), requestId: this.requestId(msg) };
  }

  private getClient(): Anthropic {
    if (!this.opts.apiKey) throw new AiError("provider_unavailable", "Anthropic is not configured (no server-side API key)");
    this.client ??= new Anthropic({
      apiKey: this.opts.apiKey,
      baseURL: this.opts.baseURL,
      fetch: this.opts.fetch,
      maxRetries: 0, // retries are owned by the gateway so every attempt is counted and recorded
      timeout: this.opts.timeoutMs ?? 60_000,
    });
    return this.client;
  }

  private async call(params: Record<string, unknown>, signal?: AbortSignal): Promise<MessageLike> {
    try {
      const client = this.getClient();
      const create = client.messages.create.bind(client.messages) as unknown as (p: unknown, o: unknown) => Promise<MessageLike>;
      return await create(params, { signal, maxRetries: 0 });
    } catch (e) {
      throw mapSdkError("Anthropic", e, [this.opts.apiKey]);
    }
  }

  private usage(m: MessageLike): Usage | undefined {
    const input = num(m.usage?.input_tokens);
    const output = num(m.usage?.output_tokens);
    return input === undefined && output === undefined ? undefined : { inputTokens: input, outputTokens: output, source: "provider" };
  }

  private requestId(m: MessageLike): string | undefined {
    return m._request_id ?? m.id ?? undefined;
  }
}
