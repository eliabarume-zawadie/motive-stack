import { z } from "zod";

/**
 * Fact provenance and polarity.
 *
 * PROVENANCE. Every statement the owner wants to make in ads can be recorded as a FactRecord with where it came from and
 * whether it may be used for marketing. Four levels, from weakest to strongest evidence:
 *   owner_provided        the owner typed it in. Nothing implies it was checked or approved for ads.
 *   owner_approved        the owner confirmed it may appear in ads. This is NOT independent verification.
 *   imported              taken from an identified source (a website import, a document). Needs approval before use.
 *   independently_verified  checked by a recorded method against recorded evidence. Never set automatically.
 * Only records with approvedForMarketing === true can support a claim in ad copy.
 *
 * LEGACY FIELDS. Workspaces created before this existed hold plain strings in `differentiators` and `verifiedFacts`. They are
 * read as owner-approved (the field names say so) and are NEVER labelled independently verified.
 *
 * POLARITY. A fact that says a thing is NOT so (or is pending, expired, conditional) must never support the opposite claim.
 * Polarity is detected with patterns, which cannot understand meaning. The design therefore fails closed: anything that
 * looks negative or uncertain blocks the matching claim and asks for review instead of passing silently.
 */

export const FACT_STATUSES = ["owner_provided", "owner_approved", "imported", "independently_verified"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

const isoDate = z.string().trim().min(8).max(40).refine((s) => !Number.isNaN(Date.parse(s)), { message: "must be a date such as 2026-10-16 or an ISO timestamp" });

export const EvidenceRefSchema = z.object({
  /** What kind of evidence: a document, a link, a licence or registration number, a note, a screenshot. */
  type: z.enum(["document", "url", "registration_number", "screenshot", "note"]),
  /** A reference the reviewer can follow. Never the document itself. */
  ref: z.string().trim().min(1).max(300),
  recordedAt: isoDate.optional(),
}).strict();

export const VerificationSchema = z.object({
  /** How it was checked, e.g. "looked up in the state licensing register". */
  method: z.string().trim().min(5).max(300),
  verifiedBy: z.string().trim().min(2).max(100),
  verifiedAt: isoDate,
  evidence: z.array(EvidenceRefSchema).min(1).max(10),
}).strict();

export const FactRecordSchema = z.object({
  text: z.string().trim().min(2).max(200),
  status: z.enum(FACT_STATUSES),
  /** Where it came from: "owner_form", "website_import", "document:insurance certificate"... Required, never guessed. */
  source: z.string().trim().min(2).max(200),
  /** May this appear in ads? Only true records can support a claim. */
  approvedForMarketing: z.boolean().default(false),
  providedAt: isoDate.optional(),
  approvedAt: isoDate.optional(),
  approvedBy: z.string().trim().min(1).max(100).optional(),
  /** For imported facts: the identified source. */
  importedFrom: z.string().trim().min(2).max(200).optional(),
  evidence: z.array(EvidenceRefSchema).max(10).default([]),
  /** Present only for independently_verified facts. */
  verification: VerificationSchema.optional(),
}).strict().superRefine((f, ctx) => {
  const bad = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (f.status === "independently_verified" && !f.verification) bad("verification", "an independently verified fact must record the verification method, who verified it, when, and at least one evidence reference");
  if (f.status !== "independently_verified" && f.verification) bad("verification", "only an independently verified fact can carry a verification record; owner-entered information is not independently verified");
  if (f.status === "owner_approved" && !f.approvedForMarketing) bad("approvedForMarketing", "an owner-approved fact must be approved for marketing use");
  if (f.status === "imported" && !f.importedFrom) bad("importedFrom", "an imported fact must identify its source");
  if (f.approvedForMarketing && !f.approvedAt) bad("approvedAt", "an approved fact must record when it was approved");
});
export type FactRecord = z.infer<typeof FactRecordSchema>;

/** One statement the system can reason about, from any source field. */
export interface FactStatement {
  text: string;
  /** Where it was read from: a legacy field or a record. */
  origin: "differentiators" | "verifiedFacts" | "offer" | "approvedPricing" | "facts" | "context";
  status: FactStatus | "legacy_owner_approved";
  source: string;
  /** Usable as support for an ad claim. */
  approved: boolean;
}

/** Everything the Business Brain says that could support or contradict an ad claim, with its provenance. */
export function factStatements(brain: {
  businessName: string; industry: string; services: string[]; serviceArea: string; offer: string; approvedPricing?: string;
  differentiators: string[]; verifiedFacts: string[]; facts?: FactRecord[];
}): FactStatement[] {
  const legacy = (text: string, origin: FactStatement["origin"]): FactStatement => ({ text, origin, status: "legacy_owner_approved", source: `legacy field: ${origin}`, approved: true });
  return [
    ...[brain.businessName, brain.industry, ...brain.services, brain.serviceArea].map((t): FactStatement => ({ text: t, origin: "context", status: "legacy_owner_approved", source: "business profile", approved: true })),
    legacy(brain.offer, "offer"),
    ...(brain.approvedPricing ? [legacy(brain.approvedPricing, "approvedPricing")] : []),
    ...brain.differentiators.map((t) => legacy(t, "differentiators")),
    ...brain.verifiedFacts.map((t) => legacy(t, "verifiedFacts")),
    ...(brain.facts ?? []).map((f): FactStatement => ({ text: f.text, origin: "facts", status: f.status, source: f.source, approved: f.approvedForMarketing })),
  ];
}

/* ------------------------------------------------------------------------------------------ polarity */

export type Polarity = "affirmative" | "negated" | "ambiguous";

/** "unlicensed" / "non-insured" become "not licensed" / "not insured" so the negation survives normalisation. */
const PREFIX_NEG = /\b(un|non|in)[-\s]?(licen[sc]ed|insured|certified|bonded|accredited|registered|guaranteed|available|owned|operated|authorized|approved|verified)\b/gi;

const NEGATION = /\b(non(?=[- ])|not|no(?!\.?\s?1\b)|never|none|nor|without|neither|isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|hasn'?t|haven'?t|hadn'?t|won'?t|wouldn'?t|cannot|can'?t|couldn'?t|lacks?|lacking|absence of|no longer|not yet|zero)\b|n['’]t\b/i;

const AMBIGUITY = /\b(pending|applying|applied for|awaiting|in progress|working (?:on|toward|towards)|planned|planning|plan to|hop(?:e|es|ed|ing)|intend\w*|aim(?:s|ed|ing)|tr(?:y|ies|ied|ying) to|want(?:s|ed)? to|would like|looking to|going to|will|become|becoming|becomes|soon|coming soon|expired|expires|expiring|lapsed|suspended|revoked|former(?:ly)?|used to|trial|sometimes|occasionally|usually|mostly|typically|some|most|limited|varies|vary|depends|depending|subject to|may|might|could|approximately|roughly|nearly|almost|unsure|unclear|unknown|tbd|to be confirmed)\b|\?\s*$/i;

/** Common harmless "no ..." phrases that say nothing about a claim ("no hidden fees"). Removing them avoids false conflicts. */
const BENIGN_NEGATION = /\bno (?:hidden|extra|additional|overtime|surprise|obligation|contract|pressure|travel|trip|call[- ]?out)\b[^,;.|]*/gi;

/** Split into clauses so "Licensed, but not insured" does not negate "Licensed". */
export function clausesOf(text: string): string[] {
  return text
    .replace(PREFIX_NEG, (_m, _p, word: string) => `not ${word}`)
    .replace(BENIGN_NEGATION, " ")
    .replace(/\?/g, " unclear ") // a question is not a statement
    .split(/[|;\n]|[.!?](?=\s|$)|,(?=\s)|\s[-–—]\s|\b(?:but|yet|however|although|though|except)\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

export function polarityOf(clause: string): Polarity {
  if (NEGATION.test(clause)) return "negated";
  if (AMBIGUITY.test(clause)) return "ambiguous";
  return "affirmative";
}
