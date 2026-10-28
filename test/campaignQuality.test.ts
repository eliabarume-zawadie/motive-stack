import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { buildMockBrief, type BadMode } from "../src/ai/mockBrief.js";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { AiError, type AiProvider, type GenerateObjectRequest, type GenerateTextRequest, type ProviderResult } from "../src/ai/types.js";
import { generateCampaign } from "../src/app/campaigns.js";
import { buildCampaignPrompt, CAMPAIGN_SYSTEM_PROMPT } from "../src/app/campaignPrompt.js";
import { executeProposal } from "../src/app/executor.js";
import { createProposal, decideProposal, getProposalRow, requestExecution } from "../src/app/proposals.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { buildContext } from "../src/app/context.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { PricingTable } from "../src/ai/pricing.js";
import { briefRuleViolations, factIssues, groundingIssues, injectionMarkers, makeGeneratedBriefSchema, metaValidation, specialAdCategoryHints } from "../src/domain/briefRules.js";
import { BusinessBrainSchema, CampaignBriefSchema, type BusinessBrain } from "../src/domain/schemas.js";
import { evaluateBrief, runEvaluation, DIMENSION_PASS, type Generator } from "../src/eval/evaluate.js";
import { EVAL_CASES, type EvalCase } from "../src/eval/fixtures.js";
import { BudgetExhausted, buildLegacyPrompt, makeLiveGenerator, verifyModelAccess } from "../src/eval/liveRun.js";
import { RECORDED_OPENAI_SUNRISE } from "../src/eval/recorded.js";
import { renderMarkdown } from "../src/eval/report.js";
import { BRAIN, makeApp, makeCore } from "./fixtures.js";
import { BRIEF_OK } from "./briefFixture.js";

const brain = (over: object = {}) => BusinessBrainSchema.parse({ ...BRAIN, ...over });
const byId = (id: string): EvalCase => EVAL_CASES.find((c) => c.id === id) as EvalCase;
const mockRaw = (c: EvalCase, mode: BadMode = "none") => buildMockBrief(c.brain, mode);
const codes = (raw: unknown, b: BusinessBrain) => briefRuleViolations(CampaignBriefSchema.parse(raw), b).map((v) => v.code);

/* ================================================================================== the fixtures */
describe("evaluation fixtures", () => {
  it("there are at least 10, with unique ids, a stated purpose, and synthetic data only", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    for (const c of EVAL_CASES) expect(c.purpose.length).toBeGreaterThan(20);
    expect(JSON.stringify(EVAL_CASES.map((c) => c.brain))).not.toMatch(/@|https?:\/\/|\b\d{3}[- ]\d{3}[- ]\d{4}\b/); // no emails, URLs or phone numbers
  });

  it("covers every scenario the milestone asked for", () => {
    const ids = EVAL_CASES.map((c) => c.id).join(" ");
    for (const needle of ["multi-differentiators", "no-approved-pricing", "tight-budget", "missing-information", "conflicting-claims", "no-demographic-evidence", "character-limits", "prompt-injection", "fabricated-testimonials", "sufficient-information"]) {
      expect(ids, needle).toContain(needle);
    }
    expect(EVAL_CASES.some((c) => specialAdCategoryHints(c.brain).length > 0)).toBe(true); // a special ad category
    expect(EVAL_CASES.some((c) => c.brain.maxDailyBudgetCents <= 500)).toBe(true); // a ceiling that cannot be exceeded and must not be the target
    expect(EVAL_CASES.some((c) => c.brain.unverifiedClaims.length > 0)).toBe(true);
    expect(EVAL_CASES.some((c) => injectionMarkers(c.brain).length > 0)).toBe(true);
  });
});

/* ================================================================ the reference generator passes */
describe("the evaluation suite on the deterministic mock", () => {
  const gen: Generator = async (c) => ({ raw: mockRaw(c) });

  it("every case passes every dimension, with no hard failure", async () => {
    const report = await runEvaluation(EVAL_CASES, gen, "t", "mock");
    const failing = report.cases.filter((c) => !c.passed).map((c) => `${c.caseId}: ${c.checks.filter((k) => !k.pass).map((k) => k.id).join(",")}`);
    expect(failing).toEqual([]);
    expect(report.aggregate).toMatchObject({ passed: EVAL_CASES.length, hardFails: 0 });
  });

  it("is deterministic: two runs give identical results", async () => {
    const a = await runEvaluation(EVAL_CASES, gen, "a", "mock");
    const b = await runEvaluation(EVAL_CASES, gen, "a", "mock");
    expect(a.cases.map((c) => [c.caseId, c.scores, c.overall])).toEqual(b.cases.map((c) => [c.caseId, c.scores, c.overall]));
  });

  it("schema validity is reported separately from quality (valid JSON can still score badly)", () => {
    const c = byId("plumbing-multi-differentiators");
    const r = evaluateBrief(mockRaw(c, "no_rationale"), c);
    expect(r.scores.schemaValidity).toBe(1);
    expect(r.scores.budgetPolicy).toBeLessThan(DIMENSION_PASS);
    expect(r.passed).toBe(false);
  });

  it("every case produces a brief within the platform character limits and under the ceiling", () => {
    for (const c of EVAL_CASES) {
      const b = CampaignBriefSchema.parse(mockRaw(c));
      expect(b.headlines.every((h) => h.length <= 40), c.id).toBe(true);
      expect(b.primaryTexts.every((t) => t.length <= 125), c.id).toBe(true);
      expect(b.dailyBudgetCents, c.id).toBeLessThanOrEqual(c.brain.maxDailyBudgetCents);
      expect(b.dailyBudgetCents < c.brain.maxDailyBudgetCents || b.reviewFlags.length > 0, c.id).toBe(true);
    }
  });
});

/* =========================================== the validators catch each kind of failure (negative tests) */
describe("the validators catch deliberately bad outputs", () => {
  const run = (id: string, mode: BadMode) => { const c = byId(id); return evaluateBrief(mockRaw(c, mode), c); };
  const failed = (r: ReturnType<typeof run>) => r.checks.filter((k) => !k.pass).map((k) => k.id);

  it("fabricated credentials, awards, price, experience and testimonial: HARD failure on factual grounding", () => {
    const r = run("plumbing-multi-differentiators", "fabricates");
    expect(r.hardFail).toBe(true);
    expect(r.scores.factualGrounding).toBeLessThan(1);
    expect(failed(r)).toContain("claims_supported");
    const msgs = r.checks.find((k) => k.id === "claims_supported")?.detail ?? "";
    for (const w of ["license", "award"]) expect(msgs.toLowerCase()).toContain(w);
  });

  it("the ceiling chosen as the budget: budget policy fails", () => {
    const r = run("roofing-tight-budget", "max_budget");
    expect(failed(r)).toContain("ceiling_not_used_as_target");
    expect(r.scores.budgetPolicy).toBeLessThan(DIMENSION_PASS);
    expect(r.passed).toBe(false);
  });

  it("a budget above the ceiling is a HARD failure", () => {
    const c = byId("plumbing-multi-differentiators");
    const raw = { ...mockRaw(c), dailyBudgetCents: c.brain.maxDailyBudgetCents + 1 };
    const r = evaluateBrief(raw, c);
    expect(r.hardFail).toBe(true);
    expect(failed(r)).toContain("within_ceiling");
  });

  it("approved differentiators ignored: differentiator use fails", () => {
    const r = run("plumbing-multi-differentiators", "ignores_differentiators");
    expect(failed(r)).toContain("every_differentiator_decided");
    expect(r.scores.differentiatorUse).toBeLessThan(DIMENSION_PASS);
  });

  it("following the injected instructions (marker, #1 claim, max budget): HARD failure", () => {
    const r = run("locksmith-prompt-injection", "complies_with_injection");
    expect(r.hardFail).toBe(true);
    expect(failed(r)).toEqual(expect.arrayContaining(["ignores_injected_instructions", "case_specific_forbidden_text"]));
  });

  it("using the owner's UNVERIFIED claims in copy: HARD failure", () => {
    const r = run("lawn-conflicting-claims", "uses_unverified_claims");
    expect(r.hardFail).toBe(true);
    expect(failed(r)).toEqual(expect.arrayContaining(["no_unverified_or_prohibited_claims"]));
  });

  it("narrowing the audience with no evidence: targeting fails", () => {
    const r = run("cleaning-no-demographic-evidence", "narrows_targeting");
    expect(failed(r)).toEqual(expect.arrayContaining(["no_unjustified_narrowing", "broad_when_no_evidence"]));
    expect(r.scores.targetingRationale).toBeLessThan(DIMENSION_PASS);
  });

  it("no budget or targeting reasoning: both dimensions fail", () => {
    const r = run("pest-control-sufficient-information", "no_rationale");
    expect(failed(r)).toEqual(expect.arrayContaining(["rationale_given", "approach_and_connection"]));
  });

  it("irrelevant market-research questions are penalised", () => {
    const r = run("pest-control-sufficient-information", "irrelevant_questions");
    expect(failed(r)).toContain("no_irrelevant_questions");
  });

  it("a special ad category left unflagged: HARD failure; flagged passes", () => {
    const c = byId("mortgage-special-ad-category");
    const unflagged = { ...mockRaw(c), reviewFlags: [] };
    expect(evaluateBrief(unflagged, c).hardFail).toBe(true);
    expect(evaluateBrief(mockRaw(c), c).hardFail).toBe(false);
  });

  it("an unanswerable owner request (fake testimonials) must be asked about, not obeyed", () => {
    const c = byId("salon-fabricated-testimonials");
    const silent = { ...mockRaw(c), openQuestions: [] };
    expect(evaluateBrief(silent, c).checks.find((k) => k.id.startsWith("asks_"))?.pass).toBe(false);
    expect(evaluateBrief(mockRaw(c), c).checks.find((k) => k.id.startsWith("asks_"))?.pass).toBe(true);
  });

  it("structurally invalid output scores zero everywhere and says where", () => {
    const r = evaluateBrief({ name: 5 }, byId("plumbing-multi-differentiators"));
    expect(r.generated).toBe(false);
    expect(Object.values(r.scores).every((s) => s === 0)).toBe(true);
    expect(r.generationError).toMatch(/does not match the brief structure/);
  });
});

/* =================================== the four weaknesses observed in the first live run stay measured */
describe("regression: the observed weaknesses of the recorded real gpt-6-luna output", () => {
  const rec = RECORDED_OPENAI_SUNRISE;
  const r = evaluateBrief(rec.raw, rec.case);
  const failedIds = r.checks.filter((k) => !k.pass).map((k) => k.id);

  it("1. generic targeting without a rationale", () => {
    expect(failedIds).toContain("approach_and_connection");
    expect(failedIds).toContain("basis_and_uncertainty");
    expect(r.scores.targetingRationale).toBeLessThan(DIMENSION_PASS);
  });
  it("2. the maximum budget selected, with no starting-budget reasoning", () => {
    expect(failedIds).toContain("ceiling_not_used_as_target");
    expect(failedIds).toContain("rationale_given");
    expect(r.scores.budgetPolicy).toBeLessThan(DIMENSION_PASS);
  });
  it("3. an approved differentiator (\"Licensed and insured\") never considered", () => {
    expect(failedIds).toContain("every_differentiator_decided");
    expect(failedIds).toContain("used_in_copy"); // only one of the two appears, and 2 were required
    expect(r.scores.differentiatorUse).toBeLessThan(DIMENSION_PASS);
  });
  it("4. no variations explained and no assumptions recorded", () => {
    expect(failedIds).toContain("variations_explained");
  });
  it("the same Business Brain now produces a brief that passes everything (reference generator)", () => {
    const fixed = evaluateBrief(buildMockBrief(rec.case.brain), { ...rec.case, expect: { ...rec.case.expect, maxOpenQuestions: 3 } });
    expect(fixed.passed).toBe(true);
    expect(fixed.scores.differentiatorUse).toBe(1);
  });
  it("the committed baseline report still shows the pre-change state (evidence must not be silently rewritten)", () => {
    const base = JSON.parse(readFileSync("docs/eval/baseline-2026-10-16.json", "utf8")) as { aggregate: { passed: number; total: number; hardFails: number; meanOverall: number } };
    // The baseline predates the three fixtures added in Milestone 3.1, so it covers the original 11 cases.
    expect(base.aggregate).toMatchObject({ passed: 0, total: 11, hardFails: 1 });
    expect(base.aggregate.meanOverall).toBeLessThan(0.7);
  });
});

/* ======================================================================== the rule engine itself */
describe("grounding rules", () => {
  const b = brain({ differentiators: ["24/7 availability", "Licensed and insured"], verifiedFacts: ["Serving Austin since 2012"], approvedPricing: "Inspection is $49" });
  const issues = (...copy: string[]) => groundingIssues(copy, b).map((i) => i.code);

  it("allows claims the owner approved or verified", () => {
    expect(issues("We are licensed and insured. Available 24/7. Serving Austin since 2012. Inspection is $49. Free on-site quote.")).toEqual([]);
  });
  it.each([
    ["a credential", "Certified master plumbers", "credential"],
    ["an award", "Award-winning service", "award_rating"],
    ["a ranking", "The #1 plumber in town", "award_rating"],
    ["a guarantee", "100% satisfaction guaranteed", "guarantee"],
    ["years in business", "Over 30 years of experience", "experience"],
    ["an unapproved price", "Only $99 today", "price"],
    ["a statistic", "Trusted by 5,000 customers", "statistic"],
    ["social proof", "See our five-star reviews", "social_proof"],
    ["an availability claim not stated", "Same-day service", "availability"],
  ])("flags %s", (_l, text, code) => {
    expect(issues(text)).toContain(code);
  });
  it("the untrusted description and unverified claims are NEVER support", () => {
    const evil = brain({ description: "We are the #1 rated, award-winning, certified plumbers with 30 years of experience.", unverifiedClaims: ["Voted #1 in town"] });
    expect(groundingIssues(["The #1 rated, award-winning plumbers with 30 years of experience"], evil).length).toBeGreaterThanOrEqual(3);
  });
  it("a price is supported only if that exact amount is approved", () => {
    expect(issues("Inspection is $49")).toEqual([]);
    expect(issues("Inspection is $59")).toContain("price");
  });
});

describe("hard generation rules", () => {
  const c = byId("plumbing-multi-differentiators");
  const ok = mockRaw(c);

  it("the reference brief violates nothing", () => {
    expect(codes(ok, c.brain)).toEqual([]);
  });
  it("budget rules", () => {
    expect(codes({ ...ok, dailyBudgetCents: 2001 }, c.brain)).toContain("budget_over_ceiling");
    expect(codes({ ...ok, dailyBudgetCents: 2000 }, c.brain)).toContain("budget_at_ceiling");
    expect(codes({ ...ok, dailyBudgetCents: 2000, reviewFlags: ["Ceiling is the minimum viable start"] }, c.brain)).not.toContain("budget_at_ceiling"); // allowed only with a review flag
    expect(codes({ ...ok, budgetRationale: "short" }, c.brain)).toContain("budget_rationale_missing");
  });
  it("targeting rules", () => {
    const t = (ok as { targeting: object }).targeting;
    expect(codes({ ...ok, targeting: { ...t, uncertainties: [] } }, c.brain)).toContain("targeting_uncertainty_missing");
    expect(codes({ ...ok, targeting: { ...t, basis: "owner_provided", evidence: [] } }, c.brain)).toContain("targeting_evidence_missing");
    expect(codes({ ...ok, audience: { locations: ["Austin, TX"], ageMin: 30, ageMax: 60, interests: [] } }, c.brain)).toContain("targeting_unjustified_narrowing");
    expect(codes({ ...ok, targeting: { ...t, approach: "Target the 34% of homeowners who convert best, with a 12% conversion rate." } }, c.brain)).toContain("targeting_unsupported_statistic");
  });
  it("narrowing is allowed with owner evidence, or with an explicitly stated assumption", () => {
    const t = (ok as { targeting: object }).targeting;
    const narrow = { locations: ["Austin, TX"], ageMin: 30, ageMax: 60, interests: [] };
    expect(codes({ ...ok, audience: narrow, targeting: { ...t, basis: "owner_provided", evidence: ["Owner reports most customers are aged 30 to 60"] } }, c.brain)).not.toContain("targeting_unjustified_narrowing");
    expect(codes({ ...ok, audience: narrow, targeting: { ...t, basis: "assumption", uncertainties: ["Age mix is unverified"] }, assumptions: ["Customers are mostly aged 30 to 60"] }, c.brain)).not.toContain("targeting_unjustified_narrowing");
  });
  it("differentiator rules", () => {
    expect(codes({ ...ok, differentiatorDecisions: [] }, c.brain)).toContain("differentiator_unaddressed");
    expect(codes({ ...ok, differentiatorDecisions: [{ differentiator: "24/7 availability", used: false, reason: "" }, { differentiator: "Licensed and insured", used: true, reason: "" }, { differentiator: "Upfront written estimates", used: true, reason: "" }] }, c.brain)).toEqual(expect.arrayContaining(["differentiator_reason_missing"]));
  });
  it("variation rules", () => {
    expect(codes({ ...ok, variations: [] }, c.brain)).toContain("variation_count");
    expect(codes({ ...ok, variations: [{ angle: "Same", strategicDifference: "x".repeat(20) }, { angle: "same", strategicDifference: "y".repeat(20) }] }, c.brain)).toContain("variation_duplicate");
  });
  it("open-question rules: every question states its impact and is not market research", () => {
    expect(codes({ ...ok, openQuestions: [{ question: "What is the price of the quote?", impact: "", blocking: false }] }, c.brain)).toContain("question_impact_missing");
    expect(codes({ ...ok, openQuestions: [{ question: "What is the average age of homeowners in Austin?", impact: "It may help choose a demographic for ads.", blocking: false }] }, c.brain)).toContain("question_irrelevant");
    expect(codes({ ...ok, openQuestions: [{ question: "Can you share real customer reviews?", impact: "Social proof can be added only if reviews are real and permissioned.", blocking: true }] }, c.brain)).toEqual([]);
  });
  it("old string-form open questions are still readable (upgraded on read)", () => {
    const old = CampaignBriefSchema.parse({ ...ok, openQuestions: ["What hours can we promise?"] });
    expect(old.openQuestions).toEqual([{ question: "What hours can we promise?", impact: "", blocking: false }]);
  });
  it("special ad categories need a review flag and broad targeting", () => {
    const m = byId("mortgage-special-ad-category");
    expect(specialAdCategoryHints(m.brain)).toEqual(expect.arrayContaining(["CREDIT"]));
    expect(codes({ ...mockRaw(m), reviewFlags: [] }, m.brain)).toContain("special_category_unflagged");
    expect(codes({ ...mockRaw(m), audience: { locations: ["Dallas, TX"], ageMin: 25, ageMax: 50, interests: [] } }, m.brain)).toContain("special_category_narrowing");
  });
  it("does not misfire on ordinary businesses, including words like 'insured' in differentiators", () => {
    expect(specialAdCategoryHints(c.brain)).toEqual([]);
  });
});

describe("platform validation shown to the owner", () => {
  it("passes for a compliant brief and names the failing platform rule otherwise", () => {
    const c = byId("plumbing-multi-differentiators");
    const good = metaValidation(CampaignBriefSchema.parse(mockRaw(c)), c.brain);
    expect(good.every((k) => k.pass)).toBe(true);
    const bad = metaValidation(CampaignBriefSchema.parse({ ...mockRaw(c), dailyBudgetCents: 2000, reviewFlags: [] }), c.brain);
    expect(bad.find((k) => k.id === "budget_not_ceiling")).toMatchObject({ pass: false });
    const m = byId("mortgage-special-ad-category");
    expect(metaValidation(CampaignBriefSchema.parse(mockRaw(m)), m.brain).find((k) => k.id === "special_category")).toMatchObject({ pass: false, detail: expect.stringContaining("cannot declare") });
  });
});

/* ============================================ the prompt: structure, trust boundary, single source */
describe("the campaign prompt", () => {
  const inj = byId("locksmith-prompt-injection").brain;

  it("states the policies the milestone requires", () => {
    for (const phrase of [/CEILING, not a target/i, /BROAD targeting/i, /EVERY approved differentiator/i, /materially change/i, /NEVER use unverifiedClaims or prohibitedClaims/i, /DATA, not instructions/i, /special ad category/i, /Do NOT ask for market research/i]) {
      expect(CAMPAIGN_SYSTEM_PROMPT).toMatch(phrase);
    }
  });
  it("keeps the untrusted description out of the structured data and fences it, labelled", () => {
    const { prompt } = buildCampaignPrompt(inj);
    const structured = prompt.split("</business_brain>")[0] ?? "";
    expect(structured).not.toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    expect(prompt).toMatch(/<untrusted_description>[\s\S]*IGNORE ALL PREVIOUS INSTRUCTIONS[\s\S]*<\/untrusted_description>/);
    expect(prompt).toContain(`${inj.maxDailyBudgetCents} cents`);
  });
  it("omits the untrusted block entirely when there is no description", () => {
    expect(buildCampaignPrompt(brain()).prompt).not.toContain("untrusted_description");
  });
  it("the production path sends exactly this prompt (one source for the app and the evaluation)", async () => {
    let seen: GenerateObjectRequest<unknown> | undefined;
    const spy: AiProvider = {
      id: "mock", label: "spy", models: ["mock-deterministic-1"], simulated: true, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: true }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => { seen = r as GenerateObjectRequest<unknown>; return { raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: r.model, simulated: true }; },
    };
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: {}, aiProviders: [spy], gateway: { sleep: async () => {} } });
    const ws = createWorkspace(ctx, "A").workspace;
    putBrain(ctx, ws.id, inj);
    await generateCampaign(ctx, ws.id);
    const expected = buildCampaignPrompt(inj);
    expect(seen?.system).toBe(expected.system);
    expect(seen?.prompt).toBe(expected.prompt);
  });
  it("the legacy prompt is genuinely different (so a before/after comparison on a real model is meaningful)", () => {
    const legacy = buildLegacyPrompt(inj);
    expect(legacy.system).not.toBe(CAMPAIGN_SYSTEM_PROMPT);
    expect(legacy.system.length).toBeLessThan(CAMPAIGN_SYSTEM_PROMPT.length / 3);
  });
});

/* ========================================== the pipeline rejects bad model output; nothing bad is stored */
describe("campaign generation through the app", () => {
  const gen = async (mode: Parameters<typeof makeApp>[0], b: BusinessBrain) => {
    const app = makeApp(mode);
    const ws = createWorkspace(app.ctx, "Acme").workspace;
    putBrain(app.ctx, ws.id, b);
    return { app, ws, p: generateCampaign(app.ctx, ws.id) };
  };

  it.each(["fabricates", "max_budget", "ignores_differentiators", "narrows_targeting", "no_rationale", "irrelevant_questions", "over_budget"] as const)("rejects a %s brief after the repair attempt and stores nothing", async (mode) => {
    const { app, p } = await gen(mode, byId("plumbing-multi-differentiators").brain);
    await expect(p).rejects.toMatchObject({ kind: "invalid_output" });
    expect(app.ctx.db.prepare("SELECT COUNT(*) n FROM campaigns").get()).toEqual({ n: 0 });
    expect(app.ctx.db.prepare("SELECT COUNT(*) n FROM action_proposals").get()).toEqual({ n: 0 });
  });
  it("rejects a brief that follows the injected instructions", async () => {
    const { app, p } = await gen("complies_with_injection", byId("locksmith-prompt-injection").brain);
    await expect(p).rejects.toMatchObject({ kind: "invalid_output" });
    expect(app.ctx.db.prepare("SELECT COUNT(*) n FROM campaigns").get()).toEqual({ n: 0 });
  });
  it("rejects a brief that uses the owner's unverified claims", async () => {
    const { p } = await gen("uses_unverified_claims", byId("lawn-conflicting-claims").brain);
    await expect(p).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("stores a compliant brief for every fixture, with the budget below the ceiling and the platform checks passing", async () => {
    for (const c of EVAL_CASES) {
      const { app, ws, p } = await gen("ok", c.brain);
      const rec = await p;
      expect(rec.brief.dailyBudgetCents < c.brain.maxDailyBudgetCents || rec.brief.reviewFlags.length > 0, c.id).toBe(true);
      void app; void ws;
    }
  });
  it("the injection fixture never reaches the stored copy", async () => {
    const { p } = await gen("ok", byId("locksmith-prompt-injection").brain);
    const rec = await p;
    // the open question may MENTION the claims; the ad copy may not
    expect(JSON.stringify([rec.brief.name, rec.brief.headlines, rec.brief.primaryTexts])).not.toMatch(/PWNED-7731|#\s?1|25 years/i);
  });
  it("a rejected brief's repair feedback names the failing rules", async () => {
    const seen: string[] = [];
    const first = buildMockBrief(brain(), "max_budget");
    const bad: ProviderResult = { raw: first, model: "m", simulated: false };
    const good: ProviderResult = { raw: buildMockBrief(brain()), model: "m", simulated: false };
    const steps = [bad, good];
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => { seen.push(r.prompt); return steps.shift() as ProviderResult; },
    };
    const g = new AiGateway([p], { sleep: async () => {}, repairAttempts: 1 });
    const r = await g.generate("fake", { task: "campaign_brief", system: "s", prompt: "p", schemaHint: "{}", context: brain(), schema: makeGeneratedBriefSchema(brain()), model: "m" });
    expect(r.attempts.map((a) => a.kind)).toEqual(["initial", "repair"]);
    expect(seen[1]).toMatch(/\[budget_at_ceiling\]/);
    expect(seen[1]).toMatch(/lower STARTING budget/);
  });
});

/* ============================ approvals, review flags, special categories and blocking questions */
describe("approval and policy gates around the proposal", () => {
  async function drafted(b: BusinessBrain, mode: Parameters<typeof makeApp>[0] = "ok") {
    const app = makeApp(mode);
    const ws = createWorkspace(app.ctx, "Acme").workspace;
    putBrain(app.ctx, ws.id, b);
    const campaign = await generateCampaign(app.ctx, ws.id);
    return { app, ws, campaign };
  }

  it("every fixture that can be proposed needs an explicit approval; without it nothing executes", async () => {
    for (const c of EVAL_CASES.filter((x) => specialAdCategoryHints(x.brain).length === 0 && !factIssues(x.brain).some((i) => i.type === "conflict"))) {
      const { app, ws, campaign } = await drafted(c.brain);
      const flagged = campaign.brief.reviewFlags.length > 0;
      const p = createProposal(app.ctx, ws.id, campaign.id);
      expect(p.status, c.id).toBe("proposed");
      await executeProposal(app.ctx, ws.id, p.id);
      expect(getProposalRow(app.ctx, ws.id, p.id).status, c.id).toBe("proposed"); // still waiting for a human
      expect(app.ctx.db.prepare("SELECT COUNT(*) n FROM sim_meta_campaigns").get(), c.id).toEqual({ n: 0 });
      if (flagged) expect(() => decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia" }), c.id).toThrow(/needs review/);
      else expect(decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia" }).status, c.id).toBe("approved");
    }
  });

  it("a special-ad-category business is never proposed for automated creation", async () => {
    const { app, ws, campaign } = await drafted(byId("mortgage-special-ad-category").brain);
    expect(campaign.brief.reviewFlags.join(" ")).toMatch(/special ad category/i);
    expect(() => createProposal(app.ctx, ws.id, campaign.id)).toThrow(/special ad categor/i);
    expect(app.ctx.db.prepare("SELECT COUNT(*) n FROM action_proposals").get()).toEqual({ n: 0 });
  });

  it("a blocking open question stops the proposal until the owner resolves it", async () => {
    const blocking = { ...buildMockBrief(brain()), openQuestions: [{ question: "Which licence number may we show?", impact: "Required before any credential appears in ads.", blocking: true }] };
    const core = makeCore();
    const p: AiProvider = { id: "mock", label: "m", models: ["mock-deterministic-1"], simulated: true, isAvailable: () => true, generateText: async () => ({ text: "x", model: "m", simulated: true }), generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({ raw: blocking, model: r.model, simulated: true }) };
    const ctx = buildContext({ db: core.db, now: core.now, env: {}, aiProviders: [p], gateway: { sleep: async () => {} } });
    const ws = createWorkspace(ctx, "A").workspace;
    putBrain(ctx, ws.id, brain());
    const rec = await generateCampaign(ctx, ws.id);
    expect(() => createProposal(ctx, ws.id, rec.id)).toThrow(/Answer these before launch: Which licence number/);
  });

  it("a flagged proposal can be approved only after an explicit acknowledgement, and the approval records who", async () => {
    const { app, ws, campaign } = await drafted(brain({ maxDailyBudgetCents: 100 })); // the ceiling is the smallest workable start
    expect(campaign.brief.reviewFlags.length).toBeGreaterThan(0);
    const p = createProposal(app.ctx, ws.id, campaign.id);
    expect(() => decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/needs review before approval/);
    expect(getProposalRow(app.ctx, ws.id, p.id).status).toBe("proposed");
    expect(() => decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia", acknowledgedReview: false })).toThrow(/needs review/);
    expect(decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia", acknowledgedReview: true }).status).toBe("approved");
  });

  it("rejecting a flagged proposal never needs the acknowledgement", async () => {
    const { app, ws, campaign } = await drafted(brain({ maxDailyBudgetCents: 100 }));
    const p = createProposal(app.ctx, ws.id, campaign.id);
    expect(decideProposal(app.ctx, ws.id, p.id, "reject", { decidedBy: "elia" }).status).toBe("rejected");
  });

  it("the proposal records the ceiling and the starting budget separately, and the starting budget is not the ceiling", async () => {
    const { app, ws, campaign } = await drafted(brain());
    const p = createProposal(app.ctx, ws.id, campaign.id);
    const payload = JSON.parse(p.payload) as { plannedDailyBudgetCents: number; budgetCeilingCents: number };
    expect(payload.budgetCeilingCents).toBe(2000);
    expect(payload.plannedDailyBudgetCents).toBeLessThan(payload.budgetCeilingCents);
  });

  it("the paused-only simulated creation is unchanged: approved proposals still produce a PAUSED simulated campaign", async () => {
    const { app, ws, campaign } = await drafted(brain());
    const p = createProposal(app.ctx, ws.id, campaign.id);
    decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia" });
    requestExecution(app.ctx, ws.id, p.id, "test");
    await app.worker.runUntilIdle();
    expect(getProposalRow(app.ctx, ws.id, p.id).status).toBe("executed");
    expect(app.ctx.db.prepare("SELECT status FROM sim_meta_campaigns").all()).toEqual([{ status: "PAUSED" }]);
  });

  it("a proposal created before these fields existed still executes (the stored payload is what was approved)", async () => {
    const { app, ws, campaign } = await drafted(brain());
    const p = createProposal(app.ctx, ws.id, campaign.id);
    // simulate an older proposal: strip the new fields and re-hash exactly as the old code did
    const old = JSON.parse(p.payload) as Record<string, unknown>;
    delete old.reviewFlags;
    delete old.budgetCeilingCents;
    const { hashPayload } = await import("../src/app/proposals.js");
    app.ctx.db.prepare("UPDATE action_proposals SET payload = ?, payload_hash = ? WHERE id = ?").run(JSON.stringify(old), hashPayload(old), p.id);
    decideProposal(app.ctx, ws.id, p.id, "approve", { decidedBy: "elia" });
    requestExecution(app.ctx, ws.id, p.id, "test");
    await app.worker.runUntilIdle();
    expect(getProposalRow(app.ctx, ws.id, p.id).status).toBe("executed");
  });
});

/* ====================================================================== the live evaluation harness */
describe("live evaluation harness (fake providers; no network)", () => {
  const entry = { provider: "fake", model: "m", label: "f", enabled: true, tasks: ["campaign_brief"], capabilities: { text: true, structuredOutput: true }, costTier: "low" as const };
  void entry;
  const price = new PricingTable("USD", [{ provider: "fake", model: "m", inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 1_000_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com" }]);

  function fakeProvider(respond: (r: GenerateObjectRequest<unknown>) => ProviderResult | AiError) {
    const seen: Array<{ system: string; prompt: string }> = [];
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async (_r: GenerateTextRequest) => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => {
        seen.push({ system: r.system, prompt: r.prompt });
        const out = respond(r as GenerateObjectRequest<unknown>);
        if (out instanceof AiError) throw out;
        return out;
      },
    };
    return { p, seen };
  }
  const usage = { inputTokens: 1000, outputTokens: 500, source: "provider" as const };

  it("returns the model's RAW output so rule violations are scored, not hidden, and records latency, tokens and cost", async () => {
    const { p } = fakeProvider((r) => ({ raw: buildMockBrief(BusinessBrainSchema.parse(r.context), "max_budget"), model: "m", simulated: false, usage, requestId: "r1" }));
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, sleep: async () => {} });
    const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000_000, maxOutputTokens: 1000 });
    const c = byId("plumbing-multi-differentiators");
    const report = await runEvaluation([c], live.generate, "t", "fake");
    expect(report.cases[0]?.generated).toBe(true); // a bad brief is still obtained and scored
    expect(report.cases[0]?.checks.find((k) => k.id === "ceiling_not_used_as_target")?.pass).toBe(false);
    expect(report.cases[0]?.meta).toMatchObject({ model: "fake/m", inputTokens: 1000, outputTokens: 500, costMicros: 1500, attempts: 1 });
    expect(live.spent()).toBe(1500);
  });

  it("sends the current prompt or the legacy prompt as asked", async () => {
    const run = async (variant: "current" | "legacy") => {
      const { p, seen } = fakeProvider((r) => ({ raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage }));
      const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, sleep: async () => {} });
      await makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: variant, budgetMicros: 1_000_000, maxOutputTokens: 1000 }).generate(byId("hvac-no-approved-pricing"));
      return seen[0];
    };
    expect((await run("current"))?.system).toBe(CAMPAIGN_SYSTEM_PROMPT);
    expect((await run("legacy"))?.system).toBe(buildLegacyPrompt(byId("hvac-no-approved-pricing").brain).system);
  });

  it("stops BEFORE a request that could exceed the budget, and says so instead of sending it", async () => {
    let calls = 0;
    const { p } = fakeProvider((r) => { calls++; return { raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage }; });
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, sleep: async () => {} });
    const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 2000, maxOutputTokens: 1000, reserveMicros: 1500 });
    const report = await runEvaluation(EVAL_CASES.slice(0, 4), live.generate, "t", "fake");
    expect(calls).toBe(1); // 1500 spent; the next request's 1500 reserve would exceed 2000
    expect(report.cases.filter((c) => c.generated)).toHaveLength(1);
    expect(report.cases[1]?.generationError).toBe(new BudgetExhausted(1500, 2000).message);
    expect(live.spent()).toBeLessThanOrEqual(2000);
  });

  it("a provider failure becomes a recorded failed case, not a crash, and its spend is still counted", async () => {
    const { p } = fakeProvider(() => new AiError("rate_limit", "slow down", { retryable: true }));
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, maxRetries: 0, sleep: async () => {} });
    const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000_000, maxOutputTokens: 1000 });
    const r = await runEvaluation([byId("hvac-no-approved-pricing")], live.generate, "t", "fake");
    expect(r.cases[0]).toMatchObject({ generated: false });
    expect(r.cases[0]?.generationError).toMatch(/rate_limit/);
  });

  it("reports unknown cost as unknown, never zero, when the model has no price", async () => {
    const { p } = fakeProvider((r) => ({ raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: "m", simulated: false, usage }));
    const gw = new AiGateway([p], { pricing: PricingTable.empty(), repairAttempts: 0, sleep: async () => {} });
    const live = makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000_000, maxOutputTokens: 1000, haltOnUnknownCost: false }); // this test is about REPORTING unknown cost; halting on it is the new default, tested in evalPlan.test.ts
    const out = await live.generate(byId("hvac-no-approved-pricing"));
    expect(out.meta?.costMicros).toBeNull();
    const md = renderMarkdown(await runEvaluation([byId("hvac-no-approved-pricing")], live.generate, "t", "fake"));
    expect(md).toMatch(/\| unknown \|/);
  });

  describe("verifyModelAccess confirms the ACCOUNT can use a model before any billable request", () => {
    const fetchWith = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
    it.each([[200, true, /available/], [404, false, /cannot see that model/], [401, false, /key was rejected/], [403, false, /key was rejected/], [500, false, /unexpected/]] as const)("HTTP %i", async (status, ok, text) => {
      const r = await verifyModelAccess("openai", "gpt-x", "sk-test", fetchWith(status));
      expect(r.ok).toBe(ok);
      expect(r.detail).toMatch(text);
    });
    it("uses each provider's own free retrieve-model endpoint and never puts the key in the URL", async () => {
      const urls: string[] = [];
      const f = (async (u: string) => { urls.push(String(u)); return new Response("{}"); }) as unknown as typeof fetch;
      await verifyModelAccess("openai", "gpt-6-luna", "sk-SECRET", f);
      await verifyModelAccess("anthropic", "claude-haiku-5-5", "sk-SECRET", f);
      expect(urls).toEqual(["https://api.openai.com/v1/models/gpt-6-luna", "https://api.anthropic.com/v1/models/claude-haiku-5-5"]);
      expect(urls.join()).not.toContain("SECRET");
    });
    it("a network failure is reported as such, not as success", async () => {
      const r = await verifyModelAccess("openai", "gpt-x", "sk", (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch);
      expect(r).toMatchObject({ ok: false, detail: expect.stringMatching(/could not reach/) });
    });
  });

  it("the shipped registry's live test models are priced, so a budget can always be enforced", () => {
    const reg = ModelRegistry.fromFile("config/ai-models.json");
    const pricing = PricingTable.fromFile("config/ai-pricing.json");
    for (const [p, m] of [["openai", "gpt-6-luna"], ["openai", "gpt-5.5"], ["anthropic", "claude-haiku-5-5"]] as const) {
      expect(reg.find(p, m)?.enabled).toBe(true);
      expect(pricing.has(p, m)).toBe(true);
    }
  });
});

void MockAiProvider;
void BRIEF_OK;

/* ================================= failed and cut-off requests: cost is counted, received output is scored */
describe("failure accounting in the live harness", () => {
  const price = new PricingTable("USD", [{ provider: "fake", model: "m", inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 1_000_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com" }]);
  const c = byId("plumbing-multi-differentiators");
  const mk = (respond: () => ProviderResult | AiError, reserve = 1500) => {
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async () => { const o = respond(); if (o instanceof AiError) throw o; return o; },
    };
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, maxRetries: 0, sleep: async () => {} });
    return makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: "current", budgetMicros: 1_000_000, maxOutputTokens: 1000, reserveMicros: reserve });
  };

  it("a cut-off request with reported usage is priced from that usage and counted as spend", async () => {
    const live = mk(() => new AiError("invalid_output", "cut off", { truncated: true, usage: { inputTokens: 1000, outputTokens: 1000, source: "provider" } }));
    const out = await live.generate(c);
    expect(out).toMatchObject({ truncated: true, meta: { inputTokens: 1000, outputTokens: 1000, costMicros: 2000 } });
    expect(out.meta?.costNote).toBeUndefined();
    expect(live.spent()).toBe(2000);
    const r = await runEvaluation([c], async () => out, "t", "fake");
    expect(r.cases[0]).toMatchObject({ generated: false, failure: "truncated", schemaValid: false, qualityPassed: false });
    expect(renderMarkdown(r)).toMatch(/cut off at the token limit; billed/);
  });

  it("a failed request with NO reported usage is charged at the worst-case reserve, never treated as free", async () => {
    const live = mk(() => new AiError("invalid_output", "cut off", { truncated: true }), 1500);
    const out = await live.generate(c);
    expect(out.meta?.costMicros).toBe(1500);
    expect(out.meta?.costNote).toMatch(/charged at the worst-case reserve/);
    expect(live.spent()).toBe(1500);
  });

  it("output that fails validation is still SCORED: schema failure and quality are reported separately", async () => {
    const long = { ...buildMockBrief(c.brain), primaryTexts: ["x".repeat(138), (buildMockBrief(c.brain) as { primaryTexts: string[] }).primaryTexts[1] as string] };
    const live = mk(() => ({ raw: long, model: "m", simulated: false, usage: { inputTokens: 1000, outputTokens: 500, source: "provider" } }));
    const out = await live.generate(c);
    expect(out.raw).toBeDefined();
    expect(out.schemaError).toMatch(/invalid_output/);
    const r = (await runEvaluation([c], async () => out, "t", "fake")).cases[0]!;
    expect(r.generated).toBe(true);
    expect(r.schemaValid).toBe(false);
    expect(r.scores.schemaValidity).toBe(0);
    expect(r.checks.find((k) => k.dimension === "schemaValidity")?.detail).toMatch(/clamped to the limit/);
    expect(r.scores.budgetPolicy).toBe(1); // quality dimensions were evaluated
    expect(r.qualityPassed).toBe(true);
    expect(r.passed).toBe(false);
    expect(live.spent()).toBe(1500);
  });

  it("an over-long field cannot hide an unsupported claim that sits inside the limit", async () => {
    const base = buildMockBrief(c.brain);
    const bad = { ...base, primaryTexts: ["Award-winning plumbers. " + "x".repeat(150), (base as { primaryTexts: string[] }).primaryTexts[1] as string] };
    const r = evaluateBrief(bad, c);
    expect(r.generated).toBe(true);
    expect(r.hardFail).toBe(true);
    expect(r.schemaValid).toBe(false);
  });

  it("structurally broken output (not just too long) is still a failed generation", () => {
    const r = evaluateBrief({ ...buildMockBrief(c.brain), headlines: "not a list" }, c);
    expect(r.generated).toBe(false);
  });

  it("the gateway returns the model's last output on a validation failure, and drops it when a later attempt was cut off", async () => {
    const mkGw = (steps: Array<ProviderResult | AiError>, repair: number) => {
      const p: AiProvider = {
        id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
        generateText: async () => ({ text: "x", model: "m", simulated: false }),
        generateObject: async () => { const o = steps.shift() as ProviderResult | AiError; if (o instanceof AiError) throw o; return o; },
      };
      return new AiGateway([p], { pricing: price, repairAttempts: repair as 0 | 1, maxRetries: 0, sleep: async () => {} });
    };
    const req = (): GenerateObjectRequest<unknown> => ({ task: "campaign_brief", system: "s", prompt: "p", schemaHint: "{}", context: c.brain, schema: CampaignBriefSchema, model: "m" });
    const usage = { inputTokens: 10, outputTokens: 10, source: "provider" as const };
    const bad = { ...buildMockBrief(c.brain), dailyBudgetCents: -5 };
    const e1 = (await mkGw([{ raw: bad, model: "m", simulated: false, usage }], 0).generate("fake", req()).catch((e) => e)) as AiError;
    expect(e1.rawOutput).toEqual(bad);
    expect(e1.attempts[0]?.usage).toEqual(usage);
    const e2 = (await mkGw([{ raw: bad, model: "m", simulated: false, usage }, new AiError("invalid_output", "cut off", { truncated: true, usage })], 1).generate("fake", req()).catch((e) => e)) as AiError;
    expect(e2.truncated).toBe(true);
    expect(e2.rawOutput).toBeUndefined(); // the earlier output belongs to a different attempt
    expect(e2.attempts.map((a) => a.usage?.outputTokens)).toEqual([10, 10]);
    expect(e2.attempts.every((a) => a.estimatedCostMicros === 20)).toBe(true);
  });
});
