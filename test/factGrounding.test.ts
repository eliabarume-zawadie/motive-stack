import { describe, expect, it } from "vitest";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { CAMPAIGN_SYSTEM_PROMPT, buildCampaignPrompt } from "../src/app/campaignPrompt.js";
import { generateCampaign, updateBrief } from "../src/app/campaigns.js";
import { buildContext } from "../src/app/context.js";
import { createProposal, decideProposal } from "../src/app/proposals.js";
import { getBrain, createWorkspace, putBrain } from "../src/app/workspaces.js";
import { approvalGateViolations, briefRuleViolations, factIssues, groundingIssues, provenanceSummary, unapprovedFacts } from "../src/domain/briefRules.js";
import { clausesOf, FactRecordSchema, polarityOf } from "../src/domain/facts.js";
import { BusinessBrainSchema, CampaignBriefSchema, type BusinessBrain } from "../src/domain/schemas.js";
import { evaluateBrief, runEvaluation } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { renderMarkdown } from "../src/eval/report.js";
import { BRAIN, makeCore } from "./fixtures.js";

const brain = (over: object = {}): BusinessBrain => BusinessBrainSchema.parse({ ...BRAIN, ...over });
type Brief = Record<string, any>;
const base = (b: BusinessBrain): Brief => buildMockBrief(b) as Brief;
const withHeadline = (b: BusinessBrain, h: string): Brief => ({ ...base(b), headlines: [...base(b).headlines, h] });
const verdict = (fact: string, claim: string, field: "verifiedFacts" | "differentiators" = "verifiedFacts") => {
  const issues = groundingIssues([claim], brain({ [field]: [fact] }));
  return issues.length ? issues.map((i) => `${i.reason}:${i.code}`).join(",") : "supported";
};
const caseById = (id: string) => EVAL_CASES.find((c) => c.id === id)!;

/* =================================================================== negative facts never support positive claims */
describe("negated facts cannot authorise the contradictory positive claim", () => {
  it.each([
    // ownership
    ["Not family owned", "Family-owned plumbers"],
    ["We are not a family-owned business", "Family owned"],
    ["No longer family owned", "A family-run company"],
    ["Non-family owned", "Family-owned"],
    ["Not-family-owned", "Family owned"],
    ["Family-owned, not veteran owned", "Veteran-owned service"],
    // founding history
    ["Not in business since 1998", "Serving Austin since 1998"],
    ["Not founded in 2005", "Founded in 2005"],
    ["We have not been around for 20 years", "20 years of experience"],
    // licensing
    ["Unlicensed handyman", "Licensed plumbers"],
    ["Not licensed", "Licensed and ready"],
    ["No licence held", "Licensed pros"],
    ["Licensed, but not insured", "Fully insured"],
    // certification
    ["Not certified", "Certified technicians"],
    ["Uncertified crew", "Certified"],
    ["Not accredited", "Accredited experts"],
    // pricing
    ["Never advertise $49 pricing", "Drain cleaning from $49"],
    ["Not offering 20% off", "20% off today"],
    // availability
    ["Not available on weekends", "Weekend appointments"],
    ["No 24/7 service", "24/7 service"],
    ["Cannot offer same-day service", "Same-day service"],
    ["No emergency calls", "Emergency repairs"],
    // guarantees and free offers
    ["No warranty offered", "Lifetime warranty"],
    ["Estimates are not free", "Free estimates"],
  ])("fact %j does not support the claim %j", (fact, claim) => {
    expect(verdict(fact, claim), `${fact} / ${claim}`).toMatch(/^contradicted:/);
  });

  it("negation is not lost by hyphens, spacing, case or prefix forms", () => {
    for (const f of ["NOT FAMILY-OWNED", "not   family   owned", "Non-family owned", "non family owned", "unlicensed", "Un-licensed", "uninsured"]) {
      expect(clausesOf(f).map(polarityOf), f).toContain("negated");
    }
  });

  it("a fact negated for one claim still supports the others in the same sentence", () => {
    expect(verdict("Licensed, but not insured", "Licensed")).toBe("supported");
    expect(verdict("Licensed, but not insured", "Insured")).toMatch(/^contradicted/);
  });

  it("harmless 'no ...' phrases are not read as negating the claim", () => {
    expect(verdict("Free estimates, no hidden fees", "Free estimates")).toBe("supported");
    expect(verdict("24/7 emergency service with no overtime fees", "24/7 emergency service")).toBe("supported");
  });

  it("a negative fact blocks the claim even when an unapproved record is the only thing that denies it", () => {
    const b = brain({ differentiators: ["Family-owned business"], facts: [{ text: "Not family owned", status: "owner_provided", source: "owner_form", approvedForMarketing: false }] });
    expect(groundingIssues(["Family-owned plumbers"], b)[0]).toMatchObject({ reason: "contradicted" });
  });
});

/* ====================================================================== uncertain facts cannot be silently passed */
describe("conditional or unclear facts are ambiguous, never support", () => {
  it.each([
    ["License application pending", "Licensed plumbers"],
    ["Licence expired last year", "Licensed"],
    ["Certification lapsed", "Certified"],
    ["Hoping to become family owned again", "Family-owned"],
    ["Weekend appointments sometimes available", "Weekend appointments"],
    ["Promo price of $49 expired", "Only $49"],
    ["24/7 service planned for next year", "24/7 service"],
    ["Is the warranty still offered?", "Lifetime warranty"],
    ["We intend to get licensed", "Licensed plumbers"],
    ["Intends to be certified next year", "Certified"],
    ["Will be insured soon", "Insured"],
  ])("fact %j leaves the claim %j ambiguous", (fact, claim) => {
    expect(verdict(fact, claim)).toMatch(/^ambiguous:/);
  });

  it("an ambiguous fact is a review-required state: the brief must carry a flag naming it", () => {
    const b = brain({ verifiedFacts: ["License application pending"] });
    expect(factIssues(b)).toEqual([expect.objectContaining({ type: "ambiguous", kind: "credential" })]);
    const unflagged = CampaignBriefSchema.parse({ ...base(b), reviewFlags: [] });
    expect(briefRuleViolations(unflagged, b).map((v) => v.code)).toContain("fact_issue_unflagged");
    expect(briefRuleViolations(CampaignBriefSchema.parse(base(b)), b)).toEqual([]); // the reference brief flags it
    expect(base(b).reviewFlags.join(" ")).toMatch(/conflicting or ambiguous/);
  });

  it("when it cannot tell, it fails closed rather than passing", () => {
    expect(verdict("Our team is rather proud of its credentials", "Certified experts")).toMatch(/^unsupported:/);
  });
});

/* ========================================================================== conflicts inside the Business Brain */
describe("a fact affirmed in one place and denied in another is a conflict", () => {
  const conflicted = () => brain({ differentiators: ["Family-owned business", "Upfront written estimates"], verifiedFacts: ["Not family owned"] });

  it("is detected, with both statements", () => {
    expect(factIssues(conflicted())).toEqual([expect.objectContaining({ type: "conflict", kind: "ownership", affirmed: ["Family-owned business"], against: ["Not family owned"] })]);
  });
  it("the conflicting claim is contradicted in copy and the differentiator is held back with a reason and a flag", () => {
    const b = conflicted();
    const brief = base(b);
    expect(brief.differentiatorDecisions.find((d: any) => d.differentiator === "Family-owned business")).toMatchObject({ used: false, reason: expect.stringMatching(/contradicts it/) });
    expect(JSON.stringify([brief.headlines, brief.primaryTexts])).not.toMatch(/family/i);
    expect(brief.reviewFlags.join(" ")).toMatch(/conflicting or ambiguous/);
    expect(brief.openQuestions[0].question).toMatch(/disagree about a ownership claim/);
    expect(groundingIssues([...brief.headlines, ...brief.primaryTexts], b)).toEqual([]);
  });
  it("the approval gate refuses it until the owner corrects the facts, even when the copy avoids the claim", () => {
    const b = conflicted();
    const v = approvalGateViolations(CampaignBriefSchema.parse(base(b)), b);
    expect(v.map((x) => x.code)).toContain("fact_conflict_unresolved");
    expect(v.find((x) => x.code === "fact_conflict_unresolved")?.message).toMatch(/"Family-owned business" versus "Not family owned"/);
  });
  it("once the owner removes the contradiction, the same brief passes the gate", () => {
    const fixed = brain({ differentiators: ["Upfront written estimates"], verifiedFacts: ["Not family owned"] });
    expect(approvalGateViolations(CampaignBriefSchema.parse(base(fixed)), fixed)).toEqual([]);
  });
});

/* ============================================================ positive facts do not support a different kind of claim */
describe("support is specific to the type of claim", () => {
  it.each([
    ["Family discounts available", "Family-owned plumbers", "unsupported:ownership"],
    ["Serving families across Austin", "Family-run company", "unsupported:ownership"],
    ["Family owned and operated", "Third-generation plumbers", "unsupported:ownership"],
    ["Family owned and operated", "Veteran-owned", "unsupported:ownership"],
    ["Family owned and operated", "Serving Austin since 1998", "unsupported:experience"],
    ["Licensed and insured", "Certified technicians", "unsupported:credential"],
    ["Licensed and insured", "Bonded and insured", "unsupported:credential"],
    ["Inspection is $49", "Inspection is $59", "unsupported:price"],
    ["Free estimates", "Lifetime warranty", "unsupported:guarantee"],
    ["Available 24/7", "Same-day service", "unsupported:availability"],
  ])("fact %j does not support %j", (fact, claim, expected) => {
    expect(verdict(fact, claim)).toBe(expected);
  });

  it("valid owner-approved claims still pass, across spelling, hyphenation and plural variations", () => {
    for (const [fact, claim] of [
      ["Family owned and operated", "Family-owned"], ["Family-run since the start", "A family-run company"], ["Licensed and insured", "Licensed and insured"],
      ["License on file", "Licensed pros"], ["Licence on file", "Licensed"], ["NATE-certified technicians", "Certified technicians"], ["Certification on file", "Certified techs"],
      ["Inspection is $49", "Inspection is $49"], ["Available 24 hours", "24-hour service"], ["Available 24/7", "24/7 availability"], ["Weekend appointments", "Weekends welcome"],
      ["Serving Austin since 2012", "Since 2012"], ["Over 20 years in business", "20 years of experience"], ["Top-rated by the owner's records", "Rated best"],
    ] as const) expect(verdict(fact, claim), `${fact} / ${claim}`).toBe("supported");
  });
});

/* =========================================================================================== provenance model */
describe("fact provenance", () => {
  const ok = { text: "Licensed in Oregon", status: "owner_approved", source: "owner_form", approvedForMarketing: true, approvedAt: "2026-10-01", approvedBy: "owner" };
  const verification = { method: "Looked up in the state licensing register", verifiedBy: "Reviewer A", verifiedAt: "2026-10-02", evidence: [{ type: "registration_number", ref: "SYNTHETIC-0001" }] };

  it("accepts each of the four levels when its required records are present", () => {
    expect(FactRecordSchema.safeParse({ text: "Free estimates", status: "owner_provided", source: "owner_form" }).success).toBe(true);
    expect(FactRecordSchema.safeParse(ok).success).toBe(true);
    expect(FactRecordSchema.safeParse({ text: "Serving Tulsa for 20 years", status: "imported", source: "website_import", importedFrom: "website_import (synthetic)", approvedForMarketing: true, approvedAt: "2026-10-01", approvedBy: "owner" }).success).toBe(true);
    expect(FactRecordSchema.safeParse({ ...ok, status: "independently_verified", verification }).success).toBe(true);
  });

  it("owner-entered information can never be labelled independently verified", () => {
    for (const status of ["owner_provided", "owner_approved", "imported"]) {
      const r = FactRecordSchema.safeParse({ ...ok, status, importedFrom: "x source", verification });
      expect(r.success, status).toBe(false);
    }
    expect(FactRecordSchema.safeParse({ ...ok, status: "independently_verified" }).success).toBe(false); // no verification record
    expect(FactRecordSchema.safeParse({ ...ok, status: "independently_verified", verification: { ...verification, evidence: [] } }).success).toBe(false);
    expect(FactRecordSchema.safeParse({ ...ok, status: "independently_verified", verification: { ...verification, method: "ok" } }).success).toBe(false);
  });

  it("requires the records its status implies", () => {
    expect(FactRecordSchema.safeParse({ ...ok, approvedForMarketing: false }).success).toBe(false); // owner_approved but not approved
    expect(FactRecordSchema.safeParse({ ...ok, approvedAt: undefined }).success).toBe(false); // approved without a time
    expect(FactRecordSchema.safeParse({ text: "x fact", status: "imported", source: "website_import" }).success).toBe(false); // imported without an identified source
    expect(FactRecordSchema.safeParse({ ...ok, approvedAt: "not a date" }).success).toBe(false);
  });

  it("legacy string fields keep working and are reported as owner-approved, never independently verified", () => {
    const b = brain({ differentiators: ["Upfront written estimates"], verifiedFacts: ["Licensed and insured"] });
    expect(provenanceSummary(b)).toEqual({ legacyOwnerApproved: 2, ownerApproved: 0, imported: 0, independentlyVerified: 0, unapproved: 0 });
    expect(groundingIssues(["Licensed and insured. Upfront written estimates"], b)).toEqual([]);
  });

  it("a Business Brain saved before records existed still loads (compatible, no migration needed)", () => {
    const old = { ...BRAIN };
    delete (old as Record<string, unknown>).facts;
    expect(BusinessBrainSchema.parse(old).facts).toEqual([]);
  });

  it("only records approved for marketing support a claim; independent verification does not bypass approval", () => {
    const verified = { ...ok, status: "independently_verified", verification, approvedForMarketing: false, approvedAt: undefined };
    const b = brain({ differentiators: [], verifiedFacts: [], facts: [verified, { ...ok, text: "Family-run" }, { text: "Serving Tulsa for 20 years", status: "owner_provided", source: "owner_form" }] });
    expect(groundingIssues(["Licensed in Oregon"], b)).toEqual([expect.objectContaining({ reason: "unsupported" })]); // verified but never approved for ads
    expect(groundingIssues(["Family-run"], b)).toEqual([]);
    expect(groundingIssues(["Serving Tulsa for 20 years"], b)).toEqual([expect.objectContaining({ reason: "unsupported" })]);
    expect(unapprovedFacts(b)).toEqual(["Licensed in Oregon", "Serving Tulsa for 20 years"]);
    expect(provenanceSummary(b)).toMatchObject({ ownerApproved: 1, independentlyVerified: 0, unapproved: 2 });
  });

  it("approved records support claims whatever their status", () => {
    const b = brain({ differentiators: [], verifiedFacts: [], facts: [{ ...ok, status: "independently_verified", verification }] });
    expect(groundingIssues(["Licensed in Oregon"], b)).toEqual([]);
    expect(provenanceSummary(b).independentlyVerified).toBe(1);
  });

  it("the prompt receives approved records as verifiedFacts and the rest as unverified, with the prompt text unchanged", () => {
    const b = brain({ facts: [{ ...ok, text: "Family-run" }, { text: "Licensed and bonded", status: "owner_provided", source: "owner_form" }] });
    const { system, prompt } = buildCampaignPrompt(b);
    expect(system).toBe(CAMPAIGN_SYSTEM_PROMPT);
    const data = JSON.parse(prompt.split("<business_brain>")[1]!.split("</business_brain>")[0]!.trim());
    expect(data.facts).toBeUndefined();
    expect(data.verifiedFacts).toContain("Family-run");
    expect(data.verifiedFacts).not.toContain("Licensed and bonded");
    expect(data.unverifiedClaims).toContain("Licensed and bonded");
  });

  it("records survive a save and reload", () => {
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: {} });
    const ws = createWorkspace(ctx, "A").workspace;
    putBrain(ctx, ws.id, { ...BRAIN, facts: [ok] });
    expect(getBrain(ctx, ws.id)?.brain.facts).toEqual([expect.objectContaining({ text: "Licensed in Oregon", status: "owner_approved", approvedAt: "2026-10-01" })]);
  });
});

/* ====================================================== generation, editing, proposal and approval pipeline */
describe("pipeline: invalid output and invalid edits cannot reach approval", () => {
  function app(steps: unknown[]) {
    const prov: AiProvider = {
      id: "mock", label: "scripted", models: ["mock-deterministic-1"], simulated: true, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: true }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({ raw: steps.shift() ?? steps[0], model: r.model, simulated: true }),
    };
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: {}, aiProviders: [prov], gateway: { sleep: async () => {} } });
    return { ctx, ws: createWorkspace(ctx, "Acme").workspace };
  }
  const count = (ctx: { db: any }, t: string) => (ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;

  it("generation rejects copy that contradicts a fact, with the conflicting statement in the feedback", async () => {
    const b = brain({ verifiedFacts: ["Not family owned"] });
    const { ctx, ws } = app([withHeadline(b, "Family-owned and trusted"), withHeadline(b, "Family-owned and trusted")]);
    putBrain(ctx, ws.id, b);
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output", message: expect.stringMatching(/"Not family owned".*\[grounding_contradicted\]/) });
    expect(count(ctx, "campaigns")).toBe(0);
  });

  it("generation rejects a brief that ignores an ambiguous fact (no review flag)", async () => {
    const b = brain({ verifiedFacts: ["License application pending"] });
    const noFlag = { ...base(b), reviewFlags: [] };
    const { ctx, ws } = app([noFlag, noFlag]);
    putBrain(ctx, ws.id, b);
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output", message: expect.stringMatching(/fact_issue_unflagged/) });
    expect(count(ctx, "campaigns") + count(ctx, "action_proposals") + count(ctx, "jobs") + count(ctx, "sim_meta_campaigns")).toBe(0);
  });

  it("a conflicting Business Brain can be drafted but never proposed until the owner fixes the facts", async () => {
    const b = brain({ differentiators: ["Family-owned business", "Upfront written estimates"], verifiedFacts: ["Not family owned"] });
    const { ctx, ws } = app([base(b)]);
    putBrain(ctx, ws.id, b);
    const rec = await generateCampaign(ctx, ws.id);
    expect(() => createProposal(ctx, ws.id, rec.id)).toThrow(/\[fact_conflict_unresolved\].*both affirms and denies/);
    expect(count(ctx, "action_proposals")).toBe(0);
    // the owner corrects the Business Brain; the same campaign can now be proposed
    putBrain(ctx, ws.id, { ...b, differentiators: ["Upfront written estimates"] });
    expect(createProposal(ctx, ws.id, rec.id).status).toBe("proposed");
  });

  it("an ambiguous fact makes the proposal need an explicit acknowledgement", async () => {
    const b = brain({ verifiedFacts: ["License application pending"] });
    const { ctx, ws } = app([base(b)]);
    putBrain(ctx, ws.id, b);
    const rec = await generateCampaign(ctx, ws.id);
    const p = createProposal(ctx, ws.id, rec.id);
    expect(() => decideProposal(ctx, ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/needs review before approval/);
    expect(decideProposal(ctx, ws.id, p.id, "approve", { decidedBy: "elia", acknowledgedReview: true }).status).toBe("approved");
  });

  it("an edit that adds a contradicted claim, or removes the flag that an ambiguity needs, cannot be proposed", async () => {
    const b = brain({ verifiedFacts: ["Not family owned", "License application pending"] });
    const { ctx, ws } = app([base(b)]);
    putBrain(ctx, ws.id, b);
    const rec = await generateCampaign(ctx, ws.id);
    updateBrief(ctx, ws.id, rec.id, { ...rec.brief, headlines: [...rec.brief.headlines, "Family-owned and trusted"] });
    expect(() => createProposal(ctx, ws.id, rec.id)).toThrow(/\[grounding_contradicted\] copy/);
    updateBrief(ctx, ws.id, rec.id, { ...rec.brief, reviewFlags: [] });
    expect(() => createProposal(ctx, ws.id, rec.id)).toThrow(/\[fact_issue_unflagged\]/);
    expect(count(ctx, "action_proposals")).toBe(0);
    expect(count(ctx, "sim_meta_campaigns")).toBe(0);
  });

  it("approval re-checks against the CURRENT Business Brain: a fact changed after proposal blocks approval", async () => {
    const b = brain();
    const { ctx, ws } = app([withHeadline(brain({ verifiedFacts: ["Family owned and operated"] }), "Family-owned and trusted")]);
    putBrain(ctx, ws.id, brain({ verifiedFacts: ["Family owned and operated"] }));
    const rec = await generateCampaign(ctx, ws.id);
    const p = createProposal(ctx, ws.id, rec.id);
    putBrain(ctx, ws.id, { ...b, verifiedFacts: ["Not family owned"] }); // the owner learns the claim is false
    expect(() => decideProposal(ctx, ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/cannot be approved yet.*grounding_contradicted/);
    expect(count(ctx, "approvals")).toBe(0);
    expect(count(ctx, "jobs")).toBe(0);
  });
});

/* ================================================================================== the evaluation suite itself */
describe("evaluation: factual validation is separate from schema validity, and deliberate failures are caught", () => {
  it("a contradicted claim is a HARD factual failure even though the output is schema-valid", () => {
    const c = caseById("plumbing-contradictory-ownership-fact");
    const r = evaluateBrief(withHeadline(c.brain, "Family-owned and trusted"), c);
    expect(r.schemaValid).toBe(true);
    expect(r.scores.schemaValidity).toBe(1);
    expect(r.hardFail).toBe(true);
    expect(r.scores.factualGrounding).toBeLessThan(1);
    expect(r.checks.find((k) => k.id === "claims_supported")?.detail).toMatch(/says the opposite/);
    expect(r.checks.find((k) => k.id === "case_specific_forbidden_text")?.pass).toBe(false);
  });

  it("an unflagged ambiguous or conflicting fact fails the review expectation", () => {
    for (const id of ["plumbing-contradictory-ownership-fact", "electrician-negated-and-pending-facts"]) {
      const c = caseById(id);
      const r = evaluateBrief({ ...base(c.brain), reviewFlags: [] }, c);
      expect(r.passed, id).toBe(false);
    }
  });

  it("claims from unapproved or negative facts are caught on the new fixtures", () => {
    const e = caseById("electrician-negated-and-pending-facts");
    expect(evaluateBrief(withHeadline(e.brain, "Licensed electricians"), e).hardFail).toBe(true);
    expect(evaluateBrief(withHeadline(e.brain, "Weekend appointments"), e).hardFail).toBe(true);
    const p = caseById("pest-ambiguous-provenance");
    expect(evaluateBrief(withHeadline(p.brain, "Licensed and bonded pros"), p).hardFail).toBe(true);
    expect(evaluateBrief(withHeadline(p.brain, "Serving Tulsa for 20 years"), p).hardFail).toBe(true);
  });

  it("a missing question about unapproved statements is penalised", () => {
    const p = caseById("pest-ambiguous-provenance");
    const r = evaluateBrief({ ...base(p.brain), openQuestions: [] }, p);
    expect(r.checks.find((k) => k.id.startsWith("asks_approval_of_unapproved"))?.pass).toBe(false);
  });

  it("an unsupported ownership claim is scored as a factual failure (regression: the evaluator once ignored the ownership code)", () => {
    const c = caseById("hvac-no-approved-pricing");
    const r = evaluateBrief(withHeadline(c.brain, "Family-owned and trusted"), c);
    expect(r.hardFail).toBe(true);
    expect(r.checks.find((k) => k.id === "claims_supported")?.pass).toBe(false);
  });

  it("mock success is labelled a plumbing and validator test in the report, not evidence of model quality", async () => {
    const report = await runEvaluation(EVAL_CASES, async (c) => ({ raw: buildMockBrief(c.brain) }), "t", "mock", {
      note: "Plumbing and validator test only: the mock is written to satisfy the rules, so its score shows that the rules, validators and pipeline work, not that any real model writes good or truthful briefs.",
    });
    expect(report.aggregate.passed).toBe(EVAL_CASES.length);
    expect(renderMarkdown(report)).toMatch(/Plumbing and validator test only.*not that any real model writes good or truthful briefs/);
    expect(renderMarkdown(report)).toMatch(/Comparable view/);
  });

  it("the suite has 14 fixtures including contradictory facts and ambiguous provenance", () => {
    expect(EVAL_CASES).toHaveLength(14);
    expect(EVAL_CASES.some((c) => factIssues(c.brain).some((i) => i.type === "conflict"))).toBe(true);
    expect(EVAL_CASES.some((c) => factIssues(c.brain).some((i) => i.type === "ambiguous"))).toBe(true);
    expect(EVAL_CASES.some((c) => unapprovedFacts(c.brain).length > 0)).toBe(true);
  });
});
