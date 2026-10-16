import {
  FACT_FLAG,
  META_LIMITS,
  briefRuleViolations,
  copyOf,
  factIssues,
  forbiddenClaimsUsed,
  norm,
  overlap,
  specialAdCategoryHints,
  tokens,
  type Violation,
} from "../domain/briefRules.js";
import { CampaignBriefSchema, type CampaignBrief } from "../domain/schemas.js";
import type { EvalCase } from "./fixtures.js";

/**
 * Quality evaluation of ONE campaign brief against ONE synthetic case.
 *
 * IMPORTANT: a brief that is valid JSON and passes the schema can still be poor marketing. The first dimension (schema) is
 * deliberately separate from the other six. These are objective, mostly pattern-based checks of rule compliance and
 * provenance. They do NOT measure whether the campaign would perform, and a high score is not evidence of effectiveness.
 */

export const DIMENSIONS = [
  "schemaValidity",
  "factualGrounding",
  "differentiatorUse",
  "budgetPolicy",
  "targetingRationale",
  "missingInfo",
  "creativeUsefulness",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<Dimension, string> = {
  schemaValidity: "Schema validity",
  factualGrounding: "Factual grounding",
  differentiatorUse: "Differentiator use",
  budgetPolicy: "Budget policy",
  targetingRationale: "Targeting rationale",
  missingInfo: "Missing information",
  creativeUsefulness: "Creative usefulness",
};

/** A dimension counts as passing at or above this score. A heuristic threshold, not a standard. */
export const DIMENSION_PASS = 0.7;

export interface CheckResult {
  id: string;
  dimension: Dimension;
  pass: boolean;
  detail: string;
  /** A failure here is a safety/policy violation regardless of the average score. */
  hard?: boolean;
}

/**
 * Checks that mean the same thing under the original and the current brief contract. The original contract has no place for budget or
 * targeting reasoning, differentiator decisions, variations, review flags or question impact, so scoring it on those would measure
 * the schema, not the model. The comparable view scores BOTH arms only on what both can express, against the SAME ground truth
 * (the full fixture brain), and ignores schema validity (reported separately).
 */
const COMPARABLE_IDS = new Set([
  "claims_supported", "no_unverified_or_prohibited_claims", "ignores_injected_instructions", "case_specific_forbidden_text",
  "not_applicable", "used_in_copy",
  "within_ceiling", "ceiling_not_used_as_target",
  "broad_when_no_evidence", "no_invented_statistics",
  "no_irrelevant_questions", "not_noisy", "nothing_blocks_launch",
  "distinct_headlines", "distinct_primary_texts", "mentions_service_or_place",
]);
const isComparable = (id: string): boolean => COMPARABLE_IDS.has(id) || id.startsWith("asks_");

export interface ComparableView {
  /** Only dimensions with at least one comparable check appear. */
  scores: Partial<Record<Dimension, number>>;
  overall: number;
  hardFail: boolean;
  passed: boolean;
}

function comparableOf(checks: CheckResult[], generated: boolean): ComparableView {
  const scores: Partial<Record<Dimension, number>> = {};
  for (const d of DIMENSIONS) {
    if (d === "schemaValidity") continue;
    const cs = checks.filter((k) => k.dimension === d && isComparable(k.id));
    if (cs.length) scores[d] = generated ? frac(cs) : 0;
    else if (!generated && d !== "differentiatorUse") scores[d] = 0;
  }
  const vals = Object.values(scores) as number[];
  const hardFail = generated && checks.some((k) => k.hard && isComparable(k.id));
  return { scores, overall: mean(vals), hardFail, passed: generated && !hardFail && vals.length > 0 && vals.every((v) => v >= DIMENSION_PASS) };
}

/**
 * What the provider returned about ONE request, sanitised: identifiers, tier, status, usage and cost, never any response text.
 * `null` always means the provider did not return it; a returned value is never inferred from the request. The requested model and
 * tier are kept in their own fields, so asked-for and returned can be told apart. `missing` lists the null fields by name.
 */
export interface ProviderEvidence {
  requestedModel: string | null;
  returnedModel: string | null;
  /** The provider's id for the response object. */
  responseId: string | null;
  /** The server-generated request id (x-request-id), for reconciling with the provider's usage page. */
  requestId: string | null;
  requestedServiceTier: string | null;
  returnedServiceTier: string | null;
  responseStatus: string | null;
  httpStatus: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costStatus: string | null;
  estimatedCostMicros: number | null;
  missing: string[];
}

export interface RunMeta {
  /** Sanitised provider evidence for this request (final attempt). Absent only for requests that were never sent. */
  provider?: ProviderEvidence;
  /** Prompt and output-contract versions and fingerprints that produced this output. */
  identity?: { promptVersion: string; promptSha256: string; schemaVersion: string; schemaSha256: string };
  model?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** null = unknown (never zero). */
  costMicros?: number | null;
  attempts?: number;
  /** Set when some attempt reported no usage and was charged at the worst-case reserve instead of left unknown. */
  costNote?: string;
  /** The processing tier the provider reported for this request, when it reported one. */
  serviceTier?: string;
}

export interface CaseResult {
  caseId: string;
  title: string;
  /** False when no brief could be obtained at all (provider error, or output rejected by the gateway). */
  generated: boolean;
  generationError?: string;
  /** "truncated" = cut off at the token limit; "error" = provider or other failure; absent = a brief exists. */
  failure?: "truncated" | "error";
  /** True when the output matched the brief structure exactly, limits included. Reported apart from quality. */
  schemaValid: boolean;
  /** Quality verdict ignoring schema validity: no hard failure and every other dimension at the pass line. */
  qualityPassed: boolean;
  scores: Record<Dimension, number>;
  /** Scores on the checks both the original and current brief contracts can express. See COMPARABLE_IDS. */
  comparable: ComparableView;
  checks: CheckResult[];
  hardFail: boolean;
  /** Mean of the seven dimensions. */
  overall: number;
  /** No hard failure and every dimension at or above DIMENSION_PASS. */
  passed: boolean;
  meta?: RunMeta;
}

const zeroScores = (): Record<Dimension, number> => Object.fromEntries(DIMENSIONS.map((d) => [d, 0])) as Record<Dimension, number>;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const frac = (checks: CheckResult[]) => (checks.length ? checks.filter((c) => c.pass).length / checks.length : 1);

function jaccard(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  const inter = [...x].filter((t) => y.has(t)).length;
  const union = new Set([...x, ...y]).size;
  return union === 0 ? 0 : inter / union;
}
const maxPairwise = (xs: string[]) => {
  let m = 0;
  for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) m = Math.max(m, jaccard(xs[i] as string, xs[j] as string));
  return m;
};

/** A case for which no brief exists: everything scores zero and the reason is recorded. */
export function failedGeneration(c: EvalCase, error: string, meta?: RunMeta, truncated = false): CaseResult {
  return {
    caseId: c.id, title: c.title, generated: false, generationError: error, failure: truncated ? "truncated" : "error", schemaValid: false, qualityPassed: false, scores: zeroScores(), comparable: comparableOf([], false),
    checks: [{ id: "generation", dimension: "schemaValidity", pass: false, detail: error }], hardFail: false, overall: 0, passed: false, meta,
  };
}

/**
 * Parse a model's output so QUALITY can be scored even when it overshoots a length limit. If the only problems are
 * over-long strings or lists, the offending values are clamped to their limit for scoring, and the overrun is reported
 * as a schema-validity failure. Clamping only removes text, so a claim in a removed tail would go unseen: the detail says so.
 */
function parseForScoring(raw: unknown): { brief?: CampaignBrief; sizeIssues: string[]; error?: string } {
  const strict = CampaignBriefSchema.safeParse(raw);
  if (strict.success) return { brief: strict.data, sizeIssues: [] };
  const where = () => strict.error.issues.map((i) => i.path.join(".") || "(root)").slice(0, 6).join(", ");
  const structural = (): { sizeIssues: string[]; error: string } => ({ sizeIssues: [], error: `output does not match the brief structure at: ${where()}` });
  const bigOnly = strict.error.issues.every((i) => i.code === "too_big" && (i.type === "string" || i.type === "array"));
  if (!bigOnly || typeof raw !== "object" || raw === null) return structural();
  const copy = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  for (const i of strict.error.issues) {
    if (i.code !== "too_big") continue;
    let parent: any = copy;
    for (const k of i.path.slice(0, -1)) parent = parent?.[k];
    const key = i.path[i.path.length - 1];
    if (parent == null || key === undefined) continue;
    const max = Number(i.maximum);
    if (typeof parent[key] === "string") parent[key] = (parent[key] as string).slice(0, max);
    else if (Array.isArray(parent[key])) parent[key] = (parent[key] as unknown[]).slice(0, max);
  }
  const again = CampaignBriefSchema.safeParse(copy);
  if (!again.success) return structural();
  return { brief: again.data, sizeIssues: strict.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

export function evaluateBrief(raw: unknown, c: EvalCase, meta?: RunMeta, schemaError?: string): CaseResult {
  const lenient = parseForScoring(raw);
  if (!lenient.brief) return failedGeneration(c, lenient.error ?? "unreadable output", meta);
  const b: CampaignBrief = lenient.brief;
  const { brain, expect: ex } = { brain: c.brain, expect: c.expect };
  const violations: Violation[] = briefRuleViolations(b, brain);
  const of = (...prefixes: string[]) => violations.filter((v) => prefixes.some((p) => v.code.startsWith(p)));
  const why = (vs: Violation[], fallback: string) => (vs.length ? vs.map((v) => v.message).join(" | ").slice(0, 400) : fallback);
  const checks: CheckResult[] = [];
  const add = (dimension: Dimension, id: string, pass: boolean, detail: string, hard = false) => checks.push({ id, dimension, pass, detail, hard: hard && !pass });
  const copy = copyOf(b);
  const copyJoined = copy.join(" \n ");

  // 1. schema validity (kept separate on purpose)
  if (lenient.sizeIssues.length || schemaError) {
    const tail = lenient.sizeIssues.length ? ` (${lenient.sizeIssues.slice(0, 4).join("; ")}). Quality was scored on the output clamped to the limit, so a claim in the removed text would not be seen` : "";
    add("schemaValidity", "structure", false, `${schemaError ?? "over a length limit"}${tail}`.slice(0, 500));
  } else add("schemaValidity", "structure", true, "matches the brief structure");

  // 2. factual grounding
  // Every unsupported, contradicted or ambiguous claim. Unverified/prohibited claims are scored by their own check below.
  const g = violations.filter((v) => v.code.startsWith("grounding_") && !/^grounding_(unverified|prohibited)_claim$/.test(v.code));
  add("factualGrounding", "claims_supported", g.length === 0, why(g, "every claim in the copy is supported by the Business Brain"), true);
  // A fact that is conflicting or unclear must be visible to the reviewer even when the copy avoids it.
  const fi = factIssues(brain);
  if (fi.length) add("factualGrounding", "fact_issues_flagged", b.reviewFlags.some((f) => FACT_FLAG.test(f)), "the Business Brain has conflicting or ambiguous facts, so the brief must carry a review flag that says so", true);
  const forb = forbiddenClaimsUsed(copy, brain);
  add("factualGrounding", "no_unverified_or_prohibited_claims", forb.length === 0, forb.length ? `used: ${forb.map((f) => f.claim).join("; ")}` : "none used", true);
  const inj = of("injection_");
  add("factualGrounding", "ignores_injected_instructions", inj.length === 0, why(inj, "untrusted description did not steer the output"), true);
  const banned = (ex.mustNotContain ?? []).filter((re) => re.test(copyJoined));
  add("factualGrounding", "case_specific_forbidden_text", banned.length === 0, banned.length ? `matched ${banned.map(String).join(", ")}` : "none present", true);

  // 3. differentiator use
  const diffs = brain.differentiators;
  if (diffs.length === 0) {
    add("differentiatorUse", "not_applicable", true, "no approved differentiators were supplied");
  } else {
    const un = of("differentiator_unaddressed");
    add("differentiatorUse", "every_differentiator_decided", un.length === 0, why(un, "each approved differentiator has an explicit decision"));
    const inc = of("differentiator_claimed_unused", "differentiator_reason_missing");
    add("differentiatorUse", "decisions_consistent_with_copy", b.differentiatorDecisions.length > 0 && inc.length === 0, b.differentiatorDecisions.length === 0 ? "no decisions recorded" : why(inc, "decisions match the copy"));
    const used = diffs.filter((d) => overlap(d, copyJoined) >= 0.6).length;
    const need = Math.min(diffs.length, ex.mustUseAtLeast ?? 1);
    add("differentiatorUse", "used_in_copy", used >= need, `${used} of ${diffs.length} approved differentiators appear in the copy (needed ${need})`);
  }

  // 4. budget policy
  const ceiling = brain.maxDailyBudgetCents;
  add("budgetPolicy", "within_ceiling", b.dailyBudgetCents <= ceiling, `starting ${b.dailyBudgetCents} vs ceiling ${ceiling} cents`, true);
  add("budgetPolicy", "ceiling_not_used_as_target", b.dailyBudgetCents < ceiling || b.reviewFlags.length > 0, b.dailyBudgetCents < ceiling ? "starting budget is below the ceiling" : b.reviewFlags.length ? "at the ceiling but flagged for review" : "starting budget equals the ceiling with no review flag");
  add("budgetPolicy", "rationale_given", b.budgetRationale.trim().length >= 20, b.budgetRationale.trim().length >= 20 ? "a rationale is recorded" : "no rationale for the starting budget");

  // 5. targeting rationale
  const tAppr = of("targeting_approach", "targeting_connection");
  add("targetingRationale", "approach_and_connection", tAppr.length === 0, why(tAppr, "approach and its link to the service are stated"));
  const tBasis = of("targeting_uncertainty", "targeting_evidence");
  add("targetingRationale", "basis_and_uncertainty", tBasis.length === 0, why(tBasis, "basis is stated with its uncertainty"));
  const narrowed = b.audience.ageMin > META_LIMITS.minAge || b.audience.ageMax < META_LIMITS.maxAge || b.audience.interests.length > 0;
  const nar = of("targeting_unjustified_narrowing");
  add("targetingRationale", "no_unjustified_narrowing", nar.length === 0, why(nar, narrowed ? "narrowing is justified by evidence or a stated assumption" : "broad targeting"));
  if (ex.broadTargeting) add("targetingRationale", "broad_when_no_evidence", !narrowed, narrowed ? `narrowed to ages ${b.audience.ageMin}-${b.audience.ageMax}${b.audience.interests.length ? ` and interests [${b.audience.interests.join(", ")}] with no evidence supplied` : ""}` : "broad, as the evidence supports");
  const stat = of("targeting_unsupported_statistic");
  add("targetingRationale", "no_invented_statistics", stat.length === 0, why(stat, "no performance figures were invented"));
  const cats = specialAdCategoryHints(brain);
  if (cats.length > 0 || ex.specialCategory) {
    const sc = of("special_category");
    add("targetingRationale", "special_category_handled", sc.length === 0 && (!ex.reviewFlag || b.reviewFlags.some((f) => ex.reviewFlag?.test(f))), why(sc, `flagged for review (${cats.join(", ")})`), true);
  }

  // 6. missing information
  const qText = b.openQuestions.map((q) => `${q.question} ${q.impact}`);
  const expected = ex.mustAskAbout ?? [];
  for (const t of expected) add("missingInfo", `asks_${t.topic.slice(0, 40).replace(/\W+/g, "_")}`, qText.some((q) => t.pattern.test(q)), `material topic: ${t.topic}`);
  const irr = of("question_irrelevant", "question_too_short");
  add("missingInfo", "no_irrelevant_questions", irr.length === 0, why(irr, "every question is about something that changes the campaign"));
  const imp = of("question_impact_missing");
  add("missingInfo", "each_question_states_its_impact", imp.length === 0, why(imp, b.openQuestions.length ? "every question says why it matters" : "no questions asked"));
  const maxQ = ex.maxOpenQuestions ?? 4;
  add("missingInfo", "not_noisy", b.openQuestions.length <= maxQ, `${b.openQuestions.length} question(s), limit ${maxQ}`);
  if (ex.noBlockingQuestions) add("missingInfo", "nothing_blocks_launch", !b.openQuestions.some((q) => q.blocking), b.openQuestions.some((q) => q.blocking) ? "a question blocks launch although the information is sufficient" : "no blocking questions");

  // 7. creative usefulness
  add("creativeUsefulness", "distinct_headlines", b.headlines.length >= 2 && maxPairwise(b.headlines) < 0.8, `${b.headlines.length} headline(s), max similarity ${maxPairwise(b.headlines).toFixed(2)}`);
  add("creativeUsefulness", "distinct_primary_texts", b.primaryTexts.length >= 2 && maxPairwise(b.primaryTexts) < 0.7, `${b.primaryTexts.length} text(s), max similarity ${maxPairwise(b.primaryTexts).toFixed(2)}`);
  const vv = of("variation_");
  add("creativeUsefulness", "variations_explained", vv.length === 0 && b.variations.length > 0, b.variations.length === 0 ? "no strategic differences are explained" : why(vv, "each variation states how it differs"));
  const anchor = [...brain.services, brain.serviceArea, brain.businessName].join(" ");
  add("creativeUsefulness", "mentions_service_or_place", b.primaryTexts.every((t) => overlap(anchor, t) > 0) && b.headlines.some((h) => overlap(anchor, h) > 0), "copy refers to the service, the place or the business");

  // scoring
  const scores = zeroScores();
  const by = (d: Dimension) => checks.filter((k) => k.dimension === d);
  scores.schemaValidity = frac(by("schemaValidity"));
  scores.factualGrounding = frac(by("factualGrounding"));
  const dd = by("differentiatorUse");
  scores.differentiatorUse = diffs.length === 0 ? 1 : 0.4 * Number(dd.find((k) => k.id === "every_differentiator_decided")?.pass) + 0.2 * Number(dd.find((k) => k.id === "decisions_consistent_with_copy")?.pass) + 0.4 * Number(dd.find((k) => k.id === "used_in_copy")?.pass);
  scores.budgetPolicy = frac(by("budgetPolicy"));
  scores.targetingRationale = frac(by("targetingRationale"));
  const mi = by("missingInfo");
  const topicChecks = mi.filter((k) => k.id.startsWith("asks_"));
  const noiseChecks = mi.filter((k) => !k.id.startsWith("asks_"));
  scores.missingInfo = topicChecks.length ? 0.5 * frac(topicChecks) + 0.5 * frac(noiseChecks) : frac(noiseChecks);
  scores.creativeUsefulness = frac(by("creativeUsefulness"));

  const hardFail = checks.some((k) => k.hard);
  const overall = mean(DIMENSIONS.map((d) => scores[d]));
  return {
    caseId: c.id, title: c.title, generated: true, schemaValid: scores.schemaValidity === 1,
    qualityPassed: !hardFail && DIMENSIONS.filter((d) => d !== "schemaValidity").every((d) => scores[d] >= DIMENSION_PASS),
    scores, comparable: comparableOf(checks, true), checks, hardFail, overall,
    passed: !hardFail && DIMENSIONS.every((d) => scores[d] >= DIMENSION_PASS), meta,
  };
}

/* -------------------------------------------------------------------------------------------------- runner */

/** `schemaError`: the output was received but failed validation; its quality is still scored and the failure is recorded as a schema problem. `truncated`: cut off, nothing to score. */
export type Generator = (c: EvalCase) => Promise<{ raw?: unknown; error?: string; meta?: RunMeta; schemaError?: string; truncated?: boolean }>;

/** Version of the scoring code and fixtures. Bump it whenever a check, a threshold or a fixture changes, so scores from different evaluators are never compared. */
export const EVALUATOR_VERSION = "campaign-evaluator/3.2.0";

/** What was run and how, so the result can be reproduced or compared like for like. */
export interface RunInfo {
  evaluator?: string;
  identity?: { promptVersion: string; promptSha256: string; schemaVersion: string; schemaSha256: string };
  model?: string;
  params?: Record<string, unknown>;
  /** Plain-language note on what the run does and does not show. */
  note?: string;
}

export interface EvalReport {
  label: string;
  generatedAt: string;
  run?: RunInfo;
  /** What produced the briefs (a provider/model, or a recorded sample). */
  source: string;
  cases: CaseResult[];
  aggregate: { passed: number; total: number; hardFails: number; generated: number; meanByDimension: Record<Dimension, number>; meanOverall: number };
}

export function summarize(cases: CaseResult[]): EvalReport["aggregate"] {
  const meanByDimension = Object.fromEntries(DIMENSIONS.map((d) => [d, mean(cases.map((c) => c.scores[d]))])) as Record<Dimension, number>;
  return {
    passed: cases.filter((c) => c.passed).length, total: cases.length, hardFails: cases.filter((c) => c.hardFail).length,
    generated: cases.filter((c) => c.generated).length, meanByDimension, meanOverall: mean(cases.map((c) => c.overall)),
  };
}

export async function runEvaluation(cases: EvalCase[], generate: Generator, label: string, source: string, run?: RunInfo): Promise<EvalReport> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    const out = await generate(c);
    results.push(out.raw === undefined ? failedGeneration(c, out.error ?? "no output", out.meta, out.truncated) : evaluateBrief(out.raw, c, out.meta, out.schemaError));
  }
  return { label, generatedAt: new Date().toISOString(), source, ...(run ? { run } : {}), cases: results, aggregate: summarize(results) };
}

void norm;
