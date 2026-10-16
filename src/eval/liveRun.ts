import type { AiGateway } from "../ai/gateway.js";
import { CampaignBriefSchema, type BusinessBrain } from "../domain/schemas.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../domain/campaignJsonSchema.js";
import { buildCampaignPrompt } from "../app/campaignPrompt.js";
import { AiError } from "../ai/types.js";
import { currentGenerationIdentity } from "../app/versions.js";
import type { Generator, RunMeta } from "./evaluate.js";
import { buildOriginalPrompt, ORIGINAL_HINT, ORIGINAL_JSON_SCHEMA, OriginalCampaignBriefSchema, originalGenerationIdentity, projectToOriginalBrain } from "./original.js";

/**
 * Support for running the evaluation against a REAL model. Everything here is opt-in and budget-limited; the default
 * test suite exercises it only with fake providers. Use synthetic, non-sensitive data only (the fixtures are invented).
 */

/**
 * current  = the candidate prompt AND the current output contract.
 * original = the recovered pre-Milestone-3 prompt AND its own output contract and Business Brain (the faithful baseline).
 * legacy   = the original prompt text with the CURRENT output contract. Kept so earlier reports stay reproducible; it is NOT a faithful baseline.
 */
export type PromptVariant = "current" | "original" | "legacy";

export function identityOf(variant: PromptVariant): NonNullable<RunMeta["identity"]> {
  if (variant === "current") return currentGenerationIdentity();
  if (variant === "original") return originalGenerationIdentity();
  const cur = currentGenerationIdentity();
  const orig = originalGenerationIdentity();
  return { promptVersion: "campaign-prompt/1.0.0-original (with the current output contract; not a faithful baseline)", promptSha256: orig.promptSha256, schemaVersion: cur.schemaVersion, schemaSha256: cur.schemaSha256 };
}

/** The prompt the application used before Milestone 3, kept so a real model can be compared on the OLD vs NEW instructions. */
export function buildLegacyPrompt(brain: BusinessBrain): { system: string; prompt: string } {
  return {
    system:
      "You are a marketing strategist for small local service businesses. Be specific, honest and compliant with ad policies. " +
      "Use ONLY facts present in the Business Brain. Never invent prices, licenses, years in business, awards, guarantees or reviews. " +
      "If a fact you would need is missing, leave it out of the ad copy and list it in openQuestions; record any assumption in assumptions.",
    prompt: `Create a lead-generation campaign brief for this business. dailyBudgetCents must not exceed maxDailyBudgetCents.\nBusiness Brain:\n${JSON.stringify(brain)}`,
  };
}

export class BudgetExhausted extends Error {
  constructor(readonly spentMicros: number, readonly limitMicros: number) {
    super(`evaluation budget reached (${spentMicros} of ${limitMicros} micro-USD): stopped before sending more requests`);
  }
}

export interface LiveOptions {
  gateway: AiGateway;
  provider: string;
  model: string;
  prompt: PromptVariant;
  /** Hard ceiling for THIS run's estimated spend, in micro-USD. Requests stop before it would be exceeded. */
  budgetMicros: number;
  maxOutputTokens: number;
  /** Per-request cost estimate used for the pre-check, in micro-USD. A request is not sent if spent + this would exceed the budget. */
  reserveMicros?: number;
  /** Per-case reserve; takes precedence over reserveMicros. Used so each request reserves ITS OWN worst case. */
  reserveForCase?: (c: import("./fixtures.js").EvalCase) => number;
  /**
   * Most attempts one request may take (default 1: no retry and no repair). A request that needed more HALTS the run: more
   * spend than planned happened, so nothing further is sent until a person looks.
   */
  maxAttemptsPerRequest?: number;
  /** Halt when a request's cost cannot be determined (default true): spend is then unmeasured, so the budget cannot be trusted. */
  haltOnUnknownCost?: boolean;
  /**
   * The processing tier the cost bound assumes (OpenAI: "default" = standard). When set, a response that reports a different tier,
   * or none, HALTS the run: the price may differ (a faster tier is priced higher), so the bound no longer holds.
   */
  expectedServiceTier?: string;
}

/**
 * A generator that returns the model's RAW output (structure checked leniently) so the evaluation can show which rules it
 * breaks. Repair is whatever the gateway was configured with: construct the gateway with repairAttempts 0 to measure first-try quality.
 */
export function makeLiveGenerator(o: LiveOptions): { generate: Generator; spent: () => number; halted: () => string | undefined } {
  let spent = 0;
  let halted: string | undefined;
  let consecutiveProviderErrors = 0;
  const reserve = o.reserveMicros ?? 0;
  const maxAttempts = o.maxAttemptsPerRequest ?? 1;
  const haltOnUnknownCost = o.haltOnUnknownCost ?? true;
  const generate: Generator = async (c) => {
    if (halted) return { error: halted };
    const caseReserve = o.reserveForCase ? o.reserveForCase(c) : reserve;
    if (spent + caseReserve > o.budgetMicros) return { error: new BudgetExhausted(spent, o.budgetMicros).message };
    const original = o.prompt === "original";
    const { system, prompt } = (original ? buildOriginalPrompt : o.prompt === "legacy" ? buildLegacyPrompt : buildCampaignPrompt)(c.brain);
    const identity = identityOf(o.prompt);
    try {
      const r = await o.gateway.generate(o.provider, {
        task: "campaign_brief", system, prompt, schemaHint: original ? ORIGINAL_HINT : CAMPAIGN_BRIEF_HINT,
        jsonSchema: (original ? ORIGINAL_JSON_SCHEMA : CAMPAIGN_BRIEF_JSON_SCHEMA) as unknown as Record<string, unknown>,
        // The original system could only hold, and was only ever given, the original Business Brain fields.
        context: original ? projectToOriginalBrain(c.brain) : c.brain, schema: original ? OriginalCampaignBriefSchema : CampaignBriefSchema,
        model: o.model, maxOutputTokens: o.maxOutputTokens,
      });
      consecutiveProviderErrors = 0;
      if (r.estimatedCostMicros === null || r.estimatedCostMicros === undefined) {
        spent += caseReserve; // unmeasured spend is charged at the worst-case reserve, never counted as free
        if (haltOnUnknownCost) halted = "stopped: a request's cost could not be determined (pricing uncertainty), so the budget can no longer be trusted";
      } else spent += r.estimatedCostMicros;
      if (r.attempts.length > maxAttempts) halted = `stopped: a request needed ${r.attempts.length} attempts (limit ${maxAttempts}); retries and repairs are not permitted in this run`;
      // The reserve is the worst case the recorded price and the pinned tier allow. A request that cost MORE means one of those assumptions is wrong.
      if (typeof r.estimatedCostMicros === "number" && r.estimatedCostMicros > caseReserve && caseReserve > 0) halted = `stopped: a request cost ${r.estimatedCostMicros} micro-USD, more than its worst-case reserve of ${caseReserve}; the price or tier assumed by the cost bound is wrong`;
      if (o.expectedServiceTier && r.serviceTier !== o.expectedServiceTier) halted = `stopped: the provider reported the processing tier "${r.serviceTier ?? "none"}" instead of "${o.expectedServiceTier}", so the price assumed by the cost bound may not apply`;
      const meta: RunMeta = {
        model: `${r.provider}/${r.model}`, latencyMs: r.latencyMs, inputTokens: r.usage?.inputTokens, outputTokens: r.usage?.outputTokens,
        costMicros: r.estimatedCostMicros, attempts: r.attempts.length, identity, ...(r.serviceTier ? { serviceTier: r.serviceTier } : {}),
      };
      return { raw: r.structuredOutput, meta };
    } catch (e) {
      const err = e as AiError;
      // Failed attempts can still be billed (a cut-off response is). Count the reported cost; an attempt that reported
      // no usage is charged at the worst-case reserve rather than treated as free.
      const attempts = err.attempts ?? [];
      let cost = 0;
      let unpriced = 0;
      for (const a of attempts) {
        if (a.estimatedCostMicros === null || a.estimatedCostMicros === undefined) { unpriced++; cost += caseReserve; } else cost += a.estimatedCostMicros;
      }
      spent += cost;
      if (unpriced > 0 && haltOnUnknownCost) halted = "stopped: a failed request reported no usage, so its cost is only an estimate (pricing uncertainty)";
      if (attempts.length > maxAttempts) halted = `stopped: a request needed ${attempts.length} attempts (limit ${maxAttempts}); retries and repairs are not permitted in this run`;
      const sum = (f: "inputTokens" | "outputTokens") => (attempts.length > 0 && attempts.every((a) => a.usage?.[f] !== undefined) ? attempts.reduce((s, a) => s + (a.usage?.[f] ?? 0), 0) : undefined);
      const meta: RunMeta = {
        identity, model: `${o.provider}/${o.model}`, attempts: attempts.length, latencyMs: attempts.reduce((s, a) => s + a.latencyMs, 0),
        inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), costMicros: cost,
        ...(unpriced ? { costNote: `${unpriced} attempt(s) reported no usage and were charged at the worst-case reserve (${caseReserve} micro-USD) instead of being treated as free` } : {}),
      };
      const message = `${err.kind ?? "error"}: ${String(err.message).slice(0, 300)}`;
      // A request the provider REJECTS (4xx other than rate limiting) will be rejected again: sending the rest would only repeat the error.
      if (err.httpStatus !== undefined && err.httpStatus >= 400 && err.httpStatus < 500 && err.httpStatus !== 429) {
        halted = `stopped: the provider rejected a request (HTTP ${err.httpStatus}, ${err.kind}); the request itself needs fixing before anything more is sent`;
      }
      // Repeated failures that are not a bad answer (outages, timeouts, rate limits) mean the run is not working; do not keep sending.
      if (err.kind !== "invalid_output" && ++consecutiveProviderErrors >= 3) halted ??= "stopped: 3 consecutive requests failed at the provider; the run is not working and nothing more will be sent";
      if (err.rawOutput !== undefined) return { raw: err.rawOutput, schemaError: message, meta };
      return { error: message, truncated: err.truncated === true, meta };
    }
  };
  return { generate, spent: () => spent, halted: () => halted };
}

/**
 * Confirm the account can actually use a model BEFORE any billable request. A model appearing in documentation or in
 * this repository's registry is not proof that this account has access. Uses each provider's free "retrieve model" endpoint.
 */
export async function verifyModelAccess(
  provider: "openai" | "anthropic",
  model: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const url = provider === "openai" ? `https://api.openai.com/v1/models/${encodeURIComponent(model)}` : `https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`;
  const headers: Record<string, string> = provider === "openai" ? { Authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  try {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.ok) return { ok: true, detail: "model is available to this account" };
    if (r.status === 401 || r.status === 403) return { ok: false, detail: `the key was rejected (HTTP ${r.status})` };
    if (r.status === 404) return { ok: false, detail: "this account cannot see that model ID (HTTP 404)" };
    return { ok: false, detail: `unexpected response (HTTP ${r.status})` };
  } catch {
    return { ok: false, detail: "could not reach the provider" };
  }
}

/**
 * A transport-level cap: the (max+1)th HTTP request is refused before it leaves the process. Retries and repairs are already off in
 * the gateway and the SDK; this makes it physically impossible for either, or any bug, to send more requests than planned.
 */
export function capRequests(inner: typeof fetch, max: number): { fetch: typeof fetch; sent: () => number } {
  let sent = 0;
  const capped = (async (...args: Parameters<typeof fetch>) => {
    if (sent >= max) throw new Error(`refused: the planned limit of ${max} HTTP request(s) for this invocation has been reached`);
    sent++;
    return inner(...args);
  }) as typeof fetch;
  return { fetch: capped, sent: () => sent };
}
