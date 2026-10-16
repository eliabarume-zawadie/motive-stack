import { z } from "zod";
import { FactRecordsSchema } from "./facts.js";

/** What the business owner tells MotiveStack about the business. */
export const BusinessBrainSchema = z
  .object({
    businessName: z.string().trim().min(2).max(100),
    industry: z.string().trim().min(2).max(100),
    services: z.array(z.string().trim().min(2).max(100)).min(1).max(20),
    serviceArea: z.string().trim().min(2).max(200),
    targetCustomer: z.string().trim().min(2).max(300),
    offer: z.string().trim().min(2).max(300),
    tone: z.string().trim().min(2).max(100).default("friendly and professional"),
    /** APPROVED differentiators: claims the owner has confirmed may appear in ads. */
    differentiators: z.array(z.string().trim().min(2).max(200)).max(10).default([]),
    /** Other facts the owner has VERIFIED (licenses held, years in business, certifications...). Usable in ads. */
    verifiedFacts: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
    /**
     * Facts with explicit provenance and approval status. Only records approved for marketing can support a claim. The plain
     * string fields above are read as OWNER-APPROVED (never independently verified); this field is how stronger or weaker evidence is recorded.
     */
    facts: FactRecordsSchema.default([]),
    /** Price statements approved for use in ads (e.g. "Inspection is free"). Without this, ads must not state prices. */
    approvedPricing: z.string().trim().max(300).optional(),
    /** Things the owner has said but NOT verified (e.g. "voted #1"). Never used in ads; they should prompt a proof request. */
    unverifiedClaims: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
    /** Things ads must never say. */
    prohibitedClaims: z.array(z.string().trim().min(2).max(200)).max(20).default([]),
    /** Free-text business description (copied from a website, notes...). UNTRUSTED data: it can contain instructions and is never a source of claims. */
    description: z.string().trim().max(2000).optional(),
    /** Hard ceiling for any proposed daily budget, in cents. It is a limit, not a spending target. */
    maxDailyBudgetCents: z.number().int().positive().max(1_000_000),
  })
  .strict();
export type BusinessBrain = z.infer<typeof BusinessBrainSchema>;

export const CallToActionSchema = z.enum(["SIGN_UP", "LEARN_MORE", "GET_QUOTE"]);

/** An open question must say why it matters. Old briefs stored plain strings; those are upgraded on read. */
export const OpenQuestionSchema = z.preprocess(
  (v) => (typeof v === "string" ? { question: v, impact: "", blocking: false } : v),
  z.object({
    question: z.string().trim().min(1).max(300),
    /** How the answer could materially change the campaign. */
    impact: z.string().trim().max(300).default(""),
    /** True when the campaign must not be launched until this is answered. */
    blocking: z.boolean().default(false),
  }).strict(),
);
export type OpenQuestion = { question: string; impact: string; blocking: boolean };

/** How a targeting recommendation is supported. Narrowing an audience needs owner-provided evidence or a stated assumption. */
export const TargetingBasisSchema = z.enum(["owner_provided", "assumption", "general_best_practice"]);

export const TargetingSchema = z.object({
  /** The proposed audience or approach, in plain words. */
  approach: z.string().trim().max(400).default(""),
  /** How it connects to the service and the campaign objective. */
  connection: z.string().trim().max(500).default(""),
  basis: TargetingBasisSchema.default("assumption"),
  /** Evidence supplied by the owner that supports it. */
  evidence: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** Restrictions that apply (policy, special ad categories). */
  restrictions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** What is not known about this recommendation. */
  uncertainties: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  /** What the owner would need to tell us if the recommendation cannot be justified. */
  needsFromOwner: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
}).strict();
export type Targeting = z.infer<typeof TargetingSchema>;

/** Structured campaign brief. This is the only shape an AI model may return for campaign generation. */
export const CampaignBriefSchema = z
  .object({
    name: z.string().trim().min(3).max(80),
    objective: z.literal("OUTCOME_LEADS"),
    headlines: z.array(z.string().trim().min(1).max(40)).min(1).max(5),
    primaryTexts: z.array(z.string().trim().min(1).max(125)).min(1).max(5),
    callToAction: CallToActionSchema,
    audience: z.object({
      locations: z.array(z.string().trim().min(2).max(100)).min(1).max(10),
      ageMin: z.number().int().min(18).max(65),
      ageMax: z.number().int().min(18).max(65),
      interests: z.array(z.string().trim().min(1).max(60)).max(10),
    }).refine((a) => a.ageMin <= a.ageMax, { message: "ageMin must be <= ageMax" }),
    /** The PROPOSED STARTING daily budget in cents. The owner's ceiling is a hard limit, never a target. */
    dailyBudgetCents: z.number().int().positive().max(1_000_000),
    /** Why this starting budget. */
    budgetRationale: z.string().trim().max(500).default(""),
    rationale: z.string().trim().min(1).max(500),
    /** The targeting recommendation with its basis and uncertainty. "audience" above holds only settings the platform can apply. */
    targeting: TargetingSchema.default({}),
    /** One decision per approved differentiator: used in the copy, or deliberately held back with a reason. */
    differentiatorDecisions: z.array(z.object({
      differentiator: z.string().trim().min(1).max(200),
      used: z.boolean(),
      reason: z.string().trim().max(300).default(""),
    }).strict()).max(10).default([]),
    /** Why the creative variations differ strategically (one entry per primary text). */
    variations: z.array(z.object({
      angle: z.string().trim().min(1).max(100),
      strategicDifference: z.string().trim().max(300).default(""),
    }).strict()).max(5).default([]),
    /** Reasons a human must review before execution (unjustified budget, special ad category...). Non-empty means "needs review". */
    reviewFlags: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    /** Things the model assumed. Surfaced to the owner; never hidden. */
    assumptions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    /** Information that could materially change the campaign, or is required before execution. */
    openQuestions: z.array(OpenQuestionSchema).max(10).default([]),
  })
  .strict();
export type CampaignBrief = z.infer<typeof CampaignBriefSchema>;

export const GenerateRequestSchema = z.object({
  /** Optional explicit choice. Omit both to use the workspace AI settings. */
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
}).strict();

export const ConnectionTestSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();

export const WorkspaceCreateSchema = z.object({ name: z.string().trim().min(2).max(100) }).strict();
export const WorkspaceUpdateSchema = z.object({
  metaAccountId: z.string().regex(/^act_\d+$/).nullable(),
}).strict();

export const DecisionSchema = z.object({
  decidedBy: z.string().trim().min(1).max(100),
  reason: z.string().trim().max(500).optional(),
  /** Required to approve a proposal that is marked "needs review". */
  acknowledgedReview: z.boolean().optional(),
}).strict();

export const SimulatedLeadSchema = z.object({
  eventId: z.string().trim().min(1).max(100).optional(),
  fullName: z.string().trim().min(1).max(100).default("Synthetic Lead"),
  email: z.string().trim().toLowerCase().email().optional(),
  phone: z.string().trim().min(7).max(20).optional(),
}).strict().refine((l) => l.email || l.phone, { message: "email or phone is required" });
