import { describe, expect, it } from "vitest";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { type AiProvider, type GenerateObjectRequest, type ProviderResult } from "../src/ai/types.js";
import { buildCampaignPrompt } from "../src/app/campaignPrompt.js";
import { generateCampaign } from "../src/app/campaigns.js";
import { buildContext } from "../src/app/context.js";
import { createProposal, decideProposal } from "../src/app/proposals.js";
import { createWorkspace, putBrain } from "../src/app/workspaces.js";
import { approvalGateViolations, factIssues, groundingIssues, provenanceSummary } from "../src/domain/briefRules.js";
import { BusinessBrainSchema, CampaignBriefSchema, type BusinessBrain } from "../src/domain/schemas.js";
import { BRAIN, makeCore } from "./fixtures.js";

const NOW = new Date("2026-10-16T12:00:00Z");
const SERVICES = ["Drain cleaning", "AC repair", "Water heater repair"];
const brain = (over: object = {}): BusinessBrain =>
  BusinessBrainSchema.parse({ ...BRAIN, businessName: "Cedar Home Services", services: SERVICES, differentiators: [], verifiedFacts: [], offer: "Call for a visit", approvedPricing: undefined, ...over });
const rec = (text: string, extra: object = {}) => ({ text, status: "owner_approved", source: "owner_form", approvedForMarketing: true, approvedAt: "2026-09-01", approvedBy: "owner", ...extra });
const verdict = (b: BusinessBrain, claim: string, asOf: Date = NOW) => {
  const g = groundingIssues([claim], b, { asOf });
  return g.length ? g.map((x) => `${x.reason}:${x.code}`).join(",") : "supported";
};

/* ======================================================================================== service scope */
describe("a fact does not support a claim about a different service", () => {
  it("a price approved for plumbing cannot support an HVAC price claim (legacy wording that names the service)", () => {
    const b = brain({ approvedPricing: "Drain cleaning from $49" });
    expect(verdict(b, "Drain cleaning from $49")).toBe("supported");
    expect(verdict(b, "AC repair from $49")).toBe("out_of_scope:price");
    expect(verdict(b, "Water heater repair from $49")).toBe("out_of_scope:price");
  });

  it("the same with an explicit scope on a record", () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drain cleaning"] } })] });
    expect(verdict(b, "Drain cleaning from $49")).toBe("supported");
    expect(verdict(b, "AC repair from $49")).toBe("out_of_scope:price");
  });

  it("a price that is not tied to a service in the copy is out of scope for a service-limited fact (it cannot be told which service it means)", () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drain cleaning"] } })] });
    expect(verdict(b, "Plumbing and AC from $49")).toBe("out_of_scope:price");
    expect(verdict(b, "From $49")).toBe("out_of_scope:price");
  });

  it("each service can have its own approved price, and neither leaks into the other", () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drain cleaning"] } }), rec("Tune-ups from $89", { scope: { services: ["AC repair"] } })] });
    expect(verdict(b, "Drain cleaning from $49")).toBe("supported");
    expect(verdict(b, "AC repair tune-ups from $89")).toBe("supported");
    expect(verdict(b, "AC repair from $49")).toBe("out_of_scope:price");
    expect(verdict(b, "Drain cleaning tune-ups from $89")).toBe("out_of_scope:price");
  });

  it("an offer approved for one service does not automatically apply to every service", () => {
    const b = brain({ facts: [rec("Free inspection", { scope: { services: ["AC repair"] } })] });
    expect(verdict(b, "Free AC repair inspection")).toBe("supported");
    expect(verdict(b, "Free inspection")).toBe("out_of_scope:free");
    expect(verdict(b, "Free drain cleaning inspection")).toBe("out_of_scope:free");
    expect(verdict(b, "Free water heater repair inspection")).toBe("out_of_scope:free");
  });

  it("a short service name does not match a longer one that shares a word (\"AC repair\" is not \"Water heater repair\")", () => {
    const b = brain({ facts: [rec("Free inspection", { scope: { services: ["AC repair"] } })] });
    expect(verdict(b, "Free water heater repair inspection")).toBe("out_of_scope:free");
  });

  it("a business-wide fact still supports claims about any service (existing behaviour is preserved)", () => {
    const b = brain({ offer: "Free quote", verifiedFacts: ["Licensed and insured"] });
    for (const s of SERVICES) {
      expect(verdict(b, `${s} in Austin? Free quote`)).toBe("supported");
      expect(verdict(b, `Licensed and insured ${s}`)).toBe("supported");
    }
  });

  it("an unknown service name on a record never matches (fail closed, not open)", () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drian cleaning"] } })] });
    expect(verdict(b, "Drain cleaning from $49")).toBe("out_of_scope:price");
  });

  it("a fact keeps its scope across other claim kinds (a credential limited to gas work)", () => {
    const b = brain({ facts: [rec("Licensed", { scope: { services: ["Water heater repair"] } })] });
    expect(verdict(b, "Licensed water heater repair")).toBe("supported");
    expect(verdict(b, "Licensed drain cleaning")).toBe("out_of_scope:credential");
  });
});

/* =================================================================================== conditions */
describe("a fact approved under conditions cannot be claimed without them", () => {
  it("a guarantee approved for labor only", () => {
    const b = brain({ verifiedFacts: ["90 day workmanship guarantee, labor only"] });
    expect(verdict(b, "Workmanship guarantee, labor only")).toBe("supported");
    expect(verdict(b, "90 day workmanship guarantee")).toBe("missing_conditions:guarantee");
    expect(verdict(b, "Guaranteed workmanship on every job")).toBe("missing_conditions:guarantee");
  });

  it("a conditional offer", () => {
    const b = brain({ verifiedFacts: ["Free estimate when booked online"] });
    expect(verdict(b, "Free estimate if booked online")).toBe("supported");
    expect(verdict(b, "Free estimate")).toBe("missing_conditions:free");
  });

  it("explicit conditions on a record are required in the same text", () => {
    const b = brain({ facts: [rec("Lifetime warranty on parts", { scope: { conditions: ["first-time customers"] } })] });
    expect(verdict(b, "Lifetime warranty on parts for first-time customers")).toBe("supported");
    expect(verdict(b, "Lifetime warranty on parts")).toBe("missing_conditions:guarantee");
  });

  it("an unconditional fact is unaffected", () => {
    const b = brain({ verifiedFacts: ["Lifetime warranty on parts"] });
    expect(verdict(b, "Lifetime warranty on parts")).toBe("supported");
  });

  it("the error says which conditions are missing", () => {
    const b = brain({ verifiedFacts: ["90 day workmanship guarantee, labor only"] });
    expect(groundingIssues(["Workmanship guarantee"], b, { asOf: NOW })[0]?.against).toMatch(/"labor only"/);
  });

  it("scope and conditions together", () => {
    const b = brain({ facts: [rec("Free inspection", { scope: { services: ["AC repair"], conditions: ["weekdays only"] } })] });
    expect(verdict(b, "Free AC repair inspection on weekdays only")).toBe("supported");
    expect(verdict(b, "Free AC repair inspection")).toBe("missing_conditions:free");
    expect(verdict(b, "Free drain cleaning inspection on weekdays only")).toBe("out_of_scope:free");
  });
});

/* ===================================================================================== validity */
describe("expired, superseded and not-yet-valid facts cannot support current claims", () => {
  const price = (extra: object) => brain({ facts: [rec("Spring tune-up special: 20% off", extra)] });

  it("a fact past its validUntil supports nothing, and the reason names the date", () => {
    const b = price({ validUntil: "2026-09-30" });
    expect(verdict(b, "Spring tune-up special: 20% off")).toMatch(/^expired:price/);
    expect(groundingIssues(["20% off tune-ups"], b, { asOf: NOW })[0]?.against).toMatch(/expired on 2026-09-30/);
  });
  it("the same fact supports the claim while it is in force", () => {
    const b = price({ validFrom: "2026-09-01", validUntil: "2026-10-31" });
    expect(verdict(b, "Spring tune-up special: 20% off")).toBe("supported");
  });
  it("a date-only validUntil holds through that whole day, and not the next", () => {
    const b = price({ validUntil: "2026-10-16" });
    expect(verdict(b, "20% off tune-ups", new Date("2026-10-16T23:00:00Z"))).toBe("supported");
    expect(verdict(b, "20% off tune-ups", new Date("2026-10-17T00:30:00Z"))).toMatch(/^expired:price/);
  });
  it("a fact that is not yet valid supports nothing", () => {
    const b = price({ validFrom: "2026-11-01" });
    expect(verdict(b, "20% off tune-ups")).toMatch(/^expired:price/);
    expect(groundingIssues(["20% off tune-ups"], b, { asOf: NOW })[0]?.against).toMatch(/not valid until 2026-11-01/);
  });
  it("a superseded record supports nothing; its replacement does", () => {
    const b = brain({ facts: [rec("Inspection is $49", { id: "insp-old", supersededBy: "insp-new" }), rec("Inspection is $59", { id: "insp-new" })] });
    expect(verdict(b, "Inspection is $49")).toMatch(/^expired:price/);
    expect(groundingIssues(["Inspection is $49"], b, { asOf: NOW })[0]?.against).toMatch(/superseded by the record "insp-new"/);
    expect(verdict(b, "Inspection is $59")).toBe("supported");
  });
  it("a typo in supersededBy, duplicate ids, a self-reference or a reversed period are rejected when the Business Brain is saved", () => {
    const bad = (facts: object[]) => BusinessBrainSchema.safeParse({ ...BRAIN, facts }).success;
    expect(bad([rec("Inspection is $49", { id: "a", supersededBy: "missing" })])).toBe(false);
    expect(bad([rec("x fact", { id: "a" }), rec("y fact", { id: "a" })])).toBe(false);
    expect(bad([rec("x fact", { id: "a", supersededBy: "a" })])).toBe(false);
    expect(bad([rec("x fact", { validFrom: "2026-10-01", validUntil: "2026-09-01" })])).toBe(false);
    expect(bad([rec("x fact", { id: "a", supersededBy: "b" }), rec("y fact", { id: "b" })])).toBe(true);
  });
  it("validity is checked against the clock the app supplies (so results are reproducible)", () => {
    const b = price({ validUntil: "2026-10-20" });
    expect(verdict(b, "20% off tune-ups", new Date("2026-10-19T00:00:00Z"))).toBe("supported");
    expect(verdict(b, "20% off tune-ups", new Date("2026-10-21T00:00:00Z"))).toMatch(/^expired:price/);
  });
  it("an expired fact is not a conflict and does not keep blocking: it asserts nothing now", () => {
    const b = brain({ facts: [rec("Weekend appointments"), rec("Not available on weekends", { validUntil: "2026-09-01" })] });
    expect(factIssues(b, { asOf: NOW })).toEqual([]);
    expect(verdict(b, "Weekend appointments")).toBe("supported");
  });
  it("legacy fields have no dates, so they are always in force (documented limitation)", () => {
    expect(verdict(brain({ verifiedFacts: ["Spring special: 20% off"] }), "20% off tune-ups")).toBe("supported");
  });
});

/* ======================================================================== denials still fail closed */
describe("negative and conflicting facts continue to fail closed, now with scope", () => {
  it("a denial that covers the same ground contradicts the claim", () => {
    const b = brain({ verifiedFacts: ["Not family owned"] });
    expect(verdict(b, "Family-owned plumbers")).toBe("contradicted:ownership");
  });
  it("a service-limited denial does not block a claim that names a different service", () => {
    const b = brain({ verifiedFacts: ["24/7 availability"], facts: [rec("No 24/7 service for AC repair", { scope: { services: ["AC repair"] } })] });
    expect(verdict(b, "24/7 drain cleaning")).toBe("supported");
  });
  it("...but blocks the claim for that service, and a claim that names no service (it cannot be told which is meant)", () => {
    const b = brain({ verifiedFacts: ["24/7 availability"], facts: [rec("No 24/7 service for AC repair", { scope: { services: ["AC repair"] } })] });
    expect(verdict(b, "24/7 AC repair")).toBe("contradicted:availability");
    expect(verdict(b, "24/7 service")).toBe("contradicted:availability");
  });
  it("a business-wide statement conflicting with a scoped denial is a conflict; two different services are not", () => {
    const wide = brain({ verifiedFacts: ["24/7 availability"], facts: [rec("No 24/7 service for AC repair", { scope: { services: ["AC repair"] } })] });
    expect(factIssues(wide, { asOf: NOW }).map((i) => i.type)).toEqual(["conflict"]);
    const apart = brain({ facts: [rec("24/7 availability", { scope: { services: ["Drain cleaning"] } }), rec("No 24/7 service for AC repair", { scope: { services: ["AC repair"] } })] });
    expect(factIssues(apart, { asOf: NOW })).toEqual([]);
  });
  it("an ambiguous fact still blocks the matching claim whatever its scope", () => {
    const b = brain({ facts: [rec("License application pending", { scope: { services: ["Water heater repair"] } })] });
    expect(verdict(b, "Licensed water heater repair")).toBe("ambiguous:credential");
  });
  it("a fact the owner has not approved supports nothing, scoped or not", () => {
    const b = brain({ facts: [{ text: "From $49", status: "owner_provided", source: "owner_form", scope: { services: ["Drain cleaning"] } }] });
    expect(verdict(b, "Drain cleaning from $49")).toBe("unsupported:price");
  });
});

/* =========================================================================== a fact used in scope */
describe("a valid fact used within its actual scope remains usable", () => {
  it("scope, conditions and period all satisfied", () => {
    const b = brain({ facts: [rec("Free inspection", { scope: { services: ["AC repair"], conditions: ["weekdays only"] }, validFrom: "2026-10-01", validUntil: "2026-12-31" })] });
    expect(verdict(b, "Free AC repair inspection, weekdays only")).toBe("supported");
  });
  it("the reference brief and the gate accept a brief built from scoped facts", () => {
    const b = brain({ differentiators: ["Free AC repair inspection"], facts: [rec("Free inspection", { scope: { services: ["AC repair"] } })] });
    const brief = CampaignBriefSchema.parse(buildMockBrief(b));
    expect(approvalGateViolations(brief, b, { asOf: NOW })).toEqual([]);
  });
  it("owner approval of a scoped fact is still reported as owner approval, never independent verification", () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drain cleaning"] }, validUntil: "2026-12-31" })] });
    expect(provenanceSummary(b)).toMatchObject({ ownerApproved: 1, independentlyVerified: 0 });
    expect(BusinessBrainSchema.safeParse({ ...BRAIN, facts: [rec("From $49", { verification: { method: "Checked the price list", verifiedBy: "Owner", verifiedAt: "2026-10-01", evidence: [{ type: "note", ref: "x" }] } })] }).success).toBe(false);
  });
});

/* ====================================================== the prompt data and the pipeline use the scope */
describe("scope reaches the model and the approval gate", () => {
  const data = (b: BusinessBrain, asOf = NOW) => JSON.parse(buildCampaignPrompt(b, { asOf }).prompt.split("<business_brain>")[1]!.split("</business_brain>")[0]!.trim());

  it("the prompt data carries each approved record's services, conditions and period with its text", () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drain cleaning"], conditions: ["weekdays only"] }, validUntil: "2026-12-31" })] });
    expect(data(b).verifiedFacts).toEqual(["From $49 (applies only to: Drain cleaning; only under these conditions: weekdays only; valid until 2026-12-31)"]);
  });
  it("a record that has expired is passed as 'no longer in force' among the claims never to use", () => {
    const b = brain({ facts: [rec("Spring special: 20% off", { validUntil: "2026-09-30" })] });
    expect(data(b).verifiedFacts).toEqual([]);
    expect(data(b).unverifiedClaims).toEqual(["Spring special: 20% off (no longer in force)"]);
  });

  function app(steps: unknown[]) {
    const prov: AiProvider = {
      id: "mock", label: "scripted", models: ["mock-deterministic-1"], simulated: true, isAvailable: () => true,
      generateText: async () => ({ text: "x", model: "m", simulated: true }),
      generateObject: async <T,>(r: GenerateObjectRequest<T>): Promise<ProviderResult> => ({ raw: steps.shift() ?? steps[0], model: r.model, simulated: true }),
    };
    const core = makeCore("2026-10-16T12:00:00Z");
    const ctx = buildContext({ db: core.db, now: core.now, env: {}, aiProviders: [prov], gateway: { sleep: async () => {} } });
    return { ctx, core, ws: createWorkspace(ctx, "Acme").workspace };
  }
  const count = (ctx: { db: any }, t: string) => (ctx.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
  const withHeadline = (b: BusinessBrain, h: string) => ({ ...(buildMockBrief(b) as Record<string, any>), headlines: [...(buildMockBrief(b) as any).headlines, h] });

  it("generation rejects an out-of-scope claim and says what the fact covers", async () => {
    const b = brain({ facts: [rec("From $49", { scope: { services: ["Drain cleaning"] } })] });
    const bad = withHeadline(b, "AC repair from $49");
    const { ctx, ws } = app([bad, bad]);
    putBrain(ctx, ws.id, b);
    await expect(generateCampaign(ctx, ws.id)).rejects.toMatchObject({ kind: "invalid_output", message: expect.stringMatching(/applies only to Drain cleaning.*\[grounding_out_of_scope\]/) });
    expect(count(ctx, "campaigns")).toBe(0);
  });

  it("the approval gate uses the app clock: a fact that expires after the proposal blocks approval, and nothing is queued", async () => {
    const b = brain({ facts: [rec("Spring special: 20% off", { validUntil: "2026-10-20" })] });
    const { ctx, core, ws } = app([withHeadline(b, "Spring special: 20% off")]);
    putBrain(ctx, ws.id, b);
    const brief = await generateCampaign(ctx, ws.id);
    const p = createProposal(ctx, ws.id, brief.id); // 2026-10-16: still valid
    core.setNow("2026-10-25T12:00:00Z");
    expect(() => decideProposal(ctx, ws.id, p.id, "approve", { decidedBy: "elia" })).toThrow(/cannot be approved yet.*grounding_expired/);
    expect(count(ctx, "approvals")).toBe(0);
    expect(count(ctx, "jobs")).toBe(0);
    expect(count(ctx, "sim_meta_campaigns")).toBe(0);
  });

  it("a brief that states a conditional guarantee without its conditions cannot be proposed", async () => {
    const b = brain({ verifiedFacts: ["90 day workmanship guarantee, labor only"] });
    const good = withHeadline(b, "Workmanship guarantee, labor only");
    const { ctx, ws } = app([good]);
    putBrain(ctx, ws.id, b);
    const rec1 = await generateCampaign(ctx, ws.id);
    expect(createProposal(ctx, ws.id, rec1.id).status).toBe("proposed");
    // the owner (or a person editing) drops the condition: the check catches it
    const { updateBrief } = await import("../src/app/campaigns.js");
    updateBrief(ctx, ws.id, rec1.id, { ...rec1.brief, headlines: [...rec1.brief.headlines, "90 day workmanship guarantee"] });
    expect(() => createProposal(ctx, ws.id, rec1.id)).toThrow(/\[grounding_missing_conditions\]/);
  });
});
