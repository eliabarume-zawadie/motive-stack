/**
 * Phase 7: experiments (plans, exact-version variants, recorded use and results, honest analysis), the Marketing Brain (traceable, human-confirmed learnings that are never
 * business facts) and recommendations (derived from records, with evidence and uncertainty, needing a person). Nothing here changes spend, edits a campaign or publishes.
 * Mock mode only; signed-in people are test identities.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { twoProportionTest } from "../src/app/experiments.js";
import { createWorker } from "../src/app/worker.js";
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
afterEach(() => { while (open.length) open.pop()?.(); });

type Json = Record<string, any>;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PUT", url: string, token?: string, payload?: unknown) {
  const res = await app.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : {}) as Json };
}
function boot(now?: () => Date) {
  const db = openDb(":memory:");
  migrate(db);
  const ctx: AppContext = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} }, assetStore: new MemoryAssetStore(), imageProvider: new MockImageProvider(), ...(now ? { now } : {}) });
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
  let offsetDays = 0;
  const s = boot(() => new Date(Date.now() + offsetDays * 86400000));
  const advance = (days: number) => { offsetDays += days; };
  const owner = await person(s, "olivia"), admin = await person(s, "adam"), admin2 = await person(s, "amy"), operator = await person(s, "oscar"), viewer = await person(s, "vera");
  const W = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Learn Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [admin2, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(s.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
  const gen = async () => (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const cid = await gen();
  const v2 = async (campaign = cid) => { const rec = (await call(s.app, "GET", `${base}/campaigns/${campaign}`, owner.token)).body; const r = await call(s.app, "PUT", `${base}/campaigns/${campaign}/brief`, operator.token, { ...rec.brief, dailyBudgetCents: rec.brief.dailyBudgetCents - 50 }); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  const plan = (over: Json = {}) => ({
    name: "Headline test", hypothesis: "A question headline gets more qualified leads than the current statement", principalVariable: "headline", variableNote: "Only the headline wording differs", audienceNote: "Homeowners in the service area", placementNote: "Feed",
    successMetric: "qualified_rate", durationDays: 14, minSample: 20, decisionRule: "If the variant's qualified share is at least 5 points higher with enough data, switch; otherwise keep the control",
    variants: [{ label: "Control", role: "control", description: "Current headline", campaignId: cid, campaignVersion: 1 }, { label: "Question", role: "variant", description: "Question headline", campaignId: cid, campaignVersion: 2 }], ...over,
  });
  const create = (over: Json = {}, by = operator) => call(s.app, "POST", `${base}/experiments`, by.token, plan(over));
  const exp = async (id: string) => (await call(s.app, "GET", `${base}/experiments/${id}`, viewer.token)).body;
  const analysis = async (id: string) => (await call(s.app, "GET", `${base}/experiments/${id}/analysis`, viewer.token)).body;
  const start = (id: string, by = operator) => call(s.app, "POST", `${base}/experiments/${id}/start`, by.token);
  const observe = (id: string, body: Json, by = operator) => call(s.app, "POST", `${base}/experiments/${id}/observations`, by.token, { metric: "qualified_rate", sourceType: "user_entered", sourceNote: "From the team's own tally", observedOn: "2030-01-10", ...body });
  const conclude = (id: string, body: Json, by = admin) => call(s.app, "POST", `${base}/experiments/${id}/conclude`, by.token, body);
  /** Runs a 2-variant experiment (control v1, variant v2) to the start. */
  const running = async (over: Json = {}) => { await v2(); const r = await create(over); expect(r.status, JSON.stringify(r.body)).toBe(201); expect((await start(r.body.id)).status).toBe(200); return r.body.id as string; };
  const creative = async () => {
    const concept = { headline: "Fast help, fair price", subline: "Free on-site quote", callToAction: "GET_QUOTE", visualDescription: "A clean, bright layout", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" } };
    const id = (await call(s.app, "POST", `${base}/campaigns/${cid}/creatives`, operator.token, { name: "Spring ad", brief: { objective: "Get quotes", keyMessage: "Fast help" }, concept, altText: "A bright advertisement with a headline", ratios: ["1:1"] })).body.id as string;
    await call(s.app, "POST", `${base}/creatives/${id}/versions/1/renders`, operator.token, {}); await s.worker.runUntilIdle();
    return id;
  };
  const approvedCreative = async () => { const id = await creative(); await call(s.app, "POST", `${base}/creatives/${id}/versions/1/submit`, operator.token); expect((await call(s.app, "POST", `${base}/creatives/${id}/versions/1/approve`, admin.token, {})).status).toBe(200); return id; };
  const importLeads = (n: number, version: number, prefix: string) => call(s.app, "POST", `${base}/leads/import`, operator.token, { campaignId: cid, campaignVersion: version, sourceNote: "Test list", rows: Array.from({ length: n }, (_, i) => ({ fullName: `${prefix}${i}`, email: `${prefix}${i}@x.com` })) });
  const qualify = (prefix: string, count: number) => s.db.prepare("UPDATE leads SET status = 'qualified' WHERE id IN (SELECT id FROM leads WHERE full_name LIKE ? ORDER BY full_name LIMIT ?)").run(`${prefix}%`, count);
  const snapshot = () => JSON.stringify([s.db.prepare("SELECT id, status, current_version, lifecycle_state FROM campaigns ORDER BY id").all(), s.db.prepare("SELECT id, status, payload_hash FROM action_proposals ORDER BY id").all(), s.db.prepare("SELECT creative_id, version, status FROM creative_versions ORDER BY creative_id, version").all(), s.db.prepare("SELECT data FROM business_brains").all()]);
  return { s, advance, owner, admin, admin2, operator, viewer, W, base, cid, gen, v2, plan, create, exp, analysis, start, observe, conclude, running, creative, approvedCreative, importLeads, qualify, snapshot };
}
type Wd = Awaited<ReturnType<typeof world>>;

describe("the maths is honest about when it can be used", () => {
  it("computes a two-proportion test and refuses when the approximation is not valid", () => {
    const t = twoProportionTest({ successes: 50, trials: 100 }, { successes: 70, trials: 100 })!;
    expect(t.z).toBeCloseTo(2.89, 1);
    expect(t.p).toBeGreaterThan(0.003); expect(t.p).toBeLessThan(0.005);
    expect(twoProportionTest({ successes: 3, trials: 40 }, { successes: 20, trials: 40 })).toBeNull(); // fewer than 5 successes
    expect(twoProportionTest({ successes: 38, trials: 40 }, { successes: 20, trials: 40 })).toBeNull(); // fewer than 5 failures
    expect(twoProportionTest({ successes: 10, trials: 40 }, { successes: 10, trials: 40 })!.p).toBeCloseTo(1, 3);
  });
});

describe("experiment plans", () => {
  it("records a hypothesis, one principal variable, audience, placement, success metric, duration, minimum data and a decision rule, with variants pinned to exact versions", async () => {
    const w = await world();
    await w.v2();
    const r = await w.create();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: "draft", principalVariable: "headline", successMetric: "qualified_rate", durationDays: 14, minSample: 20, planLocked: false });
    expect(r.body.variants.map((v: Json) => [v.label, v.role, v.campaign.version])).toEqual([["Control", "control", 1], ["Question", "variant", 2]]);
    expect(r.body.neverAutomatic).toMatch(/does not change any budget, campaign or creative/);
    expect(r.body.decisionRule).toMatch(/enough data/);
  });

  it("refuses a plan that is not a comparison: no or several controls, one label twice, identical versions, no reference, a missing decision rule", async () => {
    const w = await world();
    await w.v2();
    const V = (role: string, label: string, extra: Json = {}) => ({ label, role, description: "d", campaignId: w.cid, campaignVersion: 1, ...extra });
    expect((await w.create({ variants: [V("variant", "A", { campaignVersion: 2 }), V("variant", "B", { campaignVersion: 1 })] })).body.error.code).toBe("one_control_required");
    expect((await w.create({ variants: [V("control", "A"), V("control", "B", { campaignVersion: 2 })] })).body.error.code).toBe("one_control_required");
    expect((await w.create({ variants: [V("control", "A"), V("variant", "a", { campaignVersion: 2 })] })).body.error.code).toBe("duplicate_label");
    expect((await w.create({ variants: [V("control", "A"), V("variant", "B")] })).body.error.code).toBe("identical_variants");
    expect((await w.create({ variants: [V("control", "A"), { label: "B", role: "variant", description: "d" }] })).body.error.code).toBe("variant_needs_reference");
    expect((await w.create({ decisionRule: "" })).status).toBe(400);
    expect((await w.create({ hypothesis: "" })).status).toBe(400);
    expect((await w.create({ minSample: 0 })).status).toBe(400);
    expect((await w.create({ durationDays: 0 })).status).toBe(400);
    expect((await w.create({ variants: [V("control", "A")] })).status).toBe(400);
    expect((await w.create({ variants: [V("control", "A"), V("variant", "B", { campaignVersion: 9 })] })).status).toBe(404);
    expect((await w.create({ variants: [V("control", "A"), V("variant", "B", { campaignId: "nope" })] })).status).toBe(404);
  });

  it("when the variable is the creative image, every variant must name a creative version; and it says what the design cannot guarantee", async () => {
    const w = await world();
    await w.v2();
    expect((await w.create({ principalVariable: "creative_image" })).body.error.code).toBe("creative_required");
    const c2 = await w.gen();
    const other = await w.create({ variants: [{ label: "Control", role: "control", description: "d", campaignId: w.cid, campaignVersion: 1 }, { label: "Other campaign", role: "variant", description: "d", campaignId: c2 }] });
    expect(other.body.designWarnings.join(" ")).toMatch(/different campaigns/);
    const aud = await w.create({ principalVariable: "audience" });
    expect(aud.body.designWarnings.join(" ")).toMatch(/cannot check that only the principal variable differs/);
  });

  it("is editable as a draft and FROZEN once started, so the plan cannot be changed to suit the data", async () => {
    const w = await world();
    await w.v2();
    const id = (await w.create()).body.id as string;
    const put = (b: Json) => call(w.s.app, "PUT", `${w.base}/experiments/${id}`, w.operator.token, b);
    expect((await put(w.plan({ hypothesis: "A sharper hypothesis" }))).body.hypothesis).toBe("A sharper hypothesis");
    expect((await w.start(id)).body).toMatchObject({ status: "running", planLocked: true });
    const locked = await put(w.plan({ decisionRule: "Switch if it looks good" }));
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe("plan_locked");
    expect((await w.start(id)).body.error.code).toBe("not_draft");
    expect((await w.exp(id)).decisionRule).toMatch(/at least 5 points/);
  });

  it("is private to the workspace and respects roles: viewers read, operators plan and start, only admins conclude", async () => {
    const w = await world();
    await w.v2();
    expect((await w.create({}, w.viewer)).status).toBe(403);
    const id = (await w.create()).body.id as string;
    expect((await w.start(id, w.viewer)).status).toBe(403);
    await w.start(id);
    expect((await w.conclude(id, { outcome: "inconclusive", rationale: "Too early" }, w.operator)).status).toBe(403);
    const other = await person(w.s, "ivy");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    expect((await call(w.s.app, "GET", `/api/workspaces/${W2}/experiments/${id}`, other.token)).status).toBe(404);
    expect((await call(w.s.app, "GET", `/api/workspaces/${W2}/experiments`, other.token)).body.experiments).toEqual([]);
  });
});

describe("recorded use and results are labelled by who entered them and where they came from", () => {
  it("records which variant was actually used, separately from the plan, and only while running", async () => {
    const w = await world();
    await w.v2();
    const id = (await w.create()).body.id as string;
    const draft = await call(w.s.app, "POST", `${w.base}/experiments/${id}/usage`, w.operator.token, { variantId: "x", usedFrom: "2030-01-01", note: "n" });
    expect(draft.body.error.code).toBe("not_running");
    await w.start(id);
    const control = (await w.exp(id)).variants.find((v: Json) => v.role === "control").id as string;
    const use = (b: Json) => call(w.s.app, "POST", `${w.base}/experiments/${id}/usage`, w.operator.token, b);
    expect((await use({ variantId: control, usedFrom: "2030-01-02", usedTo: "2030-01-01", note: "n" })).body.error.code).toBe("bad_range");
    expect((await use({ variantId: "nope", usedFrom: "2030-01-02", note: "n" })).status).toBe(404);
    expect((await use({ variantId: control, usedFrom: "2030-01-02", note: "Ran in the spring feed" })).status).toBe(200);
    expect((await w.analysis(id)).variants[0].usage[0]).toMatchObject({ usedFrom: "2030-01-02", note: "Ran in the spring feed", byKind: "person" });
    expect((await w.analysis(id)).warnings.some((x: Json) => x.code === "no_usage_recorded")).toBe(true); // the other variant has no record
  });

  it("accepts a count out of a total or a plain value, never both or neither, and labels the source; synthetic is allowed only as synthetic", async () => {
    const w = await world();
    const id = await w.running();
    const vid = (await w.exp(id)).variants[0].id as string;
    expect((await w.observe(id, { variantId: vid, successes: 9, trials: 5 })).status).toBe(400);
    expect((await w.observe(id, { variantId: vid })).status).toBe(400);
    expect((await w.observe(id, { variantId: vid, successes: 1, trials: 5, value: 3 })).status).toBe(400);
    expect((await w.observe(id, { variantId: vid, successes: 1, trials: 5, sourceType: "guess" })).status).toBe(400);
    expect((await w.observe(id, { variantId: vid, successes: 2, trials: 10, sourceType: "imported", sourceNote: "Ad platform export" })).status).toBe(200);
    expect((await w.observe(id, { variantId: vid, successes: 1, trials: 3, sourceType: "synthetic", sourceNote: "Simulator" })).status).toBe(200);
    const obs = (await w.analysis(id)).variants[0].observations;
    expect(obs.map((o: Json) => [o.sourceType, o.successes, o.trials])).toEqual([["imported", 2, 10], ["synthetic", 1, 3]]);
  });
});

describe("analysis: counts what exists, by exact version and origin, and says what it cannot know", () => {
  it("counts leads for the exact campaign version, keeps synthetic and imported apart, and reports leads with no recorded version", async () => {
    const w = await world();
    const id = await w.running();
    await w.importLeads(30, 1, "c"); await w.importLeads(25, 2, "v");
    await call(w.s.app, "POST", `${w.base}/leads/import`, w.operator.token, { campaignId: w.cid, sourceNote: "Old list", rows: [{ fullName: "Unversioned", email: "u@x.com" }] });
    w.qualify("c", 6); w.qualify("v", 15);
    const a = await w.analysis(id);
    const [ctl, vr] = a.variants;
    expect(ctl).toMatchObject({ label: "Control", leads: { byOrigin: { imported: 30 }, leadSample: 30, qualified: 6, notCountedNoVersion: 1 } });
    expect(vr).toMatchObject({ label: "Question", leads: { leadSample: 25, qualified: 15 } });
    expect(a.warnings.map((x: Json) => x.code)).toEqual(expect.arrayContaining(["leads_without_version", "assignment_unverified"]));
  });

  it("blocks a conclusion until the planned time and the minimum data are met, and says why", async () => {
    const w = await world();
    const id = await w.running();
    await w.importLeads(5, 1, "c"); await w.importLeads(5, 2, "v");
    const a = await w.analysis(id);
    expect(a.readiness).toBe("collecting");
    expect(a.blocking.map((x: Json) => x.code)).toEqual(expect.arrayContaining(["duration_not_reached", "below_min_sample"]));
    expect(a.blocking.find((x: Json) => x.code === "below_min_sample").message).toMatch(/below the planned minimum of 20/);
    expect(a.significance).toMatchObject({ assessed: false, claimsSignificance: false });
    expect(a.note).toMatch(/does not mean the result is true/);
  });

  it("treats synthetic data as unusable for a decision", async () => {
    const w = await world();
    const id = await w.running();
    const vid = (await w.exp(id)).variants.map((v: Json) => v.id as string);
    for (const v of vid) await w.observe(id, { variantId: v, successes: 30, trials: 100, sourceType: "synthetic", sourceNote: "Simulator" });
    const a = await w.analysis(id);
    expect(a.blocking.map((x: Json) => x.code)).toContain("only_synthetic_data");
    expect(a.significance.assessed).toBe(false);
    expect(a.variants.every((v: Json) => v.sample === 0)).toBe(true); // synthetic numbers add nothing to the sample
  });

  it("does not invent a metric the app cannot measure: it asks for it to be entered", async () => {
    const w = await world();
    const id = await w.running({ successMetric: "cost_per_lead" });
    const a = await w.analysis(id);
    expect(a.plan.measuredByApp).toBe(false);
    expect(a.blocking.find((x: Json) => x.code === "metric_not_entered").message).toMatch(/not measured by this app/);
    expect(JSON.stringify(a.variants)).not.toMatch(/"cost"|costPerLead/);
    expect(a.significance.reason).toMatch(/not a count out of a total/);
  });

  it("offers an INDICATIVE test only when two non-synthetic variants have enough counts, and never claims significance", async () => {
    const w = await world();
    const id = await w.running();
    w.advance(40); // the planned duration has now passed
    await w.importLeads(40, 1, "c"); await w.importLeads(40, 2, "v");
    w.qualify("c", 8); w.qualify("v", 22);
    const a = await w.analysis(id);
    expect(a.significance).toMatchObject({ assessed: true, claimsSignificance: false, method: "two-proportion z-test (pooled), two-sided" });
    expect(a.significance.dataset).toMatch(/synthetic leads are never used/);
    expect(a.significance.control).toMatchObject({ successes: 8, trials: 40 });
    expect(a.significance.variant).toMatchObject({ successes: 22, trials: 40 });
    expect(a.significance.pValue).toBeLessThan(0.01);
    expect(a.significance.interpretation).toMatch(/INDICATIVE ONLY/);
    expect(a.significance.interpretation).toMatch(/not a claim that the result is statistically significant/);
    expect(a.readiness).toBe("enough_data_to_consider");
    expect(JSON.stringify(a)).not.toMatch(/"significant":\s*true/);
  });

  it("uses entered results for a rate it cannot compute, from one source at a time, and never adds sources together", async () => {
    const w = await world();
    const id = await w.running({ successMetric: "click_through_rate" });
    w.advance(40);
    const [c, v] = (await w.exp(id)).variants.map((x: Json) => x.id as string);
    await w.observe(id, { variantId: c, metric: "click_through_rate", successes: 30, trials: 1000, sourceType: "imported", sourceNote: "Platform export" });
    await w.observe(id, { variantId: v, metric: "click_through_rate", successes: 60, trials: 1000, sourceType: "imported", sourceNote: "Platform export" });
    await w.observe(id, { variantId: v, metric: "click_through_rate", successes: 500, trials: 600, sourceType: "user_entered", sourceNote: "Guess" });
    const a = await w.analysis(id);
    expect(a.significance).toMatchObject({ assessed: true, dataset: "entered results (imported) for the success metric", control: { successes: 30, trials: 1000 }, variant: { successes: 60, trials: 1000 } });
    expect(a.warnings.map((x: Json) => x.code)).toContain("mixed_sources");
  });
});

describe("concluding records a decision and changes nothing else", () => {
  it("refuses to pick a winner on thin data unless the warnings are acknowledged; inconclusive is always allowed", async () => {
    const w = await world();
    const id = await w.running();
    const r = await w.conclude(id, { outcome: "variant_better", rationale: "It looks better" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("warnings_unacknowledged");
    expect(r.body.error.message).toMatch(/does not yet support picking a winner/);
    expect((await w.exp(id)).status).toBe("running");
    const ok = await w.conclude(id, { outcome: "variant_better", rationale: "Our judgement despite thin data", acknowledgeWarnings: true });
    expect(ok.body).toMatchObject({ status: "concluded", outcome: "variant_better", outcomeRationale: "Our judgement despite thin data" });
    expect(ok.body.warningsAtConclusion.map((x: Json) => x.code)).toEqual(expect.arrayContaining(["below_min_sample", "duration_not_reached"])); // the warnings stay with the decision
    const w2 = await world();
    const id2 = await w2.running();
    expect((await w2.conclude(id2, { outcome: "inconclusive", rationale: "Not enough yet" })).body.outcome).toBe("inconclusive");
  });

  it("changes no campaign, creative, proposal, budget or Business Brain, and locks the results once concluded", async () => {
    const w = await world();
    await w.approvedCreative();
    const id = await w.running();
    const before = w.snapshot();
    await w.conclude(id, { outcome: "control_better", rationale: "Keep what we have", acknowledgeWarnings: true });
    expect(w.snapshot()).toBe(before);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get()).toEqual({ n: 0 });
    const vid = (await w.exp(id)).variants[0].id as string;
    expect((await w.observe(id, { variantId: vid, successes: 1, trials: 2 })).body.error.code).toBe("not_running");
    expect((await w.conclude(id, { outcome: "inconclusive", rationale: "again" })).body.error.code).toBe("not_running");
  });

  it("can be abandoned with a reason, and the abandonment is recorded", async () => {
    const w = await world();
    const id = await w.running();
    expect((await call(w.s.app, "POST", `${w.base}/experiments/${id}/abandon`, w.admin.token, {})).status).toBe(400);
    const r = await call(w.s.app, "POST", `${w.base}/experiments/${id}/abandon`, w.admin.token, { reason: "The campaign was withdrawn" });
    expect(r.body).toMatchObject({ status: "abandoned", outcome: "abandoned", outcomeRationale: "The campaign was withdrawn" });
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE type IN ('experiment.created','experiment.started','experiment.abandoned')").get()).toEqual({ n: 3 });
  });
});

describe("the Marketing Brain: traceable learnings, never business facts", () => {
  const LEARN = { statement: "Question headlines drew more replies in the spring", kind: "message", sourceType: "human_note", observedOn: "2030-04-01", confidence: "low", limitations: "One season, one campaign, hand-counted" };
  const learn = (w: Wd, body: Json = {}, by = w.operator) => call(w.s.app, "POST", `${w.base}/learnings`, by.token, { ...LEARN, ...body });
  const decide = (w: Wd, id: string, d: string, body: Json = {}, by = w.admin) => call(w.s.app, "POST", `${w.base}/learnings/${id}/${d}`, by.token, body);

  it("needs a source, a date, a confidence and the limitations, and starts as a suggestion that a PERSON must confirm", async () => {
    const w = await world();
    for (const k of ["statement", "limitations", "observedOn"]) expect((await learn(w, { [k]: "" })).status, k).toBe(400);
    expect((await learn(w, { confidence: "certain" })).status).toBe(400);
    expect((await learn(w, { sourceType: "experiment" })).body.error.code).toBe("source_ref_required");
    expect((await learn(w, { sourceType: "experiment", sourceRef: "exp_nope" })).status).toBe(404);
    const ok = await learn(w);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ status: "suggested", origin: "human_entered", originLabel: "Written by a person", humanConfirmed: false, usableAsClaim: false, confidence: "low" });
    expect((await learn(w, {}, w.viewer)).status).toBe(403);
  });

  it("is confirmed by someone other than its author, rejected or retired only with a reason, and the decision is recorded", async () => {
    const w = await world();
    const id = (await learn(w, {}, w.admin)).body.id as string;
    const self = await decide(w, id, "confirm", {}, w.admin);
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toMatch(/self_approval_not_allowed/);
    expect((await decide(w, id, "confirm", {}, w.operator)).status).toBe(403);
    const ok = await decide(w, id, "confirm", { note: "Matches what we saw" }, w.admin2);
    expect(ok.body).toMatchObject({ status: "confirmed", humanConfirmed: true, separation: "enforced" });
    expect((await decide(w, id, "retire", {}, w.admin2)).body.error.code).toBe("note_required");
    expect((await decide(w, id, "retire", { note: "Superseded by a later test" }, w.admin2)).body.status).toBe("retired");
    const id2 = (await learn(w)).body.id as string;
    expect((await decide(w, id2, "reject", {})).body.error.code).toBe("note_required");
    expect((await decide(w, id2, "reject", { note: "One anecdote" })).body.status).toBe("rejected");
    expect((await decide(w, id2, "confirm")).body.error.code).toBe("not_suggested");
  });

  it("never becomes a business fact: confirming it changes neither the Business Brain nor what the creative claim check allows", async () => {
    const w = await world();
    const brainBefore = JSON.stringify(w.s.db.prepare("SELECT data, version FROM business_brains").all());
    const id = (await learn(w, { statement: "We are the cheapest plumber in Austin" })).body.id as string;
    expect((await decide(w, id, "confirm", {}, w.admin)).body.status).toBe("confirmed");
    expect(JSON.stringify(w.s.db.prepare("SELECT data, version FROM business_brains").all())).toBe(brainBefore);
    const concept = { headline: "Cheapest plumber in Austin", subline: "", callToAction: "GET_QUOTE", visualDescription: "A clean layout", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" } };
    const cr = (await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/creatives`, w.operator.token, { name: "Claim test", brief: { objective: "a", keyMessage: "b" }, concept, altText: "An advertisement with a claim", ratios: ["1:1"] })).body.id as string;
    await call(w.s.app, "POST", `${w.base}/creatives/${cr}/versions/1/renders`, w.operator.token, {}); await w.s.worker.runUntilIdle();
    const qa = (await call(w.s.app, "POST", `${w.base}/creatives/${cr}/versions/1/check`, w.viewer.token)).body;
    expect(qa.checks.find((c: Json) => c.id === "claims")).toMatchObject({ status: "fail" });
    const list = (await call(w.s.app, "GET", `${w.base}/learnings`, w.viewer.token)).body;
    expect(list.note).toMatch(/never makes an ad claim usable/);
  });

  it("suggests learnings by plain rules from concluded experiments and rejected or approved creatives: low confidence, with limits, once each, never auto-confirmed", async () => {
    const w = await world();
    const approved = await w.approvedCreative();
    const rej = await w.creative();
    await call(w.s.app, "POST", `${w.base}/creatives/${rej}/versions/1/submit`, w.operator.token);
    await call(w.s.app, "POST", `${w.base}/creatives/${rej}/versions/1/reject`, w.admin.token, { reason: "Headline is too pushy" });
    const id = await w.running();
    await w.conclude(id, { outcome: "inconclusive", rationale: "No clear difference" });
    const r = await call(w.s.app, "POST", `${w.base}/learnings/suggest`, w.operator.token);
    expect(r.body.added).toBe(3);
    const ls = r.body.learnings as Json[];
    expect(ls.every((l) => l.status === "suggested" && l.origin === "machine_suggested" && l.confidence === "low" && l.limitations.length > 20 && l.usableAsClaim === false)).toBe(true);
    expect(ls.map((l) => l.sourceType).sort()).toEqual(["approved_creative", "experiment", "rejected_creative"]);
    expect(ls.find((l) => l.sourceType === "approved_creative")!.limitations).toMatch(/not evidence that the creative performs/);
    expect(ls.find((l) => l.sourceType === "rejected_creative")!.statement).toMatch(/Headline is too pushy/);
    expect(ls.find((l) => l.sourceType === "experiment")!.statement).toMatch(/no clear difference/);
    expect(ls.find((l) => l.sourceType === "experiment")!.sourceRef).toBe(id);
    expect(approved).toBeTruthy();
    expect((await call(w.s.app, "POST", `${w.base}/learnings/suggest`, w.operator.token)).body.added).toBe(0); // idempotent
    const conf = await decide(w, ls[0]!.id, "confirm", {}, w.admin);
    expect(conf.body).toMatchObject({ status: "confirmed", separation: "machine_suggested" });
    expect((await call(w.s.app, "POST", `${w.base}/learnings/suggest`, w.viewer.token)).status).toBe(403);
  });
});

describe("recommendations: derived from records, with evidence and uncertainty, needing a person", () => {
  const recs = async (w: Wd) => (await call(w.s.app, "GET", `${w.base}/recommendations`, w.viewer.token)).body;
  it("suggests testing one change only where an approved creative exists and no experiment does, and names its evidence and uncertainty", async () => {
    const w = await world();
    expect((await recs(w)).recommendations).toEqual([]);
    await w.approvedCreative();
    const r = (await recs(w)).recommendations.find((x: Json) => x.kind === "test_one_change");
    expect(r).toMatchObject({ requiresApproval: true, approvalPermission: "recommendations.decide", status: "open", evidenceKind: "records_and_inference" });
    expect(r.evidence).toEqual([{ type: "campaign", id: w.cid, label: expect.any(String) }]);
    expect(r.uncertainty).toMatch(/No performance data is measured by this app/);
    expect(r.neverAutomatic).toMatch(/does not change any budget, campaign or creative, and nothing is published/);
    await w.v2();
    await w.create();
    expect((await recs(w)).recommendations.some((x: Json) => x.kind === "test_one_change")).toBe(false); // an experiment now covers the campaign
  });

  it("says when an experiment needs data, when it has met its plan, and when its only data is synthetic", async () => {
    const w = await world();
    const id = await w.running();
    w.advance(40);
    let r = (await recs(w)).recommendations;
    expect(r.find((x: Json) => x.kind === "needs_data").text).toMatch(/below the planned minimum/);
    const [c, v] = (await w.exp(id)).variants.map((x: Json) => x.id as string);
    for (const x of [c, v]) await w.observe(id, { variantId: x, successes: 30, trials: 100, sourceType: "synthetic", sourceNote: "Simulator" });
    r = (await recs(w)).recommendations;
    expect(r.find((x: Json) => x.kind === "synthetic_only").text).toMatch(/Do not use it to decide anything/);
    await w.importLeads(40, 1, "c"); await w.importLeads(40, 2, "v"); w.qualify("c", 8); w.qualify("v", 22);
    r = (await recs(w)).recommendations;
    const ready = r.find((x: Json) => x.kind === "review_experiment");
    expect(ready.title).toMatch(/met its planned time and data/);
    expect(ready.uncertainty).toMatch(/does not make the result true/);
    expect(ready.evidence[0]).toMatchObject({ type: "experiment", id });
  });

  it("asks for a learning after a conclusion and for confirmation of waiting suggestions", async () => {
    const w = await world();
    const id = await w.running();
    await w.conclude(id, { outcome: "inconclusive", rationale: "Not enough" });
    expect((await recs(w)).recommendations.map((x: Json) => x.kind)).toContain("record_learning");
    await call(w.s.app, "POST", `${w.base}/learnings/suggest`, w.operator.token);
    const kinds = (await recs(w)).recommendations.map((x: Json) => x.kind);
    expect(kinds).toContain("confirm_learnings");
    expect(kinds).not.toContain("record_learning"); // a suggestion now exists
  });

  it("accepting or dismissing records a decision and changes nothing else; dismissing needs a reason; only admins decide", async () => {
    const w = await world();
    await w.approvedCreative();
    const key = (await recs(w)).recommendations[0].key as string;
    const before = w.snapshot();
    const post = (b: Json, by = w.admin) => call(w.s.app, "POST", `${w.base}/recommendations/decide`, by.token, b);
    expect((await post({ key, decision: "accept" }, w.operator)).status).toBe(403);
    expect((await post({ key, decision: "dismiss" })).body.error.code).toBe("note_required");
    expect((await post({ key: "nope:nothing", decision: "accept" })).status).toBe(404);
    expect((await post({ key, decision: "maybe" })).status).toBe(400);
    const ok = await post({ key, decision: "accept", note: "We will plan a test" });
    expect(ok.body).toMatchObject({ status: "accepted", decisionNote: "We will plan a test" });
    expect(w.snapshot()).toBe(before);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM experiments").get()).toEqual({ n: 0 }); // accepting did not create or start anything
    expect((await post({ key, decision: "dismiss", note: "Changed our mind" })).body.status).toBe("dismissed");
  });

  it("is private to the workspace", async () => {
    const w = await world();
    await w.approvedCreative();
    const other = await person(w.s, "ivy");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    expect((await call(w.s.app, "GET", `/api/workspaces/${W2}/recommendations`, other.token)).body.recommendations).toEqual([]);
    expect((await call(w.s.app, "GET", `/api/workspaces/${W2}/learnings`, other.token)).body.learnings).toEqual([]);
    expect((await call(w.s.app, "POST", `/api/workspaces/${W2}/recommendations/decide`, other.token, { key: (await recs(w)).recommendations[0].key, decision: "accept" })).status).toBe(404);
  });
});

describe("the inbox and the code stay honest", () => {
  it("lists waiting suggestions and an experiment past its planned end for someone who can act", async () => {
    const w = await world();
    await w.running();
    w.advance(40);
    await w.approvedCreative();
    await call(w.s.app, "POST", `${w.base}/learnings/suggest`, w.operator.token);
    const inbox = (await call(w.s.app, "GET", `${w.base}/inbox`, w.admin.token)).body;
    expect(inbox.waiting.find((x: Json) => x.kind === "learning_review")).toMatchObject({ canAct: true, actionPermission: "learnings.confirm" });
    expect(inbox.waiting.find((x: Json) => x.kind === "experiment_review")).toMatchObject({ canAct: true, actionPermission: "experiments.decide" });
    const viewer = (await call(w.s.app, "GET", `${w.base}/inbox`, w.viewer.token)).body;
    expect(viewer.waiting.find((x: Json) => x.kind === "learning_review").canAct).toBe(false);
  });

  it("has no code path from a learning, experiment or recommendation to spend, a campaign edit, the Business Brain or an external call", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/app/experiments.ts", "src/app/learnings.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/UPDATE campaigns|UPDATE business_brains|INSERT INTO business_brains|putBrain|updateBrief|createProposal|requestExecution|enqueueJob|fetch\(|https?:\/\/|nodemailer|crypto\.randomInt|Math\.random/);
    }
  });
});
