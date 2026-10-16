/**
 * Dry-run PLAN for comparing the recovered original campaign implementation with the current candidate. OFFLINE ONLY.
 *
 * It reads local configuration, source files and the saved results of earlier runs, counts requests, bounds their cost from the
 * locally recorded prices, and writes docs/eval/plan-original-vs-current.{md,json}. It sends nothing: global fetch is replaced with a
 * function that throws, so an accidental network call would fail loudly. It does not check model access (that needs the network).
 *
 *   npm run eval:plan
 *   npm run eval:plan -- --reps 3 --max-output 2500 --ceiling 156000
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

(globalThis as { fetch: unknown }).fetch = () => { throw new Error("eval-plan is offline: a network call was attempted"); };

import { PricingTable } from "../src/ai/pricing.js";
import { buildCampaignPrompt } from "../src/app/campaignPrompt.js";
import { CAMPAIGN_SCHEMA_VERSION, currentGenerationIdentity } from "../src/app/versions.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { REGIONAL_UPLIFT, absoluteInputTokens, actualMicros, estimatedInputTokens, requestText, reserveWithUplift, worstCaseMicros } from "../src/eval/costBound.js";
import { DIMENSION_LABELS, DIMENSION_PASS, DIMENSIONS, EVALUATOR_VERSION } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { buildLegacyPrompt } from "../src/eval/liveRun.js";
import { ORIGINAL_HINT, ORIGINAL_JSON_SCHEMA, buildOriginalPrompt, originalGenerationIdentity } from "../src/eval/original.js";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? (process.argv[i + 1] ?? d) : d; };
const REPS = Number(arg("reps", "2"));
const MAX_OUT = Number(arg("max-output", "2500"));
const CEILING = Number(arg("ceiling", "156000")); // the approved maximum aggregate spend, in micro-USD
const ALLOWANCE = Number(arg("access-allowance", "500")); // charged to the budget per access check, because the provider documents no billing for it
const UPLIFT = REGIONAL_UPLIFT; // the documented regional-processing uplift; applied to every reserve because it cannot be ruled out for this account
const PROVIDER = "openai";
const MODEL = "gpt-6-luna";
const SERVICE_TIER = "default";
const DOCS_READ_ON = "2026-10-16";
const WRITE = !process.argv.includes("--no-write"); // --no-write: compute and print only, leaving the committed plan files untouched

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fileSha = (p: string) => sha(readFileSync(p, "utf8").replace(/\r\n/g, "\n")); // line endings differ by checkout; the content is what matters
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;

const pricing = PricingTable.fromFile("config/ai-pricing.json");
const price = pricing.entry(PROVIDER, MODEL);
if (!price) { console.error(`No locally recorded price for ${PROVIDER}/${MODEL}: a cost bound cannot be computed, so no live run may be planned.`); process.exit(1); }
const models = JSON.parse(readFileSync("config/ai-models.json", "utf8")) as { models?: Array<Record<string, unknown>>; entries?: Array<Record<string, unknown>> };
const entry = (models.models ?? models.entries ?? []).find((e) => e.provider === PROVIDER && e.model === MODEL) as Record<string, unknown> | undefined;

type Arm = "original" | "current";
const ARMS: Arm[] = ["original", "current"];
type Case = (typeof EVAL_CASES)[number];
const promptFor = (arm: Arm, c: Case) => (arm === "original" ? buildOriginalPrompt(c.brain) : buildCampaignPrompt(c.brain, { asOf: new Date("2026-10-16T12:00:00Z") }));
const contractFor = (arm: Arm) => (arm === "original" ? JSON.stringify(ORIGINAL_JSON_SCHEMA) + ORIGINAL_HINT : JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA) + CAMPAIGN_BRIEF_HINT);

const longThreshold = price.longContext?.aboveInputTokens ?? Infinity;
const perCase = EVAL_CASES.map((c) => {
  const row = { id: c.id } as Record<string, unknown>;
  for (const arm of ARMS) {
    const text = requestText(promptFor(arm, c), contractFor(arm));
    const est = estimatedInputTokens(text);
    const abs = absoluteInputTokens(text);
    if (abs > longThreshold) throw new Error(`${c.id}/${arm}: even the estimate exceeds the long-context threshold; the cost model would be wrong`);
    row[arm] = { chars: text.length, estimatedInputTokens: est, absoluteInputTokens: abs, estimatedWorstMicros: worstCaseMicros(est, MAX_OUT, price), absoluteWorstMicros: reserveWithUplift(abs, MAX_OUT, price) };
  }
  return row as { id: string } & Record<Arm, { chars: number; estimatedInputTokens: number; absoluteInputTokens: number; estimatedWorstMicros: number; absoluteWorstMicros: number }>;
});
const sum = (arm: Arm, k: "estimatedWorstMicros" | "absoluteWorstMicros") => perCase.reduce((s, r) => s + r[arm][k], 0);
const maxOf = (arm: Arm, k: "estimatedWorstMicros" | "absoluteWorstMicros") => Math.max(...perCase.map((r) => r[arm][k]));
const requests = EVAL_CASES.length * ARMS.length * REPS;
const estPerRep = { original: sum("original", "estimatedWorstMicros"), current: sum("current", "estimatedWorstMicros") };
const absPerRep = { original: sum("original", "absoluteWorstMicros"), current: sum("current", "absoluteWorstMicros") };
const estTotal = (estPerRep.original + estPerRep.current) * REPS;
const absTotal = (absPerRep.original + absPerRep.current) * REPS;

// Budgets: what is left after the access-check allowance, split between the arms in proportion to their estimated cost, rounded down to 500.
const checksAllowed = Number(arg("access-checks", "0")); // this plan uses none: the live diagnostic already showed the key and the model work
const perRepBudget = Math.floor((CEILING - checksAllowed * ALLOWANCE) / REPS / 500) * 500;
// Split in proportion to the ABSOLUTE worst case, so each budget covers its arm's whole absolute worst case whenever the ceiling allows it.
const originalBudget = Math.floor((perRepBudget * absPerRep.original) / (absPerRep.original + absPerRep.current) / 500) * 500;
const budgets = { original: originalBudget, current: perRepBudget - originalBudget };
const maxCommitted = REPS * (budgets.original + budgets.current) + checksAllowed * ALLOWANCE;
const budgetsCoverAbsolute = budgets.original >= absPerRep.original && budgets.current >= absPerRep.current;

/* ---- reconciliation: the exact sum of the per-case reserves versus the simple "maximum x requests" figure ---- */
const reservesOf = (arm: Arm) => perCase.map((r) => r[arm].absoluteWorstMicros);
const armStats = (arm: Arm) => { const rs = reservesOf(arm); const max = Math.max(...rs); return { requestsPerRepetition: rs.length, perCase: rs, min: Math.min(...rs), max, sumPerRepetition: rs.reduce((a, b) => a + b, 0), maxTimesRequests: max * rs.length }; };
const stats = { original: armStats("original"), current: armStats("current") };
const exactTotal = REPS * (stats.original.sumPerRepetition + stats.current.sumPerRepetition);
const simpleUpperBound = REPS * (stats.original.maxTimesRequests + stats.current.maxTimesRequests);
const budgetsCoverMaxBound = budgets.original >= stats.original.maxTimesRequests && budgets.current >= stats.current.maxTimesRequests;
const diagnosticLedger = existsSync("docs/live-verification/ledger-tier-diagnostic.json") ? (JSON.parse(readFileSync("docs/live-verification/ledger-tier-diagnostic.json", "utf8")) as { entries: Array<{ chargedMicros?: number; requests: number; status: string }> }) : undefined;
const diagnosticSpend = diagnosticLedger ? diagnosticLedger.entries.reduce((s, e) => s + (e.chargedMicros ?? 0), 0) : 0;

/* ---- calibration: the estimate against requests that were actually billed (committed evidence, no new request) ---- */
interface Calib { arm: string; id: string; billedIn: number; billedOut: number; billedMicros: number; estIn: number; absIn: number; ratioBilledToEstimate: number; estWorst: number }
const calib: Calib[] = [];
for (const v of ["current", "legacy"] as const) {
  const p = `docs/eval/m3-live2-${v}-openai-gpt_6_luna.json`;
  if (!existsSync(p)) continue;
  const r = JSON.parse(readFileSync(p, "utf8")) as { cases: Array<{ caseId: string; generated: boolean; meta?: { inputTokens?: number; outputTokens?: number; costMicros?: number } }> };
  for (const c of r.cases) {
    const fx = EVAL_CASES.find((x) => x.id === c.caseId);
    if (!fx || c.meta?.inputTokens === undefined) continue;
    const text = requestText(v === "current" ? promptFor("current", fx) : buildLegacyPrompt(fx.brain), contractFor("current")); // the legacy run used the CURRENT contract
    calib.push({ arm: v, id: c.caseId, billedIn: c.meta.inputTokens, billedOut: c.meta.outputTokens ?? 0, billedMicros: c.meta.costMicros ?? 0, estIn: estimatedInputTokens(text), absIn: absoluteInputTokens(text), ratioBilledToEstimate: c.meta.inputTokens / estimatedInputTokens(text), estWorst: worstCaseMicros(estimatedInputTokens(text), MAX_OUT, price) });
  }
}
const ratios = calib.map((c) => c.ratioBilledToEstimate);
const spendShare = calib.map((c) => c.billedMicros / c.estWorst);
const recomputedOk = calib.every((c) => Math.abs(actualMicros(c.billedIn, c.billedOut, price) - c.billedMicros) <= 1);
const expectedLow = Math.round(estTotal * Math.min(...spendShare));
const expectedHigh = Math.round(estTotal * Math.max(...spendShare));

/* ---- the live diagnostic's recorded result (committed evidence; read, not re-run) ---- */
interface DiagSummary { date: string; maxOut: number; http: number; requestId: string; tier: string; model: string; input: number; output: number; reasoning: number; cost: number; passed: number; total: number; file: string }
const diagFile = existsSync("docs/live-verification") ? readdirSync("docs/live-verification").filter((f) => f.startsWith("openai-tier-diagnostic-")).sort().pop() : undefined;
const diag: DiagSummary | undefined = diagFile ? (() => {
  const d = JSON.parse(readFileSync("docs/live-verification/" + diagFile, "utf8")) as Record<string, any>;
  return { date: String(d.startedAt).slice(0, 10), maxOut: d.request.sent.max_output_tokens, http: d.http.status, requestId: d.http.requestId, tier: d.response.service_tier, model: d.response.model, input: d.response.usage.input_tokens, output: d.response.usage.output_tokens, reasoning: d.response.usage.output_tokens_details?.reasoning_tokens ?? 0, cost: d.calculatedCostMicros, passed: d.checks.filter((c: any) => c.pass).length, total: d.checks.length, file: "docs/live-verification/" + diagFile };
})() : undefined;

const sources = ["src/eval/evaluate.ts", "src/eval/fixtures.ts", "src/eval/report.ts", "src/eval/liveRun.ts", "src/eval/costBound.ts", "src/eval/ledger.ts", "src/eval/original.ts", "src/domain/briefRules.ts", "src/domain/facts.ts", "src/domain/schemas.ts", "src/domain/campaignJsonSchema.ts", "src/app/campaignPrompt.ts", "src/ai/openaiProvider.ts", "src/ai/stack.ts", "src/eval/evalPolicy.ts", "src/eval/tierDiagnostic.ts", "scripts/eval-campaigns.ts"];
const fingerprints = Object.fromEntries(sources.map((s) => [s, fileSha(s)]));
const fixturesSha = sha(JSON.stringify(EVAL_CASES.map((c) => ({ id: c.id, brain: c.brain, expect: String(c.expect.mustNotContain ?? "") }))));
const cur = currentGenerationIdentity();
const orig = originalGenerationIdentity();

const commands: string[] = [];
const common = `--models ${PROVIDER}/${MODEL} --max-output ${MAX_OUT} --repair 0 --retries 0 --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros ${CEILING} --max-total-requests ${requests}`;
for (let r = 1; r <= REPS; r++) for (const arm of ARMS) commands.push(`npm run eval:campaigns -- ${common} --prompt ${arm} --budget-micros ${budgets[arm]} --label cmp-3-2-${arm}-rep${r}${r === 1 && arm === "original" && checksAllowed > 0 ? " --check-access" : ""} --yes-spend`);

const plan = {
  generatedAt: new Date().toISOString(),
  networkUsed: false,
  status: "PLAN ONLY. Nothing here has been sent, and model access has not been checked.",
  approvedSettings: { model: MODEL, cases: EVAL_CASES.length, arms: ARMS, repetitionsPerCasePerArm: REPS, plannedGenerations: requests, maxOutputTokens: MAX_OUT, maxAggregateSpendMicros: CEILING, retries: 0, repairs: 0, externalActions: "prohibited", deployment: "local only", serviceTier: SERVICE_TIER, responseStorage: "disabled (store:false)" },
  model: { provider: PROVIDER, id: MODEL, registryEntrySha256: sha(JSON.stringify(entry ?? null)), providerSnapshot: "not pinned: the provider id is an alias with no dated snapshot listed; the response's model id and service tier are recorded per request" },
  price: { ...price, serviceTier: SERVICE_TIER, status: `recorded locally ${price.asOf}; the public pricing and models pages were read again on ${DOCS_READ_ON} (see the document); the figures matched`, regionalUpliftApplied: UPLIFT },
  design: { cases: EVAL_CASES.length, arms: ARMS, repetitionsPerCasePerArm: REPS, primaryRequests: requests, retriesAllowed: 0, repairAttemptsAllowed: 0, maxOutputTokens: MAX_OUT, maxRequestsIncludingRetries: requests },
  identifiers: { prompts: { original: orig.promptVersion, current: cur.promptVersion }, promptSha256: { original: orig.promptSha256, current: cur.promptSha256 }, schemas: { original: orig.schemaVersion, current: cur.schemaVersion }, schemaSha256: { original: orig.schemaSha256, current: cur.schemaSha256 }, evaluator: EVALUATOR_VERSION, evaluatorSourceSha256: fingerprints, fixturesSha256: fixturesSha, configSha256: { "config/ai-models.json": fileSha("config/ai-models.json"), "config/ai-pricing.json": fileSha("config/ai-pricing.json"), "config/prompt-versions.json": fileSha("config/prompt-versions.json") } },
  cost: {
    // kept under these names for earlier consumers: the ESTIMATED worst case
    perRepWorstCaseMicros: estPerRep, worstCaseTotalMicros: estTotal,
    estimatedWorstCase: { perRepetitionMicros: estPerRep, totalMicros: estTotal, basis: "characters / 3 + 400 input tokens, full output cap, standard rates" },
    absoluteWorstCase: { perRepetitionMicros: absPerRep, totalMicros: absTotal, perRequestMaxMicros: { original: maxOf("original", "absoluteWorstMicros"), current: maxOf("current", "absoluteWorstMicros") }, basis: `one input token per UTF-8 byte (cannot be exceeded), full output cap, standard rates x ${UPLIFT} regional uplift` },
    observedSpendShareOfEstimatedWorst: { min: Math.min(...spendShare), max: Math.max(...spendShare), samples: spendShare.length },
    expectedTotalMicros: { low: expectedLow, high: expectedHigh, basis: "estimated worst case x the share actually billed in six earlier requests; an expectation, not a bound" },
    hardCeilingMicros: CEILING,
    perInvocationBudgetMicros: budgets,
    reservation: { original: stats.original, current: stats.current, exactTotalMicros: exactTotal, simpleUpperBoundMicros: simpleUpperBound, differenceMicros: simpleUpperBound - exactTotal, budgetsCoverMaxTimesRequests: budgetsCoverMaxBound, requestsPerInvocation: EVAL_CASES.length, invocations: ARMS.length * REPS },
    priorDiagnosticSpendMicros: diagnosticSpend,
    accessCheckAllowanceMicros: ALLOWANCE, maxAccessChecksCharged: checksAllowed,
    maxCommittedMicros: maxCommitted, budgetsCoverAbsoluteWorstCase: budgetsCoverAbsolute,
    inputTokensPerRep: { original: perCase.reduce((s, r) => s + r.original.estimatedInputTokens, 0), current: perCase.reduce((s, r) => s + r.current.estimatedInputTokens, 0) },
  },
  calibration: { samples: calib, billedCostsMatchPriceTable: recomputedOk, billedToEstimatedInputRatio: { min: Math.min(...ratios), max: Math.max(...ratios) } },
  perCase,
  commands,
};
mkdirSync("docs/eval", { recursive: true });
if (WRITE) writeFileSync("docs/eval/plan-original-vs-current.json", JSON.stringify(plan, null, 2) + "\n");

/* =============================================================================================== the document */
const L: string[] = [];
const row = (...c: string[]) => L.push(`| ${c.join(" | ")} |`);
const absFits = absTotal <= CEILING;
L.push("# Evaluation plan and preflight: recovered original vs current candidate (NOTHING SENT)", "");
L.push(`Generated ${plan.generatedAt} by \`npm run eval:plan\`. **This script made no network request** (it replaces \`fetch\` with a function that throws) and no model call or provider-access check. The only network use in preparing this document was reading the provider's public documentation pages on ${DOCS_READ_ON}. The live comparison has not been started and needs your final authorization.`, "");

L.push("## 0. Approved settings", "");
row("Setting", "Value"); row("---", "---");
row("Model", `\`${MODEL}\` (provider \`${PROVIDER}\`)`); row("Cases", `${EVAL_CASES.length} synthetic business scenarios`); row("Arms", "reconstructed original implementation; current candidate");
row("Repetitions", `${REPS} per case per arm`); row("Planned generations", `${requests}`); row("Max output tokens per generation", `${MAX_OUT.toLocaleString("en-US")}`);
row("Maximum aggregate experimental spend", `${usd(CEILING)} (${CEILING} micro-USD)`); row("Automatic retries / repairs", "disabled / disabled"); row("External advertising and CRM actions", "prohibited"); row("Deployment", "local only");
row("Service tier", `explicitly \`${SERVICE_TIER}\` (standard), read back from every response`); row("Response storage", "explicitly disabled (`store: false`)");
L.push("");

L.push("## 1. What is compared", "");
L.push(`- **Arm A, original:** the recovered pre-Milestone-3 prompt, brief contract and Business Brain fields.`, `- **Arm B, current:** the candidate prompt and brief contract, with the full Business Brain.`, `- **Cases:** the same ${EVAL_CASES.length} synthetic businesses for both arms. All data is invented.`, `- **Identical for both arms:** model \`${PROVIDER}/${MODEL}\`, max output ${MAX_OUT} tokens, repair 0, retries 0, provider-default sampling, reasoning effort \`${String(entry?.reasoningEffort ?? "registry default")}\`, service tier \`${SERVICE_TIER}\` (pinned in the request and checked in the response).`, `- **Repetitions:** ${REPS} per case per arm, so run-to-run variation is measured and not hidden.`, "");
L.push("Cases: " + EVAL_CASES.map((c) => `\`${c.id}\``).join(", "), "");

L.push("## 2. Version identifiers", "");
row("Item", "Original arm", "Current arm"); row("---", "---", "---");
row("Prompt", `\`${orig.promptVersion}\``, `\`${cur.promptVersion}\``);
row("Prompt sha256", `\`${orig.promptSha256.slice(0, 16)}…\``, `\`${cur.promptSha256.slice(0, 16)}…\``);
row("Output contract", `\`${orig.schemaVersion}\``, `\`${CAMPAIGN_SCHEMA_VERSION}\``);
row("Contract sha256", `\`${orig.schemaSha256.slice(0, 16)}…\``, `\`${cur.schemaSha256.slice(0, 16)}…\``);
row("Business Brain sent", "9 original fields only", "full brain (facts projected into the fields the prompt names)");
L.push("", `- **Evaluator:** \`${EVALUATOR_VERSION}\`; source fingerprints for ${sources.length} files and the fixtures fingerprint \`${fixturesSha.slice(0, 16)}…\` are in the JSON file. Re-run \`npm run eval:plan\` after any code change: the fingerprints and numbers here are only valid for the code they were generated from.`);
L.push(`- **Model:** \`${PROVIDER}/${MODEL}\`. ${plan.model.providerSnapshot}.`);
L.push(`- **Config fingerprints:** models \`${plan.identifiers.configSha256["config/ai-models.json"].slice(0, 12)}…\`, pricing \`${plan.identifiers.configSha256["config/ai-pricing.json"].slice(0, 12)}…\`.`, "");

L.push("## 3. Pricing verification (documentation, read " + DOCS_READ_ON + ")", "");
L.push("Sources: [pricing](https://developers.openai.com/api/docs/pricing), [models](https://developers.openai.com/api/docs/models), [retrieve model](https://developers.openai.com/api/reference/resources/models/methods/retrieve). The page text was read through a fetch tool that summarises the page, so wording is the tool's; a person should glance at the pricing page before the run.", "");
row("Question", "What the official pages state", "Effect on this plan"); row("---", "---", "---");
row("Exact model id", "`gpt-6-luna` is listed on the models page under exactly that id. No dated snapshot id is listed.", "Id matches the registry. Because it is an alias, the response's model id is recorded per request so a silent change is visible.");
row("Standard rates", "$0.10 per 1M input, $0.50 per 1M output (short context). Matches `config/ai-pricing.json`.", `Used: input ${usd(price.inputPerMTokMicros)} / output ${usd(price.outputPerMTokMicros)} per 1M tokens.`);
row("Long-context pricing", "Applies above 272K input tokens (input $0.20, output $0.75).", `Does not apply: the largest possible input here is ${Math.max(...perCase.map((r) => Math.max(r.original.absoluteInputTokens, r.current.absoluteInputTokens))).toLocaleString("en-US")} tokens even counting one token per byte. The cost model refuses to run if an input could exceed the threshold.`);
row("Cached input", "$0.01 per 1M (cheaper than standard).", "Not relied on. A cache hit could only lower the bill, so the bound stays an upper bound.");
row("Batch / Flex", "Half the standard rates.", "Not used (synchronous requests). Could only lower the bill.");
row("Fast (priority)", "Twice the standard rates ($0.20 / $1.00).", `**Would double the cost.** The request pins \`service_tier: "${SERVICE_TIER}"\` and the run halts if a response reports any other tier or none.`);
row("Regional processing", "A 10% uplift 'for models released on or after March 5, 2026'. The page does not say whether `gpt-6-luna` qualifies (its knowledge cutoff is May 2026, so it may).", `Cannot be ruled out, so every reserve is multiplied by ${UPLIFT}.`);
row("Reasoning tokens", "The pricing page does not say how they are billed. The registry sets reasoning effort `none`, so little or no hidden reasoning is expected. Cost is computed from the provider-reported output tokens and the output cap limits them; whether reasoning tokens are inside that count is the provider's statement to confirm, and this plan did not verify it.", "Treated as output tokens inside the cap. A request that exceeded the cap would show as a cost above its reserve and halt the run.");
row("Responses API / structured outputs", "The models page does not list per-model endpoint or structured-output support.", "Supported in practice: earlier live requests used the Responses API with strict structured output and succeeded (docs/ai-verification.md).");
row("Ultrafast", "`gpt-6-luna` is not listed.", "Not applicable.");
L.push("", `**Conclusion on rates.** For these requests the applicable rate is the standard short-context rate ($0.10 / $0.50 per 1M), provided the standard tier is used. That is a consequence of pinning the tier and of the inputs being far below 272K tokens, not an assumption. The one rate that could still differ is the regional uplift, which is covered by the ${UPLIFT} factor. **The rates themselves are the provider's published prices; this plan cannot confirm what the account is actually billed.** The earlier six billed requests matched the price table to the micro-USD against the provider-reported token counts (${recomputedOk ? "re-checked here: yes" : "RE-CHECK FAILED"}), which confirms the arithmetic and not the invoice.`, "");

L.push("### Live service-tier diagnostic (already run, one request)", "");
if (diag) {
  L.push("One generation was made on " + diag.date + " to test the tier before any evaluation: `gpt-6-luna`, `service_tier: \"default\"`, " + diag.maxOut + " output tokens, synthetic input, no retries.", "");
  row("Observation", "Result"); row("---", "---");
  row("HTTP / request id", "HTTP " + diag.http + " / `" + diag.requestId + "`"); row("Returned service tier", "`" + diag.tier + "`"); row("Model returned", "`" + diag.model + "`");
  row("Usage", diag.input + " input, " + diag.output + " output (" + diag.reasoning + " reasoning) tokens"); row("Cost (price table)", diag.cost + " µUSD ($" + (diag.cost / 1e6).toFixed(6) + ")"); row("Checks passed", diag.passed + " of " + diag.total);
  L.push("", "Evidence: `" + diag.file + "`. This shows the endpoint accepts and reports the tier. It does not show the account's billing, and it did not send `store: false` (the adapter did not support it then).", "");
}
L.push("## 4. Request count and cost bound", "");
L.push(`- Primary requests: ${EVAL_CASES.length} cases × ${ARMS.length} arms × ${REPS} repetitions = **${requests}**. Retries and repairs are disabled, so the **maximum is also ${requests}**; a request that needs a second attempt halts the run.`);
L.push(`- Input tokens cannot be counted exactly offline, so three figures are kept apart: an **expectation** (from what was billed before), an **estimated worst case** (characters / 3 + ${400} tokens of headroom, full output cap) and an **absolute worst case** (one token per UTF-8 byte, which no tokenizer can exceed, full output cap, ×${UPLIFT}).`, "");
row("Basis", "Original, 1 repetition (14)", "Current, 1 repetition (14)", `All ${requests} requests`); row("---", "---", "---", "---");
row("Expected (from 6 billed requests)", "—", "—", `${expectedLow}–${expectedHigh} µUSD (${usd(expectedLow)}–${usd(expectedHigh)})`);
row("Estimated worst case", `${estPerRep.original} µUSD`, `${estPerRep.current} µUSD`, `**${estTotal} µUSD (${usd(estTotal)})**`);
row("Absolute worst case (bytes, ×" + UPLIFT + ")", `${absPerRep.original} µUSD`, `${absPerRep.current} µUSD`, `${absTotal} µUSD (${usd(absTotal)})`);
L.push("", `- **Approved ceiling:** ${CEILING} µUSD (${usd(CEILING)}). It is ${(CEILING / estTotal).toFixed(2)}× the estimated worst case. The absolute worst case, if every one of the ${requests} requests hit it, is ${absFits ? "within" : "**above**"} the ceiling (${absTotal} vs ${CEILING}).`);
if (!absFits) L.push(`- **What that means.** Static arithmetic alone cannot prove that all ${requests} requests fit if every input and output sat at its absolute maximum. What is guaranteed instead is that **spend cannot pass the ceiling**: before each request the run reserves that request's own absolute worst case on top of the spend measured so far, and refuses to send if the sum would pass its budget. In the impossible-in-practice absolute-worst world the run would stop early and record the remaining cases as not run. In the realistic world (the six billed requests used ${(Math.min(...spendShare) * 100).toFixed(0)}% to ${(Math.max(...spendShare) * 100).toFixed(0)}% of the estimated worst case) every request runs.`);
if (absFits) L.push(`- **What that means.** Even if every one of the ${requests} requests used its absolute maximum input and the full output cap, the total (${absTotal} µUSD) stays within the ceiling, so **no request can be blocked by the budget in any circumstance**, and the aggregate cannot pass the ceiling.`);
L.push(`- **Budgets.** ${checksAllowed === 0 ? "No access check is planned, so the whole ceiling is available." : `After a ${ALLOWANCE} µUSD allowance for each possible access check (up to ${checksAllowed}), the remainder is split.`} The ceiling is split between the invocations in proportion to each arm's absolute worst case: original **${budgets.original}** µUSD and current **${budgets.current}** µUSD per invocation. The most that can ever be committed is ${REPS} × (${budgets.original} + ${budgets.current})${checksAllowed ? ` + ${checksAllowed} × ${ALLOWANCE}` : ""} = **${maxCommitted} µUSD**, which is ${maxCommitted <= CEILING ? "within" : "ABOVE"} the ceiling. Each budget is ${budgetsCoverAbsolute ? "above" : "BELOW"} that arm's absolute worst case for one repetition (${absPerRep.original} and ${absPerRep.current})${budgetsCoverAbsolute ? ", so a budget can never block a request" : ""}.`);
L.push("", "### Reconciliation of the aggregate", "");
L.push(`Each invocation evaluates exactly **${EVAL_CASES.length}** requests (one per case, one arm); there are **${ARMS.length * REPS}** invocations. A reserve is computed **per request from that request's own input**, so the 14 values differ slightly. The largest single-request reserve per arm is ${stats.original.max} (original) and ${stats.current.max} (current); those are maxima, not the reserve of every request.`, "");
row("Arm", "Requests per invocation", "Smallest reserve", "Largest reserve", "Sum of the 14 actual reserves", "14 × largest"); row("---", "---", "---", "---", "---", "---");
row("Original", String(stats.original.requestsPerRepetition), String(stats.original.min), String(stats.original.max), String(stats.original.sumPerRepetition), String(stats.original.maxTimesRequests));
row("Current", String(stats.current.requestsPerRepetition), String(stats.current.min), String(stats.current.max), String(stats.current.sumPerRepetition), String(stats.current.maxTimesRequests));
L.push("", `- **Exact aggregate** = ${REPS} × (${stats.original.sumPerRepetition} + ${stats.current.sumPerRepetition}) = **${exactTotal} µUSD (${usd(exactTotal)})**. This is what the plan reports.`);
L.push(`- **Simple upper bound** = ${REPS} × (${EVAL_CASES.length} × ${stats.original.max} + ${EVAL_CASES.length} × ${stats.current.max}) = ${EVAL_CASES.length * REPS} × ${stats.original.max} + ${EVAL_CASES.length * REPS} × ${stats.current.max} = **${simpleUpperBound} µUSD (${usd(simpleUpperBound)})**. It assumes every request reserved the largest value for its arm, so it is higher by ${simpleUpperBound - exactTotal} µUSD (${stats.original.maxTimesRequests - stats.original.sumPerRepetition} + ${stats.current.maxTimesRequests - stats.current.sumPerRepetition} per repetition, × ${REPS}). Both figures are valid upper bounds; the second is the one to quote if a single simple number is wanted.`);
L.push(`- **Both are inside the ceiling** of ${CEILING} µUSD (headroom ${CEILING - simpleUpperBound} µUSD on the simple bound). Each invocation budget (original ${budgets.original}, current ${budgets.current}) covers its arm's exact sum **and** 14 × largest reserve: ${budgetsCoverAbsolute && budgetsCoverMaxBound ? "yes" : "NO"}.`);
L.push(`- **Spend already incurred, outside this ceiling:** the single service-tier diagnostic charged ${diagnosticSpend} µUSD to its own ledger (\`docs/live-verification/ledger-tier-diagnostic.json\`, ceiling 2000, one request). That ledger and the comparison ledger (\`docs/eval/ledger-cmp-3-2.json\`) are separate files for separate experiments; neither command reads or writes the other, so neither erases the other's spend. Earlier live runs are recorded in \`docs/eval/m3-live*\` and are not part of this experiment.`, "");
L.push(`- **Aggregate limit across invocations.** A ledger file (\`docs/eval/ledger-cmp-3-2.json\`) records every invocation before it sends anything. The command refuses to start if the committed total plus its own reserve would pass ${CEILING} µUSD or ${requests} requests, if an earlier invocation halted or never finished and has not been explicitly reconciled by a person (\`--reconcile\` with a written note, which is recorded), or if asked to change the limits of an existing ledger.`);
L.push("- **If anything charges more than its reserve** (the provider bills a rate not recorded here), the first such request is seen after the fact, the run halts, and the ledger refuses to continue. The worst consequence is therefore bounded by one request's overshoot, not the whole run.", "");

L.push("### Calibration of the input estimate against billed requests", "");
L.push("These six requests were billed in the second live run (`docs/eval/m3-live2-*`); the old arm there used the original prompt text with the current contract. No new request was made for this table.", "");
row("Arm", "Case", "Billed input", "Estimate (÷3 + 400)", "Billed ÷ estimate", "Bytes (absolute)"); row("---", "---", "---", "---", "---", "---");
for (const c of calib) row(c.arm, `\`${c.id}\``, String(c.billedIn), String(c.estIn), c.ratioBilledToEstimate.toFixed(2), String(c.absIn));
L.push("", `The estimate was above the billed input in every sample (billed was ${(Math.min(...ratios) * 100).toFixed(0)}% to ${(Math.max(...ratios) * 100).toFixed(0)}% of it). That is evidence the estimate is conservative for prompts of this family, **not a guarantee**: it covers only the current contract with two prompt styles and no sample of the original arm's own prompt. This is why the reserve uses the absolute figure.`, "");
L.push("<details><summary>Per-case figures (µUSD)</summary>", "");
row("Case", "Original est. / absolute", "Current est. / absolute"); row("---", "---", "---");
for (const r of perCase) row(`\`${r.id}\``, `${r.original.estimatedWorstMicros} / ${r.original.absoluteWorstMicros}`, `${r.current.estimatedWorstMicros} / ${r.current.absoluteWorstMicros}`);
L.push("", "</details>", "");

L.push("## 5. The provider access check (documented; NOT used in this plan)", "");
L.push("- **Operation:** `GET https://api.openai.com/v1/models/gpt-6-luna` with the bearer key, issued by `verifyModelAccess` in `src/eval/liveRun.ts`. It is **not** a generation endpoint and sends no prompt or business data. Its only inputs are the key and the model id.");
L.push("- **What it tests:** that the key is accepted (HTTP 401/403 otherwise) and that the account can see that exact model id (HTTP 404 otherwise). It does not test that a generation will succeed, that the account has quota or billing enabled, or what tier a request would use.");
L.push("- **Billing:** the official reference page for this endpoint states **nothing** about billing, cost, token usage or rate limits, and the models page says nothing about billing for the Models API. It is a metadata request with no tokens, so a charge is not expected, but **the documentation does not say so and this plan does not claim it is free**. Each access check is therefore charged to the budget at an allowance of " + ALLOWANCE + " µUSD ($" + (ALLOWANCE / 1e6).toFixed(4) + "), recorded in the ledger. That is a deliberately generous placeholder for an operation that carries no tokens, not a measured price.");
L.push("- **Status in this plan:** not used. The live service-tier diagnostic made a real generation with this key and model, which is stronger evidence than a metadata request, so the 84-to-56 request plan has no access check and no allowance for one. The `--check-access` option remains available; if it were ever used its cost would be charged to the budget at " + ALLOWANCE + " µUSD and the ledger would record it.");
L.push("- It was not run in this task and is not part of the commands below.", "");

L.push("## 6. Scoring methodology", "");
L.push("Each output is scored on separate layers; none stands in for another.", "");
L.push("1. **Schema validity**, against each arm's own contract (length limits and truncation included). Reported separately and never merged into quality. An output that fails validation but is received is still scored on the layers below; an output that is cut off has nothing to score and is counted as such.");
L.push("2. **Factual grounding** (hard checks), judged against the full fixture Business Brain for both arms: unsupported, contradicted, ambiguous, out-of-scope, missing-condition and expired claims; injected instructions; unverified or prohibited claims. A hard failure is reported as such in either arm.");
L.push(`3. **Comparable quality dimensions**, using only checks both contracts can express: ${DIMENSIONS.filter((d) => d !== "schemaValidity").map((d) => DIMENSION_LABELS[d]).join(", ")} (restricted to the comparable checks in \`src/eval/evaluate.ts\`). Pass line ${Math.round(DIMENSION_PASS * 100)}% per dimension, a working threshold and not a standard.`);
L.push("4. **Current-only dimensions** (reasoning fields, differentiator decisions, variations, review flags, question impact) are reported for the current arm alone and never used to rank the arms.", "");
L.push("**Repetitions.** Every repetition is its own report (`cmp-3-2-<arm>-rep<N>`), listed individually. Per case and arm the aggregate shows both values, the mean, the minimum and how many repetitions passed. The arms are compared case by case (paired), then counted: cases where current is higher, equal, lower on the comparable overall. Hard failures are counted per arm and per repetition.", "");
L.push("**Decision rule, fixed before any result exists.** The result is called an *indication of improvement* only if all hold: current's comparable overall is higher or equal in at least 10 of the 14 case means; current has no more hard failures than original; and there is no case where current hard-fails in every repetition while original never does. Otherwise it is reported as *mixed* or *no demonstrated improvement*. No result is described as statistically significant, and a favourable result is not evidence of marketing performance. The rule, the pass line and the evaluator version are recorded here and in the code; they cannot be changed after results are seen without a new evaluator version.", "");
L.push("**Run order.** Invocations alternate by repetition (original 1, current 1, original 2, ...), so provider drift over the session affects both arms alike. The reported model id, service tier and request id are recorded for every request.", "");

L.push("## 7. What depends on reconstructed historical artifacts", "");
L.push("The repository had no Git history. The original implementation was rebuilt by replaying recorded edits (see `src/eval/original.ts`, `docs/campaign-evaluation.md`). **Everything on the original arm inherits that limit.**", "");
row("Dependency", "Reconstructed?", "Basis and risk"); row("---", "---", "---");
row("Original system prompt", "Yes", "Replayed from recorded edits; character-identical to the prompt used in the first live run. Low risk.");
row("Original brief contract (zod, JSON schema, hint)", "Yes", "Replayed from recorded edits; the real output of the original code parses under it. Low-to-moderate risk: an unrecorded shell edit would be missed.");
row("Original Business Brain fields", "Yes", "Same replay. The fixtures are projected onto these 9 fields, so the original arm does not see verified facts, pricing, unverified claims or provenance. That reflects the original system but is also a design choice that affects every original-arm result.");
row("Original generation parameters", "Partly", "Output cap, repair and retry settings are set for this experiment and apply to BOTH arms; they are not the original production defaults.");
row("The evaluator and the 14 fixtures", "No, but new", "Written after the original; both arms are scored by the same code. The newest fixtures were written knowing the current design.");
row("Earlier live reports (m3-live, m3-live2)", "Not used", "Different prompt revision and, for the old arm, the current contract. Used here only for the cost calibration above.");
L.push("");

L.push("## 8. Preparation checks", "");
row("Check", "Result", "Where verified"); row("---", "---", "---");
row("Arms use their intended prompt and schema versions", "Yes: the original arm sends the original prompt, JSON schema, hint and 9-field brain; the current arm the candidate. Versions and fingerprints are recorded in every report.", "`test/versionsAndBaseline.test.ts`, `config/prompt-versions.json`");
row("Reconstruction limits disclosed", "Yes: section 7, `src/eval/original.ts`, `docs/campaign-evaluation.md`", "documents");
row("Rubric and decision rule fixed before results", "Yes: section 6; evaluator version " + EVALUATOR_VERSION + " with source fingerprints", "this plan, committed before the run");
row("Fixtures contain no confidential information", "Yes: invented names; a test checks the fixtures contain no email address, URL or phone number", "`test/campaignQuality.test.ts`");
row("Schema validity, factual grounding and other dimensions reported separately", "Yes: separate fields (`schemaValid`, `qualityPassed`), separate dimensions and a separate comparable view", "`test/versionsAndBaseline.test.ts`, `test/factGrounding.test.ts`");
row("Repetitions identified individually and aggregated clearly", "Yes: one report per repetition; aggregation rule in section 6", "plan, CLI `--compare`");
row("All requests, costs and stop conditions recorded", "Yes: per request tokens, cost, attempts, model id, service tier; ledger of every invocation; halt reasons", "`src/eval/liveRun.ts`, `src/eval/ledger.ts`");
row("Retries and repairs cannot occur", "Configured off (retries 0, repair 0) AND enforced: more than one attempt halts the run", "`test/evalPlan.test.ts`");
row("Cost unknown halts", "Yes: an unmeasurable cost is charged at the reserve and halts", "`test/evalPlan.test.ts`");
L.push("");

L.push("## 9. Stop conditions", "");
row("Condition", "Action", "Enforced by"); row("---", "---", "---");
row("Budget would be passed by the next request's own reserve", "Do not send it; later cases recorded as not run", "Code (`BudgetExhausted`)");
row("Aggregate ceiling or request cap would be passed, or limits changed", "Do not start the invocation", "Code (ledger)");
row("An earlier invocation halted or never finished", "Do not start the next until a person reconciles it with a recorded note", "Code (ledger; `--reconcile`)");
row("The provider rejects a request (HTTP 4xx other than 429)", "Halt: the same request would be rejected again", "Code (`liveRun`)");
row("3 consecutive requests fail at the provider (outage, timeout, rate limit)", "Halt", "Code (`liveRun`)");
row("More HTTP requests than the invocation planned (a retry, a repair, a bug)", "The extra request is refused before it leaves the process", "Code (`capRequests` on the transport)");
row("A retry or repair is requested for a registered experiment", "Refuse to start", "Code (CLI)");
row("A request needed more than 1 attempt (a retry or a repair)", "Halt immediately", "Code (`maxAttemptsPerRequest` = 1; retries 0 and repair 0 also set)");
row("A request's cost cannot be determined", "Halt; charged at the reserve, never as zero", "Code (`haltOnUnknownCost`)");
row("The response reports a processing tier other than `" + SERVICE_TIER + "`, or none", "Halt: the price assumed may not apply", "Code (`expectedServiceTier`)");
row("The model has no recorded price", "Refuse to plan or run", "Code (CLI)");
row("Price page differs from `config/ai-pricing.json`, or the recorded price is older than 14 days", "Do not start; re-verify", "Procedure, before the run");
row("More than 4 of the first 14 requests of an invocation produce nothing scorable", "Stop and review before the next invocation", "Procedure, after the first invocation");
row("Any sign that real customer data is in an input", "Stop", "Procedure; the fixtures are synthetic");
L.push("");

L.push("## 10. Exact invocation (not run)", "");
L.push("Prerequisites, set in your shell or `.env.local` (never pasted into chat): `AI_PROVIDER_MODE=live`, `ALLOW_LIVE_PROVIDER_CALLS=true`, `OPENAI_API_KEY`. The command itself sets the service tier to `default` and response storage to disabled, and refuses to start if the environment says otherwise. Run each invocation first **without** `--yes-spend` to see its plan (no network request, no spend). If an invocation halts or is interrupted, the next one is refused until a person reconciles the ledger: `npm run eval:campaigns -- --reconcile \"<what you reviewed and why it is safe to continue>\" --ledger docs/eval/ledger-cmp-3-2.json --aggregate-ceiling-micros " + CEILING + " --max-total-requests " + requests + "`.", "", "```");
for (const c of commands) L.push(c);
L.push("```", "", "Then, offline and free, per repetition:", "", "```");
for (let r = 1; r <= REPS; r++) L.push(`npm run eval:campaigns -- --compare docs/eval/cmp-3-2-original-rep${r}-openai-gpt_6_luna.json docs/eval/cmp-3-2-current-rep${r}-openai-gpt_6_luna.json --names original,current --label cmp-3-2-rep${r}`);
L.push("```", "");

L.push("## 11. Remaining uncertainties for final authorization", "");
L.push("1. **Prices are the provider's published figures.** The plan cannot see what the account is billed. A per-request check after the first invocation (compare the account's usage page with the ledger) is recommended before the next.");
L.push("2. **The regional uplift** may or may not apply to this model; it is covered by a ×" + UPLIFT + " factor, not confirmed.");
L.push("3. **Reasoning-token billing** is not stated on the pricing page; it is bounded by the output cap, and the run halts if a request ever costs more than its reserve.");
L.push("4. **`store: false` has not been exercised against the live API.** The provider documents the parameter and the adapter now sends it, but the diagnostic ran before it existed. If the API rejects it, the first request fails with an HTTP 4xx, is not billed, the run halts, and the ledger shows one request. `store: false` asks the API not to keep the response for later retrieval; it does not by itself guarantee zero retention in the provider's logging or abuse-monitoring systems.");
L.push(absFits ? "5. **All " + requests + " requests can run even at their absolute maximum cost** (section 4), so the budget cannot stop the run; the expectation is " + usd(expectedLow) + " to " + usd(expectedHigh) + "." : "5. **Not all " + requests + " requests are guaranteed to run** in a world where every input and output is at its absolute maximum (section 4); the guarantee is that spend cannot pass the ceiling. The realistic expectation is that all run, at roughly " + usd(expectedLow) + " to " + usd(expectedHigh) + ".");
L.push("6. **The service-tier read-back was verified live, once.** A single diagnostic generation (" + (diag ? diag.requestId : "no record found") + ") returned `service_tier: \"default\"` and the run now halts on any other value. It is one observation, not a guarantee for every later request; the halt is the protection.");
L.push("7. **The model id is an alias** with no dated snapshot; behaviour could change between repetitions. Reported ids and request ids are recorded.");
L.push("8. **The original arm is a reconstruction** (section 7), the fixtures are 14 synthetic cases, and the evaluator is heuristic. A result is an indication, not proof of anything about marketing performance.");
L.push("9. **The estimate of input tokens is calibrated on the current contract only** (section 4); the reserve uses the absolute figure for that reason.");
L.push("10. **The plan's numbers are valid for the committed code.** Regenerate with `npm run eval:plan` after any change.", "");
if (WRITE) writeFileSync("docs/eval/plan-original-vs-current.md", L.join("\n"));
else {
  // --no-write shows the arithmetic without touching the committed files.
  const start = L.findIndex((l) => l.startsWith("### Reconciliation of the aggregate"));
  const end = L.findIndex((l, i) => i > start && /^(##|###) /.test(l));
  console.log(L.slice(start, end < 0 ? undefined : end).join("\n"));
}
console.log(`Plan written: ${requests} requests; estimated worst case ${estTotal} µUSD (${usd(estTotal)}); absolute worst case ${absTotal} µUSD (${usd(absTotal)}); ceiling ${CEILING} µUSD; max committed ${maxCommitted} µUSD; budgets ${budgets.original}/${budgets.current}. No network request was made.`);
