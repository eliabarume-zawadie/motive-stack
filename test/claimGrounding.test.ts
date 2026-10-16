import { describe, expect, it } from "vitest";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { generateCampaign, updateBrief } from "../src/app/campaigns.js";
import { buildContext } from "../src/app/context.js";
import { createProposal, decideProposal, getProposalRow } from "../src/app/proposals.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { approvalGateViolations, briefRuleViolations, groundingIssues } from "../src/domain/briefRules.js";
import { BusinessBrainSchema, CampaignBriefSchema, type BusinessBrain } from "../src/domain/schemas.js";
import { BRAIN, makeCore } from "./fixtures.js";

const brain = (over: object = {}): BusinessBrain => BusinessBrainSchema.parse({ ...BRAIN, ...over });
type Brief = Record<string, any>;
const base = (b: BusinessBrain = brain()): Brief => buildMockBrief(b) as Brief;
const withHeadline = (b: BusinessBrain, h: string): Brief => ({ ...base(b), headlines: [...base(b).headlines, h] });
const gate = (raw: Brief, b: BusinessBrain) => approvalGateViolations(CampaignBriefSchema.parse(raw), b);
const ownership = (copy: string, b: BusinessBrain) => groundingIssues([copy], b).filter((i) => i.code === "ownership" || i.code === "experience");

/* ================================================================== unsupported ownership claims */
describe("unsupported ownership, history and size claims", () => {
  const plain = brain();
  it("'family-owned' is rejected when no owner-approved fact supports it", () => {
    expect(ownership("Family-owned plumbers", plain)).not.toHaveLength(0);
    expect(gate(withHeadline(plain, "Family-owned and trusted"), plain).map((v) => v.code)).toContain("grounding_ownership");
  });

  it.each([
    "Family owned business",
    "A family-run company",
    "Proudly family operated",
    "Run by a local family",
    "Owned by our family",
    "Our family serving yours",
    "Third-generation plumbers",
    "Serving families for generations",
    "Locally owned and operated",
    "Owner-operated, locally based",
    "Veteran-owned service",
    "Woman owned business",
    "Your neighborhood small business",
    "Founded by a local family",
    "Mom-and-pop prices",
    "Trusted in Austin for years",
    "Serving Austin since 1998",
    "Established 2004",
    "For over a decade",
  ])("the same kind of claim worded differently is rejected: %s", (text) => {
    expect(ownership(text, plain).length, text).toBeGreaterThan(0);
  });

  it("is accepted when an owner-approved fact supports it, whatever the hyphenation or wording", () => {
    for (const fact of [{ verifiedFacts: ["Family owned and operated"] }, { differentiators: ["Family-owned business"] }, { verifiedFacts: ["Family-run since the start"] }]) {
      const b = brain(fact);
      for (const copy of ["Family-owned plumbers", "A family-run company", "Family owned business"]) expect(ownership(copy, b), `${JSON.stringify(fact)} / ${copy}`).toHaveLength(0);
    }
  });

  it("support is specific: a family-owned fact does not support a multi-generation, veteran or 'since 1998' claim", () => {
    const b = brain({ verifiedFacts: ["Family owned and operated"] });
    for (const copy of ["Third-generation plumbers", "Veteran-owned service", "Serving Austin since 1998", "Over 20 years of experience"]) expect(ownership(copy, b).length, copy).toBeGreaterThan(0);
  });

  it("the business NAME is not support: 'Smith Family Plumbing' does not make 'family-owned' true", () => {
    const b = brain({ businessName: "Smith Family Plumbing" });
    expect(ownership("Family-owned plumbers", b)).not.toHaveLength(0);
    expect(ownership("Smith Family Plumbing, Austin", b)).toHaveLength(0); // using the name itself is fine
  });

  it("the untrusted description and the owner's UNVERIFIED claims never count as support", () => {
    const b = brain({ description: "We are a proud family-owned business", unverifiedClaims: ["Family-owned since 1985"] });
    expect(ownership("Family-owned plumbers", b)).not.toHaveLength(0);
  });
});

/* ========================================================================= other unsupported claims */
describe("unsupported license, testimonial, price and guarantee claims, at the brief level", () => {
  const plain = brain({ differentiators: ["Upfront written estimates"], verifiedFacts: [], approvedPricing: undefined });
  it.each([
    ["a license", "Licensed master plumbers", "grounding_credential"],
    ["a testimonial", "Customers say we're the best", "grounding_social_proof"],
    ["a review claim", "Read our five-star reviews", "grounding_award_rating"],
    ["a price", "Drain cleaning from $49", "grounding_price"],
    ["a guarantee", "100% satisfaction guaranteed", "grounding_guarantee"],
    ["a warranty", "Lifetime warranty on repairs", "grounding_guarantee"],
  ])("%s is rejected", (_n, text, code) => {
    expect(gate(withHeadline(plain, text.slice(0, 40)), plain).map((v) => v.code)).toContain(code);
  });
  it("each is accepted when the owner approved it", () => {
    const b = brain({ differentiators: ["Upfront written estimates", "Licensed and insured"], verifiedFacts: ["Lifetime warranty on repairs", "100% satisfaction guaranteed"], approvedPricing: "Drain cleaning from $49" });
    for (const t of ["Licensed plumbers", "Drain cleaning from $49", "Lifetime warranty on repairs"]) expect(gate(withHeadline(b, t), b).map((v) => v.code), t).not.toContain("grounding_credential");
    expect(groundingIssues(["Drain cleaning from $49", "Lifetime warranty on repairs", "Licensed and insured"], b)).toEqual([]);
  });
});

describe("supplied differentiators", () => {
  it("are used legitimately: copy built from them is not a violation", () => {
    const b = brain({ differentiators: ["24/7 availability", "Licensed and insured"] });
    const raw = base(b);
    expect(gate(raw, b)).toEqual([]);
    expect(raw.differentiatorDecisions.map((d: { differentiator: string }) => d.differentiator)).toEqual(expect.arrayContaining(["24/7 availability", "Licensed and insured"]));
    expect(briefRuleViolations(CampaignBriefSchema.parse(raw), b)).toEqual([]);
  });
  it("one that is held back needs a recorded reason", () => {
    const b = brain({ differentiators: ["24/7 availability", "Licensed and insured"] });
    const raw = base(b);
    raw.differentiatorDecisions = raw.differentiatorDecisions.map((d: any) => (d.differentiator === "24/7 availability" ? { ...d, used: false, reason: "" } : d));
    expect(briefRuleViolations(CampaignBriefSchema.parse(raw), b).map((v) => v.code)).toContain("differentiator_reason_missing");
  });
});

/* ===================================================================================== length limits */
describe("platform length limits, per field", () => {
  const b = brain();
  const longHeadline = "H".repeat(41);
  const longText = "T".repeat(126);

  it("a headline or primary text over its limit names the field, the size and the limit", () => {
    const raw = { ...base(b), headlines: [...base(b).headlines.slice(0, 1), longHeadline], primaryTexts: [longText, ...base(b).primaryTexts.slice(1)] };
    const parsed = CampaignBriefSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    const where = (parsed.success ? [] : parsed.error.issues).map((i) => i.path.join("."));
    expect(where).toEqual(expect.arrayContaining(["headlines.1", "primaryTexts.0"]));
  });

  it("the rule layer reports it too (for briefs that bypass the schema), as 'length_*' with field, size and limit", () => {
    // Build the brief without parsing so the schema cannot be what rejects it.
    const ok = CampaignBriefSchema.parse(base(b));
    const over = { ...ok, headlines: [...ok.headlines, longHeadline], primaryTexts: [longText, ...ok.primaryTexts.slice(1)] };
    const v = briefRuleViolations(over, b).filter((x) => x.code.startsWith("length_"));
    expect(v.map((x) => x.code).sort()).toEqual(["length_headline", "length_primary_text"]);
    expect(v.find((x) => x.code === "length_headline")).toMatchObject({ path: ["headlines", ok.headlines.length], message: expect.stringMatching(/41 characters; the limit is 40/) });
    expect(v.find((x) => x.code === "length_primary_text")).toMatchObject({ path: ["primaryTexts", 0], message: expect.stringMatching(/126 characters; the limit is 125/) });
  });

  it("text exactly at the limit passes; one character over fails", () => {
    const at = { ...base(b), headlines: [...base(b).headlines, "H".repeat(40)], primaryTexts: ["Austin plumbing. " + "x".repeat(108), ...base(b).primaryTexts.slice(1)] };
    expect(at.primaryTexts[0]).toHaveLength(125);
    expect(CampaignBriefSchema.safeParse(at).success).toBe(true);
    expect(CampaignBriefSchema.safeParse({ ...at, headlines: [...base(b).headlines, "H".repeat(41)] }).success).toBe(false);
  });

  it("text is never shortened to pass: the stored brief keeps exactly what was written", () => {
    const ok = CampaignBriefSchema.parse(base(b));
    expect(ok.headlines.every((h) => h.length <= 40)).toBe(true);
    expect(JSON.stringify(ok.headlines)).toBe(JSON.stringify(base(b).headlines));
  });
});

/* ============================================================ repair, revalidation and blocked approval */
describe("controlled repair and the approval gate (offline, scripted provider)", () => {
  function app(steps: unknown[], env: Record<string, string> = {}) {
    const calls: string[] = [];
    const prov: AiProvider = {
      id: "mock", label: "scripted", models: ["mock-deterministic-1"], simulated: true, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: true }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => { calls.push(r.prompt); return { raw: steps.shift() ?? steps[0], model: r.model, simulated: true, usage: { inputTokens: 10, outputTokens: 10, source: "simulated" } }; },
    };
    const core = makeCore();
    const ctx = buildContext({ db: core.db, now: core.now, env, aiProviders: [prov], gateway: { sleep: async () => {} } });
    const ws = createWorkspace(ctx, "Acme").workspace;
    return { ctx, ws, calls, core };
  }
  const bad = () => withHeadline(brain(), "Family-owned and trusted");
  const good = () => base(brain());
  const count = (ctx: { db: any }, table: string) => (ctx.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  const kinds = (ctx: { db: any }) => (ctx.db.prepare("SELECT attempt_kind k, outcome o FROM ai_usage ORDER BY attempt_no").all() as Array<{ k: string; o: string }>);

  it("a first attempt with an unsupported claim is repaired ONCE, the repair is revalidated, and both attempts are recorded", async () => {
    const { ctx, ws, calls } = app([bad(), good()]);
    putBrain(ctx, ws.id, brain());
    const rec = await generateCampaign(ctx, ws.id);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/\[grounding_ownership\]/); // the repair was told which rule failed
    expect(calls[1]).toMatch(/ownership, founding or company-size claim/);
    expect(kinds(ctx).map((x) => x.k)).toEqual(["initial", "repair"]);
    expect(kinds(ctx)[0]?.o).toBe("invalid_output");
    expect(rec.brief.headlines.join(" ")).not.toMatch(/family/i);
  });

  it("a repair that STILL contains the claim is not accepted: generation fails, nothing is stored", async () => {
    const { ctx, ws, calls } = app([bad(), bad()]);
    putBrain(ctx, ws.id, brain());
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(calls).toHaveLength(2); // one repair at most
    expect(kinds(ctx).map((x) => x.k)).toEqual(["initial", "repair"]);
    expect(count(ctx, "campaigns")).toBe(0);
    expect(count(ctx, "action_proposals")).toBe(0);
  });

  it("an over-length repair is rejected too (length is revalidated, not trimmed)", async () => {
    const tooLong = { ...good(), primaryTexts: ["T".repeat(126), ...good().primaryTexts.slice(1)] };
    const { ctx, ws } = app([tooLong, tooLong]);
    putBrain(ctx, ws.id, brain());
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output", message: expect.stringMatching(/primaryTexts\.0.*126 characters/) });
    expect(count(ctx, "campaigns")).toBe(0);
  });

  it("repair can be disabled: exactly one request, then a validation error", async () => {
    const { ctx, ws, calls } = app([bad(), good()], { AI_REPAIR_ATTEMPTS: "0" });
    putBrain(ctx, ws.id, brain());
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output" });
    expect(calls).toHaveLength(1);
    expect(kinds(ctx).map((x) => x.k)).toEqual(["initial"]);
  });

  it("after a failed validation nothing external happens: no proposal, no job, no simulated Meta or CRM write", async () => {
    const { ctx, ws } = app([bad(), bad()]);
    putBrain(ctx, ws.id, brain());
    await expect(generateCampaign(ctx, ws.id)).rejects.toBeDefined();
    for (const t of ["campaigns", "action_proposals", "approvals", "jobs", "sim_meta_campaigns", "sim_crm_contacts"]) expect(count(ctx, t), t).toBe(0);
  });

  it("a person editing a good brief into one with an unsupported claim cannot get it proposed", async () => {
    const { ctx, ws } = app([good()]);
    putBrain(ctx, ws.id, brain());
    const rec = await generateCampaign(ctx, ws.id);
    const edited = { ...rec.brief, headlines: [...rec.brief.headlines, "Family-owned and trusted"] };
    updateBrief(ctx, ws.id, rec.id, edited);
    expect(() => createProposal(ctx, ws.id, rec.id)).toThrow(/\[grounding_ownership\] copy: uses ownership, founding or company-size claim \("Family-owned"\)/);
    expect(count(ctx, "action_proposals")).toBe(0);
    expect(count(ctx, "sim_meta_campaigns")).toBe(0);
  });

  it("an over-length human edit cannot get through either; the error names the field", async () => {
    const { ctx, ws } = app([good()]);
    putBrain(ctx, ws.id, brain());
    const rec = await generateCampaign(ctx, ws.id);
    // The schema blocks the edit itself, so nothing over the limit can even be saved.
    expect(() => updateBrief(ctx, ws.id, rec.id, { ...rec.brief, primaryTexts: ["T".repeat(126)] })).toThrow();
  });

  it("the same brief with the claim SUPPORTED by an owner fact is proposed normally, and still needs a human approval", async () => {
    const supported = brain({ verifiedFacts: ["Family owned and operated"] });
    const { ctx, ws, core } = app([base(supported)]);
    putBrain(ctx, ws.id, supported);
    const rec = await generateCampaign(ctx, ws.id);
    updateBrief(ctx, ws.id, rec.id, { ...rec.brief, headlines: [...rec.brief.headlines, "Family-owned and trusted"] });
    ctx.db.prepare("UPDATE workspaces SET meta_account_id = 'act_123' WHERE id = ?").run(ws.id);
    void core;
    const p = createProposal(ctx, ws.id, rec.id);
    expect(p.status).toBe("proposed");
    expect(count(ctx, "sim_meta_campaigns")).toBe(0); // nothing happens until a person approves
  });

  it("the approval step re-checks: a stored brief that no longer passes cannot be approved", async () => {
    const { ctx, ws } = app([good()]);
    putBrain(ctx, ws.id, brain());
    const rec = await generateCampaign(ctx, ws.id);
    const p = createProposal(ctx, ws.id, rec.id);
    // Corrupt the stored version in place (the supported path never allows this; this proves the second gate exists).
    const row = ctx.db.prepare("SELECT brief FROM campaign_versions WHERE campaign_id = ?").get(rec.id) as { brief: string };
    const tampered = JSON.parse(row.brief);
    tampered.headlines.push("Family-owned and trusted");
    ctx.db.prepare("UPDATE campaign_versions SET brief = ? WHERE campaign_id = ?").run(JSON.stringify(tampered), rec.id);
    expect(() => decideProposal(ctx, ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/cannot be approved yet.*grounding_ownership/);
    expect(getProposalRow(ctx, ws.id, p.id).status).toBe("proposed");
    expect(count(ctx, "approvals")).toBe(0);
    expect(count(ctx, "jobs")).toBe(0);
    expect(count(ctx, "sim_meta_campaigns")).toBe(0);
  });
});
