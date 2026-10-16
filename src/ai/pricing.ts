import { readFileSync } from "node:fs";
import { z } from "zod";
import type { CostStatus, Usage } from "./types.js";

/**
 * Pricing is CONFIGURATION, never code. Nothing is assumed: a model with no entry has an unknown cost.
 * Prices are integer micro-units of `currency` per 1,000,000 tokens (e.g. 3_000_000 = 3.00 per million tokens).
 * A price of 0 is rejected: a free-looking model is almost always a typo, and unknown must never look like zero.
 */
const Rate = z.object({
  inputPerMTokMicros: z.number().int().positive(),
  outputPerMTokMicros: z.number().int().positive(),
});

const PriceSchema = Rate.extend({
  provider: z.string(),
  model: z.string(),
  /**
   * Higher rates that apply to the WHOLE request once the prompt exceeds `aboveInputTokens`.
   * If a model has such a tier on the provider's price list it must be configured here; otherwise a request
   * above the base tier's limit is priced as unknown rather than guessed.
   */
  longContext: Rate.extend({ aboveInputTokens: z.number().int().positive() }).optional(),
  /** Largest prompt (input tokens) the base rate is valid for, when the provider documents none for a tier. */
  baseValidUpToInputTokens: z.number().int().positive().optional(),
  /** What these numbers assume, e.g. "standard tier, global routing, no caching, no batch". */
  appliesTo: z.string(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().url(),
});
const PricingFileSchema = z.object({ currency: z.string().default("USD"), prices: z.array(PriceSchema).default([]) }).passthrough();

export type PriceEntry = z.infer<typeof PriceSchema>;

export class PricingTable {
  constructor(
    readonly currency: string,
    private readonly prices: PriceEntry[],
  ) {}

  static empty(): PricingTable {
    return new PricingTable("USD", []);
  }

  static fromFile(path: string): PricingTable {
    const parsed = PricingFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return new PricingTable(parsed.currency, parsed.prices);
  }

  has(provider: string, model: string): boolean {
    return this.prices.some((p) => p.provider === provider && p.model === model);
  }

  entry(provider: string, model: string): PriceEntry | undefined {
    return this.prices.find((p) => p.provider === provider && p.model === model);
  }

  /**
   * Estimated cost in micro-units, or null with the reason it is unknown. Provider-reported usage is never altered.
   * Uses the long-context rate when the prompt is above the configured threshold. If the prompt is above the
   * base tier's documented limit and no higher tier is configured, the cost is unknown (never guessed).
   */
  estimate(provider: string, model: string, usage: Usage | undefined, simulated: boolean): { micros: number | null; status: CostStatus } {
    if (simulated) return { micros: null, status: "not_applicable" };
    const price = this.entry(provider, model);
    if (!price) return { micros: null, status: "unknown_no_pricing" };
    if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) return { micros: null, status: "unknown_no_usage" };
    let rate: { inputPerMTokMicros: number; outputPerMTokMicros: number } = price;
    if (price.longContext && usage.inputTokens > price.longContext.aboveInputTokens) rate = price.longContext;
    else if (price.baseValidUpToInputTokens && usage.inputTokens > price.baseValidUpToInputTokens) return { micros: null, status: "unknown_no_pricing" };
    const micros = Math.round((usage.inputTokens * rate.inputPerMTokMicros + usage.outputTokens * rate.outputPerMTokMicros) / 1_000_000);
    return { micros, status: "estimated" };
  }
}
