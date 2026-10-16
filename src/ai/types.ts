import type { z } from "zod";

/**
 * Normalized failure kinds. Providers' own error shapes never leave the adapters.
 * Fallback to another provider is permitted ONLY for: rate_limit, timeout, provider_unavailable.
 */
export type AiErrorKind =
  | "unknown_provider"
  | "unknown_model"
  | "not_eligible" // no configured model is allowed to handle this task
  | "provider_unavailable" // not configured, or the provider is down (see `retryable`)
  | "auth" // missing/invalid/forbidden credentials
  | "insufficient_balance" // account quota or credit exhausted
  | "rate_limit"
  | "timeout"
  | "invalid_request"
  | "invalid_output" // output failed validation or was cut off / refused
  | "budget_exhausted" // our own configured usage limit
  | "budget_unverifiable" // a cost limit is set but the cost of this model is unknown
  | "live_disabled"
  | "cancelled";

export const FALLBACK_ELIGIBLE: ReadonlySet<AiErrorKind> = new Set(["rate_limit", "timeout", "provider_unavailable"]);

export class AiError extends Error {
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  /** Tokens the provider reported for the request that failed (e.g. a cut-off response is still billed). */
  readonly usage?: Usage;
  /** True when the output was cut off at the token limit (nothing parseable exists). */
  readonly truncated?: boolean;
  /** The model's last output when it was received but failed validation. Model output, never a secret. */
  rawOutput?: unknown;
  /** Attempts made before this error surfaced (filled in by the gateway). */
  attempts: AttemptRecord[] = [];

  constructor(
    readonly kind: AiErrorKind,
    message: string,
    opts: { retryable?: boolean; requestId?: string; retryAfterMs?: number; httpStatus?: number; usage?: Usage; truncated?: boolean } = {},
  ) {
    super(message);
    this.name = "AiError";
    this.retryable = opts.retryable ?? false;
    this.requestId = opts.requestId;
    this.retryAfterMs = opts.retryAfterMs;
    this.httpStatus = opts.httpStatus;
    this.usage = opts.usage;
    this.truncated = opts.truncated;
  }
}

/** Token usage. A missing count means "unknown", never zero. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** "provider": reported by the provider. "simulated": produced by the mock, not a real measurement. */
  source: "provider" | "simulated";
}

export interface GenerateObjectRequest<T> {
  /** Stable task name, e.g. "campaign_brief". */
  task: string;
  system: string;
  prompt: string;
  /** Human-readable description of the required JSON shape (used by providers without native structured output). */
  schemaHint: string;
  /** JSON Schema for native structured output. Must avoid unsupported keywords; the zod schema is the real validator. */
  jsonSchema?: Record<string, unknown>;
  /** Structured input. Real providers ignore it (the prompt carries it); the mock uses it for determinism. */
  context: unknown;
  /** Runtime validator applied by the gateway to every provider result. */
  schema: z.ZodType<T>;
  model: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface GenerateTextRequest {
  task: string;
  system: string;
  prompt: string;
  context?: unknown;
  model: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** What an adapter returns. RAW: the gateway validates, measures latency and prices it. */
export interface ProviderResult {
  raw?: unknown;
  text?: string;
  model: string;
  usage?: Usage;
  requestId?: string;
  /** The processing tier the provider says it used (affects price). Absent when the provider does not report one. */
  serviceTier?: string;
  simulated: boolean;
}

export interface AiProvider {
  readonly id: string;
  readonly label: string;
  readonly models: readonly string[];
  /** True for the offline mock. Its results are always labelled simulated. */
  readonly simulated: boolean;
  /** True for a model server on THIS machine (e.g. Ollama): real model output, no network egress, no per-token charge. */
  readonly local?: boolean;
  /** False when disabled or missing credentials. Unavailable providers can never be selected. */
  isAvailable(): boolean;
  generateObject<T>(req: GenerateObjectRequest<T>): Promise<ProviderResult>;
  generateText(req: GenerateTextRequest): Promise<ProviderResult>;
}

export type CostStatus =
  | "estimated" // computed from provider-reported usage and a configured price
  | "partial" // some attempts were priced, others were not
  | "unknown_no_pricing" // no price configured for this model
  | "unknown_no_usage" // provider did not report token usage
  | "not_applicable" // simulated (mock) result
  | "local_no_charge"; // ran on this machine: no per-token charge (electricity is not counted)

export interface AttemptRecord {
  attemptNo: number;
  kind: "initial" | "retry" | "repair";
  provider: string;
  model: string;
  simulated: boolean;
  outcome: "ok" | AiErrorKind;
  latencyMs: number;
  usage?: Usage;
  requestId?: string;
  /** Integer micro-units of the pricing currency. null = unknown. */
  estimatedCostMicros: number | null;
  costStatus: CostStatus;
  errorMessage?: string;
}

export interface GatewayResult<T> {
  status: "ok";
  provider: string;
  model: string;
  simulated: boolean;
  text?: string;
  structuredOutput?: T;
  /** Summed over attempts. Fields stay undefined when any attempt did not report them. */
  usage: Usage | null;
  latencyMs: number;
  requestId?: string;
  estimatedCostMicros: number | null;
  costStatus: CostStatus;
  attempts: AttemptRecord[];
  /** The processing tier reported by the provider for the final attempt, when it reports one. */
  serviceTier?: string;
}
