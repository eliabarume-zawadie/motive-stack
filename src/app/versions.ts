import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../domain/campaignJsonSchema.js";
import { CampaignBriefSchema } from "../domain/schemas.js";
import { CAMPAIGN_SYSTEM_PROMPT } from "./campaignPrompt.js";
import { sha256, stableStringify } from "./util.js";

/**
 * Versions of the instructions and the output contract used to generate a campaign brief.
 *
 * A version string is a human label. The SHA-256 fingerprints are what makes a result reproducible: they change whenever
 * the prompt text or the output contract changes, and `config/prompt-versions.json` pins them, so a test fails if either
 * is edited without a deliberate version bump. Editing a prompt in place and keeping its version is therefore impossible
 * to do silently.
 *
 * The current prompt is the CANDIDATE: it is not claimed to be better than the original, only to be the one in use.
 */
export const CAMPAIGN_PROMPT_VERSION = "campaign-prompt/3.1.0-candidate";
export const CAMPAIGN_SCHEMA_VERSION = "campaign-brief-schema/3.0.0";
export const BUSINESS_BRAIN_SCHEMA_VERSION = "business-brain-schema/3.1.0";

/** The output contract: the JSON schema sent to providers, the hint, and the set of fields the validator accepts. */
export function outputContractSha256(jsonSchema: unknown, hint: string, fields: string[]): string {
  return sha256(stableStringify({ jsonSchema, hint, fields: [...fields].sort() }));
}

export const campaignPromptSha256 = (): string => sha256(CAMPAIGN_SYSTEM_PROMPT);
export const campaignSchemaSha256 = (): string => outputContractSha256(CAMPAIGN_BRIEF_JSON_SCHEMA, CAMPAIGN_BRIEF_HINT, Object.keys(CampaignBriefSchema.shape));

/** What produced a campaign brief, recorded with every generation and every evaluation run. */
export interface GenerationIdentity {
  promptVersion: string;
  promptSha256: string;
  schemaVersion: string;
  schemaSha256: string;
}

export const currentGenerationIdentity = (): GenerationIdentity => ({
  promptVersion: CAMPAIGN_PROMPT_VERSION,
  promptSha256: campaignPromptSha256(),
  schemaVersion: CAMPAIGN_SCHEMA_VERSION,
  schemaSha256: campaignSchemaSha256(),
});

/** The settings that shape a generation, so a result can be reproduced or compared like for like. */
export interface GenerationParams {
  maxOutputTokens: number;
  repairAttempts: number;
  maxRetries: number;
  timeoutMs: number;
  temperature?: number;
  reasoningEffort?: string;
  /** mock | local | live */
  providerMode: string;
}
