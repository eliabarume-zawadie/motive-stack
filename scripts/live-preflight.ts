/**
 * Offline readiness check for the opt-in live AI verification. Makes NO network request and prints NO secret values
 * (variable names and pass/fail only). Usage: npm run live:preflight [-- openai|anthropic]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config as loadEnv } from "dotenv";
import { ModelRegistry } from "../src/ai/registry.js";
import { PricingTable } from "../src/ai/pricing.js";

const envFile = process.env.LIVE_ENV_FILE ?? ".env.local";
if (existsSync(envFile)) loadEnv({ path: envFile });

const which = process.argv[2];
const providers = which ? [which] : ["openai", "anthropic"];
const KEYS: Record<string, string> = { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };
const DEFAULT_MODEL: Record<string, string> = { openai: "gpt-6-luna", anthropic: "claude-haiku-5-5" };

const reg = ModelRegistry.fromFile(process.env.AI_MODELS_FILE ?? "config/ai-models.json");
const pricing = PricingTable.fromFile(process.env.AI_PRICING_FILE ?? "config/ai-pricing.json");

let bad = 0;
const row = (ok: boolean, label: string, detail = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

console.log("Live AI verification preflight (offline; no requests are made, no values are printed)\n");

const ignored = spawnSync("git", ["check-ignore", "-q", envFile]).status === 0;
row(ignored, `${envFile} is ignored by git`);
row(existsSync(envFile), `${envFile} exists`, existsSync(envFile) ? "" : "create it from .env.example; put keys there, never in chat");
row(process.env.AI_PROVIDER_MODE === "live", "AI_PROVIDER_MODE=live", `currently "${process.env.AI_PROVIDER_MODE ?? "mock"}"`);
row(process.env.ALLOW_LIVE_PROVIDER_CALLS === "true", "ALLOW_LIVE_PROVIDER_CALLS=true", `currently "${process.env.ALLOW_LIVE_PROVIDER_CALLS ?? "false"}"`);

for (const p of providers) {
  const model = process.env[`${p.toUpperCase()}_LIVE_TEST_MODEL`] ?? DEFAULT_MODEL[p] ?? "";
  console.log(`\n[${p}] test model: ${model}`);
  row(!!process.env[KEYS[p] ?? ""], `${KEYS[p]} is set`);
  const e = reg.find(p, model);
  row(!!e, "model is in the registry");
  row(!!e?.enabled && !!e?.capabilities.structuredOutput, "model is enabled with structured output");
  row(!!e?.tasks.includes("live_probe"), "model is configured for the live_probe task");
  row(!!e?.reasoningEffort, "reasoning effort is configured (bounds hidden reasoning tokens)", e?.reasoningEffort ?? "missing");
  const price = pricing.entry(p, model);
  row(!!price, "verified price is configured", price ? `asOf ${price.asOf}` : "missing: cost-limited requests would be refused");
}

const budget = Number(process.env.LIVE_TEST_BUDGET_MICROS ?? 50_000);
const cap = Number(process.env.LIVE_TEST_MAX_OUTPUT_TOKENS ?? 400);
console.log(`\nHard limits for the test run: budget ${budget} micro-USD (${(budget / 1e6).toFixed(4)} USD), max output ${cap} tokens/request, retries 1, repair 0.`);
console.log(bad === 0 ? "\nReady. Run: npm run test:live:openai   or   npm run test:live:anthropic" : `\n${bad} check(s) failed: live verification is PENDING.`);
process.exitCode = bad === 0 ? 0 : 1;
