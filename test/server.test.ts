import { mkdtempSync, rmSync } from "node:fs";
import { PricingTable } from "../src/ai/pricing.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { MockAiProvider } from "../src/ai/mockProvider.js";
import { ModelRegistry } from "../src/ai/registry.js";
import { AiError, type AiProvider } from "../src/ai/types.js";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorker } from "../src/app/worker.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";

const open: Array<() => void> = [];
afterEach(() => {
  while (open.length) open.pop()?.();
});

function boot(path = ":memory:", env: Record<string, string> = {}) {
  const db = openDb(path);
  migrate(db);
  const ctx = buildContext({ db, env, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx);
  const worker = createWorker(ctx);
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker };
}

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}

async function signup(app: FastifyInstance, name = "Acme") {
  const r = await call(app, "POST", "/api/workspaces", undefined, { name });
  expect(r.status).toBe(201);
  return { id: r.body.workspace.id as string, token: r.body.token as string };
}

/** Drive the whole product through the HTTP API, exactly as the UI does. */
async function fullFlow(s: ReturnType<typeof boot>) {
  const w = await signup(s.app);
  const base = `/api/workspaces/${w.id}`;
  expect((await call(s.app, "PUT", `${base}/brain`, w.token, BRAIN)).status).toBe(200);
  const gen = await call(s.app, "POST", `${base}/campaigns/generate`, w.token, { providerId: "mock", model: "mock-deterministic-1" });
  expect(gen.status).toBe(201);
  const cid = gen.body.id as string;
  const prop = await call(s.app, "POST", `${base}/campaigns/${cid}/proposals`, w.token, {});
  expect(prop.status).toBe(201);
  expect(prop.body.status).toBe("proposed");
  const appr = await call(s.app, "POST", `${base}/proposals/${prop.body.id}/approve`, w.token, { decidedBy: "elia" });
  await call(s.app, "POST", `${base}/proposals/${prop.body.id}/execute`, w.token);
  expect(appr.body.status).toBe("approved");
  await s.worker.runUntilIdle();
  return { w, base, cid, pid: prop.body.id as string };
}

describe("HTTP API: full workflow", () => {
  it("brief -> approval -> simulated paused campaign -> lead -> CRM, visible in the read models", async () => {
    const s = boot();
    const { w, base, cid, pid } = await fullFlow(s);

    const proposal = await call(s.app, "GET", `${base}/proposals/${pid}`, w.token);
    expect(proposal.body).toMatchObject({ status: "executed", mode: "mock", externalResource: { verifiedState: "PAUSED", simulated: true } });

    const lead = await call(s.app, "POST", `${base}/campaigns/${cid}/simulate-lead`, w.token, { fullName: "Pat", email: "pat@example.com", eventId: "e1" });
    expect(lead.status).toBe(202);
    await s.worker.runUntilIdle();
    const dup = await call(s.app, "POST", `${base}/campaigns/${cid}/simulate-lead`, w.token, { fullName: "Pat", email: "pat@example.com", eventId: "e1" });
    expect(dup.body.duplicate).toBe(true);

    const leads = await call(s.app, "GET", `${base}/leads`, w.token);
    expect(leads.body).toEqual([expect.objectContaining({ crmStatus: "synced", simulated: true })]);
    const activity = await call(s.app, "GET", `${base}/activity`, w.token);
    const types = (activity.body as unknown as Array<{ type: string }>).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["campaign.generated", "proposal.approved", "execution.succeeded", "lead.crm_synced", "lead.duplicate_event"]));
    const camp = await call(s.app, "GET", `${base}/campaigns/${cid}`, w.token);
    expect(camp.body.status).toBe("launched_paused");
  });
});

describe("HTTP API: auth and isolation", () => {
  it("rejects missing, wrong and cross-workspace tokens", async () => {
    const s = boot();
    const a = await signup(s.app, "Alpha Co");
    const b = await signup(s.app, "Bravo Co");
    expect((await call(s.app, "GET", `/api/workspaces/${a.id}/brain`)).status).toBe(401);
    expect((await call(s.app, "GET", `/api/workspaces/${a.id}/brain`, "msw_wrong")).status).toBe(401);
    expect((await call(s.app, "GET", `/api/workspaces/${a.id}/brain`, b.token)).status).toBe(401);
    expect((await call(s.app, "GET", `/api/workspaces/${a.id}/brain`, a.token)).status).toBe(200);
  });

  it("another workspace's token cannot read or approve this workspace's proposal", async () => {
    const s = boot();
    const { pid, base } = await fullFlow(s);
    const other = await signup(s.app, "Other");
    const otherBase = `/api/workspaces/${other.id}`;
    expect((await call(s.app, "GET", `${otherBase}/proposals/${pid}`, other.token)).status).toBe(404);
    expect((await call(s.app, "POST", `${otherBase}/proposals/${pid}/approve`, other.token, { decidedBy: "x" })).status).toBe(404);
    expect((await call(s.app, "GET", `${otherBase}/leads`, other.token)).body).toEqual([]);
    expect(base).not.toBe(otherBase);
  });

  it("never exposes the token hash or provider secrets", async () => {
    const s = boot();
    const w = await signup(s.app);
    const cfg = await call(s.app, "GET", "/api/config");
    const ws = await call(s.app, "GET", `/api/workspaces/${w.id}`, w.token);
    for (const text of [JSON.stringify(cfg.body), JSON.stringify(ws.body)]) {
      expect(text).not.toMatch(/token_hash|msw_|api[_-]?key|secret/i);
    }
  });
});

describe("HTTP API: validation and errors", () => {
  it("returns 400 with field paths for invalid input and stores nothing", async () => {
    const s = boot();
    const w = await signup(s.app);
    const r = await call(s.app, "PUT", `/api/workspaces/${w.id}/brain`, w.token, { ...BRAIN, services: [] });
    expect(r.status).toBe(400);
    expect(r.body.error.issues[0].path).toBe("services");
    expect((await call(s.app, "GET", `/api/workspaces/${w.id}/brain`, w.token)).body.brain).toBeNull();
  });

  it("rejects unknown fields in approval bodies and an approval without an approver", async () => {
    const s = boot();
    const { w, base } = await fullFlow(s);
    const camps = await call(s.app, "GET", `${base}/campaigns`, w.token);
    expect(camps.body).toHaveLength(1);
    const r = await call(s.app, "POST", `${base}/proposals/prp_x/approve`, w.token, { decidedBy: "", extra: 1 });
    expect(r.status).toBe(400);
  });

  it("rejects a model's over-ceiling budget at generation (502), and still blocks a later over-ceiling proposal with a clear 422", async () => {
    const db = openDb(":memory:");
    migrate(db);
    const bad = buildServer(buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} }, aiProviders: [new MockAiProvider("over_budget")] }));
    const w = await signup(bad);
    const base = `/api/workspaces/${w.id}`;
    await call(bad, "PUT", `${base}/brain`, w.token, BRAIN);
    const rejected = await call(bad, "POST", `${base}/campaigns/generate`, w.token, { providerId: "mock", model: "mock-deterministic-1" });
    expect(rejected.status).toBe(502);
    expect(rejected.body.error.code).toBe("invalid_output");
    expect((await call(bad, "GET", `${base}/campaigns`, w.token)).body).toEqual([]);
    db.close();

    const s = boot();
    const w2 = await signup(s.app);
    const b2 = `/api/workspaces/${w2.id}`;
    await call(s.app, "PUT", `${b2}/brain`, w2.token, BRAIN);
    const g = await call(s.app, "POST", `${b2}/campaigns/generate`, w2.token, { providerId: "mock", model: "mock-deterministic-1" });
    await call(s.app, "PUT", `${b2}/brain`, w2.token, { ...BRAIN, maxDailyBudgetCents: 300 });
    const r = await call(s.app, "POST", `${b2}/campaigns/${g.body.id}/proposals`, w2.token, {});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("budget_exceeds_cap");
  });

  it("refuses an unavailable provider (409) and reports invalid model output as 502, storing nothing", async () => {
    for (const [behavior, status] of [["unavailable", 409], ["invalid", 502]] as const) {
      const db = openDb(":memory:");
      migrate(db);
      const app = buildServer(buildContext({ db, env: {}, aiProviders: [new MockAiProvider(behavior)] }));
      const w = await signup(app);
      await call(app, "PUT", `/api/workspaces/${w.id}/brain`, w.token, BRAIN);
      const r = await call(app, "POST", `/api/workspaces/${w.id}/campaigns/generate`, w.token, { providerId: "mock", model: "mock-deterministic-1" });
      expect(r.status).toBe(status);
      expect((await call(app, "GET", `/api/workspaces/${w.id}/campaigns`, w.token)).body).toEqual([]);
      db.close();
    }
  });

  it("serves the UI", async () => {
    const s = boot();
    const res = await s.app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("MotiveStack");
  });
});

describe("persistence across restarts", () => {
  it("campaigns, proposals, leads and activity survive closing and reopening the database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    open.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "t.db");

    const first = boot(path);
    const { w, base, cid, pid } = await fullFlow(first);
    await call(first.app, "POST", `${base}/campaigns/${cid}/simulate-lead`, w.token, { fullName: "Pat", email: "pat@example.com", eventId: "e1" });
    first.db.close(); // "stop the app" with the lead still queued

    const second = boot(path); // "start the app again"
    const before = await call(second.app, "GET", `${base}/proposals/${pid}`, w.token);
    expect(before.body).toMatchObject({ status: "executed", externalResource: { verifiedState: "PAUSED" } });
    expect((await call(second.app, "GET", `${base}/campaigns`, w.token)).body).toHaveLength(1);
    await second.worker.runUntilIdle(); // the queued lead job is picked up after restart
    expect((await call(second.app, "GET", `${base}/leads`, w.token)).body).toEqual([expect.objectContaining({ crmStatus: "synced" })]);
    expect(second.ctx.db.prepare("SELECT COUNT(*) n FROM sim_meta_campaigns").get()).toEqual({ n: 1 });
  });
});

describe("mock vs live separation", () => {
  const liveEnv = { INTEGRATION_MODE: "live", LIVE_META: "true", META_ACCESS_TOKEN: "not-a-real-token", META_WRITE_ALLOWLIST: "act_111" };

  it("a mock-mode approval cannot authorize a write once the server is in live mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ms-"));
    open.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "t.db");

    const mock = boot(path);
    const w = await signup(mock.app);
    const base = `/api/workspaces/${w.id}`;
    await call(mock.app, "PUT", `${base}/brain`, w.token, BRAIN);
    const g = await call(mock.app, "POST", `${base}/campaigns/generate`, w.token, { providerId: "mock", model: "mock-deterministic-1" });
    const p = await call(mock.app, "POST", `${base}/campaigns/${g.body.id}/proposals`, w.token, {});
    await call(mock.app, "POST", `${base}/proposals/${p.body.id}/approve`, w.token, { decidedBy: "elia" });
    await call(mock.app, "POST", `${base}/proposals/${p.body.id}/execute`, w.token);
    mock.db.close();

    const live = boot(path, liveEnv); // same database, now in live mode; no network is touched
    const refused = await live.worker.runUntilIdle();
    expect(refused).toBe(1);
    const after = await call(live.app, "GET", `${base}/proposals/${p.body.id}`, w.token);
    expect(after.body).toMatchObject({ status: "failed", lastError: "mode_mismatch", externalResource: null });
  });

  it("live mode refuses synthetic leads and requires a connected ad account before proposing", async () => {
    const s = boot(":memory:", liveEnv);
    const w = await signup(s.app);
    const base = `/api/workspaces/${w.id}`;
    await call(s.app, "PUT", `${base}/brain`, w.token, BRAIN);
    const g = await call(s.app, "POST", `${base}/campaigns/generate`, w.token, { providerId: "mock", model: "mock-deterministic-1" });
    const noAccount = await call(s.app, "POST", `${base}/campaigns/${g.body.id}/proposals`, w.token, {});
    expect(noAccount.status).toBe(409);
    expect(noAccount.body.error.code).toBe("meta_account_required");
    const lead = await call(s.app, "POST", `${base}/campaigns/${g.body.id}/simulate-lead`, w.token, { email: "a@b.co" });
    expect(lead.status).toBe(409);
    expect(lead.body.error.code).toBe("simulated_leads_disabled");
  });

  it("credentials present does not turn live mode on", () => {
    const s = boot(":memory:", { META_ACCESS_TOKEN: "present-but-mode-is-mock", ANTHROPIC_API_KEY: "present-too" } as never);
    expect(s.ctx.integrations).toEqual({ mode: "mock", liveMeta: false, liveGhl: false, aiMode: "mock", allowLiveProviderCalls: false, liveAi: false, localAi: false });
    expect(s.ctx.metaFor("ws_x").mode).toBe("mock");
    expect(s.ctx.ai.list().filter((p) => !p.simulated).every((p) => p.available === false)).toBe(true); // real providers stay unavailable: keys alone do nothing
  });
});

describe("integration config", () => {
  it("defaults to mock and rejects bad values or unsupported live providers", async () => {
    const { loadIntegrationConfig } = await import("../src/integrations/mode.js");
    expect(loadIntegrationConfig({})).toEqual({ mode: "mock", liveMeta: false, liveGhl: false, aiMode: "mock", allowLiveProviderCalls: false, liveAi: false, localAi: false });
    expect(loadIntegrationConfig({ LIVE_META: "true" }).liveMeta).toBe(false); // flag without INTEGRATION_MODE=live is ignored
    expect(loadIntegrationConfig({ INTEGRATION_MODE: "live", LIVE_META: "true" }).liveMeta).toBe(true);
    expect(() => loadIntegrationConfig({ INTEGRATION_MODE: "yes" })).toThrow();
    expect(() => loadIntegrationConfig({ INTEGRATION_MODE: "live", LIVE_GHL: "true" })).toThrow(/not supported/);
  });

  it("real AI providers are offered only with BOTH AI_PROVIDER_MODE=live and ALLOW_LIVE_PROVIDER_CALLS=true, plus a key", () => {
    const db = openDb(":memory:");
    migrate(db);
    const avail = (env: Record<string, string>) => {
      const c = buildContext({ db, env });
    // a blank or placeholder value is not a key, so it never makes a provider available
      return Object.fromEntries(c.ai.list().map((p) => [p.id, p.available]));
    };
    const keys = { OPENAI_API_KEY: "sk-TEST-FAKE-openai-0000000000", ANTHROPIC_API_KEY: "sk-ant-TEST-FAKE-0000000000" };
    expect(avail({ ...keys })).toMatchObject({ mock: true, openai: false, anthropic: false }); // keys alone: nothing live
    expect(avail({ ...keys, ALLOW_LIVE_PROVIDER_CALLS: "true" })).toMatchObject({ openai: false, anthropic: false }); // allow flag alone: nothing live
    expect(() => avail({ ...keys, AI_PROVIDER_MODE: "live" })).toThrow(/ALLOW_LIVE_PROVIDER_CALLS/); // live without the second switch is a startup error
    expect(avail({ ...keys, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true" })).toMatchObject({ openai: true, anthropic: true });
    expect(avail({ OPENAI_API_KEY: "sk-TEST-FAKE-openai-0000000000", AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true" })).toMatchObject({ openai: true, anthropic: false }); // per-provider keys
    db.close();
  });
});

describe("AI endpoints", () => {
  it("require the workspace token", async () => {
    const s = boot();
    const w = await signup(s.app);
    for (const [m, p] of [["GET", "ai/settings"], ["PUT", "ai/settings"], ["GET", "ai/usage"], ["POST", "ai/connection-test"]] as const) {
      expect((await call(s.app, m, `/api/workspaces/${w.id}/${p}`)).status).toBe(401);
    }
  });

  it("settings round-trip, validate, and list every model with its eligibility", async () => {
    const s = boot();
    const w = await signup(s.app);
    const base = `/api/workspaces/${w.id}/ai`;
    const first = await call(s.app, "GET", `${base}/settings`, w.token);
    expect(first.body.settings.routingMode).toBe("automatic");
    expect(first.body.models.find((m: any) => m.provider === "mock").eligible).toBe(true);
    expect(first.body.models.find((m: any) => m.provider === "openai")).toMatchObject({ eligible: false, reason: expect.stringContaining("mock mode") });

    const bad = await call(s.app, "PUT", `${base}/settings`, w.token, { routingMode: "manual", provider: "mock", model: "nope" });
    expect(bad.status).toBe(400);
    const good = await call(s.app, "PUT", `${base}/settings`, w.token, { routingMode: "manual", provider: "mock", model: "mock-deterministic-1", maxRequestsPerDay: 10 });
    expect(good.status).toBe(200);
    expect((await call(s.app, "GET", `${base}/settings`, w.token)).body.settings).toMatchObject({ routingMode: "manual", maxRequestsPerDay: 10 });
  });

  it("generate with an empty body uses the workspace settings, and usage is then visible", async () => {
    const s = boot();
    const w = await signup(s.app);
    const base = `/api/workspaces/${w.id}`;
    await call(s.app, "PUT", `${base}/brain`, w.token, BRAIN);
    const g = await call(s.app, "POST", `${base}/campaigns/generate`, w.token);
    expect(g.status).toBe(201);
    expect(g.body.versions[0]).toMatchObject({ aiProvider: "mock" });
    const u = await call(s.app, "GET", `${base}/ai/usage`, w.token);
    expect(u.body.recent).toEqual([expect.objectContaining({ simulated: true, costStatus: "not_applicable", taskType: "campaign_brief" })]);
    expect(u.body.summary.today).toMatchObject({ simulatedRequests: 1, liveRequests: 0 });
    expect(JSON.stringify(u.body)).not.toContain(BRAIN.businessName); // metadata only
  });

  it("connection test is simulated in mock mode and cannot reach a real provider", async () => {
    const s = boot();
    const w = await signup(s.app);
    const base = `/api/workspaces/${w.id}/ai/connection-test`;
    const sim = await call(s.app, "POST", base, w.token, { provider: "mock", model: "mock-deterministic-1" });
    expect(sim.body).toMatchObject({ simulated: true, connected: null });
    const real = await call(s.app, "POST", base, w.token, { provider: "anthropic", model: "claude-haiku-5-5" });
    expect(real.status).toBe(409);
    expect(real.body.error.code).toBe("live_disabled");
  });

  it("another workspace's token cannot read this workspace's AI settings or usage", async () => {
    const s = boot();
    const a = await signup(s.app, "Alpha Co");
    const b = await signup(s.app, "Bravo Co");
    expect((await call(s.app, "GET", `/api/workspaces/${a.id}/ai/usage`, b.token)).status).toBe(401);
    expect((await call(s.app, "PUT", `/api/workspaces/${a.id}/ai/settings`, b.token, { routingMode: "automatic" })).status).toBe(401);
  });

  it("never exposes provider keys, even when they are in the environment", async () => {
    const KEYS = { OPENAI_API_KEY: "sk-OPENAI-SECRET-123", ANTHROPIC_API_KEY: "sk-ant-SECRET-456", META_ACCESS_TOKEN: "EAA-META-SECRET" };
    for (const env of [KEYS, { ...KEYS, AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true" }]) {
      const s = boot(":memory:", env);
      const w = await signup(s.app);
      const base = `/api/workspaces/${w.id}`;
      const dump = [
        (await call(s.app, "GET", "/api/config")).body,
        (await call(s.app, "GET", `${base}/ai/settings`, w.token)).body,
        (await call(s.app, "GET", `${base}/ai/usage`, w.token)).body,
        (await call(s.app, "POST", `${base}/ai/connection-test`, w.token, { provider: "anthropic", model: "no-such-model" })).body,
      ].map((b) => JSON.stringify(b)).join("\n");
      expect(dump).not.toMatch(/SECRET|sk-/);
      const html = (await s.app.inject({ method: "GET", url: "/app.js" })).body;
      expect(html).not.toMatch(/SECRET|sk-ant|OPENAI_API_KEY/);
    }
  });

  it("maps provider failures to safe HTTP responses without leaking details", async () => {
    const failing = (kind: AiError["kind"]): AiProvider => ({
      id: "fx", label: "fx", models: ["m"], simulated: false, isAvailable: () => true,
      generateText: async () => { throw new AiError(kind, `upstream said ${kind} for key sk-LEAK`); },
      generateObject: async () => { throw new AiError(kind, `upstream said ${kind} for key sk-LEAK`); },
    });
    const expected: Array<[AiError["kind"], number]> = [["auth", 502], ["rate_limit", 429], ["timeout", 504], ["insufficient_balance", 502]];
    for (const [kind, status] of expected) {
      const db = openDb(":memory:");
      migrate(db);
      const registry = new ModelRegistry([{ provider: "fx", model: "m", label: "fx", enabled: true, tasks: ["campaign_brief", "connection_test"], capabilities: { text: true, structuredOutput: true }, costTier: "low" }]);
      // live requests need the server's spending ceiling and a price for the model
      const pricing = new PricingTable("USD", [{ provider: "fx", model: "m", inputPerMTokMicros: 1_000_000, outputPerMTokMicros: 1_000_000, appliesTo: "test", asOf: "2026-01-01", source: "https://example.com/p" }]);
      const ctx = buildContext({ db, env: { AI_PROVIDER_MODE: "live", ALLOW_LIVE_PROVIDER_CALLS: "true", AI_LIVE_BUDGET_MICROS: "1000000000" }, aiProviders: [failing(kind)], registry, pricing, gateway: { sleep: async () => {}, maxRetries: 0 } });
      const app = buildServer(ctx);
      const w = await signup(app);
      await call(app, "PUT", `/api/workspaces/${w.id}/brain`, w.token, BRAIN);
      const r = await call(app, "POST", `/api/workspaces/${w.id}/campaigns/generate`, w.token, {});
      expect(r.status).toBe(status);
      expect(r.body.error.code).toBe(kind);
      db.close();
    }
  });
});

describe("empty JSON bodies", () => {
  it("accepts an empty body with a JSON content-type where all fields are optional (generate uses workspace settings)", async () => {
    const s = boot();
    const w = await signup(s.app);
    const base = `/api/workspaces/${w.id}`;
    await call(s.app, "PUT", `${base}/brain`, w.token, BRAIN);
    const res = await s.app.inject({ method: "POST", url: `${base}/campaigns/generate`, headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" } });
    expect(res.statusCode).toBe(201);
  });

  it("still rejects malformed JSON, and still validates required fields when the body is empty", async () => {
    const s = boot();
    const w = await signup(s.app);
    const base = `/api/workspaces/${w.id}`;
    const malformed = await s.app.inject({ method: "POST", url: `${base}/campaigns/generate`, headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" }, payload: "{not json" });
    expect(malformed.statusCode).toBe(400);
    const emptyRequired = await s.app.inject({ method: "PUT", url: `${base}/brain`, headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" } });
    expect(emptyRequired.statusCode).toBe(400);
    expect(JSON.parse(emptyRequired.body).error.code).toBe("validation");
  });
});
