/**
 * Phase 6: lead lineage (origin, attribution, campaign version, UTM, consent, follow-up), imports, form definitions with test submissions, and truthful analytics.
 * Synthetic, imported and real data are never blended; what cannot be measured is shown as not measured. Mock mode only; signed-in people are test identities.
 */
import { readFileSync, readdirSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
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

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
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
type S = ReturnType<typeof boot>;
async function person(s: S, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  return { token, id: (await call(s.app, "GET", "/api/me", token)).body.user.id as string };
}

async function world() {
  const s = boot();
  const owner = await person(s, "olivia"), admin = await person(s, "adam"), operator = await person(s, "oscar"), viewer = await person(s, "vera");
  const W = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Lead Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(s.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
  const gen = async () => (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const cid = await gen();
  const launch = async (campaign = cid) => {
    const pid = (await call(s.app, "POST", `${base}/campaigns/${campaign}/proposals`, operator.token, {})).body.id as string;
    expect((await call(s.app, "POST", `${base}/proposals/${pid}/approve`, admin.token, { decidedBy: "x", acknowledgedReview: true })).status).toBe(200);
    expect((await call(s.app, "POST", `${base}/proposals/${pid}/execute`, admin.token)).status).toBe(200);
    await s.worker.runUntilIdle();
  };
  const simulate = async (body: Json = {}, campaign = cid) => { const r = await call(s.app, "POST", `${base}/campaigns/${campaign}/simulate-lead`, operator.token, { fullName: "Synthetic Sam", email: "sam@example.com", ...body }); await s.worker.runUntilIdle(); return r; };
  const importRows = (rows: Json[], over: Json = {}, by = operator) => call(s.app, "POST", `${base}/leads/import`, by.token, { campaignId: cid, sourceNote: "Trade show list, March", rows, ...over });
  const leads = async () => (await call(s.app, "GET", `${base}/leads`, viewer.token)).body as Json[];
  const detail = async (id: string) => (await call(s.app, "GET", `${base}/leads/${id}`, viewer.token)).body;
  const analytics = async () => (await call(s.app, "GET", `${base}/analytics`, viewer.token)).body;
  return { s, owner, admin, operator, viewer, W, base, cid, gen, launch, simulate, importRows, leads, detail, analytics };
}
type Wd = Awaited<ReturnType<typeof world>>;

describe("migration 020 on a database that already has leads", () => {
  it("adds lineage columns, classifies only what is certain, and leaves every existing value alone", () => {
    const db = openDb(":memory:");
    open.push(() => db.open && db.close());
    db.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    for (const f of readdirSync("src/db/migrations").filter((x) => x.endsWith(".sql") && x < "020").sort()) { db.exec(readFileSync(`src/db/migrations/${f}`, "utf8")); db.prepare("INSERT INTO schema_migrations VALUES (?, 't')").run(f); }
    db.prepare("INSERT INTO workspaces (id, name, token_hash, created_at) VALUES ('ws_a','A','h','t')").run();
    db.prepare("INSERT INTO campaigns (id, workspace_id, name, status, current_version, created_at) VALUES ('c1','ws_a','C',  'draft', 3, 't')").run();
    db.prepare("INSERT INTO lead_events (id, workspace_id, source, event_id, campaign_id, payload, simulated, received_at) VALUES ('e1','ws_a','simulated','x','c1','{}',1,'2026-01-02T00:00:00.000Z')").run();
    db.prepare("INSERT INTO leads (id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, created_at) VALUES ('l1','ws_a','c1','e1','Sam','s@x.com',NULL,1,'2026-01-02T00:00:01.000Z')").run();
    const before = db.prepare("SELECT id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, status, crm_status, created_at FROM leads").all();
    expect(migrate(db)).toEqual(["020_lead_lineage_forms.sql", "021_experiments_learnings.sql"]); // 020 is the migration under test; later ones apply after it
    expect(db.prepare("SELECT id, workspace_id, campaign_id, lead_event_id, full_name, email, phone, simulated, status, crm_status, created_at FROM leads").all()).toEqual(before);
    expect(db.prepare("SELECT origin, campaign_version, attribution_status, attribution_basis, captured_at, consent_status FROM leads").get()).toEqual({ origin: "synthetic", campaign_version: null, attribution_status: "observed", attribution_basis: "simulator", captured_at: "2026-01-02T00:00:00.000Z", consent_status: "not_recorded" });
    expect(migrate(db)).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});

describe("a synthetic lead records where it came from, and says it is synthetic", () => {
  it("stores origin, the campaign version in force, capture time and an attribution that names its basis", async () => {
    const w = await world();
    await w.launch();
    expect((await w.simulate()).status).toBe(202);
    const [l] = await w.leads();
    expect(l).toMatchObject({ origin: "synthetic", campaignVersion: 1, attributionStatus: "observed", attributionBasis: "simulator", simulated: true, sameContact: 0 });
    const d = await w.detail(l!.id);
    expect(d).toMatchObject({ origin: "synthetic", campaignVersion: 1, consent: { status: "not_recorded" }, followUp: { dueDate: null, done: false } });
    expect(d.attribution.basisText).toMatch(/simulator/);
    expect(d.capturedAt).toBeTruthy();
  });
  it("a campaign edit after capture does not rewrite which version the lead came from", async () => {
    const w = await world();
    await w.launch();
    await w.simulate();
    const rec = (await call(w.s.app, "GET", `${w.base}/campaigns/${w.cid}`, w.viewer.token)).body;
    expect(rec.currentVersion).toBe(1);
    w.s.db.prepare("UPDATE campaigns SET current_version = 4 WHERE id = ?").run(w.cid);
    expect((await w.leads())[0]!.campaignVersion).toBe(1);
  });
});

describe("importing leads", () => {
  const rows = [
    { fullName: "Ada Lovelace", email: "Ada@Example.com", phone: "512-555-0101" },
    { fullName: "Bo Bell", phone: "512 555 0102", utm: { source: "fair", campaign: "PLACEHOLDER" } },
    { fullName: "Cy Cole", email: "cy@example.com", utm: { source: "newsletter", medium: "email" }, capturedAt: "2026-03-04" },
    { fullName: "No Contact" },
    { fullName: "Bad Email", email: "not-an-email" },
  ];
  it("labels them IMPORTED, keeps UTM and capture time, reports rejected rows by number, and never queues a CRM sync or a message", async () => {
    const w = await world();
    const r = await w.importRows(rows.map((x) => (x.utm?.campaign === "PLACEHOLDER" ? { ...x, utm: { ...x.utm, campaign: w.cid } } : x)));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ received: 5, imported: 3, duplicates: 0 });
    expect(r.body.rejected.map((x: Json) => x.row)).toEqual([4, 5]);
    expect(r.body.rejected[0].reason).toMatch(/email or phone is required/);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM jobs").get()).toEqual({ n: 0 }); // nothing queued: no CRM write, no follow-up message
    const list = await w.leads();
    expect(list.every((l) => l.origin === "imported" && l.simulated === false && l.crmStatus === "not_synced")).toBe(true);
    const cy = list.find((l) => l.fullName === "Cy Cole")!;
    const d = await w.detail(cy.id);
    expect(d).toMatchObject({ origin: "imported", campaignVersion: null, utm: { source: "newsletter", medium: "email", campaign: null }, consent: { status: "not_recorded" }, capturedAt: "2026-03-04T00:00:00.000Z" });
    expect(d.email).toBe("cy@example.com");
    expect(d.importBatchId).toMatch(/^imp_/);
    expect((await call(w.s.app, "GET", `${w.base}/lead-imports`, w.viewer.token)).body.batches[0]).toMatchObject({ imported: 3, rejected: 2, sourceNote: "Trade show list, March", consent: "not_recorded" });
  });

  it("decides attribution from the evidence: assigned, matched by utm_campaign, or unknown when the tag names another campaign. Never 'observed'", async () => {
    const w = await world();
    await w.importRows([
      { fullName: "Assigned", email: "a@x.com" },
      { fullName: "Matched", email: "m@x.com", utm: { campaign: w.cid } },
      { fullName: "Conflict", email: "c@x.com", utm: { campaign: "some_other_campaign" } },
    ]);
    const by = Object.fromEntries((await w.leads()).map((l) => [l.fullName, [l.attributionStatus, l.attributionBasis]]));
    expect(by).toEqual({ Assigned: ["inferred", "assigned_by_importer"], Matched: ["inferred", "utm_matches_campaign"], Conflict: ["unknown", "utm_names_another_campaign"] });
    expect((await w.leads()).some((l) => l.attributionStatus === "observed")).toBe(false);
  });

  it("is idempotent: the same rows again store nothing; an external id or the same contact is one lead", async () => {
    const w = await world();
    const batch = [{ fullName: "Ada", email: "ada@x.com", externalId: "crm-1" }, { fullName: "Bo", email: "bo@x.com" }];
    expect((await w.importRows(batch)).body).toMatchObject({ imported: 2, duplicates: 0 });
    expect((await w.importRows(batch)).body).toMatchObject({ imported: 0, duplicates: 2 });
    expect((await w.importRows([{ fullName: "Ada again", email: "ada@x.com", externalId: "crm-1" }])).body.duplicates).toBe(1);
    expect(await w.leads()).toHaveLength(2);
    expect((w.s.db.prepare("SELECT COUNT(*) n FROM lead_import_batches").get() as { n: number }).n).toBe(3);
  });

  it("records the importer's consent statement as THEIR word, and shows the same contact appearing twice instead of merging it", async () => {
    const w = await world();
    await w.launch();
    await w.simulate({ email: "pat@x.com" });
    await w.importRows([{ fullName: "Pat Imported", email: "pat@x.com" }], { consent: "given", sourceNote: "Opt-in cards at the counter" });
    const imp = (await w.leads()).find((l) => l.origin === "imported")!;
    expect(imp.sameContact).toBe(1);
    const d = await w.detail(imp.id);
    expect(d.consent).toMatchObject({ status: "given" });
    expect(d.consent.note).toMatch(/Stated by the importer: Opt-in cards/);
    expect(d.sameContact[0]).toMatchObject({ origin: "synthetic" });
    expect(await w.leads()).toHaveLength(2); // never merged or hidden
  });

  it("limits a batch, needs a real campaign and a source note, and respects roles and workspaces", async () => {
    const w = await world();
    const many = Array.from({ length: 201 }, (_, i) => ({ fullName: `L${i}`, email: `l${i}@x.com` }));
    expect((await w.importRows(many)).status).toBe(400);
    expect((await w.importRows([{ fullName: "A", email: "a@x.com" }], { campaignId: "nope" })).status).toBe(404);
    expect((await w.importRows([{ fullName: "A", email: "a@x.com" }], { campaignVersion: 9 })).status).toBe(404); // a version that does not exist
    expect((await w.importRows([{ fullName: "A", email: "a@x.com" }], { campaignVersion: 1 })).status).toBe(201);
    expect((await w.leads())[0]!.campaignVersion).toBe(1); // the importer's statement of the version, recorded
    expect((await w.importRows([{ fullName: "A", email: "a@x.com" }], { sourceNote: "" })).status).toBe(400);
    expect((await w.importRows([])).status).toBe(400);
    expect((await w.importRows([{ fullName: "A", email: "a@x.com" }], {}, w.viewer)).status).toBe(403);
    const other = await person(w.s, "ivy");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    expect((await call(w.s.app, "POST", `/api/workspaces/${W2}/leads/import`, other.token, { campaignId: w.cid, sourceNote: "x", rows: [{ fullName: "A", email: "a@x.com" }] })).status).toBe(404);
    expect(await w.leads()).toHaveLength(1); // only the one valid import above; every refused request stored nothing
  });
});

describe("follow-up reminders", () => {
  it("sets a date and a note, marks it done, clears it when the date moves, audits each change, and sends nothing", async () => {
    const w = await world();
    await w.importRows([{ fullName: "Ada", email: "ada@x.com" }]);
    const id = (await w.leads())[0]!.id as string;
    const put = (body: Json, by = w.operator) => call(w.s.app, "PUT", `${w.base}/leads/${id}/follow-up`, by.token, body);
    expect((await put({ done: true })).body.error.code).toBe("no_follow_up");
    expect((await put({ dueDate: "2030-02-31" })).status).toBe(400);
    expect((await put({ dueDate: "2030-05-01", note: "Call about the quote" })).body.followUp).toMatchObject({ dueDate: "2030-05-01", done: false, note: "Call about the quote" });
    expect((await put({ done: true })).body.followUp).toMatchObject({ done: true });
    expect((await w.detail(id)).followUp).toMatchObject({ dueDate: "2030-05-01", done: true });
    expect((await put({ dueDate: "2030-06-01" })).body.followUp).toMatchObject({ dueDate: "2030-06-01", done: false }); // a new date reopens it
    expect((await put({ dueDate: "2030-06-02" }, w.viewer)).status).toBe(403);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type = 'lead.follow_up_set'").get()).toEqual({ n: 3 });
    expect(readFileSync("src/app/leadIntake.ts", "utf8")).not.toMatch(/nodemailer|smtp|twilio|sendgrid|fetch\(|https?:\/\/|sendMail/i);
  });
});

describe("lead forms: definitions and clearly labelled test submissions only", () => {
  const FORM = { name: "Quote request", fields: { email: "required", phone: "optional" }, privacyNotice: "We use your details only to reply to your request.", consentText: "I agree to be contacted about my request.", purpose: "Reply to quote requests", retentionNote: "Deleted after 12 months" };
  it("needs honest settings: a required contact field, a privacy notice, consent wording, a purpose and a retention note", async () => {
    const w = await world();
    const post = (b: Json) => call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/forms`, w.operator.token, b);
    expect((await post({ ...FORM, fields: { email: "optional", phone: "optional" } })).status).toBe(400);
    expect((await post({ ...FORM, fields: { email: "off", phone: "off" } })).status).toBe(400);
    for (const k of ["privacyNotice", "consentText", "purpose", "retentionNote"]) expect((await post({ ...FORM, [k]: "" })).status, k).toBe(400);
    const ok = await post(FORM);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ currentVersion: 1, published: false });
    expect(ok.body.publishNote).toMatch(/not published or hosted/);
    expect(ok.body.versions[0].campaignVersion).toBe(1);
    expect((await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/forms`, w.viewer.token, FORM)).status).toBe(403);
    expect((await call(w.s.app, "GET", `${w.base}/campaigns/${w.cid}/forms`, w.viewer.token)).body.forms).toHaveLength(1);
  });

  it("revising adds a version and keeps the old one; a test submission records a SYNTHETIC lead tied to that form version, the campaign version and the UTM tags", async () => {
    const w = await world();
    const f = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/forms`, w.operator.token, FORM)).body;
    const rev = await call(w.s.app, "POST", `${w.base}/forms/${f.id}/versions`, w.operator.token, { fields: FORM.fields, privacyNotice: FORM.privacyNotice, purpose: FORM.purpose, retentionNote: FORM.retentionNote, consentText: "I agree to be called back." });
    expect(rev.body.versions.map((v: Json) => [v.version, v.consentText])).toEqual([[1, "I agree to be contacted about my request."], [2, "I agree to be called back."]]);
    const sub = (b: Json) => call(w.s.app, "POST", `${w.base}/forms/${f.id}/test-submission`, w.operator.token, b);
    expect((await sub({ fullName: "Visitor", email: "v@x.com", consent: false })).body.error.code).toBe("consent_required");
    expect((await sub({ fullName: "Visitor", consent: true })).body.error.code).toBe("email_required");
    const ok = await sub({ fullName: "Visitor", email: "V@X.com", consent: true, utm: { source: "test", campaign: w.cid }, eventId: "evt-1" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const d = await w.detail(ok.body.leadId);
    expect(d).toMatchObject({ origin: "synthetic", campaignVersion: 1, form: { id: f.id, version: 2 }, utm: { source: "test", campaign: w.cid }, attribution: { status: "observed", basis: "form_test" }, consent: { status: "given" } });
    expect(d.consent.note).toMatch(/Test consent to: I agree to be called back/);
    expect(d.crm.status).toBe("not_synced");
    expect((await sub({ fullName: "Visitor", email: "v@x.com", consent: true, eventId: "evt-1" })).body).toMatchObject({ duplicate: true, leadId: null });
    expect(await w.leads()).toHaveLength(1);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("ties a test lead to the creative and format it came through, only when that creative belongs to the campaign", async () => {
    const w = await world();
    const f = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/forms`, w.operator.token, FORM)).body;
    const concept = { headline: "Fast help", subline: "", callToAction: "GET_QUOTE", visualDescription: "Clean", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" } };
    const cr = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/creatives`, w.operator.token, { name: "Ad", brief: { objective: "a", keyMessage: "b" }, concept, altText: "An advertisement", ratios: ["1:1"] })).body.id as string;
    const ok = await call(w.s.app, "POST", `${w.base}/forms/${f.id}/test-submission`, w.operator.token, { fullName: "V", email: "v@x.com", consent: true, creativeId: cr, ratio: "1:1" });
    expect((await w.detail(ok.body.leadId)).creative).toEqual({ id: cr, version: 1, ratio: "1:1" });
    const c2 = await w.gen();
    const f2 = (await call(w.s.app, "POST", `${w.base}/campaigns/${c2}/forms`, w.operator.token, FORM)).body;
    expect((await call(w.s.app, "POST", `${w.base}/forms/${f2.id}/test-submission`, w.operator.token, { fullName: "V", email: "v@x.com", consent: true, creativeId: cr })).body.error.code).toBe("creative_not_in_campaign");
  });
});

describe("analytics: truthful, labelled by source, never blended", () => {
  it("counts each origin on its own and has no combined total", async () => {
    const w = await world();
    await w.launch();
    await w.simulate({ email: "s1@x.com" }); await w.simulate({ email: "s2@x.com" });
    await w.importRows([{ fullName: "I1", email: "i1@x.com" }, { fullName: "I2", email: "i2@x.com", utm: { campaign: "other" } }, { fullName: "I3", email: "i3@x.com", utm: { campaign: w.cid } }]);
    const ids = await w.leads();
    await call(w.s.app, "PUT", `${w.base}/leads/${ids.find((l) => l.fullName === "I1")!.id}/status`, w.operator.token, { status: "qualified" });
    const a = await w.analytics();
    const by = Object.fromEntries(a.origins.map((o: Json) => [o.origin, o]));
    expect(by.synthetic).toMatchObject({ leads: 2, source: "simulated", attribution: { observed: 2, inferred: 0, unknown: 0 } });
    expect(by.imported).toMatchObject({ leads: 3, source: "imported", byStatus: { new: 2, qualified: 1 }, attribution: { observed: 0, inferred: 2, unknown: 1 } });
    expect(by.real).toMatchObject({ leads: 0, source: "actual" });
    expect(by.real.note).toMatch(/None/);
    expect(JSON.stringify(a)).not.toMatch(/"total"|"allLeads"|"combined"/);
    expect(a.campaigns).toHaveLength(1);
    expect(a.campaigns[0].byOrigin.map((o: Json) => [o.origin, o.leads, o.qualified])).toEqual([["synthetic", 2, 0], ["imported", 3, 1]]);
    expect(a.attributionNote).toMatch(/not proof the campaign caused it/);
  });

  it("lists what cannot be measured as not measured, never as zero and never with a figure", async () => {
    const w = await world();
    const a = await w.analytics();
    for (const id of ["impressions", "clicks", "spend", "cost_per_lead", "click_through_rate", "conversion_rate", "roas", "leads_real"]) {
      const m = a.metrics.find((x: Json) => x.id === id);
      expect(m, id).toMatchObject({ available: false, sourceType: id === "leads_real" ? "unknown" : "unknown", value: null });
      expect(m.why.length).toBeGreaterThan(20);
    }
    expect(a.metrics.filter((m: Json) => m.available).map((m: Json) => m.sourceType).sort()).toEqual(["estimated", "imported", "simulated", "user_entered"]);
    expect(a.metrics.find((m: Json) => m.id === "planned_daily_commitment").why).toMatch(/intent, not spend/);
    expect(a.measurability.notMeasurable.join(" ")).toMatch(/Cost per lead/);
    expect(a.principle).toMatch(/never added together/);
  });

  it("counts follow-ups and imported consent, and is private to the workspace and readable by a viewer", async () => {
    const w = await world();
    await w.importRows([{ fullName: "A", email: "a@x.com" }], { consent: "given" });
    const id = (await w.leads())[0]!.id as string;
    await call(w.s.app, "PUT", `${w.base}/leads/${id}/follow-up`, w.operator.token, { dueDate: "2000-01-01" });
    const a = await w.analytics();
    expect(a.followUps).toMatchObject({ open: 1, overdue: 1, done: 0 });
    expect(a.consent.imported).toEqual({ given: 1 });
    const other = await person(w.s, "ivy");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    const b = (await call(w.s.app, "GET", `/api/workspaces/${W2}/analytics`, other.token)).body;
    expect(b.origins.every((o: Json) => o.leads === 0)).toBe(true);
    expect(b.campaigns).toEqual([]);
  });
});
