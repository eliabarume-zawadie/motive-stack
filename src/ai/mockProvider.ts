import { createHash } from "node:crypto";
import { BusinessBrainSchema, type BusinessBrain } from "../domain/schemas.js";
import { buildMockBrief, type BadMode } from "./mockBrief.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult } from "./types.js";

export type MockBehavior = "ok" | "invalid" | "over_budget" | "unavailable" | "throws" | Exclude<BadMode, "none">;

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const approxTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4));
const reqId = (seed: string): string => `mock-${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`;

/** Deterministic stand-in for a model. Same input, same output, no network. Everything it returns is `simulated`. */
export class MockAiProvider implements AiProvider {
  readonly id = "mock";
  readonly label = "Mock (deterministic, offline)";
  readonly models = ["mock-deterministic-1"] as const;
  readonly simulated = true;

  constructor(private readonly behavior: MockBehavior = "ok") {}

  isAvailable(): boolean {
    return this.behavior !== "unavailable";
  }

  async generateObject<T>(req: GenerateObjectRequest<T>): Promise<ProviderResult> {
    if (req.signal?.aborted) throw new AiError("cancelled", "Mock request was cancelled");
    if (this.behavior === "throws") throw new AiError("provider_unavailable", "Mock provider failure");
    if (this.behavior === "invalid") return this.result({ name: 42, nonsense: true }, req.prompt, req.model);
    if (req.task !== "campaign_brief") throw new AiError("invalid_request", `Mock does not support task "${req.task}"`);

    const brain: BusinessBrain = BusinessBrainSchema.parse(req.context);
    const plain: ReadonlyArray<string> = ["ok", "over_budget", "invalid", "unavailable", "throws"];
    const mode = (plain.includes(this.behavior) ? "none" : this.behavior) as BadMode;
    const brief = buildMockBrief(brain, mode);
    if (this.behavior === "over_budget") brief.dailyBudgetCents = brain.maxDailyBudgetCents + 100;
    return this.result(brief, req.prompt, req.model);
  }

  async generateText(req: GenerateTextRequest): Promise<ProviderResult> {
    if (req.signal?.aborted) throw new AiError("cancelled", "Mock request was cancelled");
    if (this.behavior === "throws") throw new AiError("provider_unavailable", "Mock provider failure");
    const text = req.task === "connection_test" ? "pong (simulated)" : `Simulated text for task "${req.task}".`;
    return { text, model: req.model, simulated: true, requestId: reqId(req.prompt), usage: { inputTokens: approxTokens(req.prompt), outputTokens: approxTokens(text), source: "simulated" } };
  }

  private result(raw: unknown, prompt: string, model: string): ProviderResult {
    const out = JSON.stringify(raw);
    return { raw, model, simulated: true, requestId: reqId(prompt), usage: { inputTokens: approxTokens(prompt), outputTokens: approxTokens(out), source: "simulated" } };
  }
}
