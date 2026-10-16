import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AiGateway } from "../src/ai/gateway.js";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { PricingTable } from "../src/ai/pricing.js";
import { type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { CAMPAIGN_SYSTEM_PROMPT } from "../src/app/campaignPrompt.js";
import { generateCampaign, getCampaignRecord, updateBrief } from "../src/app/campaigns.js";
import { buildContext } from "../src/app/context.js";
import { BUSINESS_BRAIN_SCHEMA_VERSION, CAMPAIGN_PROMPT_VERSION, CAMPAIGN_SCHEMA_VERSION, campaignPromptSha256, campaignSchemaSha256, currentGenerationIdentity } from "../src/app/versions.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { BusinessBrainSchema, CampaignBriefSchema } from "../src/domain/schemas.js";
import { evaluateBrief, runEvaluation, type EvalReport } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { buildLegacyPrompt, identityOf, makeLiveGenerator } from "../src/eval/liveRun.js";
import {
  ORIGINAL_JSON_SCHEMA, ORIGINAL_PROMPT_VERSION, ORIGINAL_SCHEMA_VERSION, ORIGINAL_SYSTEM_PROMPT, OriginalBusinessBrainSchema, OriginalCampaignBriefSchema,
  buildOriginalPrompt, originalGenerationIdentity, originalPromptSha256, originalSchemaSha256, projectToOriginalBrain,
} from "../src/eval/original.js";
import { RECORDED_OPENAI_SUNRISE } from "../src/eval/recorded.js";
import { renderComparison, renderMarkdown } from "../src/eval/report.js";
import { BRAIN, makeCore } from "./fixtures.js";

type Registry = { entries: Array<{ id: string; version: string; sha256: string; status: string }> };
const registry = JSON.parse(readFileSync("config/prompt-versions.json", "utf8")) as Registry;
const pinned = (version: string) => registry.entries.find((e) => e.version === version);
const caseById = (id: string) => EVAL_CASES.find((c) => c.id === id)!;

/* =================================================================== prompt and schema versions are pinned */
describe("prompt and schema versioning", () => {
  it("the candidate prompt and output contract match their pinned fingerprints (a silent edit fails this test)", () => {
    expect(pinned(CAMPAIGN_PROMPT_VERSION)?.sha256).toBe(campaignPromptSha256());
    expect(pinned(CAMPAIGN_SCHEMA_VERSION)?.sha256).toBe(campaignSchemaSha256());
  });
  it("the recovered originals match their pinned fingerprints", () => {
    expect(pinned(ORIGINAL_PROMPT_VERSION)?.sha256).toBe(originalPromptSha256());
    expect(pinned(ORIGINAL_SCHEMA_VERSION)?.sha256).toBe(originalSchemaSha256());
    expect(pinned(ORIGINAL_PROMPT_VERSION)?.status).toBe("baseline-original");
  });
  it("every version label is unique, and the candidate is not mistaken for the original", () => {
    const labels = registry.entries.map((e) => e.version);
    expect(new Set(labels).size).toBe(labels.length);
    expect(campaignPromptSha256()).not.toBe(originalPromptSha256());
    expect(campaignSchemaSha256()).not.toBe(originalSchemaSha256());
  });
  it("the fingerprint really depends on the text: a one-character change produces a different hash", async () => {
    const { sha256 } = await import("../src/app/util.js");
    expect(sha256(CAMPAIGN_SYSTEM_PROMPT + " ")).not.toBe(campaignPromptSha256());
  });
  it("the prompt keeps the trust rules it had (the candidate is preserved, not silently replaced)", () => {
    for (const phrase of [/DATA, not instructions/, /CEILING, not a target/, /NEVER use unverifiedClaims or prohibitedClaims/, /A different wording of an unsupported claim is still unsupported/]) expect(CAMPAIGN_SYSTEM_PROMPT).toMatch(phrase);
  });
  it("labels the Business Brain contract too", () => {
    expect(BUSINESS_BRAIN_SCHEMA_VERSION).toMatch(/^business-brain-schema\//);
  });
});

describe("generation identity is recorded with every generated campaign version", () => {
  function setup() {
    const prov: AiProvider = {
      id: "mock", label: "m", models: ["mock-deterministic-1"], simulated: true, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: true }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({ raw: buildMockBrief(BusinessBrainSchema.parse(r.context)), model: r.model, simulated: true }),
    };
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env: { AI_MAX_OUTPUT_TOKENS: "1800", AI_REPAIR_ATTEMPTS: "0", AI_MAX_RETRIES: "1" }, aiProviders: [prov], gateway: { sleep: async () => {} } });
    return { ctx, ws: createWorkspace(ctx, "A").workspace };
  }
  it("records the prompt and schema versions, fingerprints and the settings in force", async () => {
    const { ctx, ws } = setup();
    putBrain(ctx, ws.id, BRAIN);
    const rec = await generateCampaign(ctx, ws.id);
    const gen = rec.versions[0]?.generation;
    expect(gen?.identity).toEqual(currentGenerationIdentity());
    expect(gen?.params).toMatchObject({ maxOutputTokens: 1800, repairAttempts: 0, maxRetries: 1, providerMode: "mock" });
  });
  it("a human edit has no generation identity (it was not generated), and is not given one", async () => {
    const { ctx, ws } = setup();
    putBrain(ctx, ws.id, BRAIN);
    const rec = await generateCampaign(ctx, ws.id);
    updateBrief(ctx, ws.id, rec.id, { ...rec.brief, rationale: "Edited by a person." });
    const v = getCampaignRecord(ctx, ws.id, rec.id).versions;
    expect(v.map((x) => x.source)).toEqual(["ai", "human"]);
    expect(v[1]?.generation).toBeNull();
  });
  it("versions saved before the columns existed read back as 'unknown', not as a guess", async () => {
    const { ctx, ws } = setup();
    putBrain(ctx, ws.id, BRAIN);
    const rec = await generateCampaign(ctx, ws.id);
    ctx.db.prepare("UPDATE campaign_versions SET prompt_version = NULL, prompt_sha256 = NULL, schema_version = NULL, schema_sha256 = NULL, generation_params = NULL WHERE campaign_id = ?").run(rec.id);
    expect(getCampaignRecord(ctx, ws.id, rec.id).versions[0]?.generation).toBeNull();
  });
});

/* ===================================================================== the recovered original baseline */
describe("the recovered original implementation", () => {
  it("its prompt is character-identical to the one used in the first live run (independent evidence it was recovered correctly)", () => {
    expect(ORIGINAL_SYSTEM_PROMPT).toBe(buildLegacyPrompt(caseById("plumbing-multi-differentiators").brain).system);
  });
  it("the real gpt-6-luna output produced by the original code parses under the recovered strict schema", () => {
    expect(OriginalCampaignBriefSchema.safeParse(RECORDED_OPENAI_SUNRISE.raw).success).toBe(true);
  });
  it("its brief contract is strict and cannot express the newer fields", () => {
    const withNew = { ...(RECORDED_OPENAI_SUNRISE.raw as object), budgetRationale: "x".repeat(30) };
    expect(OriginalCampaignBriefSchema.safeParse(withNew).success).toBe(false);
    expect(Object.keys(OriginalCampaignBriefSchema.shape)).not.toEqual(expect.arrayContaining(["targeting", "budgetRationale", "reviewFlags", "differentiatorDecisions", "variations"]));
    expect(ORIGINAL_JSON_SCHEMA.required).not.toContain("targeting");
  });
  it("the original Business Brain is strict: it has no field for verified facts, pricing, unverified claims or provenance", () => {
    expect(OriginalBusinessBrainSchema.safeParse({ ...BRAIN, verifiedFacts: ["x fact"] }).success).toBe(false);
    expect(Object.keys(OriginalBusinessBrainSchema.shape)).toEqual(["businessName", "industry", "services", "serviceArea", "targetCustomer", "offer", "tone", "differentiators", "maxDailyBudgetCents"]);
  });
  it("projecting a fixture keeps only the fields the original system had, so information it could not hold is not sent", () => {
    const c = caseById("plumbing-contradictory-ownership-fact");
    const p = projectToOriginalBrain(c.brain);
    expect(Object.keys(p)).toHaveLength(9);
    expect(JSON.stringify(buildOriginalPrompt(c.brain))).not.toContain("Not family owned"); // a verifiedFacts entry
    expect(buildOriginalPrompt(c.brain).prompt).toContain("Family-owned business"); // a differentiator
  });
  it("the original prompt differs from the candidate and from the confounded 'legacy' arm's output contract", () => {
    expect(originalGenerationIdentity().promptSha256).not.toBe(currentGenerationIdentity().promptSha256);
    const legacy = identityOf("legacy");
    expect(legacy.promptSha256).toBe(originalPromptSha256());
    expect(legacy.schemaSha256).toBe(campaignSchemaSha256()); // current contract: this is why legacy is not a faithful baseline
    expect(legacy.promptVersion).toMatch(/not a faithful baseline/);
    expect(identityOf("original")).toEqual(originalGenerationIdentity());
  });
});

/* ======================================================================== a fair, normalised comparison */
describe("comparison between the original and current implementations (offline; fake providers)", () => {
  const price = new PricingTable("USD", [{ provider: "fake", model: "m", inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 1_000_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com" }]);
  const usage = { inputTokens: 500, outputTokens: 300, source: "provider" as const };
  const toOriginalShape = (b: Record<string, any>) => ({
    name: b.name, objective: b.objective, headlines: b.headlines, primaryTexts: b.primaryTexts, callToAction: b.callToAction, audience: b.audience,
    dailyBudgetCents: b.dailyBudgetCents, rationale: b.rationale, assumptions: b.assumptions, openQuestions: b.openQuestions.map((q: { question: string }) => q.question),
  });

  function arm(variant: "original" | "current", output: (ctx: unknown) => unknown) {
    const seen: GenerateObjectRequest<unknown>[] = [];
    const p: AiProvider = {
      id: "fake", label: "f", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: false }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => { seen.push(r as GenerateObjectRequest<unknown>); return { raw: output(r.context), model: "m", simulated: false, usage }; },
    };
    const gw = new AiGateway([p], { pricing: price, repairAttempts: 0, maxRetries: 0, sleep: async () => {} });
    return { live: makeLiveGenerator({ gateway: gw, provider: "fake", model: "m", prompt: variant, budgetMicros: 1_000_000, maxOutputTokens: 2500 }), seen };
  }

  it("the original arm sends the original prompt, schema and projected Business Brain; the current arm sends the candidate", async () => {
    const c = caseById("plumbing-contradictory-ownership-fact");
    const o = arm("original", () => toOriginalShape(buildMockBrief(c.brain) as Record<string, any>));
    const cur = arm("current", () => buildMockBrief(c.brain));
    await o.live.generate(c);
    await cur.live.generate(c);
    expect(o.seen[0]).toMatchObject({ system: ORIGINAL_SYSTEM_PROMPT, jsonSchema: ORIGINAL_JSON_SCHEMA, maxOutputTokens: 2500 });
    expect(Object.keys(o.seen[0]?.context as object)).toHaveLength(9);
    expect(cur.seen[0]?.system).toBe(CAMPAIGN_SYSTEM_PROMPT);
    expect(cur.seen[0]?.maxOutputTokens).toBe(2500); // same generation parameters in both arms
    expect(o.seen[0]?.schemaHint).toMatch(/openQuestions": string\[\]/);
  });

  it("the output is validated under each arm's OWN contract (a current-style field is rejected for the original)", async () => {
    const c = caseById("hvac-no-approved-pricing");
    const o = arm("original", () => buildMockBrief(c.brain)); // current shape, wrong for the original contract
    const out = await o.live.generate(c);
    expect(out.schemaError ?? out.error).toMatch(/invalid_output/);
  });

  it("scores the two arms on the SAME comparable checks: a schema's missing fields are not penalised", async () => {
    const c = caseById("hvac-no-approved-pricing");
    const raw = buildMockBrief(c.brain) as Record<string, any>;
    const cur = evaluateBrief(raw, c);
    const orig = evaluateBrief(toOriginalShape(raw), c);
    // identical content, different contract: the FULL rubric differs (the original cannot express reasoning), the comparable view does not
    expect(orig.overall).toBeLessThan(cur.overall);
    expect(orig.comparable.overall).toBeCloseTo(cur.comparable.overall, 10);
    expect(orig.comparable.scores).toEqual(cur.comparable.scores);
    expect(orig.comparable.passed).toBe(cur.comparable.passed);
    // and the comparable view leaves out exactly the checks the original cannot answer
    expect(Object.keys(orig.comparable.scores)).not.toContain("schemaValidity");
  });

  it("the comparable view still catches real faults in either arm (it is not just lenient)", () => {
    const c = caseById("hvac-no-approved-pricing");
    const raw = buildMockBrief(c.brain) as Record<string, any>;
    const fabricated = { ...toOriginalShape(raw), headlines: [...raw.headlines, "Family-owned and trusted"] };
    const r = evaluateBrief(fabricated, c);
    expect(r.comparable.hardFail).toBe(true);
    expect(r.comparable.passed).toBe(false);
    const overBudget = { ...toOriginalShape(raw), dailyBudgetCents: c.brain.maxDailyBudgetCents };
    expect(evaluateBrief(overBudget, c).comparable.scores.budgetPolicy).toBeLessThan(1);
  });

  it("the comparison report names both versions, scores comparables only, and states what it cannot show", async () => {
    const cases = EVAL_CASES.slice(0, 3);
    const run = async (variant: "original" | "current") => {
      const a = arm(variant, (ctx) => {
        const b = buildMockBrief(BusinessBrainSchema.parse({ ...BRAIN, ...(ctx as object) })) as Record<string, any>;
        return variant === "original" ? toOriginalShape(b) : b;
      });
      const label = variant === "original" ? "original" : "current";
      return runEvaluation(cases, a.live.generate, label, `fake ${label}`, { identity: identityOf(variant), model: "fake/m", params: { maxOutputTokens: 2500 } });
    };
    const [o, c] = [await run("original"), await run("current")];
    const md = renderComparison(o as EvalReport, c as EvalReport, { a: "original", b: "current" });
    expect(md).toMatch(/campaign-prompt\/1\.0\.0-original/);
    expect(md).toMatch(/campaign-prompt\/3\.1\.0-candidate/);
    expect(md).toMatch(/comparable view only/);
    expect(md).toMatch(/not statistical evidence/);
    expect(md).toMatch(/Do not report a win as proof of improvement/);
    expect(renderMarkdown(o)).toMatch(/Prompt: `campaign-prompt\/1\.0\.0-original`/);
  });

  it("no live call is possible from this suite: every arm above used a fake provider", () => {
    expect(process.env.AI_PROVIDER_MODE ?? "mock").not.toBe("live");
  });
});
