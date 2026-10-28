/**
 * Phase 3: the owner's marketing goal travels with the campaign, a bad plan is refused before any model request, and the version history says what
 * changed between versions. Mock AI only.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/app/context.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";

const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

function boot() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  open.push(() => db.open && db.close());
  return { db, ctx, app: buildServer(ctx) };
}
type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
async function setup() {
  const s = boot();
  const r = await s.app.inject({ method: "POST", url: "/api/workspaces", payload: { name: "Plan Co" } });
  const { workspace, token } = JSON.parse(r.body);
  const base = `/api/workspaces/${workspace.id}`;
  expect((await call(s.app, "PUT", `${base}/brain`, token, BRAIN)).status).toBe(200);
  return { ...s, base, token };
}
const MOCK = { providerId: "mock", model: "mock-deterministic-1" };
const aiRequests = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT COUNT(*) n FROM ai_usage").get() as { n: number }).n;

describe("campaign plan (goal, focus service, run length)", () => {
  it("a draft made without a goal has no plan, and says so", async () => {
    const t = await setup();
    const g = await call(t.app, "POST", `${t.base}/campaigns/generate`, t.token, MOCK);
    expect(g.status).toBe(201);
    expect(g.body.plan).toBeNull();
  });

  it("stores the goal beside the campaign and returns it with the detail view", async () => {
    const t = await setup();
    const service = BRAIN.services[0]!;
    const g = await call(t.app, "POST", `${t.base}/campaigns/generate`, t.token, { ...MOCK, goal: "promote_service", focusService: service, durationDays: 14 });
    expect(g.status).toBe(201);
    expect(g.body.plan).toMatchObject({ goal: "promote_service", focusService: service, durationDays: 14 });
    const again = await call(t.app, "GET", `${t.base}/campaigns/${g.body.id}`, t.token);
    expect(again.body.plan).toMatchObject({ goal: "promote_service", goalLabel: "Promote one service or offer" });
    const audit = t.db.prepare("SELECT detail FROM audit_events WHERE type = 'campaign.generated'").get() as { detail: string } | undefined;
    expect(audit?.detail ?? "").toContain("promote_service");
  });

  it("refuses an unknown goal, a service the Business Brain does not list, a missing service and a silly run length, without asking any model", async () => {
    const t = await setup();
    const before = aiRequests(t.db);
    for (const body of [
      { ...MOCK, goal: "world_domination" },
      { ...MOCK, goal: "promote_service" },
      { ...MOCK, goal: "promote_service", focusService: "Quantum plumbing" },
      { ...MOCK, durationDays: 0 },
      { ...MOCK, durationDays: 365 },
      { ...MOCK, durationDays: 2.5 },
    ]) {
      const r = await call(t.app, "POST", `${t.base}/campaigns/generate`, t.token, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect(aiRequests(t.db)).toBe(before);
    expect((await call(t.app, "GET", `${t.base}/campaigns`, t.token)).body).toEqual([]);
  });

  it("the focus service match ignores case and spacing; unknown request keys are still rejected", async () => {
    const t = await setup();
    const ok = await call(t.app, "POST", `${t.base}/campaigns/generate`, t.token, { ...MOCK, goal: "promote_service", focusService: `  ${BRAIN.services[0]!.toUpperCase()} ` });
    expect(ok.status).toBe(201);
    const extra = await call(t.app, "POST", `${t.base}/campaigns/generate`, t.token, { ...MOCK, budgetCents: 99999 });
    expect(extra.status).toBe(400);
  });
});

describe("version history", () => {
  it("lists each version with what changed from the one before", async () => {
    const t = await setup();
    const g = await call(t.app, "POST", `${t.base}/campaigns/generate`, t.token, MOCK);
    const cid = g.body.id as string;
    expect(g.body.versionHistory).toHaveLength(1);
    expect(g.body.versionHistory[0].changes).toEqual([]);
    const brief = { ...g.body.brief, name: "Renamed campaign", headlines: [g.body.brief.headlines[0]] };
    const edit = await call(t.app, "PUT", `${t.base}/campaigns/${cid}/brief`, t.token, brief);
    expect(edit.status).toBe(200);
    const h = edit.body.versionHistory as Json[];
    expect(h.map((x) => [x.version, x.source])).toEqual([[1, "ai"], [2, "human"]]);
    const fields = h[1]!.changes.map((c: Json) => c.field).sort();
    expect(fields).toEqual(["headlines", "name"]);
    expect(h[1]!.changes.find((c: Json) => c.field === "name")).toMatchObject({ label: "Name", from: g.body.brief.name, to: "Renamed campaign" });
  });
});
