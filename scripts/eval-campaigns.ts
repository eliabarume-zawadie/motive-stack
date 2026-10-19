/**
 * Campaign quality evaluation CLI.
 *
 * OFFLINE (default; no network, no key):
 *   npm run eval:campaigns -- --label after --baseline docs/eval/baseline-2026-10-16.json
 *
 * LIVE (opt-in, budget-limited, synthetic data only). Needs ALL of:
 *   AI_PROVIDER_MODE=live  ALLOW_LIVE_PROVIDER_CALLS=true  <provider key in .env.local>  AND the explicit --yes-spend flag.
 *   npm run eval:campaigns -- --models openai/gpt-6-luna --cases plumbing-multi-differentiators,hvac-no-approved-pricing --budget-micros 20000
 *   (without --yes-spend it only prints the plan and the worst-case cost, and sends nothing)
 * NETWORK: without --check-access and --yes-spend this command makes NO network request. --check-access makes ONE model-retrieve request
 * (GET /v1/models/{id}); the provider documentation does not state its billing, so it is charged to the budget at --access-allowance-micros.
 * AGGREGATE LIMITS across invocations: --ledger FILE --aggregate-ceiling-micros N --max-total-requests N (limits cannot change on an existing ledger).
 * Options: --prompt current|original|legacy  --repair 0|1  --retries 0..5 (default 0)  --max-output N  --budget-micros N  --label NAME
 *   --prompt original = the recovered pre-Milestone-3 prompt AND its own schema/Business Brain (the faithful baseline; see src/eval/original.ts).
 *   --prompt legacy   = the original prompt text with the CURRENT schema (kept for old reports; NOT a faithful baseline).
 *
 * COMPARE two saved reports (offline, free):
 *   npm run eval:campaigns -- --compare docs/eval/a.json docs/eval/b.json --names original,current --label comparison-x
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { absoluteInputTokens, estimatedInputTokens, requestText, reserveWithUplift, worstCaseMicros } from "../src/eval/costBound.js";
import { OutputStore, loadArtifact, recordFromGeneration, rescoreArtifact, rescorability, scoredBlock } from "../src/eval/outputs.js";
import { canStart, closeEntry, committedMicros, committedRequests, loadLedger, reconcile, saveLedger, type Ledger, type LedgerEntry } from "../src/eval/ledger.js";
import { buildAiStack } from "../src/ai/stack.js";
import { EVAL_SERVICE_TIER, evaluationEnv, verifiedRatesProblem } from "../src/eval/evalPolicy.js";
import { buildCampaignPrompt } from "../src/app/campaignPrompt.js";
import { BusinessBrainSchema } from "../src/domain/schemas.js";
import { EVALUATOR_VERSION, evaluateBrief, runEvaluation, summarize, DIMENSIONS, DIMENSION_LABELS, type EvalReport, type Generator } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { buildLegacyPrompt, capRequests, identityOf, makeLiveGenerator, verifyModelAccess, type PromptVariant } from "../src/eval/liveRun.js";
import { ORIGINAL_HINT, ORIGINAL_JSON_SCHEMA, buildOriginalPrompt } from "../src/eval/original.js";
import { currentGenerationIdentity } from "../src/app/versions.js";
import { RECORDED_OPENAI_SUNRISE } from "../src/eval/recorded.js";
import { renderComparison, renderConsole, renderMarkdown } from "../src/eval/report.js";

if (existsSync(process.env.LIVE_ENV_FILE ?? ".env.local")) loadEnv({ path: process.env.LIVE_ENV_FILE ?? ".env.local" });

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const label = arg("label") ?? "run";
const baselinePath = arg("baseline");
const modelsArg = arg("models") ?? (arg("provider") && arg("model") ? `${arg("provider")}/${arg("model")}` : undefined);
const pct = (n: number) => `${Math.round(n * 100)}%`;
const baseline = baselinePath ? (JSON.parse(readFileSync(baselinePath, "utf8")) as EvalReport) : undefined;

mkdirSync("docs/eval", { recursive: true });
const save = (name: string, report: EvalReport, base?: EvalReport) => {
  writeFileSync(`docs/eval/${name}.json`, JSON.stringify(report, null, 2) + "\n");
  writeFileSync(`docs/eval/${name}.md`, renderMarkdown(report, base));
};

/* ------------------------------------------------------------------------------------------------ reconcile */
if (flag("reconcile") || arg("reconcile") !== undefined) {
  const path = arg("ledger");
  const note = arg("reconcile") ?? "";
  if (!path || !arg("aggregate-ceiling-micros") || !arg("max-total-requests")) { console.error("--reconcile needs --ledger, --aggregate-ceiling-micros and --max-total-requests (the same ones the experiment uses)"); process.exit(1); }
  const l = loadLedger(path, { experiment: label.replace(/-(original|current)-rep\d+$/, ""), aggregateCeilingMicros: Number(arg("aggregate-ceiling-micros")), maxTotalRequests: Number(arg("max-total-requests")) });
  try {
    const cleared = reconcile(l, note, new Date().toISOString(), arg("charged-micros") === undefined ? undefined : Number(arg("charged-micros")));
    saveLedger(path, l);
    console.log(`Reconciled: ${cleared.join(", ")}. Note recorded: "${note.trim()}". Committed now ${committedMicros(l)} of ${l.aggregateCeilingMicros} micro-USD. Nothing was sent.`);
    process.exit(0);
  } catch (e) { console.error((e as Error).message); process.exit(1); }
}

/* ------------------------------------------------------------------------------------- rescore and rescorability */
if (arg("rescore") !== undefined) {
  // npm run eval:campaigns -- --rescore docs/eval/outputs/<name>.outputs.json --label <new-label>   (offline; no model is called)
  const from = arg("rescore") as string;
  const a = loadArtifact(from);
  const { report, skipped, comparison } = rescoreArtifact(a, label);
  if (existsSync(`docs/eval/${label}.json`)) { console.error(`refusing to overwrite docs/eval/${label}.json: use a new --label`); process.exit(1); }
  writeFileSync(`docs/eval/${label}.json`, JSON.stringify({ ...report, rescoredFrom: from, skipped, comparison }, null, 2) + "\n");
  writeFileSync(`docs/eval/${label}.md`, renderMarkdown(report));
  console.log(renderConsole(report));
  for (const c of comparison) console.log(`  ${c.caseId.padEnd(40)} original ${c.original ? `${c.original.evaluator} ${Math.round(c.original.overall * 100)}%${c.original.hardFail ? " HARD" : ""}` : "not scored"}  ->  rescored ${c.rescored.evaluator} ${Math.round(c.rescored.overall * 100)}%${c.rescored.hardFail ? " HARD" : ""}`);
  for (const k of skipped) console.log(`  SKIPPED ${k.caseId}: ${k.reason}`);
  console.log(`\nRescored ${comparison.length} saved output(s) offline; no model was called. Wrote docs/eval/${label}.{json,md}. The saved outputs and their original scores were not modified.`);
  process.exit(0);
}
if (arg("rescorability") !== undefined) {
  // npm run eval:campaigns -- --rescorability <report.json> [<report2.json> ...] --label <name>
  const i = process.argv.indexOf("--rescorability");
  const paths: string[] = [];
  for (let k = i + 1; k < process.argv.length && !process.argv[k]!.startsWith("--"); k++) paths.push(process.argv[k]!);
  if (paths.length === 0) { console.error("usage: --rescorability <report.json> [more reports] --label <name>"); process.exit(1); }
  const rows = paths.map((p) => rescorability(p));
  const md = ["# Can the existing results be rescored?", "", "A result can be rescored only if the model's output text was saved. These reports hold scores and check details, not output text.", "",
    "| Report | Scored by | Cases | Output text saved | Rescorable | Why |", "|---|---|---|---|---|---|",
    ...rows.map((r) => `| \`${r.report}\` | ${r.evaluatorThatScoredIt ?? "unknown"} | ${r.cases} | ${r.rawOutputsPersisted ? "yes" : "**no**"} | ${r.rescorable ? "yes" : "**no**"} | ${r.reason} |`), ""].join("\n");
  writeFileSync(`docs/eval/${label}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2) + "\n");
  writeFileSync(`docs/eval/${label}.md`, md + "\n");
  for (const r of rows) console.log(`${r.report}: scored by ${r.evaluatorThatScoredIt ?? "unknown"}; rescorable: ${r.rescorable ? "yes" : "NO"} - ${r.reason}`);
  process.exit(0);
}

/* ----------------------------------------------------------------------------------------------- compare */
if (flag("compare")) {
  const i = process.argv.indexOf("--compare");
  const [pa, pb] = [process.argv[i + 1], process.argv[i + 2]];
  if (!pa || !pb) { console.error("usage: --compare <reportA.json> <reportB.json> [--names a,b] [--label NAME]"); process.exit(1); }
  const [na = "A", nb = "B"] = (arg("names") ?? "").split(",");
  let md = "";
  try { md = renderComparison(JSON.parse(readFileSync(pa, "utf8")) as EvalReport, JSON.parse(readFileSync(pb, "utf8")) as EvalReport, { a: na, b: nb }); } catch (e) { console.error((e as Error).message); process.exit(1); }
  writeFileSync(`docs/eval/${label}.md`, md);
  console.log(md);
  process.exit(0);
}

/* ------------------------------------------------------------------------------------------------ offline */
if (!modelsArg) {
  const mock = new MockAiProvider();
  const mockGenerator: Generator = async (c) => {
    const brain = BusinessBrainSchema.parse(c.brain);
    const r = await mock.generateObject({ task: "campaign_brief", system: "", prompt: JSON.stringify(brain), schemaHint: "", context: brain, schema: { safeParse: () => ({ success: true }) } as never, model: "mock-deterministic-1" });
    return { raw: r.raw, meta: { model: "mock/mock-deterministic-1", attempts: 1 } };
  };
  const report = await runEvaluation(EVAL_CASES, mockGenerator, label, "mock provider (deterministic reference; it follows the rules by construction, so a high score here does NOT show a real model does well)", {
    evaluator: EVALUATOR_VERSION, identity: currentGenerationIdentity(), model: "mock/mock-deterministic-1", params: { providerMode: "mock" },
    note: "Plumbing and validator test only: the mock is written to satisfy the rules, so its score shows that the rules, validators and pipeline work, not that any real model writes good or truthful briefs.",
  });
  const rec = RECORDED_OPENAI_SUNRISE;
  const recResult = evaluateBrief(rec.raw, rec.case, { model: rec.model });
  const recReport: EvalReport = { label: `${label}-recorded-real-sample`, generatedAt: new Date().toISOString(), source: `recorded real output ${rec.model} ${rec.recordedAt}`, cases: [recResult], aggregate: summarize([recResult]) };
  save(label, report, baseline);
  save(`${label}-recorded-real-sample`, recReport);
  console.log(renderConsole(report) + "\n\n" + renderConsole(recReport));
  console.log(`\nWrote docs/eval/${label}.md and ${label}-recorded-real-sample.md`);
  process.exit(0);
}

/* -------------------------------------------------------------------------------------------------- live */
const fail = (msg: string): never => { console.error(`REFUSING TO RUN LIVE: ${msg}`); process.exit(1); };
if (process.env.AI_PROVIDER_MODE !== "live" || process.env.ALLOW_LIVE_PROVIDER_CALLS !== "true") fail("set AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true for this command (both are required).");

const variant = (arg("prompt") ?? "current") as PromptVariant;
if (variant !== "current" && variant !== "legacy" && variant !== "original") fail('--prompt must be "current", "original" or "legacy"');
const repair = arg("repair") === "1" ? "1" : "0";
const retries = Number(arg("retries") ?? 0);
const maxOut = Number(arg("max-output") ?? 1500);
const budget = Number(arg("budget-micros") ?? 20_000);
const wanted = (arg("cases") ?? "all").split(",").map((s) => s.trim());
const cases = wanted.includes("all") ? EVAL_CASES : EVAL_CASES.filter((c) => wanted.includes(c.id));
if (cases.length === 0) fail(`no matching cases. Available: ${EVAL_CASES.map((c) => c.id).join(", ")}`);

// The ONLY network operation besides generation is the provider access check, and it runs only when asked for with --check-access.
// Its billing is not stated by the provider's documentation, so each one is charged to the budget at an allowance (never treated as free).
const checkAccess = flag("check-access");
const accessAllowance = Number(arg("access-allowance-micros") ?? 500);
const ledgerPath = arg("ledger");
const ceilingArg = arg("aggregate-ceiling-micros");
const maxTotalArg = arg("max-total-requests");
if (ledgerPath && (!ceilingArg || !maxTotalArg)) fail("--ledger needs --aggregate-ceiling-micros and --max-total-requests");
const serviceTier = EVAL_SERVICE_TIER; // pinned so the price assumed by the cost bound is the price charged

// A registered experiment (one with a ledger) has a fixed request count: a retry or a repair would change it, so neither is allowed.
if (ledgerPath && (repair !== "0" || retries !== 0)) fail("an experiment with a ledger runs with --repair 0 and --retries 0: a retry or a repair would change the planned request count");
// Only the AI stack is built: providers, model registry, prices and the gateway. There is no database, ad-platform connector or CRM in this process.
const specs = modelsArg.split(",").map((m) => m.trim());
const transport = capRequests(fetch, cases.length * specs.length); // the (N+1)th HTTP request is refused before it leaves the process
const stack = buildAiStack({ env: evaluationEnv(process.env, { repair: Number(repair), retries, maxOutputTokens: maxOut }), fetch: transport.fetch });
const pricing = stack.pricing;
const KEY: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };

const promptFor = (c: (typeof EVAL_CASES)[number]) => (variant === "legacy" ? buildLegacyPrompt(c.brain) : variant === "original" ? buildOriginalPrompt(c.brain) : buildCampaignPrompt(c.brain, { asOf: new Date() }));
const contractText = variant === "original" ? JSON.stringify(ORIGINAL_JSON_SCHEMA) + ORIGINAL_HINT : JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA) + CAMPAIGN_BRIEF_HINT;

interface Plan { provider: "openai" | "anthropic"; model: string; reserveFor: (c: (typeof EVAL_CASES)[number]) => number; maxReserve: number; estimatedWorst: number; ok: boolean; why: string }
const plans: Plan[] = [];
for (const spec of modelsArg.split(",").map((s) => s.trim())) {
  const [provider, ...rest] = spec.split("/");
  const model = rest.join("/");
  if (provider !== "openai" && provider !== "anthropic") fail(`"${spec}": live evaluation supports openai/<model> and anthropic/<model>`);
  const p = provider as "openai" | "anthropic";
  const entry = stack.registry.find(p, model);
  const key = process.env[KEY[p] as string];
  const price = pricing.entry(p, model);
  let ok = true;
  let why = checkAccess ? "" : "access NOT checked (pass --check-access to check; the check is charged to the budget)";
  if (!entry?.enabled || !entry.capabilities.structuredOutput) { ok = false; why = "not an enabled structured-output model in config/ai-models.json"; }
  else if (!price) { ok = false; why = "no verified price in config/ai-pricing.json, so spend cannot be limited"; }
  else if (ledgerPath && verifiedRatesProblem(p, model, price)) { ok = false; why = verifiedRatesProblem(p, model, price) as string; }
  else if (!key) { ok = false; why = `${KEY[p]} is not set`; }
  else if (checkAccess) {
    const access = await verifyModelAccess(p, model, key);
    if (!access.ok) { ok = false; why = access.detail; } else why = "access verified by a model-retrieve request (not a generation)";
  }
  // Reserve each request's ABSOLUTE worst case: input counted as one token per UTF-8 byte (a token is never shorter), output at the cap, times the regional uplift.
  const reserveFor = (c: (typeof EVAL_CASES)[number]) => (price ? reserveWithUplift(absoluteInputTokens(requestText(promptFor(c), contractText)), maxOut, price) : 0);
  const maxReserve = Math.max(...cases.map(reserveFor));
  const estimatedWorst = price ? Math.max(...cases.map((c) => worstCaseMicros(estimatedInputTokens(requestText(promptFor(c), contractText)), maxOut, price))) : 0;
  if (ok && maxReserve > budget) { ok = false; why = `worst-case cost of ONE request (${maxReserve} micro-USD) exceeds the budget (${budget}); raise --budget-micros deliberately or lower --max-output`; }
  plans.push({ provider: p, model, reserveFor, maxReserve, estimatedWorst, ok, why });
}

let ledger: Ledger | undefined;
if (ledgerPath) {
  ledger = loadLedger(ledgerPath, { experiment: label.replace(/-(original|current)-rep\d+$/, ""), aggregateCeilingMicros: Number(ceilingArg), maxTotalRequests: Number(maxTotalArg) });
}
const reservedForThis = budget + (checkAccess ? accessAllowance : 0);
const startCheck = ledger ? canStart(ledger, { reservedMicros: reservedForThis, requests: cases.length }) : ({ ok: true } as const);

console.log(`LIVE evaluation plan: ${cases.length} case(s), prompt=${variant}, repair=${repair}, retries=${retries}, max output ${maxOut} tokens, service tier "${serviceTier}", response storage disabled (store:false), budget ${budget} micro-USD ($${(budget / 1e6).toFixed(4)}) for this invocation`);
for (const p of plans) console.log(`  ${p.ok ? "READY" : "BLOCKED"}  ${p.provider}/${p.model}  per-request reserve up to ${p.maxReserve} micro-USD (absolute bound incl. the 1.10 regional uplift; the estimated worst case is ${p.estimatedWorst})  (${p.why})`);
if (ledger) console.log(`  ledger ${ledgerPath}: committed ${committedMicros(ledger)} of ${ledger.aggregateCeilingMicros} micro-USD, ${committedRequests(ledger)} of ${ledger.maxTotalRequests} requests; this invocation reserves ${reservedForThis} micro-USD and ${cases.length} requests -> ${startCheck.ok ? "may start" : "REFUSED: " + startCheck.reason}`);
if (!flag("yes-spend")) { console.log("\nNothing was sent." + (checkAccess ? " (One model-retrieve request was made for the access check.)" : " No network request was made.") + " Add --yes-spend to run the READY models (billable, capped by the budget above)."); process.exit(plans.every((p) => p.ok) && startCheck.ok ? 0 : 1); }
if (plans.every((p) => !p.ok)) fail("no model is ready.");
if (!startCheck.ok) fail(startCheck.reason);

const reports: EvalReport[] = [];
for (const p of plans.filter((x) => x.ok)) {
  // The saved-outputs file is created first: if it already exists the invocation is refused BEFORE anything is sent.
  const name = `${label}-${p.provider}-${p.model.replace(/[^a-z0-9.]+/gi, "_")}`;
  const store = new OutputStore(`docs/eval/outputs/${name}.outputs.json`, { label, source: `LIVE ${p.provider}/${p.model} | prompt ${variant} | synthetic data` });
  let entry: LedgerEntry | undefined;
  if (ledger && ledgerPath) {
    entry = { label, arm: variant, startedAt: new Date().toISOString(), status: "started", reservedMicros: reservedForThis, requests: cases.length };
    ledger.entries.push(entry);
    saveLedger(ledgerPath, ledger); // written BEFORE anything is sent: a crash leaves a pessimistic entry, not none
  }
  const { generate, spent, halted } = makeLiveGenerator({
    gateway: stack.gateway, provider: p.provider, model: p.model, prompt: variant, budgetMicros: budget, maxOutputTokens: maxOut,
    reserveForCase: p.reserveFor, maxAttemptsPerRequest: 1, haltOnUnknownCost: true, expectedServiceTier: p.provider === "openai" ? serviceTier : undefined,
  });
  let report: EvalReport | undefined;
  let failure: unknown;
  const httpBefore = transport.sent();
  try {
    report = await runEvaluation(cases, generate, name, `LIVE ${p.provider}/${p.model} | prompt ${variant} | repair ${repair} | synthetic data | ${new Date().toISOString().slice(0, 10)}`, {
      evaluator: EVALUATOR_VERSION, identity: identityOf(variant), model: `${p.provider}/${p.model}`,
      params: { maxOutputTokens: maxOut, repairAttempts: Number(repair), maxRetries: retries, serviceTier, store: false, budgetMicros: budget, cases: cases.length },
      note: variant === "legacy" ? "DEPRECATED arm: the original prompt text with the CURRENT output contract. Not a faithful baseline." : variant === "original" ? "Faithful baseline: the recovered original prompt, output contract and Business Brain fields. Compare with the comparable view only." : undefined,
    }, {
      // Saved BEFORE scoring and rewritten after every request: the output text survives a crash or a scoring failure, and the
      // scores are attached afterwards. The record holds synthetic text and identifiers only, never a key or a header.
      onGenerated: (c, out) => store.add(recordFromGeneration(name, c, out)),
      onScored: (c, _out, scored) => store.attachScore(c.id, scoredBlock(scored)),
    });
  } catch (e) {
    failure = e; // recorded in the ledger below, then re-thrown: an invocation that ends in an error never looks like a normal one
  } finally {
    if (entry && ledger && ledgerPath) {
      closeEntry(entry, {
        spentMicros: spent(), accessChargedMicros: checkAccess ? accessAllowance : 0,
        requestsSent: transport.sent() - httpBefore, // counted at the transport: requests that actually left the process
        halted: halted(), error: failure === undefined ? undefined : String((failure as Error)?.message ?? failure).slice(0, 200),
        inFlightReserveMicros: p.maxReserve, finishedAt: new Date().toISOString(),
      });
      saveLedger(ledgerPath, ledger);
    }
  }
  if (failure !== undefined) throw failure;
  if (!report) throw new Error("no report was produced");
  save(name, report, baseline);
  reports.push(report);
  console.log(`\n  HTTP requests sent in this invocation: ${transport.sent()} (planned at most ${cases.length * specs.length})`);
  if (halted()) { console.log(`\n  RUN HALTED: ${halted()}`); process.exitCode = 1; }
  console.log("\n" + renderConsole(report) + `\n  estimated spend: ${spent()} micro-USD ($${(spent() / 1e6).toFixed(6)})`);
  if (ledger) console.log(`  ledger: committed ${committedMicros(ledger)} of ${ledger.aggregateCeilingMicros} micro-USD, ${committedRequests(ledger)} of ${ledger.maxTotalRequests} requests`);
}
if (reports.length > 1) {
  const L = ["# Model comparison", "", `Prompt ${variant}, repair ${repair}, ${cases.length} synthetic case(s). Not a statistical result.`, "", `| Model | Pass | ${DIMENSIONS.map((d) => DIMENSION_LABELS[d]).join(" | ")} |`, `|---|---|${DIMENSIONS.map(() => "---").join("|")}|`];
  for (const r of reports) L.push(`| ${r.source.split("|")[0]?.replace("LIVE ", "")} | ${r.aggregate.passed}/${r.aggregate.total} | ${DIMENSIONS.map((d) => pct(r.aggregate.meanByDimension[d])).join(" | ")} |`);
  writeFileSync(`docs/eval/${label}-comparison.md`, L.join("\n") + "\n");
  console.log(`\nWrote docs/eval/${label}-comparison.md`);
}
