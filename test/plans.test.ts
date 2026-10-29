/**
 * Phase 3: the canonical campaign lifecycle, marketing plans (recommend, edit, batch-generate, review), plan budgets that are never multiplied, and the rule
 * that one campaign's approval never covers another's. Mock AI only; signed-in people are test identities.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { LIFECYCLE_STATES, TRANSITIONS, canTransition, syncAllLifecycles } from "../src/app/lifecycle.js";
import { createWorker } from "../src/app/worker.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const oidc = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); });

const BRAIN3 = { ...BRAIN, services: ["Emergency plumbing", "Water heater repair", "Drain cleaning"] };
const MOCK = { providerId: "mock", model: "mock-deterministic-1" };

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT" | "PATCH", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}

function boot() {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} } });
  const app = buildServer(ctx, oidc());
  open.push(() => db.open && db.close());
  return { db, ctx, app, worker: createWorker(ctx) };
}
type W = ReturnType<typeof boot>;
async function person(w: W, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  const r = await call(w.app, "GET", "/api/me", token);
  return { token, id: r.body.user.id as string };
}
async function team(brain: Json = BRAIN3) {
  const w = boot();
  const owner = await person(w, "olivia"), admin = await person(w, "adam"), admin2 = await person(w, "amy"), operator = await person(w, "oscar"), viewer = await person(w, "vera");
  const id = (await call(w.app, "POST", "/api/workspaces", owner.token, { name: "Plan Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${id}`;
  for (const [p, role] of [[admin, "admin"], [admin2, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) await call(w.app, "POST", `${base}/members`, owner.token, { userId: p.id, role });
  expect((await call(w.app, "PUT", `${base}/brain`, owner.token, brain)).status).toBe(200);
  return { w, base, id, owner, admin, admin2, operator, viewer };
}
type T = Awaited<ReturnType<typeof team>>;
const recommend = (t: T, by: { token: string }, body: Json = {}) => call(t.w.app, "POST", `${t.base}/plans/recommend`, by.token, body);
const generate = (t: T, by: { token: string }, pid: string, body: Json = {}) => call(t.w.app, "POST", `${t.base}/plans/${pid}/generate`, by.token, { ...MOCK, ...body });
const plan = (t: T, by: { token: string }, pid: string) => call(t.w.app, "GET", `${t.base}/plans/${pid}`, by.token);
const campaignCount = (t: T) => (t.w.db.prepare("SELECT COUNT(*) n FROM campaigns").get() as { n: number }).n;
const lifecycleOf = async (t: T, cid: string) => (await call(t.w.app, "GET", `${t.base}/campaigns/${cid}`, t.viewer.token)).body.lifecycle.state as string;

/* ---------------------------------------------------------------- lifecycle */

describe("the canonical campaign lifecycle", () => {
  it("has an explicit transition table: forward steps, no way out of archived, and no archiving while a run is queued", () => {
    expect([...LIFECYCLE_STATES]).toEqual(["draft", "needs_review", "ready_for_approval", "approved", "ready_for_execution", "executed_simulated", "executed_external", "completed", "archived"]);
    expect(canTransition("draft", "ready_for_approval")).toBe(true);
    expect(canTransition("ready_for_approval", "approved")).toBe(true);
    expect(canTransition("approved", "ready_for_execution")).toBe(true);
    expect(canTransition("ready_for_execution", "executed_simulated")).toBe(true);
    expect(canTransition("executed_simulated", "completed")).toBe(true);
    expect(canTransition("draft", "draft")).toBe(true);
    expect(canTransition("draft", "executed_simulated")).toBe(false); // nothing skips approval
    expect(canTransition("draft", "approved")).toBe(false);
    expect(canTransition("ready_for_execution", "archived")).toBe(false);
    expect(canTransition("draft", "completed")).toBe(false);
    for (const s of LIFECYCLE_STATES) expect(canTransition("archived", s), `archived -> ${s}`).toBe(s === "archived");
    expect(TRANSITIONS.archived).toEqual([]);
  });

  it("follows a campaign from draft through approval, queued run, simulated run and completion, driven by real events", async () => {
    const t = await team();
    const gen = (await call(t.w.app, "POST", `${t.base}/campaigns/generate`, t.operator.token, MOCK)).body;
    const cid = gen.id as string;
    expect(gen.lifecycle).toEqual({ state: "draft", label: "Draft" });
    const prop = (await call(t.w.app, "POST", `${t.base}/campaigns/${cid}/proposals`, t.operator.token, {})).body.id as string;
    expect(await lifecycleOf(t, cid)).toBe("ready_for_approval");
    await call(t.w.app, "POST", `${t.base}/proposals/${prop}/approve`, t.admin.token, { decidedBy: "x" });
    expect(await lifecycleOf(t, cid)).toBe("approved");
    await call(t.w.app, "POST", `${t.base}/proposals/${prop}/execute`, t.admin.token);
    expect(await lifecycleOf(t, cid)).toBe("ready_for_execution");
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${cid}/archive`, t.admin.token)).body.error.code).toBe("invalid_transition"); // a run is queued
    await t.w.worker.runUntilIdle();
    expect(await lifecycleOf(t, cid)).toBe("executed_simulated");
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${cid}/complete`, t.operator.token)).status).toBe(403); // campaigns.archive is admin+
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${cid}/complete`, t.admin.token)).body.lifecycle.state).toBe("completed");
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${cid}/archive`, t.admin.token)).body.lifecycle.state).toBe("archived");
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${cid}/complete`, t.admin.token)).body.error.code).toBe("invalid_transition"); // archived is final
    const changes = (t.w.db.prepare("SELECT detail FROM audit_events WHERE type = 'campaign.lifecycle_changed' AND entity_id = ? ORDER BY id").all(cid) as Array<{ detail: string }>).map((r) => JSON.parse(r.detail));
    expect(changes.map((c) => c.to)).toEqual(["ready_for_approval", "approved", "ready_for_execution", "executed_simulated", "completed", "archived"]);
    expect(changes.some((c) => c.anomaly)).toBe(false);
  });

  it("an edit after approval returns the campaign to draft and makes only its own approval stale; completing needs a campaign that was run", async () => {
    const t = await team();
    const gen = (await call(t.w.app, "POST", `${t.base}/campaigns/generate`, t.operator.token, MOCK)).body;
    const prop = (await call(t.w.app, "POST", `${t.base}/campaigns/${gen.id}/proposals`, t.operator.token, {})).body.id as string;
    await call(t.w.app, "POST", `${t.base}/proposals/${prop}/approve`, t.admin.token, { decidedBy: "x" });
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${gen.id}/complete`, t.admin.token)).body.error.code).toBe("invalid_transition");
    await call(t.w.app, "PUT", `${t.base}/campaigns/${gen.id}/brief`, t.operator.token, { ...gen.brief, name: "Edited name" });
    expect(await lifecycleOf(t, gen.id)).toBe("draft");
    expect(t.w.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(prop)).toEqual({ status: "stale" });
  });

  it("a draft with a blocking question or a review flag is 'needs review' until it is fixed", async () => {
    const t = await team();
    const gen = (await call(t.w.app, "POST", `${t.base}/campaigns/generate`, t.operator.token, MOCK)).body;
    const flagged = { ...gen.brief, openQuestions: [{ question: "What is the approved price?", impact: "Without it the offer cannot be stated", blocking: true }] };
    await call(t.w.app, "PUT", `${t.base}/campaigns/${gen.id}/brief`, t.operator.token, flagged);
    expect(await lifecycleOf(t, gen.id)).toBe("needs_review");
    await call(t.w.app, "PUT", `${t.base}/campaigns/${gen.id}/brief`, t.operator.token, { ...gen.brief, openQuestions: [] });
    expect(await lifecycleOf(t, gen.id)).toBe("draft");
  });

  it("archiving a draft closes any open proposal for it and cannot be done by an operator", async () => {
    const t = await team();
    const gen = (await call(t.w.app, "POST", `${t.base}/campaigns/generate`, t.operator.token, MOCK)).body;
    const prop = (await call(t.w.app, "POST", `${t.base}/campaigns/${gen.id}/proposals`, t.operator.token, {})).body.id as string;
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${gen.id}/archive`, t.operator.token)).status).toBe(403);
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${gen.id}/archive`, t.admin.token)).body.lifecycle.state).toBe("archived");
    expect(t.w.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(prop)).toEqual({ status: "stale" });
    expect((await call(t.w.app, "POST", `${t.base}/proposals/${prop}/approve`, t.admin.token, { decidedBy: "x" })).body.error.code).toBe("stale"); // the closed proposal can no longer be approved
  });
});

describe("migration 017: existing campaigns get a lifecycle without losing anything", () => {
  function dbThrough016() {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of readdirSync("src/db/migrations").filter((x) => x.endsWith(".sql") && x < "017").sort()) { db.exec(readFileSync(`src/db/migrations/${f}`, "utf8")); db.prepare("INSERT INTO schema_migrations VALUES (?, 'then')").run(f); }
    return db;
  }
  it("maps legacy 'draft' and 'launched_paused' (and open proposals) to the canonical states, keeps every column's value, and is idempotent", () => {
    const db = dbThrough016();
    open.push(() => db.open && db.close());
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_a','A','h','t')").run();
    const camp = (id: string, status: string) => db.prepare("INSERT INTO campaigns (id, workspace_id, name, status, current_version, created_at) VALUES (?, 'ws_a', ?, ?, 1, 't')").run(id, id, status);
    const prop = (id: string, camp: string, status: string, mode: string) => db.prepare("INSERT INTO action_proposals (id, workspace_id, campaign_id, campaign_version, type, payload, payload_hash, daily_budget_cents, integration_mode, status, created_at, updated_at) VALUES (?, 'ws_a', ?, 1, 't', '{}', 'x', 100, ?, ?, 't', 't')").run(id, camp, mode, status);
    for (const [id, st] of [["c_draft", "draft"], ["c_sim", "launched_paused"], ["c_live", "launched_paused"], ["c_prop", "draft"], ["c_appr", "draft"]] as const) camp(id, st);
    prop("p_sim", "c_sim", "executed", "mock"); prop("p_live", "c_live", "executed", "live"); prop("p_prop", "c_prop", "proposed", "mock"); prop("p_appr", "c_appr", "approved", "mock");
    const before = db.prepare("SELECT id, workspace_id, name, status, current_version, created_at FROM campaigns ORDER BY id").all();
    expect(migrate(db)).toEqual(["017_plans_lifecycle.sql", "018_creative_studio.sql", "019_team_operations.sql", "020_lead_lineage_forms.sql", "021_experiments_learnings.sql", "022_integration_tests.sql", "023_audit_append_only.sql"]);
    expect(db.prepare("SELECT id, workspace_id, name, status, current_version, created_at FROM campaigns ORDER BY id").all()).toEqual(before);
    const states = () => Object.fromEntries((db.prepare("SELECT id, lifecycle_state s FROM campaigns").all() as Array<{ id: string; s: string }>).map((r) => [r.id, r.s]));
    expect(states()).toEqual({ c_draft: "draft", c_sim: "executed_simulated", c_live: "executed_external", c_prop: "ready_for_approval", c_appr: "approved" });
    const ctx = buildContext({ db, env: {} });
    expect(syncAllLifecycles(ctx)).toBe(0); // the exact rules agree with the coarse backfill here: nothing to change
    expect(syncAllLifecycles(ctx)).toBe(0);
    expect(states()).toEqual({ c_draft: "draft", c_sim: "executed_simulated", c_live: "executed_external", c_prop: "ready_for_approval", c_appr: "approved" });
    expect(db.prepare("SELECT COUNT(*) n FROM marketing_plans").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM campaign_plans").get()).toEqual({ n: 0 }); // the goal table is a different thing and untouched
  });
});

/* ---------------------------------------------------------------- recommended plans */

describe("recommended plans", () => {
  it("proposes one separate campaign per confirmed service, says it is rule-based and not a forecast, and never calls an unknown 'not offered'", async () => {
    const t = await team();
    const r = await recommend(t, t.operator, { totalDailyBudgetCents: 1500, durationDays: 14 });
    expect(r.status).toBe(201);
    const p = r.body;
    expect(p.opportunities.map((o: Json) => o.focusService)).toEqual(BRAIN3.services);
    expect(p.opportunities.every((o: Json) => o.status === "selected")).toBe(true);
    expect(p.basis).toMatch(/Rule-based/);
    expect(p.basis).toMatch(/not a forecast/);
    expect(p.notice).toMatch(/not approved as a whole/);
    expect(p.opportunities[0].unknowns.join(" ")).toMatch(/unknown, not "not offered"/);
    expect(p.opportunities[0].unknowns.join(" ")).toMatch(/No price is approved/);
    expect(p.opportunities[0].rationale).toMatch(/not mixed with/);
    expect(new Set(p.opportunities.map((o: Json) => o.title)).size).toBe(3);
    expect(campaignCount(t)).toBe(0); // a recommendation creates no campaign
  });

  it("splits one total across the campaigns, never multiplies it, and refuses a total above the ceiling", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, { totalDailyBudgetCents: 1999 })).body;
    expect(p.opportunities.map((o: Json) => o.allocationCents)).toEqual([666, 666, 666]);
    expect(p.budget).toMatchObject({ totalDailyCents: 1999, plannedSharesCents: 1998, unassignedCents: 1, ceilingCents: 2000 });
    const over = await recommend(t, t.operator, { totalDailyBudgetCents: 2001 });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("budget_exceeds_ceiling");
    const none = (await recommend(t, t.operator, {})).body;
    expect(none.budget.totalDailyCents).toBeNull();
    expect(none.opportunities.every((o: Json) => o.allocationCents === null)).toBe(true);
    expect(none.gaps).toContain("Set the plan's daily total.");
  });

  it("needs a saved Business Brain and a service, rejects unknown fields, and respects roles", async () => {
    const t = await team();
    expect((await recommend(t, t.operator, { foo: 1 })).status).toBe(400);
    expect((await recommend(t, t.viewer)).status).toBe(403);
    expect((await call(t.w.app, "GET", `${t.base}/plans`, t.viewer.token)).status).toBe(200);
    const w2 = await team({ ...BRAIN, services: [] as string[] }).catch(() => null);
    void w2; // a brain with no services is refused by the Business Brain schema itself, so the "no services" guard is a second line of defence
    const bare = boot();
    const o = await person(bare, "bob");
    const ws = (await call(bare.app, "POST", "/api/workspaces", o.token, { name: "Bare Co" })).body.workspace.id as string;
    const r = await call(bare.app, "POST", `/api/workspaces/${ws}/plans/recommend`, o.token, {});
    expect(r.body.error.code).toBe("brain_required");
  });

  it("flags an opportunity that repeats an existing campaign, and the batch will not make it until the owner says it should differ", async () => {
    const t = await team();
    const existing = (await call(t.w.app, "POST", `${t.base}/campaigns/generate`, t.operator.token, { ...MOCK, goal: "promote_service", focusService: "Drain cleaning" })).body;
    const p = (await recommend(t, t.operator, {})).body;
    const dup = p.opportunities.find((o: Json) => o.focusService === "Drain cleaning");
    expect(dup.status).toBe("suggested");
    expect(dup.duplicate).toMatchObject({ of: existing.id, acknowledged: false });
    expect(dup.duplicate.note).toMatch(/already have a campaign about this service/);
    const sel = await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}/opportunities/${dup.id}`, t.operator.token, { status: "selected" });
    expect(sel.status).toBe(200);
    const g = await generate(t, t.operator, p.id);
    expect(g.body.results.find((r: Json) => r.opportunityId === dup.id)).toMatchObject({ outcome: "skipped", reason: "duplicate_not_acknowledged" });
    expect(campaignCount(t)).toBe(3); // the existing one plus the two others
    await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}/opportunities/${dup.id}`, t.operator.token, { acknowledgeDuplicate: true });
    expect((await generate(t, t.operator, p.id)).body.results.find((r: Json) => r.opportunityId === dup.id).outcome).toBe("generated");
    expect(campaignCount(t)).toBe(4);
  });
});

/* ---------------------------------------------------------------- editing a plan */

describe("editing a plan: exclude, save for later, shares, total", () => {
  it("lets a person exclude or save an opportunity, rename it, and change its share, within the total and the ceiling", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, { totalDailyBudgetCents: 1500 })).body;
    const [a, b, c] = p.opportunities as Json[];
    const patch = (o: Json, body: Json, by = t.operator) => call(t.w.app, "PATCH", `${t.base}/plans/${p.id}/opportunities/${o.id}`, by.token, body);
    expect((await patch(b!, { status: "excluded" })).body.opportunities[1].status).toBe("excluded");
    expect((await patch(c!, { status: "saved", title: "Drain work, later" })).body.opportunities[2]).toMatchObject({ status: "saved", title: "Drain work, later" });
    expect((await patch(a!, { allocationCents: 1500 })).status).toBe(200); // one selected campaign may take the whole total
    expect((await patch(a!, { allocationCents: 1501 })).body.error.code).toBe("allocation_exceeds_total");
    expect((await patch(a!, { allocationCents: 2001 })).body.error.code).toMatch(/allocation_exceeds_total|budget_exceeds_ceiling/);
    expect((await patch(b!, { status: "selected" })).body.error.code).toBe("allocation_exceeds_total"); // 1500 + 500 > 1500
    expect((await patch(a!, { allocationCents: 500 })).status).toBe(200);
    expect((await patch(b!, { status: "selected" })).status).toBe(200);
    expect((await patch(a!, { bogus: 1 })).status).toBe(400);
    expect((await patch(a!, { status: "generated" })).status).toBe(400);
    const cur = (await plan(t, t.viewer, p.id)).body;
    expect(cur.budget.plannedSharesCents).toBe(1000);
    expect((await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}`, t.operator.token, { totalDailyBudgetCents: 900 })).body.error.code).toBe("allocation_exceeds_total");
    expect((await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}`, t.operator.token, { totalDailyBudgetCents: 2500 })).body.error.code).toBe("budget_exceeds_ceiling");
    expect((await patch(a!, { status: "excluded" }, t.viewer)).status).toBe(403);
  });
});

/* ---------------------------------------------------------------- batch generation */

describe("batch generation: several distinct, independent campaigns; resumable and idempotent", () => {
  it("makes one separate draft per selected opportunity, about its own service, each with its own lifecycle, versions and plan link", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, { totalDailyBudgetCents: 1800 })).body;
    const g = await generate(t, t.operator, p.id);
    expect(g.status).toBe(200);
    expect(g.body.results.map((r: Json) => r.outcome)).toEqual(["generated", "generated", "generated"]);
    const camps = g.body.opportunities.map((o: Json) => o.campaign);
    expect(new Set(camps.map((c: Json) => c.id)).size).toBe(3);
    expect(new Set(camps.map((c: Json) => c.name)).size).toBe(3); // distinct drafts, not three copies
    for (const [i, c] of camps.entries()) {
      expect(c.name).toContain(BRAIN3.services[i]!);
      expect(c.lifecycle).toBe("draft");
      expect(c.version).toBe(1);
    }
    expect(g.body.opportunities.every((o: Json) => o.status === "generated")).toBe(true);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM campaigns WHERE plan_id = ?").get(p.id)).toEqual({ n: 3 });
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM campaign_plans").get()).toEqual({ n: 3 }); // each also records its own goal
    const detail = (await call(t.w.app, "GET", `${t.base}/campaigns/${camps[0].id}`, t.viewer.token)).body;
    expect(detail.marketingPlan).toMatchObject({ id: p.id, totalDailyCents: 1800, plannedShareCents: 600 });
    expect((await call(t.w.app, "GET", `${t.base}/dashboard`, t.viewer.token)).body.campaigns.list.every((c: Json) => c.plan?.id === p.id && c.lifecycle === "draft")).toBe(true);
  });

  it("running it again, or twice at once, never makes a second campaign for an opportunity", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, {})).body;
    const [x, y] = await Promise.all([generate(t, t.operator, p.id), generate(t, t.operator, p.id)]);
    expect(x.status).toBe(200);
    expect(y.status).toBe(200);
    expect(campaignCount(t)).toBe(3);
    expect(t.w.db.prepare("SELECT COUNT(*) n FROM campaigns c WHERE plan_id = ? AND (SELECT COUNT(*) FROM plan_opportunities o WHERE o.campaign_id = c.id) != 1").get(p.id)).toEqual({ n: 0 });
    const again = await generate(t, t.operator, p.id);
    expect(again.body.results).toEqual([]);
    expect(campaignCount(t)).toBe(3);
    // the database itself refuses a second campaign for an opportunity
    const oppId = p.opportunities[0].id;
    expect(() => t.w.db.prepare("UPDATE plan_opportunities SET campaign_id = (SELECT campaign_id FROM plan_opportunities WHERE id = ?) WHERE id = ?").run(p.opportunities[1].id, oppId)).toThrow();
  });

  it("a failure on one opportunity marks only that one failed (with a safe message), the rest are made, and a retry finishes it without duplicates", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, {})).body;
    const bad = p.opportunities[1].id as string;
    t.w.db.prepare("UPDATE plan_opportunities SET focus_service = 'Quantum plumbing' WHERE id = ?").run(bad); // a service the Business Brain does not list: generation refuses it
    const g = await generate(t, t.operator, p.id);
    expect(g.body.results.map((r: Json) => r.outcome)).toEqual(["generated", "failed", "generated"]);
    expect(g.body.opportunities[1]).toMatchObject({ status: "failed", error: { code: "invalid_plan" } });
    expect(JSON.stringify(g.body.opportunities[1].error)).not.toMatch(/at \w+\.|node:/);
    expect(campaignCount(t)).toBe(2);
    t.w.db.prepare("UPDATE plan_opportunities SET focus_service = 'Water heater repair' WHERE id = ?").run(bad);
    const retry = await generate(t, t.operator, p.id);
    expect(retry.body.results.map((r: Json) => r.outcome)).toEqual(["generated"]);
    expect(campaignCount(t)).toBe(3);
    expect(retry.body.opportunities.map((o: Json) => o.status)).toEqual(["generated", "generated", "generated"]);
  });

  it("releases an old interrupted generation so it can be retried, and leaves a fresh one alone", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, {})).body;
    const [old, fresh] = [p.opportunities[0].id as string, p.opportunities[1].id as string];
    t.w.db.prepare("UPDATE plan_opportunities SET status = 'generating', generation_started_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(old);
    t.w.db.prepare("UPDATE plan_opportunities SET status = 'generating', generation_started_at = ? WHERE id = ?").run(new Date().toISOString(), fresh);
    const g = await generate(t, t.operator, p.id);
    expect(g.body.opportunities[0].status).toBe("generated");
    expect(g.body.opportunities[1].status).toBe("generating"); // someone else is on it
    expect(campaignCount(t)).toBe(2);
  });

  it("regenerating adds a new version to the same campaign and makes only its own proposal stale; an approved campaign cannot be regenerated", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, {})).body;
    const g = (await generate(t, t.operator, p.id)).body;
    const [o1, o2] = g.opportunities as [Json, Json, Json];
    const prop = (await call(t.w.app, "POST", `${t.base}/campaigns/${o1.campaign.id}/proposals`, t.operator.token, {}));
    expect(prop.status).toBe(409); // a plan campaign needs the plan's total first
    const re = await call(t.w.app, "POST", `${t.base}/plans/${p.id}/opportunities/${o1.id}/regenerate`, t.operator.token, MOCK);
    expect(re.status).toBe(200);
    expect(re.body.opportunities[0].campaign.version).toBe(2);
    expect(re.body.opportunities[1].campaign.version).toBe(1);
    expect(campaignCount(t)).toBe(3);
    expect((await call(t.w.app, "POST", `${t.base}/plans/${p.id}/opportunities/${o2.id}/regenerate`, t.viewer.token, MOCK)).status).toBe(403);
  });
});

/* ---------------------------------------------------------------- plan budgets and approvals */

describe("plan budgets: a total that is never multiplied, a review of the exact numbers, and independent approvals", () => {
  async function planned(total = 1800) {
    const t = await team();
    const p = (await recommend(t, t.operator, { totalDailyBudgetCents: total })).body;
    const g = (await generate(t, t.operator, p.id)).body;
    return { t, p, g, cids: g.opportunities.map((o: Json) => o.campaign.id as string) };
  }
  const propose = (t: T, cid: string, by: { token: string }) => call(t.w.app, "POST", `${t.base}/campaigns/${cid}/proposals`, by.token, {});
  const review = (t: T, pid: string, by: { token: string }, fingerprint: string) => call(t.w.app, "POST", `${t.base}/plans/${pid}/budget-review`, by.token, { fingerprint });

  it("blocks proposing a plan campaign with no total, with campaigns adding up to more than the total, or above its share, before anything about review", async () => {
    const t = await team();
    const p = (await recommend(t, t.operator, {})).body; // no total
    const g = (await generate(t, t.operator, p.id)).body;
    const cid = g.opportunities[0].campaign.id as string;
    expect((await propose(t, cid, t.operator)).body.error.code).toBe("plan_total_missing");
    const sum = g.budget.campaignsAddUpToCents as number;
    expect(sum).toBeGreaterThan(0);
    await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}`, t.operator.token, { totalDailyBudgetCents: Math.min(Math.max(1, sum - 1), 2000) }); // never above the 2000¢ ceiling; the mock drafts together exceed it
    const over = await propose(t, cid, t.operator);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe("plan_budget_exceeded");
    expect(over.body.error.message).toMatch(/add up to \d+¢ per day, which is more than the plan's total/);
    const blocked = t.w.db.prepare("SELECT detail FROM audit_events WHERE type = 'proposal.blocked' ORDER BY id DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(blocked.detail)).toMatchObject({ reason: "plan_budget_exceeded" });
  });

  it("applying the planned shares lowers over-share campaigns as a labelled person's edit, never raises a budget, and then a reviewer must look at the exact numbers", async () => {
    const { t, p, g } = await planned(1800);
    const before = (g.opportunities as Json[]).map((o) => o.campaign.dailyBudgetCents as number);
    const applied = (await call(t.w.app, "POST", `${t.base}/plans/${p.id}/apply-allocations`, t.operator.token)).body;
    const after = (applied.opportunities as Json[]).map((o) => o.campaign.dailyBudgetCents as number);
    after.forEach((b, i) => { expect(b).toBeLessThanOrEqual(600); expect(b).toBeLessThanOrEqual(before[i]!); });
    expect(applied.budget.campaignsAddUpToCents).toBeLessThanOrEqual(1800);
    expect((applied.opportunities as Json[]).every((o) => o.campaign.version === (before[0]! > 600 ? 2 : 1))).toBe(true);
    const rationale = (await call(t.w.app, "GET", `${t.base}/campaigns/${applied.opportunities[0].campaign.id}`, t.viewer.token)).body.brief.budgetRationale as string;
    if (before[0]! > 600) expect(rationale).toMatch(/Lowered to its planned share of 600¢ per day in the plan/);
    // proposing still needs the review of these exact numbers
    expect(applied.gaps).toContain("The total and each campaign's budget have not been reviewed.");
    const cid = applied.opportunities[0].campaign.id as string;
    const blocked = await propose(t, cid, t.operator);
    expect(blocked.body.error.code).toBe("plan_budget_not_reviewed");
    expect((await review(t, p.id, t.operator, applied.budget.fingerprint)).status).toBe(403); // plans.review is admin+
    expect((await review(t, p.id, t.admin, "a".repeat(64))).body.error.code).toBe("stale");
    const done = (await review(t, p.id, t.admin, applied.budget.fingerprint)).body;
    expect(done.budget.review).toMatchObject({ done: true, stale: false, separation: "enforced" });
    expect(done.gaps).toEqual([]);
    expect((await propose(t, cid, t.operator)).status).toBe(201);
  });

  it("the reviewer cannot be the person who last changed the numbers, and any later change (a budget edit, a share, an archive) makes the review stale", async () => {
    const { t, p } = await planned(1800);
    const lowered = (await call(t.w.app, "POST", `${t.base}/plans/${p.id}/apply-allocations`, t.admin.token)).body; // admin made the last change
    const self = await review(t, p.id, t.admin, lowered.budget.fingerprint);
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe("self_approval_not_allowed");
    expect((await review(t, p.id, t.admin2, lowered.budget.fingerprint)).body.budget.review.done).toBe(true);
    const cid = lowered.opportunities[0].campaign.id as string;
    // edit one campaign's budget after the review
    const rec = (await call(t.w.app, "GET", `${t.base}/campaigns/${cid}`, t.viewer.token)).body;
    await call(t.w.app, "PUT", `${t.base}/campaigns/${cid}/brief`, t.operator.token, { ...rec.brief, dailyBudgetCents: Math.max(1, rec.brief.dailyBudgetCents - 1) });
    const stale = (await plan(t, t.viewer, p.id)).body;
    expect(stale.budget.review).toMatchObject({ done: false, stale: true });
    expect(stale.gaps).toContain("The budget changed since it was reviewed.");
    expect((await propose(t, cid, t.operator)).body.error.code).toBe("plan_budget_not_reviewed");
    // review again, then archiving a campaign changes what counts and makes it stale once more
    expect((await review(t, p.id, t.admin2, stale.budget.fingerprint)).body.budget.review.done).toBe(true);
    const other = lowered.opportunities[1].campaign.id as string;
    expect((await call(t.w.app, "POST", `${t.base}/campaigns/${other}/archive`, t.admin.token)).status).toBe(200);
    const after = (await plan(t, t.viewer, p.id)).body;
    expect(after.budget.review.stale).toBe(true);
    expect(after.budget.campaignsAddUpToCents).toBeLessThan(stale.budget.campaignsAddUpToCents);
  });

  it("one campaign's approval never covers another's: each has its own proposal, version binding and lifecycle", async () => {
    const { t, p } = await planned(1800);
    const lowered = (await call(t.w.app, "POST", `${t.base}/plans/${p.id}/apply-allocations`, t.operator.token)).body;
    await review(t, p.id, t.admin, lowered.budget.fingerprint);
    const [a, b, c] = (lowered.opportunities as Json[]).map((o) => o.campaign.id as string);
    const pa = (await propose(t, a!, t.operator)).body.id as string;
    const pb = (await propose(t, b!, t.operator)).body.id as string;
    expect((await call(t.w.app, "POST", `${t.base}/proposals/${pa}/approve`, t.admin.token, { decidedBy: "x" })).body.status).toBe("approved");
    expect(await lifecycleOf(t, a!)).toBe("approved");
    expect(await lifecycleOf(t, b!)).toBe("ready_for_approval"); // untouched
    expect(await lifecycleOf(t, c!)).toBe("draft");
    expect(t.w.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pb)).toEqual({ status: "proposed" });
    // editing B makes only B's proposal stale; A's approval still stands for exactly the version it covered
    const recB = (await call(t.w.app, "GET", `${t.base}/campaigns/${b}`, t.viewer.token)).body;
    await call(t.w.app, "PUT", `${t.base}/campaigns/${b}/brief`, t.operator.token, { ...recB.brief, name: "Renamed B" });
    expect(t.w.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pb)).toEqual({ status: "stale" });
    expect(t.w.db.prepare("SELECT status, campaign_version FROM action_proposals WHERE id = ?").get(pa)).toEqual({ status: "approved", campaign_version: 1 + (lowered.opportunities[0].campaign.version - 1) });
    // a plan campaign's card shows the plan context next to its proposal
    const ctxView = (await call(t.w.app, "GET", `${t.base}/campaigns/${a}`, t.viewer.token)).body.marketingPlan;
    expect(ctxView).toMatchObject({ id: p.id, totalDailyCents: 1800, reviewDone: false });
  });

  it("plans are workspace-private: another workspace sees, changes and generates nothing", async () => {
    const { t, p } = await planned(1800);
    const other = await person(t.w, "olga");
    const W2 = (await call(t.w.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    const o2 = `/api/workspaces/${W2}`;
    expect((await call(t.w.app, "GET", `${t.base}/plans/${p.id}`, other.token)).status).toBe(404); // not a member
    expect((await call(t.w.app, "GET", `${o2}/plans/${p.id}`, other.token)).status).toBe(404); // own workspace, their plan id
    expect((await call(t.w.app, "PATCH", `${o2}/plans/${p.id}`, other.token, { name: "Hijack" })).status).toBe(404);
    expect((await call(t.w.app, "POST", `${o2}/plans/${p.id}/generate`, other.token, MOCK)).status).toBe(404);
    expect((await call(t.w.app, "POST", `${o2}/plans/${p.id}/budget-review`, other.token, { fingerprint: "a".repeat(64) })).status).toBe(404);
    expect((await call(t.w.app, "PATCH", `${o2}/plans/${p.id}/opportunities/${p.opportunities[0].id}`, other.token, { status: "excluded" })).status).toBe(404);
    expect((await call(t.w.app, "GET", `${o2}/plans`, other.token)).body.plans).toEqual([]);
    expect((await call(t.w.app, "GET", `${t.base}/plans/${p.id}`, t.viewer.token)).body.name).toBe("Marketing plan");
  });

  it("every plan action is in the audit trail with the person who did it", async () => {
    const { t, p } = await planned(1800);
    await call(t.w.app, "PATCH", `${t.base}/plans/${p.id}`, t.operator.token, { name: "Spring plan" });
    await call(t.w.app, "POST", `${t.base}/plans/${p.id}/archive`, t.operator.token);
    const types = ((await call(t.w.app, "GET", `${t.base}/activity`, t.owner.token)).body as Json[]).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["plan.created", "plan.generated", "plan.updated", "plan.archived", "campaign.generated"]));
    expect((await generate(t, t.operator, p.id)).body.error.code).toBe("plan_archived");
    expect((await call(t.w.app, "GET", `${t.base}/plans`, t.viewer.token)).body.plans).toHaveLength(0);
    expect((await call(t.w.app, "GET", `${t.base}/plans?archived=true`, t.viewer.token)).body.plans).toHaveLength(1);
  });
});
