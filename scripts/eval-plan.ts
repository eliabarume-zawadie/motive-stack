/**
 * Dry-run PLAN for comparing the recovered original campaign implementation with the current candidate. OFFLINE ONLY.
 *
 * It reads local configuration and source files, counts requests, bounds their cost from the locally recorded prices, and writes
 * docs/eval/plan-original-vs-current.{md,json}. It sends nothing: global fetch is replaced with a function that throws, so an
 * accidental network call would fail loudly instead of quietly happening. It does not check model access (that needs the network).
 *
 *   npm run eval:plan
 *   npm run eval:plan -- --reps 3 --max-output 2500 --margin 1.25
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

(globalThis as { fetch: unknown }).fetch = () => { throw new Error("eval-plan is offline: a network call was attempted"); };

import { PricingTable } from "../src/ai/pricing.js";
import { estimateTokens } from "../src/app/aiService.js";
import { buildCampaignPrompt } from "../src/app/campaignPrompt.js";
import { CAMPAIGN_PROMPT_VERSION, CAMPAIGN_SCHEMA_VERSION, currentGenerationIdentity } from "../src/app/versions.js";
import { CAMPAIGN_BRIEF_HINT, CAMPAIGN_BRIEF_JSON_SCHEMA } from "../src/domain/campaignJsonSchema.js";
import { DIMENSION_PASS, DIMENSIONS, DIMENSION_LABELS, EVALUATOR_VERSION } from "../src/eval/evaluate.js";
import { EVAL_CASES } from "../src/eval/fixtures.js";
import { ORIGINAL_HINT, ORIGINAL_JSON_SCHEMA, buildOriginalPrompt, originalGenerationIdentity } from "../src/eval/original.js";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? (process.argv[i + 1] ?? d) : d; };
const REPS = Number(arg("reps", "3"));
const MAX_OUT = Number(arg("max-output", "2500"));
const MARGIN = Number(arg("margin", "1.25"));
const PROVIDER = "openai";
const MODEL = "gpt-6-luna";
const INPUT_SAFETY_TOKENS = 400; // headroom on top of the character-based estimate

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const fileSha = (p: string) => sha(readFileSync(p, "utf8").replace(/\r\n/g, "\n")); // line endings differ by checkout; the content is what matters

const pricing = PricingTable.fromFile("config/ai-pricing.json");
const price = pricing.entry(PROVIDER, MODEL);
if (!price) { console.error(`No locally recorded price for ${PROVIDER}/${MODEL}: a cost bound cannot be computed, so no live run may be planned.`); process.exit(1); }
const models = JSON.parse(readFileSync("config/ai-models.json", "utf8")) as { models?: Array<Record<string, unknown>>; entries?: Array<Record<string, unknown>> };
const entry = (models.models ?? models.entries ?? []).find((e) => e.provider === PROVIDER && e.model === MODEL) as Record<string, unknown> | undefined;

type Arm = "original" | "current";
const ARMS: Arm[] = ["original", "current"];
const build = (arm: Arm, c: (typeof EVAL_CASES)[number]) => (arm === "original" ? buildOriginalPrompt(c.brain) : buildCampaignPrompt(c.brain, { asOf: new Date("2026-10-16T12:00:00Z") }));
const contract = (arm: Arm) => (arm === "original" ? JSON.stringify(ORIGINAL_JSON_SCHEMA) + ORIGINAL_HINT : JSON.stringify(CAMPAIGN_BRIEF_JSON_SCHEMA) + CAMPAIGN_BRIEF_HINT);

/** Worst case for ONE request: every input token estimated high, and the whole output cap spent (reasoning tokens bill as output). */
function worstCaseMicros(arm: Arm, c: (typeof EVAL_CASES)[number]) {
  const p = build(arm, c);
  const inputTokens = estimateTokens(p.system + p.prompt + contract(arm)) + INPUT_SAFETY_TOKENS;
  if (inputTokens > (price?.longContext?.aboveInputTokens ?? Infinity)) throw new Error(`${c.id}/${arm}: input exceeds the long-context threshold; the cost model would be wrong`);
  const micros = Math.ceil((inputTokens * (price as { inputPerMTokMicros: number }).inputPerMTokMicros + MAX_OUT * (price as { outputPerMTokMicros: number }).outputPerMTokMicros) / 1e6);
  return { inputTokens, micros };
}

const perCase = EVAL_CASES.map((c) => ({ id: c.id, original: worstCaseMicros("original", c), current: worstCaseMicros("current", c) }));
const armTotal = (arm: Arm) => perCase.reduce((s, r) => s + r[arm].micros, 0);
const armInput = (arm: Arm) => perCase.reduce((s, r) => s + r[arm].inputTokens, 0);
const perRep = { original: armTotal("original"), current: armTotal("current") };
const requests = EVAL_CASES.length * ARMS.length * REPS;
const worstCaseTotal = (perRep.original + perRep.current) * REPS;
const ceilingTotal = Math.ceil((worstCaseTotal * MARGIN) / 1000) * 1000;
const perInvocationBudget = (arm: Arm) => Math.ceil((perRep[arm] * MARGIN) / 100) * 100;
const usd = (micros: number) => `$${(micros / 1e6).toFixed(4)}`;

const sources = ["src/eval/evaluate.ts", "src/eval/fixtures.ts", "src/eval/report.ts", "src/eval/liveRun.ts", "src/eval/original.ts", "src/domain/briefRules.ts", "src/domain/facts.ts", "src/domain/schemas.ts", "src/domain/campaignJsonSchema.ts", "src/app/campaignPrompt.ts"];
const fingerprints = Object.fromEntries(sources.map((s) => [s, fileSha(s)]));
const fixturesSha = sha(JSON.stringify(EVAL_CASES.map((c) => ({ id: c.id, brain: c.brain, expect: String(c.expect.mustNotContain ?? "") }))));
const cur = currentGenerationIdentity();
const orig = originalGenerationIdentity();

const plan = {
  generatedAt: new Date().toISOString(),
  networkUsed: false,
  status: "PLAN ONLY. Nothing here has been sent, and model access has not been checked.",
  model: { provider: PROVIDER, id: MODEL, registryEntrySha256: sha(JSON.stringify(entry ?? null)), providerSnapshot: "not pinned: the provider id is an alias; the response's model id must be recorded per request" },
  price: { ...price, status: `recorded locally, checked ${price.asOf} against ${price.source}; NOT re-verified for this plan (no network), so treated as PROVISIONAL`, provisionalMargin: MARGIN },
  design: { cases: EVAL_CASES.length, arms: ARMS, repetitionsPerCasePerArm: REPS, primaryRequests: requests, retriesAllowed: 0, repairAttemptsAllowed: 0, maxOutputTokens: MAX_OUT, maxRequestsIncludingRetries: requests },
  identifiers: { prompts: { original: orig.promptVersion, current: cur.promptVersion }, promptSha256: { original: orig.promptSha256, current: cur.promptSha256 }, schemas: { original: orig.schemaVersion, current: cur.schemaVersion }, schemaSha256: { original: orig.schemaSha256, current: cur.schemaSha256 }, evaluator: EVALUATOR_VERSION, evaluatorSourceSha256: fingerprints, fixturesSha256: fixturesSha, configSha256: { "config/ai-models.json": fileSha("config/ai-models.json"), "config/ai-pricing.json": fileSha("config/ai-pricing.json"), "config/prompt-versions.json": fileSha("config/prompt-versions.json") } },
  cost: { perRepWorstCaseMicros: perRep, worstCaseTotalMicros: worstCaseTotal, hardCeilingMicros: ceilingTotal, perInvocationBudgetMicros: { original: perInvocationBudget("original"), current: perInvocationBudget("current") }, inputTokensPerRep: { original: armInput("original"), current: armInput("current") } },
  perCase,
};
mkdirSync("docs/eval", { recursive: true });
writeFileSync("docs/eval/plan-original-vs-current.json", JSON.stringify(plan, null, 2) + "\n");

const L: string[] = [];
const row = (...c: string[]) => L.push(`| ${c.join(" | ")} |`);
L.push("# Evaluation plan: recovered original vs current candidate (DRY RUN, nothing sent)", "");
L.push(`Generated ${plan.generatedAt} by \`npm run eval:plan\`. **No network request, model call or provider-access check was made** (the script replaces \`fetch\` with a function that throws). This is a plan for review; the live comparison has not been started and needs separate approval.`, "");

L.push("## 1. What is compared", "");
L.push(`- **Arm A, original:** the recovered pre-Milestone-3 prompt, brief contract and Business Brain fields.`, `- **Arm B, current:** the candidate prompt and brief contract, with the full Business Brain.`, `- **Cases:** the same ${EVAL_CASES.length} synthetic businesses for both arms (ids below). All data is invented.`, `- **Model and parameters (identical for both arms):** ${PROVIDER}/${MODEL}, max output ${MAX_OUT} tokens, repair 0, retries 0, provider-default sampling, reasoning effort \`${String(entry?.reasoningEffort ?? "registry default")}\`.`, `- **Repetitions:** ${REPS} per case per arm. Repetition measures run-to-run variation; with sampling left at provider defaults, one run per case would hide it.`, "");
L.push("Cases: " + EVAL_CASES.map((c) => `\`${c.id}\``).join(", "), "");

L.push("## 2. Version identifiers", "");
row("Item", "Original arm", "Current arm"); row("---", "---", "---");
row("Prompt", `\`${orig.promptVersion}\``, `\`${cur.promptVersion}\``);
row("Prompt sha256", `\`${orig.promptSha256.slice(0, 16)}…\``, `\`${cur.promptSha256.slice(0, 16)}…\``);
row("Output contract", `\`${orig.schemaVersion}\``, `\`${CAMPAIGN_SCHEMA_VERSION}\``);
row("Contract sha256", `\`${orig.schemaSha256.slice(0, 16)}…\``, `\`${cur.schemaSha256.slice(0, 16)}…\``);
row("Business Brain sent", "9 original fields only", "full brain (facts projected into the fields the prompt names)");
L.push("", `- **Evaluator:** \`${EVALUATOR_VERSION}\`. Source fingerprints (sha256, line-ending-normalised) are in the JSON file for ${sources.length} files; fixtures fingerprint \`${fixturesSha.slice(0, 16)}…\`.`);
L.push(`- **Model:** \`${PROVIDER}/${MODEL}\` (registry entry fingerprint \`${plan.model.registryEntrySha256.slice(0, 16)}…\`). ${plan.model.providerSnapshot}.`);
L.push(`- **Config fingerprints:** \`config/ai-models.json\` \`${plan.identifiers.configSha256["config/ai-models.json"].slice(0, 12)}…\`, \`config/ai-pricing.json\` \`${plan.identifiers.configSha256["config/ai-pricing.json"].slice(0, 12)}…\`.`, "");

L.push("## 3. Request count and cost bound", "");
L.push(`- Primary requests: ${EVAL_CASES.length} cases × ${ARMS.length} arms × ${REPS} repetitions = **${requests}**.`);
L.push(`- Retries and repairs are disabled, so the **maximum is also ${requests} requests**. If any request needs a second attempt the run halts (section 6), so the count cannot grow unnoticed.`);
L.push(`- Price used (local, provisional): input ${usd(price.inputPerMTokMicros)} and output ${usd(price.outputPerMTokMicros)} per million tokens, recorded ${price.asOf} from ${price.source}. The registry notes that regional processing (+10%) and cached or batch tiers are not modelled, hence the margin below. **Not re-verified in this task.**`);
L.push(`- Worst case per request = (estimated input tokens + ${INPUT_SAFETY_TOKENS} headroom) × input rate + the full ${MAX_OUT}-token output cap × output rate. Input includes the prompt, the data and the JSON schema and hint. Reasoning tokens bill as output and are inside the cap.`, "");
row("Arm", "Worst case, one repetition (14 requests)", `Worst case, ${REPS} repetitions`); row("---", "---", "---");
row("Original", `${perRep.original} µUSD (${usd(perRep.original)})`, `${perRep.original * REPS} µUSD (${usd(perRep.original * REPS)})`);
row("Current", `${perRep.current} µUSD (${usd(perRep.current)})`, `${perRep.current * REPS} µUSD (${usd(perRep.current * REPS)})`);
row("**Total**", `${perRep.original + perRep.current} µUSD`, `**${worstCaseTotal} µUSD (${usd(worstCaseTotal)})**`);
L.push("", `- **Proposed hard ceiling: ${ceilingTotal} µUSD (${usd(ceilingTotal)})** = worst case × ${MARGIN} provisional-price margin, rounded up. It is a stop line, not an expected cost. Earlier runs on this model recorded roughly 30% to 45% of the per-request worst case, so the expected spend is well below the ceiling.`);
L.push(`- **Per-invocation budgets** (each invocation runs one arm over the ${EVAL_CASES.length} cases once): original ${perInvocationBudget("original")} µUSD, current ${perInvocationBudget("current")} µUSD. Their sum over ${REPS} repetitions is ${(perInvocationBudget("original") + perInvocationBudget("current")) * REPS} µUSD, which is the most the plan can authorise in total.`, "");
L.push("<details><summary>Per-case worst case (µUSD) and estimated input tokens</summary>", "");
row("Case", "Original in-tokens", "Original µUSD", "Current in-tokens", "Current µUSD"); row("---", "---", "---", "---", "---");
for (const r of perCase) row(`\`${r.id}\``, String(r.original.inputTokens), String(r.original.micros), String(r.current.inputTokens), String(r.current.micros));
L.push("", "</details>", "");

L.push("## 4. Scoring methodology", "");
L.push("Each output is scored on separate layers; none is allowed to stand in for another.", "");
L.push("1. **Schema validity**, against each arm's own contract (including length limits and truncation). Reported separately and never merged into quality. An output that fails validation but is received is still scored on the layers below; an output that is cut off has nothing to score and is counted as such.");
L.push("2. **Factual grounding** (hard checks), judged against the full fixture Business Brain for both arms: unsupported, contradicted, ambiguous, out-of-scope, missing-condition and expired claims; injected instructions; unverified or prohibited claims. This is the safety layer, and a hard failure is reported as such in either arm.");
L.push(`3. **Comparable quality dimensions**, using only checks both contracts can express: ${DIMENSIONS.filter((d) => d !== "schemaValidity").map((d) => DIMENSION_LABELS[d]).join(", ")} (restricted to the comparable checks listed in \`src/eval/evaluate.ts\`). Pass line ${Math.round(DIMENSION_PASS * 100)}% per dimension (a working threshold, not a standard).`);
L.push("4. **Current-only dimensions** (reasoning fields, differentiator decisions, variations, review flags, question impact) are reported for the current arm alone and are never used to rank the arms.", "");
L.push("**Aggregation.** Per case and arm, all repetitions are listed, with the mean, the minimum and the number of repetitions that passed. The arms are compared case by case (paired), then counted: cases where current is higher, equal, lower on the comparable overall. Hard failures are counted per arm.", "");
L.push("**Decision rule, fixed in advance.** The result is called an *indication of improvement* only if all hold: current's comparable overall is higher or equal in at least 10 of the 14 case means; current has no more hard failures than original; and there is no case where current hard-fails in every repetition while original never does. Otherwise it is reported as *mixed* or *no demonstrated improvement*. No result is described as statistically significant, and a favourable result is not evidence of marketing performance.", "");
L.push("**Run order.** Invocations alternate by repetition (original 1, current 1, original 2, current 2, ...), so a drift in the provider over the session affects both arms alike. The model's reported id and the request id are recorded for every request.", "");

L.push("## 5. Which results depend on reconstructed historical artifacts", "");
L.push("The repository had no Git history. These depend on a reconstruction (see `src/eval/original.ts` and `docs/campaign-evaluation.md`):", "");
row("Dependency", "Reconstructed?", "Basis and risk"); row("---", "---", "---");
row("Original system prompt", "Yes", "Replayed from recorded edits; character-identical to the prompt used in the first live run. Low risk.");
row("Original brief contract (zod + JSON schema + hint)", "Yes", "Replayed from recorded edits; the real output of the original code parses under it. Low-to-moderate risk: an unrecorded shell edit would be missed.");
row("Original Business Brain fields", "Yes", "Same replay. The 14 fixtures are projected onto these 9 fields, so the original arm does not see verified facts, pricing, unverified claims or provenance. That reflects the original system but is also a design choice that affects every original-arm result.");
row("Original generation parameters", "Partly", "Output cap, repair and retry settings are chosen for this experiment and applied to BOTH arms; they are not the original production defaults.");
row("The evaluator and the 14 fixtures", "No, but new", "Written after the original; both arms are scored by the same code. Scores are heuristics (see limits). The 3 newest fixtures were written knowing the current design.");
row("Earlier live reports (m3-live, m3-live2)", "Not used", "They used an unfingerprinted revision of the prompt and, for the old arm, the current contract. They are not part of this comparison.");
L.push("");

L.push("## 6. Stop conditions", "");
row("Condition", "Action", "Enforced by"); row("---", "---", "---");
row("Budget exhaustion", "Stop before a request whose worst case would pass the invocation budget; later cases are recorded as not run, never guessed", "Implemented (`BudgetExhausted`, reserve check before each request)");
row("Any retry or repair attempt (a request needing more than 1 attempt)", `Halt the whole invocation immediately; send nothing more until reviewed`, "Implemented (`maxAttemptsPerRequest` = 1; retries 0 and repair 0 are also set in configuration)");
row("Unknown or unmeasurable cost (no usage reported, no price)", "Halt; the failed or unpriced request is charged at the worst-case reserve, never as zero", "Implemented (`haltOnUnknownCost`; the CLI also refuses a model with no recorded price)");
row("Price record older than 14 days, a price page that disagrees with `config/ai-pricing.json`, or model access unconfirmed", "Do not start; re-verify first (needs the network and your approval)", "Procedure, before any live run");
row("Cumulative recorded spend reaching the hard ceiling across invocations", "Stop; do not start the next invocation", "Procedure: add the invocation totals after each one");
row("More than 4 of the first 14 requests of an invocation produce nothing scorable (cut off or invalid)", "Stop and review the output cap and the failures before continuing", "Procedure: check after the first invocation");
row("Any request that appears to use real customer data or private content", "Stop; fixtures are synthetic only", "Procedure; no such input exists in the fixtures");
L.push("", "## 7. Commands (not run)", "");
L.push("Each invocation is one arm over the 14 cases, once. Each starts with a plan-only run (it makes one free model-access request and sends nothing billable). **Do not run these without approval:**", "", "```");
L.push("# prerequisites: AI_PROVIDER_MODE=live  ALLOW_LIVE_PROVIDER_CALLS=true  key in .env.local");
for (let r = 1; r <= REPS; r++) for (const arm of ARMS) L.push(`npm run eval:campaigns -- --models ${PROVIDER}/${MODEL} --prompt ${arm} --max-output ${MAX_OUT} --repair 0 --retries 0 --budget-micros ${perInvocationBudget(arm)} --label cmp-${arm}-rep${r}   # add --yes-spend to run`);
L.push("# then, offline and free, per repetition:", `npm run eval:campaigns -- --compare docs/eval/cmp-original-rep1-${PROVIDER}-gpt_6_luna.json docs/eval/cmp-current-rep1-${PROVIDER}-gpt_6_luna.json --names original,current --label cmp-rep1`, "```", "");

L.push("## 8. Limits of this plan", "");
L.push("- The cost bound rests on locally recorded prices that were not re-verified here, on a character-based token estimate, and on the output cap being enforced by the provider. The margin and the halt rules are the protection if any of them is wrong.");
L.push("- 14 cases, even repeated, are an indication and not a reliability measure. Repeating a case reduces noise in that case; it does not add independent cases.");
L.push("- The evaluator's checks are pattern based (see `docs/campaign-evaluation.md`). A pass is not proof a claim is true, and a fail may be a false alarm.");
L.push("- Nothing here measures marketing performance. Synthetic fixtures cannot.");
L.push("- The plan is only as faithful to the original as the reconstruction (section 5).", "");
writeFileSync("docs/eval/plan-original-vs-current.md", L.join("\n"));
console.log(`Plan written: ${requests} requests, worst case ${worstCaseTotal} µUSD (${usd(worstCaseTotal)}), proposed ceiling ${ceilingTotal} µUSD (${usd(ceilingTotal)}). No network request was made.`);
