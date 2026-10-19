import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMockBrief } from "../src/ai/mockBrief.js";
import { buildAiStack } from "../src/ai/stack.js";
import { EVAL_SERVICE_TIER, evaluationEnv } from "../src/eval/evalPolicy.js";
import { EVALUATOR_VERSION, runEvaluation, type EvalReport } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { makeLiveGenerator } from "../src/eval/liveRun.js";
import { OUTPUT_ARTIFACT_VERSION, OutputStore, fixtureSha256, loadArtifact, recordFromGeneration, rescoreArtifact, rescorability, scoredBlock, type OutputArtifact } from "../src/eval/outputs.js";
import { renderComparison } from "../src/eval/report.js";
import { currentGenerationIdentity } from "../src/app/versions.js";

const KEY = "sk-TEST-FAKE-savedoutputs-0000000000000";
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "outputs-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const c0 = EVAL_CASES[0]!;
const c1 = EVAL_CASES[1]!;
const c2 = EVAL_CASES[2]!;
const c3 = EVAL_CASES[3]!;
const briefOf = (c: (typeof EVAL_CASES)[number]) => buildMockBrief(c.brain) as Record<string, any>;

function transport(replies: Array<{ headers?: Record<string, string>; body: unknown; status?: number }>) {
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    seen.push(String(url));
    const r = replies[seen.length - 1]!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}
const body = (text: string, o: { tier?: string | null; id?: string } = {}) => ({
  object: "response", id: o.id ?? "resp_x1", model: "gpt-6-luna-2026-10-01", status: "completed",
  output: [{ type: "message", role: "assistant", id: "m1", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
  usage: { input_tokens: 1700, output_tokens: 600, total_tokens: 2300, output_tokens_details: { reasoning_tokens: 0 } },
  ...(o.tier === null ? {} : { service_tier: o.tier ?? "default" }),
});
const stack = (t: ReturnType<typeof transport>) => buildAiStack({ env: evaluationEnv({ AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", OPENAI_API_KEY: KEY }, { repair: 0, retries: 0, maxOutputTokens: 2500 }), fetch: t.fetchImpl });
const generator = (t: ReturnType<typeof transport>) => makeLiveGenerator({ gateway: stack(t).gateway, provider: "openai", model: "gpt-6-luna", prompt: "current", budgetMicros: 100_000, maxOutputTokens: 2500, reserveForCase: () => 2_418, maxAttemptsPerRequest: 1, haltOnUnknownCost: true, expectedServiceTier: EVAL_SERVICE_TIER });

/** Runs the evaluation exactly the way the command does: save each output before scoring, attach scores after. */
async function runSaved(path: string, cases: typeof EVAL_CASES, replies: Parameters<typeof transport>[0], hooks: { beforeScore?: () => void } = {}) {
  const t = transport(replies);
  const g = generator(t);
  const store = new OutputStore(path, { label: "inv", source: "test" });
  const report = await runEvaluation(cases, g.generate, "inv", "test", { evaluator: EVALUATOR_VERSION }, {
    onGenerated: (c, out) => { hooks.beforeScore?.(); store.add(recordFromGeneration("inv", c, out)); },
    onScored: (c, _o, s) => store.attachScore(c.id, scoredBlock(s)),
  });
  return { report, store, t, g };
}

describe("every synthetic output is saved with its identifiers, before and after scoring", () => {
  it("records the case, requested and returned model, versions and fingerprints, evaluator, raw text, parsed output, usage, ids, tier, cost and final scores", async () => {
    const path = join(tmp(), "a.outputs.json");
    const text0 = JSON.stringify(briefOf(c0));
    const { t } = await runSaved(path, [c0], [{ headers: { "x-request-id": "req_save_1" }, body: body(text0) }]);
    expect(t.seen).toHaveLength(1);
    const a = loadArtifact(path);
    expect(a.artifactVersion).toBe(OUTPUT_ARTIFACT_VERSION);
    const r = a.records[0]!;
    const id = currentGenerationIdentity();
    expect(r).toMatchObject({
      invocation: "inv", caseId: c0.id, fixtureSha256: fixtureSha256(c0),
      requestedModel: "gpt-6-luna", returnedModel: "gpt-6-luna-2026-10-01", requestedServiceTier: "default", returnedServiceTier: "default",
      promptVersion: id.promptVersion, promptSha256: id.promptSha256, schemaVersion: id.schemaVersion, schemaSha256: id.schemaSha256, evaluatorVersion: EVALUATOR_VERSION,
      responseId: "resp_x1", requestId: "req_save_1", responseStatus: "completed",
      usage: { inputTokens: 1700, outputTokens: 600 }, costStatus: "estimated", estimatedCostMicros: 470,
      validationErrors: null, generationError: null, failure: null,
    });
    expect(r.rawText).toBe(text0); // exactly what the provider returned
    expect(r.parsedOutput).toMatchObject({ name: briefOf(c0).name, objective: "OUTCOME_LEADS" });
    expect(r.scored).toMatchObject({ evaluatorVersion: EVALUATOR_VERSION, schemaValid: true, hardFail: false });
    expect(Object.keys(r.scored!.scores)).toEqual(expect.arrayContaining(["schemaValidity", "factualGrounding", "differentiatorUse", "budgetPolicy", "targetingRationale", "missingInfo", "creativeUsefulness"]));
    expect(r.scored!.checks.length).toBeGreaterThan(10);
    expect(r.scored!.comparable.overall).toBeGreaterThan(0);
  });

  it("an output that fails its contract keeps its text, the parsed object that was scored, and the validation errors", async () => {
    const long = { ...briefOf(c1), primaryTexts: ["T".repeat(126), "ok"] };
    const path = join(tmp(), "b.outputs.json");
    await runSaved(path, [c1], [{ headers: { "x-request-id": "req_long" }, body: body(JSON.stringify(long)) }]);
    const r = loadArtifact(path).records[0]!;
    expect(r.rawText).toBe(JSON.stringify(long));
    expect((r.parsedOutput as { primaryTexts: string[] }).primaryTexts[0]).toHaveLength(126);
    expect(r.validationErrors).toMatch(/at most 125/);
    expect(r).toMatchObject({ requestId: "req_long", returnedServiceTier: "default" });
    expect(r.scored).toMatchObject({ schemaValid: false });
  });

  it("malformed JSON and a cut-off answer keep the text they did produce, and no parsed object is invented", async () => {
    const path = join(tmp(), "c.outputs.json");
    const cut = { ...body("{\"na"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    await runSaved(path, [c0, c1], [{ headers: { "x-request-id": "req_bad" }, body: body("{not json") }, { headers: { "x-request-id": "req_cut" }, body: cut }]);
    const [bad, truncated] = loadArtifact(path).records;
    expect(bad).toMatchObject({ rawText: "{not json", parsedOutput: null, failure: "error", requestId: "req_bad", returnedServiceTier: "default" });
    expect(bad!.generationError).toMatch(/malformed JSON/);
    expect(truncated).toMatchObject({ rawText: "{\"na", parsedOutput: null, failure: "truncated", requestId: "req_cut" });
    expect(bad!.scored).not.toBeNull(); // a failed generation is still scored (zero), and recorded
  });

  it("a response rejected for its tier keeps its text as evidence but is never scored as a campaign", async () => {
    const path = join(tmp(), "d.outputs.json");
    const text = JSON.stringify(briefOf(c0));
    await runSaved(path, [c0], [{ headers: { "x-request-id": "req_prio" }, body: body(text, { tier: "priority" }) }]);
    const r = loadArtifact(path).records[0]!;
    expect(r).toMatchObject({ rawText: text, parsedOutput: null, returnedServiceTier: "priority", requestedServiceTier: "default", requestId: "req_prio", failure: "error" });
    expect(r.generationError).toMatch(/^response_rejected: stopped:/);
  });

  it("the output is on disk BEFORE it is scored, and the file grows request by request", async () => {
    const path = join(tmp(), "e.outputs.json");
    const seenBeforeScoring: number[] = [];
    await runSaved(path, [c0, c1, c2], [0, 1, 2].map((i) => ({ headers: { "x-request-id": `req_${i}` }, body: body(JSON.stringify(briefOf([c0, c1, c2][i]!))) })), { beforeScore: () => seenBeforeScoring.push(existsSync(path) ? loadArtifact(path).records.length : -1) });
    expect(seenBeforeScoring).toEqual([0, 1, 2]); // each time, the previous records were already durable
    const a = loadArtifact(path);
    expect(a.records.map((r) => r.caseId)).toEqual([c0.id, c1.id, c2.id]);
    expect(a.records.every((r) => r.scored !== null)).toBe(true);
  });

  it("a failure while scoring cannot lose the text: the record was already saved", async () => {
    const path = join(tmp(), "f.outputs.json");
    const t = transport([{ headers: { "x-request-id": "req_f" }, body: body(JSON.stringify(briefOf(c0))) }]);
    const store = new OutputStore(path, { label: "inv", source: "test" });
    await expect(runEvaluation([c0], generator(t).generate, "inv", "test", undefined, {
      onGenerated: (c, out) => store.add(recordFromGeneration("inv", c, out)),
      onScored: () => { throw new Error("scoring blew up"); },
    })).rejects.toThrow(/scoring blew up/);
    const r = loadArtifact(path).records[0]!;
    expect(r.rawText).toBe(JSON.stringify(briefOf(c0)));
    expect(r.scored).toBeNull(); // honestly unscored
  });

  it("contains no credential, header or prompt: only synthetic text, identifiers and scores", async () => {
    const path = join(tmp(), "g.outputs.json");
    await runSaved(path, [c0], [{ headers: { "x-request-id": "req_g", authorization: "Bearer should-never-appear" }, body: body(JSON.stringify(briefOf(c0))) }]);
    const raw = readFileSync(path, "utf8");
    for (const forbidden of [KEY, "authorization", "Bearer", "x-request-id", "sk-", "should-never-appear", "You are a marketing strategist"]) expect(raw, forbidden).not.toContain(forbidden);
    expect(Object.keys(JSON.parse(raw).records[0]).sort()).toEqual(["artifactVersion", "caseId", "costStatus", "estimatedCostMicros", "evaluatorVersion", "fixtureSha256", "generationError", "failure", "invocation", "parsedOutput", "promptSha256", "promptVersion", "rawText", "requestId", "requestedModel", "requestedServiceTier", "responseId", "responseStatus", "returnedModel", "returnedServiceTier", "schemaSha256", "schemaVersion", "scored", "usage", "validationErrors"].sort());
  });

  it("refuses to overwrite an existing outputs file: it is evidence", () => {
    const path = join(tmp(), "h.outputs.json");
    new OutputStore(path, { label: "inv", source: "test" });
    expect(() => new OutputStore(path, { label: "inv", source: "test" })).toThrow(/refusing to overwrite the saved outputs/);
  });

  it("provider text never reaches the gateway's caller or the usage log unless it is asked for", async () => {
    const t = transport([{ body: body(JSON.stringify(briefOf(c0))) }, { body: body("{not json") }]);
    const s = stack(t);
    const req = { task: "t", system: "s", prompt: "p", schemaHint: "{}", context: {}, schema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never, model: "gpt-6-luna" };
    const ok = await s.gateway.generate("openai", req);
    expect(ok.rawText).toBeUndefined();
    expect(JSON.stringify(ok.attempts)).not.toContain("OUTCOME_LEADS"); // attempt records (what the usage log stores) never hold provider text
    const err = await s.gateway.generate("openai", req).catch((e) => e);
    expect(err.rawText).toBeUndefined();
    expect(JSON.stringify(err.attempts)).not.toContain("not json");
    const t2 = transport([{ body: body(JSON.stringify(briefOf(c0))) }, { body: body("{not json") }]);
    const s2 = stack(t2);
    expect((await s2.gateway.generate("openai", req, { captureRawText: true })).rawText).toBe(JSON.stringify(briefOf(c0)));
    expect(((await s2.gateway.generate("openai", req, { captureRawText: true }).catch((e) => e)) as { rawText?: string }).rawText).toBe("{not json");
  });
});

/* ================================================================================================= rescoring */
describe("saved outputs can be rescored without a model call", () => {
  const nameWith = (c: (typeof EVAL_CASES)[number], name: string) => ({ ...briefOf(c), name });

  /** An artifact as evaluator 3.2.0 would have saved it: it scored "Lead Generation" as an unsupported ownership claim. */
  function oldArtifact(): OutputArtifact {
    const c = EVAL_CASES.find((x) => x.id === "electrician-negated-and-pending-facts")!;
    const brief = nameWith(c, "Brightwire Electric - Lead Generation");
    const rec = recordFromGeneration("old", c, { raw: brief, rawText: JSON.stringify(brief), meta: { identity: currentGenerationIdentity() } });
    rec.evaluatorVersion = "campaign-evaluator/3.2.0";
    rec.scored = { evaluatorVersion: "campaign-evaluator/3.2.0", schemaValid: true, qualityPassed: false, hardFail: true, passed: false, overall: 0.9, scores: {} as never, comparable: { scores: {}, overall: 0.9, hardFail: true, passed: false }, checks: [] };
    return { artifactVersion: OUTPUT_ARTIFACT_VERSION, label: "old", source: "test", createdAt: "t", records: [rec] };
  }

  it("rescores a copy with the current evaluator, keeps the original scores and evaluator, and shows what changed", () => {
    const a = oldArtifact();
    const before = JSON.stringify(a);
    const { report, comparison, skipped } = rescoreArtifact(a, "old-rescored");
    expect(skipped).toEqual([]);
    expect(report.run?.evaluator).toBe("campaign-evaluator/3.3.0");
    expect(report.source).toMatch(/RESCORED from saved outputs .* no model was called/);
    expect(comparison[0]).toMatchObject({ original: { evaluator: "campaign-evaluator/3.2.0", hardFail: true }, rescored: { evaluator: "campaign-evaluator/3.3.0" } });
    expect(report.cases[0]!.checks.find((k) => k.id === "claims_supported")?.pass).toBe(true); // the false positive is gone
    expect(JSON.stringify(a)).toBe(before); // the saved artifact (and its original scores) was not touched
  });
  it("makes no network request", () => {
    expect(String(globalThis.fetch)).toMatch(/NETWORK BLOCKED in tests/);
    expect(() => rescoreArtifact(oldArtifact(), "x")).not.toThrow(); // and the global blocking stub would fail the file if it were called
  });
  it("round-trips a real saved file: save, load, rescore", async () => {
    const path = join(tmp(), "rt.outputs.json");
    await runSaved(path, [c0, c1, c3], [c0, c1, c3].map((c, i) => ({ headers: { "x-request-id": `req_rt${i}` }, body: body(JSON.stringify(briefOf(c))) })));
    const { report, comparison } = rescoreArtifact(loadArtifact(path), "rt-rescored");
    expect(report.aggregate.total).toBe(3);
    for (const x of comparison) expect(x.rescored.overall).toBeCloseTo(x.original!.overall, 10); // same evaluator, same input: same score
  });
  it("a record that was never output is rescored as a failed generation; no text is invented", async () => {
    const path = join(tmp(), "fail.outputs.json");
    await runSaved(path, [c0], [{ headers: { "x-request-id": "req_503" }, status: 503, body: { error: { type: "server_error", code: null, message: "x" } } }]);
    const rec = loadArtifact(path).records[0]!;
    expect(rec).toMatchObject({ rawText: null, parsedOutput: null, requestId: "req_503" });
    const { report } = rescoreArtifact(loadArtifact(path), "fail-rescored");
    expect(report.cases[0]).toMatchObject({ generated: false });
    expect(report.cases[0]!.overall).toBe(0);
  });
  it("skips, and says why, when the fixture has changed or the case no longer exists", () => {
    const a = oldArtifact();
    a.records[0]!.fixtureSha256 = "0".repeat(64);
    const ghost = { ...a.records[0]!, caseId: "no-such-case" };
    const r = rescoreArtifact({ ...a, records: [a.records[0]!, ghost] }, "skip");
    expect(r.report.cases).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason)).toEqual([expect.stringMatching(/fixture has changed/), expect.stringMatching(/no longer exists/)]);
  });
});

/* ================================================================================ results that cannot be rescored */
describe("existing results whose text was never saved are reported as unrescorable, not reconstructed", () => {
  it("both completed invocations: no output text was persisted, so they cannot be rescored", () => {
    for (const f of ["cmp-3-2-original-rep1", "cmp-3-2-current-rep1"]) {
      const r = rescorability(`docs/eval/${f}-openai-gpt_6_luna.json`);
      expect(r).toMatchObject({ evaluatorThatScoredIt: "campaign-evaluator/3.2.0", cases: 14, rawOutputsPersisted: false, rescorable: false });
      expect(r.reason).toMatch(/never persisted.*cannot be rescored.*not regenerated or reconstructed/);
    }
  });
  it("nothing on disk holds those outputs: the reports carry no output text and no saved outputs file exists", () => {
    expect(existsSync("docs/eval/outputs/cmp-3-2-original-rep1-openai-gpt_6_luna.outputs.json")).toBe(false);
    expect(existsSync("docs/eval/outputs/cmp-3-2-current-rep1-openai-gpt_6_luna.outputs.json")).toBe(false);
    for (const f of ["cmp-3-2-original-rep1", "cmp-3-2-current-rep1"]) {
      const j = JSON.stringify(JSON.parse(readFileSync(`docs/eval/${f}-openai-gpt_6_luna.json`, "utf8")));
      expect(j).not.toMatch(/"(headlines|primaryTexts|rawText|parsedOutput)"\s*:/);
    }
  });
  it("a report with a saved outputs file next to it is reported as rescorable", () => {
    const dir = tmp();
    writeFileSync(join(dir, "r.json"), JSON.stringify({ run: { evaluator: "campaign-evaluator/3.3.0" }, cases: [{}, {}] }));
    mkdirSync(join(dir, "outputs"));
    writeFileSync(join(dir, "outputs", "r.outputs.json"), "{}");
    expect(rescorability(join(dir, "r.json"), join(dir, "outputs"))).toMatchObject({ rawOutputsPersisted: true, rescorable: true, cases: 2 });
  });
  it("the historical reports are byte-for-byte what they were when committed: original scores and evaluator version preserved", () => {
    const h = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    expect(h("docs/eval/cmp-3-2-original-rep1-openai-gpt_6_luna.json")).toBe("b39a1e02a729483027351a8da699d24017d3b83095f41f2f57632c28f8894def");
    expect(h("docs/eval/cmp-3-2-current-rep1-openai-gpt_6_luna.json")).toBe("2d6d0346e44ef5d1266368d177940349d28874cb94354a5412e9158118d6b396");
    expect(h("docs/eval/cmp-3-2-original-rep1-openai-gpt_6_luna.md")).toBe("8d6317b0c74465dd0ae39d9d0210358318c63a0f7717e3f26f1b4999f695951b");
  });
});

/* ================================================================================ cohorts are never pooled */
describe("results from different evaluator versions are never compared or pooled", () => {
  const load = (f: string) => JSON.parse(readFileSync(`docs/eval/${f}-openai-gpt_6_luna.json`, "utf8")) as EvalReport;
  it("two repetition-1 reports (both 3.2.0) can be compared with each other", () => {
    expect(() => renderComparison(load("cmp-3-2-original-rep1"), load("cmp-3-2-current-rep1"), { a: "original", b: "current" })).not.toThrow();
  });
  it("a 3.2.0 report and a 3.3.0 report are refused, with an explanation", () => {
    const corrected = { ...load("cmp-3-2-current-rep1"), run: { ...load("cmp-3-2-current-rep1").run, evaluator: "campaign-evaluator/3.3.0" } } as EvalReport;
    expect(() => renderComparison(load("cmp-3-2-original-rep1"), corrected, { a: "original-rep1", b: "current-rep2" })).toThrow(/scored by different evaluators.*3\.2\.0.*3\.3\.0.*separate cohorts and are not compared or pooled/);
  });
});
