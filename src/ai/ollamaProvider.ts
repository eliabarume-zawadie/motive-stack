import { OpenAIProvider } from "./openaiProvider.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";

/**
 * Ollama must run on THIS machine. A remote host would mean business data leaving the machine under the
 * "local, no network egress" label, so anything other than loopback is refused at startup.
 */
export function assertLoopbackUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("OLLAMA_BASE_URL is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("OLLAMA_BASE_URL must be http or https");
  if (u.username || u.password) throw new Error("OLLAMA_BASE_URL must not contain credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("OLLAMA_BASE_URL must point at this machine (localhost, 127.0.0.1 or ::1). Remote model servers are not supported in local mode.");
  }
  return u;
}

export interface OllamaProviderOptions {
  /** Models configured in the registry for provider "ollama". */
  models: readonly string[];
  /** Local mode on? When false the provider is unavailable and never sends a request. */
  enabled: boolean;
  baseURL?: string;
  /** model id -> temperature (from the registry). Ollama recommends 0 for structured output. */
  temperatureByModel?: Record<string, number>;
  /** Per-attempt SDK timeout. CPU inference of a full brief takes minutes. Default 300s. */
  timeoutMs?: number;
  /** Test seam: lets tests drive the real SDK against a mocked HTTP layer. */
  fetch?: typeof fetch;
}

/**
 * Ollama via its OpenAI-compatible Responses endpoint (stateless flavor), reusing the OpenAI adapter.
 * Ollama ignores the API key but the SDK requires a value, so a fixed placeholder is used.
 * Wire protocol verified against a real local Ollama 0.40.3 (docs/ai-verification.md section 6). Output QUALITY is not: an 8B
 * model on CPU failed the application's field limits in every measured run. Ollama does not guarantee schema conformance,
 * so every result goes through the gateway's validation.
 */
export class OllamaProvider extends OpenAIProvider {
  constructor(o: OllamaProviderOptions) {
    const base = assertLoopbackUrl(o.baseURL ?? DEFAULT_OLLAMA_BASE_URL);
    super({
      id: "ollama",
      label: "Ollama (local)",
      local: true,
      apiKey: o.enabled ? "ollama" : undefined,
      models: o.models,
      baseURL: base.toString().replace(/\/$/, ""),
      timeoutMs: o.timeoutMs ?? 300_000,
      temperatureByModel: o.temperatureByModel,
      fetch: o.fetch,
    });
  }
}
