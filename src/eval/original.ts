import { z } from "zod";
import type { BusinessBrain } from "../domain/schemas.js";
import { outputContractSha256 } from "../app/versions.js";
import { sha256 } from "../app/util.js";

/**
 * THE ORIGINAL (pre-Milestone-3) CAMPAIGN GENERATION CONTRACT, frozen for fair comparison. Do not edit.
 *
 * HOW IT WAS RECOVERED. The repository has no Git history (no commits), so the original could not be read from version
 * control. It was rebuilt by replaying, in order, every recorded Write/Edit tool call against `src/domain/schemas.ts`,
 * `src/app/campaigns.ts` and `src/domain/campaignJsonSchema.ts` in the saved session transcript, up to the message that
 * began Milestone 3. All 10 recorded edits applied cleanly and none was skipped.
 *
 * HOW IT WAS CHECKED. (1) The recovered system prompt is character-identical to the prompt the first live run used and that
 * `src/eval/liveRun.ts` already carried as `buildLegacyPrompt`. (2) The real gpt-6-luna output recorded on 2026-10-16 (produced
 * by the original code) parses under the recovered strict schema. Both are asserted in test/original.test.ts.
 *
 * WHAT THIS CANNOT PROVE. Edits made outside the recorded Write/Edit tool calls (for example by a shell command) would not be
 * in the replay. None is known, and the two checks above agree, but this is a reconstruction, not a copy from version control.
 *
 * NOT RECONSTRUCTED: the original mock model's output, and any UI. Only the prompt, the Business Brain contract, and the
 * brief contract that a live model sees are recovered, because those are what a model comparison needs.
 */

export const ORIGINAL_PROMPT_VERSION = "campaign-prompt/1.0.0-original";
export const ORIGINAL_SCHEMA_VERSION = "campaign-brief-schema/1.0.0-original";

export const ORIGINAL_SYSTEM_PROMPT =
  "You are a marketing strategist for small local service businesses. Be specific, honest and compliant with ad policies. " +
  "Use ONLY facts present in the Business Brain. Never invent prices, licenses, years in business, awards, guarantees or reviews. " +
  "If a fact you would need is missing, leave it out of the ad copy and list it in openQuestions; record any assumption in assumptions.";

/** The Business Brain the original system could hold. It had no field for verified facts, pricing, unverified claims or provenance. */
export const OriginalBusinessBrainSchema = z.object({
  businessName: z.string().trim().min(2).max(100),
  industry: z.string().trim().min(2).max(100),
  services: z.array(z.string().trim().min(2).max(100)).min(1).max(20),
  serviceArea: z.string().trim().min(2).max(200),
  targetCustomer: z.string().trim().min(2).max(300),
  offer: z.string().trim().min(2).max(300),
  tone: z.string().trim().min(2).max(100).default("friendly and professional"),
  differentiators: z.array(z.string().trim().min(2).max(200)).max(10).default([]),
  maxDailyBudgetCents: z.number().int().positive().max(1_000_000),
}).strict();
export type OriginalBusinessBrain = z.infer<typeof OriginalBusinessBrainSchema>;

/** What the original system would have been given for a brain: only the fields it had. Information it could not hold is not sent. */
export function projectToOriginalBrain(brain: BusinessBrain): OriginalBusinessBrain {
  return OriginalBusinessBrainSchema.parse({
    businessName: brain.businessName, industry: brain.industry, services: brain.services, serviceArea: brain.serviceArea,
    targetCustomer: brain.targetCustomer, offer: brain.offer, tone: brain.tone, differentiators: brain.differentiators,
    maxDailyBudgetCents: brain.maxDailyBudgetCents,
  });
}

export function buildOriginalPrompt(brain: BusinessBrain): { system: string; prompt: string } {
  return {
    system: ORIGINAL_SYSTEM_PROMPT,
    prompt: `Create a lead-generation campaign brief for this business. dailyBudgetCents must not exceed maxDailyBudgetCents.\nBusiness Brain:\n${JSON.stringify(projectToOriginalBrain(brain))}`,
  };
}

/** The original brief contract. Note what it cannot express: budget or targeting reasoning, differentiator decisions, variations, review flags, question impact. */
export const OriginalCampaignBriefSchema = z.object({
  name: z.string().trim().min(3).max(80),
  objective: z.literal("OUTCOME_LEADS"),
  headlines: z.array(z.string().trim().min(1).max(40)).min(1).max(5),
  primaryTexts: z.array(z.string().trim().min(1).max(125)).min(1).max(5),
  callToAction: z.enum(["SIGN_UP", "LEARN_MORE", "GET_QUOTE"]),
  audience: z.object({
    locations: z.array(z.string().trim().min(2).max(100)).min(1).max(10),
    ageMin: z.number().int().min(18).max(65),
    ageMax: z.number().int().min(18).max(65),
    interests: z.array(z.string().trim().min(1).max(60)).max(10),
  }).refine((a) => a.ageMin <= a.ageMax, { message: "ageMin must be <= ageMax" }),
  dailyBudgetCents: z.number().int().positive().max(1_000_000),
  rationale: z.string().trim().min(1).max(500),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  openQuestions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
}).strict();

const strArray = { type: "array", items: { type: "string" } };
export const ORIGINAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "objective", "headlines", "primaryTexts", "callToAction", "audience", "dailyBudgetCents", "rationale", "assumptions", "openQuestions"],
  properties: {
    name: { type: "string" },
    objective: { type: "string", enum: ["OUTCOME_LEADS"] },
    headlines: strArray,
    primaryTexts: strArray,
    callToAction: { type: "string", enum: ["SIGN_UP", "LEARN_MORE", "GET_QUOTE"] },
    audience: {
      type: "object",
      additionalProperties: false,
      required: ["locations", "ageMin", "ageMax", "interests"],
      properties: { locations: strArray, ageMin: { type: "integer" }, ageMax: { type: "integer" }, interests: strArray },
    },
    dailyBudgetCents: { type: "integer" },
    rationale: { type: "string" },
    assumptions: strArray,
    openQuestions: strArray,
  },
} as const;

export const ORIGINAL_HINT = `{
  "name": string (3-80 chars),
  "objective": "OUTCOME_LEADS",
  "headlines": string[] (1-5 items, each <= 40 chars),
  "primaryTexts": string[] (1-5 items, each <= 125 chars),
  "callToAction": "SIGN_UP" | "LEARN_MORE" | "GET_QUOTE",
  "audience": { "locations": string[], "ageMin": int 18-65, "ageMax": int 18-65, "interests": string[] },
  "dailyBudgetCents": positive integer (never above the stated cap),
  "rationale": string (<= 500 chars),
  "assumptions": string[] (things you assumed; empty if none),
  "openQuestions": string[] (facts you need from the owner but were not given; empty if none)
}`;

export const originalPromptSha256 = (): string => sha256(ORIGINAL_SYSTEM_PROMPT);
export const originalSchemaSha256 = (): string => outputContractSha256(ORIGINAL_JSON_SCHEMA, ORIGINAL_HINT, Object.keys(OriginalCampaignBriefSchema.shape));

export const originalGenerationIdentity = () => ({
  promptVersion: ORIGINAL_PROMPT_VERSION,
  promptSha256: originalPromptSha256(),
  schemaVersion: ORIGINAL_SCHEMA_VERSION,
  schemaSha256: originalSchemaSha256(),
});
