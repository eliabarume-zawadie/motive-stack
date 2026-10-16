/**
 * JSON Schema sent to providers for NATIVE structured output of a campaign brief.
 * Deliberately minimal: every property required, additionalProperties false, and NO length/range keywords,
 * because providers' strict modes reject some of them. The zod CampaignBriefSchema is the real validator
 * and is always applied to the result (a test keeps the two in sync).
 */
const strArray = { type: "array", items: { type: "string" } };

export const CAMPAIGN_BRIEF_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "objective", "headlines", "primaryTexts", "callToAction", "audience", "dailyBudgetCents", "budgetRationale", "rationale", "targeting", "differentiatorDecisions", "variations", "reviewFlags", "assumptions", "openQuestions"],
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
    budgetRationale: { type: "string" },
    rationale: { type: "string" },
    targeting: {
      type: "object",
      additionalProperties: false,
      required: ["approach", "connection", "basis", "evidence", "restrictions", "uncertainties", "needsFromOwner"],
      properties: {
        approach: { type: "string" }, connection: { type: "string" },
        basis: { type: "string", enum: ["owner_provided", "assumption", "general_best_practice"] },
        evidence: strArray, restrictions: strArray, uncertainties: strArray, needsFromOwner: strArray,
      },
    },
    differentiatorDecisions: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["differentiator", "used", "reason"], properties: { differentiator: { type: "string" }, used: { type: "boolean" }, reason: { type: "string" } } },
    },
    variations: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["angle", "strategicDifference"], properties: { angle: { type: "string" }, strategicDifference: { type: "string" } } },
    },
    reviewFlags: strArray,
    assumptions: strArray,
    openQuestions: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["question", "impact", "blocking"], properties: { question: { type: "string" }, impact: { type: "string" }, blocking: { type: "boolean" } } },
    },
  },
} as const;

export const CAMPAIGN_BRIEF_HINT = `{
  "name": string (3-80 chars),
  "objective": "OUTCOME_LEADS",
  "headlines": string[] (1-5 items, each <= 40 chars),
  "primaryTexts": string[] (1-5 items, each <= 125 chars),
  "callToAction": "SIGN_UP" | "LEARN_MORE" | "GET_QUOTE",
  "audience": { "locations": string[], "ageMin": int 18-65, "ageMax": int 18-65, "interests": string[] },
  "dailyBudgetCents": positive integer, your STARTING budget, clearly BELOW the owner's ceiling (never above it),
  "budgetRationale": string (<= 500 chars; why this starting budget, and that no performance data was supplied),
  "rationale": string (<= 500 chars),
  "targeting": {
    "approach": string (<= 400 chars; the audience in plain words),
    "connection": string (<= 500 chars; why it fits the service and the lead objective),
    "basis": "owner_provided" | "assumption" | "general_best_practice",
    "evidence": string[] (owner-provided evidence; empty if none),
    "restrictions": string[],
    "uncertainties": string[] (what is not known; required unless basis is owner_provided),
    "needsFromOwner": string[]
  },
  "differentiatorDecisions": [ { "differentiator": string, "used": boolean, "reason": string (why held back, if not used) } ] (one per approved differentiator),
  "variations": [ { "angle": string (<= 100 chars), "strategicDifference": string (<= 300 chars) } ] (exactly one per primary text, distinct angles),
  "reviewFlags": string[] (reasons a human must review before launch; empty if none),
  "assumptions": string[] (things you assumed; empty if none),
  "openQuestions": [ { "question": string, "impact": string (how the answer would change the campaign), "blocking": boolean } ] (only material questions; empty if none)
}`;
