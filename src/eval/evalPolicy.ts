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
