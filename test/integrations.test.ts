/**
 * Phase 8: integrations and controlled-execution readiness. The registry describes each adapter's real state and exact capabilities, future channels are declared (not built),
 * action contracts list what would be needed before anything affects the outside world, simulated self-tests never contact anything, dry-runs are read-only, and the whole
 * mock workflow (Meta and CRM, with failure injection) never makes a network call. Nothing here can switch an integration on.
 */
import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { runSimulatedTest } from "../src/app/integrations.js";
import { createWorker } from "../src/app/worker.js";
import { ALL_PERMISSIONS } from "../src/auth/authz.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { MockImageProvider } from "../src/creative/image.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { MemoryAssetStore } from "../src/storage/assetStore.js";
import { BRAIN } from "./fixtures.js";
import { AUDIENCE, ISSUER, NOW_MS, OIDC_REQUIRED, OPEN_POLICY, claims, makeKey, signJwt } from "./support/jwt.js";

const rsa = makeKey("RS256", "rsa-1");
const OIDC_ENV = { AUTH_MODE: "oidc", OIDC_ISSUER: ISSUER, OIDC_AUDIENCE: AUDIENCE, OIDC_JWKS_URI: "https://idp.example.test/jwks", ...OIDC_REQUIRED };
const oidc = () => buildAuthRuntime(loadAuthConfig(OIDC_ENV), { keys: new StaticJwks([rsa.jwk]), now: () => NOW_MS, policy: OPEN_POLICY });
const open: Array<() => void> = [];
afterEach(() => { while (open.length) open.pop()?.(); vi.restoreAllMocks(); });

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
function boot() {
  let offset = 0;
  const db = openDb(":memory:");
  migrate(db);
  const provider = new MockImageProvider();
  const ctx: AppContext = buildContext({ db, env: { OPENAI_API_KEY: "sk-TEST-never-shown-000000000000" }, backoffMs: () => 0, gateway: { sleep: async () => {} }, assetStore: new MemoryAssetStore(), imageProvider: provider, now: () => new Date(Date.now() + offset * 86400000) });
  const app = buildServer(ctx, oidc());
  open.push(() => db.open && db.close());
  return { db, ctx, app, provider, worker: createWorker(ctx), advance: (d: number) => { offset += d; } };
}
type S = ReturnType<typeof boot>;
async function person(s: S, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  return { token, id: (await call(s.app, "GET", "/api/me", token)).body.user.id as string };
}
async function world() {
  const s = boot();
  const owner = await person(s, "olivia"), admin = await person(s, "adam"), operator = await person(s, "oscar"), viewer = await person(s, "vera");
  const W = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Hook Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(s.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
  const cid = (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const propose = async () => (await call(s.app, "POST", `${base}/campaigns/${cid}/proposals`, operator.token, {})).body.id as string;
  const approve = (pid: string) => call(s.app, "POST", `${base}/proposals/${pid}/approve`, admin.token, { decidedBy: "x", acknowledgedReview: true });
  const run = async (pid: string) => { const r = await call(s.app, "POST", `${base}/proposals/${pid}/execute`, admin.token); await s.worker.runUntilIdle(); return r; };
  const status = (pid: string) => (s.db.prepare("SELECT status FROM action_proposals WHERE id = ?").get(pid) as { status: string }).status;
  const registry = async (by = admin) => call(s.app, "GET", `${base}/integrations`, by.token);
  const dry = (pid: string) => call(s.app, "GET", `${base}/proposals/${pid}/dry-run`, viewer.token);
  const simulate = async (body: Json = {}) => { const r = await call(s.app, "POST", `${base}/campaigns/${cid}/simulate-lead`, operator.token, { fullName: "Synthetic Sam", email: "sam@example.com", ...body }); await s.worker.runUntilIdle(); return r; };
  const counts = () => JSON.stringify([s.db.prepare("SELECT COUNT(*) n FROM jobs").get(), s.db.prepare("SELECT id, status FROM action_proposals ORDER BY id").all(), s.db.prepare("SELECT COUNT(*) n FROM execution_attempts").get(), s.db.prepare("SELECT COUNT(*) n FROM crm_syncs").get(), s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()]);
  return { s, owner, admin, operator, viewer, W, base, cid, propose, approve, run, status, registry, dry, simulate, counts };
}

describe("the registry says what each integration really is", () => {
  it("describes every adapter with a state, capabilities, limits, provenance, failure behaviour and permission limits, and none can affect the outside world now", async () => {
    const w = await world();
    const r = await w.registry();
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.adapters.map((a: Json) => [a.id, a]));
    expect(Object.keys(by).sort()).toEqual(["ai_text", "asset_storage", "credential_vault", "ghl_crm", "identity", "image_generation", "meta_ads"]);
    expect(by.meta_ads).toMatchObject({ state: "mock", stateLabel: "SIMULATED", mode: "simulated", canAffectOutsideWorldNow: false });
    expect(by.ghl_crm).toMatchObject({ state: "mock", mode: "simulated" });
    expect(by.ai_text).toMatchObject({ state: "mock", mode: "simulated" });
    expect(by.image_generation).toMatchObject({ state: "mock" });
    expect(by.asset_storage).toMatchObject({ state: "limited", mode: "local" });
    expect(by.identity.state).toBe("configured_unverified");
    expect(by.credential_vault.state).toBe("disabled");
    for (const a of r.body.adapters) {
      expect(a.canAffectOutsideWorldNow, a.id).toBe(false);
      for (const k of ["reason", "dataProvenance", "failureBehavior", "permissionLimits"]) expect(String(a[k]).length, `${a.id}.${k}`).toBeGreaterThan(15);
      expect(a.capabilities.length, a.id).toBeGreaterThan(0);
      expect(a.limits.length, a.id).toBeGreaterThan(0);
      expect(a.setupGuidance.length, a.id).toBeGreaterThan(0);
    }
    expect(r.body.states.map((s: Json) => s.id)).toEqual(["mock", "configured_unverified", "verified", "limited", "disabled", "unavailable", "not_built"]);
  });

  it("is exact about which actions are supported: only a paused draft and a simulated contact exist; budgets, activation, messages and performance do not", async () => {
    const w = await world();
    const by = Object.fromEntries((await w.registry()).body.adapters.map((a: Json) => [a.id, Object.fromEntries(a.capabilities.map((c: Json) => [c.id, c]))]));
    expect(by.meta_ads.create_campaign_draft).toMatchObject({ effect: "external_effect", state: "simulated", approvalRequired: true });
    expect(by.meta_ads.create_campaign_draft.note).toMatch(/paused, with no budget/);
    for (const id of ["set_budget_or_activate", "create_ad_set_or_ad", "pause_resume", "read_performance", "read_lead_forms_and_leads"]) expect(by.meta_ads[id].state, id).toBe("not_built");
    expect(by.ghl_crm.upsert_contact).toMatchObject({ state: "simulated" });
    for (const id of ["read_contacts", "create_opportunity", "send_message", "receive_webhooks"]) expect(by.ghl_crm[id].state, id).toBe("not_built");
    expect(by.image_generation.generate_video.state).toBe("not_built");
    expect(by.image_generation.live_provider.state).toBe("not_built");
    // every capability that could have an external effect is simulated, gated or not built: never plain "available" while the server is in mock mode
    for (const a of Object.values(by) as Json[]) for (const c of Object.values(a) as Json[]) if (c.effect === "external_effect") expect(["simulated", "disabled", "not_built"], c.id).toContain(c.state);
  });

  it("declares future channels with their own capabilities, approval requirements, limits, provenance and failure behaviour, and no way to enable them", async () => {
    const w = await world();
    const f = (await w.registry()).body.futureChannels as Json[];
    expect(f.map((x) => x.id).sort()).toEqual(["analytics", "calendar_tools", "email_sms", "google_ads", "tiktok_ads"]);
    for (const x of f) {
      expect(x).toMatchObject({ state: "not_built", stateLabel: "NOT BUILT", mode: "none", canAffectOutsideWorldNow: false, testable: "none", lastTest: null });
      expect(x.capabilities.every((c: Json) => c.state === "not_built"), x.id).toBe(true);
      expect(x.capabilities.some((c: Json) => c.effect === "external_effect" && c.approvalRequired), x.id).toBe(true);
      expect(x.limits.length).toBeGreaterThan(0); expect(x.dataProvenance.length).toBeGreaterThan(20); expect(x.failureBehavior).toMatch(/fail closed|never resend/i);
      expect(x.permissionLimits).toMatch(/Nobody can enable it/);
    }
    expect(f.find((x) => x.id === "email_sms")!.capabilities[0].note).toMatch(/consent verification/);
  });

  it("states the execution lock: why nothing reaches the outside world, and that this page cannot change it", async () => {
    const w = await world();
    const lock = (await w.registry()).body.executionLock;
    expect(lock.externalEffectsPossibleNow).toBe(false);
    expect(lock.enabledFromThisPage).toBe(false);
    expect(lock.summary).toMatch(/Nothing this app can do reaches the outside world/);
    expect(lock.reasons.join(" ")).toMatch(/Meta is simulated/);
    expect(lock.reasons.join(" ")).toMatch(/LIVE_GHL is refused at start-up/);
    expect(lock.reasons.join(" ")).toMatch(/E-mail, SMS, push, tracking pixels and public forms do not exist/);
    expect((await w.registry()).body.note).toMatch(/cannot switch one on/);
  });

  it("lists every external-effect action as a contract: preconditions, data sent, reversibility, indicative scopes, and what enabling would take", async () => {
    const w = await world();
    const c = (await w.registry()).body.actionContracts as Json[];
    const by = Object.fromEntries(c.map((x) => [x.id, x]));
    expect(by["meta.create_campaign_draft"]).toMatchObject({ status: "simulated", approvalPermission: "proposals.decide", runPermission: "proposals.execute" });
    expect(ALL_PERMISSIONS).toContain(by["meta.create_campaign_draft"].approvalPermission);
    expect(ALL_PERMISSIONS).toContain(by["meta.create_campaign_draft"].runPermission);
    expect(by["meta.create_campaign_draft"].requires.join(" ")).toMatch(/exact payload/);
    expect(by["meta.create_campaign_draft"].requires.join(" ")).toMatch(/separate run step/);
    expect(by["meta.create_campaign_draft"].dataSent).toContain("Status: paused");
    for (const id of ["meta.set_budget_or_activate", "ghl.send_message", "ads.send_conversion_events"]) expect(by[id].status, id).toBe("not_built");
    expect(by["ghl.send_message"].reversible).toMatch(/cannot be unsent/);
    for (const x of c) { expect(x.scopesNote).toMatch(/indicative/); expect(x.scopesNote).toMatch(/None is requested in this release/); expect(x.enablementRequires).toMatch(/Separate explicit authorization/); expect(x.indicativeScopes.length).toBeGreaterThan(0); expect(x.requires.length).toBeGreaterThan(0); }
  });

  it("never shows a key, a token or a secret", async () => {
    const w = await world();
    const text = JSON.stringify((await w.registry()).body);
    expect(text).not.toMatch(/sk-TEST|never-shown|Bearer|eyJ|msw_/);
  });

  it("is for admins: viewers and operators are refused", async () => {
    const w = await world();
    expect((await w.registry(w.viewer)).status).toBe(403);
    expect((await w.registry(w.operator)).status).toBe(403);
    expect((await call(w.s.app, "POST", `${w.base}/integrations/meta_ads/test`, w.operator.token)).status).toBe(403);
    expect((await call(w.s.app, "GET", `${w.base}/integrations`)).status).toBe(401);
  });
});

describe("simulated self-tests exercise a stand-in and contact nothing", () => {
  const test = (w: Awaited<ReturnType<typeof world>>, id: string, by = w.admin) => call(w.s.app, "POST", `${w.base}/integrations/${id}/test`, by.token);
  it("tests the Meta simulator, the CRM simulator and the placeholder image provider, labels every result simulated, and remembers the last one", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await world();
    for (const id of ["meta_ads", "ghl_crm", "image_generation"]) {
      const r = await test(w, id);
      expect(r.status, id).toBe(200);
      expect(r.body).toMatchObject({ ok: true, simulated: true });
      expect(r.body.note).toMatch(/SIMULATED test of a built-in stand-in/);
    }
    expect((await test(w, "meta_ads")).body.detail).toMatch(/fixtures, not real accounts\)\. Nothing was contacted/);
    expect((await test(w, "image_generation")).body.detail).toMatch(/valid 512x512 picture in memory/);
    const by = Object.fromEntries((await w.registry()).body.adapters.map((a: Json) => [a.id, a]));
    expect(by.meta_ads.lastTest).toMatchObject({ ok: true, simulated: true });
    expect(by.ghl_crm.lastTest.detail).toMatch(/No contact was created/);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM integration_tests WHERE simulated = 1").get()).toEqual({ n: 5 });
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 0 }); // a test created nothing
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("records a failing self-test honestly and refuses what has no simulated test", async () => {
    const w = await world();
    w.s.provider.faults.refuse = true;
    const r = await test(w, "image_generation");
    expect(r.body).toMatchObject({ ok: false, simulated: true });
    expect((await w.registry()).body.adapters.find((a: Json) => a.id === "image_generation").lastTest).toMatchObject({ ok: false });
    for (const id of ["ai_text", "identity", "asset_storage", "google_ads", "nonsense"]) expect((await test(w, id)).body.error.code, id).toBe("not_testable");
  });
  it("refuses to test a LIVE service at all, records nothing and contacts nothing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await world();
    const liveCtx = { ...w.s.ctx, integrations: { ...w.s.ctx.integrations, liveMeta: true } } as AppContext;
    await expect(runSimulatedTest(liveCtx, w.W, "user:x", "meta_ads")).rejects.toMatchObject({ code: "live_test_disabled", status: 409 });
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM integration_tests").get()).toEqual({ n: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("a dry run shows what would be sent and judges every gate now, changing nothing", () => {
  it("previews a paused draft with no budget, and lists each precondition as met or not", async () => {
    const w = await world();
    const pid = await w.propose();
    const before = w.counts();
    const early = (await w.dry(pid)).body;
    expect(early.wouldSend).toMatchObject({ status: "PAUSED", budgetSent: false, objective: "OUTCOME_LEADS", creativesSent: false });
    expect(early.wouldSend.note).toMatch(/NOT sent when a draft is created/);
    expect(early.whatWouldHappen).toMatch(/SIMULATED: the built-in simulator would create a paused draft/);
    expect(early.gates.find((g: Json) => g.id === "status")).toMatchObject({ met: false });
    expect(early.allGatesMet).toBe(false);
    await w.approve(pid);
    const ok = (await w.dry(pid)).body;
    expect(ok.allGatesMet).toBe(true);
    expect(ok.gates.map((g: Json) => g.id)).toEqual(expect.arrayContaining(["status", "campaign_version", "approval", "payload_hash", "approval_unexpired", "mode", "approver", "account", "ceiling", "daily_limit", "creatives"]));
    expect(ok.note).toMatch(/read-only preview/);
    expect(w.counts()).not.toBe(before); // approving changed things...
    const after = w.counts();
    await w.dry(pid); await w.dry(pid);
    expect(w.counts()).toBe(after); // ...but looking never does
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get()).toEqual({ n: 0 });
  });

  it("agrees with the executor: an expired approval and a lowered limit are flagged, and the run then refuses", async () => {
    const w = await world();
    const pid = await w.propose();
    await w.approve(pid);
    w.s.advance(2); // the 24-hour approval has expired
    const d = (await w.dry(pid)).body;
    expect(d.gates.find((g: Json) => g.id === "approval_unexpired")).toMatchObject({ met: false });
    expect(d.allGatesMet).toBe(false);
    expect((await w.run(pid)).status).toBe(409); // requestExecution refuses an expired approval too
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 0 });

    const w2 = await world();
    const p2 = await w2.propose();
    await w2.approve(p2);
    expect((await w2.dry(p2)).body.allGatesMet).toBe(true);
    const brain = { ...BRAIN, maxDailyBudgetCents: 100 }; // the limit is lowered after approval
    await call(w2.s.app, "PUT", `${w2.base}/brain`, w2.owner.token, brain);
    const d2 = (await w2.dry(p2)).body;
    expect(d2.allGatesMet).toBe(false);
    expect(d2.gates.filter((g: Json) => !g.met).map((g: Json) => g.id)).toEqual(expect.arrayContaining(["ceiling"]));
    await w2.run(p2);
    expect(w2.status(p2)).not.toBe("executed"); // and the executor agrees
  });

  it("is private to the workspace and available to viewers who can read proposals", async () => {
    const w = await world();
    const pid = await w.propose();
    const other = await person(w.s, "ivy");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    expect((await call(w.s.app, "GET", `/api/workspaces/${W2}/proposals/${pid}/dry-run`, other.token)).status).toBe(404);
    expect((await w.dry(pid)).status).toBe(200);
  });
});

describe("a lead's CRM dry run says only the simulator ever receives a lead, and never sends anything", () => {
  it("shows a synthetic lead going to the simulator, and imported and form-test leads going nowhere", async () => {
    const w = await world();
    const pid = await w.propose(); await w.approve(pid); await w.run(pid);
    expect((await w.simulate()).status).toBe(202);
    await call(w.s.app, "POST", `${w.base}/leads/import`, w.operator.token, { campaignId: w.cid, sourceNote: "Show list", rows: [{ fullName: "Imported Ida", email: "ida@x.com" }] });
    const leads = (await call(w.s.app, "GET", `${w.base}/leads`, w.viewer.token)).body as Json[];
    const syn = leads.find((l) => l.origin === "synthetic")!, imp = leads.find((l) => l.origin === "imported")!;
    const crmBefore = w.s.db.prepare("SELECT COUNT(*) n FROM crm_syncs").get();
    const d1 = (await call(w.s.app, "GET", `${w.base}/leads/${syn.id}/crm-dry-run`, w.viewer.token)).body;
    expect(d1.wouldSend).toMatchObject({ fullName: "Synthetic Sam", email: "sam@example.com", destination: "the built-in simulator" });
    expect(d1.whatWouldHappen).toMatch(/SIMULATED: the simulator would record a contact/);
    const d2 = (await call(w.s.app, "GET", `${w.base}/leads/${imp.id}/crm-dry-run`, w.viewer.token)).body;
    expect(d2.wouldSend).toBeNull();
    expect(d2.eligibility).toMatch(/Imported leads are never sent to any CRM/);
    expect(d2.note).toMatch(/never e-mails, texts or calls a lead/);
    expect((await call(w.s.app, "GET", `${w.base}/leads/nope/crm-dry-run`, w.viewer.token)).status).toBe(404);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM crm_syncs").get()).toEqual(crmBefore);
  });
});

describe("the whole mock workflow makes no network call, with Meta and CRM failures injected", () => {
  it("runs propose, approve, run, a synthetic lead and its CRM sync end to end without touching the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await world();
    const pid = await w.propose(); await w.approve(pid); await w.run(pid);
    expect(w.status(pid)).toBe("executed");
    expect(w.s.db.prepare("SELECT simulated FROM external_resources").get()).toEqual({ simulated: 1 });
    await w.simulate();
    const lead = w.s.db.prepare("SELECT crm_status, simulated FROM leads").get() as { crm_status: string; simulated: number };
    expect(lead).toEqual({ crm_status: "synced", simulated: 1 });
    expect(w.s.db.prepare("SELECT simulated FROM crm_syncs").get()).toEqual({ simulated: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("retries a definite Meta failure safely, then succeeds, without a network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await world();
    w.s.ctx.faults.meta.transientFailuresRemaining = 2;
    const pid = await w.propose(); await w.approve(pid); await w.run(pid);
    expect(w.status(pid)).toBe("executed");
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 1 }); // exactly one draft, never duplicated
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends a lost response to 'needs review' and never re-sends it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await world();
    w.s.ctx.faults.meta.timeoutAfterSuccess = true;
    const pid = await w.propose(); await w.approve(pid); await w.run(pid);
    expect(["needs_review", "executed"]).toContain(w.status(pid));
    const creates = (w.s.db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE dispatched = 1").get() as { n: number }).n;
    await w.s.worker.runUntilIdle();
    expect((w.s.db.prepare("SELECT COUNT(*) n FROM execution_attempts WHERE dispatched = 1").get() as { n: number }).n).toBe(creates); // nothing was sent again
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails a permission error at once and a platform that ignores 'paused' is not recorded as success", async () => {
    const w = await world();
    w.s.ctx.faults.meta.failKind = "permission";
    const p1 = await w.propose(); await w.approve(p1); await w.run(p1);
    expect(w.status(p1)).toBe("failed");
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM external_resources").get()).toEqual({ n: 0 });
    const w2 = await world();
    w2.s.ctx.faults.meta.createActive = true;
    const p2 = await w2.propose(); await w2.approve(p2); await w2.run(p2);
    expect(w2.status(p2)).not.toBe("executed");
  });

  it("retries a temporary CRM failure then syncs, and fails a CRM permission error, all simulated", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const w = await world();
    const pid = await w.propose(); await w.approve(pid); await w.run(pid);
    w.s.ctx.faults.crm.transientFailuresRemaining = 2;
    await w.simulate({ email: "a@x.com", eventId: "e1" });
    expect((w.s.db.prepare("SELECT crm_status FROM leads WHERE email = 'a@x.com'").get() as { crm_status: string }).crm_status).toBe("synced");
    w.s.ctx.faults.crm.permissionDenied = true;
    await w.simulate({ email: "b@x.com", eventId: "e2" });
    expect((w.s.db.prepare("SELECT crm_status FROM leads WHERE email = 'b@x.com'").get() as { crm_status: string }).crm_status).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("the code stays honest", () => {
  it("the registry module never imports a live connector or makes a request", () => {
    const src = readFileSync("src/app/integrations.ts", "utf8");
    expect(src).not.toMatch(/from "\.\.\/connector\/meta|GraphClient|MetaConnector|fetch\(|https?:\/\/|nodemailer|twilio/);
  });
  it("the browser has no control that turns an integration on", () => {
    const js = readFileSync("public/integrations.js", "utf8");
    expect(js).not.toMatch(/method:\s*"(PUT|PATCH|DELETE)"/);
    expect((js.match(/method:\s*"POST"/g) ?? []).length).toBe(1); // the only write is the simulated self-test
    expect([...js.matchAll(/api\(([^)]*)\)/g)].every((m) => /integrations\/\$\{[^}]+\}\/test|\/integrations"|dry-run|crm-dry-run|"\/leads"|\/campaigns\/\$\{/.test(m[1]!))).toBe(true);
  });
});
