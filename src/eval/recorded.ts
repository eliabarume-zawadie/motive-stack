import { BusinessBrainSchema } from "../domain/schemas.js";
import type { EvalCase } from "./fixtures.js";

/**
 * The real brief `gpt-6-luna` produced on 2026-10-16 for the Sunrise Plumbing brain (the first live end-to-end run), recorded
 * verbatim. It is kept as evidence of the four observed weaknesses so they stay measurable:
 *   1. targeting had no rationale, 2. the starting budget equalled the ceiling, 3. the approved "Licensed and insured"
 *   differentiator was not considered, 4. no open questions at all.
 * The brain is the one used in that run. The expectations are the current quality bar, not what the model was asked then.
 */
export const RECORDED_OPENAI_SUNRISE: { case: EvalCase; raw: unknown; model: string; recordedAt: string } = {
  model: "openai/gpt-6-luna",
  recordedAt: "2026-10-16",
  case: {
    id: "recorded-openai-sunrise",
    title: "Recorded real output: gpt-6-luna, Sunrise Plumbing (2026-10-16)",
    purpose: "Regression evidence for the four observed weaknesses in the first live run.",
    brain: BusinessBrainSchema.parse({
      businessName: "Sunrise Plumbing", industry: "Home services", services: ["Emergency plumbing", "Water heater repair"], serviceArea: "Austin, TX",
      targetCustomer: "Homeowners with urgent plumbing problems", offer: "Free on-site quote", tone: "friendly and professional",
      differentiators: ["24/7 availability", "Licensed and insured"], maxDailyBudgetCents: 2000,
    }),
    expect: { mustUseAtLeast: 2, maxOpenQuestions: 3, broadTargeting: true },
  },
  raw: {
    name: "Sunrise Plumbing Lead Campaign",
    objective: "OUTCOME_LEADS",
    headlines: ["Urgent Plumbing Help in Austin", "Water Heater Repair", "Get a Free On-Site Quote"],
    primaryTexts: [
      "Facing an urgent plumbing problem? Sunrise Plumbing offers 24/7 availability in Austin. Request a free on-site quote.",
      "Need water heater repair? Contact Sunrise Plumbing for friendly, professional service in Austin.",
    ],
    callToAction: "GET_QUOTE",
    audience: { locations: ["Austin, TX"], ageMin: 18, ageMax: 65, interests: [] },
    dailyBudgetCents: 2000,
    rationale: "Focuses on urgent plumbing needs and water heater repair, highlighting the stated 24/7 availability and free on-site quote to encourage inquiries from Austin homeowners.",
    assumptions: [],
    openQuestions: [],
  },
};
