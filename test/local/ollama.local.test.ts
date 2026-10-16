import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelRegistry } from "../../src/ai/registry.js";
import { connectionTest, listUsage } from "../../src/app/aiService.js";
import { generateCampaign } from "../../src/app/campaigns.js";
import { buildContext } from "../../src/app/context.js";
import { createWorkspace, putBrain } from "../../src/app/workspaces.js";
import { migrate, openDb } from "../../src/db/db.js";
import { BRAIN } from "../fixtures.js";

/**
 * REAL LOCAL MODEL measurement against the Ollama server on this machine. Free and offline: no key, no billing,
 * nothing leaves the computer. Opt-in because it is SLOW (about 2 minutes per sample on a CPU):
 *   npm run local:preflight
 *   npm run test:local:ollama            (LOCAL_SAMPLES=5 by default)
 * It measures how often the real model returns a brief that passes the application's schema. It is a measurement,
 * not a guarantee: Ollama does not promise schema conformance, so the app validates every result regardless.
 */
const optedIn = process.env.LOCAL_TESTS === "1" && process.env.AI_PROVIDER_MODE === "local";
const HINT = "run `npm run local:preflight`, then `npm run test:local:ollama`";
const SAMPLES = Math.max(1, Number(process.env.LOCAL_SAMPLES ?? 5));
const MIN_VALID_RATE = Number(process.env.LOCAL_MIN_VALID_RATE ?? 0.6);
const MODEL = "llama3.1:latest";
const root = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "");

interface Sample { n: number; ok: boolean; firstTryOk?: boolean; wallMs: number; failKind?: string; inputTokens?: number; outputTokens?: number; withinBudgetCap?: boolean; openQuestions?: number; attempts: number }
const samples: Sample[] = [];
const evidence: Record<string, unknown> = {};

describe.skipIf(!optedIn)(`LOCAL Ollama / ${MODEL}${optedIn ? "" : ` - SKIPPED: ${HINT}`}`, () => {
  let db: ReturnType<typeof openDb>;
  let ctx: ReturnType<typeof buildContext>;
  let ws: { id: string };

  beforeAll(() => {
    db = openDb(":memory:");
    migrate(db);
    // Default: ONE repair attempt, exactly what the app does. Both the first-try and the final result are recorded.
    // Set LOCAL_REPAIR_ATTEMPTS=0 to measure the raw first-try rate only.
    ctx = buildContext({ db, env: { AI_PROVIDER_MODE: "local", AI_REPAIR_ATTEMPTS: process.env.LOCAL_REPAIR_ATTEMPTS ?? "1", AI_MAX_RETRIES: "0", OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL } });
    ws = createWorkspace(ctx, "Local verification").workspace;
    putBrain(ctx, ws.id, BRAIN);
  });

  it("1. the local server is running and the configured model is installed", async () => {
    const v = (await (await fetch(`${root}/api/version`)).json()) as { version: string };
    const tags = (await (await fetch(`${root}/api/tags`)).json()) as { models: Array<{ name: string; size: number; details: { parameter_size: string; quantization_level: string } }> };
    const m = tags.models.find((x) => x.name === MODEL);
    expect(m, `${MODEL} must be installed (ollama pull llama3.1)`).toBeDefined();
    Object.assign(evidence, { ollamaVersion: v.version, model: MODEL, parameterSize: m?.details.parameter_size, quantization: m?.details.quantization_level, sizeGB: Number(((m?.size ?? 0) / 1e9).toFixed(2)) });
  });

  it("2. the app's connection test makes a real request to the local model and reports it as connected (no charge)", async () => {
    const r = await connectionTest(ctx, ws.id, "ollama", MODEL);
    expect(r).toMatchObject({ simulated: false, connected: true, provider: "ollama", model: MODEL });
    expect(r.requestId).toBeTruthy();
    evidence.connectionTest = { connected: r.connected, latencyMs: r.latencyMs, requestId: r.requestId };
    const ps = (await (await fetch(`${root}/api/ps`)).json()) as { models?: Array<{ size_vram: number; context_length: number }> };
    evidence.inference = ps.models?.[0] && ps.models[0].size_vram > 0 ? "GPU" : "CPU";
    evidence.servedContextTokens = ps.models?.[0]?.context_length;
  }, 600_000);

  it(`3. ${SAMPLES} real campaign briefs through the full app path: how often does the schema pass on the first try?`, async () => {
    for (let n = 1; n <= SAMPLES; n++) {
      const t0 = performance.now();
      const before = listUsage(ctx, ws.id).length;
      const s: Sample = { n, ok: false, wallMs: 0, attempts: 0 };
      try {
        const rec = await generateCampaign(ctx, ws.id);
        s.ok = true;
        s.withinBudgetCap = rec.brief.dailyBudgetCents <= BRAIN.maxDailyBudgetCents;
        s.openQuestions = rec.brief.openQuestions.length;
      } catch (e) {
        s.failKind = (e as { kind?: string }).kind ?? "error";
      }
      s.wallMs = Math.round(performance.now() - t0);
      const all = listUsage(ctx, ws.id); // newest first
      const rows = all.slice(0, all.length - before);
      s.attempts = rows.length;
      s.firstTryOk = rows.length > 0 && rows[rows.length - 1]?.outcome === "ok"; // the oldest row of this sample is its first attempt
      s.inputTokens = rows.reduce((a, r) => a + (r.inputTokens ?? 0), 0) || undefined;
      s.outputTokens = rows.reduce((a, r) => a + (r.outputTokens ?? 0), 0) || undefined;
      samples.push(s);
      console.log(`sample ${n}/${SAMPLES}: ${s.ok ? (s.firstTryOk ? "VALID first try" : "VALID after repair") : `INVALID (${s.failKind})`}, ${s.attempts} attempt(s), in ${(s.wallMs / 1000).toFixed(0)}s, tokens in/out ${s.inputTokens ?? "?"}/${s.outputTokens ?? "?"}`);
    }
    const valid = samples.filter((s) => s.ok).length;
    const rate = valid / samples.length;
    const walls = samples.map((s) => s.wallMs).sort((a, b) => a - b);
    Object.assign(evidence, {
      repairAttemptsAllowed: Number(process.env.LOCAL_REPAIR_ATTEMPTS ?? "1"),
      samples, attempted: samples.length,
      validFirstTry: samples.filter((x) => x.firstTryOk).length, validFinal: valid, validRate: Number(rate.toFixed(2)),
      medianSeconds: Math.round((walls[Math.floor(walls.length / 2)] ?? 0) / 1000),
      validBriefsWithinBudgetCap: samples.filter((s) => s.ok && s.withinBudgetCap).length,
      note: "Measured at temperature 0. validRate is the FINAL result including the app's repair attempt. A small sample is an indication, not a reliability guarantee.",
    });
    expect(rate, `final valid rate ${valid}/${samples.length} is below the acceptance bar ${MIN_VALID_RATE}`).toBeGreaterThanOrEqual(MIN_VALID_RATE);
  }, 3_600_000);

  it("4. every attempt was recorded as a LOCAL, no-charge, non-simulated request", () => {
    const rows = listUsage(ctx, ws.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ mode: "local", simulated: false, costStatus: "local_no_charge", estimatedCostMicros: null, provider: "ollama" });
  });

  afterAll(() => {
    if (!optedIn || !samples.length) return;
    const dir = "docs/live-verification";
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/ollama-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ verifiedLocallyAt: new Date().toISOString(), costUsd: 0, networkEgress: "none (localhost only)", ...evidence }, null, 2) + "\n");
    console.log(`Local verification evidence written to ${file}`);
    db?.close();
  });
});

describe("local gate (always runs)", () => {
  it(optedIn ? "local Ollama tests are ENABLED for this run" : `local Ollama tests are DISABLED for this run - ${HINT}`, () => {
    expect(typeof optedIn).toBe("boolean");
  });
});

void ModelRegistry;
