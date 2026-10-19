import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EVALUATOR_VERSION, evaluateBrief, failedGeneration, summarize, type CaseResult, type EvalReport, type GeneratorOutput, type ProviderEvidence, type RunMeta } from "./evaluate.js";
import { EVAL_CASES, type EvalCase } from "./fixtures.js";

/**
 * A saved record of every synthetic generation, so a result can be re-scored later WITHOUT calling a model.
 *
 * One file per invocation (docs/eval/outputs/<label>-<provider>-<model>.outputs.json), written after EVERY request and written
 * BEFORE the output is scored, so a crash or a scoring bug can never cost the text. The inputs are the invented fixture
 * businesses only. A record holds the output text and identifiers; it never holds the API key, request headers, or the prompt
 * (the prompt is fully determined by the case and the recorded prompt version).
 */
export const OUTPUT_ARTIFACT_VERSION = "campaign-eval-output/1";

export const fixtureSha256 = (c: EvalCase): string =>
  createHash("sha256").update(JSON.stringify({ id: c.id, brain: c.brain, expect: JSON.parse(JSON.stringify(c.expect, (_k, v) => (v instanceof RegExp ? String(v) : v))) })).digest("hex");

export interface ScoredBlock {
  evaluatorVersion: string;
  schemaValid: boolean;
  qualityPassed: boolean;
  hardFail: boolean;
  passed: boolean;
  overall: number;
  scores: CaseResult["scores"];
  comparable: CaseResult["comparable"];
  checks: CaseResult["checks"];
}

export interface OutputRecord {
  artifactVersion: typeof OUTPUT_ARTIFACT_VERSION;
  invocation: string;
  caseId: string;
  /** Fingerprint of the fixture (brain and expectations) the output was produced for. A rescore refuses if the fixture has changed. */
  fixtureSha256: string;
  requestedModel: string | null;
  returnedModel: string | null;
  requestedServiceTier: string | null;
  returnedServiceTier: string | null;
  promptVersion: string | null;
  promptSha256: string | null;
  schemaVersion: string | null;
  schemaSha256: string | null;
  evaluatorVersion: string;
  responseId: string | null;
  requestId: string | null;
  responseStatus: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  costStatus: string | null;
  estimatedCostMicros: number | null;
  /** The output text exactly as the provider returned it. null only when no output was received. */
  rawText: string | null;
  /** The object that was handed to the scorer (the validated output, or the received output that failed validation). null when there was none. */
  parsedOutput: unknown | null;
  /** Why the output failed its contract (length limits, missing fields...). null when it was valid. */
  validationErrors: string | null;
  generationError: string | null;
  failure: "truncated" | "error" | null;
  /** Filled after scoring. null until then, and for ever if the run stopped first. */
  scored: ScoredBlock | null;
}

export interface OutputArtifact {
  artifactVersion: typeof OUTPUT_ARTIFACT_VERSION;
  label: string;
  source: string;
  createdAt: string;
  records: OutputRecord[];
}

/** Build a record from one generation, before it is scored. Identifiers a provider did not return stay null. */
export function recordFromGeneration(invocation: string, c: EvalCase, out: GeneratorOutput, evaluatorVersion = EVALUATOR_VERSION): OutputRecord {
  const p: ProviderEvidence | undefined = out.meta?.provider;
  const id = out.meta?.identity;
  return {
    artifactVersion: OUTPUT_ARTIFACT_VERSION, invocation, caseId: c.id, fixtureSha256: fixtureSha256(c),
    requestedModel: p?.requestedModel ?? null, returnedModel: p?.returnedModel ?? null,
    requestedServiceTier: p?.requestedServiceTier ?? null, returnedServiceTier: p?.returnedServiceTier ?? null,
    promptVersion: id?.promptVersion ?? null, promptSha256: id?.promptSha256 ?? null, schemaVersion: id?.schemaVersion ?? null, schemaSha256: id?.schemaSha256 ?? null,
    evaluatorVersion,
    responseId: p?.responseId ?? null, requestId: p?.requestId ?? null, responseStatus: p?.responseStatus ?? null,
    usage: { inputTokens: p?.inputTokens ?? null, outputTokens: p?.outputTokens ?? null },
    costStatus: p?.costStatus ?? null, estimatedCostMicros: p?.estimatedCostMicros ?? null,
    rawText: out.rawText ?? null,
    parsedOutput: out.raw === undefined ? null : out.raw,
    validationErrors: out.schemaError ?? null,
    generationError: out.error ?? null,
    failure: out.error === undefined ? null : out.truncated ? "truncated" : "error",
    scored: null,
  };
}

export const scoredBlock = (r: CaseResult, evaluatorVersion = EVALUATOR_VERSION): ScoredBlock => ({
  evaluatorVersion, schemaValid: r.schemaValid, qualityPassed: r.qualityPassed, hardFail: r.hardFail, passed: r.passed, overall: r.overall, scores: r.scores, comparable: r.comparable, checks: r.checks,
});

/** Writes the artifact after every change, atomically, and refuses to overwrite an existing one. */
export class OutputStore {
  private readonly artifact: OutputArtifact;
  constructor(readonly path: string, header: { label: string; source: string }, now: () => Date = () => new Date()) {
    if (existsSync(path)) throw new Error(`refusing to overwrite the saved outputs at ${path}: they are evidence. Use a new label.`);
    this.artifact = { artifactVersion: OUTPUT_ARTIFACT_VERSION, label: header.label, source: header.source, createdAt: now().toISOString(), records: [] };
    this.flush();
  }
  add(r: OutputRecord): void {
    this.artifact.records.push(r);
    this.flush();
  }
  attachScore(caseId: string, s: ScoredBlock): void {
    const r = this.artifact.records.find((x) => x.caseId === caseId && x.scored === null);
    if (r) r.scored = s;
    this.flush();
  }
  get records(): readonly OutputRecord[] {
    return this.artifact.records;
  }
  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.artifact, null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}

export const loadArtifact = (path: string): OutputArtifact => {
  const a = JSON.parse(readFileSync(path, "utf8")) as OutputArtifact;
  if (a.artifactVersion !== OUTPUT_ARTIFACT_VERSION || !Array.isArray(a.records)) throw new Error(`${path} is not a ${OUTPUT_ARTIFACT_VERSION} outputs file`);
  return a;
};

export interface Rescored {
  report: EvalReport;
  /** Saved outputs that could not be rescored, and why. They are listed, never silently dropped or regenerated. */
  skipped: Array<{ caseId: string; reason: string }>;
  /** Side by side, so the original scores and the evaluator that gave them are never overwritten. */
  comparison: Array<{ caseId: string; original: { evaluator: string; overall: number; hardFail: boolean; passed: boolean } | null; rescored: { evaluator: string; overall: number; hardFail: boolean; passed: boolean } }>;
}

/**
 * Score a COPY of saved outputs with the current evaluator. Nothing is sent to any model. The artifact is not modified. A record
 * whose fixture has changed, or whose case no longer exists, is skipped and reported.
 */
export function rescoreArtifact(a: OutputArtifact, label: string, cases: EvalCase[] = EVAL_CASES, now: () => Date = () => new Date()): Rescored {
  const results: CaseResult[] = [];
  const skipped: Rescored["skipped"] = [];
  const comparison: Rescored["comparison"] = [];
  for (const rec of a.records) {
    const c = cases.find((x) => x.id === rec.caseId);
    if (!c) { skipped.push({ caseId: rec.caseId, reason: "this case no longer exists in the fixture set" }); continue; }
    if (fixtureSha256(c) !== rec.fixtureSha256) { skipped.push({ caseId: rec.caseId, reason: "the fixture has changed since the output was produced, so it cannot be scored faithfully" }); continue; }
    const meta: RunMeta = {
      model: rec.requestedModel ? `openai/${rec.requestedModel}` : undefined, inputTokens: rec.usage.inputTokens ?? undefined, outputTokens: rec.usage.outputTokens ?? undefined,
      costMicros: rec.estimatedCostMicros,
      provider: { requestedModel: rec.requestedModel, returnedModel: rec.returnedModel, responseId: rec.responseId, requestId: rec.requestId, requestedServiceTier: rec.requestedServiceTier, returnedServiceTier: rec.returnedServiceTier, responseStatus: rec.responseStatus, httpStatus: null, inputTokens: rec.usage.inputTokens, outputTokens: rec.usage.outputTokens, costStatus: rec.costStatus, estimatedCostMicros: rec.estimatedCostMicros, missing: [] },
    };
    const r = rec.parsedOutput !== null ? evaluateBrief(rec.parsedOutput, c, meta, rec.validationErrors ?? undefined) : failedGeneration(c, rec.generationError ?? "no output was received", meta, rec.failure === "truncated");
    results.push(r);
    comparison.push({
      caseId: rec.caseId,
      original: rec.scored ? { evaluator: rec.scored.evaluatorVersion, overall: rec.scored.overall, hardFail: rec.scored.hardFail, passed: rec.scored.passed } : null,
      rescored: { evaluator: EVALUATOR_VERSION, overall: r.overall, hardFail: r.hardFail, passed: r.passed },
    });
  }
  const report: EvalReport = {
    label, generatedAt: now().toISOString(), source: `RESCORED from saved outputs of "${a.label}" (${a.source}); no model was called`,
    run: { evaluator: EVALUATOR_VERSION, note: `Scored offline from ${a.records.length} saved synthetic output(s) with ${EVALUATOR_VERSION}. The original scores and evaluator versions are preserved in the saved outputs and listed in "comparison"; this is a separate cohort from results scored by any other evaluator version.` },
    cases: results, aggregate: summarize(results),
  };
  return { report, skipped, comparison };
}

export interface Rescorability {
  report: string;
  evaluatorThatScoredIt: string | null;
  cases: number;
  rawOutputsPersisted: boolean;
  outputsFileLookedFor: string;
  rescorable: boolean;
  reason: string;
}

/**
 * Can an existing report be rescored? Only if its raw outputs were actually saved. A report that holds scores and check details
 * but no output text cannot be rescored, and its text is NOT regenerated or reconstructed.
 */
export function rescorability(reportPath: string, outputsDir = "docs/eval/outputs"): Rescorability {
  const r = JSON.parse(readFileSync(reportPath, "utf8")) as { label?: string; run?: { evaluator?: string }; cases?: unknown[] };
  const base = reportPath.replace(/\\/g, "/").split("/").pop()!.replace(/\.json$/, "");
  const outputs = `${outputsDir}/${base}.outputs.json`;
  const persisted = existsSync(outputs);
  return {
    report: reportPath.replace(/\\/g, "/"), evaluatorThatScoredIt: r.run?.evaluator ?? null, cases: r.cases?.length ?? 0,
    rawOutputsPersisted: persisted, outputsFileLookedFor: outputs, rescorable: persisted,
    reason: persisted
      ? "a saved outputs file exists and can be rescored offline"
      : "the model's output text was never persisted (the report holds scores and check details only), so it cannot be rescored. It is not regenerated or reconstructed, because that would be a different result.",
  };
}
