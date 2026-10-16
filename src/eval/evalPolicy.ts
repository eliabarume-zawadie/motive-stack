/**
 * The settings an evaluation invocation runs under. They are set here, not left to whatever the shell happens to contain, and
 * a conflicting environment is an error, so the cost bound (standard tier) and the data policy (no stored responses) cannot be
 * quietly undone by a stray variable.
 */
export interface EvalPolicyInput { repair: number; retries: number; maxOutputTokens: number; serviceTier?: string }

export const EVAL_SERVICE_TIER = "default";

export function evaluationEnv(base: Record<string, string | undefined>, i: EvalPolicyInput): Record<string, string | undefined> {
  if (base.OPENAI_SERVICE_TIER && base.OPENAI_SERVICE_TIER !== EVAL_SERVICE_TIER) throw new Error(`OPENAI_SERVICE_TIER is "${base.OPENAI_SERVICE_TIER}" in the environment; an evaluation must run on the "${EVAL_SERVICE_TIER}" tier because its cost bound assumes standard pricing`);
  if (base.OPENAI_STORE && base.OPENAI_STORE !== "false") throw new Error(`OPENAI_STORE is "${base.OPENAI_STORE}" in the environment; an evaluation must run with response storage disabled (store:false)`);
  return {
    ...base,
    OPENAI_SERVICE_TIER: EVAL_SERVICE_TIER,
    OPENAI_STORE: "false", // synthetic data only, and no reason for the provider to keep the responses for later retrieval
    AI_REPAIR_ATTEMPTS: String(i.repair),
    AI_MAX_RETRIES: String(i.retries),
    AI_MAX_OUTPUT_TOKENS: String(i.maxOutputTokens),
  };
}

/**
 * The standard rates read from the provider's pricing page, per model, on the date shown. A registered experiment (one with a ledger)
 * runs only on a model listed here, and only while the recorded price equals these rates. The recorded price file alone cannot catch
 * its own error; this is a second, independent statement of what was read from the provider.
 */
export const VERIFIED_RATES: Record<string, { inputPerMTokMicros: number; outputPerMTokMicros: number; readOn: string; source: string }> = {
  "openai/gpt-6-luna": { inputPerMTokMicros: 100_000, outputPerMTokMicros: 500_000, readOn: "2026-10-16", source: "https://developers.openai.com/api/docs/pricing" },
};

/** Why the recorded price cannot be trusted for a registered experiment, or undefined when it matches the verified rates. */
export function verifiedRatesProblem(provider: string, model: string, price: { inputPerMTokMicros: number; outputPerMTokMicros: number } | undefined): string | undefined {
  const v = VERIFIED_RATES[`${provider}/${model}`];
  if (!price) return "no recorded price, so spend cannot be limited";
  if (!v) return `pricing is ambiguous: no rates for ${provider}/${model} have been read from the provider's pricing page for this experiment`;
  if (price.inputPerMTokMicros !== v.inputPerMTokMicros || price.outputPerMTokMicros !== v.outputPerMTokMicros) {
    return `pricing is ambiguous: the recorded price (${price.inputPerMTokMicros}/${price.outputPerMTokMicros}) differs from the rates read from the provider on ${v.readOn} (${v.inputPerMTokMicros}/${v.outputPerMTokMicros})`;
  }
  return undefined;
}
