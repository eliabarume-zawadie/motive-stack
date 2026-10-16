import { buildMockBrief } from "../src/ai/mockBrief.js";
import { BusinessBrainSchema, CampaignBriefSchema } from "../src/domain/schemas.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { BRAIN } from "./fixtures.js";

/**
 * A raw campaign brief for the BRAIN fixture that satisfies EVERY generation rule (grounded copy, starting budget below the
 * ceiling, targeting rationale, one decision per differentiator, material questions only). Tests use it as "a valid model output".
 */
export const BRIEF_OK: Record<string, unknown> & { headlines: string[]; primaryTexts: string[]; audience: Record<string, unknown> } = buildMockBrief(BusinessBrainSchema.parse(BRAIN)) as never;

/** The brief after schema validation (defaults applied). */
export const brief = () => CampaignBriefSchema.parse(BRIEF_OK);

/** A structured-generation request for the campaign brief task. */
export const req = (model: string) => ({
  task: "campaign_brief", system: "s", prompt: "p", schemaHint: CAMPAIGN_BRIEF_HINT,
  jsonSchema: CAMPAIGN_BRIEF_JSON_SCHEMA as unknown as Record<string, unknown>,
  context: BusinessBrainSchema.parse(BRAIN), schema: CampaignBriefSchema, model,
});
