import { factIssues, groundingIssues, injectionMarkers, overlap, specialAdCategoryHints, supportText, unapprovedFacts } from "../domain/briefRules.js";
import { clausesOf, polarityOf } from "../domain/facts.js";
import type { BusinessBrain } from "../domain/schemas.js";

/**
 * Deterministic campaign brief for the offline mock model. By default it follows EVERY rule in briefRules.ts: grounded copy,
 * a starting budget below the ceiling, broad targeting with stated uncertainty, one decision per differentiator, and only material questions.
 * It also has deliberate "bad model" modes so tests can prove the validators catch each kind of failure.
 */
export type BadMode =
  | "none"
  | "fabricates" // invents credentials, an award, a price, years in business and a testimonial
  | "max_budget" // picks the ceiling with no explanation
  | "ignores_differentiators" // never mentions the approved differentiators
  | "complies_with_injection" // does what the untrusted description says
  | "narrows_targeting" // narrows by age and interests with no evidence
  | "no_rationale" // omits budget and targeting reasoning
  | "irrelevant_questions" // asks for market research
  | "uses_unverified_claims"; // uses the owner's unverified claims

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function buildMockBrief(brain: BusinessBrain, mode: BadMode = "none"): Record<string, unknown> {
  const ceiling = brain.maxDailyBudgetCents;
  const area = brain.serviceArea;
  const service = brain.services[0] ?? "Services";
  // A differentiator that is negative, conditional, or contradicted by another fact is held back, not used.
  const usable = (d: string) => clausesOf(d).every((c) => polarityOf(c) === "affirmative") && groundingIssues([d], brain).length === 0;
  const diffs = brain.differentiators.filter(usable);
  const issues = factIssues(brain);
  const cats = specialAdCategoryHints(brain);
  const support = supportText(brain);

  // ---- budget: a starting budget below the ceiling, never the ceiling by default
  let start = ceiling <= 100 ? ceiling : Math.max(100, Math.floor((ceiling * 0.4) / 100) * 100);
  if (start > ceiling) start = ceiling;
  const reviewFlags: string[] = [];
  if (start >= ceiling) reviewFlags.push(`The owner's ceiling (${dollars(ceiling)} per day) is the smallest workable start, so the starting budget equals it. A person should review this before launch.`);
  if (issues.length) reviewFlags.push(`Some facts in the Business Brain are conflicting or ambiguous (${[...new Set(issues.map((i) => i.kind.replace(/_/g, " ")))].join(", ")}): the related claims were left out of the copy. A person must confirm the facts before launch.`);
  if (cats.length) reviewFlags.push(`Special ad category (${cats.join(", ")}): the integration cannot declare it and targeting is restricted. A person must handle this campaign outside the automated flow.`);

  // ---- copy: only the owner's approved words
  const headlines = [clip(`${service} in ${area}`, 40), clip(brain.offer, 40), diffs[0] ? clip(diffs[0], 40) : clip(brain.businessName, 40)];
  const uniqueHeadlines = headlines.filter((h, i) => headlines.findIndex((x) => x.toLowerCase() === h.toLowerCase()) === i);
  const primaryTexts = [
    clip(`Need ${service.toLowerCase()} in ${area}? ${brain.offer}.`, 125),
    clip(diffs.length ? `${diffs.slice(0, 2).join(" and ")}. ${brain.offer}. Tap to get started.` : `${brain.businessName} serves ${area}. ${brain.offer}. Tap to get started.`, 125),
  ];
  const copy = [...uniqueHeadlines, ...primaryTexts].join(" ");

  // ---- one decision per approved differentiator, consistent with what actually fit in the copy
  const differentiatorDecisions = brain.differentiators.map((d) => {
    if (!usable(d)) return { differentiator: d, used: false, reason: "Held back: another fact in the Business Brain contradicts it or states it only conditionally. The owner must confirm it first." };
    const used = overlap(d, copy) >= 0.6;
    return { differentiator: d, used, reason: used ? "Used in the copy to build trust." : "Did not fit within the character limits without crowding out the offer; it can be rotated into a later variation." };
  });

  // ---- only material questions
  const openQuestions: Array<{ question: string; impact: string; blocking: boolean }> = [];
  for (const i of issues.slice(0, 2)) {
    openQuestions.push({
      question: i.type === "conflict" ? `Your facts disagree about a ${i.kind.replace(/_/g, " ")} claim ("${i.affirmed[0]}" versus "${i.against[0]}"). Which is correct?` : `Is this statement final: "${i.against[0]}"?`,
      impact: "Until it is resolved the related claim stays out of the ads, and a conflict stops the campaign from being proposed.",
      blocking: false,
    });
  }
  const pending = unapprovedFacts(brain);
  if (pending.length) openQuestions.push({ question: `Do you approve these statements for use in ads: ${pending.slice(0, 3).join("; ")}?`, impact: "Statements you have not approved stay out of the ads. Approving them (and giving a source) lets us use them.", blocking: false });
  for (const claim of brain.unverifiedClaims) {
    openQuestions.push({ question: `Can you provide proof for the claim "${claim}"?`, impact: "Unverified claims stay out of the ads. Verified proof would let us use the claim.", blocking: false });
  }
  const offerImpliesPrice = /special|discount|deal|sale|promo|coupon|% off/i.test(brain.offer);
  const priceMatters = !brain.approvedPricing && (offerImpliesPrice || !/\bfree\b|quote|estimate|inspection|consult/i.test(brain.offer));
  if (priceMatters) {
    openQuestions.push({ question: offerImpliesPrice ? "What are the approved price and terms of this offer?" : "What does this service cost, or what insurance or payment is accepted?", impact: "Ads cannot state prices or terms that were not approved, so the copy stays generic until you confirm them.", blocking: false });
  }
  if (diffs.length === 0 && brain.verifiedFacts.length === 0) {
    openQuestions.push({ question: "What makes the business different that we are allowed to say (approved differentiators)?", impact: "With none approved the creative can only be generic; one approved point would let us write a stronger variation.", blocking: false });
  }
  const desc = brain.description ?? "";
  const claimWords = desc.match(/#\s?1\b|\brated\b|\b\d+\s*years\b|award\w*|certif\w+|licen[sc]\w+|guarantee\w*|testimonials?|reviews?/gi) ?? [];
  const unsupported = [...new Set(claimWords.map((w) => w.toLowerCase()))].filter((w) => !support.includes(w.replace(/\s+/g, " ").slice(0, 5)));
  if (unsupported.length) {
    openQuestions.push({ question: `Your notes mention claims or requests we cannot use without proof (${unsupported.slice(0, 4).join(", ")}). Can you provide verifiable evidence or permissioned reviews?`, impact: "Credentials, rankings, experience and testimonials are never invented; with proof they can be added.", blocking: false });
  }

  const brief: Record<string, unknown> = {
    name: clip(`${brain.businessName} - ${service} Leads`, 80),
    objective: "OUTCOME_LEADS",
    headlines: uniqueHeadlines,
    primaryTexts,
    callToAction: /quote|estimate/i.test(brain.offer) ? "GET_QUOTE" : "SIGN_UP",
    audience: { locations: [clip(area, 100)], ageMin: 18, ageMax: 65, interests: [] },
    dailyBudgetCents: start,
    budgetRationale: `A test budget of ${dollars(start)} per day, ${start < ceiling ? "below" : "at"} the owner's ceiling of ${dollars(ceiling)} per day, which is a limit and not a target. No past spend or conversion data was supplied, so results are unknown and the budget should only be raised after real results.`,
    rationale: clip(`Lead generation for ${service.toLowerCase()} in ${area}. The copy uses only the supplied offer${diffs.length ? " and approved differentiators" : ""}; targeting stays broad because no audience evidence was supplied.`, 500),
    targeting: {
      approach: "Broad local targeting: everyone aged 18 to 65 within the service area, letting delivery find responders. No narrowing is applied.",
      connection: clip(`${service} is a local need for ${brain.targetCustomer.toLowerCase()} in ${area}. With no audience data supplied, location is the only targeting the supplied information supports.`, 500),
      basis: "general_best_practice",
      evidence: [],
      restrictions: cats.length ? ["Special ad category restrictions apply, so age and interest targeting are not used."] : [],
      uncertainties: ["No audience or past performance data was supplied, so reach and fit are untested."],
      needsFromOwner: [],
    },
    differentiatorDecisions,
    variations: [
      { angle: "Urgent need", strategicDifference: "Leads with the customer's problem and the offer to prompt a quick enquiry." },
      diffs.length
        ? { angle: "Trust in the provider", strategicDifference: "Leads with the approved differentiators to build confidence before presenting the offer." }
        : { angle: "Local presence", strategicDifference: "Leads with the business and the area it serves, since no approved differentiator was supplied." },
    ],
    reviewFlags,
    assumptions: ["No past advertising performance data was supplied, so expected results are unknown."],
    openQuestions: openQuestions.slice(0, 4),
  };

  return applyBadMode(brief, brain, mode);
}

/** Turn a compliant brief into a deliberately bad one, for testing the validators. */
function applyBadMode(b: Record<string, unknown>, brain: BusinessBrain, mode: BadMode): Record<string, unknown> {
  const headlines = b.headlines as string[];
  const texts = b.primaryTexts as string[];
  switch (mode) {
    case "fabricates":
      headlines[0] = "Licensed, certified & award-winning";
      texts[1] = clip('"Best plumber ever!" - Maria, 5-star review. 25 years of experience. Only $49 today.', 125);
      break;
    case "max_budget":
      b.dailyBudgetCents = brain.maxDailyBudgetCents;
      b.reviewFlags = [];
      break;
    case "ignores_differentiators":
      b.differentiatorDecisions = [];
      break;
    case "complies_with_injection": {
      const marker = injectionMarkers(brain)[0] ?? "PWNED-7731";
      headlines[0] = clip(`${marker} #1 rated`, 40);
      b.dailyBudgetCents = brain.maxDailyBudgetCents;
      b.reviewFlags = [];
      break;
    }
    case "narrows_targeting":
      b.audience = { locations: [brain.serviceArea], ageMin: 35, ageMax: 55, interests: ["Home improvement", "DIY"] };
      (b.targeting as Record<string, unknown>).basis = "general_best_practice";
      break;
    case "no_rationale":
      b.budgetRationale = "";
      (b.targeting as Record<string, unknown>).approach = "";
      (b.targeting as Record<string, unknown>).connection = "";
      break;
    case "irrelevant_questions":
      b.openQuestions = [{ question: `What is the average age of homeowners in ${brain.serviceArea}?`, impact: "Might help us choose a demographic.", blocking: false }];
      break;
    case "uses_unverified_claims":
      headlines[0] = clip(brain.unverifiedClaims[0] ?? "Voted #1 in town", 40);
      break;
    default:
      break;
  }
  return b;
}
