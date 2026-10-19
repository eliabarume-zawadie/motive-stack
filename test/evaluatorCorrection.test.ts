import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { briefRuleViolations, factIssues, groundingIssues } from "../src/domain/briefRules.js";
import { BusinessBrainSchema, CampaignBriefSchema, type BusinessBrain } from "../src/domain/schemas.js";
import { EVALUATOR_HISTORY, EVALUATOR_VERSION, evaluateBrief } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { BRAIN } from "./fixtures.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const brain = (over: object = {}): BusinessBrain => BusinessBrainSchema.parse({ ...BRAIN, differentiators: [], verifiedFacts: [], ...over });
const claims = (text: string, b: BusinessBrain) => groundingIssues([text], b, { asOf: NOW }).filter((i) => i.code === "ownership" || i.code === "experience");
const verdict = (text: string, b: BusinessBrain) => {
  const g = claims(text, b);
  return g.length ? g.map((i) => `${i.reason}:${i.code}`).join(",") : "ok";
};
const caseById = (id: string) => EVAL_CASES.find((c) => c.id === id)!;

describe("evaluator 3.3.0: the word 'generation' alone is not an ownership or history claim", () => {
  const bare = brain();
  it.each([
    "Lead generation",
    "Lead Generation",
    "Brightwire Electric - Lead Generation Campaign",
    "Next-generation service",
    "next generation panel upgrades",
    "Generation of new leads",
    "Generation Z homeowners welcome",
    "Fast lead generation for local pros",
  ])("%j does not trigger an ownership or history failure, even with no supporting fact", (text) => {
    expect(verdict(text, bare)).toBe("ok");
  });

  it("the rule is narrowed, not removed: genuine generational claims still have to be supported", () => {
    for (const text of [
      "Third-generation business", "Third generation plumbers", "Fourth-generation family", "2nd-generation electricians",
      "Serving families for generations", "Trusted for three generations", "Generations of experience", "Generations of families trust us",
      "A multi-generational family business", "Multi-generation service", "Generational family business",
    ]) expect(verdict(text, bare), text).toMatch(/^unsupported:ownership/);
  });

  it("'family' describes the business only in claim contexts: everyday ad language is no longer read as ownership", () => {
    for (const text of ["Keep your family comfortable", "Protect the family home", "Safe heat for your family", "Family discounts available", "Plumbing for the whole family"]) expect(verdict(text, bare), text).toBe("ok");
    for (const text of ["Family-owned", "Family owned and operated", "A family-run company", "Our family serving yours", "Run by a local family", "Local family business"]) expect(verdict(text, bare), text).toMatch(/^unsupported:ownership/);
  });
});

describe("the real claims are still assessed against the evidence", () => {
  it("'Family-owned': unsupported without a fact, supported with one, contradicted by a negative fact", () => {
    expect(verdict("Family-owned", brain())).toBe("unsupported:ownership");
    expect(verdict("Family-owned", brain({ verifiedFacts: ["Family owned and operated"] }))).toBe("ok");
    expect(verdict("Family-owned", brain({ verifiedFacts: ["Not family owned"] }))).toBe("contradicted:ownership");
    expect(verdict("Family-owned", brain({ verifiedFacts: ["Non-family owned; bought in 2021"] }))).toBe("contradicted:ownership");
  });
  it("'Third-generation business': unsupported alone, supported only by a fact about generations, contradicted by a denial", () => {
    expect(verdict("Third-generation business", brain())).toBe("unsupported:ownership");
    expect(verdict("Third-generation business", brain({ verifiedFacts: ["Third-generation family business"] }))).toBe("ok");
    expect(verdict("Third-generation business", brain({ verifiedFacts: ["Family owned and operated"] }))).toBe("unsupported:ownership"); // a different claim
    expect(verdict("Third-generation business", brain({ verifiedFacts: ["Not a third-generation business"] }))).toBe("contradicted:ownership");
    expect(verdict("Third-generation business", brain({ verifiedFacts: ["Third-generation business pending confirmation"] }))).toBe("ambiguous:ownership");
  });
  it("'Established in 1998': unsupported alone, supported by the fact, contradicted or unclear when the fact says otherwise", () => {
    expect(verdict("Established in 1998", brain())).toBe("unsupported:experience");
    expect(verdict("Established in 1998", brain({ verifiedFacts: ["Established in 1998"] }))).toBe("ok");
    expect(verdict("Established in 1998", brain({ verifiedFacts: ["Not established in 1998"] }))).toBe("contradicted:experience");
    expect(verdict("Established in 1998", brain({ verifiedFacts: ["Established in 1998 (to be confirmed)"] }))).toBe("ambiguous:experience");
    expect(verdict("Established in 1998", brain({ verifiedFacts: ["Established in 2005"] }))).toBe("unsupported:experience");
  });
  it("a Business Brain that both affirms and denies an ownership claim is still a conflict that blocks launch", () => {
    const b = brain({ differentiators: ["Family-owned business"], verifiedFacts: ["Not family owned"] });
    expect(factIssues(b, { asOf: NOW })).toEqual([expect.objectContaining({ type: "conflict", kind: "ownership" })]);
    expect(verdict("Family-owned", b)).toBe("contradicted:ownership");
  });
  it("a negative fact never authorises a claim, and an unrelated mention of 'generation' in a fact does not create a claim to deny", () => {
    const b = brain({ verifiedFacts: ["Lead generation handled by our team", "Next-generation smart thermostats installed"] });
    expect(factIssues(b, { asOf: NOW })).toEqual([]); // no phantom ownership fact, so no phantom conflict
    expect(verdict("Family-owned", b)).toBe("unsupported:ownership");
    expect(verdict("Third-generation business", b)).toBe("unsupported:ownership"); // such a fact does not support the real claim either
  });
});

describe("the same corrections hold through generation rules and the whole evaluation", () => {
  const c = caseById("electrician-negated-and-pending-facts");
  const base = buildMockBrief(c.brain) as Record<string, any>;
  const named = (name: string) => ({ ...base, name });

  it("the false-positive scenario from invocation 2: a campaign named '... Lead Generation' no longer fails factual grounding", () => {
    const r = evaluateBrief(named("Brightwire Electric - Lead Generation"), c);
    const grounding = r.checks.find((k) => k.id === "claims_supported")!;
    expect(grounding.pass).toBe(true);
    expect(r.scores.factualGrounding).toBe(1);
    expect(r.hardFail).toBe(false);
  });
  it("the same brief with a REAL unsupported claim still hard-fails", () => {
    const r = evaluateBrief({ ...base, headlines: [...base.headlines, "Third-generation electricians"] }, c);
    expect(r.checks.find((k) => k.id === "claims_supported")?.pass).toBe(false);
    expect(r.hardFail).toBe(true);
  });
  it("other defects in that case are unaffected: leaving out the review flag for conflicting or unclear facts still hard-fails", () => {
    const r = evaluateBrief({ ...named("Brightwire Electric - Lead Generation"), reviewFlags: [] }, c);
    expect(r.checks.find((k) => k.id === "claims_supported")?.pass).toBe(true);
    expect(r.checks.find((k) => k.id === "fact_issues_flagged")?.pass).toBe(false);
    expect(r.hardFail).toBe(true);
  });
  it("generation-time rules agree with the evaluator (they share one rule)", () => {
    const b = CampaignBriefSchema.parse(named("Brightwire Electric - Lead Generation"));
    expect(briefRuleViolations(b, c.brain, { asOf: NOW }).map((v) => v.code)).not.toContain("grounding_ownership");
    const bad = CampaignBriefSchema.parse({ ...base, headlines: [...base.headlines, "Third-generation electricians"] });
    expect(briefRuleViolations(bad, c.brain, { asOf: NOW }).map((v) => v.code)).toContain("grounding_ownership");
  });
  it("every fixture still scores exactly as before for the reference generator (no other dimension moved)", () => {
    for (const x of EVAL_CASES) {
      const r = evaluateBrief(buildMockBrief(x.brain), x);
      expect(r.passed, x.id).toBe(true);
      expect(r.hardFail, x.id).toBe(false);
    }
  });
});

describe("the evaluator version is recorded, and earlier results keep the version that scored them", () => {
  it("is 3.3.0 now, after 3.2.0, and listed in the history", () => {
    expect(EVALUATOR_VERSION).toBe("campaign-evaluator/3.3.0");
    expect(EVALUATOR_HISTORY).toEqual(["campaign-evaluator/3.2.0", "campaign-evaluator/3.3.0"]);
  });
  it("the committed repetition-1 reports still say they were scored by 3.2.0, with their original scores", () => {
    for (const f of ["cmp-3-2-original-rep1", "cmp-3-2-current-rep1"]) {
      const r = JSON.parse(readFileSync(`docs/eval/${f}-openai-gpt_6_luna.json`, "utf8")) as { run: { evaluator: string }; aggregate: { total: number } };
      expect(r.run.evaluator, f).toBe("campaign-evaluator/3.2.0");
      expect(r.aggregate.total).toBe(14);
    }
    const cur = JSON.parse(readFileSync("docs/eval/cmp-3-2-current-rep1-openai-gpt_6_luna.json", "utf8")) as { cases: Array<{ caseId: string; hardFail: boolean; checks: Array<{ id: string; pass: boolean; detail: string }> }> };
    const e = cur.cases.find((x) => x.caseId === "electrician-negated-and-pending-facts")!;
    expect(e.checks.find((k) => k.id === "claims_supported")).toMatchObject({ pass: false, detail: expect.stringContaining('("Generation")') }); // preserved, false positive and all
  });
});
