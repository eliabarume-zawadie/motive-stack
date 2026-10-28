/**
 * Phase 4: lead status with history and detail, duplicate-event state, and bounded retry of failed background jobs. Simulated CRM and Meta only.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/app/context.js";
import { audit } from "../src/app/core.js";
import { createWorker } from "../src/app/worker.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";

const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}

async function setup() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx);
  const worker = createWorker(ctx);
  open.push(() => db.open && db.close());
  const made = await call(app, "POST", "/api/workspaces", undefined, { name: "Lead Co" });
  const token = made.body.token as string;
  const base = `/api/workspaces/${made.body.workspace.id}`;
  await call(app, "PUT", `${base}/brain`, token, BRAIN);
  const gen = await call(app, "POST", `${base}/campaigns/generate`, token, { providerId: "mock", model: "mock-deterministic-1" });
  const cid = gen.body.id as string;
  const prop = await call(app, "POST", `${base}/campaigns/${cid}/proposals`, token, {});
  await call(app, "POST", `${base}/proposals/${prop.body.id}/approve`, token, { decidedBy: "elia" });
  await call(app, "POST", `${base}/proposals/${prop.body.id}/execute`, token);
  await worker.runUntilIdle();
  return { db, ctx, app, worker, token, base, cid };
}
async function addLead(t: Awaited<ReturnType<typeof setup>>, eventId: string, fullName = "Pat Lee") {
  const r = await call(t.app, "POST", `${t.base}/campaigns/${t.cid}/simulate-lead`, t.token, { fullName, email: "pat@example.com", eventId });
  await t.worker.runUntilIdle();
  return r;
}

describe("lead status, detail and history", () => {
  it("a new lead starts as 'new'; changing its status records who, when and why, and the detail shows the history", async () => {
    const t = await setup();
    await addLead(t, "e1");
    const list = (await call(t.app, "GET", `${t.base}/leads`, t.token)).body as Json[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "new", simulated: true, crmStatus: "synced" });
    const id = list[0]!.id as string;

    const upd = await call(t.app, "PUT", `${t.base}/leads/${id}/status`, t.token, { status: "contacted", note: "Called, left a message" });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ status: "contacted", source: "simulated", eventId: "e1", simulated: true, campaignName: expect.any(String) });
    expect(upd.body.history).toHaveLength(1);
    expect(upd.body.history[0]).toMatchObject({ from: "new", to: "contacted", note: "Called, left a message" });
    expect(upd.body.history[0].by).toMatch(/workspace-token/); // server-derived, not what the body says
    const types = ((await call(t.app, "GET", `${t.base}/activity`, t.token)).body as unknown as Json[]).map((a) => a.type);
    expect(types).toContain("lead.status_changed");
  });

  it("refuses an unknown status, the same status again, and a lead from another workspace", async () => {
    const t = await setup();
    await addLead(t, "e1");
    const id = ((await call(t.app, "GET", `${t.base}/leads`, t.token)).body as Json[])[0]!.id as string;
    expect((await call(t.app, "PUT", `${t.base}/leads/${id}/status`, t.token, { status: "vip" })).status).toBe(400);
    expect((await call(t.app, "PUT", `${t.base}/leads/${id}/status`, t.token, {})).status).toBe(400);
    const same = await call(t.app, "PUT", `${t.base}/leads/${id}/status`, t.token, { status: "new" });
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe("status_unchanged");
    const other = await call(t.app, "POST", "/api/workspaces", undefined, { name: "Other" });
    const o = `/api/workspaces/${other.body.workspace.id}`;
    expect((await call(t.app, "GET", `${o}/leads/${id}`, other.body.token)).status).toBe(404);
    expect((await call(t.app, "PUT", `${o}/leads/${id}/status`, other.body.token, { status: "won" })).status).toBe(404);
    expect((await call(t.app, "GET", `${t.base}/leads/${id}`, t.token)).body.status).toBe("new");
  });

  it("a repeated event id is stored once and the detail says how many repeats were ignored", async () => {
    const t = await setup();
    await addLead(t, "same");
    expect((await addLead(t, "same")).body.duplicate).toBe(true);
    expect((await addLead(t, "same")).body.duplicate).toBe(true);
    const list = (await call(t.app, "GET", `${t.base}/leads`, t.token)).body as Json[];
    expect(list).toHaveLength(1);
    const d = await call(t.app, "GET", `${t.base}/leads/${list[0]!.id}`, t.token);
    expect(d.body.duplicateEventsIgnored).toBe(2);
    expect(d.body.crm).toMatchObject({ status: "synced", simulated: true });
    expect(JSON.stringify(d.body)).not.toContain(t.token);
  });

  it("needs sign-in", async () => {
    const t = await setup();
    expect((await call(t.app, "GET", `${t.base}/leads/x`)).status).toBe(401);
    expect((await call(t.app, "PUT", `${t.base}/leads/x/status`, undefined, { status: "won" })).status).toBe(401);
  });
});

describe("failed jobs: what they are about and a bounded retry", () => {
  function killLeadJob(t: Awaited<ReturnType<typeof setup>>) {
    t.db.prepare("UPDATE jobs SET status = 'dead', attempts = max_attempts, last_error = 'CRM said no\nsecond line' WHERE type = 'process_lead'").run();
    return (t.db.prepare("SELECT id FROM jobs WHERE type = 'process_lead'").get() as { id: string }).id;
  }

  it("the dashboard shows what a job is about, how long it took, and whether it may be retried", async () => {
    const t = await setup();
    await addLead(t, "e1", "Sam Jones");
    const jobs = ((await call(t.app, "GET", `${t.base}/dashboard`, t.token)).body.jobs.recent as Json[]);
    const lead = jobs.find((j) => j.type === "process_lead")!;
    expect(lead).toMatchObject({ about: "Lead: Sam Jones", status: "done", retryable: false, simulated: true });
    expect(typeof lead.durationMs).toBe("number");
    const exec = jobs.find((j) => j.type === "execute_proposal")!;
    expect(exec.about).toMatch(/^Campaign: /);
  });

  it("a lead job that gave up can be retried (safely, once stored it is not duplicated), at most twice, and the error is one safe line", async () => {
    const t = await setup();
    await addLead(t, "e1");
    const jid = killLeadJob(t);
    let dash = (await call(t.app, "GET", `${t.base}/dashboard`, t.token)).body.jobs;
    const dead = dash.attention.find((j: Json) => j.id === jid);
    expect(dead).toMatchObject({ retryable: true, lastError: "CRM said no" });

    const r1 = await call(t.app, "POST", `${t.base}/jobs/${jid}/retry`, t.token);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ status: "queued", manualRetries: 1 });
    await t.worker.runUntilIdle();
    expect((await call(t.app, "GET", `${t.base}/leads`, t.token)).body).toHaveLength(1); // no duplicate lead
    expect(t.db.prepare("SELECT COUNT(*) n FROM crm_syncs").get()).toEqual({ n: 1 });
    expect((t.db.prepare("SELECT status FROM jobs WHERE id = ?").get(jid) as Json).status).toBe("done");
    // a job that is not failed cannot be retried
    expect((await call(t.app, "POST", `${t.base}/jobs/${jid}/retry`, t.token)).body.error.code).toBe("job_not_retryable");

    t.db.prepare("UPDATE jobs SET status = 'dead' WHERE id = ?").run(jid);
    expect((await call(t.app, "POST", `${t.base}/jobs/${jid}/retry`, t.token)).status).toBe(200);
    t.db.prepare("UPDATE jobs SET status = 'dead' WHERE id = ?").run(jid);
    const third = await call(t.app, "POST", `${t.base}/jobs/${jid}/retry`, t.token);
    expect(third.status).toBe(409);
    expect(third.body.error.message).toMatch(/2 times/);
    const types = ((await call(t.app, "GET", `${t.base}/activity`, t.token)).body as unknown as Json[]).filter((a) => a.type === "job.retried");
    expect(types).toHaveLength(2);
  });

  it("an execution job is never retried from here, and an unknown job is a 404", async () => {
    const t = await setup();
    const exec = (t.db.prepare("SELECT id FROM jobs WHERE type = 'execute_proposal'").get() as { id: string }).id;
    t.db.prepare("UPDATE jobs SET status = 'dead' WHERE id = ?").run(exec);
    const r = await call(t.app, "POST", `${t.base}/jobs/${exec}/retry`, t.token);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/unconfirmed/);
    expect((t.db.prepare("SELECT status FROM jobs WHERE id = ?").get(exec) as Json).status).toBe("dead");
    expect((await call(t.app, "POST", `${t.base}/jobs/nope/retry`, t.token)).status).toBe(404);
  });
});

describe("integration status: last explicit test", () => {
  it("a simulated test verifies nothing and is not recorded as a result; a recorded real-path result is reported, without any key or secret", async () => {
    const t = await setup();
    const wsId = t.base.split("/").pop()!;
    expect((await call(t.app, "GET", t.base + "/dashboard", t.token)).body.integrations.lastAiTest).toBeNull();
    const run = await call(t.app, "POST", t.base + "/ai/connection-test", t.token, { provider: "mock", model: "mock-deterministic-1" });
    expect(run.body).toMatchObject({ simulated: true, connected: null });
    expect((await call(t.app, "GET", t.base + "/dashboard", t.token)).body.integrations.lastAiTest).toBeNull();
    audit(t.ctx, wsId, "owner", "ai.connection_test", "ai_task", "t1", { provider: "openai", model: "gpt-x", ok: false, kind: "auth" });
    const after = (await call(t.app, "GET", t.base + "/dashboard", t.token)).body.integrations;
    expect(after.lastAiTest).toMatchObject({ ok: false, provider: "openai", model: "gpt-x", simulated: false });
    expect(JSON.stringify(after)).not.toMatch(/sk-|apikey|api_key/i);
  });
});
