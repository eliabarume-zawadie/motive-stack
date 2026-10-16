import { describe, expect, it } from "vitest";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { briefRuleViolations } from "../src/domain/briefRules.js";
import { BusinessBrainSchema, CampaignBriefSchema } from "../src/domain/schemas.js";
import { BRAIN } from "./fixtures.js";

const brain = (over: object = {}) => BusinessBrainSchema.parse({ ...BRAIN, ...over });
const violations = (raw: unknown, b = brain()) => briefRuleViolations(CampaignBriefSchema.parse(raw), b).map((v) => v.code);

describe("differentiator decisions are matched one-to-one, best match first", () => {
  it("near-identically worded differentiators each keep their own decision", () => {
    const b = brain({ differentiators: Array.from({ length: 6 }, (_, i) => `Differentiator ${i} ${"y".repeat(150)}`) });
    expect(violations(buildMockBrief(b), b).filter((c) => c.startsWith("differentiator_"))).toEqual([]);
  });
  it("still reports a differentiator that genuinely has no decision", () => {
    const b = brain({ differentiators: ["24/7 availability", "Licensed and insured"] });
    const raw = buildMockBrief(b) as { differentiatorDecisions: unknown[] };
    raw.differentiatorDecisions = raw.differentiatorDecisions.slice(0, 1);
    expect(violations(raw, b)).toContain("differentiator_unaddressed");
  });
});
