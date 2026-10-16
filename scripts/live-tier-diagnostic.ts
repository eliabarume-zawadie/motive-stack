/**
 * ONE live service-tier diagnostic generation (see src/eval/tierDiagnostic.ts for the guarantees).
 *
 *   npm run live:tier-diagnostic            DRY RUN: prints the plan, the worst-case reserve and the ledger state. No network request.
 *   npm run live:tier-diagnostic -- --send  makes exactly ONE request. Needs AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true
 *                                           and OPENAI_API_KEY (from .env.local or the shell). Authorised for one generation only.
 *
 * It is not a comparison run, does not use --check-access, and never prints, stores or returns the API key.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { PricingTable } from "../src/ai/pricing.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { DIAG, reserveFor, runTierDiagnostic } from "../src/eval/tierDiagnostic.js";
import { committedMicros, committedRequests, loadLedger } from "../src/eval/ledger.js";

if (existsSync(process.env.LIVE_ENV_FILE ?? ".env.local")) loadEnv({ path: process.env.LIVE_ENV_FILE ?? ".env.local" });

const send = process.argv.includes("--send");
const LEDGER = "docs/live-verification/ledger-tier-diagnostic.json";
const pricing = PricingTable.fromFile(process.env.AI_PRICING_FILE ?? "config/ai-pricing.json");
const registry = ModelRegistry.fromFile(process.env.AI_MODELS_FILE ?? "config/ai-models.json");
const price = pricing.entry(DIAG.provider, DIAG.model);
const reserve = reserveFor(price);
const ledger = loadLedger(LEDGER, { experiment: "tier-diagnostic", aggregateCeilingMicros: DIAG.budgetMicros, maxTotalRequests: 1 });

console.log("Service-tier diagnostic");
console.log(`  model ${DIAG.model}, service_tier "${DIAG.serviceTier}", max output ${DIAG.maxOutputTokens} tokens, 1 request, no retries, no repair`);
console.log(`  price (recorded) input ${price?.inputPerMTokMicros ?? "none"} / output ${price?.outputPerMTokMicros ?? "none"} micro-USD per 1M tokens; matches the rates read on ${DIAG.verifiedRates.readOn}: ${reserve.priceMatchesDocs}`);
console.log(`  worst case: ${reserve.inputBytes} input bytes (one token each) + ${DIAG.maxOutputTokens} output tokens, x${DIAG.uplift} uplift = ${reserve.reserveMicros} micro-USD; if a faster tier served it (x${DIAG.fasterTierFactor}) = ${reserve.fasterTierMicros} micro-USD`);
console.log(`  budget ${DIAG.budgetMicros} micro-USD ($${(DIAG.budgetMicros / 1e6).toFixed(4)}) -> ${reserve.fitsBudget ? "fits" : "DOES NOT FIT: " + reserve.why}`);
console.log(`  ledger ${LEDGER}: ${committedRequests(ledger)} of 1 request, ${committedMicros(ledger)} of ${DIAG.budgetMicros} micro-USD committed`);
console.log(`  OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? "present (value never printed)" : "NOT SET"}; AI_PROVIDER_MODE=${process.env.AI_PROVIDER_MODE ?? "(unset)"}; ALLOW_LIVE_PROVIDER_CALLS=${process.env.ALLOW_LIVE_PROVIDER_CALLS ?? "(unset)"}`);

if (!send) { console.log("\nDRY RUN. Nothing was sent and no network request was made. Add --send to make the one request."); process.exit(reserve.fitsBudget ? 0 : 1); }
if (process.env.AI_PROVIDER_MODE !== "live" || process.env.ALLOW_LIVE_PROVIDER_CALLS !== "true") { console.error("\nREFUSING: set AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true for this command (both are required)."); process.exit(1); }

const record = await runTierDiagnostic({ apiKey: process.env.OPENAI_API_KEY ?? "", fetchImpl: fetch, ledgerPath: LEDGER, pricing, registry });
if (record.mode === "refused") { console.error(`\nREFUSED, nothing was sent: ${record.refusedBecause}`); process.exit(1); }

mkdirSync("docs/live-verification", { recursive: true });
const file = `docs/live-verification/openai-tier-diagnostic-${record.startedAt.replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
console.log(`\nHTTP requests made: ${record.httpRequests}; HTTP ${record.http?.status ?? "none"}; request id ${record.http?.requestId ?? record.response?.id ?? "none"}`);
console.log(`returned service_tier: ${JSON.stringify(record.response?.service_tier ?? null)}; model ${record.response?.model ?? "none"}; status ${record.response?.status ?? "none"}`);
console.log(`usage: input ${record.response?.usage?.input_tokens ?? "none"}, output ${record.response?.usage?.output_tokens ?? "none"}; calculated cost ${record.calculatedCostMicros ?? "unknown"} micro-USD; charged to ledger ${record.ledger?.chargedMicros} micro-USD`);
if (record.error) console.log(`error: ${record.error.kind}${record.error.httpStatus ? " (HTTP " + record.error.httpStatus + ")" : ""}: ${record.error.message}`);
for (const c of record.checks) console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.id}: ${c.detail}`);
console.log(`\n${record.passed ? "DIAGNOSTIC PASSED" : "DIAGNOSTIC FAILED: stop here; do not retry and do not proceed to the evaluation"}. Record: ${file}`);
process.exit(record.passed ? 0 : 1);
