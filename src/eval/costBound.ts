/**
 * Worst-case cost of ONE generation request, from locally recorded prices. Shared by the live CLI (its per-request reserve) and
 * the offline plan, so the plan can never promise a different number than the run enforces.
 *
 * Two input bounds are kept apart on purpose:
 *   estimated  characters / 3 plus headroom. A heuristic, calibrated against billed requests (see the plan). Not a guarantee.
 *   absolute   UTF-8 bytes. A token is never shorter than one byte, so this cannot be exceeded whatever the tokenizer does.
 * The output side is bounded by the provider-enforced max output token cap, which includes hidden reasoning tokens.
 */
export interface PriceLike {
  inputPerMTokMicros: number;
  outputPerMTokMicros: number;
  longContext?: { aboveInputTokens: number; inputPerMTokMicros: number; outputPerMTokMicros: number };
}

export const INPUT_HEADROOM_TOKENS = 400;

/** Everything sent as input for one request: system text, the user prompt, and the output contract (JSON schema and field hint). */
export const requestText = (p: { system: string; prompt: string }, contract: string): string => `${p.system}\n${p.prompt}\n${contract}`;

export const estimatedInputTokens = (text: string): number => Math.ceil(text.length / 3) + INPUT_HEADROOM_TOKENS;
export const absoluteInputTokens = (text: string): number => Buffer.byteLength(text, "utf8");

/** Micro-USD (rounded up) for the given token counts. A request that could cross the long-context threshold is priced at the long-context rates. */
export function worstCaseMicros(inputTokens: number, maxOutputTokens: number, price: PriceLike): number {
  const long = price.longContext && inputTokens > price.longContext.aboveInputTokens ? price.longContext : undefined;
  const inRate = long?.inputPerMTokMicros ?? price.inputPerMTokMicros;
  const outRate = long?.outputPerMTokMicros ?? price.outputPerMTokMicros;
  return Math.ceil((inputTokens * inRate + maxOutputTokens * outRate) / 1e6);
}

/** Cost of what a request actually used, from provider-reported usage. */
export const actualMicros = (inputTokens: number, outputTokens: number, price: PriceLike): number => worstCaseMicros(inputTokens, outputTokens, price);
