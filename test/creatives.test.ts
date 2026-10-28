/**
 * Phase 4: the Creative Studio (images, mock provider only). Pictures are persisted render jobs; nothing is complete until its bytes were validated and stored;
 * versions are immutable; approval is bound to one version and re-checks the current Business Brain and Brand Kit; a proposal pins the exact approved pictures.
 * Signed-in people are test identities; nothing leaves this process and no image service exists to contact.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type AppContext } from "../src/app/context.js";
import { createWorker } from "../src/app/worker.js";
import { buildAuthRuntime, loadAuthConfig } from "../src/auth/config.js";
import { StaticJwks } from "../src/auth/jwks.js";
import { checkPng, encodePng } from "../src/creative/png.js";
import { MockImageProvider } from "../src/creative/image.js";
import { RATIOS, matchesRatio } from "../src/creative/ratios.js";
import { contrastRatio } from "../src/creative/qa.js";
import { migrate, openDb } from "../src/db/db.js";
import { buildServer } from "../src/server/app.js";
import { MemoryAssetStore } from "../src/storage/assetStore.js";
import { readImageInfo } from "../src/storage/imageInfo.js";
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
  const json = String(res.headers["content-type"] ?? "").includes("json");
  return { status: res.statusCode, headers: res.headers, raw: res.rawPayload, body: (json && res.body ? JSON.parse(res.body) : {}) as Json };
}

function boot(limits: Partial<AppContext["creativeLimits"]> = {}) {
  const db = openDb(":memory:");
  migrate(db);
  const provider = new MockImageProvider();
  const store = new MemoryAssetStore();
  const ctx = buildContext({ db, env: {}, backoffMs: () => 0, gateway: { sleep: async () => {} }, assetStore: store, imageProvider: provider, creativeLimits: limits });
  const app = buildServer(ctx, oidc());
  open.push(() => db.open && db.close());
  return { db, ctx, app, provider, store, worker: createWorker(ctx) };
}
type S = ReturnType<typeof boot>;
async function person(s: S, name: string) {
  const token = signJwt(rsa, claims({ sub: `idp|${name}`, name }));
  return { token, id: (await call(s.app, "GET", "/api/me", token)).body.user.id as string };
}

const KIT = { voice: { descriptors: ["warm"], preferredTerms: [], avoidTerms: ["cheap"], ctaStyle: "" }, visual: { colors: [{ name: "Blue", hex: "#1A4D8F", role: "primary" }, { name: "Paper", hex: "#FFFFFF", role: "background" }, { name: "Ink", hex: "#1B1B1B", role: "text" }], typography: "", imageStyle: "Clean and bright", logoRules: "", referenceAssetIds: [] }, audiences: [], channels: [], disclaimers: [], notes: "" };

async function world(opts: { limits?: Partial<AppContext["creativeLimits"]>; approvedKit?: boolean } = {}) {
  const s = boot(opts.limits);
  const owner = await person(s, "olivia"), admin = await person(s, "adam"), admin2 = await person(s, "amy"), operator = await person(s, "oscar"), viewer = await person(s, "vera");
  const W = (await call(s.app, "POST", "/api/workspaces", owner.token, { name: "Studio Co" })).body.workspace.id as string;
  const base = `/api/workspaces/${W}`;
  for (const [p, role] of [[admin, "admin"], [admin2, "admin"], [operator, "operator"], [viewer, "viewer"]] as const) expect((await call(s.app, "POST", `${base}/members`, owner.token, { userId: p.id, role })).status).toBe(201);
  expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
  const cid = (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
  const approveKit = async (kit: Json = KIT) => {
    expect((await call(s.app, "PUT", `${base}/brand-kit`, operator.token, kit)).status).toBe(200);
    const v = (await call(s.app, "GET", `${base}/brand-kit`, owner.token)).body.version as number;
    expect((await call(s.app, "POST", `${base}/brand-kit/submit`, operator.token)).status).toBe(200);
    expect((await call(s.app, "POST", `${base}/brand-kit/approve`, admin.token, { version: v })).status).toBe(200);
  };
  if (opts.approvedKit !== false) await approveKit();
  const concept = (over: Json = {}) => ({ headline: "Fast help, fair price", subline: "Free on-site quote", callToAction: "GET_QUOTE", visualDescription: "A clean, bright layout", palette: { background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" }, ...over });
  const body = (over: Json = {}, c: Json = {}) => ({ name: "Spring ad", brief: { objective: "Get quote requests", keyMessage: "Fast, fair help" }, concept: concept(c), altText: "A bright advertisement with a headline and a blue accent", ratios: ["1:1", "4:5"], ...over });
  const make = async (over: Json = {}, c: Json = {}) => { const r = await call(s.app, "POST", `${base}/campaigns/${cid}/creatives`, operator.token, body(over, c)); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body; };
  const detail = async (id: string) => (await call(s.app, "GET", `${base}/creatives/${id}`, viewer.token)).body;
  const render = (id: string, v: number, ratios?: string[], by = operator) => call(s.app, "POST", `${base}/creatives/${id}/versions/${v}/renders`, by.token, ratios ? { ratios } : {});
  const submit = (id: string, v: number, by = operator) => call(s.app, "POST", `${base}/creatives/${id}/versions/${v}/submit`, by.token);
  const approve = (id: string, v: number, by = admin) => call(s.app, "POST", `${base}/creatives/${id}/versions/${v}/approve`, by.token, {});
  const reject = (id: string, v: number, by = admin, reason = "Not right") => call(s.app, "POST", `${base}/creatives/${id}/versions/${v}/reject`, by.token, { reason });
  const run = async () => { const n = await s.worker.runUntilIdle(); return n; };
  /** Create, render every format, and wait for the worker. */
  const ready = async (over: Json = {}, c: Json = {}) => { const cr = await make(over, c); expect((await render(cr.id, 1)).status).toBe(202); await run(); return cr.id as string; };
  return { s, owner, admin, admin2, operator, viewer, W, base, cid, approveKit, concept, body, make, detail, render, submit, approve, reject, run, ready };
}
type Wd = Awaited<ReturnType<typeof world>>;
const rendersOf = (w: Wd, id: string) => w.s.db.prepare("SELECT * FROM creative_renders WHERE creative_id = ? ORDER BY created_at, id").all(id) as Array<Json>;
const assetsCount = (w: Wd) => (w.s.db.prepare("SELECT COUNT(*) n FROM asset_versions WHERE source = 'generated'").get() as { n: number }).n;

/* ---------------------------------------------------------------- the picture layer */

describe("the picture layer", () => {
  it("writes a valid PNG and checks it strictly: a cut-short or altered file is not accepted", () => {
    const px = new Uint8Array(8 * 6 * 3).fill(120);
    const good = encodePng(8, 6, px);
    expect(checkPng(good)).toEqual({ ok: true, width: 8, height: 6 });
    expect(readImageInfo(good)).toMatchObject({ mime: "image/png", width: 8, height: 6 });
    expect(checkPng(good.subarray(0, good.length - 20)).ok).toBe(false); // truncated
    const flipped = Buffer.from(good); flipped[good.length - 20] = (flipped[good.length - 20] ?? 0) ^ 0xff; // damages pixel data or its checksum
    expect(checkPng(flipped).ok).toBe(false);
    expect(checkPng(Buffer.from("<html>nope</html>")).ok).toBe(false);
    expect(checkPng(Buffer.concat([good, Buffer.from("junk")])).ok).toBe(false); // trailing bytes
  });
  it("the mock provider is deterministic, offline, honest about being a mock, and every format matches its ratio", async () => {
    const p = new MockImageProvider();
    expect(p.capabilities).toMatchObject({ mock: true, offline: true, rendersText: false, deterministic: true });
    for (const r of Object.values(RATIOS)) {
      const a = await p.generate({ ratio: r.id, width: r.width, height: r.height, seed: "s", prompt: "x", palette: { background: "#ffffff", foreground: "#000000", accent: "#1A4D8F" } });
      const b = await p.generate({ ratio: r.id, width: r.width, height: r.height, seed: "s", prompt: "x", palette: { background: "#ffffff", foreground: "#000000", accent: "#1A4D8F" } });
      expect(a.bytes.equals(b.bytes)).toBe(true);
      const c = checkPng(a.bytes); expect(c.ok).toBe(true);
      if (c.ok) expect(matchesRatio(c.width, c.height, r.id)).toBe(true);
    }
  });
  it("computes colour contrast the standard way", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#888888")).toBeLessThan(1.5);
  });
});

/* ---------------------------------------------------------------- the flow */

describe("Creative Studio: brief → concept → pictures → checks → approval → campaign link", () => {
  it("reports what the provider is and that video is not built", async () => {
    const w = await world();
    const r = await call(w.s.app, "GET", `${w.base}/creative/providers`, w.viewer.token);
    expect(r.status).toBe(200);
    expect(r.body.image[0]).toMatchObject({ id: "mock-image", mock: true, offline: true });
    expect(r.body.video).toMatchObject({ status: "not_built", providers: [] });
  });

  it("suggests concepts from the campaign's own copy and Brand Kit colours, labelled as rule-based (not AI)", async () => {
    const w = await world();
    const r = await call(w.s.app, "GET", `${w.base}/campaigns/${w.cid}/creative-concepts`, w.operator.token);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe("rule_based");
    expect(r.body.note).toMatch(/not generated by AI/);
    expect(r.body.concepts.length).toBeGreaterThan(0);
    expect(r.body.concepts[0].concept.palette).toEqual({ background: "#FFFFFF", foreground: "#1B1B1B", accent: "#1A4D8F" });
    // a suggestion can be saved exactly as given
    const c = r.body.concepts[0];
    const saved = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/creatives`, w.operator.token, { name: "From a suggestion", brief: c.brief, concept: c.concept, altText: c.altText, ratios: c.ratios });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
  });

  it("makes every format as a queued job, completes each only after its bytes were validated and stored, and records provider and model", async () => {
    const w = await world();
    const cr = await w.make();
    expect(assetsCount(w)).toBe(0);
    const r = await w.render(cr.id, 1);
    expect(r.status).toBe(202);
    expect(r.body.requested).toEqual(["1:1", "4:5"]);
    expect(rendersOf(w, cr.id).map((x) => x.status)).toEqual(["queued", "queued"]); // not complete: nothing was made yet
    expect(assetsCount(w)).toBe(0);
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'render_image' AND status = 'queued'").get()).toEqual({ n: 2 });
    await w.run();
    const d = await w.detail(cr.id);
    const v = d.versions[0];
    expect(v.renders.map((x: Json) => x.status)).toEqual(["succeeded", "succeeded"]);
    expect(v.renders[0]).toMatchObject({ provider: "mock-image", model: "mock-image-1", simulatedCostCents: 0, stage: "done" });
    expect(v.variants.map((x: Json) => x.ratio).sort()).toEqual(["1:1", "4:5"]);
    for (const x of v.variants) {
      expect(x).toMatchObject({ source: "generated", mime: "image/png", provider: "mock-image", model: "mock-image-1", rights: "generated", assetStatus: "draft" });
      expect(matchesRatio(x.width, x.height, x.ratio)).toBe(true);
    }
    expect(assetsCount(w)).toBe(2);
    // the stored file is the validated picture
    const f = await call(w.s.app, "GET", `${w.base}/creatives/${cr.id}/versions/1/pictures/1:1/file`, w.viewer.token);
    expect(f.status).toBe(200);
    expect(f.headers["content-type"]).toBe("image/png");
    expect(f.headers["x-content-type-options"]).toBe("nosniff");
    expect(checkPng(f.raw).ok).toBe(true);
    expect(w.s.db.prepare("SELECT 1 FROM audit_events WHERE type = 'creative.render_succeeded'").get()).toBeTruthy();
  });

  it("does the whole path: checks pass, a second person approves, the pictures are approved with it, and the campaign's proposal pins the exact pictures", async () => {
    const w = await world();
    const id = await w.ready();
    const sub = await w.submit(id, 1);
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);
    expect(sub.body.versions[0].status).toBe("needs_review");
    const qa = sub.body.versions[0].qa;
    expect(qa.passed).toBe(true);
    expect(qa.checks.find((c: Json) => c.id === "ai_critique")).toMatchObject({ status: "not_performed", method: "ai_critique" });
    expect(qa.checks.some((c: Json) => c.id === "mock_1:1" && c.status === "warn")).toBe(true); // placeholder art is called out
    expect(qa.score.note).toMatch(/not a prediction/);
    const ap = await w.approve(id, 1);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.approvedVersion).toBe(1);
    expect(ap.body.versions[0].variants.every((v: Json) => v.assetStatus === "approved")).toBe(true);
    expect(ap.body.versions[0].review.separation).toBe("enforced");

    const pr = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {});
    expect(pr.status, JSON.stringify(pr.body)).toBe(201);
    const payload = JSON.parse((w.s.db.prepare("SELECT payload FROM action_proposals WHERE id = ?").get(pr.body.id) as { payload: string }).payload);
    expect(payload.creatives).toHaveLength(1);
    expect(payload.creatives[0]).toMatchObject({ creativeId: id, version: 1 });
    expect(payload.creatives[0].pictures.map((p: Json) => p.ratio).sort()).toEqual(["1:1", "4:5"]);
    expect(payload.creatives[0].pictures.every((p: Json) => /^[0-9a-f]{64}$/.test(p.sha256))).toBe(true);
    // editing the creative afterwards makes a NEW draft; the proposal still names the approved version
    const rev = await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions`, w.operator.token, { brief: { objective: "x", keyMessage: "y" }, concept: w.concept({ headline: "New words" }), altText: "A bright advertisement with new words", ratios: ["1:1", "4:5"] });
    expect(rev.status).toBe(201);
    expect(rev.body.approvedVersion).toBe(1);
    expect(rev.body.versions[1].status).toBe("draft");
    expect((await call(w.s.app, "POST", `${w.base}/proposals/${pr.body.id}/approve`, w.admin.token, { decidedBy: "x", acknowledgedReview: true })).status).toBe(200);
  });
});

/* ---------------------------------------------------------------- nothing complete without a validated, persisted output */

describe("a render is never complete without a validated, persisted output", () => {
  const failsWith = async (fault: Json, code: string) => {
    const w = await world();
    Object.assign(w.s.provider.faults, fault);
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1);
    await w.run();
    const r = rendersOf(w, cr.id)[0]!;
    expect(r).toMatchObject({ status: "failed", error_code: code, asset_id: null, sha256: null });
    expect(assetsCount(w)).toBe(0); // nothing was stored
    const d = await w.detail(cr.id);
    expect(d.versions[0].variants).toEqual([]); // and no picture is attached
    expect(d.versions[0].renders[0].error.repair).toBeTruthy(); // the failure says what to do
    const sub = await w.submit(cr.id, 1);
    expect(sub.status).toBe(409);
    expect(sub.body.error.code ?? sub.body.code).toBe("qa_failed");
    return { w, cr };
  };
  it("a cut-short picture is thrown away", async () => { await failsWith({ truncate: true }, "output_invalid"); });
  it("something that is not an image is thrown away", async () => { await failsWith({ notAnImage: true }, "output_invalid"); });
  it("a picture in the wrong shape is thrown away", async () => { await failsWith({ wrongSize: true }, "wrong_ratio"); });
  it("a refusal is recorded as a failure, with guidance, and is not retried automatically", async () => {
    const { w, cr } = await failsWith({ refuse: true }, "provider_refused");
    expect(rendersOf(w, cr.id)[0]!.attempts).toBe(1);
  });

  it("a temporary provider failure is retried automatically within bounds, then succeeds", async () => {
    const w = await world();
    w.s.provider.faults.transientFailures = 2;
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1);
    await w.run();
    expect(rendersOf(w, cr.id)[0]).toMatchObject({ status: "succeeded", attempts: 3 });
    expect(w.s.provider.calls).toBe(3);
    expect(assetsCount(w)).toBe(1);
  });
  it("gives up after the bounded number of attempts and says so", async () => {
    const w = await world();
    w.s.provider.faults.transientFailures = 99;
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1);
    await w.run();
    expect(rendersOf(w, cr.id)[0]).toMatchObject({ status: "failed", error_code: "provider_unavailable", attempts: 5 });
    expect(assetsCount(w)).toBe(0);
  });

  it("a failed render can be retried by hand, at most twice", async () => {
    const w = await world();
    w.s.provider.faults.refuse = true;
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1);
    await w.run();
    const rid = rendersOf(w, cr.id)[0]!.id as string;
    expect((await call(w.s.app, "POST", `${w.base}/renders/${rid}/retry`, w.operator.token)).status).toBe(200);
    await w.run();
    expect((await call(w.s.app, "POST", `${w.base}/renders/${rid}/retry`, w.operator.token)).status).toBe(200);
    await w.run();
    const third = await call(w.s.app, "POST", `${w.base}/renders/${rid}/retry`, w.operator.token);
    expect(third.status).toBe(409);
    expect(JSON.stringify(third.body)).toMatch(/retry_limit/);
    w.s.provider.faults.refuse = false;
    // a different route out: ask for a fresh render
    expect((await w.render(cr.id, 1)).status).toBe(202);
    await w.run();
    expect(rendersOf(w, cr.id).filter((r) => r.status === "succeeded")).toHaveLength(1);
  });

  it("cancels a queued render so it never runs, and cancels a running one so nothing is stored", async () => {
    const w = await world();
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1);
    const q = rendersOf(w, cr.id)[0]!.id as string;
    expect((await call(w.s.app, "POST", `${w.base}/renders/${q}/cancel`, w.operator.token)).status).toBe(200);
    await w.run();
    expect(rendersOf(w, cr.id)[0]).toMatchObject({ status: "cancelled" });
    expect(w.s.provider.calls).toBe(0);

    w.s.provider.faults.delayMs = 3000;
    await w.render(cr.id, 1);
    const running = w.run();
    const rid = () => rendersOf(w, cr.id).find((r) => r.status === "running")?.id as string | undefined;
    for (let i = 0; i < 100 && !rid(); i++) await new Promise((r) => setTimeout(r, 20));
    expect(rid()).toBeTruthy();
    expect((await call(w.s.app, "POST", `${w.base}/renders/${rid()}/cancel`, w.operator.token)).status).toBe(200);
    await running;
    expect(rendersOf(w, cr.id).map((r) => r.status)).toEqual(["cancelled", "cancelled"]);
    expect(assetsCount(w)).toBe(0);
    expect((await call(w.s.app, "POST", `${w.base}/renders/${q}/cancel`, w.operator.token)).status).toBe(409); // already finished
  });

  it("is idempotent: running the same job twice does not make a second picture, and asking while one is in flight does not duplicate it", async () => {
    const w = await world();
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1);
    const again = await w.render(cr.id, 1);
    expect(again.body.alreadyRunning).toEqual(["1:1"]);
    expect(rendersOf(w, cr.id)).toHaveLength(1);
    await w.run();
    const rid = rendersOf(w, cr.id)[0]!.id as string;
    // a duplicate delivery of the finished job is a no-op
    w.s.db.prepare("INSERT INTO jobs (id, workspace_id, type, payload, dedupe_key, status, attempts, max_attempts, run_at, created_at, updated_at) VALUES ('job_dup', ?, 'render_image', ?, 'dup', 'queued', 0, 5, ?, ?, ?)")
      .run(w.W, JSON.stringify({ renderId: rid }), "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
    await w.run();
    expect(assetsCount(w)).toBe(1);
    expect(w.s.provider.calls).toBe(1);
  });

  it("limits how many pictures a workspace can make in a day", async () => {
    const w = await world({ limits: { maxRendersPerDay: 3 } });
    const cr = await w.make({ ratios: ["1:1", "4:5", "9:16", "1.91:1"] });
    const r = await w.render(cr.id, 1);
    expect(r.status).toBe(429);
    expect(JSON.stringify(r.body)).toMatch(/daily_render_limit/);
    expect((await w.render(cr.id, 1, ["1:1", "4:5"])).status).toBe(202);
  });

  it("a second render of the same format adds a version of the same asset and never changes the first", async () => {
    const w = await world();
    const cr = await w.make({ ratios: ["1:1"] });
    await w.render(cr.id, 1); await w.run();
    const before = w.s.db.prepare("SELECT asset_id, version, sha256 FROM asset_versions WHERE source = 'generated'").all() as Json[];
    await w.render(cr.id, 1); await w.run();
    const after = w.s.db.prepare("SELECT asset_id, version, sha256 FROM asset_versions WHERE source = 'generated' ORDER BY version").all() as Json[];
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.asset_id).toBe(before[0]!.asset_id);
    expect(after[1]!.version).toBe(2);
  });
});

/* ---------------------------------------------------------------- the quality gate */

describe("the quality gate: deterministic checks with repair guidance, kept apart from AI critique and human approval", () => {
  const check = async (w: Wd, id: string) => (await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/check`, w.viewer.token)).body;
  const status = (qa: Json, id: string) => qa.checks.find((c: Json) => c.id === id);

  it("flags a missing picture for a format, with what to do about it", async () => {
    const w = await world();
    const cr = await w.make();
    const qa = await check(w, cr.id);
    expect(qa.passed).toBe(false);
    expect(status(qa, "image_1:1")).toMatchObject({ status: "fail", group: "technical" });
    expect(status(qa, "image_1:1").repair).toMatch(/Make the image for 1:1|attach/);
  });
  it("flags words the Brand Kit says to avoid, and an unsupported or invented claim, each with repair guidance", async () => {
    const w = await world();
    const id = await w.ready({}, { headline: "Cheap and best in town", subline: "Rated 5 stars by customers" });
    const qa = await check(w, id);
    expect(status(qa, "avoid_terms")).toMatchObject({ status: "fail", group: "brand" });
    expect(status(qa, "avoid_terms").message).toMatch(/"cheap"/);
    expect(status(qa, "claims").status).toBe("fail");
    expect(status(qa, "claims").group).toBe("factual");
    expect(status(qa, "testimonials")).toMatchObject({ status: "fail" });
    for (const c of qa.checks.filter((x: Json) => x.status === "fail")) expect(c.repair, c.id).toBeTruthy();
    expect((await w.submit(id, 1)).status).toBe(409);
  });
  it("flags weak alt text and poor contrast, and says words in the picture cannot be read by a screen reader", async () => {
    const w = await world();
    const id = await w.ready({ altText: "ad" }, { palette: { background: "#777777", foreground: "#888888", accent: "#1A4D8F" } });
    const qa = await check(w, id);
    expect(status(qa, "alt_text").status).toBe("fail");
    expect(status(qa, "contrast").status).toBe("fail");
    expect(status(qa, "text_in_image").status).toBe("info");
  });
  it("flags copy that is too long", async () => {
    const w = await world();
    const cr = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/creatives`, w.operator.token, w.body({}, { headline: "x".repeat(41) }));
    expect(cr.status).toBe(400); // the structured brief refuses it at the door
  });
  it("without an approved Brand Kit the brand checks are limited and say so (a warning, never a silent pass)", async () => {
    const w = await world({ approvedKit: false });
    const id = await w.ready();
    const qa = await check(w, id);
    expect(status(qa, "brand_kit")).toMatchObject({ status: "warn", group: "brand" });
    expect(status(qa, "avoid_terms")).toBeUndefined();
  });
  it("never reports an AI critique as done", async () => {
    const w = await world();
    const id = await w.ready();
    const qa = await check(w, id);
    expect(status(qa, "ai_critique")).toMatchObject({ status: "not_performed" });
    expect(qa.counts.not_performed).toBe(1);
    expect(qa.checks.filter((c: Json) => c.method === "ai_critique")).toHaveLength(1);
  });
  it("catches a stored file that no longer matches its record", async () => {
    const w = await world();
    const id = await w.ready();
    const key = (w.s.db.prepare("SELECT storage_key FROM asset_versions WHERE source = 'generated' LIMIT 1").get() as { storage_key: string }).storage_key;
    await w.s.store.remove(key);
    const qa = await check(w, id);
    expect(qa.checks.filter((c: Json) => c.status === "fail" && /stored image file is missing/.test(c.message))).toHaveLength(1);
  });
});

/* ---------------------------------------------------------------- versions, revision, imports */

describe("versions, revision and imported pictures", () => {
  it("never changes a saved version: editing adds one, and only a draft can get new pictures", async () => {
    const w = await world();
    const id = await w.ready();
    const v1 = (await w.detail(id)).versions[0];
    const rev = await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions`, w.operator.token, { brief: { objective: "a", keyMessage: "b" }, concept: w.concept({ headline: "Changed words" }), altText: "A bright advertisement with changed words", ratios: ["1:1", "4:5"] });
    expect(rev.status).toBe(201);
    const d = await w.detail(id);
    expect(d.versions[0]).toMatchObject({ concept: v1.concept, altText: v1.altText, status: "superseded" });
    expect(d.versions[1]).toMatchObject({ version: 2, parentVersion: 1, status: "draft" });
    expect(d.versions[1].variants.map((x: Json) => x.assetVersion)).toEqual(d.versions[0].variants.map((x: Json) => x.assetVersion)); // same visuals: pictures kept
    // a changed visual description needs new pictures
    const rev3 = await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions`, w.operator.token, { brief: { objective: "a", keyMessage: "b" }, concept: w.concept({ visualDescription: "A different scene" }), altText: "A bright advertisement, different scene", ratios: ["1:1", "4:5"] });
    expect(rev3.body.versions[2].variants).toEqual([]);
    // a version in review is locked
    const id2 = await w.ready();
    expect((await w.submit(id2, 1)).status).toBe(200);
    const locked = await w.render(id2, 1);
    expect(locked.status).toBe(409);
    expect(JSON.stringify(locked.body)).toMatch(/version_locked/);
  });

  it("attaches only an APPROVED image of the right shape, and an attached image keeps its own provenance", async () => {
    const w = await world();
    const px = new Uint8Array(512 * 512 * 3).fill(200);
    const file = encodePng(512, 512, px);
    const up = await call(w.s.app, "POST", `${w.base}/assets`, w.operator.token, { name: "Studio photo", kind: "image", source: "uploaded", rightsBasis: "owned", data: file.toString("base64") });
    expect(up.status).toBe(201);
    const aid = up.body.id as string;
    const cr = await w.make({ ratios: ["1:1"] });
    const attach = (ratio = "1:1") => call(w.s.app, "POST", `${w.base}/creatives/${cr.id}/versions/1/images`, w.operator.token, { ratio, assetId: aid, assetVersion: 1 });
    const early = await attach();
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toMatch(/asset_not_approved/);
    expect((await call(w.s.app, "POST", `${w.base}/assets/${aid}/versions/1/submit`, w.operator.token)).status).toBe(200);
    expect((await call(w.s.app, "POST", `${w.base}/assets/${aid}/versions/1/approve`, w.admin.token, {})).status).toBe(200);
    expect(JSON.stringify((await attach("4:5")).body)).toMatch(/ratio_not_in_version/);
    const ok = await attach();
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.versions[0].variants[0]).toMatchObject({ source: "imported", assetId: aid, rights: "owned" });
    expect((await w.submit(cr.id, 1)).status).toBe(200);
    expect((await w.approve(cr.id, 1)).status).toBe(200);
    // a wrong-shaped approved image is refused at attach time with a reason
    const sq = encodePng(300, 100, new Uint8Array(300 * 100 * 3).fill(90));
    const up2 = await call(w.s.app, "POST", `${w.base}/assets`, w.operator.token, { name: "Wide", kind: "image", source: "uploaded", rightsBasis: "owned", data: sq.toString("base64") });
    await call(w.s.app, "POST", `${w.base}/assets/${up2.body.id}/versions/1/submit`, w.operator.token);
    await call(w.s.app, "POST", `${w.base}/assets/${up2.body.id}/versions/1/approve`, w.admin.token, {});
    const cr2 = await w.make({ name: "Second", ratios: ["1:1"] });
    const bad = await call(w.s.app, "POST", `${w.base}/creatives/${cr2.id}/versions/1/images`, w.operator.token, { ratio: "1:1", assetId: up2.body.id, assetVersion: 1 });
    expect(bad.status).toBe(409);
    expect(JSON.stringify(bad.body)).toMatch(/wrong_ratio/);
  });
});

/* ---------------------------------------------------------------- review, permissions, isolation */

describe("review, permissions and workspace isolation", () => {
  it("a person cannot approve what they submitted; a second admin can; an operator cannot approve at all", async () => {
    const w = await world();
    const id = await w.ready();
    expect((await w.submit(id, 1, w.admin)).status).toBe(200);
    const self = await w.approve(id, 1, w.admin);
    expect(self.status).toBe(403);
    expect(JSON.stringify(self.body)).toMatch(/self_approval_not_allowed/);
    expect((await w.approve(id, 1, w.operator)).status).toBe(403);
    expect((await w.approve(id, 1, w.admin2)).status).toBe(200);
  });
  it("rejection needs a reason, keeps the pictures as drafts, and the version can be fixed and sent again", async () => {
    const w = await world();
    const id = await w.ready();
    await w.submit(id, 1);
    expect((await call(w.s.app, "POST", `${w.base}/creatives/${id}/versions/1/reject`, w.admin.token, {})).status).toBe(400);
    expect((await w.reject(id, 1)).status).toBe(200);
    const d = await w.detail(id);
    expect(d.versions[0]).toMatchObject({ status: "rejected" });
    expect(d.versions[0].variants.every((v: Json) => v.assetStatus === "draft")).toBe(true);
    expect((await w.submit(id, 1)).status).toBe(200); // a rejected version may be sent again after changes
  });
  it("approval re-runs the checks against what is true NOW: a Brand Kit change after submission blocks it", async () => {
    const w = await world();
    const id = await w.ready();
    await w.submit(id, 1);
    await w.approveKit({ ...KIT, voice: { ...KIT.voice, avoidTerms: ["cheap", "fair"] } }); // "Fast help, fair price" now uses an avoided word
    const ap = await w.approve(id, 1);
    expect(ap.status).toBe(409);
    expect(JSON.stringify(ap.body)).toMatch(/qa_failed/);
    expect((await w.detail(id)).versions[0].status).toBe("needs_review");
  });
  it("a viewer can look but not change; the legacy rules of read, write and review apply per route", async () => {
    const w = await world();
    const cr = await w.make();
    expect((await call(w.s.app, "GET", `${w.base}/creatives/${cr.id}`, w.viewer.token)).status).toBe(200);
    expect((await call(w.s.app, "GET", `${w.base}/campaigns/${w.cid}/creatives`, w.viewer.token)).body.creatives).toHaveLength(1);
    expect((await w.render(cr.id, 1, undefined, w.viewer)).status).toBe(403);
    expect((await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/creatives`, w.viewer.token, w.body())).status).toBe(403);
    expect((await w.reject(cr.id, 1, w.operator)).status).toBe(403);
    expect((await call(w.s.app, "GET", `${w.base}/creatives/${cr.id}`)).status).toBe(401);
  });
  it("another workspace can see nothing: not the creative, its pictures, its renders, or the campaign", async () => {
    const w = await world();
    const id = await w.ready();
    const other = await person(w.s, "outsider");
    const W2 = (await call(w.s.app, "POST", "/api/workspaces", other.token, { name: "Other Co" })).body.workspace.id as string;
    const b2 = `/api/workspaces/${W2}`;
    const rid = rendersOf(w, id)[0]!.id as string;
    for (const [m, u] of [["GET", `/creatives/${id}`], ["GET", `/creatives/${id}/versions/1/pictures/1:1/file`], ["POST", `/renders/${rid}/cancel`], ["POST", `/creatives/${id}/versions/1/check`], ["GET", `/campaigns/${w.cid}/creatives`]] as const)
      expect((await call(w.s.app, m, `${b2}${u}`, other.token)).status, u).toBe(404);
    expect((await call(w.s.app, "GET", `/api/workspaces/${w.W}/creatives/${id}`, other.token)).status).toBe(404); // not a member of the workspace that owns it: it is not even confirmed to exist
  });
  it("a custom role is judged by exactly the creative permissions it lists", async () => {
    const s = boot();
    const owner = await person(s, "olivia"), member = await person(s, "mia");
    const org = (await call(s.app, "POST", "/api/organizations", owner.token, { name: "Bright Agency" })).body;
    const O = `/api/organizations/${org.id}`;
    const ws = (await call(s.app, "POST", `${O}/workspaces`, owner.token, { name: "Client One" })).body;
    await call(s.app, "POST", `${O}/members`, owner.token, { userId: member.id, role: "member" });
    const base = `/api/workspaces/${ws.id}`;
    expect((await call(s.app, "PUT", `${base}/brain`, owner.token, BRAIN)).status).toBe(200);
    const cid = (await call(s.app, "POST", `${base}/campaigns/generate`, owner.token, { providerId: "mock", model: "mock-deterministic-1" })).body.id as string;
    const cat = JSON.stringify((await call(s.app, "GET", `${O}/permissions`, owner.token)).body);
    for (const p of ["creatives.read", "creatives.write", "creatives.review"]) expect(cat).toContain(p);
    const role = (await call(s.app, "POST", `${O}/role-templates`, owner.token, { name: "Creative viewer", permissions: ["workspace.read", "campaigns.read", "creatives.read"] })).body;
    expect((await call(s.app, "POST", `${O}/access-grants`, owner.token, { userId: member.id, workspaceIds: [ws.id], customRoleId: role.id })).status).toBe(201);
    expect((await call(s.app, "GET", `${base}/campaigns/${cid}/creatives`, member.token)).status).toBe(200);
    const mk = { name: "x", brief: { objective: "a", keyMessage: "b" }, concept: { headline: "Hi", subline: "", callToAction: "GET_QUOTE", visualDescription: "plain", palette: { background: "#FFFFFF", foreground: "#000000", accent: "#1A4D8F" } }, altText: "A plain advertisement", ratios: ["1:1"] };
    expect((await call(s.app, "POST", `${base}/campaigns/${cid}/creatives`, member.token, mk)).status).toBe(403);
    expect((await call(s.app, "POST", `${base}/campaigns/${cid}/creatives`, owner.token, mk)).status).toBe(201);
  });
});

/* ---------------------------------------------------------------- the link to a campaign's proposal */

describe("a proposal pins the exact approved pictures", () => {
  it("a campaign with no approved creative proposes as before (no creatives field, so older hashes are untouched)", async () => {
    const w = await world();
    const pr = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {});
    expect(pr.status).toBe(201);
    expect("creatives" in JSON.parse((w.s.db.prepare("SELECT payload FROM action_proposals WHERE id = ?").get(pr.body.id) as { payload: string }).payload)).toBe(false);
  });
  it("approving the proposal is refused if a creative it names is archived afterwards, and running is refused too", async () => {
    const w = await world();
    const id = await w.ready();
    await w.submit(id, 1); await w.approve(id, 1);
    const pr = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {});
    expect((await call(w.s.app, "POST", `${w.base}/creatives/${id}/archive`, w.operator.token)).status).toBe(200);
    const ap = await call(w.s.app, "POST", `${w.base}/proposals/${pr.body.id}/approve`, w.admin.token, { decidedBy: "x", acknowledgedReview: true });
    expect(ap.status).toBe(409);
    expect(JSON.stringify(ap.body)).toMatch(/creative_changed/);
  });
  it("nothing is sent anywhere with the pictures: approving and running still follow the existing approval-first path", async () => {
    const w = await world();
    const id = await w.ready();
    await w.submit(id, 1); await w.approve(id, 1);
    const pr = await call(w.s.app, "POST", `${w.base}/campaigns/${w.cid}/proposals`, w.operator.token, {});
    const ap = await call(w.s.app, "POST", `${w.base}/proposals/${pr.body.id}/approve`, w.admin.token, { decidedBy: "x", acknowledgedReview: true });
    expect(ap.body.status).toBe("approved");
    expect(w.s.db.prepare("SELECT COUNT(*) n FROM jobs WHERE type = 'execute_proposal'").get()).toEqual({ n: 0 });
    expect(w.s.provider.calls).toBe(2); // only the two mock renders; no other media call
  });
});
