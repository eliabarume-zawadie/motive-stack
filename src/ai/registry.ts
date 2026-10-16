import { readFileSync } from "node:fs";
import { z } from "zod";

/** Model capability metadata. This is how a new provider (e.g. a Llama host) declares what it can do. */
export const ModelEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  label: z.string().min(1),
  enabled: z.boolean().default(true),
  /** Tasks this model may be used for. */
  tasks: z.array(z.string()).min(1),
  capabilities: z.object({ text: z.boolean().default(true), structuredOutput: z.boolean().default(false) }).default({}),
  /** Used only for deterministic automatic routing: cheaper tiers are preferred. */
  costTier: z.enum(["low", "medium", "high"]).default("medium"),
  /** Per-attempt timeout for this model, in ms (slow local models need minutes). Defaults to the gateway timeout. */
  timeoutMs: z.number().int().positive().max(1_800_000).optional(),
  /** Sampling temperature sent with every request to this model (e.g. 0 for deterministic structured output). */
  temperature: z.number().min(0).max(2).optional(),
  /**
   * Context window of this model as actually served (tokens). When set, a request whose estimated prompt plus output
   * cap would not fit is REFUSED instead of sent: some servers (Ollama) silently truncate oversized prompts.
   */
  contextTokens: z.number().int().positive().optional(),
  /** Reasoning/effort level sent with every request to this model, to bound hidden reasoning tokens (billed as output). */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  notes: z.string().optional(),
});
export type ModelEntry = z.infer<typeof ModelEntrySchema>;

const RegistryFileSchema = z.object({ models: z.array(ModelEntrySchema) }).passthrough();

const TIER = { low: 0, medium: 1, high: 2 } as const;

export class ModelRegistry {
  constructor(readonly entries: ModelEntry[]) {
    const seen = new Set<string>();
    for (const e of entries) {
      const k = `${e.provider}/${e.model}`;
      if (seen.has(k)) throw new Error(`Duplicate model entry ${k}`);
      seen.add(k);
    }
  }

  static fromFile(path: string): ModelRegistry {
    return new ModelRegistry(RegistryFileSchema.parse(JSON.parse(readFileSync(path, "utf8"))).models);
  }

  find(provider: string, model: string): ModelEntry | undefined {
    return this.entries.find((e) => e.provider === provider && e.model === model);
  }

  modelsFor(provider: string): string[] {
    return this.entries.filter((e) => e.provider === provider && e.enabled).map((e) => e.model);
  }

  /** model id -> reasoning effort, for one provider. */
  effortFor(provider: string): Record<string, string> {
    return Object.fromEntries(this.entries.filter((e) => e.provider === provider && e.reasoningEffort).map((e) => [e.model, e.reasoningEffort as string]));
  }

  /** model id -> sampling temperature, for one provider. Zero is a real setting, not "unset". */
  temperatureFor(provider: string): Record<string, number> {
    return Object.fromEntries(this.entries.filter((e) => e.provider === provider && e.temperature !== undefined).map((e) => [e.model, e.temperature as number]));
  }

  providers(): string[] {
    return [...new Set(this.entries.map((e) => e.provider))];
  }

  /** Deterministic order: cost tier, then provider id, then model id. */
  static order(a: ModelEntry, b: ModelEntry): number {
    return TIER[a.costTier] - TIER[b.costTier] || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
  }
}
